import { act, render, screen } from '@testing-library/react'
import { useAsyncData } from './useAsyncData'
import { afterEach, describe, expect, it, vi } from 'vitest'

function PollingHarness({ loader }: { loader: () => Promise<number> }) {
  const state = useAsyncData(loader, 'polling-test', {
    pollIntervalMs: 100,
    shouldPoll: (value) => value < 2,
  })
  return (
    <div>
      <span data-testid="value">{state.data ?? 'empty'}</span>
      <span data-testid="error">{state.error?.message ?? 'none'}</span>
    </div>
  )
}

describe('useAsyncData polling', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps stale data after a transient error and stops at the terminal value', async () => {
    vi.useFakeTimers()
    const loader = vi.fn()
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('Mất kết nối tạm thời'))
      .mockResolvedValueOnce(2)

    render(<PollingHarness loader={loader} />)
    await act(async () => undefined)
    expect(screen.getByTestId('value')).toHaveTextContent('1')

    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(screen.getByTestId('value')).toHaveTextContent('1')
    expect(screen.getByTestId('error')).toHaveTextContent('Mất kết nối tạm thời')

    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(screen.getByTestId('value')).toHaveTextContent('2')
    expect(screen.getByTestId('error')).toHaveTextContent('none')

    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(loader).toHaveBeenCalledTimes(3)
  })

  it('cleans up a pending poll after unmount', async () => {
    vi.useFakeTimers()
    const loader = vi.fn().mockResolvedValue(1)
    const view = render(<PollingHarness loader={loader} />)
    await act(async () => undefined)

    view.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })

    expect(loader).toHaveBeenCalledTimes(1)
  })
})
