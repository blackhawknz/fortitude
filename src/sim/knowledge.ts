import type { AgentId, FactDef, FactId, KnowledgeSource, Tick, WorldState } from '../core/types.js'
import { chance, rng, weighted } from '../core/rng.js'
import { FACTS, factDef, factVersion } from '../world/facts.js'
import { allGoals, castMember } from '../world/cast.js'
import { applyDelta, edge } from './relationships.js'

/**
 * Knowledge: who holds which facts, how they came by them, and — since
 * Phase 5 — which VERSION they believe. A version > 0 is a rumour variant
 * (FactDef.rumours): garbled in the telling, possibly about the wrong
 * person. Everything that depends on "who is this about" uses the holder's
 * believed version, so a rumour that blames Sera makes people resent Sera.
 */

export function knows(state: WorldState, agent: AgentId, fact: FactId): boolean {
  return !!state.knowledge[agent]?.[fact]
}

/** Knows the actual truth, not a rumour of it. */
export function knowsTruth(state: WorldState, agent: AgentId, fact: FactId): boolean {
  const k = state.knowledge[agent]?.[fact]
  return !!k && !k.version
}

export function versionOf(state: WorldState, agent: AgentId, fact: FactId): number {
  return state.knowledge[agent]?.[fact]?.version ?? 0
}

/** The fact as `agent` believes it: text, subject, valence. */
export function believed(state: WorldState, agent: AgentId, fact: FactId) {
  return factVersion(fact, versionOf(state, agent, fact))
}

/** Who `agent` believes the fact is about. */
export function subjectFor(state: WorldState, agent: AgentId, f: FactDef): AgentId | undefined {
  return believed(state, agent, f.id).subject
}

export interface LearnOptions {
  version?: number
  hops?: number
}

/**
 * Returns true if the agent learned something new — including the truth
 * replacing a rumour they held. Learning a fact about someone quietly
 * changes how you see them (and, at half strength, anyone the truth
 * implicates). They don't know.
 */
export function learn(state: WorldState, agent: AgentId, fact: FactId, source: KnowledgeSource, tick: Tick, opts: LearnOptions = {}): boolean {
  const k = (state.knowledge[agent] ??= {})
  const version = opts.version ?? 0
  const existing = k[fact]
  if (existing) {
    // Only the truth can displace a rumour. Rumours never overwrite anything.
    if (!existing.version || version !== 0) return false
    k[fact] = { fact, source, tick, version: 0, hops: opts.hops ?? 0 }
    shiftOpinions(state, agent, fact, 0, tick, existing.version)
    return true
  }
  k[fact] = { fact, source, tick, ...(version ? { version } : {}), ...(opts.hops ? { hops: opts.hops } : {}) }
  shiftOpinions(state, agent, fact, version, tick)
  return true
}

function shiftOpinions(state: WorldState, agent: AgentId, fact: FactId, version: number, tick: Tick, previousVersion?: number): void {
  const v = factVersion(fact, version)
  const prev = previousVersion !== undefined ? factVersion(fact, previousVersion) : null
  const shift = (who: AgentId, strength: number) => {
    if (who === agent || !state.edges[`${agent}>${who}`]) return
    const val = v.valence * strength
    const d = val < 0 ? { trust: 12 * val, tension: -16 * val, grudge: -18 * val } : { warmth: 8 * val, trust: 3 * val }
    applyDelta(edge(state, agent, who), d, tick, null)
  }
  // Learning the truth about someone you'd already judged on the rumour doesn't hit twice.
  if (v.subject && v.valence !== 0 && !(prev && prev.subject === v.subject)) shift(v.subject, 1)
  if (v.true) for (const who of factDef(fact).implicates ?? []) if (v.valence !== 0) shift(who, 0.5)
}

/**
 * How a fact sounds when `from` passes it to someone. Confidences and
 * evidence are exact. Gossip garbles — more with every mouth it has passed
 * through, less from candid tellers. A teller who believes a rumour passes
 * the rumour on.
 */
export function telling(
  state: WorldState,
  from: AgentId,
  fact: FactId,
  mode: 'confide' | 'gossip' | 'betray' | 'speech',
  seed: string,
  ...keys: (string | number)[]
): Required<LearnOptions> {
  const k = state.knowledge[from]?.[fact]
  const hops = (k?.hops ?? 0) + 1
  const held = k?.version ?? 0
  const rumours = factDef(fact).rumours ?? []
  if (held !== 0 || mode === 'confide' || mode === 'speech' || !rumours.length) return { version: held, hops }
  const candour = castMember(from).traits.candour / 100
  // ~20–25% garbled on the first retelling, rising with every mouth; candid tellers garble less.
  const p = Math.min(0.6, 0.25 + 0.12 * (hops - 1)) * (1.3 - candour)
  if (!chance(p, seed, ...keys, 'distort')) return { version: 0, hops }
  return { version: 1 + Math.floor(rng(seed, ...keys, 'variant') * rumours.length), hops }
}

export function knowersOf(state: WorldState, fact: FactId): AgentId[] {
  return Object.keys(state.knowledge)
    .filter((a) => state.knowledge[a]![fact])
    .sort()
}

