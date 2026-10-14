import type { AgentId, SimEvent, WorldState } from '../core/types.js'
import { INTENT_KINDS } from '../core/types.js'
import { formatTime, timeOf } from '../core/clock.js'
import { CAST, castMember } from '../world/cast.js'
import { LOCATIONS, locationDef } from '../world/locations.js'
import { factVersion } from '../world/facts.js'
import { RELATIONSHIP_LABEL } from '../sim/relationships.js'
import { canEnter } from '../sim/intents.js'
import type { WorldStore } from '../db/store.js'

export type TriggerKind =
  | 'novel_encounter'
  | 'significant_outcome'
  | 'relationship_threshold'
  | 'goal_event'
  | 'direct_address'
  | 'station_incident'
  | 'routine_check'
  | 'drift'
  | 'intent_rejected'

export interface Trigger {
  kind: TriggerKind
  detail: string
  urgency: number // 0–1
  eventId?: string
  tick: number
}

/**
 * Everything an agent is allowed to know when it wakes, and nothing else
 * (spec §4.3, §10.1 "never knows what they shouldn't").
 *
 *  - private_memory: only this agent's own memory rows
 *  - knowledge: only facts in this agent's head
 *  - relationships: only this agent's OUTGOING edges (their own feelings)
 *  - recent_events: only events whose visibility includes this agent
 *  - world.condition: what this agent can see (most see the board's hull figure)
 */
export interface ContextPacket {
  agent: {
    id: string
    name: string
    pronouns: string
    role: string
    personality: string
    voice: string
    backstory: string
    goals: { id: string; text: string; weight: number; progress: number | null; note: string | null; yours: boolean }[]
    secret: string
    unspoken_want: string
    traits: Record<string, number>
  }
  self_state: {
    location: { id: string; name: string; description: string }
    activity: string
    health: number
    stress: number
    mood: string
    inventory: string[]
    current_intents: { kind: string; target?: string; to?: string; reason: string; until: string }[]
  }
  knowledge: { id: string; text: string; how: string }[]
  beliefs: string[]
  recent_days: string[]
  private_memory: string[]
  relationships: { id: string; name: string; trust: number; warmth: number; tension: number; resentment: number; label: string; lastInteraction: string | null; your_view: string | null }[]
  people_here: { id: string; name: string; activity: string; asleep: boolean }[]
  recent_events: { when: string; type: string; text: string }[]
  trigger: { kind: TriggerKind; detail: string; urgency: number }
  world: {
    name: string
    day: number
    hour: number
    condition: { hull: number; power: number; air: number; water: number; morale: number }
    hull_source: 'measured' | 'board'
    rumours: string[]
  }
  places: { id: string; name: string; open_to_you: boolean }[]
  people: { id: string; name: string; pronouns: string; role: string }[]
  available_actions: readonly string[]
  /** Present only in a live conversation with the player: the exchange so far, oldest first. */
  conversation?: { speaker: string; line: string }[]
}

/** Agents who can read true structural numbers rather than the posted board. */
const SEES_TRUE_HULL: ReadonlySet<AgentId> = new Set(['alita', 'tomas'])

