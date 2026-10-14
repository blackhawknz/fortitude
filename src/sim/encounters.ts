import type { AgentId, FactDef, IntentKind, Mood, OutcomeId, SimEvent } from '../core/types.js'
import { chance, pick, rng, weighted } from '../core/rng.js'
import { formatTime } from '../core/clock.js'
import { CAST, castMember } from '../world/cast.js'
import { locationDef } from '../world/locations.js'
import { factDef } from '../world/facts.js'
import { OUTCOMES, outcomeDef, outcomeWeight, type Features } from '../world/outcomes.js'
import type { TickContext } from './context.js'
import { affinity, applyDelta, clamp, edge, RELATIONSHIP_LABEL, round1 } from './relationships.js'
import {
  chooseFact,
  confidedFacts,
  gossipFacts,
  heldSecrets,
  knows,
  learn,
  secretsAbout,
  shareableFacts,
} from './knowledge.js'
import { fulfil } from './intents.js'
import { historyLine, narrateEncounter, topicFor } from './narrate.js'

/** A pair can't meet again within this many ticks (prevents hourly repeats). */
const PAIR_COOLDOWN = 4

const BIAS_KINDS: readonly IntentKind[] = ['seek', 'speak', 'confide', 'confront', 'ally', 'observe', 'withhold']

function intentWeight(ctx: TickContext, from: AgentId, kind: IntentKind, to: AgentId): number {
  const i = ctx.state.intents.find((x) => x.agentId === from && x.kind === kind && x.target === to)
  return i ? i.weight : 0
}

function intentBonus(ctx: TickContext, a: AgentId, b: AgentId): number {
  let bonus = 0
  for (const [x, y] of [[a, b], [b, a]] as const) {
    bonus += 0.6 * intentWeight(ctx, x, 'seek', y)
    bonus += 0.5 * intentWeight(ctx, x, 'speak', y)
    bonus += 0.4 * (intentWeight(ctx, x, 'confide', y) + intentWeight(ctx, x, 'confront', y) + intentWeight(ctx, x, 'ally', y))
    bonus += 0.3 * intentWeight(ctx, x, 'observe', y)
    // Avoiding someone in the same room is itself an encounter: both notice.
    bonus += 0.3 * intentWeight(ctx, x, 'avoid', y)
  }
  return bonus
}

export function interactionChance(ctx: TickContext, a: AgentId, b: AgentId): number {
  const s = ctx.state
  const ta = castMember(a).traits
  const tb = castMember(b).traits
  let p =
    s.settings.encounterBase +
    ta.sociability / 400 +
    tb.sociability / 400 +
    (affinity(s, a, b) * 100) / 300 -
    s.agents[a]!.stress / 500 -
    s.agents[b]!.stress / 500 +
    intentBonus(ctx, a, b)
  if (s.locations[s.agents[a]!.locationId]!.dark) p *= 0.35
  return Math.max(0, Math.min(0.95, p))
}

/** Who drives the encounter: avoiders first, then whoever wants something, then the more sociable. */
function chooseInitiator(ctx: TickContext, x: AgentId, y: AgentId): [AgentId, AgentId] {
  const drive = (from: AgentId, to: AgentId) =>
    2 * intentWeight(ctx, from, 'avoid', to) + BIAS_KINDS.reduce((sum, k) => sum + intentWeight(ctx, from, k, to), 0)
  const dx = drive(x, y)
  const dy = drive(y, x)
  if (dx !== dy) return dx > dy ? [x, y] : [y, x]
  const sx = castMember(x).traits.sociability
  const sy = castMember(y).traits.sociability
  if (sx !== sy) return sx > sy ? [x, y] : [y, x]
  return rng(ctx.seed, ctx.tick, x, y, 'init') < 0.5 ? [x, y] : [y, x]
}

