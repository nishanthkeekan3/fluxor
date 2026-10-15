// k6 load test scripts for all 3 experimental scenarios
// Run: k6 run scripts/test_normal.js
// Install k6: brew install k6

import http from 'k6/http'
import { sleep, check } from 'k6'

const LB = __ENV.LB_URL || 'http://localhost:8080'

// ── Scenario 1: Normal Traffic ────────────────────────────────
export const normalOptions = {
  scenarios: {
    normal: {
      executor: 'constant-vus',
      vus: 50,
      duration: '60s',
      gracefulStop: '0s',
    }
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
}

// ── Scenario 2: Traffic Spike ─────────────────────────────────
export const spikeOptions = {
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '30s', target: 200 },
        { duration: '30s', target: 200 },
        { duration: '20s', target: 10 },
      ],
      gracefulRampDown: '0s',
      gracefulStop: '0s',
    }
  },
}

// ── Scenario 3: Server Failure ────────────────────────────────
export const failureOptions = {
  scenarios: {
    failure_test: {
      executor: 'constant-vus',
      vus: 50,
      duration: '90s',
      gracefulStop: '0s',
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
  },
}

// Default export — change options to switch scenario
const scenario = __ENV.SCENARIO || 'spike'

export const options =
  scenario === 'normal' ? normalOptions :
  scenario === 'failure' ? failureOptions :
  spikeOptions

export default function () {
  const res = http.get(`${LB}/work`, { timeout: '5s' })
  check(res, {
    'status is 200': (r) => r.status === 200,
    'latency < 1s': (r) => r.timings.duration < 1000,
  })
  sleep(0.1)
}
