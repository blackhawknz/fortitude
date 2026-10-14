import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createInitialState, simFingerprint } from '../src/sim/state.js'
import { replay } from '../src/sim/replay.js'
import { Engine } from '../src/engine/engine.js'
import { AgentRuntime, type TurnRecord } from '../src/agents/runtime.js'
import { MockBackend } from '../src/agents/backend.js'
import { AlitaBackend, AlitaClient, AlitaMemorySync, castBackends } from '../src/agents/alita.js'
import { memoryStore } from './helpers.js'
import { buildContextPacket } from '../src/agents/packet.js'

/** A stand-in for the Alita service: /agent/turn, /agent/reflect, scoped memory with idempotent refs. */
function fakeAlita() {
  const memories: { scope: string; content: string; external_ref: string }[] = []
  const calls: { path: string; body: any }[] = []
  let server: Server | null = null
  let port = 0
  const handler = (req: any, res: any) => {
    let data = ''
    req.on('data', (c: Buffer) => (data += c))
    req.on('end', () => {
      const body = data ? JSON.parse(data) : null
      const url = new URL(req.url, 'http://x')
      calls.push({ path: url.pathname, body })
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      if (url.pathname === '/agent/turn')
        return send(200, { content: JSON.stringify({ intents: [{ kind: 'move', to: 'spine', reason: 'See the crack.', weight: 0.8, hours: 3 }], memory_writes: [{ text: 'The Spine again.', importance: 4 }], mood: 'calm' }), usage: { prompt_tokens: 10, completion_tokens: 5 } })
      if (url.pathname === '/agent/reflect') return send(200, { content: JSON.stringify({ journal: 'Via the real me.', memory_consolidation: { summarise: 'A day on the ring.' } }) })
      if (url.pathname === '/agent/memory' && req.method === 'POST') {
        const dup = memories.find((m) => m.external_ref === body.external_ref)
        if (dup) return send(200, { status: 'duplicate', id: memories.indexOf(dup) })
        memories.push(body)
        return send(200, { status: 'added', id: memories.length - 1 })
      }
      if (url.pathname === '/agent/memory/retract') {
        const before = memories.length
        for (let i = memories.length - 1; i >= 0; i--) if (memories[i]!.scope === body.scope) memories.splice(i, 1)
        return send(200, { retracted: before - memories.length })
      }
      send(404, { detail: 'not found' })
    })
  }
  return {
    memories,
    calls,
    get url() {
      return `http://127.0.0.1:${port}`
    },
    async start() {
      server = createServer(handler)
      await new Promise<void>((r) => server!.listen(port, '127.0.0.1', () => r()))
      port = (server!.address() as AddressInfo).port
    },
    async stop() {
      server?.closeAllConnections()
      await new Promise<void>((r) => server!.close(() => r()))
      server = null
    },
  }
}

let alita: ReturnType<typeof fakeAlita> | null = null
afterEach(async () => {
  try {
    await alita?.stop()
  } catch {
    /* already stopped */
  }
  alita = null
})

function world(clock: { t: number }, url: string) {
  const store = memoryStore()
  store.create(createInitialState({ id: 'aw', seed: 'alita-phase3' }))
  const engine = new Engine({ store, worldId: 'aw', tickMs: 1000 })
  const local = new MockBackend(() => ({ intents: [{ kind: 'rest', reason: 'local fallback', weight: 0.4, hours: 2 }], memory_writes: [{ text: 'Thought locally.', importance: 3 }] }))
  const client = new AlitaClient({ url, timeoutMs: 500, cooldownMs: 10_000, now: () => clock.t })
  const queen = new AlitaBackend(client, 'aw', local)
  const sync = new AlitaMemorySync(store, 'aw', client, { minIntervalMs: 0, now: () => clock.t })
  const turns: TurnRecord[] = []
  const runtime = new AgentRuntime({ store, worldId: 'aw', getState: () => engine.state, agents: castBackends(local, queen, ['alita', 'sera']), onTurn: (t) => turns.push(t), driftRoll: () => 1, turnTimeoutMs: 2000 })
  engine.listeners.push(runtime, sync)
  return { store, engine, runtime, sync, client, queen, turns, local }
}

async function lockstep(w: ReturnType<typeof world>, ticks: number, clock: { t: number }) {
  for (let i = 0; i < ticks; i++) {
    clock.t += 1000
    w.engine.step()
    await w.runtime.idle()
    await w.sync.idle()
  }
}