/** Holders who believe it about the actual subject (truth, or a rumour that still names them). */
export function believersAboutSubject(state: WorldState, fact: FactId): AgentId[] {
  const subject = factDef(fact).subject
  return knowersOf(state, fact).filter((a) => believed(state, a, fact).subject === subject)
}

function wantedBy(agent: AgentId, fact: FactId): boolean {
  return allGoals(castMember(agent)).some((g) => g.kind === 'learn' && g.facts.includes(fact))
}

/** Would passing this on compromise the speaker (as they understand it)? */
function compromises(state: WorldState, f: FactDef, speaker: AgentId): boolean {
  const b = believed(state, speaker, f.id)
  return b.subject === speaker || (b.true && !!f.implicates?.includes(speaker))
}

/** Facts `a` could confide to `b`: B doesn't know them, not (as A believes) B's own secret, secrecy within what trust allows. */
export function shareableFacts(state: WorldState, a: AgentId, b: AgentId): FactDef[] {
  const trust = edge(state, a, b).trust / 100
  const stress = state.agents[a]!.stress / 100
  const candour = castMember(a).traits.candour / 100
  const threshold = 0.15 + trust * 0.55 + stress * 0.15 + candour * 0.15
  return FACTS.filter((f) => {
    if (!knows(state, a, f.id) || knows(state, b, f.id)) return false
    if (subjectFor(state, a, f) === b) return false
    const penalty = compromises(state, f, a) ? 0.08 : 0
    return f.secrecy + penalty <= threshold
  })
}

/** Facts about a third party that `a` is willing to pass on to `b`. */
export function gossipFacts(state: WorldState, a: AgentId, b: AgentId): FactDef[] {
  const t = castMember(a).traits
  const threshold = 0.4 + (1 - t.kindness / 100) * 0.3 + (t.ambition / 100) * 0.2 + (t.candour / 100) * 0.1
  return FACTS.filter((f) => {
    if (!knows(state, a, f.id) || knows(state, b, f.id)) return false
    const subject = subjectFor(state, a, f)
    return (
      subject !== undefined &&
      subject !== b &&
      !compromises(state, f, a) &&
      // Nobody gossips what they were told in confidence — that's betrayal, handled separately.
      !isConfidedTo(state, a, f.id) &&
      f.secrecy <= threshold
    )
  })
}

export function isConfidedTo(state: WorldState, a: AgentId, fact: FactId): boolean {
  const k = state.knowledge[a]?.[fact]
  return !!k && k.source.kind === 'told' && k.source.confided
}

/** Betrayal needs low trust in the person whose confidence is broken (spec §5.2). */
export const BETRAYAL_MAX_TRUST = 45

/** Facts confided to `a` by someone other than `b`, that `b` doesn't know, by someone `a` doesn't much trust. */
export function confidedFacts(state: WorldState, a: AgentId, b: AgentId): { fact: FactDef; victim: AgentId }[] {
  const out: { fact: FactDef; victim: AgentId }[] = []
  for (const k of Object.values(state.knowledge[a] ?? {})) {
    if (k.source.kind !== 'told' || !k.source.confided) continue
    const victim = k.source.by
    if (victim === b || knows(state, b, k.fact)) continue
    if (edge(state, a, victim).trust > BETRAYAL_MAX_TRUST) continue
    const fact = factDef(k.fact)
    if (subjectFor(state, a, fact) === b || compromises(state, fact, a)) continue
    out.push({ fact, victim })
  }
  return out.sort((x, y) => (x.fact.id < y.fact.id ? -1 : 1))
}

/** Something `a` is sitting on that `b` would want: a's own secret, or a fact b is hunting. */
export function heldSecrets(state: WorldState, a: AgentId, b: AgentId): FactDef[] {
  return FACTS.filter(
    (f) =>
      knows(state, a, f.id) &&
      !knows(state, b, f.id) &&
      f.secrecy >= 0.5 &&
      (subjectFor(state, a, f) === a || wantedBy(b, f.id)),
  )
}

/** Facts `a` holds that (as `a` believes) are about `b`. */
export function secretsAbout(state: WorldState, a: AgentId, b: AgentId): FactDef[] {
  return FACTS.filter((f) => knows(state, a, f.id) && subjectFor(state, a, f) === b)
}

/**
 * Weighted choice of a fact to pass on. Confiding favours your own burdens —
 * that's what confiding is. Gossip favours what's juicy but sayable.
 * Either way, what the listener is hunting for is more likely to come up.
 */
export function chooseFact(
  state: WorldState,
  facts: FactDef[],
  speaker: AgentId,
  listener: AgentId,
  mode: 'confide' | 'gossip',
  seed: string,
  ...keys: (string | number)[]
): FactDef | undefined {
  return weighted(
    facts.map((f) => {
      const base = mode === 'confide' ? 0.3 + f.secrecy + (compromises(state, f, speaker) ? 0.6 : 0) : 0.4 + f.secrecy * 0.6
      return [f, base + (wantedBy(listener, f.id) ? 0.8 : 0)] as const
    }),
    seed,
    ...keys,
  )
}
