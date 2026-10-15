import { useEffect, useRef, useCallback } from 'react'
import { useLBStore } from '../store/useLBStore'

const getHost = () => {
  if (typeof window !== 'undefined' && window.location?.hostname) {
    return window.location.hostname
  }
  return 'localhost'
}

const getWsUrl = () => {
  const env = import.meta.env.VITE_WS_URL
  if (env && !env.includes('load-balancer')) {
    return env
  }
  return `ws://${getHost()}:8080/ws`
}

const getLbUrl = () => {
  const env = import.meta.env.VITE_LB_URL
  if (env && !env.includes('load-balancer')) {
    return env
  }
  return `http://${getHost()}:8080`
}

const getPromUrl = () => {
  return `http://${getHost()}:9090`
}

const getRlAgentUrl = () => {
  return `http://${getHost()}:5000`
}

let rpsWindow = []

export function useWebSocket() {
  const wsRef = useRef(null)
  const retryRef = useRef(null)
  const isCleanedUpRef = useRef(false)
  const cpuMapRef = useRef({})

  const connect = useCallback(() => {
    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN ||
       wsRef.current.readyState === WebSocket.CONNECTING)
    ) {
      return
    }

    if (isCleanedUpRef.current) return

    const wsUrl = getWsUrl()
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      useLBStore.getState().setWsStatus('connected')
      clearTimeout(retryRef.current)
      console.log('[WS] connected to', wsUrl)
    }

    ws.onclose = () => {
      useLBStore.getState().setWsStatus('disconnected')
      if (!isCleanedUpRef.current) {
        clearTimeout(retryRef.current)
        retryRef.current = setTimeout(connect, 2000)
      }
    }

    ws.onerror = () => {
      useLBStore.getState().setWsStatus('error')
    }

    ws.onmessage = (evt) => {
      try {
        const event = JSON.parse(evt.data)
        if (event.type === 'ROUTE_EVENT') {
          handleRouteEvent(event, cpuMapRef)
        }
      } catch {}
    }
  }, [])

  // Send algorithm change command & refresh actual /admin/status
  const setAlgorithm = useCallback((algo) => {
    const lbUrl = getLbUrl()

    // 1. Send via WebSocket if open
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'SET_ALGO', algo }))
    }

    // 2. Call REST endpoint and refresh /admin/status
    fetch(`${lbUrl}/admin/algorithm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ algorithm: algo }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.algorithm) useLBStore.getState().setAlgorithm(data.algorithm)
        // Refresh the actual /admin/status state from load balancer
        return fetch(`${lbUrl}/admin/status`)
      })
      .then(r => r ? r.json() : null)
      .then(data => {
        if (data) {
          if (data.algorithm) useLBStore.getState().setAlgorithm(data.algorithm)
          if (data.servers) {
            const merged = data.servers.map(s => ({
              ...s,
              cpu: cpuMapRef.current[s.id] !== undefined ? cpuMapRef.current[s.id] : null,
            }))
            useLBStore.getState().updateServers(merged)
          }
        }
      })
      .catch((err) => {
        console.error('[LB] Failed to update algorithm:', err)
      })
  }, [])

  useEffect(() => {
    isCleanedUpRef.current = false
    connect()
    const lbUrl = getLbUrl()
    const promUrl = getPromUrl()

    // Poll /admin/status every 3s for initial & background state sync
    const statusInterval = setInterval(() => {
      fetch(`${lbUrl}/admin/status`)
        .then(r => r.json())
        .then(data => {
          if (data.servers) {
            const merged = data.servers.map(s => ({
              ...s,
              cpu: cpuMapRef.current[s.id] !== undefined ? cpuMapRef.current[s.id] : null,
            }))
            useLBStore.getState().updateServers(merged)
          }
          if (data.algorithm) useLBStore.getState().setAlgorithm(data.algorithm)
        })
        .catch(() => {})
    }, 3000)

    // Poll metrics from Prometheus with graceful direct fallback to RL Agent and Backends
    const pollPrometheus = () => {
      const fallbackBackendCpu = () => {
        const ports = [8081, 8082, 8083]
        Promise.allSettled(
          ports.map((port, idx) =>
            fetch(`http://${getHost()}:${port}/status`)
              .then(r => r.json())
              .then(d => ({ id: idx, cpu: parseFloat(d.cpu_load) }))
          )
        ).then(results => {
          const newCpuMap = {}
          results.forEach(res => {
            if (res.status === 'fulfilled' && !isNaN(res.value?.cpu)) {
              newCpuMap[res.value.id] = res.value.cpu
            }
          })
          if (Object.keys(newCpuMap).length > 0) {
            cpuMapRef.current = newCpuMap
            const currentServers = useLBStore.getState().servers || []
            const updated = currentServers.map(s => ({
              ...s,
              cpu: newCpuMap[s.id] !== undefined ? newCpuMap[s.id] : s.cpu,
            }))
            useLBStore.getState().updateServers(updated)
          }
        }).catch(() => {})
      }

      // 1. Fetch backend CPU
      fetch(`${promUrl}/api/v1/query?query=backend_cpu_utilization`)
        .then(r => r.json())
        .then(data => {
          if (data?.status === 'success' && Array.isArray(data?.data?.result) && data.data.result.length > 0) {
            const newCpuMap = {}
            data.data.result.forEach(item => {
              const sid = parseInt(item.metric?.server_id, 10) - 1
              const val = parseFloat(item.value?.[1])
              if (!isNaN(sid) && !isNaN(val)) {
                newCpuMap[sid] = val
              }
            })
            cpuMapRef.current = newCpuMap
            const currentServers = useLBStore.getState().servers || []
            const updated = currentServers.map(s => ({
              ...s,
              cpu: newCpuMap[s.id] !== undefined ? newCpuMap[s.id] : null,
            }))
            useLBStore.getState().updateServers(updated)
          } else {
            fallbackBackendCpu()
          }
        })
        .catch(() => {
          fallbackBackendCpu()
        })

      // 2. Fetch RL metrics (Prometheus with direct fallback to RL Agent /status)
      Promise.allSettled([
        fetch(`${promUrl}/api/v1/query?query=rl_avg_reward`).then(r => r.json()),
        fetch(`${promUrl}/api/v1/query?query=rl_epsilon`).then(r => r.json()),
        fetch(`${promUrl}/api/v1/query?query=rl_decisions_total`).then(r => r.json()),
      ]).then(([rewardRes, epsRes, decRes]) => {
        let avgReward = null
        let epsilon = null
        let decisionsTotal = null

        if (rewardRes.status === 'fulfilled' && rewardRes.value?.data?.result?.[0]?.value?.[1]) {
          const val = parseFloat(rewardRes.value.data.result[0].value[1])
          if (!isNaN(val)) avgReward = val
        }
        if (epsRes.status === 'fulfilled' && epsRes.value?.data?.result?.[0]?.value?.[1]) {
          const val = parseFloat(epsRes.value.data.result[0].value[1])
          if (!isNaN(val)) epsilon = val
        }
        if (decRes.status === 'fulfilled' && decRes.value?.data?.result?.[0]?.value?.[1]) {
          const val = parseInt(decRes.value.data.result[0].value[1], 10)
          if (!isNaN(val)) decisionsTotal = val
        }

        if (avgReward != null || epsilon != null || decisionsTotal != null) {
          if (avgReward != null) {
            const timeLabel = new Date().toLocaleTimeString()
            useLBStore.getState().pushReward({ time: timeLabel, reward: parseFloat(avgReward.toFixed(4)) })
          }
          useLBStore.setState({
            rlStats: { avgReward, epsilon, decisionsTotal }
          })
        } else {
          // Direct fallback to RL Agent /status on :5000
          fetch(`${getRlAgentUrl()}/status`)
            .then(r => r.json())
            .then(data => {
              if (data && data.step_count !== undefined) {
                const timeLabel = new Date().toLocaleTimeString()
                const rVal = parseFloat(Number(data.avg_reward || 0).toFixed(4))
                useLBStore.getState().pushReward({ time: timeLabel, reward: rVal })
                useLBStore.setState({
                  rlStats: {
                    avgReward: data.avg_reward,
                    epsilon: data.epsilon,
                    decisionsTotal: data.decisions_total !== undefined ? data.decisions_total : data.step_count,
                  }
                })
              }
            })
            .catch(() => {})
        }
      }).catch(() => {})
    }

    pollPrometheus()
    const promInterval = setInterval(pollPrometheus, 2000)

    // Active RPS decay ticker — ensures RPS chart drops immediately and accurately to 0 when stopped
    const rpsInterval = setInterval(() => {
      const nowMs = Date.now()
      const prevLen = rpsWindow.length
      rpsWindow = rpsWindow.filter(t => nowMs - t < 3000)
      if (prevLen > 0 || rpsWindow.length > 0) {
        const timeLabel = new Date().toLocaleTimeString()
        const rps = (rpsWindow.length / 3).toFixed(1)
        useLBStore.getState().pushRps({ time: timeLabel, rps })
      }
    }, 1000)

    return () => {
      isCleanedUpRef.current = true
      clearInterval(statusInterval)
      clearInterval(promInterval)
      clearInterval(rpsInterval)
      clearTimeout(retryRef.current)
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [connect])

  return { setAlgorithm }
}

