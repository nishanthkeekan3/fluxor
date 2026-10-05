const express = require('express');
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
    console.log('[experiment-runner] Stopping container backend-2...');
    exec('docker stop backend-2', (err, stdout, stderr) => {
      if (err) {
        console.error('[experiment-runner] Failed to stop backend-2:', err.message);
      } else {
        console.log('[experiment-runner] backend-2 stopped successfully');
      }
      resolve();
    });
  });
}

function restartBackend2() {
  return new Promise((resolve) => {
    console.log('[experiment-runner] Restarting container backend-2...');
    exec('docker start backend-2', (err, stdout, stderr) => {
      if (err) {
        console.error('[experiment-runner] Failed to restart backend-2:', err.message);
      } else {
        console.log('[experiment-runner] backend-2 restarted successfully');
      }
      resolve();
    });
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

  runningProcess = spawn('k6', ['run', '/scripts/loadtest.js'], { env });

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

// POST /stop
app.post('/stop', async (req, res) => {
  if (!runningProcess) {
    if (currentScenario === 'failure') {
      if (failureTimer) {
        clearTimeout(failureTimer);
        failureTimer = null;
      }
      await restartBackend2();
      currentScenario = null;
    }
    return res.json({ status: 'stopped' });
  }

  isStopping = true;
  if (failureTimer) {
    clearTimeout(failureTimer);
    failureTimer = null;
  }

  const proc = runningProcess;
  const isFailure = currentScenario === 'failure';
  let closed = false;
  let forceKillTimer = null;

  const cleanupAndRespond = async () => {
    if (closed) return;
    closed = true;
    if (forceKillTimer) clearTimeout(forceKillTimer);

    if (isFailure) {
      await restartBackend2();
    }

    runningProcess = null;
    currentScenario = null;
    isStopping = false;
    res.json({ status: 'stopped' });
  };

  proc.once('close', cleanupAndRespond);
  proc.once('error', cleanupAndRespond);

  try {
    proc.kill('SIGINT');
  } catch (err) {
    cleanupAndRespond();
    return;
  }

  forceKillTimer = setTimeout(() => {
    if (!closed) {
      try {
        proc.kill('SIGKILL');
      } catch (err) {
        cleanupAndRespond();
      }
    }
  }, 2000);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[experiment-runner] Server listening on port ${PORT}`);
});
