import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Engine, TickListener } from '../engine/engine.js'
import type { TickResult } from '../sim/tick.js'
import type { WorldStore } from '../db/store.js'
import { PLAYER_ID } from '../world/cast.js'
import type { PlayerService, PlayerAction } from '../player/service.js'
import { buildDebrief, narrateDebrief, type TextModel } from '../player/presence.js'

/**
 * The player's HTTP door. Loopback only (the serve CLI binds 127.0.0.1).
 *
 *   GET  /                       the web UI
 *   GET  /api/state              what your character can see right now
 *   GET  /api/journal            what your character knows happened (?since=tick&limit=)
 *   GET  /api/debrief            while you were away (?prose=1 for a narrated note)
 *   GET  /api/notifications      teasers sent while you were away; POST …/read to clear
 *   GET  /api/transcript/:id     your conversation with someone
 *   POST /api/act                { kind, to?, target?, fact?, hours? }  — adjudicated next tick
 *   POST /api/say                { to, text, reveals?, register? }      — answered now
 *   GET  /api/stream             SSE: { view, entries } after every tick
 *
 * Presence: while a stream is open the player counts as present; the last
 * tick they saw is recorded when they leave. The UI fetches the debrief
 * BEFORE opening the stream, so the window covers the whole absence.
 *
 * State-changing requests must be same-origin. Set FORTITUDE_TOKEN to also
 * require a bearer token.
 */

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../public')

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Block drive-by writes from other websites without tripping over how the
 * UI was reached. Allowed when any of these hold:
 *  - no Origin header (curl, scripts: not a browser drive-by)
 *  - the browser itself says the request is same-origin (Sec-Fetch-Site),
 *    which stays true behind IDE previews and port-forwarding proxies
 *  - the Origin's host matches the Host header
 *  - the Origin is a loopback address (localhost vs 127.0.0.1 is not an attack)
 *  - the Origin is explicitly allowed (FORTITUDE_ALLOWED_ORIGINS)
 */
export function writeAllowed(origin: string | undefined, host: string | undefined, secFetchSite: string | undefined, allowed: readonly string[] = []): boolean {
  if (!origin) return true
  if (secFetchSite === 'same-origin' || secFetchSite === 'none') return true
  if (allowed.includes(origin)) return true
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false // e.g. "null" from a sandboxed frame or file://
  }
  if (host && url.host === host) return true
  return LOOPBACK.has(url.hostname)
}

export interface AppOptions {
  /** Extra origins allowed to write (e.g. a proxy URL). */
  allowedOrigins?: string[]
  player: PlayerService
  engine: Engine
  store: WorldStore
  worldId: string
  token?: string
  model?: TextModel | null
}

export function createApp(opts: AppOptions) {
  const { player, engine, store, worldId } = opts
  const app = new Hono()
  const subscribers = new Set<(data: string) => void>()
  const proseCache = new Map<string, string>()

  const listener: TickListener = {
    onTick(r: TickResult) {
      if (!subscribers.size) return
      store.markSeen(worldId, r.state.tick)
      const entries = player.journal({ sinceTick: r.state.tick, limit: 40 })
      const payload = JSON.stringify({ view: player.view(), entries, unread: store.notificationsFor(worldId, { unreadOnly: true }).length })
      for (const send of subscribers) send(payload)
    },
  }
  engine.listeners.push(listener)

  app.use('/api/*', async (c, next) => {
    if (opts.token && c.req.header('authorization') !== `Bearer ${opts.token}` && c.req.query('token') !== opts.token) return c.json({ error: 'unauthorized' }, 401)
    if (c.req.method !== 'GET' && !writeAllowed(c.req.header('origin'), c.req.header('host'), c.req.header('sec-fetch-site'), opts.allowedOrigins)) {
      console.warn(`[http] refused ${c.req.method} ${c.req.path}: origin=${c.req.header('origin')} host=${c.req.header('host')} sec-fetch-site=${c.req.header('sec-fetch-site')}`)
      return c.json({ error: 'cross-origin request refused (set FORTITUDE_ALLOWED_ORIGINS if you reach the UI through a proxy)' }, 403)
    }
    await next()
  })

  app.get('/', (c) => c.html(readFileSync(resolve(PUBLIC_DIR, 'index.html'), 'utf8')))

  app.get('/api/state', (c) => c.json(player.view()))

  app.get('/api/journal', (c) => {
    const since = c.req.query('since')
    const limit = Number(c.req.query('limit') ?? 60)
    return c.json({ entries: player.journal({ sinceTick: since !== undefined ? Number(since) : undefined, limit: Math.min(200, Math.max(1, limit)) }) })
  })

  app.get('/api/debrief', async (c) => {
    const d = buildDebrief(store, worldId, engine.state.tick)
    if (c.req.query('prose') && opts.model && d.headline.length) {
      const key = `${d.since.tick}:${d.now.tick}`
      if (!proseCache.has(key)) {
        try {
          proseCache.set(key, await narrateDebrief(opts.model, d))
        } catch {
          /* the list is enough */
        }
      }
      d.prose = proseCache.get(key)
    }
    return c.json(d)
  })

  app.get('/api/notifications', (c) => c.json({ notifications: store.notificationsFor(worldId, { limit: 20 }), unread: store.notificationsFor(worldId, { unreadOnly: true }).length }))
  app.post('/api/notifications/read', (c) => {
    store.markNotificationsRead(worldId)
    return c.json({ ok: true })
  })

  app.get('/api/transcript/:id', (c) => c.json({ with: c.req.param('id'), lines: player.transcript(c.req.param('id')) }))

  app.post('/api/act', async (c) => {
    const body = (await c.req.json().catch(() => null)) as PlayerAction | null
    if (!body?.kind) return c.json({ ok: false, error: 'kind required' }, 400)
    const r = player.act(body)
    return c.json(r, r.ok ? 200 : 400)
  })

  app.post('/api/wait', (c) => {
    const r = player.wait()
    return c.json(r, r.ok ? 200 : 429)
  })

  app.post('/api/say', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { to?: string; text?: string; reveals?: string; register?: 'open' | 'guarded' | 'warm' | 'cold' | 'formal' } | null
    if (!body?.to || !body.text) return c.json({ ok: false, error: 'to and text required' }, 400)
    const r = await player.say(body.to, body.text, { reveals: body.reveals, register: body.register })
    return c.json(r, r.ok ? 200 : 400)
  })

  app.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      const send = (data: string) => void stream.writeSSE({ event: 'tick', data })
      subscribers.add(send)
      store.markSeen(worldId, engine.state.tick)
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ view: player.view(), you: PLAYER_ID }) })
      const keepAlive = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 15_000)
      await new Promise<void>((resolveStream) => stream.onAbort(() => resolveStream()))
      clearInterval(keepAlive)
      subscribers.delete(send)
      store.markSeen(worldId, engine.state.tick)
    }),
  )

  return { app, isPresent: () => subscribers.size > 0, fetch: app.fetch, request: app.request.bind(app) }
}
