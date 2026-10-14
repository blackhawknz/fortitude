import { describe, expect, it } from 'vitest'
import { createInitialState, simFingerprint } from '../src/sim/state.js'
import { advanceTick } from '../src/sim/tick.js'
import { replay } from '../src/sim/replay.js'
import { Engine } from '../src/engine/engine.js'
import { memoryStore } from './helpers.js'

describe('persistence', () => {
  it('load(create(s)) round-trips the deterministic state', () => {
    const store = memoryStore()
    const s = createInitialState({ id: 'p1', seed: 'persist' })
    store.create(s)
    expect(simFingerprint(store.load('p1'))).toBe(simFingerprint(s))
  })

  it('state survives a run of persisted ticks', () => {
    const store = memoryStore()
    let s = store.create(createInitialState({ id: 'p2', seed: 'persist-2' }))
    for (let i = 0; i < 24 * 3; i++) {
      const r = advanceTick(s, [])
      store.persistTick(r)
      s = r.state
    }
    expect(simFingerprint(store.load('p2'))).toBe(simFingerprint(s))
  })

  it('engine drains the queue, and the persisted log replays exactly', () => {
    const store = memoryStore()
    store.create(createInitialState({ id: 'p3', seed: 'persist-3' }))
    const engine = new Engine({ store, worldId: 'p3', tickMs: 1000 })
    for (let i = 0; i < 30; i++) engine.step()
    store.submitIntent('p3', { agentId: 'sera', kind: 'move', to: 'sealed-deck', reason: 'look', weight: 0.9, expiresTick: 60, source: 'agent' }, engine.state.tick, 'x1')
    store.submitIntent('p3', { agentId: 'bex', kind: 'move', to: 'sealed-deck', reason: 'nosy', weight: 0.9, expiresTick: 60, source: 'agent' }, engine.state.tick, 'x2')
    expect(store.pendingIntents('p3')).toHaveLength(2)
    const r = engine.step()
    expect(store.pendingIntents('p3')).toHaveLength(0)
    expect(r.state.agents.sera!.locationId).toBe('sealed-deck')
    expect(r.intents.find((i) => i.id === 'x2')?.status).toBe('rejected')
    for (let i = 0; i < 40; i++) engine.step()

    const live = store.load('p3')
    const rebuilt = replay({ id: 'p3', seed: 'persist-3', settings: live.settings, toTick: live.tick, submissions: store.submissionsByTick('p3') })
    expect(simFingerprint(rebuilt)).toBe(simFingerprint(live))
  })

  it('agent-owned writes never alter the deterministic state', () => {
    const store = memoryStore()
    store.create(createInitialState({ id: 'p4', seed: 'persist-4' }))
    const before = simFingerprint(store.load('p4'))
    store.setAgentMood('p4', 'sera', 'elated')
    store.setGoalBelief('p4', 'sera', 'g-seal', 0.9, 'I am nearly there')
    store.addAgentMemory('p4', 'sera', 0, 'A private thought.', 3, true)
    expect(simFingerprint(store.load('p4'))).toBe(before)
  })

  it('catch-up after downtime is capped at 60 ticks', () => {
    const store = memoryStore()
    store.create(createInitialState({ id: 'p5', seed: 'persist-5' }))
    const engine = new Engine({ store, worldId: 'p5', tickMs: 1000 })
    engine.step()
    const last = store.world('p5')!.lastTickAt!
    expect(engine.ticksOwed(last + 5_500)).toBe(5)
    expect(engine.ticksOwed(last + 10 * 3_600_000)).toBe(60)
  })

  it('visibility: an agent only sees events they may know first-hand', () => {
    const store = memoryStore()
    store.create(createInitialState({ id: 'p6', seed: 'persist-6' }))
    const engine = new Engine({ store, worldId: 'p6', tickMs: 1000 })
    for (let i = 0; i < 24 * 4; i++) engine.step()
    for (const agent of ['juno', 'sera', 'bex']) {
      const seen = store.visibleEvents('p6', agent, { limit: 500 })
      expect(seen.length).toBeGreaterThan(0)
      for (const e of seen) expect(e.privateTo === null || e.privateTo.includes(agent)).toBe(true)
    }
  })
})
