"""
RL Agent — DQN-based load balancing decision maker.
Exposes REST API for the Go load balancer to call.
"""

from __future__ import annotations
import os, json, time, random, logging
import threading
from collections import deque
from threading import Lock

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
import requests
from flask import Flask, request, jsonify
from prometheus_client import Gauge, Counter, generate_latest, CONTENT_TYPE_LATEST

logging.basicConfig(level=logging.INFO, format="[RL] %(message)s")
log = logging.getLogger(__name__)

app = Flask(__name__)

@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response

@app.route("/")
def index():
    return jsonify({
        "message": "RL Agent API is running.",
        "endpoints": ["/decide (POST)", "/feedback (POST)", "/status (GET)", "/metrics (GET)", "/health (GET)"]
    })

# ── Config ────────────────────────────────────────────────────
N_SERVERS   = int(os.getenv("N_SERVERS", 3))
STATE_DIM   = N_SERVERS * 3 + 2   # cpu, conns, latency per server + rate + queue
ACTION_DIM  = N_SERVERS
PROM_URL    = os.getenv("PROMETHEUS_URL", "http://prometheus:9090")
CKPT_DIR    = os.getenv("CKPT_DIR", "./checkpoints")
CKPT_PATH   = f"{CKPT_DIR}/dqn_latest.pt"
os.makedirs(CKPT_DIR, exist_ok=True)

# ── DQN Model ─────────────────────────────────────────────────
class DQN(nn.Module):
    def __init__(self, state_dim, action_dim):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(state_dim, 64),
            nn.ReLU(),
            nn.Linear(64, 64),
            nn.ReLU(),
            nn.Linear(64, 32),
            nn.ReLU(),
            nn.Linear(32, action_dim),
        )

    def forward(self, x):
        return self.net(x)

# ── Replay Buffer ─────────────────────────────────────────────
class ReplayBuffer:
    def __init__(self, capacity=10000):
        self.buf = deque(maxlen=capacity)

    def push(self, state, action, reward, next_state):
        self.buf.append((state, action, reward, next_state))

    def sample(self, batch_size):
        batch = random.sample(self.buf, batch_size)
        s, a, r, ns = zip(*batch)
        return (np.array(s, dtype=np.float32),
                np.array(a),
                np.array(r, dtype=np.float32),
                np.array(ns, dtype=np.float32))

    def __len__(self):
        return len(self.buf)

