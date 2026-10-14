import type { AgentState, Edge, Knowing, LocationState, WorldSettings, WorldState } from '../core/types.js'
import { DEFAULT_SETTINGS, edgeKey } from '../core/types.js'
import { CAST, allGoals, edgeSeed, setPlayerName } from '../world/cast.js'
import { LOCATIONS } from '../world/locations.js'
import { relationshipType } from './relationships.js'
import { initGoals } from './goals.js'
import { fingerprint } from '../core/rng.js'

export interface NewWorldOptions {
  id: string
  name?: string
  seed: string
  settings?: Partial<WorldSettings>
}

/** Build tick-0 state from the authored content. Pure. */
export function createInitialState(opts: NewWorldOptions): WorldState {
  const settings = { ...DEFAULT_SETTINGS, ...opts.settings }
  setPlayerName(settings.playerName)
  const agents: Record<string, AgentState> = {}
  const knowledge: Record<string, Record<string, Knowing>> = {}

  for (const c of CAST) {
    agents[c.id] = {
      id: c.id,
      alive: true,
      health: c.id === 'mira' ? 88 : 92,
      stress: c.id === 'tomas' ? 58 : c.id === 'kavi' ? 52 : c.id === 'sera' ? 46 : 28,
      locationId: c.home,
      activity: 'Asleep',
      asleep: true,
      working: false,
      inventory: [...c.inventory],
      goals: allGoals(c).map((g) => ({ id: g.id, text: g.text, weight: g.weight, progress: 0 })),
      mood: 'calm',
      moodTick: 0,
      injuredUntil: null,
    }
    knowledge[c.id] = {}
    for (const k of c.knows) {
      knowledge[c.id]![k.fact] = {
        fact: k.fact,
        tick: 0,
        source: k.from ? { kind: 'told', by: k.from, tick: 0, confided: k.confided ?? false } : { kind: 'self' },
      }
    }
  }

  const edges: Record<string, Edge> = {}
  for (const a of CAST) {
    for (const b of CAST) {
      if (a.id === b.id) continue
      const s = edgeSeed(a.id, b.id)
      const edge: Edge = {
        from: a.id,
        to: b.id,
        trust: s.trust,
        warmth: s.warmth,
        tension: s.tension,
        grudge: 0,
        // Years of living together — except the newcomer, who has met nobody aboard.
        encounters: a.isPlayer || b.isPlayer ? 0 : 20,
        lastTick: null,
        type: 'acquaintance',
        history: [],
      }
      edge.type = s.type ?? relationshipType(edge)
      edges[edgeKey(a.id, b.id)] = edge
    }
  }

  const locations: Record<string, LocationState> = {}
  for (const l of LOCATIONS) {
    locations[l.id] = { id: l.id, condition: l.id === 'spine' ? 58 : 80, dark: false, sealedUntil: null }
  }

  const hull = 64
  const state: WorldState = {
    id: opts.id,
    name: opts.name ?? 'Fortitude',
    seed: opts.seed,
    tick: 0,
    settings,
    agents,
    edges,
    locations,
    station: {
      hull,
      reportedHull: hull + 11,
      power: 78,
      air: 72,
      water: 58,
      morale: 52,
      incidents: [],
      lastIncident: {},
    },
    knowledge,
    betrayals: [],
    exposures: [],
    intents: [],
    intentSeq: 0,
  }
  initGoals(state)
  return state
}

/**
 * Fingerprint of the deterministic state only. Agent-owned annotations
 * (goal notes / perceived progress) are stripped: they are not inputs to the
 * sim and may legitimately differ between a live run and a replay.
 */
export function simFingerprint(s: WorldState): string {
  const copy = structuredClone(s)
  for (const a of Object.values(copy.agents)) for (const g of a.goals) {
    delete g.note
    delete g.perceivedProgress
  }
  return fingerprint(copy)
}

/** Deep copy. The tick is written as pure state â†’ state; it clones first. */
export function cloneState(s: WorldState): WorldState {
  return structuredClone(s)
}
