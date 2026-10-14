import type { OutcomeId } from '../core/types.js'

/**
 * The outcome table (spec §5.2). Data, not code.
 *
 * Every encounter is between an initiator A and a responder B. For each
 * outcome:   weight = max(0, base + Σ weights[f] · features[f])
 * gated by `requires` (all must hold) and `requiresAny` (at least one).
 * One outcome is drawn by seeded weighted roll.
 *
 * Effects are deltas to the DIRECTED edges: `ab` is A's view of B, `ba` is
 * B's view of A. `knowledge` names a handler in sim/knowledge.ts.
 *
 * NOTE: no feature depends on whether an agent is LLM-backed or dormant.
 * That would make the deterministic layer depend on real-time budgets and
 * break replay (spec correction — see docs/decisions.md).
 */

export const FEATURE_KEYS = [
  'affinity', // -1..1: mean over both directions of ((trust+warmth)/2 - tension)/100
  'trust', // mean, 0..1
  'warmth',
  'tension',
  'trustAB',
  'trustBA',
  'warmthAB',
  'tensionAB',
  'tensionBA',
  'kindness', // mean, 0..1
  'kindA',
  'candour',
  'candourA',
  'ambitionA',
  'sociability',
  'stress',
  'stressA',
  'sharedCause', // 0/1
  'bothWorking', // 0/1
  'strangers', // 0/1 — no prior encounters
  // committed intents, A toward B unless noted
  'seek',
  'speak',
  'confide',
  'confront',
  'ally',
  'withhold',
  'observe',
  'avoid', // either party avoiding the other (A is the avoider)
  // knowledge
  'aHasShareable',
  'aHasGossip',
  'aHasConfided', // A holds something a third party confided
  'aHoldsSecret', // A knows something B wants, or A's own secret, that B doesn't know
  'aKnowsBSecret', // A has learned B's secret
] as const
export type FeatureKey = (typeof FEATURE_KEYS)[number]
export type Features = Record<FeatureKey, number>

export interface EdgeDelta {
  trust?: number
  warmth?: number
  tension?: number
  grudge?: number
}

export type KnowledgeHandler = 'confide' | 'gossip' | 'betray' | 'observe'

export interface OutcomeDef {
  id: OutcomeId
  base: number
  weights: Partial<Record<FeatureKey, number>>
  requires?: Partial<Record<FeatureKey, readonly [number, number]>>
  requiresAny?: Partial<Record<FeatureKey, readonly [number, number]>>
  setting?: 'romance'
  ab: EdgeDelta
  ba: EdgeDelta
  stressA?: number
  stressB?: number
  knowledge?: KnowledgeHandler
  /** 0–1; feeds wake triggers. */
  magnitude: number
  /** Can bystanders tell what happened? 'quiet' outcomes look like ordinary talk from across the room. */
  visibility: 'open' | 'quiet' | 'hidden'
  /** Can a bystander overhear the content (facts)? */
  overhearable?: boolean
  /** Does B notice? false → one-sided (observe). */
  bNotices: boolean
}

