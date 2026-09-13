import { createServer, request as httpRequest, type IncomingMessage } from 'node:http'
import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { assertPublicHttpUrl, resolvePublicAddresses } from './security.js'

export class SafeProxy {
  private readonly server = createServer((request, response) => {
    void this.forwardHttp(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(502)
      response.end()
    })
  })

  private port = 0

  constructor() {
    this.server.on('connect', (request, clientSocket, head) => {
      void this.forwardConnect(request.url ?? '', clientSocket, head).catch(() => clientSocket.destroy())
    })
    this.server.on('upgrade', (request, socket, head) => {
      void this.forwardUpgrade(request, socket, head).catch(() => socket.destroy())
    })
  }

  async start(): Promise<void> {
    await new Promise<void>((resolveStart, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        const address = this.server.address()
        if (!address || typeof address === 'string') return reject(new Error('SAFE_PROXY_BIND_FAILED'))
        this.port = address.port
        resolveStart()
      })
    })
  }

  url(): string {
    if (!this.port) throw new Error('SAFE_PROXY_NOT_STARTED')
    return `http://127.0.0.1:${this.port}`
  }

  async close(): Promise<void> {
    await new Promise<void>((resolveClose) => this.server.close(() => resolveClose()))
  }

  private async forwardConnect(authority: string, clientSocket: Duplex, head: Buffer): Promise<void> {
    const target = parseAuthority(authority, 443)
    const addresses = await resolvePublicAddresses(target.hostname)
    const upstream = await openSocket(addresses[0] ?? '', target.port)
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
    const close = () => {
      clientSocket.destroy()
      upstream.destroy()
    }
    clientSocket.once('error', close)
    upstream.once('error', close)
  }

  private async forwardHttp(request: IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    const parsed = await assertPublicHttpUrl(request.url ?? '')
    const addresses = await resolvePublicAddresses(parsed.hostname)
    const upstream = httpRequest({
      hostname: addresses[0],
      port: parsed.port ? Number(parsed.port) : 80,
      method: request.method,
      path: `${parsed.pathname}${parsed.search}`,
      headers: { ...request.headers, host: parsed.host, 'proxy-connection': undefined },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    })
    upstream.once('error', () => {
      if (!response.headersSent) response.writeHead(502)
      response.end()
    })
    request.pipe(upstream)
  }

  private async forwardUpgrade(request: IncomingMessage, clientSocket: Duplex, head: Buffer): Promise<void> {
    const parsed = await assertPublicHttpUrl(request.url ?? '')
    const addresses = await resolvePublicAddresses(parsed.hostname)
    const upstream = await openSocket(addresses[0] ?? '', parsed.port ? Number(parsed.port) : 80)
    const startLine = `${request.method ?? 'GET'} ${parsed.pathname}${parsed.search} HTTP/${request.httpVersion}\r\n`
    const headers = Object.entries(request.headers)
      .filter(([name]) => name.toLowerCase() !== 'proxy-connection')
      .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value ?? ''}\r\n`)
      .join('')
    upstream.write(`${startLine}${headers}\r\n`)
    if (head.length) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  }
}

function parseAuthority(authority: string, defaultPort: number): { hostname: string; port: number } {
  const parsed = new URL(`http://${authority}`)
  const port = parsed.port ? Number(parsed.port) : defaultPort
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('URL_POLICY_REJECTED')
  return { hostname: parsed.hostname, port }
}

function openSocket(host: string, port: number): Promise<Socket> {
  return new Promise((resolveSocket, reject) => {
    const socket = connect({ host, port })
    socket.once('connect', () => resolveSocket(socket))
    socket.once('error', reject)
  })
}
