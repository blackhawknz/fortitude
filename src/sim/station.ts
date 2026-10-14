import type { AgentId, Incident, IncidentKind, LocationId, Mood, StationState, Tick, WorldState } from '../core/types.js'
import { chance, int, pick, rng } from '../core/rng.js'
import { formatTime, inHours, timeOf } from '../core/clock.js'
import { CAST, castMember } from '../world/cast.js'
import { LOCATIONS, locationDef } from '../world/locations.js'
import { FACTS } from '../world/facts.js'
import type { TickContext } from './context.js'
import { clamp, driftEdges, round1, round2 } from './relationships.js'
import { edgeSeed } from '../world/cast.js'

// ─── Incident table (spec §6.2). Data, with small predicate functions. ────

interface IncidentDef {
  kind: IncidentKind
  chance: (s: StationState, tick: Tick, firstTime: boolean) => number
  cooldown: number
  places: readonly LocationId[]
  duration: readonly [number, number]
  severity: (s: StationState) => number
  text: (place: string, tick: Tick) => string
  morale: number
  stressPresent: number
}

const RING_PLACES = LOCATIONS.filter((l) => l.kind !== 'quarters' && l.kind !== 'restricted').map((l) => l.id)

export const INCIDENTS: readonly IncidentDef[] = [
  {
    kind: 'pressure_alarm',
    chance: (s) => (s.hull < 70 ? 0.004 + ((70 - s.hull) / 70) * 0.04 : 0),
    cooldown: 6,
    places: ['spine', 'third-bay', 'dock', 'promenade', 'reclamation'],
    duration: [1, 2],
    severity: (s) => clamp((75 - s.hull) / 60, 0.2, 1),
    text: (p) => `A pressure alarm sounded in ${p}.`,
    morale: -1.5,
    stressPresent: 6,
  },
  {
    kind: 'brownout',
    chance: (s) => (s.power < 60 ? 0.01 + ((60 - s.power) / 60) * 0.06 : 0),
    cooldown: 12,
    places: RING_PLACES,
    duration: [2, 5],
    severity: (s) => clamp((65 - s.power) / 50, 0.2, 1),
    text: (p) => `The lights failed in ${p}. Emergency strips only.`,
    morale: -1,
    stressPresent: 3,
  },
  {
    kind: 'water_rationing',
    chance: (s, tick) => (s.water < 50 && timeOf(tick).hour === 6 ? 0.6 : 0),
    cooldown: 24,
    places: ['mess'],
    duration: [24, 24],
    severity: (s) => clamp((55 - s.water) / 30, 0.2, 1),
    text: () => 'Water rationing was posted on the mess board. Half measures for a day.',
    morale: -4,
    stressPresent: 0,
  },
  {
    kind: 'hull_breach',
    chance: (s) => (s.hull < 40 ? 0.0005 + ((40 - s.hull) / 40) * 0.0015 : 0),
    cooldown: 72,
    places: ['spine', 'third-bay', 'dock', 'promenade'],
    duration: [12, 24],
    severity: () => 1,
    text: (p) => `Hull breach in ${p}. The seal doors came down.`,
    morale: -8,
    stressPresent: 20,
  },
  {
    kind: 'sealed_deck_activity',
    chance: (_s, tick, first) => (timeOf(tick).day >= 15 && inHours(timeOf(tick).hour, 0, 5) ? (first ? 0.25 : 0.015) : 0),
    cooldown: 24,
    places: ['third-bay'],
    duration: [1, 1],
    severity: () => 0.9,
    text: (_p, tick) => `At ${formatTime(tick).split(', ')[1]} the pressure board in the Third Bay flickered. Air had moved behind the seal.`,
    morale: -2,
    stressPresent: 8,
  },
]

/** Incidents everyone on the station hears about, not just those present. */
const PUBLIC_INCIDENTS: ReadonlySet<IncidentKind> = new Set(['water_rationing', 'hull_breach', 'sealed_deck_activity'])

function presentAt(s: WorldState, loc: LocationId): AgentId[] {
  return CAST.filter((c) => s.agents[c.id]!.alive && s.agents[c.id]!.locationId === loc).map((c) => c.id)
}

function maintainers(s: WorldState, subsystem: 'hull' | 'air' | 'water'): number {
  return CAST.filter((c) => {
    const a = s.agents[c.id]!
    if (!a.alive || a.asleep || !a.working || !c.maintains?.includes(subsystem)) return false
    const sub = locationDef(a.locationId).subsystem
    return sub === subsystem || (subsystem === 'hull' && a.locationId === 'third-bay') || (subsystem === 'water' && sub === 'air')
  }).length
}