export function pairFeatures(ctx: TickContext, a: AgentId, b: AgentId): Features {
  const s = ctx.state
  const ab = edge(s, a, b)
  const ba = edge(s, b, a)
  const ca = castMember(a)
  const cb = castMember(b)
  const ta = ca.traits
  const tb = cb.traits
  const sa = s.agents[a]!
  const sb = s.agents[b]!
  const flag = (k: IntentKind) => (intentWeight(ctx, a, k, b) > 0 ? 1 : 0)
  return {
    affinity: affinity(s, a, b),
    trust: (ab.trust + ba.trust) / 200,
    warmth: (ab.warmth + ba.warmth) / 200,
    tension: (ab.tension + ba.tension) / 200,
    trustAB: ab.trust / 100,
    trustBA: ba.trust / 100,
    warmthAB: ab.warmth / 100,
    tensionAB: ab.tension / 100,
    tensionBA: ba.tension / 100,
    kindness: (ta.kindness + tb.kindness) / 200,
    kindA: ta.kindness / 100,
    candour: (ta.candour + tb.candour) / 200,
    candourA: ta.candour / 100,
    ambitionA: ta.ambition / 100,
    sociability: (ta.sociability + tb.sociability) / 200,
    stress: (sa.stress + sb.stress) / 200,
    stressA: sa.stress / 100,
    sharedCause: ca.causes.some((c) => cb.causes.includes(c)) ? 1 : 0,
    bothWorking: sa.working && sb.working ? 1 : 0,
    strangers: ab.encounters === 0 ? 1 : 0,
    seek: flag('seek'),
    speak: flag('speak'),
    confide: flag('confide'),
    confront: flag('confront'),
    ally: flag('ally'),
    withhold: flag('withhold'),
    observe: flag('observe'),
    avoid: intentWeight(ctx, a, 'avoid', b) > 0 || intentWeight(ctx, b, 'avoid', a) > 0 ? 1 : 0,
    aHasShareable: shareableFacts(s, a, b).length ? 1 : 0,
    aHasGossip: gossipFacts(s, a, b).length ? 1 : 0,
    aHasConfided: confidedFacts(s, a, b).length ? 1 : 0,
    aHoldsSecret: heldSecrets(s, a, b).length ? 1 : 0,
    aKnowsBSecret: secretsAbout(s, a, b).length ? 1 : 0,
  }
}

export function chooseOutcome(ctx: TickContext, a: AgentId, b: AgentId, f: Features): OutcomeId {
  const romance = ctx.state.settings.romance
  const entries = OUTCOMES.map((o) => [o.id, outcomeWeight(o, f, romance)] as const)
  return weighted(entries, ctx.seed, ctx.tick, a, b, 'outcome') ?? 'nothing'
}

function moodFor(outcome: OutcomeId, initiator: boolean): Mood | undefined {
  switch (outcome) {
    case 'connect':
    case 'repair':
      return 'warm'
    case 'cooperate':
      return 'content'
    case 'disagree':
    case 'confront':
      return 'irritable'
    case 'confide':
      return initiator ? 'calm' : 'concerned'
    case 'withhold':
      return initiator ? 'guarded' : 'concerned'
    case 'betray':
      return initiator ? 'guarded' : undefined
    case 'avoid':
      return initiator ? 'guarded' : 'concerned'
    default:
      return undefined
  }
}

/** PHASE 4. Pair co-located agents, roll, resolve each encounter to exactly one outcome. */
export function resolveEncounters(ctx: TickContext): void {
  const s = ctx.state
  const byPlace = new Map<string, AgentId[]>()
  for (const c of CAST) {
    const a = s.agents[c.id]!
    if (!a.alive || a.asleep) continue
    const list = byPlace.get(a.locationId) ?? []
    list.push(c.id)
    byPlace.set(a.locationId, list)
  }

  const candidates: { a: AgentId; b: AgentId; p: number }[] = []
  for (const [, ids] of [...byPlace.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) {
    ids.sort()
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const x = ids[i]!
        const y = ids[j]!
        const last = edge(s, x, y).lastTick
        if (last !== null && ctx.tick - last < PAIR_COOLDOWN) continue
        const p = interactionChance(ctx, x, y)
        if (rng(ctx.seed, ctx.tick, x, y, 'meet') < p) candidates.push({ a: x, b: y, p })
      }
    }
  }
  candidates.sort((u, v) => v.p - u.p || (u.a + u.b < v.a + v.b ? -1 : 1))

  const busy = new Set<AgentId>()
  for (const { a: x, b: y } of candidates) {
    if (busy.has(x) || busy.has(y)) continue
    busy.add(x)
    busy.add(y)
    const [a, b] = chooseInitiator(ctx, x, y)
    resolvePair(ctx, a, b, byPlace.get(s.agents[a]!.locationId) ?? [])
  }
}

