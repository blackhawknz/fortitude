import { describe, expect, it } from 'vitest'
import type { AgentId } from '../src/core/types.js'
import { tickOf } from '../src/core/clock.js'
import { createInitialState, simFingerprint } from '../src/sim/state.js'
import { replay } from '../src/sim/replay.js'
import { Engine } from '../src/engine/engine.js'
import { AgentRuntime, type TurnRecord } from '../src/agents/runtime.js'
import { MockBackend, type AgentBackend } from '../src/agents/backend.js'
import { buildContextPacket, type ContextPacket } from '../src/agents/packet.js'
import { parseResponse, extractJson } from '../src/agents/response.js'
import { BudgetLedger } from '../src/agents/budget.js'
import { deriveTriggers, routineHour } from '../src/agents/triggers.js'
import { CAST } from '../src/world/cast.js'
import { memoryStore } from './helpers.js'

function world(seed: string, id = 'aw') {
  const store = memoryStore()
  store.create(createInitialState({ id, seed }))
  const engine = new Engine({ store, worldId: id, tickMs: 1000 })
  return { store, engine, id }
}

function withRuntime(seed: string, agents: Partial<Record<AgentId, AgentBackend>>, extra: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {}) {
  const w = world(seed)
  const turns: TurnRecord[] = []
  const runtime = new AgentRuntime({ store: w.store, worldId: w.id, getState: () => w.engine.state, agents, onTurn: (t) => turns.push(t), driftRoll: () => 1, ...extra })
  w.engine.listeners.push(runtime)
  return { ...w, runtime, turns }
}

async function lockstep(engine: Engine, runtime: AgentRuntime, ticks: number) {
  for (let i = 0; i < ticks; i++) {
    engine.step()
    await runtime.idle()
  }
}

// ─── Parsing ─────────────────────────────────────────────────────────────

describe('response parsing', () => {
  it('extracts JSON from fences and chatter', () => {
    expect(extractJson('```json\n{"intents":[]}\n```')).toEqual({ intents: [] })
    expect(extractJson('Sure! {"mood":"calm"} hope that helps')).toEqual({ mood: 'calm' })
    expect(() => extractJson('I walk to the bar.')).toThrow()
  })

  it('drops forbidden fields and bad items but keeps the good ones', () => {
    const r = parseResponse(
      {
        intents: [
          { kind: 'seek', target: 'tomas', reason: 'talk', weight: 0.7, hours: 6 },
          { kind: 'kill', target: 'tomas' },
          { kind: 'move', to: 'spine', weight: '0.4', hours: 500 },
          { kind: 'rest' },
          { kind: 'work' },
        ],
        outcome: 'betray',
        relationships: [{ id: 'tomas', trust: 100 }],
        mood: 'Scheming',
        goal_updates: [{ id: 'g-seal', progress: 0.5 }, { id: 'g-cover', progress: 1 }],
        memory_writes: [{ text: 'note', importance: 9 }],
      },
      100,
      ['g-seal'],
    )
    expect(r.intents.map((i) => i.kind)).toEqual(['seek', 'move', 'rest'])
    expect(r.intents[1]!.expiresTick).toBe(149) // clamped horizon: applied next tick, then 48h
    expect(r.intents[1]!.weight).toBe(0.4) // coerced
    expect(r.mood).toBeNull()
    expect(r.goalUpdates.map((g) => g.id)).toEqual(['g-seal'])
    expect(r.memoryWrites).toHaveLength(0) // importance out of range
    expect(r.violations.join(' ')).toMatch(/outcome.*cannot set/)
    expect(r.violations.join(' ')).toMatch(/relationships.*cannot set/)
    expect(r.violations.join(' ')).toMatch(/not your goal/)
  })

  it('caps dialogue length', () => {
    const r = parseResponse({ dialogue: { say: 'x'.repeat(900), to: 'tomas' } }, 1, [])
    expect(r.dialogue!.say).toHaveLength(400)
  })
})

// ─── Budget + triggers ───────────────────────────────────────────────────

