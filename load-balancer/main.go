package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// ─── Types ────────────────────────────────────────────────────────────────────

type Server struct {
	URL          *url.URL
	ID           int
	ActiveConns  int64
	Healthy      int32 // 1=healthy, 0=down
	TotalReqs    int64
	mu           sync.RWMutex
	latencySum   float64
	latencyCount int64
}

func (s *Server) IsHealthy() bool { return atomic.LoadInt32(&s.Healthy) == 1 }
func (s *Server) IncrConn()       { atomic.AddInt64(&s.ActiveConns, 1) }
func (s *Server) DecrConn()       { atomic.AddInt64(&s.ActiveConns, -1) }
func (s *Server) GetConns() int64 { return atomic.LoadInt64(&s.ActiveConns) }

func (s *Server) RecordLatency(ms float64) {
	s.mu.Lock()
	s.latencySum += ms
	s.latencyCount++
	s.mu.Unlock()
}

func (s *Server) AvgLatency() float64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.latencyCount == 0 {
		return 0
	}
	return s.latencySum / float64(s.latencyCount)
}

// ─── Load Balancer ────────────────────────────────────────────────────────────

type LoadBalancer struct {
	servers    []*Server
	rrCounter  uint64
	algorithm  string
	algMu      sync.RWMutex
	rlAgentURL string
	hub        *Hub
}

func NewLoadBalancer(backendURLs []string, rlAgentURL string, hub *Hub) *LoadBalancer {
	servers := make([]*Server, len(backendURLs))
	for i, rawURL := range backendURLs {
		u, err := url.Parse(rawURL)
		if err != nil {
			log.Fatalf("invalid backend URL %s: %v", rawURL, err)
		}
		servers[i] = &Server{URL: u, ID: i, Healthy: 1}
	}
	return &LoadBalancer{
		servers:    servers,
		algorithm:  os.Getenv("ALGORITHM"),
		rlAgentURL: rlAgentURL,
		hub:        hub,
	}
}

func (lb *LoadBalancer) SetAlgorithm(algo string) {
	lb.algMu.Lock()
	lb.algorithm = algo
	lb.algMu.Unlock()
	log.Printf("[LB] Algorithm switched to: %s", algo)
}

func (lb *LoadBalancer) GetAlgorithm() string {
	lb.algMu.RLock()
	defer lb.algMu.RUnlock()
	return lb.algorithm
}

func (lb *LoadBalancer) healthyServers() []*Server {
	var healthy []*Server
	for _, s := range lb.servers {
		if s.IsHealthy() {
			healthy = append(healthy, s)
		}
	}
	return healthy
}

// Round Robin
func (lb *LoadBalancer) roundRobin() *Server {
	healthy := lb.healthyServers()
	if len(healthy) == 0 {
		return nil
	}
	idx := atomic.AddUint64(&lb.rrCounter, 1)
	return healthy[int(idx-1)%len(healthy)]
}

// Least Connections
func (lb *LoadBalancer) leastConnections() *Server {
	healthy := lb.healthyServers()
	if len(healthy) == 0 {
		return nil
	}
	best := healthy[0]
	for _, s := range healthy[1:] {
		if s.GetConns() < best.GetConns() {
			best = s
		}
	}
	return best
}

// RL Agent call
type RLState struct {
	CPUUtil     []float64 `json:"cpu_util"`
	ActiveConns []float64 `json:"active_conns"`
	AvgLatency  []float64 `json:"avg_latency_ms"`
	RequestRate float64   `json:"request_rate"`
}

type RLResponse struct {
	Action int     `json:"action"`
	QValue float64 `json:"q_value"`
}

func (lb *LoadBalancer) rlDecide(requestID string) *Server {
	healthy := lb.healthyServers()
	if len(healthy) == 0 {
		return nil
	}

	state := RLState{
		CPUUtil:     make([]float64, len(lb.servers)),
		ActiveConns: make([]float64, len(lb.servers)),
		AvgLatency:  make([]float64, len(lb.servers)),
		RequestRate: 0,
	}
	for i, s := range lb.servers {
		state.ActiveConns[i] = float64(s.GetConns())
		state.AvgLatency[i] = s.AvgLatency()
	}

	payload := map[string]interface{}{
		"request_id":     requestID,
		"cpu_util":       state.CPUUtil,
		"active_conns":   state.ActiveConns,
		"avg_latency_ms": state.AvgLatency,
		"request_rate":   state.RequestRate,
	}
	body, _ := json.Marshal(payload)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	req, _ := http.NewRequestWithContext(ctx, "POST", lb.rlAgentURL+"/decide", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("[LB] RL agent timeout, falling back to RR: %v", err)
		return lb.roundRobin()
	}
	defer resp.Body.Close()

	var rlResp RLResponse
	if err := json.NewDecoder(resp.Body).Decode(&rlResp); err != nil {
		return lb.roundRobin()
	}

	// Map action to actual server (must be healthy)
	action := rlResp.Action
	if action >= 0 && action < len(lb.servers) && lb.servers[action].IsHealthy() {
		return lb.servers[action]
	}
	return lb.roundRobin()
}