function resolvePair(ctx: TickContext, a: AgentId, b: AgentId, present: AgentId[]): void {
  const s = ctx.state
  const tick = ctx.tick
  const seed = ctx.seed
  const features = pairFeatures(ctx, a, b)
  let outcome = chooseOutcome(ctx, a, b, features)
  const def = () => outcomeDef(outcome)
  const locationId = s.agents[a]!.locationId
  const place = locationDef(locationId).name
  const bystanders = present.filter((p) => p !== a && p !== b)

  // ── Knowledge transfer ────────────────────────────────────────────────
  let fact: FactDef | undefined
  let victim: AgentId | undefined
  if (outcome === 'confide') {
    fact = chooseFact(shareableFacts(s, a, b), a, b, 'confide', seed, tick, a, b, 'fact')
  } else if (outcome === 'gossip') {
    fact = chooseFact(gossipFacts(s, a, b), a, b, 'gossip', seed, tick, a, b, 'fact')
  } else if (outcome === 'betray') {
    const options = confidedFacts(s, a, b)
    if (options.length) {
      const choice = pick(options, seed, tick, a, b, 'betray')
      fact = choice.fact
      victim = choice.victim
    }
  }
  if ((outcome === 'confide' || outcome === 'gossip' || outcome === 'betray') && !fact) outcome = 'connect'

  if (outcome === 'nothing') return

  // Topic: the fact if one changes hands; for confrontations, a secret A has
  // learned about B (both already know it; bystanders hear only the topic).
  // A WITHHELD secret is never named — B must not learn its topic from the text.
  let topic = topicFor(a, b, seed, tick, a, b)
  if (fact) topic = fact.topic
  else if (outcome === 'confront') {
    const secret = secretsAbout(s, a, b)[0]
    if (secret) topic = secret.topic
  }

  const o = def()
  if (fact) learn(s, b, fact.id, { kind: 'told', by: a, tick, confided: outcome === 'confide' }, tick)
  if (outcome === 'betray' && fact && victim) {
    s.betrayals.push({ id: `b${tick}.${a}.${b}`, betrayer: a, victim, listener: b, fact: fact.id, tick, discovered: false })
  }

  // Overhearing: quiet talk can still carry.
  const overheard: AgentId[] = []
  if (o.overhearable) {
    for (const w of bystanders) {
      const p = 0.02 + (castMember(w).traits.perception / 100) * 0.16
      if (!chance(p, seed, tick, a, b, w, 'overhear')) continue
      overheard.push(w)
      if (fact) learn(s, w, fact.id, { kind: 'overheard', from: a, tick }, tick)
    }
  }

  // Observation can surface a hidden condition.
  if (outcome === 'observe') {
    for (const cond of castMember(b).conditions ?? []) {
      if (!cond.evidenceFact || s.agents[b]!.health >= (cond.noticeableBelow ?? 0)) continue
      const medic = castMember(a).work === 'medbay' ? 0.3 : 0
      if (chance(castMember(a).traits.perception / 200 + medic, seed, tick, a, b, cond.id)) {
        if (learn(s, a, cond.evidenceFact, { kind: 'observed', subject: b, tick }, tick)) fact = factDef(cond.evidenceFact)
      }
    }
  }

  // ── Event ─────────────────────────────────────────────────────────────
  const text = narrateEncounter(outcome, { a, b, place, topic, fact: fact?.text, victim }, seed, tick, a, b)
  const privateTo =
    o.visibility === 'open' ? [a, b, ...bystanders] : o.visibility === 'quiet' ? [a, b, ...overheard] : o.bNotices ? [a, b] : [a]
  const ev = ctx.emit({
    type: 'encounter',
    actorId: a,
    targetId: b,
    locationId,
    outcome,
    text,
    magnitude: o.magnitude,
    privateTo: [...new Set(privateTo)].sort(),
    data: { bystanders, overheard, fact: fact?.id, victim, topic },
  })

  // ── Relationship + stress deltas ──────────────────────────────────────
  const stamp = `${formatTime(tick)} — ${place}: `
  const milestones: [AgentId, AgentId, string, string][] = []
  const ab = edge(s, a, b)
  const ba = edge(s, b, a)
  const prevAB = applyDelta(ab, o.ab, tick, stamp + historyLine(outcome, a, b, true, topic))
  if (prevAB) milestones.push([a, b, prevAB, ab.type])
  if (o.bNotices) {
    const prevBA = applyDelta(ba, o.ba, tick, stamp + historyLine(outcome, b, a, false, topic))
    if (prevBA) milestones.push([b, a, prevBA, ba.type])
  }
  const sa = s.agents[a]!
  const sb = s.agents[b]!
  if (o.stressA) sa.stress = round1(clamp(sa.stress + o.stressA))
  if (o.stressB && o.bNotices) sb.stress = round1(clamp(sb.stress + o.stressB))
  const ma = moodFor(outcome, true)
  const mb = o.bNotices ? moodFor(outcome, false) : undefined
  if (ma) ctx.moodHints[a] = ma
  if (mb) ctx.moodHints[b] = mb

  // ── Memory ────────────────────────────────────────────────────────────
  const imp = 1 + o.magnitude * 4
  ctx.remember(a, historyLine(outcome, a, b, true, topic) + (fact && outcome !== 'observe' ? ` (“${fact.text}”)` : ''), imp, ev.id)
  if (outcome === 'observe' && fact) ctx.remember(a, `Watching ${castMember(b).name}, I noticed: ${fact.text}`, 4, ev.id)
  if (o.bNotices) ctx.remember(b, historyLine(outcome, b, a, false, topic) + (fact ? ` (“${fact.text}”)` : ''), imp, ev.id)
  for (const w of overheard) {
    if (fact) ctx.remember(w, `Overheard ${castMember(a).name} telling ${castMember(b).name}: “${fact.text}”`, 4, ev.id)
  }

  // ── Intents satisfied by meeting ─────────────────────────────────────
  for (const i of [...s.intents]) {
    if (i.agentId === a && i.target === b && ['seek', 'speak', 'confide', 'confront', 'ally'].includes(i.kind)) fulfil(s, i.id, ctx.intentChanges)
    if (i.agentId === b && i.target === a && ['seek', 'speak'].includes(i.kind)) fulfil(s, i.id, ctx.intentChanges)
    if (i.agentId === a && i.target === b && i.kind === 'observe' && outcome === 'observe') fulfil(s, i.id, ctx.intentChanges)
  }

  // ── Milestones: one side's feelings crossed a band. Private to that side. ──
  for (const [from, to, before, after] of milestones) {
    ctx.emit({
      type: 'milestone',
      actorId: from,
      targetId: to,
      locationId,
      text: `${castMember(from).name} no longer thinks of ${castMember(to).name} the same way: ${RELATIONSHIP_LABEL[before as keyof typeof RELATIONSHIP_LABEL]} → ${RELATIONSHIP_LABEL[after as keyof typeof RELATIONSHIP_LABEL]}.`,
      magnitude: 0.6,
      privateTo: [from],
      data: { before, after },
    })
  }

  if (outcome !== 'avoid' && outcome !== 'observe') {
    discoverBetrayals(ctx, a, b, ev)
    noticeExposure(ctx, a, b)
    noticeExposure(ctx, b, a)
  }
}

