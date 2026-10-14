import type { AgentId, SimEvent, WorldState } from '../core/types.js'
import { rng } from '../core/rng.js'
import { timeOf } from '../core/clock.js'
import { castMember, allGoals } from '../world/cast.js'
import type { Trigger } from './packet.js'

/** The hour of the day an agent gets its routine check — staggered so the cast doesn't all wake at once. */
export function routineHour(agentId: AgentId): number {
  return 8 + Math.floor(rng('routine-hour', agentId) * 12) // 08:00–19:00
}

const visibleTo = (e: SimEvent, id: AgentId) => e.privateTo === null || e.privateTo.includes(id)

function goalFacts(agentId: AgentId): string[] {
  return allGoals(castMember(agentId)).flatMap((g) => (g.kind === 'learn' ? g.facts : g.kind === 'conceal' || g.kind === 'tell' ? [g.fact] : []))
}

/**
 * Spec §4.2 wake triggers, derived from one tick's events. Returns every
 * trigger that applies; the runtime takes the most urgent and coalesces the rest.
 * `driftRoll` is injected so tests can pin it.
 */
export function deriveTriggers(agentId: AgentId, state: WorldState, events: readonly SimEvent[], driftRoll: number = Math.random(), driftChance = 0.004): Trigger[] {
  const me = state.agents[agentId]!
  if (!me.alive) return []
  const out: Trigger[] = []
  const tick = state.tick
  const myGoalFacts = goalFacts(agentId)

  for (const e of events) {
    if (!visibleTo(e, agentId)) continue
    const involved = e.actorId === agentId || e.targetId === agentId
    switch (e.type) {
      case 'speech':
        if (e.targetId === agentId) out.push({ kind: 'direct_address', detail: e.text, urgency: 0.9, eventId: e.id, tick })
        break
      case 'encounter': {
        if (involved) {
          const other = e.actorId === agentId ? e.targetId! : e.actorId!
          const edge = state.edges[`${agentId}>${other}`]
          if (edge && edge.encounters === 1) out.push({ kind: 'novel_encounter', detail: e.text, urgency: 0.7, eventId: e.id, tick })
          else if (e.magnitude >= 0.5) out.push({ kind: 'significant_outcome', detail: e.text, urgency: e.magnitude, eventId: e.id, tick })
        } else if (e.magnitude >= 0.7) {
          out.push({ kind: 'significant_outcome', detail: `You saw it: ${e.text}`, urgency: 0.5, eventId: e.id, tick })
        }
        break
      }
      case 'milestone':
        if (e.actorId === agentId) out.push({ kind: 'relationship_threshold', detail: e.text, urgency: 0.6, eventId: e.id, tick })
        break
      case 'discovery': {
        if (e.actorId !== agentId) break
        const fact = typeof e.data?.fact === 'string' ? e.data.fact : undefined
        const goal = (fact && myGoalFacts.includes(fact)) || typeof e.data?.goal === 'string'
        out.push({ kind: 'goal_event', detail: e.text, urgency: goal ? 0.85 : 0.65, eventId: e.id, tick })
        break
      }
      case 'betrayal_discovered':
        if (e.actorId === agentId) out.push({ kind: 'significant_outcome', detail: e.text, urgency: 0.95, eventId: e.id, tick })
        break
      case 'incident': {
        const present = Array.isArray(e.data?.present) && (e.data.present as string[]).includes(agentId)
        if (present) out.push({ kind: 'station_incident', detail: `${e.text} You were there.`, urgency: Math.max(0.6, e.magnitude), eventId: e.id, tick })
        else if (e.privateTo === null && e.magnitude >= 0.75) out.push({ kind: 'station_incident', detail: e.text, urgency: 0.55, eventId: e.id, tick })
        break
      }
      case 'intent':
        if (e.actorId === agentId && e.data?.rejected) out.push({ kind: 'intent_rejected', detail: e.text, urgency: 0.45, eventId: e.id, tick })
        break
    }
  }

  // Asleep: only things that would wake a sleeping person.
  if (me.asleep) return out.filter((t) => t.kind === 'station_incident' && t.urgency >= 0.6)

  if (timeOf(tick).hour === routineHour(agentId)) {
    out.push({ kind: 'routine_check', detail: `A quiet moment ${me.activity.toLowerCase()}. Time to take stock of the day.`, urgency: 0.3, tick })
  }
  if (driftRoll < driftChance) out.push({ kind: 'drift', detail: 'Your mind wanders to the things you have been putting off.', urgency: 0.2, tick })
  return out
}

/** Pick the most urgent trigger; fold the others into its detail so nothing is lost. */
export function coalesce(triggers: readonly Trigger[]): Trigger | null {
  if (!triggers.length) return null
  const sorted = [...triggers].sort((a, b) => b.urgency - a.urgency)
  const top = sorted[0]!
  const rest = sorted.slice(1, 4).map((t) => t.detail)
  return rest.length ? { ...top, detail: `${top.detail}${rest.length ? ' — Also: ' + rest.join(' / ') : ''}` } : top
}
