import type { AgentId, Edge, RelationshipType, WorldState } from '../core/types.js'
import { edgeKey } from '../core/types.js'
import type { EdgeDelta } from '../world/outcomes.js'
import { castMember } from '../world/cast.js'

export const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v))
export const round1 = (v: number) => Math.round(v * 10) / 10
export const round2 = (v: number) => Math.round(v * 100) / 100

export function edge(state: WorldState, from: AgentId, to: AgentId): Edge {
  const e = state.edges[edgeKey(from, to)]
  if (!e) throw new Error(`No edge ${from}>${to}`)
  return e
}

/** Band classification of one directed edge. Order matters. */
export function relationshipType(e: Edge): RelationshipType {
  if (e.type === 'lover') return 'lover'
  if (e.tension >= 75 && e.trust <= 25) return 'enemy'
  if (e.tension >= 50) return 'rival'
  if (e.trust >= 70 && e.warmth >= 60) return 'close'
  if (e.trust >= 50 && e.warmth >= 40) return 'friend'
  if (e.encounters >= 1) return 'acquaintance'
  return 'stranger'
}

export const RELATIONSHIP_LABEL: Record<RelationshipType, string> = {
  stranger: 'Strangers',
  acquaintance: 'Acquaintances',
  friend: 'Friends',
  close: 'Close friends',
  rival: 'At odds',
  enemy: 'Enemies',
  lover: 'Lovers',
}

/** −1..1. Mean over both directions. */
export function affinity(state: WorldState, a: AgentId, b: AgentId): number {
  const ab = edge(state, a, b)
  const ba = edge(state, b, a)
  const one = (e: Edge) => ((e.trust + e.warmth) / 2 - e.tension) / 100
  return (one(ab) + one(ba)) / 2
}

/**
 * Apply a delta to one directed edge. Returns the previous type if the band
 * changed (a milestone), else null.
 */
/**
 * Diminishing returns: the closer a value is to an extreme, the harder it is
 * to push further. Goodwill near 100 is hard-won; a bad moment still costs.
 */
function nudge(v: number, d: number): number {
  const scale = d > 0 ? Math.max(0.15, 1 - v / 110) : Math.max(0.3, 0.4 + v / 100)
  return round1(clamp(v + d * scale))
}

/**
 * How hard `from` takes friction. Unkind people take more offence and hold
 * it longer; kind people absorb it. This is what makes grudges one-sided.
 */
export function offenceScale(from: AgentId): number {
  return 0.55 + (1 - castMember(from).traits.kindness / 100) * 1.0
}

export function applyDelta(e: Edge, d: EdgeDelta, tick: number, summary: string | null): RelationshipType | null {
  const before = e.type
  if (d.grudge) e.grudge = round1(clamp(e.grudge + (d.grudge > 0 ? d.grudge * offenceScale(e.from) : d.grudge)))
  if (d.trust) e.trust = nudge(e.trust, d.trust)
  if (d.warmth) e.warmth = nudge(e.warmth, d.warmth)
  if (d.tension) e.tension = nudge(e.tension, d.tension > 0 ? d.tension * offenceScale(e.from) : d.tension)
  if (summary !== null) {
    e.encounters += 1
    e.lastTick = tick
    e.history.push(summary)
    if (e.history.length > 12) e.history.splice(0, e.history.length - 12)
  }
  e.type = relationshipType(e)
  return e.type !== before ? before : null
}

/**
 * Daily drift. Unattended relationships settle back toward where they
 * started; tension fades slowly — but grudges above 60 barely fade at all.
 */
export function driftEdges(state: WorldState, seedOf: (from: AgentId, to: AgentId) => { trust: number; warmth: number; tension: number }): void {
  for (const e of Object.values(state.edges)) {
    const s = seedOf(e.from, e.to)
    e.trust = round1(e.trust + (s.trust - e.trust) * 0.02)
    e.warmth = round1(e.warmth + (s.warmth - e.warmth) * 0.03)
    const forgiveness = 0.01 + (castMember(e.from).traits.kindness / 100) * 0.04
    const fade = e.tension > 60 ? forgiveness / 6 : forgiveness
    const floor = Math.max(s.tension, e.grudge)
    // Tension settles toward the larger of where it started and the grudge — from either side.
    e.tension = round1(e.tension + (floor - e.tension) * (e.tension > floor ? fade : 0.05))
    e.grudge = round1(Math.max(0, e.grudge - 0.1))
    e.type = relationshipType(e)
  }
}
