import { describe, expect, it } from 'vitest'
import type { AgentId } from '../src/core/types.js'
import { tickOf } from '../src/core/clock.js'
import { createInitialState } from '../src/sim/state.js'
import { advanceTick } from '../src/sim/tick.js'
import { Engine } from '../src/engine/engine.js'
import { AgentRuntime, type TurnRecord } from '../src/agents/runtime.js'
import { MockBackend, type AgentBackend } from '../src/agents/backend.js'
import { parseReflection, reflectionHour, reflectionDay, type ReflectionPacket } from '../src/agents/reflection.js'
import { CAST } from '../src/world/cast.js'
import { memoryStore, proposal, run, freshWorld } from './helpers.js'

function setup(seed: string, agents: Partial<Record<AgentId, AgentBackend>>) {
  const store = memoryStore()
  store.create(createInitialState({ id: 'w', seed }))
  const engine = new Engine({ store, worldId: 'w', tickMs: 1000 })
  const turns: TurnRecord[] = []
  const runtime = new AgentRuntime({ store, worldId: 'w', getState: () => engine.state, agents, onTurn: (t) => turns.push(t), driftRoll: () => 1 })
  engine.listeners.push(runtime)
  return { store, engine, runtime, turns }
}

async function lockstep(engine: Engine, runtime: AgentRuntime, ticks: number) {
  for (let i = 0; i < ticks; i++) {
    engine.step()
    await runtime.idle()
  }
}

describe('speech is a real act (sim)', () => {
  it('revealing a known fact moves it into the listener’s head', () => {
    // Find a tick where Sera and Alita share the Throne Ring, awake.
    let s = freshWorld('speech')
    while (!(s.agents.sera!.locationId === s.agents.alita!.locationId && !s.agents.sera!.asleep && !s.agents.alita!.asleep)) s = advanceTick(s, []).state
    expect(s.knowledge.alita!['f-sera-helped']).toBeUndefined()
    const r = advanceTick(s, [proposal({ agentId: 'sera', kind: 'speak', target: 'alita', say: 'I held the lamp.', register: 'guarded', fact: 'f-sera-helped' }, s.tick + 1)])
    const k = r.state.knowledge.alita!['f-sera-helped']!
    expect(k.source).toMatchObject({ kind: 'told', by: 'sera', confided: true })
    expect(r.events.find((e) => e.type === 'speech')!.data!.fact).toBe('f-sera-helped')
  })

  it('a fact the speaker does not know is stripped: the words are said, nothing is learned', () => {
    let s = freshWorld('speech-2')
    while (!(s.agents.sera!.locationId === s.agents.alita!.locationId && !s.agents.sera!.asleep && !s.agents.alita!.asleep)) s = advanceTick(s, []).state
    const r = advanceTick(s, [proposal({ agentId: 'sera', kind: 'speak', target: 'alita', say: 'Cassian has a list.', fact: 'f-cassian-list' }, s.tick + 1)])
    expect(r.events.some((e) => e.type === 'speech')).toBe(true)
    expect(r.state.knowledge.alita!['f-cassian-list']).toBeUndefined()
  })

  it('being spoken to holds both people in place for a moment', () => {
    let s = freshWorld('hold')
    while (!(s.agents.sera!.locationId === s.agents.alita!.locationId && !s.agents.sera!.asleep && !s.agents.alita!.asleep)) s = advanceTick(s, []).state
    const r = advanceTick(s, [proposal({ agentId: 'sera', kind: 'speak', target: 'alita', say: 'Have you got a minute?' }, s.tick + 1)])
    // Committed this tick (it may already be fulfilled if they got talking).
    expect(r.intents.some((i) => i.id.startsWith('c') && i.agentId === 'alita' && i.kind === 'seek' && i.target === 'sera' && i.status === 'committed')).toBe(true)
  })
})

