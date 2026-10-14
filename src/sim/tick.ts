import type { Intent, SimEvent, WorldState } from '../core/types.js'
import { castMember, isAgent } from '../world/cast.js'
import { isLocation, locationDef } from '../world/locations.js'
import { TickContext, type SimMemory } from './context.js'
import { resolveEncounters } from './encounters.js'
import { updateGoals } from './goals.js'
import { instinctProposals } from './instincts.js'
import { applyIntents } from './intents.js'
import { resolvePlaces } from './places.js'
import { resolveSchedule } from './schedule.js'
import { advanceStation } from './station.js'
import { cloneState } from './state.js'

/**
 * Bump whenever a change to src/sim or src/world would alter outcomes.
 * Replay is only meaningful against the same version; it is stamped on each world.
 */
export const SIM_VERSION = 1

export interface TickResult {
  state: WorldState
  events: SimEvent[]
  memories: SimMemory[]
  /** Every intent whose status changed this tick (committed, rejected, expired, fulfilled), including instincts. */
  intents: Intent[]
}

/**
 * Phases 1–5 of the tick (spec §3.2). PURE and DETERMINISTIC:
 * same `prev` + same `submissions` ⇒ identical result. No I/O, no clock,
 * no Math.random, and no reads of agent-owned (LLM-written) fields.
 *
 * `submissions` are the externally proposed intents (agent runtime, player)
 * drained from the queue since the last tick. Phase 6 (persist) and phase 7
 * (notify agents) live in the engine.
 */
export function advanceTick(prev: WorldState, submissions: readonly Intent[]): TickResult {
  const state = cloneState(prev)

  // PHASE 1 — advance clock
  state.tick += 1
  const tick = state.tick
  const ctx = new TickContext(state, tick)

  // PHASE 2 — apply intents (external submissions + the sim's own instincts)
  const external = submissions.map((i) => (i.kind === 'speak' ? { ...i, expiresTick: Math.min(i.expiresTick, tick + 2) } : i))
  const phase2 = applyIntents(state, [...external, ...instinctProposals(state, tick)], tick)
  ctx.intentChanges.push(...phase2.committed, ...phase2.rejected, ...phase2.retired)

  for (const i of phase2.rejected) {
    if (i.source === 'instinct') continue
    ctx.emit({
      type: 'intent',
      actorId: i.agentId,
      // Rejected proposals may name people/places that don't exist: never trust them for lookups.
      text: `${safeAgent(i.agentId)} meant to ${i.kind}${i.target ? ' ' + safeAgent(i.target) : ''}${i.to ? ' → ' + safeName(i.to) : ''}, but couldn’t: ${i.rejectReason}.`,
      magnitude: 0.3,
      privateTo: [i.agentId],
      data: { intent: i.id, rejected: true, reason: i.rejectReason },
    })
  }

  // Speech is generative content riding on an adjudicated intent. It is
  // recorded, it can wake the listener, but it changes nothing by itself.
  for (const i of phase2.committed) {
    if (i.kind !== 'speak' || !i.say || !i.target) continue
    const locationId = state.agents[i.agentId]!.locationId
    const present = Object.values(state.agents)
      .filter((a) => a.alive && !a.asleep && a.locationId === locationId)
      .map((a) => a.id)
      .sort()
    ctx.emit({
      type: 'speech',
      actorId: i.agentId,
      targetId: i.target,
      locationId,
      text: `${castMember(i.agentId).name} to ${castMember(i.target).name}: “${i.say}”`,
      magnitude: 0.5,
      privateTo: [...new Set([i.agentId, i.target, ...present])].sort(),
      data: { intent: i.id, register: i.register, say: i.say },
    })
  }

  // PHASE 3 — where is everyone
  resolveSchedule(state, tick)

  // PHASE 4 — encounters, then what places reveal
  resolveEncounters(ctx)
  resolvePlaces(ctx)

  // PHASE 5 — station, bodies, goals
  advanceStation(ctx)
  updateGoals(ctx)

  return { state, events: ctx.events, memories: ctx.memories, intents: ctx.intentChanges }
}

function safeName(id: string): string {
  return isLocation(id) ? locationDef(id).name : `“${String(id).slice(0, 40)}”`
}

function safeAgent(id: string): string {
  return isAgent(id) ? castMember(id).name : `“${String(id).slice(0, 40)}”`
}