/** PHASE 5. Station subsystems, incidents, bodies. */
export function advanceStation(ctx: TickContext): void {
  const s = ctx.state
  const st = s.station
  const tick = ctx.tick
  const seed = ctx.seed
  const { hour } = timeOf(tick)

  // ── Subsystems ────────────────────────────────────────────────────────
  const hullWork = Math.min(0.5, 0.35 * maintainers(s, 'hull'))
  const decay = (s.settings.hullDecayPerDay / 24) * (0.5 + rng(seed, tick, 'hull')) * (1 - hullWork)
  // Hull is monotonic: it only ever goes down. Kept to 3 dp so slow decay isn't rounded away.
  st.hull = Math.round(Math.max(0, st.hull - decay) * 1000) / 1000

  const noise = (k: string) => (rng(seed, tick, k) - 0.5) * 1.2
  st.power = round1(clamp(st.power + (62 + st.hull * 0.2 - st.power) * 0.03 + noise('power')))
  st.air = round1(clamp(st.air + ((maintainers(s, 'air') ? 80 : 60) - st.air) * 0.02 + noise('air') * 0.5))
  st.water = round1(clamp(st.water + ((maintainers(s, 'water') ? 61 : 45) - st.water) * 0.02 + noise('water') * 0.6))

  s.locations['spine']!.condition = round1(clamp(st.hull - 6))

  // ── End incidents ─────────────────────────────────────────────────────
  st.incidents = st.incidents.filter((inc) => {
    if (inc.endTick > tick) return true
    const loc = s.locations[inc.locationId]!
    if (inc.kind === 'brownout') loc.dark = false
    return false
  })
  for (const loc of Object.values(s.locations)) if (loc.sealedUntil !== null && loc.sealedUntil <= tick) loc.sealedUntil = null

  // ── New incidents ─────────────────────────────────────────────────────
  for (const def of INCIDENTS) {
    const last = st.lastIncident[def.kind]
    if (last !== undefined && tick - last < def.cooldown) continue
    if (!chance(def.chance(st, tick, last === undefined), seed, tick, def.kind, 'incident')) continue
    fireIncident(ctx, def)
  }

  // ── The morning board ─────────────────────────────────────────────────
  if (hour === 6) {
    st.reportedHull = round1(clamp(st.reportedHull - 0.12, st.hull + 6, st.hull + 25))
    ctx.emit({
      type: 'station',
      text: `The morning board posted the hull at ${Math.round(st.reportedHull)}%.`,
      magnitude: 0.05,
      privateTo: null,
      data: { reportedHull: st.reportedHull },
    })
  }

  // ── Relationships settle, once a day ─────────────────────────────────
  if (hour === 4) driftEdges(s, edgeSeed)

  // ── Morale ────────────────────────────────────────────────────────────
  // Everyone knows the station is dying: there is a standing gloom term.
  // The Queen's optimistic board figure props it up — that is what her secret buys.
  const living = CAST.filter((c) => s.agents[c.id]!.alive)
  const avgStress = living.reduce((sum, c) => sum + s.agents[c.id]!.stress, 0) / Math.max(1, living.length)
  const target = 0.35 * (100 - avgStress) + 0.25 * st.reportedHull + 0.25 * ((st.power + st.air + st.water) / 3) - 12
  st.morale = round1(clamp(st.morale + (target - st.morale) * 0.02))

  advanceBodies(ctx)
}

