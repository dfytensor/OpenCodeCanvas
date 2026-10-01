// Managed singleton for `opencode serve` — headless HTTP server lifecycle.
// Owns spawn / health probing / crash recovery via <projectDir>/.occ/server.json.
import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'

const run = promisify(execFile)

export interface ServerHandle {
  port: number
  baseUrl: string
  username: string
  password: string
  managed: boolean
  pid?: number
}

interface PersistedServer {
  port: number
  pid?: number
  username: string
  password: string
  managed?: boolean
}

interface CacheEntry {
  handle: ServerHandle
  owned: boolean // spawned by this process (only these get killed by stopServer)
}

let cached: CacheEntry | null = null
let pending: Promise<ServerHandle> | null = null

export function basicAuthHeader(h: ServerHandle): string {
  return 'Basic ' + Buffer.from(`${h.username}:${h.password}`).toString('base64')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function probeHealth(h: ServerHandle, timeoutMs = 3000): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${h.baseUrl}/global/health`, {
      headers: { Authorization: basicAuthHeader(h) },
      signal: ctrl.signal
    })
    if (!res.ok) return false
    const data = (await res.json()) as { healthy?: boolean }
    return data.healthy === true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function pidAlive(pid?: number): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function serverFile(projectDir: string): string {
  return join(projectDir, '.occ', 'server.json')
}

function readPersisted(projectDir: string): PersistedServer | null {
  try {
    const file = serverFile(projectDir)
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PersistedServer>
    if (typeof raw.port !== 'number') return null
    if (typeof raw.username !== 'string' || typeof raw.password !== 'string') return null
    return {
      port: raw.port,
      pid: typeof raw.pid === 'number' ? raw.pid : undefined,
      username: raw.username,
      password: raw.password,
      managed: raw.managed === true
    }
  } catch {
    return null
  }
}

function persist(projectDir: string | undefined, h: ServerHandle): void {
  if (!projectDir || !existsSync(projectDir)) return
  try {
    const dir = join(projectDir, '.occ')
    mkdirSync(dir, { recursive: true })
    const rec: PersistedServer = {
      port: h.port,
      pid: h.pid,
      username: h.username,
      password: h.password,
      managed: h.managed
    }
    writeFileSync(serverFile(projectDir), JSON.stringify(rec, null, 2), 'utf8')
  } catch {
    // persistence is best-effort, never fatal
  }
}

/**
 * Read the WinINET per-user proxy (System Preferences → Proxy). bun ignores
 * Windows proxy settings, so without this the spawned serve connects directly
 * and may exit through a global-TUN route that provider gateways geo-block
 * (observed: bigmodel coding endpoint → 403 RegionError from a CN machine).
 * Returns proxy URLs suitable for HTTP_PROXY / HTTPS_PROXY.
 */
function wininetProxyUrl(): string | undefined {
  if (process.platform !== 'win32') return undefined
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    const out = require('child_process').execFileSync(
      'reg',
      ['query', key, '/v', 'ProxyEnable'],
      { encoding: 'utf8', windowsHide: true }
    ) as string
    if (!/0x1/.test(out)) return undefined
    const raw = require('child_process').execFileSync(
      'reg',
      ['query', key, '/v', 'ProxyServer'],
      { encoding: 'utf8', windowsHide: true }
    ) as string
    const m = /ProxyServer\s+REG_SZ\s+(.+)/.exec(raw)
    if (!m) return undefined
    const value = m[1].trim()
    if (value.includes('=')) {
      // per-scheme form: "http=...;https=127.0.0.1:31181"
      const https = /(?:^|;)https?=([^;]+)/i.exec(value)
      if (https) return `http://${https[1]}`
      return undefined
    }
    return `http://${value}`
  } catch {
    return undefined
  }
}

/** Env for the serve child: inherit + auth + proxy discovered from WinINET. */
function childEnv(username: string, password: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password
  }
  if (!env.HTTPS_PROXY && !env.https_proxy) {
    const proxy = wininetProxyUrl()
    if (proxy) {
      env.HTTPS_PROXY = proxy
      env.HTTP_PROXY = env.HTTP_PROXY ?? proxy
      env.NO_PROXY = env.NO_PROXY ?? '127.0.0.1,localhost,::1'
    }
  }
  return env
}