func (lb *LoadBalancer) SelectServer(reqID string) (*Server, string) {
	algo := lb.GetAlgorithm()
	switch algo {
	case "lc":
		return lb.leastConnections(), algo
	case "rl":
		return lb.rlDecide(reqID), algo
	default:
		return lb.roundRobin(), "rr"
	}
}

// ─── WebSocket Hub ────────────────────────────────────────────────────────────

type Client struct {
	conn *websocket.Conn
	send chan []byte
}

type Hub struct {
	clients    map[*Client]bool
	broadcast  chan []byte
	register   chan *Client
	unregister chan *Client
	mu         sync.Mutex
}

func newHub() *Hub {
	return &Hub{
		clients:    make(map[*Client]bool),
		broadcast:  make(chan []byte, 256),
		register:   make(chan *Client),
		unregister: make(chan *Client),
	}
}

func (h *Hub) Run() {
	for {
		select {
		case c := <-h.register:
			h.mu.Lock()
			h.clients[c] = true
			h.mu.Unlock()
		case c := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[c]; ok {
				delete(h.clients, c)
				close(c.send)
			}
			h.mu.Unlock()
		case msg := <-h.broadcast:
			h.mu.Lock()
			for c := range h.clients {
				select {
				case c.send <- msg:
				default:
					delete(h.clients, c)
					close(c.send)
				}
			}
			h.mu.Unlock()
		}
	}
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[WS] upgrade error: %v", err)
		return
	}
	client := &Client{conn: conn, send: make(chan []byte, 64)}
	h.register <- client

	// Writer goroutine
	go func() {
		defer func() {
			h.unregister <- client
			conn.Close()
		}()
		for msg := range client.send {
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				break
			}
		}
	}()

	// Reader goroutine (handle incoming commands from dashboard)
	go func() {
		defer func() { h.unregister <- client }()
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				break
			}
			// Commands from dashboard: {"type":"SET_ALGO","algo":"rl"}
			var cmd map[string]string
			if json.Unmarshal(msg, &cmd) == nil {
				if cmd["type"] == "SET_ALGO" {
					lb.SetAlgorithm(cmd["algo"])
				}
			}
		}
	}()
}

// ─── Prometheus Metrics ───────────────────────────────────────────────────────

var (
	reqTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "lb_requests_total",
		Help: "Total requests routed",
	}, []string{"server_id", "algorithm"})

	reqLatency = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "lb_request_latency_ms",
		Help:    "Request latency in ms",
		Buckets: []float64{5, 10, 25, 50, 100, 250, 500, 1000, 2000},
	}, []string{"server_id", "algorithm"})

	activeConns = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "lb_active_connections",
		Help: "Active connections per backend",
	}, []string{"server_id"})
)

func initMetrics() {
	prometheus.MustRegister(reqTotal, reqLatency, activeConns)
}

// ─── Route Event ──────────────────────────────────────────────────────────────

type ServerState struct {
	ID         int     `json:"id"`
	ActiveConn int64   `json:"conns"`
	AvgLatency float64 `json:"latency_ms"`
	Healthy    bool    `json:"healthy"`
}

type RouteEvent struct {
	Type         string        `json:"type"`
	RequestID    string        `json:"request_id"`
	Timestamp    int64         `json:"timestamp"`
	Algorithm    string        `json:"algorithm"`
	ServerID     int           `json:"server_id"`
	LatencyMs    float64       `json:"latency_ms"`
	ServerStates []ServerState `json:"server_states"`
}

// Global lb reference needed for WS command handler
var lb *LoadBalancer

// ─── Main Handler ─────────────────────────────────────────────────────────────