export const OUTCOMES: readonly OutcomeDef[] = [
  {
    id: 'connect',
    base: 0.18,
    weights: { affinity: 0.45, tension: -0.7, sociability: 0.25, strangers: 0.1, seek: 0.25, speak: 0.2 },
    ab: { warmth: 3, trust: 1, tension: -1 },
    ba: { warmth: 3, trust: 1, tension: -1 },
    stressA: -1,
    stressB: -1,
    magnitude: 0.2,
    visibility: 'open',
    bNotices: true,
  },
  {
    id: 'cooperate',
    base: 0,
    weights: { sharedCause: 0.12, bothWorking: 0.18, ally: 1.0, trust: 0.15 },
    ab: { trust: 4, warmth: 2, tension: -2 },
    ba: { trust: 4, warmth: 2, tension: -2 },
    stressA: -1,
    stressB: -1,
    magnitude: 0.3,
    visibility: 'open',
    bNotices: true,
  },
  {
    id: 'disagree',
    base: 0.06,
    weights: { tension: 0.6, candour: 0.25, affinity: -0.3, stress: 0.35, kindness: -0.2 },
    ab: { tension: 7, trust: -2, warmth: -1 },
    ba: { tension: 7, trust: -2, warmth: -1 },
    stressA: 4,
    stressB: 4,
    magnitude: 0.4,
    visibility: 'open',
    bNotices: true,
  },
  {
    id: 'confide',
    base: 0,
    weights: { stressA: 0.45, trustAB: 0.35, warmthAB: 0.15, confide: 1.2 },
    requires: { trustAB: [0.55, 1], aHasShareable: [1, 1] },
    ab: { trust: 4, warmth: 3, tension: -2 },
    ba: { trust: 5, warmth: 4 },
    stressA: -8,
    knowledge: 'confide',
    magnitude: 0.6,
    visibility: 'quiet',
    overhearable: true,
    bNotices: true,
  },
  {
    id: 'gossip',
    base: 0.02,
    weights: { sociability: 0.2, candourA: 0.12, kindA: -0.18, ambitionA: 0.12, trust: 0.15, speak: 0.25 },
    requires: { aHasGossip: [1, 1] },
    ab: { warmth: 1, trust: 1 },
    ba: { warmth: 2, trust: 1 },
    knowledge: 'gossip',
    magnitude: 0.45,
    visibility: 'quiet',
    overhearable: true,
    bNotices: true,
  },
  {
    id: 'withhold',
    base: 0.02,
    weights: { tensionAB: 0.3, withhold: 1.0, candourA: -0.25 },
    requires: { aHoldsSecret: [1, 1] },
    ab: {},
    ba: { tension: 3, trust: -2 },
    stressA: 4,
    magnitude: 0.35,
    visibility: 'quiet',
    bNotices: true,
  },
  {
    id: 'confront',
    base: 0,
    weights: { tensionAB: 0.7, kindA: -0.35, candourA: 0.3, confront: 1.2, aKnowsBSecret: 0.15 },
    requiresAny: { tensionAB: [0.4, 1], confront: [1, 1] },
    ab: { tension: 10, trust: -3, warmth: -4, grudge: 2 },
    ba: { tension: 12, trust: -5, warmth: -5, grudge: 5 },
    stressA: 8,
    stressB: 10,
    magnitude: 0.75,
    visibility: 'open',
    overhearable: true,
    bNotices: true,
  },
  {
    id: 'repair',
    base: 0,
    weights: { kindness: 0.55, warmth: 0.3, trust: 0.15, ally: 0.3, speak: 0.25 },
    requires: { tension: [0.2, 1] },
    ab: { tension: -12, trust: 3, warmth: 2, grudge: -4 },
    ba: { tension: -12, trust: 3, warmth: 2, grudge: -4 },
    stressA: -4,
    stressB: -4,
    magnitude: 0.5,
    visibility: 'open',
    bNotices: true,
  },
  {
    id: 'avoid',
    base: 0,
    weights: { avoid: 2.0 },
    requires: { avoid: [1, 1] },
    ab: {},
    ba: { tension: 3, trust: -1, grudge: 1 },
    magnitude: 0.3,
    visibility: 'open',
    bNotices: true,
  },
  {
    id: 'observe',
    base: 0.03,
    weights: { observe: 1.5 },
    ab: {},
    ba: {},
    knowledge: 'observe',
    magnitude: 0.2,
    visibility: 'hidden',
    bNotices: false,
  },
  {
    id: 'betray',
    base: 0,
    weights: { ambitionA: 0.12, kindA: -0.08, trustAB: 0.06 },
    requires: { aHasConfided: [1, 1], ambitionA: [0.55, 1] },
    ab: {},
    ba: { trust: 2, warmth: 1 },
    knowledge: 'betray',
    magnitude: 0.65,
    visibility: 'quiet',
    overhearable: true,
    bNotices: true,
  },
  {
    id: 'romance',
    base: 0,
    weights: { warmth: 0.3, trust: 0.2 },
    requires: { warmth: [0.7, 1], trust: [0.6, 1], tension: [0, 0.3] },
    setting: 'romance',
    ab: { warmth: 6, trust: 2 },
    ba: { warmth: 6, trust: 2 },
    magnitude: 0.7,
    visibility: 'quiet',
    bNotices: true,
  },
  {
    id: 'nothing',
    base: 0.14,
    weights: {},
    ab: {},
    ba: {},
    magnitude: 0,
    visibility: 'hidden',
    bNotices: true,
  },
]

export function outcomeDef(id: OutcomeId): OutcomeDef {
  const o = OUTCOMES.find((x) => x.id === id)
  if (!o) throw new Error(`Unknown outcome: ${id}`)
  return o
}

export function outcomeWeight(def: OutcomeDef, f: Features, romance: boolean): number {
  if (def.setting === 'romance' && !romance) return 0
  if (def.requires) {
    for (const [k, [lo, hi]] of Object.entries(def.requires) as [FeatureKey, readonly [number, number]][]) {
      if (f[k] < lo || f[k] > hi) return 0
    }
  }
  if (def.requiresAny) {
    const ok = (Object.entries(def.requiresAny) as [FeatureKey, readonly [number, number]][]).some(
      ([k, [lo, hi]]) => f[k] >= lo && f[k] <= hi,
    )
    if (!ok) return 0
  }
  let w = def.base
  for (const [k, c] of Object.entries(def.weights) as [FeatureKey, number][]) w += c * f[k]
  return Math.max(0, w)
}
