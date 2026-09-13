import { useEffect, useEffectEvent, useState } from 'react'

interface AsyncState<T> {
  data: T | null
  error: Error | null
  loading: boolean
  refreshing: boolean
}

interface KeyedAsyncState<T> extends AsyncState<T> {
  key: string
}

interface AsyncDataOptions<T> {
  pollIntervalMs?: number
  shouldPoll?: (data: T) => boolean
  shouldPollOnError?: () => boolean
}

export function useAsyncData<T>(
  loader: () => Promise<T>,
  dependencyKey: string,
  options: AsyncDataOptions<T> = {},
): AsyncState<T> {
  const [state, setState] = useState<KeyedAsyncState<T>>({ key: dependencyKey, data: null, error: null, loading: true, refreshing: false })
  const load = useEffectEvent(loader)
  const shouldPoll = useEffectEvent((data: T) => options.shouldPoll?.(data) ?? false)
  const shouldPollOnError = useEffectEvent(() => options.shouldPollOnError?.() ?? true)
  const pollIntervalMs = options.pollIntervalMs

  useEffect(() => {
    let active = true
    let timer: number | undefined
    let latestData: T | null = null

    async function run() {
      if (!active) return
      if (latestData !== null) {
        setState((current) => ({ ...current, refreshing: current.key === dependencyKey && current.data !== null }))
      }
      try {
        const data = await load()
        if (!active) return
        latestData = data
        setState({ key: dependencyKey, data, error: null, loading: false, refreshing: false })
      } catch (error: unknown) {
        if (!active) return
        const normalized = error instanceof Error ? error : new Error('Đã có lỗi xảy ra.')
        setState((current) => current.key === dependencyKey
          ? { ...current, error: normalized, loading: false, refreshing: false }
          : { key: dependencyKey, data: null, error: normalized, loading: false, refreshing: false })
      }

      const keepPolling = latestData === null ? shouldPollOnError() : shouldPoll(latestData)
      if (active && pollIntervalMs && keepPolling) {
        timer = window.setTimeout(run, pollIntervalMs)
      }
    }

    void run()
    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [dependencyKey, pollIntervalMs])

  if (state.key !== dependencyKey) {
    return { data: null, error: null, loading: true, refreshing: false }
  }
  return state
}
