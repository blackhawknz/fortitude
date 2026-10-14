import type { Intent, IntentKind, SimEvent, WorldState } from '../core/types.js'
import { castMember, isAgent } from '../world/cast.js'
import { isLocation, locationDef } from '../world/locations.js'
import { factDef } from '../world/facts.js'
import { chance } from '../core/rng.js'
import { learn } from './knowledge.js'
import { fulfil } from './intents.js'
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
export const SIM_VERSION = 2

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
  // If the speaker chose to reveal a fact, that part IS adjudicated: the
  // listener learns it; said openly, everyone present does; said quietly,
  // bystanders may overhear.
  const holds: Intent[] = []
  for (const i of phase2.committed) {
    if (i.kind !== 'speak' || !i.say || !i.target) continue
    const speaker = i.agentId
    const listener = i.target
    const locationId = state.agents[speaker]!.locationId
    const present = Object.values(state.agents)
      .filter((a) => a.alive && !a.asleep && a.locationId === locationId)
      .map((a) => a.id)
      .sort()
    const bystanders = present.filter((p) => p !== speaker && p !== listener)
    const heard: string[] = []
    if (i.fact) {
      const quiet = i.register === 'guarded' || i.register === 'warm'
      learn(state, listener, i.fact, { kind: 'told', by: speaker, tick, confided: quiet }, tick)
      for (const b of bystanders) {
        const p = quiet ? 0.02 + (castMember(b).traits.perception / 100) * 0.16 : 0.9
        if (!chance(p, state.seed, tick, i.id, b, 'overhear-speech')) continue
        heard.push(b)
        learn(state, b, i.fact, { kind: 'overheard', from: speaker, tick }, tick)
      }
      fulfilAll(state, speaker, listener, ['confide'], ctx.intentChanges)
    }
    const quietly = i.register === 'guarded' || i.register === 'warm'
    const ev = ctx.emit({
      type: 'speech',
      actorId: speaker,
      targetId: listener,
      locationId,
      text: `${castMember(speaker).name} to ${castMember(listener).name}: “${i.say}”`,
      magnitude: i.fact ? 0.7 : 0.5,
      // A quiet word is heard by the listener and whoever overheard; an open one by the room.
      privateTo: [...new Set([speaker, listener, ...(quietly ? heard : present)])].sort(),
      data: { intent: i.id, register: i.register, say: i.say, fact: i.fact, overheard: heard },
    })
    if (i.fact) {
      ctx.remember(listener, `${castMember(speaker).name} told me: “${factDef(i.fact).text}”`, 4, ev.id)
      for (const b of heard) ctx.remember(b, `Overheard ${castMember(speaker).name} telling ${castMember(listener).name}: “${factDef(i.fact).text}”`, 4, ev.id)
    }
    // Conversation hold: people who've just been spoken to linger a moment to answer —
    // unless they're set on avoiding the speaker.
    for (const [who, other] of [[listener, speaker], [speaker, listener]] as const) {
      if (state.intents.some((x) => x.agentId === who && x.kind === 'avoid' && x.target === other)) continue
      holds.push({
        id: `c${tick}.${who}.${holds.length}`,
        agentId: who,
        kind: 'seek',
        target: other,
        reason: 'In the middle of a conversation.',
        // Strong enough to keep people talking (even past bedtime); only a pressing intent breaks it.
        weight: 0.75,
        expiresTick: tick + 2,
        source: 'instinct',
        createdTick: tick,
        status: 'pending',
        appliedTick: null,
      })
    }
  }
  if (holds.length) {
    const r = applyIntents(state, holds, tick)
    ctx.intentChanges.push(...r.committed, ...r.rejected, ...r.retired)
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

function fulfilAll(state: WorldState, agentId: string, target: string, kinds: IntentKind[], out: Intent[]): void {
  for (const i of [...state.intents]) if (i.agentId === agentId && i.target === target && kinds.includes(i.kind)) fulfil(state, i.id, out)
}

function safeAgent(id: string): string {
  return isAgent(id) ? castMember(id).name : `“${String(id).slice(0, 40)}”`
}