describe('attention budget', () => {
  it('enforces the in-world daily budget', () => {
    const l = new BudgetLedger({ sera: { turnsPerInWorldDay: 2, turnsPerRealHour: 100, priority: 'major' } }, 100, () => 0)
    for (let i = 0; i < 2; i++) {
      expect(l.check('sera', 1, 0.5).ok).toBe(true)
      l.spend('sera', 1)
    }
    expect(l.check('sera', 1, 0.9).ok).toBe(false)
    expect(l.check('sera', 2, 0.9).ok).toBe(true) // new day
  })

  it('enforces the global real-hour cap and sheds low urgency first', () => {
    let t = 0
    const b = { turnsPerInWorldDay: 1000, turnsPerRealHour: 1000 }
    const l = new BudgetLedger({ q: { ...b, priority: 'queen' }, m: { ...b, priority: 'major' }, n: { ...b, priority: 'minor' } }, 10, () => t)
    for (let i = 0; i < 8; i++) l.spend('m', 1)
    expect(l.check('n', 1, 0.6).ok).toBe(false) // contended: minor needs ≥ 0.8
    expect(l.check('m', 1, 0.3).ok).toBe(false) // routine-level urgency shed
    expect(l.check('m', 1, 0.6).ok).toBe(true)
    expect(l.check('q', 1, 0.3).ok).toBe(true)
    l.spend('m', 1)
    l.spend('m', 1)
    expect(l.check('q', 1, 1).ok).toBe(false) // hard cap
    t = 3_600_001
    expect(l.check('n', 1, 0.2).ok).toBe(true) // window rolled
  })
})

describe('wake triggers', () => {
  it('routine check fires once a day at a staggered hour, and never while asleep', () => {
    const s = createInitialState({ id: 'x', seed: 'trig' })
    s.tick = tickOf(1, routineHour('sera'))
    s.agents.sera!.asleep = false
    expect(deriveTriggers('sera', s, [], 1).map((t) => t.kind)).toEqual(['routine_check'])
    s.agents.sera!.asleep = true
    expect(deriveTriggers('sera', s, [], 1)).toEqual([])
    const hours = new Set(CAST.map((c) => routineHour(c.id)))
    expect(hours.size).toBeGreaterThan(4)
  })

  it('direct address wakes the listener', () => {
    const s = createInitialState({ id: 'x', seed: 'trig' })
    s.tick = 30
    s.agents.tomas!.asleep = false
    const t = deriveTriggers('tomas', s, [{ id: 'e', tick: 30, type: 'speech', actorId: 'sera', targetId: 'tomas', text: 'Sera to Tomas: “We need to talk.”', magnitude: 0.5, privateTo: ['sera', 'tomas'] }], 1)
    expect(t[0]!.kind).toBe('direct_address')
  })

  it('dormant agents are never woken, whatever happens', async () => {
    const backend = new MockBackend(() => ({ intents: [] }))
    const w = withRuntime('dormant', { sera: backend })
    await lockstep(w.engine, w.runtime, 72)
    expect(new Set(backend.calls.map((p) => p.agent.id))).toEqual(new Set(['sera']))
  })
})

// ─── Phase 1 success criteria ────────────────────────────────────────────

describe('intents influence the next tick', () => {
  it('an agent’s move lands one tick after the turn completes', async () => {
    const backend = new MockBackend((p) => ({ intents: [{ kind: 'move', to: 'chapel', reason: 'quiet', weight: 0.95, hours: 4 }], mood: 'weary' }))
    const w = withRuntime('move', { mira: backend })
    // Run to just before Mira's routine wake, then step through it.
    while (w.turns.length === 0) {
      w.engine.step()
      await w.runtime.idle()
    }
    const turn = w.turns[0]!
    expect(turn.status).toBe('ok')
    expect(w.store.pendingIntents(w.id)).toHaveLength(1)
    const r = w.engine.step()
    expect(r.state.tick).toBe(turn.tickAnswered + 1)
    expect(r.state.agents.mira!.locationId).toBe('chapel')
    expect(w.store.agentMood(w.id, 'mira')).toBe('weary')
  })

  it('an agent pursues a goal over several days and the world reacts', async () => {
    // Sera keeps going back to the sealed deck. The world decides what she finds.
    const backend = new MockBackend((p) => ({
      intents: [{ kind: 'investigate', to: 'sealed-deck', reason: 'I have the keys.', weight: 0.9, hours: 10 }],
      memory_writes: [{ text: `Going back to the seal (${p.trigger.kind}).`, importance: 3 }],
    }))
    const w = withRuntime('goal', { sera: backend })
    await lockstep(w.engine, w.runtime, 24 * 5)
    const live = w.engine.state
    const goal = live.agents.sera!.goals.find((g) => g.id === 'g-seal')!

    const dormant = world('goal', 'dormant')
    for (let i = 0; i < 24 * 5; i++) dormant.engine.step()
    const dormantGoal = dormant.engine.state.agents.sera!.goals.find((g) => g.id === 'g-seal')!

    expect(goal.progress).toBeGreaterThan(dormantGoal.progress)
    expect(live.knowledge.sera!['f-seal-interior']?.source.kind).toBe('evidence')
    // And the replay of the logged intents reproduces it exactly.
    const rebuilt = replay({ id: w.id, seed: 'goal', settings: live.settings, toTick: live.tick, submissions: w.store.submissionsByTick(w.id) })
    expect(simFingerprint(rebuilt)).toBe(simFingerprint(live))
  })
})