# ── DQN Agent ─────────────────────────────────────────────────
class DQNAgent:
    def __init__(self):
        self.policy_net = DQN(STATE_DIM, ACTION_DIM)
        self.target_net = DQN(STATE_DIM, ACTION_DIM)
        self.target_net.load_state_dict(self.policy_net.state_dict())
        self.target_net.eval()

        self.optimizer = optim.Adam(self.policy_net.parameters(), lr=1e-3)
        self.loss_fn   = nn.SmoothL1Loss()
        self.buffer    = ReplayBuffer()

        self.epsilon       = 1.0
        self.epsilon_min   = 0.01
        self.epsilon_decay = 0.999
        self.gamma         = 0.95
        self.batch_size    = 32
        self.target_sync   = 50
        self.step_count    = 0
        self.decisions_total = 0
        self.total_reward  = 0.0
        self.episode_steps = 0
        self.recent_rewards = deque(maxlen=100)
        self.lock          = Lock()

        self._last_state   = None
        self._last_action  = None

        # Try to load existing checkpoint
        self.load_checkpoint()

    def select_action(self, state: np.ndarray) -> int:
        with self.lock:
            self.decisions_total += 1
        if random.random() < self.epsilon:
            return random.randint(0, ACTION_DIM - 1)
        with torch.no_grad():
            t = torch.FloatTensor(state).unsqueeze(0)
            q = self.policy_net(t)
            return int(q.argmax().item())

    def q_values(self, state: np.ndarray) -> list:
        with torch.no_grad():
            t = torch.FloatTensor(state).unsqueeze(0)
            return self.policy_net(t).squeeze().tolist()

    def store_and_train(self, state, action, reward, next_state):
        with self.lock:
            self.buffer.push(state, action, reward, next_state)
            self.total_reward += reward
            self.episode_steps += 1
            self.recent_rewards.append(reward)

            if len(self.buffer) < self.batch_size:
                return

            s, a, r, ns = self.buffer.sample(self.batch_size)
            s  = torch.FloatTensor(s)
            a  = torch.LongTensor(a).unsqueeze(1)
            r  = torch.FloatTensor(r)
            ns = torch.FloatTensor(ns)

            current_q = self.policy_net(s).gather(1, a).squeeze()
            with torch.no_grad():
                max_next_q = self.target_net(ns).max(1)[0]
            target_q = r + self.gamma * max_next_q

            loss = self.loss_fn(current_q, target_q)
            self.optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(self.policy_net.parameters(), 1.0)
            self.optimizer.step()

            self.step_count += 1
            self.epsilon = max(self.epsilon_min, self.epsilon * self.epsilon_decay)
            prom_epsilon.set(self.epsilon)
            avg_r = float(np.mean(self.recent_rewards))
            prom_reward.set(avg_r)

            if self.step_count % self.target_sync == 0:
                self.target_net.load_state_dict(self.policy_net.state_dict())

            if self.step_count % 100 == 0:
                self.save_checkpoint()
                log.info(f"step={self.step_count} eps={self.epsilon:.3f} "
                         f"avg_reward={avg_r:.3f}")

    def save_checkpoint(self):
        torch.save({
            "policy": self.policy_net.state_dict(),
            "target": self.target_net.state_dict(),
            "epsilon": self.epsilon,
            "step_count": self.step_count,
            "decisions_total": self.decisions_total,
        }, CKPT_PATH)

    def load_checkpoint(self):
        if os.path.exists(CKPT_PATH):
            ck = torch.load(CKPT_PATH, map_location="cpu")
            self.policy_net.load_state_dict(ck["policy"])
            self.target_net.load_state_dict(ck["target"])
            self.epsilon        = ck.get("epsilon", self.epsilon)
            self.step_count     = ck.get("step_count", 0)
            self.decisions_total = ck.get("decisions_total", self.step_count)
            log.info(f"Checkpoint loaded: step={self.step_count} eps={self.epsilon:.3f}")

# ── State Builder ─────────────────────────────────────────────
def build_state(payload: dict) -> np.ndarray:
    """
    Build normalised state vector from Go payload or Prometheus metrics.
    State: [cpu_0, conns_0, lat_0, cpu_1, conns_1, lat_1, ..., req_rate, queue]
    """
    state = []
    cpu_util    = payload.get("cpu_util", [0.0] * N_SERVERS)
    active_conn = payload.get("active_conns", [0.0] * N_SERVERS)
    avg_lat     = payload.get("avg_latency_ms", [100.0] * N_SERVERS)

    for i in range(N_SERVERS):
        cpu  = float(cpu_util[i])    if i < len(cpu_util)    else 0.0
        conn = float(active_conn[i]) if i < len(active_conn) else 0.0
        lat  = float(avg_lat[i])     if i < len(avg_lat)     else 100.0

        # Enrich with Prometheus if available
        prom_cpu = _prom_metric(f'backend_cpu_utilization{{server_id="{i+1}"}}')
        if prom_cpu is not None:
            cpu = prom_cpu

        state.append(np.clip(cpu / 100.0, 0, 1))
        state.append(np.clip(conn / 100.0, 0, 1))
        state.append(np.clip(lat / 2000.0, 0, 1))

    req_rate = float(payload.get("request_rate", 0))
    state.append(np.clip(req_rate / 500.0, 0, 1))
    state.append(0.0)   # queue depth placeholder
    return np.array(state, dtype=np.float32)

def compute_reward(state: np.ndarray, action: int, latency_ms: float) -> float:
    cpu_utils = [state[i * 3] for i in range(N_SERVERS)]   # normalised [0,1]
    chosen_cpu = cpu_utils[action] if action < len(cpu_utils) else 0.5

    r_latency  = -(latency_ms / 1000.0) * 0.5
    r_balance  = -float(np.std(cpu_utils)) * 0.3
    r_capacity = -10.0 if chosen_cpu > 0.85 else 0.0
    r_capacity *= 0.2

    return float(np.clip(r_latency + r_balance + r_capacity, -15.0, 1.0))

_prom_cache = {}