describe('Phase 3: the Alita adapter', () => {
  it('serves the Queen through Alita, mirrors her memories, and survives Alita dying mid-run', async () => {
    alita = fakeAlita()
    await alita.start()
    const clock = { t: 1_000_000 }
    const w = world(clock, alita.url)

    // 1. Alita up: the Queen's turns go to Alita with Fortitude's own contract; Sera stays local.
    await lockstep(w, 30, clock)
    const viaAlita = w.turns.filter((t) => t.agentId === 'alita' && t.servedBy === 'alita' && t.status === 'ok')
    expect(viaAlita.length).toBeGreaterThan(0)
    expect(w.turns.filter((t) => t.agentId === 'sera').every((t) => t.servedBy !== 'alita')).toBe(true)
    const turnCall = alita.calls.find((c) => c.path === '/agent/turn')!
    expect(turnCall.body.scope).toBe('fortitude:aw')
    expect(turnCall.body.system).toContain('Reply with ONLY a JSON object')
    expect(alita.memories.length).toBeGreaterThan(0)
    expect(alita.memories.every((m) => m.scope === 'fortitude:aw' && m.external_ref.startsWith('fortitude:aw:'))).toBe(true)

    // 2. Kill Alita. The world keeps turning; the Queen degrades to the local model.
    await alita.stop()
    const tickBefore = w.engine.state.tick
    await lockstep(w, 40, clock)
    expect(w.engine.state.tick).toBe(tickBefore + 40)
    const degraded = w.turns.filter((t) => t.agentId === 'alita' && t.tickAsked > tickBefore && t.status === 'ok')
    expect(degraded.length).toBeGreaterThan(0)
    expect(degraded.every((t) => t.servedBy === 'alita→mock')).toBe(true)
    expect(w.turns.filter((t) => t.tickAsked > tickBefore).every((t) => t.status === 'ok' || t.status === 'skipped')).toBe(true)
    expect(w.client.health.up).toBe(false)
    const backlog = w.store.unsyncedMemories('aw', 'alita', 3, 1000)
    expect(backlog.length).toBeGreaterThan(0) // her memories kept locally, not lost

    // 3. Alita returns (same port). After the cooldown, the outbox reconciles with no duplicates.
    const lost = alita.memories.length
    await alita.start()
    clock.t += 20_000
    await lockstep(w, 2, clock)
    await w.sync.drain()
    expect(w.store.unsyncedMemories('aw', 'alita', 3, 1000)).toHaveLength(0)
    expect(alita.memories.length).toBeGreaterThan(lost)
    const refs = alita.memories.map((m) => m.external_ref)
    expect(new Set(refs).size).toBe(refs.length)
    expect(w.client.health.up).toBe(true)

    // 4. Replay is unaffected by which backend answered: the intent log is the truth.
    const live = w.engine.state
    const rebuilt = replay({ id: 'aw', seed: 'alita-phase3', settings: live.settings, toTick: live.tick, submissions: w.store.submissionsByTick('aw') })
    expect(simFingerprint(rebuilt)).toBe(simFingerprint(live))
  }, 60_000)

  it('the circuit breaker skips Alita during cooldown instead of paying the timeout every turn', async () => {
    const clock = { t: 0 }
    const client = new AlitaClient({ url: 'http://127.0.0.1:9', timeoutMs: 300, cooldownMs: 5_000, now: () => clock.t })
    const local = new MockBackend(() => ({ intents: [] }))
    const queen = new AlitaBackend(client, 'w', local)
    const store = memoryStore()
    const s = store.create(createInitialState({ id: 'w', seed: 'cb' }))
    const packet = buildContextPacket(store, s, 'alita', { kind: 'routine_check', detail: 'x', urgency: 0.3, tick: 0 })
    const r1 = await queen.turn(packet)
    expect(r1.backend).toBe('alita→mock')
    expect(client.coolingDown).toBe(true)
    const t0 = Date.now()
    const r2 = await queen.turn(packet)
    expect(Date.now() - t0).toBeLessThan(100) // no network attempt while cooling down
    expect(r2.backend).toBe('alita→mock')
    expect(queen.fallbacks).toBe(2)
  })

  it('retract clears a world from Alita and resets the outbox', async () => {
    alita = fakeAlita()
    await alita.start()
    const clock = { t: 0 }
    const w = world(clock, alita.url)
    w.store.addAgentMemory('aw', 'alita', 5, 'The crack is wider.', 5, true)
    await w.sync.drain()
    expect(alita.memories).toHaveLength(1)
    const r = await w.client.retract('fortitude:aw')
    w.store.clearSync('aw')
    expect(r.retracted).toBe(1)
    expect(alita.memories).toHaveLength(0)
    expect(w.store.syncedCount('aw')).toBe(0)
  })
})