describe('nothing bypasses the resolver', () => {
  const hostile = (p: ContextPacket) => ({
    intents: [
      { kind: 'move', to: 'sealed-deck', reason: 'break in', weight: 1 }, // locked to Bex
      { kind: 'seek', target: 'the-queen', reason: 'no such person' },
      { kind: 'confront', target: p.agent.id, reason: 'myself?' },
      { kind: 'teleport', to: 'spine' },
    ],
    dialogue: { say: 'You will obey.', to: 'alita', register: 'cold' }, // not present
    outcome: 'betray',
    relationships: { alita: { trust: 0 } },
    station: { hull: 100 },
    knowledge: ['f-crack'],
    events: [{ type: 'incident', text: 'Bex took the throne.' }],
  })

  it('a hostile agent that proposes only invalid things leaves the world exactly as if it were dormant', async () => {
    const w = withRuntime('hostile', { bex: new MockBackend(hostile) })
    await lockstep(w.engine, w.runtime, 60)
    expect(w.turns.filter((t) => t.status === 'ok').length).toBeGreaterThan(0)

    const baseline = world('hostile', 'baseline')
    for (let i = 0; i < 60; i++) baseline.engine.step()
    // World state is identical (ids aside) — every proposal was rejected at adjudication.
    const strip = (s: typeof w.engine.state) => ({ ...s, id: 'x', intents: s.intents.filter((i) => i.source === 'instinct') })
    expect(simFingerprint(strip(w.engine.state))).toBe(simFingerprint(strip(baseline.engine.state)))
    expect(w.engine.state.knowledge.bex!['f-crack']).toBeUndefined()
    expect(w.engine.state.station.hull).toBe(baseline.engine.state.station.hull)
  })

  it('timeouts and backend errors never stall the loop', async () => {
    const hang: AgentBackend = { name: 'hang', turn: () => new Promise(() => {}), reflect: () => new Promise(() => {}) }
    const boom: AgentBackend = { name: 'boom', turn: async () => { throw new Error('500 upstream') }, reflect: async () => { throw new Error('500 upstream') } }
    const w = withRuntime('fail', { sera: hang, kavi: boom }, { turnTimeoutMs: 50 })
    for (let i = 0; i < 30; i++) w.engine.step() // the loop does not wait
    expect(w.engine.state.tick).toBe(30)
    await w.runtime.idle()
    expect(w.turns.some((t) => t.status === 'error' && t.agentId === 'kavi')).toBe(true)
  })
})

describe('information boundaries in the context packet', () => {
  it('private memory never enters another agent’s context', async () => {
    const backend = new MockBackend(() => ({ memory_writes: [{ text: 'SECRET-SERA-7731: I held the lamp.', importance: 5, private: true }] }))
    const w = withRuntime('mem', { sera: backend })
    await lockstep(w.engine, w.runtime, 48)
    const trig = { kind: 'routine_check' as const, detail: 'x', urgency: 0.3, tick: w.engine.state.tick }
    expect(JSON.stringify(buildContextPacket(w.store, w.engine.state, 'sera', trig))).toContain('SECRET-SERA-7731')
    for (const c of CAST.filter((c) => c.id !== 'sera')) {
      expect(JSON.stringify(buildContextPacket(w.store, w.engine.state, c.id, trig))).not.toContain('SECRET-SERA-7731')
    }
  })

  it('an agent’s packet holds only its own knowledge, edges and visible events', () => {
    const w = world('bounds')
    for (let i = 0; i < 24 * 6; i++) w.engine.step()
    const s = w.engine.state
    const trig = { kind: 'routine_check' as const, detail: 'x', urgency: 0.3, tick: s.tick }
    for (const c of CAST) {
      const p = buildContextPacket(w.store, s, c.id, trig)
      const json = JSON.stringify(p)
      // Facts they don't know never appear verbatim.
      for (const f of ['f-crack', 'f-cassian-list', 'f-seal-opened', 'f-ines-edits']) {
        if (!s.knowledge[c.id]![f]) expect(json).not.toContain(require_fact_text(f))
      }
      expect(p.relationships.every((r) => r.id !== c.id)).toBe(true)
      // Non-Queen, non-engineer agents see the board's hull, not the true one.
      if (!['alita', 'tomas'].includes(c.id)) expect(p.world.condition.hull).toBe(Math.round(s.station.reportedHull))
    }
  })
})

import { factDef } from '../src/world/facts.js'
function require_fact_text(id: string): string {
  return factDef(id).text
}