func proxyHandler(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	reqID := fmt.Sprintf("req_%d", start.UnixMilli())

	server, algo := lb.SelectServer(reqID)
	if server == nil {
		http.Error(w, "no healthy backends", http.StatusServiceUnavailable)
		return
	}

	server.IncrConn()
	activeConns.WithLabelValues(fmt.Sprintf("%d", server.ID)).Set(float64(server.GetConns()))

	proxy := httputil.NewSingleHostReverseProxy(server.URL)
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("[PROXY] error to %s: %v", server.URL, err)
		http.Error(w, "backend error", http.StatusBadGateway)
	}

	proxy.ServeHTTP(w, r)

	latency := float64(time.Since(start).Milliseconds())
	server.DecrConn()
	server.RecordLatency(latency)
	atomic.AddInt64(&server.TotalReqs, 1)

	activeConns.WithLabelValues(fmt.Sprintf("%d", server.ID)).Set(float64(server.GetConns()))
	reqTotal.WithLabelValues(fmt.Sprintf("%d", server.ID), algo).Inc()
	reqLatency.WithLabelValues(fmt.Sprintf("%d", server.ID), algo).Observe(latency)

	// Send feedback to RL agent (non-blocking)
	if algo == "rl" {
		go sendRLFeedback(reqID, server.ID, latency)
	}

	// Broadcast WebSocket event
	states := make([]ServerState, len(lb.servers))
	for i, s := range lb.servers {
		states[i] = ServerState{
			ID:         s.ID,
			ActiveConn: s.GetConns(),
			AvgLatency: s.AvgLatency(),
			Healthy:    s.IsHealthy(),
		}
	}
	event := RouteEvent{
		Type:         "ROUTE_EVENT",
		RequestID:    reqID,
		Timestamp:    start.UnixMilli(),
		Algorithm:    algo,
		ServerID:     server.ID,
		LatencyMs:    latency,
		ServerStates: states,
	}
	if data, err := json.Marshal(event); err == nil {
		lb.hub.broadcast <- data
	}
}

func sendRLFeedback(requestID string, serverID int, latencyMs float64) {
	body, _ := json.Marshal(map[string]interface{}{
		"request_id": requestID,
		"server_id":  serverID,
		"latency_ms": latencyMs,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", lb.rlAgentURL+"/feedback", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	http.DefaultClient.Do(req) //nolint
}

// ─── Health Checker ───────────────────────────────────────────────────────────

func healthChecker(servers []*Server) {
	ticker := time.NewTicker(10 * time.Second)
	for range ticker.C {
		for _, s := range servers {
			go func(srv *Server) {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL.String()+"/health", nil)
				resp, err := http.DefaultClient.Do(req)
				if err != nil || resp.StatusCode != 200 {
					if atomic.SwapInt32(&srv.Healthy, 0) == 1 {
						log.Printf("[HEALTH] Server %d UNHEALTHY", srv.ID)
					}
				} else {
					if atomic.SwapInt32(&srv.Healthy, 1) == 0 {
						log.Printf("[HEALTH] Server %d RECOVERED", srv.ID)
					}
				}
				if resp != nil {
					resp.Body.Close()
				}
			}(s)
		}
	}
}

// ─── Main ─────────────────────────────────────────────────────────────────────

func main() {
	initMetrics()

	backendURLs := strings.Split(os.Getenv("BACKEND_URLS"), ",")
	rlAgentURL := os.Getenv("RL_AGENT_URL")
	if rlAgentURL == "" {
		rlAgentURL = "http://localhost:5000"
	}

	hub := newHub()
	go hub.Run()

	lb = NewLoadBalancer(backendURLs, rlAgentURL, hub)
	go healthChecker(lb.servers)

	mux := http.NewServeMux()

	// WebSocket endpoint
	mux.HandleFunc("/ws", hub.ServeWS)

	// Prometheus metrics
	mux.Handle("/metrics", promhttp.Handler())

	// Admin API
	mux.HandleFunc("/admin/algorithm", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "http://localhost:3000")
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		if r.Method == http.MethodPost {
			var body struct {
				Algorithm string `json:"algorithm"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			lb.SetAlgorithm(body.Algorithm)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{"algorithm": body.Algorithm})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"algorithm": lb.GetAlgorithm()})
	})

	mux.HandleFunc("/admin/status", func(w http.ResponseWriter, r *http.Request) {
		type Status struct {
			Algorithm string        `json:"algorithm"`
			Servers   []ServerState `json:"servers"`
		}
		states := make([]ServerState, len(lb.servers))
		for i, s := range lb.servers {
			states[i] = ServerState{
				ID:         s.ID,
				ActiveConn: s.GetConns(),
				AvgLatency: s.AvgLatency(),
				Healthy:    s.IsHealthy(),
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		json.NewEncoder(w).Encode(Status{Algorithm: lb.GetAlgorithm(), Servers: states})
	})

	// Proxy all other requests
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		proxyHandler(w, r)
	})

	log.Println("[LB] Load balancer starting on :8080")
	if err := http.ListenAndServe(":8080", mux); err != nil {
		log.Fatal(err)
	}
}
