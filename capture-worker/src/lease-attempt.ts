/** One attempt budget includes external I/O; heartbeats cannot keep a stalled attempt alive. */
export class LeaseAttempt {
  private readonly controller = new AbortController()
  private readonly deadline: ReturnType<typeof setTimeout>
  private readonly heartbeat: ReturnType<typeof setInterval>
  private renewing = false

  constructor(timeoutMillis: number, renew: () => Promise<boolean>, heartbeatMillis: number) {
    this.deadline = setTimeout(() => this.abort('WORKER_ATTEMPT_TIMEOUT'), timeoutMillis)
    this.heartbeat = setInterval(() => {
      if (this.renewing || this.signal.aborted) return
      this.renewing = true
      void renew().then((valid) => {
        if (!valid) this.abort('STALE_WORKER_LEASE')
      }, () => this.abort('WORKER_HEARTBEAT_FAILED')).finally(() => { this.renewing = false })
    }, heartbeatMillis)
    this.signal.addEventListener('abort', () => this.close(), { once: true })
  }

  get signal(): AbortSignal { return this.controller.signal }

  check(): void { this.signal.throwIfAborted() }

  abort(code: string): void { this.controller.abort(new Error(code)) }

  close(): void {
    clearTimeout(this.deadline)
    clearInterval(this.heartbeat)
  }
}
