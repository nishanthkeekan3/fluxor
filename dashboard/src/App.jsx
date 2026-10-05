import React from 'react'
import { useWebSocket } from './hooks/useWebSocket'
import { useExperiment } from './hooks/useExperiment'
import { useLBStore } from './store/useLBStore'
import TopologyCanvas from './components/TopologyCanvas'
import MetricsPanel from './components/MetricsPanel'

const ALGO_OPTIONS = [
  { value: 'rr', label: 'Round Robin', color: '#3b82f6', desc: 'Distributes evenly in sequence' },
  { value: 'lc', label: 'Least Conn', color: '#f59e0b', desc: 'Routes to least loaded server' },
  { value: 'rl', label: 'RL Agent', color: '#a78bfa', desc: 'DQN adaptive routing' },
]

export default function App() {
  const { setAlgorithm } = useWebSocket()
  const {
    startExperiment,
    stopExperiment,
    refreshExperimentStatus,
  } = useExperiment()

  const wsStatus           = useLBStore(s => s.wsStatus)
  const algorithm          = useLBStore(s => s.algorithm)
  const totalReqs          = useLBStore(s => s.totalRequests)
  const experimentRunning  = useLBStore(s => s.experimentRunning)
  const experimentScenario = useLBStore(s => s.experimentScenario)

  const [selectedScenario, setSelectedScenario] = React.useState('normal')
  const [experimentError, setExperimentError] = React.useState(null)

  React.useEffect(() => {
    refreshExperimentStatus().catch(() => {})
  }, [refreshExperimentStatus])

  const handleRunExperiment = async () => {
    setExperimentError(null)
    try {
      await startExperiment(selectedScenario)
    } catch (err) {
      setExperimentError(err.message || 'Failed to start experiment')
    }
  }

  const handleStopExperiment = async () => {
    setExperimentError(null)
    try {
      await stopExperiment()
    } catch (err) {
      setExperimentError(err.message || 'Failed to stop experiment')
    }
  }

  return (
    <div style={{ minHeight: '100vh', padding: '16px 24px', background: '#0a0e1a' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, borderBottom: '1px solid #1e293b', paddingBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: '#e2e8f0', letterSpacing: '-0.01em' }}>
            RL Load Balancer
            <span style={{ marginLeft: 10, fontSize: 12, color: '#2e86ab', fontWeight: 400, background: '#0d2137', padding: '2px 8px', borderRadius: 4 }}>
              LIVE
            </span>
          </h1>
          <p style={{ fontSize: 12, color: '#475569', marginTop: 2 }}>Adaptive Reinforcement Learning — Distributed Server System</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ fontSize: 12, color: '#64748b' }}>
            Requests: <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{totalReqs}</span>
          </div>
          <StatusBadge status={wsStatus} />
        </div>
      </div>

      {/* Algorithm Selector */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <span style={{ fontSize: 12, color: '#64748b', alignSelf: 'center', marginRight: 4 }}>ALGORITHM:</span>
        {ALGO_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => setAlgorithm(opt.value)}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              border: `2px solid ${algorithm === opt.value ? opt.color : '#1e293b'}`,
              background: algorithm === opt.value ? `${opt.color}20` : '#0f172a',
              color: algorithm === opt.value ? opt.color : '#64748b',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            {opt.label}
            <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 400, color: algorithm === opt.value ? opt.color : '#475569' }}>
              {opt.desc}
            </span>
          </button>
        ))}
      </div>

      {/* Experiment Control Panel */}
      <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: '12px 16px', marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Load Test Experiment:
            </span>
            <select
              value={selectedScenario}
              onChange={(e) => setSelectedScenario(e.target.value)}
              disabled={experimentRunning}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                border: '1px solid #1e293b',
                background: '#0a0e1a',
                color: '#e2e8f0',
                fontSize: 12,
                cursor: experimentRunning ? 'not-allowed' : 'pointer',
                outline: 'none',
              }}
            >
              <option value="normal">Normal Traffic</option>
              <option value="spike">Traffic Spike</option>
              <option value="failure">Server Failure</option>
            </select>
            <button
              type="button"
              onClick={handleRunExperiment}
              disabled={experimentRunning}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                border: 'none',
                background: experimentRunning ? '#1e293b' : '#16a34a',
                color: experimentRunning ? '#64748b' : '#ffffff',
                fontSize: 12,
                fontWeight: 600,
                cursor: experimentRunning ? 'not-allowed' : 'pointer',
                transition: 'all 0.2s',
              }}
            >
              RUN EXPERIMENT
            </button>
            <button
              type="button"
              onClick={handleStopExperiment}
              disabled={!experimentRunning}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                border: 'none',
                background: !experimentRunning ? '#1e293b' : '#dc2626',
                color: !experimentRunning ? '#64748b' : '#ffffff',
                fontSize: 12,
                fontWeight: 600,
                cursor: !experimentRunning ? 'not-allowed' : 'pointer',
                transition: 'all 0.2s',
              }}
            >
              STOP
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ color: '#64748b' }}>STATUS:</span>
            {experimentRunning ? (
              <span style={{ color: '#22c55e', fontWeight: 700, background: '#052e16', padding: '3px 8px', borderRadius: 4, border: '1px solid #22c55e40' }}>
                RUNNING ({experimentScenario || selectedScenario})
              </span>
            ) : (
              <span style={{ color: '#94a3b8', fontWeight: 600, background: '#0a0e1a', padding: '3px 8px', borderRadius: 4, border: '1px solid #1e293b' }}>
                IDLE
              </span>
            )}
          </div>
        </div>
        {experimentError && (
          <div style={{ color: '#f87171', background: '#450a0a', padding: '6px 12px', borderRadius: 6, fontSize: 11, border: '1px solid #ef444440', marginTop: 10 }}>
            {experimentError}
          </div>
        )}
      </div>

      {/* Topology Canvas */}
      <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 12, padding: 4, marginBottom: 4 }}>
        <div style={{ fontSize: 11, color: '#475569', padding: '8px 12px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Request Flow Visualization — Real Time
        </div>
        <TopologyCanvas />
      </div>

      {/* Metrics */}
      <MetricsPanel />

      {/* Footer */}
      <div style={{ marginTop: 20, textAlign: 'center', fontSize: 11, color: '#334155' }}>
        Active Algorithm: <b style={{ color: '#2e86ab' }}>{algorithm.toUpperCase()}</b> &nbsp;·&nbsp;
        WebSocket: <b style={{ color: wsStatus === 'connected' ? '#22c55e' : '#ef4444' }}>{wsStatus}</b> &nbsp;·&nbsp;
        Backend: 3 servers &nbsp;·&nbsp;
        RL Agent: DQN (CPU)
      </div>
    </div>
  )
}

function StatusBadge({ status }) {
  const map = {
    connected:    { color: '#22c55e', bg: '#052e16', dot: '#4ade80' },
    disconnected: { color: '#ef4444', bg: '#1c0606', dot: '#f87171' },
    error:        { color: '#f59e0b', bg: '#1c1006', dot: '#fbbf24' },
  }
  const style = map[status] || map.disconnected
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: style.bg, padding: '5px 12px', borderRadius: 20, border: `1px solid ${style.color}30` }}>
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: style.dot,
        animation: status === 'connected' ? 'pulse 2s infinite' : 'none' }} />
      <span style={{ fontSize: 11, color: style.color, fontWeight: 600 }}>{status.toUpperCase()}</span>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
    </div>
  )
}