/** A victim talking to the listener of a betrayal may realise what happened. */
function discoverBetrayals(ctx: TickContext, a: AgentId, b: AgentId, cause: SimEvent): void {
  const s = ctx.state
  for (const bt of s.betrayals) {
    if (bt.discovered) continue
    const pairMatch = (bt.victim === a && bt.listener === b) || (bt.victim === b && bt.listener === a)
    if (!pairMatch) continue
    const p = 0.2 + (castMember(bt.victim).traits.perception / 100) * 0.25
    if (!chance(p, ctx.seed, ctx.tick, bt.id, 'discover')) continue
    bt.discovered = true
    const e = edge(s, bt.victim, bt.betrayer)
    const before = applyDelta(e, { trust: -30, warmth: -15, tension: 25, grudge: 35 }, ctx.tick, null)
    s.agents[bt.victim]!.stress = round1(clamp(s.agents[bt.victim]!.stress + 12))
    ctx.moodHints[bt.victim] = 'grim'
    const v = castMember(bt.victim).name
    const ev = ctx.emit({
      type: 'betrayal_discovered',
      actorId: bt.victim,
      targetId: bt.betrayer,
      locationId: s.agents[a]!.locationId,
      text: `${v} realised ${castMember(bt.listener).name} knew what ${v} had told ${castMember(bt.betrayer).name} in confidence. ${castMember(bt.betrayer).name} had passed it on.`,
      magnitude: 0.85,
      privateTo: [bt.victim],
      data: { betrayal: bt.id, fact: bt.fact, cause: cause.id, relationshipBefore: before },
    })
    ctx.remember(bt.victim, `${castMember(bt.betrayer).name} passed on what I told them in confidence. ${castMember(bt.listener).name} knows.`, 5, ev.id)
  }
}

/** A subject may notice that someone knows their secret. */
function noticeExposure(ctx: TickContext, subject: AgentId, knower: AgentId): void {
  const s = ctx.state
  for (const f of secretsAbout(s, knower, subject)) {
    if (f.secrecy < 0.5) continue
    const k = s.knowledge[knower]![f.id]!
    if (k.source.kind === 'self' || (k.source.kind === 'told' && k.source.by === subject)) continue
    const key = `${subject}:${knower}:${f.id}`
    if (s.exposures.includes(key)) continue
    const p = (castMember(subject).traits.perception / 100) * 0.2
    if (!chance(p, ctx.seed, ctx.tick, key, 'expose')) continue
    s.exposures.push(key)
    const st = s.agents[subject]!
    st.stress = round1(clamp(st.stress + 10))
    applyDelta(edge(s, subject, knower), { tension: 6 }, ctx.tick, null)
    ctx.moodHints[subject] = 'anxious'
    const ev = ctx.emit({
      type: 'discovery',
      actorId: subject,
      targetId: knower,
      locationId: st.locationId,
      text: `Something in how ${castMember(knower).name} spoke told ${castMember(subject).name} they know: “${f.text}”`,
      magnitude: 0.7,
      privateTo: [subject],
      data: { fact: f.id, exposure: true },
    })
    ctx.remember(subject, `${castMember(knower).name} knows. (“${f.text}”) I don't know who told them.`, 5, ev.id)
    if (!knows(s, subject, f.id)) learn(s, subject, f.id, { kind: 'self' }, ctx.tick)
  }
}
