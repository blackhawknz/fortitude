import type { Intent, IntentKind, IntentProposal, Tick, WorldState } from '../core/types.js'
import { INTENT_KINDS } from '../core/types.js'
import { accessItems, isLocation, locationDef } from '../world/locations.js'
import { isAgent } from '../world/cast.js'
import { isFact } from '../world/facts.js'

export const MAX_ACTIVE_INTENTS = 4
export const MAX_INTENT_HORIZON = 48 // ticks
export const MAX_SAY_CHARS = 400
export const MAX_REASON_CHARS = 200

const NEEDS_TARGET: ReadonlySet<IntentKind> = new Set(['seek', 'avoid', 'speak', 'confide', 'withhold', 'confront', 'ally'])
const NEEDS_PLACE: ReadonlySet<IntentKind> = new Set(['move', 'investigate'])

export function canEnter(state: WorldState, agentId: string, locationId: string, tick: Tick): string | null {
  const loc = state.locations[locationId]
  if (!loc) return 'no such place'
  if (loc.sealedUntil !== null && loc.sealedUntil > tick) return `${locationDef(locationId).name} is sealed after the breach`
  const items = accessItems(locationDef(locationId))
  if (items.length && !items.some((i) => state.agents[agentId]!.inventory.includes(i))) {
    return `${locationDef(locationId).name} is locked to you`
  }
  return null
}

/**
 * Validate a proposal against current state. Returns a normalised intent
 * proposal (clamped/truncated) or a rejection reason. Pure.
 */
export function validateIntent(
  state: WorldState,
  p: IntentProposal,
  tick: Tick,
): { ok: true; value: IntentProposal } | { ok: false; reason: string } {
  const agent = state.agents[p.agentId]
  if (!agent) return { ok: false, reason: 'unknown agent' }
  if (!agent.alive) return { ok: false, reason: 'agent is dead' }
  if (!(INTENT_KINDS as readonly string[]).includes(p.kind)) return { ok: false, reason: `unknown action "${p.kind}"` }

  if (NEEDS_TARGET.has(p.kind) && !p.target) return { ok: false, reason: `${p.kind} needs a target` }
  if (NEEDS_PLACE.has(p.kind) && !p.to) return { ok: false, reason: `${p.kind} needs a place` }
  if (p.kind === 'observe' && !p.target && !p.to) return { ok: false, reason: 'observe needs a target or a place' }

  if (p.target !== undefined) {
    if (!isAgent(p.target)) return { ok: false, reason: `nobody called "${p.target}"` }
    if (p.target === p.agentId) return { ok: false, reason: 'cannot target yourself' }
    if (!state.agents[p.target]!.alive) return { ok: false, reason: 'they are dead' }
  }
  if (p.to !== undefined) {
    if (!isLocation(p.to)) return { ok: false, reason: `no place called "${p.to}"` }
    const blocked = canEnter(state, p.agentId, p.to, tick)
    if (blocked) return { ok: false, reason: blocked }
  }
  if (!(p.expiresTick > tick)) return { ok: false, reason: 'already expired' }

  if (p.kind === 'speak') {
    if (!p.say || !p.say.trim()) return { ok: false, reason: 'nothing to say' }
    const here = agent.locationId
    if (state.agents[p.target!]!.locationId !== here) return { ok: false, reason: 'they are not here' }
    if (state.agents[p.target!]!.asleep) return { ok: false, reason: 'they are asleep' }
  }

  // A revealed fact must be one the speaker actually knows. An invented or
  // unknown fact is stripped (the words are still said; nothing is learned).
  let fact = p.fact
  if (fact !== undefined && (!isFact(fact) || !state.knowledge[p.agentId]?.[fact])) fact = undefined
  if (p.kind !== 'speak' && p.kind !== 'confide') fact = undefined

  const value: IntentProposal = {
    ...p,
    weight: Math.max(0, Math.min(1, Number.isFinite(p.weight) ? p.weight : 0.5)),
    expiresTick: Math.min(p.expiresTick, tick + MAX_INTENT_HORIZON),
    reason: (p.reason ?? '').slice(0, MAX_REASON_CHARS),
  }
  if (p.say !== undefined) value.say = p.say.slice(0, MAX_SAY_CHARS)
  if (fact !== undefined) value.fact = fact
  else delete value.fact
  return { ok: true, value }
}