describe('decisions beat habits', () => {
  it('an instinct that contradicts an agent decision is overruled', () => {
    // Tomas's authored instinct is to avoid Sera from 08:00. If he has decided to seek her, the habit loses.
    const s = run(freshWorld('habit'), tickOf(2, 6)).state
    const r1 = advanceTick(s, [proposal({ agentId: 'tomas', kind: 'seek', target: 'sera', expiresTick: s.tick + 20 }, s.tick + 1)])
    const r = run(r1.state, 3)
    const all = [...r1.intents, ...r.results.flatMap((x) => x.intents)]
    const avoid = all.filter((i) => i.agentId === 'tomas' && i.kind === 'avoid' && i.target === 'sera')
    for (const a of avoid) expect(a.status).toBe('rejected')
    expect(r.state.intents.some((i) => i.agentId === 'tomas' && i.kind === 'avoid' && i.target === 'sera')).toBe(false)
  })

  it('a newer agent decision retires a contradictory older one', () => {
    const s = run(freshWorld('mind'), tickOf(2, 9)).state
    const r1 = advanceTick(s, [proposal({ agentId: 'kavi', kind: 'avoid', target: 'tomas' }, s.tick + 1)])
    const r2 = advanceTick(r1.state, [proposal({ agentId: 'kavi', kind: 'confront', target: 'tomas' }, r1.state.tick + 1)])
    const retired = r2.intents.find((i) => i.agentId === 'kavi' && i.kind === 'avoid' && i.target === 'tomas')!
    expect(retired.rejectReason).toBe('changed your mind')
    expect(r2.state.intents.some((i) => i.agentId === 'kavi' && i.kind === 'avoid' && i.target === 'tomas')).toBe(false)
  })
})

describe('reflection pass', () => {
  it('runs once per in-world day per agent, the hour before they sleep', async () => {
    const backend = new MockBackend(() => ({ intents: [] }))
    const w = setup('reflect-cadence', { sera: backend, tomas: backend })
    await lockstep(w.engine, w.runtime, 24 * 3 + 2)
    const refl = w.turns.filter((t) => t.kind === 'reflect' && t.status === 'ok')
    for (const id of ['sera', 'tomas']) {
      const mine = refl.filter((t) => t.agentId === id)
      expect(mine.length).toBe(3)
      for (const t of mine) expect(t.tickAsked % 24).toBe(reflectionHour(id))
      expect(new Set(mine.map((t) => reflectionDay(t.tickAsked))).size).toBe(3)
    }
    expect(reflectionHour('tomas')).toBe(0) // sleeps at 01:00; reflects on the day just gone
  })

  it('writes journal, opinions, beliefs, summaries and own goals; forgets only what it was shown', async () => {
    let shownIds: number[] = []
    const backend = new MockBackend(
      () => ({ memory_writes: [{ text: 'a note', importance: 2 }] }),
      0,
      (p: ReflectionPacket) => {
        shownIds = p.todays_memories.map((m) => m.id)
        return {
          goals: [{ id: 'g-tell-alita', text: 'Tell the Queen about the lamp', weight: 0.8, status: 'active' }, { id: 'g-seal', note: 'Closer.' }],
          opinions: [{ agentId: 'tomas', view: 'He is more frightened than I am.', stance: -0.2 }, { agentId: 'sera', view: 'me?', stance: 1 }],
          beliefs: [{ text: 'The Queen already suspects.', weight: 0.7 }],
          memory_consolidation: { forget: [...shownIds.slice(0, 1), 999999], keep: shownIds.slice(1, 2), summarise: 'A long day at the seal.' },
          journal: 'I held the lamp. I keep holding it.',
          mood: 'weary',
        }
      },
    )
    const w = setup('reflect-apply', { sera: backend })
    await lockstep(w.engine, w.runtime, 24 + 1)
    const r = w.turns.find((t) => t.kind === 'reflect')!
    expect(r.status).toBe('ok')
    expect(r.reflection!.opinions.map((o) => o.agentId)).toEqual(['tomas']) // self-opinion dropped
    expect(r.reflection!.forget).not.toContain(999999)
    expect(w.store.journals('w', 'sera')[0]!.text).toContain('lamp')
    expect(w.store.opinionOf('w', 'sera', 'tomas')!.text).toContain('frightened')
    expect(w.store.agentGoals('w', 'sera').map((g) => g.id)).toContain('g-tell-alita')
    expect(w.store.agentGoals('w', 'sera').find((g) => g.id === 'g-seal')!.note).toBe('Closer.')
    expect(w.store.semantic('w', 'sera').some((s) => s.kind === 'summary' && s.text.startsWith('Day 1'))).toBe(true)
    // ...and the next turn's packet carries them.
    const p = backend.calls.at(-1)!
    if (p.world.day > 1) {
      expect(p.beliefs).toContain('The Queen already suspects.')
      expect(p.relationships.find((x) => x.id === 'tomas')!.your_view).toContain('frightened')
    }
    // Reflection never touched the deterministic state: Sera's authored goals are intact.
    expect(w.engine.state.agents.sera!.goals.map((g) => g.id)).toEqual(['g-seal'])
  })

  it('agent-authored goal ids are accepted in later turns', async () => {
    const backend = new MockBackend(
      () => ({ goal_updates: [{ id: 'g-mine', progress: 0.4, note: 'Getting there.' }] }),
      0,
      () => ({ goals: [{ id: 'g-mine', text: 'Something of my own', weight: 0.6, status: 'active' }] }),
    )
    const w = setup('own-goal', { kavi: backend })
    await lockstep(w.engine, w.runtime, 24 * 2)
    const later = w.turns.filter((t) => t.kind === 'turn' && t.tickAsked > 24 && t.status === 'ok')
    expect(later.length).toBeGreaterThan(0)
    for (const t of later) expect(t.parsed!.violations.join(' ')).not.toMatch(/not your goal/)
    expect(w.store.agentGoals('w', 'kavi').find((g) => g.id === 'g-mine')!.perceivedProgress).toBe(0.4)
  })

  it('caps the agent’s own goals and parses defensively', () => {
    const p = { todays_memories: [{ id: 5, when: '', text: '', importance: 1 }], beliefs: [{ id: 9, text: 'x', weight: 1 }] } as unknown as ReflectionPacket
    const r = parseReflection(
      { opinions: [{ agentId: 'nobody', view: 'x', stance: 3 }, { agentId: 'tomas', view: 'y', stance: 3 }], beliefs: [{ id: 77, text: 'stolen id' }], drop_beliefs: [9, 10], memory_consolidation: { forget: [5, 6] } },
      p,
      'sera',
    )
    expect(r.opinions).toEqual([{ agentId: 'tomas', view: 'y', stance: 1 }])
    expect(r.beliefs[0]!.id).toBeUndefined()
    expect(r.dropBeliefs).toEqual([9])
    expect(r.forget).toEqual([5])
  })
})

