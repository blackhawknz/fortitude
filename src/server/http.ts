import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Engine, TickListener } from '../engine/engine.js'
import type { TickResult } from '../sim/tick.js'
import { PLAYER_ID } from '../world/cast.js'
import type { PlayerService, PlayerAction } from '../player/service.js'

/**
 * The player's HTTP door. Loopback only (the serve CLI binds 127.0.0.1).
 *
 *   GET  /                 the web UI
 *   GET  /api/state        what your character can see right now
 *   GET  /api/journal      what your character knows happened (?since=tick&limit=)
 *   GET  /api/transcript/:id   your conversation with someone
 *   POST /api/act          { kind, to?, target?, fact?, hours? }  — adjudicated next tick
 *   POST /api/say          { to, text, reveals?, register? }      — answered now
 *   GET  /api/stream       SSE: { view, entries } after every tick
 *
 * State-changing requests must be same-origin (blocks drive-by requests to
 * localhost from other web pages). Set FORTITUDE_TOKEN to also require a bearer token.
 */

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../public')

export function createApp(opts: { player: PlayerService; engine: Engine; token?: string }) {
  const { player, engine } = opts
  const app = new Hono()
  const subscribers = new Set<(data: string) => void>()

  const listener: TickListener = {
    onTick(r: TickResult) {
      if (!subscribers.size) return
      const entries = player.journal({ sinceTick: r.state.tick, limit: 40 })
      const payload = JSON.stringify({ view: player.view(), entries })
      for (const send of subscribers) send(payload)
    },
  }
  engine.listeners.push(listener)

  app.use('/api/*', async (c, next) => {
    if (opts.token && c.req.header('authorization') !== `Bearer ${opts.token}` && c.req.query('token') !== opts.token) return c.json({ error: 'unauthorized' }, 401)
    if (c.req.method !== 'GET') {
      const origin = c.req.header('origin')
      const host = c.req.header('host')
      if (origin && host && new URL(origin).host !== host) return c.json({ error: 'cross-origin request refused' }, 403)
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

  app.get('/api/transcript/:id', (c) => c.json({ with: c.req.param('id'), lines: player.transcript(c.req.param('id')) }))

  app.post('/api/act', async (c) => {
    const body = (await c.req.json().catch(() => null)) as PlayerAction | null
    if (!body?.kind) return c.json({ ok: false, error: 'kind required' }, 400)
    const r = player.act(body)
    return c.json(r, r.ok ? 200 : 400)
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
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ view: player.view(), you: PLAYER_ID }) })
      const keepAlive = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 15_000)
      await new Promise<void>((resolveStream) => stream.onAbort(() => resolveStream()))
      clearInterval(keepAlive)
      subscribers.delete(send)
    }),
  )

  return app
}