export function buildContextPacket(store: WorldStore, state: WorldState, agentId: AgentId, trigger: Trigger, opts: { memoryLimit?: number; eventLimit?: number } = {}): ContextPacket {
  const c = castMember(agentId)
  const a = state.agents[agentId]!
  const loc = locationDef(a.locationId)

  const known = Object.values(state.knowledge[agentId] ?? {}).sort((x, y) => x.tick - y.tick || (x.fact < y.fact ? -1 : 1))
  // Each item is what THIS agent believes — a rumour if that's what reached them.
  const knowledge = known.map((k) => {
    const f = { id: k.fact, text: factVersion(k.fact, k.version ?? 0).text }
    const how =
      k.source.kind === 'self'
        ? 'you have always known'
        : k.source.kind === 'told'
          ? `${castMember(k.source.by).name} told you${k.source.confided ? ', in confidence' : ''}`
          : k.source.kind === 'overheard'
            ? `you overheard ${castMember(k.source.from).name}`
            : k.source.kind === 'evidence'
              ? `you found it at ${locationDef(k.source.locationId).name}`
              : `you noticed it watching ${castMember(k.source.subject).name}`
    return { id: f.id, text: f.text, how }
  })
  const semantic = store.semantic(state.id, agentId, 60)
  const beliefs = semantic.filter((r) => r.kind === 'belief').map((r) => r.text)
  const recent_days = semantic
    .filter((r) => r.kind === 'summary')
    .sort((x, y) => y.updatedTick - x.updatedTick)
    .slice(0, 4)
    .reverse()
    .map((r) => r.text)
  const opinions = new Map(semantic.filter((r) => r.kind === 'opinion' && r.subjectId).map((r) => [r.subjectId!, r.text]))
  const rumours = known
    .filter((k) => (k.source.kind === 'told' && !k.source.confided) || k.source.kind === 'overheard')
    .slice(-5)
    .map((k) => factVersion(k.fact, k.version ?? 0).text)

  const memories = store.episodic(state.id, agentId, opts.memoryLimit ?? 30)
  // Rank: importance first, recency second; keep the top slice, then present oldest → newest.
  const ranked = [...memories].sort((x, y) => y.importance - x.importance || y.tick - x.tick).slice(0, 16)
  ranked.sort((x, y) => x.tick - y.tick || x.id - y.id)
  const private_memory = ranked.map((m) => `[${formatTime(m.tick)}] ${m.text}`)

  const relationships = CAST.filter((o) => o.id !== agentId)
    .map((o) => {
      const e = state.edges[`${agentId}>${o.id}`]!
      return {
        id: o.id,
        name: o.name,
        trust: Math.round(e.trust),
        warmth: Math.round(e.warmth),
        tension: Math.round(e.tension),
        resentment: Math.round(e.grudge),
        label: RELATIONSHIP_LABEL[e.type],
        lastInteraction: e.history.at(-1) ?? null,
        your_view: opinions.get(o.id) ?? null,
      }
    })
    .sort((x, y) => Math.abs(y.warmth + y.trust - y.tension * 2 - 60) - Math.abs(x.warmth + x.trust - x.tension * 2 - 60))

  const people_here = CAST.filter((o) => o.id !== agentId && state.agents[o.id]!.alive && state.agents[o.id]!.locationId === a.locationId).map((o) => ({
    id: o.id,
    name: o.name,
    activity: state.agents[o.id]!.activity,
    asleep: state.agents[o.id]!.asleep,
  }))

  const events = store.visibleEvents(state.id, agentId, { limit: opts.eventLimit ?? 14 }).filter((e: SimEvent) => e.type !== 'station' || e.tick >= state.tick - 24)
  const recent_events = events.reverse().map((e) => ({ when: formatTime(e.tick), type: e.outcome ?? e.type, text: e.text }))

  const st = state.station
  const trueHull = SEES_TRUE_HULL.has(agentId)
  const { day, hour } = timeOf(state.tick)

  return {
    agent: {
      id: c.id,
      name: c.name,
      pronouns: c.pronouns,
      role: c.role,
      personality: c.personality,
      voice: c.voice,
      backstory: c.backstory,
      // The sim's progress number is not something a person can perceive. They see their own estimate.
      goals: store.agentGoals(state.id, agentId).map((g) => ({
        id: g.id,
        text: g.text,
        weight: g.weight,
        progress: g.perceivedProgress ?? null,
        note: g.note ?? null,
        yours: g.origin === 'agent',
      })),
      secret: c.secret.text,
      unspoken_want: c.unspoken,
      traits: { ...c.traits },
    },
    self_state: {
      location: { id: loc.id, name: loc.name, description: loc.description },
      activity: a.activity,
      health: Math.round(a.health),
      stress: Math.round(a.stress),
      mood: store.agentMood(state.id, agentId) ?? a.mood,
      inventory: [...a.inventory],
      current_intents: state.intents
        .filter((i) => i.agentId === agentId)
        .map((i) => ({ kind: i.kind, target: i.target, to: i.to, reason: i.reason, until: formatTime(i.expiresTick) })),
    },
    knowledge,
    beliefs,
    recent_days,
    private_memory,
    relationships,
    people_here,
    recent_events,
    trigger: { kind: trigger.kind, detail: trigger.detail, urgency: trigger.urgency },
    world: {
      name: state.name,
      day,
      hour,
      condition: {
        hull: Math.round(trueHull ? st.hull : st.reportedHull),
        power: Math.round(st.power),
        air: Math.round(st.air),
        water: Math.round(st.water),
        morale: Math.round(st.morale),
      },
      hull_source: trueHull ? 'measured' : 'board',
      rumours,
    },
    places: LOCATIONS.map((l) => ({ id: l.id, name: l.name, open_to_you: canEnter(state, agentId, l.id, state.tick) === null })),
    people: CAST.filter((o) => o.id !== agentId).map((o) => ({ id: o.id, name: o.name, pronouns: o.pronouns, role: o.role })),
    available_actions: INTENT_KINDS.filter((k) => k !== 'speak'),
  }
}