describe('memory tiers', () => {
  it('episodic memory is capped per agent', () => {
    const store = memoryStore()
    store.create(createInitialState({ id: 'm', seed: 'mem' }))
    for (let i = 0; i < 260; i++) store.addAgentMemory('m', 'juno', i, `memory ${i}`, i % 50 === 0 ? 5 : 1, true)
    store.addAgentMemory('m', 'bex', 0, 'bex memory', 1, true)
    store.pruneEpisodic('m', 'juno', 200)
    const left = store.episodic('m', 'juno', 1000)
    expect(left).toHaveLength(200)
    expect(left.some((m) => m.text === 'memory 0')).toBe(true) // important and old survives
    expect(store.episodic('m', 'bex', 10)).toHaveLength(1) // other agents untouched
  })

  it('semantic memory is capped at 50, keeping opinions and recent summaries', () => {
    const store = memoryStore()
    store.create(createInitialState({ id: 'm', seed: 'mem2' }))
    for (const c of CAST.filter((c) => c.id !== 'sera')) store.setOpinion('m', 'sera', c.id, `about ${c.id}`, 0.1, 1)
    for (let i = 0; i < 30; i++) store.addSemantic('m', 'sera', 'summary', `Day ${i}`, 1, i)
    for (let i = 0; i < 60; i++) store.addSemantic('m', 'sera', 'belief', `belief ${i}`, i / 60, i)
    store.pruneSemantic('m', 'sera', 50, 14)
    const left = store.semantic('m', 'sera', 1000)
    expect(left).toHaveLength(50)
    expect(left.filter((r) => r.kind === 'opinion')).toHaveLength(CAST.length - 1)
    expect(left.filter((r) => r.kind === 'summary').map((r) => r.text)).toContain('Day 29')
    expect(left.filter((r) => r.kind === 'summary').map((r) => r.text)).not.toContain('Day 0')
  })
})
