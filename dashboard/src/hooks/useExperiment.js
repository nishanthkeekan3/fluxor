import { useCallback } from 'react'
import { useLBStore } from '../store/useLBStore'

const getRunnerUrl = () => {
  if (typeof window !== 'undefined' && window.location?.hostname) {
    return `http://${window.location.hostname}:5006`
  }
  return 'http://localhost:5006'
}

export function useExperiment() {
  const startExperiment = useCallback(async (scenario) => {
    const validScenarios = ['normal', 'spike', 'failure']
    if (!validScenarios.includes(scenario)) {
      throw new Error(`Invalid scenario "${scenario}". Must be one of: ${validScenarios.join(', ')}`)
    }

    const runnerUrl = getRunnerUrl()
    const res = await fetch(`${runnerUrl}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario }),
    })

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      const msg = data?.message || `Failed to start experiment (HTTP ${res.status})`
      throw new Error(msg)
    }

    // Retain previous metrics and continue accumulating requests smoothly
    useLBStore.getState().setExperimentScenario(scenario)
    useLBStore.getState().setExperimentRunning(true)

    return data
  }, [])

  const stopExperiment = useCallback(async () => {
    const prevScenario = useLBStore.getState().experimentScenario
    // Optimistic UI update: instant 0ms visual response without latency
    useLBStore.getState().setExperimentRunning(false)
    useLBStore.getState().setExperimentScenario(null)
    useLBStore.getState().clearParticles()

    const runnerUrl = getRunnerUrl()
    try {
      const res = await fetch(`${runnerUrl}/stop`, {
        method: 'POST',
      })

      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        useLBStore.getState().setExperimentRunning(true)
        useLBStore.getState().setExperimentScenario(prevScenario)
        const msg = data?.message || `Failed to stop experiment (HTTP ${res.status})`
        throw new Error(msg)
      }

      return data
    } catch (err) {
      useLBStore.getState().setExperimentRunning(true)
      useLBStore.getState().setExperimentScenario(prevScenario)
      throw err
    }
  }, [])

  const refreshExperimentStatus = useCallback(async () => {
    const runnerUrl = getRunnerUrl()
    const res = await fetch(`${runnerUrl}/status`)

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      const msg = data?.message || `Failed to fetch experiment status (HTTP ${res.status})`
      throw new Error(msg)
    }

    useLBStore.getState().setExperimentRunning(Boolean(data.running))
    useLBStore.getState().setExperimentScenario(data.scenario || null)

    return data
  }, [])

  return {
    startExperiment,
    stopExperiment,
    refreshExperimentStatus,
  }
}