def _prom_poller():
    """Background poller so Prometheus network calls never block /decide or /feedback."""
    while True:
        try:
            for i in range(N_SERVERS):
                query = f'backend_cpu_utilization{{server_id="{i+1}"}}'
                r = requests.get(f"{PROM_URL}/api/v1/query", params={"query": query}, timeout=0.25)
                if r.status_code == 200:
                    result = r.json().get("data", {}).get("result", [])
                    if result and len(result) > 0:
                        _prom_cache[query] = float(result[0]["value"][1])
        except Exception:
            pass
        time.sleep(2)

threading.Thread(target=_prom_poller, daemon=True).start()

def _prom_metric(query: str) -> float | None:
    return _prom_cache.get(query, None)

# ── Prometheus Metrics ────────────────────────────────────────
prom_epsilon = Gauge("rl_epsilon", "Current exploration rate")
prom_reward  = Gauge("rl_avg_reward", "Average episodic reward")
prom_decides = Counter("rl_decisions_total", "Total routing decisions made")

# ── Flask API ─────────────────────────────────────────────────
agent = DQNAgent()

# Store RL transitions separately for each request
pending_transitions = {}
transition_lock = threading.Lock()

@app.route("/decide", methods=["POST"])
def decide():
    """
    POST /decide — called by Go load balancer per request.
    Body: { request_id: str, cpu_util: [], active_conns: [], avg_latency_ms: [], request_rate: N }
    Returns: { action: int, q_value: float }
    """
    payload = request.get_json(force=True) or {}
    request_id = payload.get("request_id")

    state = build_state(payload)
    action = agent.select_action(state)
    q_vals = agent.q_values(state)

    if request_id:
        with transition_lock:
            if len(pending_transitions) > 5000:
                old_keys = list(pending_transitions.keys())[:1000]
                for k in old_keys:
                    pending_transitions.pop(k, None)
            pending_transitions[request_id] = {
                "state": state,
                "action": action,
            }

    prom_decides.inc()

    return jsonify({
        "action": action,
        "q_value": float(max(q_vals))
    })

@app.route("/feedback", methods=["POST"])
def feedback():
    """
    POST /feedback — called by Go after request completes.
    Body: { request_id: str, server_id: int, latency_ms: float }
    """
    payload = request.get_json(force=True) or {}

    request_id = payload.get("request_id")
    latency_ms = float(payload.get("latency_ms", 200))
    server_id = int(payload.get("server_id", 0))

    with transition_lock:
        transition = pending_transitions.pop(request_id, None)

    if transition is None:
        return jsonify({
            "status": "skipped",
            "reason": "transition_not_found"
        })

    prev_state = transition["state"]
    prev_action = transition["action"]

    reward = compute_reward(
        prev_state,
        prev_action,
        latency_ms
    )

    # Build next state quickly
    next_payload = {
        "cpu_util": [],
        "active_conns": [],
        "avg_latency_ms": []
    }

    next_state = build_state(next_payload)

    agent.store_and_train(
        prev_state,
        prev_action,
        reward,
        next_state
    )

    return jsonify({
        "status": "ok",
        "reward": reward,
        "server_id": server_id
    })

@app.route("/status", methods=["GET"])
def status():
    with agent.lock:
        avg_r = float(np.mean(agent.recent_rewards)) if len(agent.recent_rewards) > 0 else (
            round(agent.total_reward / max(1, agent.episode_steps), 4)
        )
        return jsonify({
            "epsilon":         round(agent.epsilon, 4),
            "step_count":      agent.step_count,
            "buffer_len":      len(agent.buffer),
            "avg_reward":      round(avg_r, 4),
            "decisions_total": agent.decisions_total,
        })

@app.route("/reset", methods=["POST", "GET"])
def reset():
    with agent.lock:
        agent.total_reward = 0.0
        agent.episode_steps = 0
        agent.recent_rewards.clear()
    return jsonify({"status": "reset"})

@app.route("/metrics")
def metrics():
    return generate_latest(), 200, {"Content-Type": CONTENT_TYPE_LATEST}

@app.route("/health")
def health():
    return jsonify({"status": "ok"})

if __name__ == "__main__":
    log.info(f"RL Agent starting — state_dim={STATE_DIM} action_dim={ACTION_DIM}")
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, threaded=True)
