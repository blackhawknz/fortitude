import type { AgentId, FactDef, FactId, KnowledgeSource, Tick, WorldState } from '../core/types.js'
import { weighted } from '../core/rng.js'
import { FACTS, factDef } from '../world/facts.js'
import { allGoals, castMember } from '../world/cast.js'
import { applyDelta, edge } from './relationships.js'

export function knows(state: WorldState, agent: AgentId, fact: FactId): boolean {
  return !!state.knowledge[agent]?.[fact]
}

/**
 * Returns true if the agent learned something new. Learning a fact about
 * someone quietly changes how you see them (and, at half strength, anyone it
 * implicates). They don't know.
 */
export function learn(state: WorldState, agent: AgentId, fact: FactId, source: KnowledgeSource, tick: Tick): boolean {
  const k = (state.knowledge[agent] ??= {})
  if (k[fact]) return false
  k[fact] = { fact, source, tick }
  const f = factDef(fact)
  const shift = (who: AgentId, strength: number) => {
    if (who === agent || !state.edges[`${agent}>${who}`]) return
    const v = f.valence * strength
    const d = v < 0 ? { trust: 12 * v, tension: -16 * v, grudge: -18 * v } : { warmth: 8 * v, trust: 3 * v }
    applyDelta(edge(state, agent, who), d, tick, null)
  }
  if (f.subject && f.valence !== 0) shift(f.subject, 1)
  for (const who of f.implicates ?? []) if (f.valence !== 0) shift(who, 0.5)
  return true
}

export function knowersOf(state: WorldState, fact: FactId): AgentId[] {
  return Object.keys(state.knowledge)
    .filter((a) => state.knowledge[a]![fact])
    .sort()
}

function wantedBy(agent: AgentId, fact: FactId): boolean {
  return allGoals(castMember(agent)).some((g) => g.kind === 'learn' && g.facts.includes(fact))
}

/** Facts `a` could confide to `b`: B doesn't know them, not B's own secret, secrecy within what trust allows. */
export function shareableFacts(state: WorldState, a: AgentId, b: AgentId): FactDef[] {
  const trust = edge(state, a, b).trust / 100
  const stress = state.agents[a]!.stress / 100
  const candour = castMember(a).traits.candour / 100
  const threshold = 0.15 + trust * 0.55 + stress * 0.15 + candour * 0.15
  return FACTS.filter((f) => {
    if (!knows(state, a, f.id) || knows(state, b, f.id)) return false
    if (f.subject === b) return false
    const penalty = f.subject === a || f.implicates?.includes(a) ? 0.08 : 0
    return f.secrecy + penalty <= threshold
  })
}

/** Would passing this on compromise the speaker? */
function compromises(f: FactDef, speaker: AgentId): boolean {
  return f.subject === speaker || !!f.implicates?.includes(speaker)
}

/** Facts about a third party that `a` is willing to pass on to `b`. */
export function gossipFacts(state: WorldState, a: AgentId, b: AgentId): FactDef[] {
  const t = castMember(a).traits
  const threshold = 0.4 + (1 - t.kindness / 100) * 0.3 + (t.ambition / 100) * 0.2 + (t.candour / 100) * 0.1
  return FACTS.filter(
    (f) =>
      f.subject !== undefined &&
      !compromises(f, a) &&
      f.subject !== b &&
      knows(state, a, f.id) &&
      !knows(state, b, f.id) &&
      // Nobody gossips what they were told in confidence — that's betrayal, handled separately.
      !isConfidedTo(state, a, f.id) &&
      f.secrecy <= threshold,
  )
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
    if (fact.subject === b || compromises(fact, a)) continue
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
      (f.subject === a || wantedBy(b, f.id)),
  )
}

/** Facts whose subject is `b` that `a` knows. */
export function secretsAbout(state: WorldState, a: AgentId, b: AgentId): FactDef[] {
  return FACTS.filter((f) => f.subject === b && knows(state, a, f.id))
}

/**
 * Weighted choice of a fact to pass on. Confiding favours your own burdens —
 * that's what confiding is. Gossip favours what's juicy but sayable.
 * Either way, what the listener is hunting for is more likely to come up.
 */
export function chooseFact(
  facts: FactDef[],
  speaker: AgentId,
  listener: AgentId,
  mode: 'confide' | 'gossip',
  seed: string,
  ...keys: (string | number)[]
): FactDef | undefined {
  return weighted(
    facts.map((f) => {
      const base = mode === 'confide' ? 0.3 + f.secrecy + (compromises(f, speaker) ? 0.6 : 0) : 0.4 + f.secrecy * 0.6
      return [f, base + (wantedBy(listener, f.id) ? 0.8 : 0)] as const
    }),
    seed,
    ...keys,
  )
}