/** Intents that contradict each other when aimed at the same person. */
const OPPOSES: Partial<Record<IntentKind, readonly IntentKind[]>> = {
  avoid: ['seek', 'speak', 'confide', 'confront', 'ally'],
  seek: ['avoid'],
  speak: ['avoid'],
  confide: ['avoid', 'withhold'],
  confront: ['avoid', 'ally'],
  ally: ['avoid', 'confront'],
  withhold: ['confide'],
}

function opposes(a: IntentProposal, b: IntentProposal): boolean {
  return a.agentId === b.agentId && a.target !== undefined && a.target === b.target && !!OPPOSES[a.kind]?.includes(b.kind)
}

const sameAim = (a: IntentProposal, b: IntentProposal) =>
  a.agentId === b.agentId && a.kind === b.kind && a.target === b.target && a.to === b.to

export interface IntentPhaseResult {
  committed: Intent[]
  rejected: Intent[]
  /** Intents removed from the active set this tick (expired / superseded). */
  retired: Intent[]
}

/**
 * PHASE 2. Expire old intents, then adjudicate submissions in a stable order.
 * Mutates `state.intents`.
 */
export function applyIntents(state: WorldState, submissions: readonly Intent[], tick: Tick): IntentPhaseResult {
  const retired: Intent[] = []
  const committed: Intent[] = []
  const rejected: Intent[] = []

  // Expire
  state.intents = state.intents.filter((i) => {
    if (i.expiresTick <= tick) {
      retired.push({ ...i, status: 'expired' })
      return false
    }
    return true
  })

  const ordered = [...submissions].sort(
    (a, b) => a.createdTick - b.createdTick || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0) || (a.id < b.id ? -1 : 1),
  )

  for (const sub of ordered) {
    const v = validateIntent(state, sub, tick)
    if (!v.ok) {
      rejected.push({ ...sub, status: 'rejected', appliedTick: tick, rejectReason: v.reason })
      continue
    }
    const intent: Intent = { ...v.value, id: sub.id, createdTick: sub.createdTick, status: 'committed', appliedTick: tick }

    // Habit never overrules a decision: an instinct that contradicts an active
    // agent intent is dropped. Otherwise the newer decision wins.
    const contrary = state.intents.filter((i) => opposes(intent, i))
    if (intent.source === 'instinct' && contrary.some((i) => i.source !== 'instinct')) {
      rejected.push({ ...intent, status: 'rejected', rejectReason: 'overruled by your own decision' })
      continue
    }
    if (contrary.length) {
      state.intents = state.intents.filter((i) => {
        if (!opposes(intent, i)) return true
        retired.push({ ...i, status: 'expired', rejectReason: 'changed your mind' })
        return false
      })
    }

    // A new intent with the same aim replaces the old one.
    state.intents = state.intents.filter((i) => {
      if (sameAim(i, intent)) {
        retired.push({ ...i, status: 'expired', rejectReason: 'superseded' })
        return false
      }
      return true
    })

    // Cap active intents per agent: evict the weakest if the newcomer is stronger.
    const mine = state.intents.filter((i) => i.agentId === intent.agentId)
    if (mine.length >= MAX_ACTIVE_INTENTS) {
      const weakest = mine.reduce((w, i) => (i.weight < w.weight ? i : w))
      if (weakest.weight >= intent.weight) {
        rejected.push({ ...intent, status: 'rejected', rejectReason: 'too many other things on your mind' })
        continue
      }
      state.intents = state.intents.filter((i) => i.id !== weakest.id)
      retired.push({ ...weakest, status: 'expired', rejectReason: 'superseded' })
    }

    state.intents.push(intent)
    committed.push(intent)
  }

  state.intents.sort((a, b) => (a.id < b.id ? -1 : 1))
  return { committed, rejected, retired }
}

export function activeIntents(state: WorldState, agentId: string): Intent[] {
  return state.intents.filter((i) => i.agentId === agentId)
}

export function intentToward(state: WorldState, agentId: string, kind: IntentKind, target: string): Intent | undefined {
  return state.intents.find((i) => i.agentId === agentId && i.kind === kind && i.target === target)
}

/** Remove an intent because it achieved its aim. */
export function fulfil(state: WorldState, id: string, out: Intent[]): void {
  const i = state.intents.find((x) => x.id === id)
  if (!i) return
  state.intents = state.intents.filter((x) => x.id !== id)
  out.push({ ...i, status: 'fulfilled' })
}
