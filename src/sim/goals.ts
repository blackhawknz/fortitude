import type { AgentId, FactId, WorldState } from '../core/types.js'
import { CAST, allGoals, castMember } from '../world/cast.js'
import { FACTS } from '../world/facts.js'
import type { TickContext } from './context.js'
import { believersAboutSubject, knows, knowsTruth } from './knowledge.js'

const initialKnowers = new Map<FactId, Set<AgentId>>()
for (const c of CAST) for (const k of c.knows) (initialKnowers.get(k.fact) ?? initialKnowers.set(k.fact, new Set()).get(k.fact)!).add(c.id)

/** Deterministic goal progress, 0–1. Sim-owned; agents keep their own beliefs about it separately. */
function progress(s: WorldState, agentId: AgentId, goalId: string): number {
  const g = allGoals(castMember(agentId)).find((x) => x.id === goalId)
  if (!g) return 0
  switch (g.kind) {
    case 'learn':
      // Only the truth counts. A rumour of it is not progress.
      return g.facts.filter((f) => knowsTruth(s, agentId, f)).length / g.facts.length
    case 'conceal': {
      const start = initialKnowers.get(g.fact)?.size ?? 1
      // A rumour that blames someone else doesn't expose you.
      const spread = believersAboutSubject(s, g.fact).length - start
      return Math.max(0, 1 - spread / Math.max(1, CAST.length - start))
    }
    case 'maintain':
      return (g.subsystem === 'morale' ? s.station.morale : s.station[g.subsystem]) / 100
    case 'bond': {
      const e = s.edges[`${g.target}>${agentId}`]
      return e ? (e.warmth + e.trust) / 200 : 0
    }
    case 'spread':
      return FACTS.filter((f) => knows(s, agentId, f.id)).length / FACTS.length
    case 'tell':
      return CAST.some((c) => {
        const k = s.knowledge[c.id]?.[g.fact]
        return k?.source.kind === 'told' && k.source.by === agentId && k.source.confided
      })
        ? 1
        : 0
  }
}

/** Set progress without emitting anything (world creation). */
export function initGoals(s: WorldState): void {
  for (const c of CAST) for (const g of s.agents[c.id]!.goals) g.progress = Math.round(progress(s, c.id, g.id) * 1000) / 1000
}

/** Update every goal's progress; emit a private goal event on significant jumps. */
export function updateGoals(ctx: TickContext): void {
  const s = ctx.state
  for (const c of CAST) {
    const a = s.agents[c.id]!
    for (const g of a.goals) {
      const before = g.progress
      const after = Math.round(progress(s, c.id, g.id) * 1000) / 1000
      g.progress = after
      if (Math.abs(after - before) >= 0.15 && ctx.tick > 0) {
        const def = allGoals(c).find((x) => x.id === g.id)!
        if (def.kind === 'maintain') continue // continuous; incidents carry that signal
        ctx.emit({
          type: 'discovery',
          actorId: c.id,
          text:
            after > before
              ? `${c.name} is closer to it now: ${g.text.toLowerCase()}.`
              : `${c.name}'s hold on it slipped: ${g.text.toLowerCase()}.`,
          magnitude: 0.6,
          privateTo: [c.id],
          data: { goal: g.id, before, after },
        })
      }
    }
  }
}
