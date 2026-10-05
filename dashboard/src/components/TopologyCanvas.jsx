import React, { useEffect, useRef } from 'react'
import * as d3 from 'd3'
import { useLBStore } from '../store/useLBStore'

// Node positions (will scale with container)
const NODES = {
  client: { x: 0.1, y: 0.5, label: 'Clients', type: 'client' },
  lb:     { x: 0.42, y: 0.5, label: 'Load\nBalancer', type: 'lb' },
  s0:     { x: 0.78, y: 0.2, label: 'Server 1', type: 'server', id: 0 },
  s1:     { x: 0.78, y: 0.5, label: 'Server 2', type: 'server', id: 1 },
  s2:     { x: 0.78, y: 0.8, label: 'Server 3', type: 'server', id: 2 },
}

function cpuColor(cpu) {
  // cpu 0..1 → green → yellow → red
  const t = Math.min(1, cpu)
  if (t < 0.5) return d3.interpolateRgb('#22c55e', '#eab308')(t * 2)
  return d3.interpolateRgb('#eab308', '#ef4444')((t - 0.5) * 2)
}

export default function TopologyCanvas() {
  const svgRef = useRef(null)
  const storeRef = useRef(null)
  const particlesSeenRef = useRef(new Set())

  const servers = useLBStore(s => s.servers)
  const particles = useLBStore(s => s.particles)
  const removeParticle = useLBStore(s => s.removeParticle)
  const algorithm = useLBStore(s => s.algorithm)

  // Draw static topology
  useEffect(() => {
    const container = svgRef.current?.parentElement
    if (!container) return
    const W = container.clientWidth || 700
    const H = 320

    const svg = d3.select(svgRef.current)
      .attr('width', W).attr('height', H)

    svg.selectAll('*').remove()

    const px = k => k.x * W
    const py = k => k.y * H

    // Background gradient
    const defs = svg.append('defs')
    const grad = defs.append('linearGradient').attr('id', 'bg').attr('x1', 0).attr('x2', 1)
    grad.append('stop').attr('offset', '0%').attr('stop-color', '#0f172a')
    grad.append('stop').attr('offset', '100%').attr('stop-color', '#1e293b')
    svg.append('rect').attr('width', W).attr('height', H).attr('fill', 'url(#bg)').attr('rx', 12)

    // Glow filter
    const filter = defs.append('filter').attr('id', 'glow')
    filter.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'blur')
    const feMerge = filter.append('feMerge')
    feMerge.append('feMergeNode').attr('in', 'blur')
    feMerge.append('feMergeNode').attr('in', 'SourceGraphic')

    // Draw edges (client → lb)
    svg.append('path')
      .attr('d', `M${px(NODES.client)},${py(NODES.client)} C${px(NODES.client)+80},${py(NODES.client)} ${px(NODES.lb)-80},${py(NODES.lb)} ${px(NODES.lb)},${py(NODES.lb)}`)
      .attr('stroke', '#334155').attr('stroke-width', 2).attr('fill', 'none').attr('stroke-dasharray', '6,3')

    // Draw edges (lb → servers)
    ;['s0','s1','s2'].forEach(k => {
      const s = NODES[k]
      svg.append('path')
        .attr('class', `edge-to-${s.id}`)
        .attr('d', `M${px(NODES.lb)},${py(NODES.lb)} C${px(NODES.lb)+80},${py(NODES.lb)} ${px(s)-80},${py(s)} ${px(s)},${py(s)}`)
        .attr('stroke', '#334155').attr('stroke-width', 2).attr('fill', 'none').attr('stroke-dasharray', '6,3')
    })

    // Client node
    const clientG = svg.append('g').attr('transform', `translate(${px(NODES.client)},${py(NODES.client)})`)
    clientG.append('circle').attr('r', 30).attr('fill', '#1e40af').attr('stroke', '#3b82f6').attr('stroke-width', 2)
    clientG.append('circle').attr('r', 38).attr('fill', 'none').attr('stroke', '#3b82f6').attr('stroke-width', 1).attr('opacity', 0.4)
    clientG.append('text').attr('text-anchor', 'middle').attr('dy', '0.35em').attr('fill', 'white').attr('font-size', 11).attr('font-weight', 'bold').text('CLIENT')

    // Pulsing ring on client
    function pulseClient() {
      clientG.append('circle').attr('r', 30).attr('fill', 'none').attr('stroke', '#60a5fa').attr('stroke-width', 2)
        .transition().duration(1500).attr('r', 55).attr('opacity', 0).remove()
    }
    setInterval(pulseClient, 1800)

    // LB node
    const lbG = svg.append('g').attr('transform', `translate(${px(NODES.lb)},${py(NODES.lb)})`)
    lbG.append('rect').attr('x', -50).attr('y', -28).attr('width', 100).attr('height', 56)
      .attr('rx', 8).attr('fill', '#1e3a5f').attr('stroke', '#2e86ab').attr('stroke-width', 2.5)
    lbG.append('text').attr('text-anchor', 'middle').attr('dy', '-4').attr('fill', 'white').attr('font-size', 11).attr('font-weight', 'bold').text('LOAD')
    lbG.append('text').attr('text-anchor', 'middle').attr('dy', '10').attr('fill', 'white').attr('font-size', 11).attr('font-weight', 'bold').text('BALANCER')
    lbG.append('text').attr('id', 'lb-algo-label').attr('text-anchor', 'middle').attr('dy', '24').attr('fill', '#64b5f6').attr('font-size', 9).text(algorithm.toUpperCase())

    // Server nodes (will be updated)
    ;['s0','s1','s2'].forEach(k => {
      const s = NODES[k]
      const g = svg.append('g').attr('id', `server-node-${s.id}`).attr('transform', `translate(${px(s)},${py(s)})`)
      g.append('circle').attr('class', 'server-ring').attr('r', 44).attr('fill', 'none').attr('stroke', '#22c55e').attr('stroke-width', 1).attr('opacity', 0.3)
      g.append('circle').attr('class', 'server-bg').attr('r', 36).attr('fill', '#166534').attr('stroke', '#22c55e').attr('stroke-width', 2)
      g.append('rect').attr('class', 'server-load-bar').attr('x', -6).attr('width', 12).attr('rx', 3)
        .attr('y', 36).attr('height', 0).attr('fill', '#22c55e').attr('opacity', 0.8)
      g.append('text').attr('class', 'server-label').attr('text-anchor', 'middle').attr('dy', '-6').attr('fill', 'white').attr('font-size', 10).attr('font-weight', 'bold').text(`SRV ${s.id + 1}`)
      g.append('text').attr('class', 'server-cpu').attr('text-anchor', 'middle').attr('dy', '8').attr('fill', '#bbf7d0').attr('font-size', 9).text('CPU: 0%')
      g.append('text').attr('class', 'server-conns').attr('text-anchor', 'middle').attr('dy', '20').attr('fill', '#86efac').attr('font-size', 8).text('0 conns')
    })

    // Particle layer (on top)
    svg.append('g').attr('id', 'particle-layer')

    storeRef.current = svg
  }, []) // only on mount

  useEffect(() => {
    const svg = storeRef.current
    if (!svg) return
    svg.select('#lb-algo-label').text(algorithm.toUpperCase())
  }, [algorithm])

  // Update server colors & labels
  useEffect(() => {
    const svg = storeRef.current
    if (!svg) return
    servers.forEach(s => {
      const cpu = (s.cpu || 0) / 100
      const color = cpuColor(cpu)
      const g = svg.select(`#server-node-${s.id}`)
      if (g.empty()) return
      g.select('.server-bg').transition().duration(500).attr('fill', color).attr('stroke', color)
      g.select('.server-ring').transition().duration(500).attr('stroke', color)
      g.select('.server-cpu').text(`CPU: ${((s.cpu || 0)).toFixed(0)}%`)
      g.select('.server-conns').text(`${s.conns || 0} conns`)
      // Load bar (below circle)
      const barH = Math.min(40, (s.conns || 0) * 2)
      g.select('.server-load-bar')
        .transition().duration(400)
        .attr('y', -barH)
        .attr('height', barH)
        .attr('fill', color)
    })
  }, [servers])

  // Animate new particles
  useEffect(() => {
    const svg = storeRef.current
    if (!svg) return

    const W = +svg.attr('width')
    const H = +svg.attr('height')
    const px = k => k.x * W
    const py = k => k.y * H

    particles.forEach(p => {
      if (particlesSeenRef.current.has(p.id)) return
      particlesSeenRef.current.add(p.id)

      const layer = svg.select('#particle-layer')
      const serverKey = `s${p.serverId}`
      const target = NODES[serverKey] || NODES.s0
      const lb = NODES.lb

      // Phase 1: client → LB
      const phase1Path = `M${px(NODES.client)},${py(NODES.client)} C${px(NODES.client)+80},${py(NODES.client)} ${px(lb)-80},${py(lb)} ${px(lb)},${py(lb)}`
      const pathEl1 = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      pathEl1.setAttribute('d', phase1Path)
      const len1 = pathEl1.getTotalLength()

      const particle = layer.append('circle').attr('r', 5).attr('fill', '#00d4ff')
        .attr('cx', px(NODES.client)).attr('cy', py(NODES.client))
        .attr('filter', 'url(#glow)')

      particle.transition().duration(220).ease(d3.easeCubicIn)
        .attrTween('cx', () => t => pathEl1.getPointAtLength(t * len1).x)
        .attrTween('cy', () => t => pathEl1.getPointAtLength(t * len1).y)
        .on('end', () => {
          // Flash LB node
          svg.select('rect').filter((d, i, nodes) => d3.select(nodes[i]).attr('stroke') === '#2e86ab')
          const lbRect = svg.select(`rect[stroke="#2e86ab"]`)
          lbRect.transition().duration(100).attr('stroke', '#f59e0b').attr('stroke-width', 3)
            .transition().duration(200).attr('stroke', '#2e86ab').attr('stroke-width', 2.5)

          // Highlight route edge
          svg.select(`.edge-to-${p.serverId}`)
            .transition().duration(80).attr('stroke', '#00d4ff').attr('stroke-width', 3)
            .transition().duration(400).attr('stroke', '#334155').attr('stroke-width', 2)

          // Phase 2: LB → server
          const phase2Path = `M${px(lb)},${py(lb)} C${px(lb)+80},${py(lb)} ${px(target)-80},${py(target)} ${px(target)},${py(target)}`
          const pathEl2 = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          pathEl2.setAttribute('d', phase2Path)
          const len2 = pathEl2.getTotalLength()

          particle.attr('fill', '#a78bfa')
            .transition().duration(300).ease(d3.easeCubicOut)
            .attrTween('cx', () => t => pathEl2.getPointAtLength(t * len2).x)
            .attrTween('cy', () => t => pathEl2.getPointAtLength(t * len2).y)
            .on('end', () => {
              // Pulse server node
              const g = svg.select(`#server-node-${p.serverId}`)
              g.append('circle').attr('r', 36).attr('fill', 'none').attr('stroke', '#a78bfa').attr('stroke-width', 3)
                .transition().duration(400).attr('r', 56).attr('opacity', 0).remove()

              // Fade particle
              particle.transition().duration(150).attr('r', 0).attr('opacity', 0).remove()
              removeParticle(p.id)
            })
        })
    })
  }, [particles, removeParticle])

  return (
    <svg ref={svgRef} style={{ width: '100%', display: 'block', borderRadius: 12 }} />
  )
}
