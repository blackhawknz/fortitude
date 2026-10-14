import type { AgentId, Priority } from '../core/types.js'

/**
 * Attention budget (spec §4.2, corrected).
 *
 * Two kinds of limit:
 *  - IN-WORLD: turns per agent per in-world day. This is the design budget —
 *    it shapes how often a character thinks, independent of tick speed.
 *  - REAL-TIME: turns per agent per real hour, and a station-wide ceiling per
 *    real hour. These are COST ceilings only.
 *
 * At fast tick speeds the real-time ceiling binds first. When the global
 * window is contended, low-urgency turns (routine, drift) are refused first,
 * then minor characters, then majors. The Queen is refused last.
 *
 * Budgets gate LLM turns only. They never touch the deterministic layer.
 */

export interface AgentBudget {
  turnsPerInWorldDay: number
  turnsPerRealHour: number
  priority: Priority
}

export const DEFAULT_BUDGETS: Record<Priority, AgentBudget> = {
  queen: { turnsPerInWorldDay: 16, turnsPerRealHour: 60, priority: 'queen' },
  major: { turnsPerInWorldDay: 12, turnsPerRealHour: 40, priority: 'major' },
  minor: { turnsPerInWorldDay: 6, turnsPerRealHour: 20, priority: 'minor' },
}

export const DEFAULT_GLOBAL_PER_REAL_HOUR = 300

/** Minimum urgency needed under contention (global window ≥ 80% used). */
const CONTENDED_FLOOR: Record<Priority, number> = { queen: 0.3, major: 0.5, minor: 0.8 }

const HOUR_MS = 3_600_000

export type BudgetDecision = { ok: true } | { ok: false; reason: string }

export class BudgetLedger {
  private global: number[] = []
  private perAgentReal = new Map<AgentId, number[]>()
  private perAgentDay = new Map<AgentId, { day: number; n: number }>()

  constructor(
    private readonly budgets: Record<AgentId, AgentBudget>,
    private readonly globalPerRealHour = DEFAULT_GLOBAL_PER_REAL_HOUR,
    private readonly now: () => number = Date.now,
  ) {}

  private prune(list: number[], t: number): number[] {
    while (list.length && list[0]! <= t - HOUR_MS) list.shift()
    return list
  }

  check(agentId: AgentId, inWorldDay: number, urgency: number): BudgetDecision {
    const b = this.budgets[agentId]
    if (!b) return { ok: false, reason: 'agent has no budget' }
    const t = this.now()
    const day = this.perAgentDay.get(agentId)
    const usedToday = day && day.day === inWorldDay ? day.n : 0
    if (usedToday >= b.turnsPerInWorldDay) return { ok: false, reason: `in-world daily budget spent (${usedToday}/${b.turnsPerInWorldDay})` }
    const mine = this.prune(this.perAgentReal.get(agentId) ?? [], t)
    if (mine.length >= b.turnsPerRealHour) return { ok: false, reason: `per-agent real-hour cap (${b.turnsPerRealHour})` }
    const g = this.prune(this.global, t)
    if (g.length >= this.globalPerRealHour) return { ok: false, reason: `global cap (${this.globalPerRealHour}/h)` }
    if (g.length >= this.globalPerRealHour * 0.8 && urgency < CONTENDED_FLOOR[b.priority]) {
      return { ok: false, reason: `contended: ${b.priority} needs urgency ≥ ${CONTENDED_FLOOR[b.priority]}` }
    }
    return { ok: true }
  }

  spend(agentId: AgentId, inWorldDay: number): void {
    const t = this.now()
    this.global.push(t)
    const mine = this.perAgentReal.get(agentId) ?? []
    mine.push(t)
    this.perAgentReal.set(agentId, mine)
    const day = this.perAgentDay.get(agentId)
    this.perAgentDay.set(agentId, day && day.day === inWorldDay ? { day: inWorldDay, n: day.n + 1 } : { day: inWorldDay, n: 1 })
  }

  usage(): { globalLastHour: number; perAgentToday: Record<AgentId, number> } {
    const t = this.now()
    return {
      globalLastHour: this.prune(this.global, t).length,
      perAgentToday: Object.fromEntries([...this.perAgentDay].map(([k, v]) => [k, v.n])),
    }
  }
}
