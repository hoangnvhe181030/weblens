import { useEffect, useEffectEvent, useState } from 'react'

interface AsyncState<T> { data: T | null; error: Error | null; loading: boolean }

export function useAsyncData<T>(loader: () => Promise<T>, dependencyKey: string): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true })
  const load = useEffectEvent(loader)

  useEffect(() => {
    let active = true
    load()
      .then((data) => { if (active) setState({ data, error: null, loading: false }) })
      .catch((error: unknown) => { if (active) setState({ data: null, error: error instanceof Error ? error : new Error('Đã có lỗi xảy ra.'), loading: false }) })
    return () => { active = false }
  }, [dependencyKey])

  return state
}
