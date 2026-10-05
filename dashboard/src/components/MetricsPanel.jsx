import React from 'react'
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { useLBStore } from '../store/useLBStore'

const COLORS = ['#22c55e', '#3b82f6', '#f59e0b']

export default function MetricsPanel() {
  const latencyHistory = useLBStore(s => s.latencyHistory)
  const rpsHistory     = useLBStore(s => s.rpsHistory)
  const servers        = useLBStore(s => s.servers)
  const routingCounts  = useLBStore(s => s.routingCounts)
  const totalRequests  = useLBStore(s => s.totalRequests)
  const rlStats        = useLBStore(s => s.rlStats)

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
      {/* Latency Chart */}
      <ChartCard title="Response Latency (ms)">
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={latencyHistory} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#64748b' }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 9, fill: '#64748b' }} />
            <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e3a5f', fontSize: 11 }} />
            <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} />
            {[0,1,2].map(i => (
              <Line key={i} type="monotone" dataKey={`s${i}`} name={`Server ${i+1}`}
                stroke={COLORS[i]} dot={false} strokeWidth={2} connectNulls />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* RPS Chart */}
      <ChartCard title="Requests/sec">
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={rpsHistory} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#64748b' }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 9, fill: '#64748b' }} />
            <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e3a5f', fontSize: 11 }} />
            <Area type="monotone" dataKey="rps" stroke="#2e86ab" fill="#0d2137" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Server Status Table */}
      <ChartCard title="Server Status">
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: '#64748b', borderBottom: '1px solid #1e293b' }}>
              {['Server','CPU%','Conns','Latency','Requests','Health'].map(h => (
                <th key={h} style={{ padding: '4px 8px', textAlign: 'left', fontWeight: 500 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {servers.map(s => (
              <tr key={s.id} style={{ borderBottom: '1px solid #0f172a' }}>
                <td style={{ padding: '6px 8px', color: '#e2e8f0', fontWeight: 'bold' }}>S{s.id + 1}</td>
                <td style={{ padding: '6px 8px' }}>
                  <span style={{ color: cpuColor(s.cpu) }}>
                    {s.cpu !== null && s.cpu !== undefined ? `${Number(s.cpu).toFixed(1)}%` : 'N/A'}
                  </span>
                </td>
                <td style={{ padding: '6px 8px', color: '#94a3b8' }}>{s.conns ?? 0}</td>
                <td style={{ padding: '6px 8px', color: '#94a3b8' }}>{(s.latency_ms ?? 0).toFixed(0)}ms</td>
                <td style={{ padding: '6px 8px', color: '#94a3b8' }}>{routingCounts[s.id] || 0}</td>
                <td style={{ padding: '6px 8px' }}>
                  <span style={{ background: s.healthy ? '#166534' : '#7f1d1d', color: s.healthy ? '#4ade80' : '#f87171', padding: '1px 6px', borderRadius: 4, fontSize: 10 }}>
                    {s.healthy ? 'UP' : 'DOWN'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ChartCard>

      {/* Routing Distribution */}
      <ChartCard title="Routing Distribution">
        <div style={{ padding: '8px 0' }}>
          {servers.map(s => {
            const pct = totalRequests > 0 ? ((routingCounts[s.id] || 0) / totalRequests * 100).toFixed(1) : 0
            return (
              <div key={s.id} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <span style={{ fontSize: 12, color: '#e2e8f0' }}>Server {s.id + 1}</span>
                  <span style={{ fontSize: 12, color: COLORS[s.id] }}>{pct}% ({routingCounts[s.id] || 0})</span>
                </div>
                <div style={{ background: '#1e293b', borderRadius: 4, height: 8 }}>
                  <div style={{ background: COLORS[s.id], height: 8, borderRadius: 4, width: `${pct}%`, transition: 'width 0.4s ease' }} />
                </div>
              </div>
            )
          })}
          <div style={{ marginTop: 12, fontSize: 11, color: '#64748b' }}>
            Total: {totalRequests} requests
          </div>
        </div>
      </ChartCard>

      {/* RL Agent Live Metrics from Prometheus */}
      <div style={{ gridColumn: 'span 2' }}>
        <ChartCard title="RL Agent (DQN Live Prometheus Metrics)">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
            <div style={{ background: '#0a0e1a', padding: '12px 16px', borderRadius: 8, border: '1px solid #1e293b' }}>
              <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', marginBottom: 6 }}>Average Reward (Episodic)</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: rlStats?.avgReward != null ? (rlStats.avgReward >= 0 ? '#22c55e' : '#f59e0b') : '#64748b' }}>
                {rlStats?.avgReward != null ? Number(rlStats.avgReward).toFixed(4) : 'N/A'}
              </div>
            </div>
            <div style={{ background: '#0a0e1a', padding: '12px 16px', borderRadius: 8, border: '1px solid #1e293b' }}>
              <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', marginBottom: 6 }}>Exploration Rate (ε)</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: rlStats?.epsilon != null ? '#a78bfa' : '#64748b' }}>
                {rlStats?.epsilon != null ? `${(Number(rlStats.epsilon) * 100).toFixed(1)}%` : 'N/A'}
              </div>
            </div>
            <div style={{ background: '#0a0e1a', padding: '12px 16px', borderRadius: 8, border: '1px solid #1e293b' }}>
              <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', marginBottom: 6 }}>Routing Decisions Total</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: rlStats?.decisionsTotal != null ? '#38bdf8' : '#64748b' }}>
                {rlStats?.decisionsTotal != null ? Number(rlStats.decisionsTotal).toLocaleString() : 'N/A'}
              </div>
            </div>
          </div>
        </ChartCard>
      </div>
    </div>
  )
}

function ChartCard({ title, children }) {
  return (
    <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function cpuColor(cpu) {
  if (cpu === null || cpu === undefined) return '#64748b'
  if (cpu < 40) return '#22c55e'
  if (cpu < 70) return '#eab308'
  return '#ef4444'
}