function handleRouteEvent(event, cpuMapRef) {
  const store = useLBStore.getState()
  const now = new Date(event.timestamp)
  const timeLabel = now.toLocaleTimeString()

  // Update server states with real CPU attached
  if (event.server_states) {
    const merged = event.server_states.map(s => ({
      ...s,
      cpu: cpuMapRef?.current?.[s.id] !== undefined ? cpuMapRef.current[s.id] : null,
    }))
    store.updateServers(merged)
  }

  // When experiment is NOT running, immediately drop trailing route events to freeze count
  if (!store.experimentRunning) {
    return
  }

  // Increment counters
  store.incRequest(event.server_id)

  // Add particle for animation
  store.addParticle({
    id: event.request_id + '_' + Date.now(),
    serverId: event.server_id,
    ts: Date.now(),
  })

  // Track latency per server
  const latEntry = { time: timeLabel }
  if (event.server_states) {
    event.server_states.forEach(s => { latEntry[`s${s.id}`] = Math.round(s.latency_ms) })
  }
  store.pushLatency(latEntry)

  // Track RPS with responsive 3s window
  const nowMs = Date.now()
  rpsWindow.push(nowMs)
  rpsWindow = rpsWindow.filter(t => nowMs - t < 3000)
  store.pushRps({ time: timeLabel, rps: (rpsWindow.length / 3).toFixed(1) })
}
