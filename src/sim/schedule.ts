import type { AgentId, Intent, LocationId, Tick, WorldState } from '../core/types.js'
import { weighted } from '../core/rng.js'
import { inHours, timeOf } from '../core/clock.js'
import { CAST, castMember, type RoutineBlock } from '../world/cast.js'
import { locationDef } from '../world/locations.js'
import { canEnter } from './intents.js'

/** Minimum intent weight needed to get someone out of bed. */
const WAKE_WEIGHT = 0.65

function routineBlock(agentId: AgentId, hour: number): { block: RoutineBlock; index: number } {
  const r = castMember(agentId).routine
  const index = r.findIndex((b) => inHours(hour, b.from, b.to))
  if (index < 0) throw new Error(`Routine gap for ${agentId} at hour ${hour}`)
  return { block: r[index]!, index }
}

function routinePlace(state: WorldState, agentId: AgentId, tick: Tick): { at: LocationId; block: RoutineBlock } {
  const { day, hour } = timeOf(tick)
  const { block, index } = routineBlock(agentId, hour)
  if (typeof block.at === 'string') return { at: block.at, block }
  // A block that wraps midnight belongs to the day it started.
  const blockDay = block.from > block.to && hour < block.to ? day - 1 : day
  const at = weighted(block.at, state.seed, 'routine', agentId, blockDay, index) ?? block.at[0]![0]
  return { at, block }
}

interface Placement {
  at: LocationId
  activity: string
  asleep: boolean
  working: boolean
  weight: number
}

function intentPlacement(state: WorldState, i: Intent, prevLocations: Record<AgentId, LocationId>): Placement | null {
  const c = castMember(i.agentId)
  switch (i.kind) {
    case 'move':
      return { at: i.to!, activity: `At ${locationDef(i.to!).name}`, asleep: false, working: false, weight: i.weight }
    case 'investigate':
      return { at: i.to!, activity: `Looking into ${locationDef(i.to!).name}`, asleep: false, working: false, weight: i.weight }
    case 'observe':
      return i.to
        ? { at: i.to, activity: `Watching ${locationDef(i.to).name}`, asleep: false, working: false, weight: i.weight }
        : i.target
          ? { at: prevLocations[i.target]!, activity: `Keeping an eye on ${castMember(i.target).name}`, asleep: false, working: false, weight: i.weight * 0.8 }
          : null
    case 'seek':
    case 'confide':
    case 'confront':
    case 'ally':
      // You go to where you last knew they were.
      return {
        at: prevLocations[i.target!]!,
        activity: `Looking for ${castMember(i.target!).name}`,
        asleep: false,
        working: false,
        weight: i.kind === 'seek' ? i.weight : i.weight * 0.7,
      }
    case 'rest':
      return { at: c.home, activity: 'Resting', asleep: false, working: false, weight: i.weight }
    case 'work':
      return { at: c.work, activity: 'Working', asleep: false, working: true, weight: i.weight }
    default:
      return null
  }
}

/**
 * PHASE 3. Where is everyone this hour?
 * Inputs: routine, committed intents, health, location state, seeded RNG.
 */
export function resolveSchedule(state: WorldState, tick: Tick): void {
  const prev: Record<AgentId, LocationId> = {}
  for (const c of CAST) prev[c.id] = state.agents[c.id]!.locationId

  for (const c of CAST) {
    const a = state.agents[c.id]!
    if (!a.alive) continue

    if (a.injuredUntil !== null && a.injuredUntil > tick) {
      Object.assign(a, { locationId: 'medbay', activity: 'Recovering in a medbay bed', asleep: false, working: false })
      continue
    }

    const { at, block } = routinePlace(state, c.id, tick)
    let place: Placement = {
      at,
      activity: block.activity,
      asleep: !!block.asleep,
      working: !!block.working,
      weight: block.asleep ? WAKE_WEIGHT : 0.35,
    }

    const mine = state.intents.filter((i) => i.agentId === c.id)
    for (const i of mine) {
      const p = intentPlacement(state, i, prev)
      if (!p || p.weight <= place.weight) continue
      if (canEnter(state, c.id, p.at, tick)) continue
      place = p
    }

    // Avoidance: if you'd end up where they were, go somewhere else.
    for (const i of mine) {
      if (i.kind !== 'avoid' || !i.target) continue
      if (prev[i.target] !== place.at || place.asleep) continue
      if (i.weight < place.weight && place.weight > 0.35) continue
      const away = place.at === c.home ? c.work : c.home
      if (!canEnter(state, c.id, away, tick)) {
        place = { at: away, activity: 'Keeping out of the way', asleep: false, working: away === c.work, weight: i.weight }
      }
    }

    // Routine places are always enterable by their owners, but incidents can seal them.
    if (canEnter(state, c.id, place.at, tick)) {
      place = { at: c.home, activity: 'Kept away by the seal doors', asleep: false, working: false, weight: 0 }
    }

    a.locationId = place.at
    a.activity = place.activity
    a.asleep = place.asleep
    a.working = place.working
  }
}
