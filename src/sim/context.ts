import type { AgentId, Intent, Mood, SimEvent, Tick, WorldState } from '../core/types.js'

/** A deterministic memory write produced by the tick (e.g. "Argued with Tomas"). */
export interface SimMemory {
  agentId: AgentId
  text: string
  importance: number // 1–5
  private: boolean
  eventId: string
}

/** Scratch space for one tick. Everything the tick produces besides state. */
export class TickContext {
  readonly events: SimEvent[] = []
  readonly memories: SimMemory[] = []
  readonly intentChanges: Intent[] = []
  readonly moodHints: Partial<Record<AgentId, Mood>> = {}

  constructor(
    readonly state: WorldState,
    readonly tick: Tick,
  ) {}

  get seed(): string {
    return this.state.seed
  }

  emit(e: Omit<SimEvent, 'id' | 'tick'>): SimEvent {
    const ev: SimEvent = { ...e, id: `${this.state.id}:${this.tick}:${this.events.length}`, tick: this.tick }
    this.events.push(ev)
    return ev
  }

  remember(agentId: AgentId, text: string, importance: number, eventId: string, isPrivate = true): void {
    this.memories.push({ agentId, text, importance: Math.max(1, Math.min(5, Math.round(importance))), private: isPrivate, eventId })
  }
}