function fireIncident(ctx: TickContext, def: IncidentDef): void {
  const s = ctx.state
  const st = s.station
  const tick = ctx.tick
  const locationId = pick(def.places, ctx.seed, tick, def.kind, 'where')
  const inc: Incident = {
    id: `inc${tick}.${def.kind}`,
    kind: def.kind,
    locationId,
    startTick: tick,
    endTick: tick + int(def.duration[0], def.duration[1], ctx.seed, tick, def.kind, 'len'),
    severity: round1(def.severity(st) * 10) / 10,
    text: def.text(locationDef(locationId).name, tick),
  }
  st.incidents.push(inc)
  st.lastIncident[def.kind] = tick
  st.morale = round1(clamp(st.morale + def.morale))

  const present = presentAt(s, locationId)
  const loc = s.locations[locationId]!
  if (def.kind === 'brownout') {
    loc.dark = true
    st.power = round1(clamp(st.power - 1))
  }
  if (def.kind === 'hull_breach') {
    loc.sealedUntil = inc.endTick
    st.hull = Math.max(0, st.hull - 1.5)
  }
  if (def.kind === 'water_rationing') {
    // Short water makes everyone shorter with each other.
    for (const c of CAST) {
      const a = s.agents[c.id]!
      if (a.alive) a.stress = round1(clamp(a.stress + 3))
    }
    for (const e of Object.values(s.edges)) e.tension = round1(clamp(e.tension + 1.5))
  }

  const ev = ctx.emit({
    type: 'incident',
    locationId,
    text: inc.text,
    magnitude: 0.4 + inc.severity * 0.5,
    privateTo: PUBLIC_INCIDENTS.has(def.kind) ? null : present,
    data: { incident: inc.id, kind: def.kind, present, severity: inc.severity },
  })

  for (const id of present) {
    const a = s.agents[id]!
    a.stress = round1(clamp(a.stress + def.stressPresent))
    ctx.moodHints[id] = def.kind === 'hull_breach' ? 'grim' : 'anxious'
    ctx.remember(id, `I was in ${locationDef(locationId).name} when it happened: ${inc.text}`, def.kind === 'hull_breach' ? 5 : 3, ev.id)
    if (def.kind === 'hull_breach') {
      const dmg = int(20, 40, ctx.seed, tick, id, 'injury')
      a.health = round1(a.health - dmg)
      a.injuredUntil = tick + int(24, 48, ctx.seed, tick, id, 'recover')
      if (a.health <= 0) {
        if (s.settings.death) {
          a.alive = false
          a.health = 0
          ctx.emit({ type: 'incident', actorId: id, locationId, text: `${castMember(id).name} died in the breach.`, magnitude: 1, privateTo: null })
        } else {
          a.health = 5
        }
      }
    }
  }
}

/**
 * Where stress settles. Secrets weigh on people: a grave secret of your own
 * raises the floor, as does knowing how bad the crack really is. Low morale
 * lifts everyone's.
 */
function stressBaseline(s: WorldState, id: AgentId): number {
  const own = (f: (typeof FACTS)[number]) => f.subject === id || f.implicates?.includes(id)
  const grave = FACTS.some((f) => own(f) && f.secrecy >= 0.85 && s.knowledge[id]?.[f.id])
  const crack = s.knowledge[id]?.['f-crack'] ? Math.max(0, 75 - s.station.hull) * 0.6 : 0
  const gloom = Math.max(0, 55 - s.station.morale) * 0.4
  return 22 + (grave ? 16 : 0) + crack + gloom + (castMember(id).burden ?? 0)
}

function derivedMood(stress: number, health: number): Mood {
  if (stress >= 75) return health < 50 ? 'grim' : 'anxious'
  if (stress >= 58) return 'concerned'
  if (health < 60) return 'weary'
  if (stress <= 22) return 'content'
  return 'calm'
}

function advanceBodies(ctx: TickContext): void {
  const s = ctx.state
  const tick = ctx.tick
  for (const c of CAST) {
    const a = s.agents[c.id]!
    if (!a.alive) continue

    for (const cond of c.conditions ?? []) {
      if (a.health > cond.healthFloor) a.health = round2(Math.max(cond.healthFloor, a.health + cond.healthPerDay / 24))
    }
    const injured = a.injuredUntil !== null && a.injuredUntil > tick
    if (injured) a.health = round2(clamp(a.health + 0.8))
    else if (a.asleep && !c.conditions?.length) a.health = round2(clamp(a.health + 0.15))
    if (a.injuredUntil !== null && a.injuredUntil <= tick) a.injuredUntil = null

    const base = stressBaseline(s, c.id)
    if (a.asleep) a.stress = a.stress > base - 5 ? round2(Math.max(base - 5, a.stress - 1)) : a.stress
    else a.stress = round2(clamp(a.stress + (base - a.stress) * 0.025))
    if (s.intents.some((i) => i.agentId === c.id && i.kind === 'withhold')) a.stress = round2(clamp(a.stress + 0.3))

    const hint = ctx.moodHints[c.id]
    if (hint) {
      a.mood = hint
      a.moodTick = tick
    } else if (tick - a.moodTick >= 3) {
      a.mood = derivedMood(a.stress, a.health)
    }
  }
}