async function startServer(projectDir?: string): Promise<ServerHandle> {
  const isWin = process.platform === 'win32'
  const port = 41000 + Math.floor(Math.random() * 1000)
  // Never override a user-level password configured via env — reuse it.
  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode'
  const password = process.env.OPENCODE_SERVER_PASSWORD || randomUUID()

  const file = isWin ? (process.env.COMSPEC ?? 'cmd.exe') : 'opencode'
  const args = isWin
    ? ['/c', 'opencode', 'serve', '--port', String(port)]
    : ['serve', '--port', String(port)]
  const child = spawn(file, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv(username, password) as NodeJS.ProcessEnv
  })
  child.unref()
  // keep pipes from holding the event loop open (unref exists at runtime)
  for (const stream of [child.stdout, child.stderr]) {
    ;(stream as unknown as { unref?: () => void } | null)?.unref?.()
  }

  const handle: ServerHandle = {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    username,
    password,
    managed: true,
    pid: child.pid
  }

  // Confirm readiness: stdout marker ("listening on http://...") or health polling.
  let sawLine = false
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    if (chunk.includes('listening on http://')) sawLine = true
  })

  const started = Date.now()
  const deadline = started + 15000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`opencode serve exited early with code ${child.exitCode}`)
    }
    // give stdout a brief window even after the marker, then trust health
    if (sawLine || Date.now() - started > 3000) {
      if (await probeHealth(handle)) {
        persist(projectDir, handle)
        return handle
      }
    }
    await sleep(300)
  }
  killTree(handle.pid)
  throw new Error('opencode serve did not become healthy within 15s')
}

function killTree(pid?: number): void {
  if (!pid) return
  // pid is cmd.exe's; /T takes down the whole process tree (opencode included)
  run('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {})
}

export async function ensureServer(projectDir?: string): Promise<ServerHandle> {
  if (cached) {
    if (await probeHealth(cached.handle)) return cached.handle
    cached = null
  }
  if (pending) return pending

  pending = (async () => {
    // zero-config adoption: attach to a server the user runs themselves
    // (OPENCODE_SERVER_URL=http://127.0.0.1:PORT) — useful when the bundled
    // binary has provider issues and the user prefers their own build
    const external = process.env.OPENCODE_SERVER_URL
    if (external) {
      const url = external.replace(/\/$/, '')
      const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode'
      const password = process.env.OPENCODE_SERVER_PASSWORD || ''
      const candidate: ServerHandle = {
        port: Number(new URL(url).port) || 80,
        baseUrl: url,
        username,
        password,
        managed: false
      }
      if (await probeHealth(candidate)) {
        cached = { handle: candidate, owned: false }
        return candidate
      }
    }
    // recovery path: adopt a server left behind by a previous app run
    if (projectDir) {
      const rec = readPersisted(projectDir)
      if (rec) {
        const candidate: ServerHandle = {
          port: rec.port,
          baseUrl: `http://127.0.0.1:${rec.port}`,
          username: rec.username,
          password: rec.password,
          managed: rec.managed === true,
          pid: rec.pid
        }
        if (pidAlive(rec.pid) || (await probeHealth(candidate))) {
          if (await probeHealth(candidate)) {
            cached = { handle: candidate, owned: false }
            return candidate
          }
        }
      }
    }
    const handle = await startServer(projectDir)
    cached = { handle, owned: true }
    return handle
  })()

  try {
    return await pending
  } finally {
    pending = null
  }
}

export async function getServer(): Promise<ServerHandle | null> {
  if (!cached) return null
  if (await probeHealth(cached.handle)) return cached.handle
  cached = null
  return null
}

export async function stopServer(): Promise<void> {
  const entry = cached
  cached = null
  if (entry?.owned) killTree(entry.handle.pid)
}
