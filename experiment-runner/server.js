const express = require('express');
const path = require('path');
const { spawn, exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());

// Enable CORS for http://localhost:3000
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'http://localhost:3000');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

let runningProcess = null;
let currentScenario = null;
let failureTimer = null;
let isStopping = false;

function stopBackend2() {
  return new Promise((resolve) => {
    console.log('[experiment-runner] Triggering failure on backend-2...');
    const http = require('http');
    const req = http.request({ host: '127.0.0.1', port: 8082, path: '/simulate-fail', method: 'POST', timeout: 1000 }, (res) => {
      console.log(`[experiment-runner] backend-2 failure activated via HTTP (${res.statusCode})`);
      resolve();
    });
    req.on('error', () => {
      exec('docker stop backend-2', () => resolve());
    });
    req.end();
  });
}

function restartBackend2() {
  return new Promise((resolve) => {
    console.log('[experiment-runner] Recovering backend-2...');
    const http = require('http');
    const req = http.request({ host: '127.0.0.1', port: 8082, path: '/simulate-recover', method: 'POST', timeout: 1000 }, (res) => {
      console.log(`[experiment-runner] backend-2 recovered via HTTP (${res.statusCode})`);
      resolve();
    });
    req.on('error', () => {
      exec('docker start backend-2', () => resolve());
    });
    req.end();
  });
}

// GET /health
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// GET /status
app.get('/status', (req, res) => {
  res.json({
    running: runningProcess !== null,
    scenario: currentScenario,
  });
});

// POST /start
app.post('/start', (req, res) => {
  if (runningProcess !== null) {
    return res.status(409).json({
      status: 'error',
      message: 'An experiment is already running',
      scenario: currentScenario,
    });
  }

  const scenario = req.body?.scenario || 'normal';
  currentScenario = scenario;
  isStopping = false;

  const env = {
    ...process.env,
    SCENARIO: scenario,
  };

  const scriptPath = process.env.SCRIPT_PATH || path.resolve(__dirname, '../scripts/loadtest.js');
  runningProcess = spawn('k6', ['run', scriptPath], { env });

  if (scenario === 'failure') {
    failureTimer = setTimeout(() => {
      stopBackend2();
    }, 5000);
  }

  runningProcess.stdout.on('data', (data) => {
    process.stdout.write(`[k6] ${data}`);
  });

  runningProcess.stderr.on('data', (data) => {
    process.stderr.write(`[k6 err] ${data}`);
  });

  const onProcessEnd = async (code, err) => {
    if (err) {
      console.error(`[k6] Failed to start/run process:`, err);
    } else {
      console.log(`[k6] Process exited with code ${code}`);
    }

    if (failureTimer) {
      clearTimeout(failureTimer);
      failureTimer = null;
    }

    if (!isStopping) {
      if (currentScenario === 'failure') {
        await restartBackend2();
      }
      runningProcess = null;
      currentScenario = null;
    }
  };

  runningProcess.on('close', (code) => onProcessEnd(code));
  runningProcess.on('error', (err) => onProcessEnd(null, err));

  res.json({
    status: 'started',
    scenario: scenario,
  });
});

function killK6Processes(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      if (pid) {
        try { exec(`taskkill /pid ${pid} /T /F`); } catch (_) {}
      }
      exec('taskkill /IM k6.exe /F /T', () => resolve());
    } else {
      if (pid) {
        try { process.kill(-pid, 'SIGKILL'); } catch (_) {
          try { process.kill(pid, 'SIGKILL'); } catch (_) {}
        }
      }
      exec('pkill -9 -f k6', () => resolve());
    }
  });
}

// POST /stop
app.post('/stop', async (req, res) => {
  isStopping = true;
  if (failureTimer) {
    clearTimeout(failureTimer);
    failureTimer = null;
  }

  // Synchronously kill the spawned k6 process handle in 0ms
  if (runningProcess) {
    try { runningProcess.kill(); } catch (_) {}
  }

  const pid = runningProcess?.pid;
  const isFailure = currentScenario === 'failure';

  // Unconditionally terminate any remaining k6 process instances
  await killK6Processes(pid);

  if (isFailure) {
    restartBackend2().catch(() => {});
  }

  runningProcess = null;
  currentScenario = null;
  isStopping = false;

  return res.json({ status: 'stopped' });
});

app.listen(PORT, () => {
  console.log(`[experiment-runner] Server listening on port ${PORT}`);
});
