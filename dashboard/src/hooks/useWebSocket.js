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

    // Poll real Prometheus API for backend_cpu_utilization and RL metrics
    const pollPrometheus = () => {
      // 1. Fetch real backend CPU utilization
      fetch(`${promUrl}/api/v1/query?query=backend_cpu_utilization`)
        .then(r => r.json())
        .then(data => {
          if (data?.status === 'success' && Array.isArray(data?.data?.result)) {
            const newCpuMap = {}
            data.data.result.forEach(item => {
              // Server IDs in Prometheus metric are "1", "2", "3" -> 0-indexed in store: 0, 1, 2
              const sid = parseInt(item.metric?.server_id, 10) - 1
              const val = parseFloat(item.value?.[1])
              if (!isNaN(sid) && !isNaN(val)) {
                newCpuMap[sid] = val
              }
            })
            cpuMapRef.current = newCpuMap

            // Update current servers in store with real CPU values
            const currentServers = useLBStore.getState().servers || []
            const updated = currentServers.map(s => ({
              ...s,
              cpu: newCpuMap[s.id] !== undefined ? newCpuMap[s.id] : null,
            }))
            useLBStore.getState().updateServers(updated)
          } else {
            cpuMapRef.current = {}
            const currentServers = useLBStore.getState().servers || []
            const updated = currentServers.map(s => ({ ...s, cpu: null }))
            useLBStore.getState().updateServers(updated)
          }
        })
        .catch(() => {
          // If Prometheus is unavailable, show unknown/unavailable state (null)
          cpuMapRef.current = {}
          const currentServers = useLBStore.getState().servers || []
          const updated = currentServers.map(s => ({ ...s, cpu: null }))
          useLBStore.getState().updateServers(updated)
        })

      // 2. Fetch real RL metrics from Prometheus if available
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
          if (!isNaN(val)) {
            avgReward = val
            const timeLabel = new Date().toLocaleTimeString()
            useLBStore.getState().pushReward({ time: timeLabel, reward: parseFloat(val.toFixed(4)) })
          }
        }
        if (epsRes.status === 'fulfilled' && epsRes.value?.data?.result?.[0]?.value?.[1]) {
          const val = parseFloat(epsRes.value.data.result[0].value[1])
          if (!isNaN(val)) epsilon = val
        }
        if (decRes.status === 'fulfilled' && decRes.value?.data?.result?.[0]?.value?.[1]) {
          const val = parseInt(decRes.value.data.result[0].value[1], 10)
          if (!isNaN(val)) decisionsTotal = val
        }

        useLBStore.setState({
          rlStats: {
            avgReward,
            epsilon,
            decisionsTotal,
          }
        })
      }).catch(() => {})
    }

    pollPrometheus()
    const promInterval = setInterval(pollPrometheus, 2000)

    return () => {
      isCleanedUpRef.current = true
      clearInterval(statusInterval)
      clearInterval(promInterval)
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

  // Track RPS
  const nowMs = Date.now()
  rpsWindow.push(nowMs)
  rpsWindow = rpsWindow.filter(t => nowMs - t < 5000)
  store.pushRps({ time: timeLabel, rps: (rpsWindow.length / 5).toFixed(1) })
}
