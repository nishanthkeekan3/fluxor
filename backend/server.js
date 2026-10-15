const express = require('express');
const client = require('prom-client');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 8081;
const SERVER_ID = process.env.SERVER_ID || '1';

// ── Prometheus metrics ────────────────────────────────────────
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const reqCounter = new client.Counter({
  name: 'backend_requests_total',
  help: 'Total requests handled',
  labelNames: ['server_id', 'status'],
  registers: [register],
});

const latencyHist = new client.Histogram({
  name: 'backend_request_latency_ms',
  help: 'Request latency in ms',
  labelNames: ['server_id'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [register],
});

const activeConnsGauge = new client.Gauge({
  name: 'backend_active_connections',
  help: 'Current active connections',
  labelNames: ['server_id'],
  registers: [register],
});

const cpuGauge = new client.Gauge({
  name: 'backend_cpu_utilization',
  help: 'CPU utilization 0-100',
  labelNames: ['server_id'],
  registers: [register],
});

// ── State ─────────────────────────────────────────────────────
let activeConnections = 0;
let cpuLoad = 0;

// Simulate CPU measurement
function measureCPU() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  cpus.forEach(cpu => {
    for (const type in cpu.times) {
      total += cpu.times[type];
    }
    idle += cpu.times.idle;
  });
  return Math.max(0, Math.min(100, (1 - idle / total) * 100 + Math.random() * 10));
}

setInterval(() => {
  cpuLoad = measureCPU();
  cpuGauge.set({ server_id: SERVER_ID }, cpuLoad);
  activeConnsGauge.set({ server_id: SERVER_ID }, activeConnections);
}, 2000);

// ── Failure Simulation ───────────────────────────────────────
let isFailed = false;

app.all('/simulate-fail', (req, res) => {
  isFailed = true;
  console.log(`[backend-${SERVER_ID}] Simulated failure activated!`);
  res.json({ status: 'failed', server_id: SERVER_ID });
});

app.all('/simulate-recover', (req, res) => {
  isFailed = false;
  console.log(`[backend-${SERVER_ID}] Simulated failure recovered!`);
  res.json({ status: 'recovered', server_id: SERVER_ID });
});

app.use((req, res, next) => {
  if (isFailed && !req.path.startsWith('/simulate-')) {
    return res.status(503).json({ error: 'Server unavailable (simulated failure)', server_id: SERVER_ID });
  }
  next();
});

app.use((req, res, next) => {
  activeConnections++;
  activeConnsGauge.set({ server_id: SERVER_ID }, activeConnections);
  const start = Date.now();
  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    activeConnections = Math.max(0, activeConnections - 1);
    const ms = Date.now() - start;
    latencyHist.observe({ server_id: SERVER_ID }, ms);
    reqCounter.inc({ server_id: SERVER_ID, status: res.statusCode || 499 });
    activeConnsGauge.set({ server_id: SERVER_ID }, activeConnections);
  };
  res.on('finish', cleanup);
  res.on('close', cleanup);
  next();
});

// ── Routes ────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', server_id: SERVER_ID, timestamp: Date.now() });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Main work endpoint — simulates real computation
app.all('/work', async (req, res) => {
  // Simulate variable latency based on server ID and load
  const baseLatency = parseInt(SERVER_ID) * 15; // server-specific baseline
  const loadLatency = Math.floor(cpuLoad * 2);   // load-based extra
  const jitter = Math.floor(Math.random() * 20);
  const totalMs = baseLatency + loadLatency + jitter;

  await sleep(totalMs);
  res.json({
    server_id: SERVER_ID,
    latency_ms: totalMs,
    cpu_load: cpuLoad.toFixed(1),
    active_conns: activeConnections,
    timestamp: Date.now(),
  });
});

// Stress endpoint — artificially raises CPU to simulate load spikes
app.post('/stress', async (req, res) => {
  const duration = parseInt(req.query.duration || '5000');
  const end = Date.now() + Math.min(duration, 30000);
  // CPU-intensive loop
  while (Date.now() < end) {
    Math.sqrt(Math.random() * 1000000);
  }
  res.json({ server_id: SERVER_ID, stressed_for_ms: duration });
});

// Status endpoint
app.get('/status', (req, res) => {
  res.json({
    server_id: SERVER_ID,
    active_connections: activeConnections,
    cpu_load: cpuLoad.toFixed(1),
    uptime_s: process.uptime().toFixed(0),
  });
});

app.listen(PORT, () => {
  console.log(`[Backend-${SERVER_ID}] listening on :${PORT}`);
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
