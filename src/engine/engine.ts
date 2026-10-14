import type { WorldState } from '../core/types.js'
import { CATCH_UP_CAP } from '../core/clock.js'
import { advanceTick, type TickResult } from '../sim/tick.js'
import type { WorldStore } from '../db/store.js'

/** Phase 7 receiver. Must not block and must not throw into the loop. */
export interface TickListener {
  onTick(result: TickResult): void
}

export interface EngineOptions {
  store: WorldStore
  worldId: string
  /** Real milliseconds per tick. */
  tickMs: number
  listeners?: TickListener[]
}

/**
 * The tick loop (spec §3). One world, one process, setInterval.
 * The loop owns all state mutation and never awaits anything: agent turns
 * resolve on their own schedule and land as pending intents, which the next
 * tick drains.
 */
export class Engine {
  private timer: NodeJS.Timeout | null = null
  private _state: WorldState
  private stepping = false
  readonly listeners: TickListener[]

  constructor(private readonly opts: EngineOptions) {
    this._state = opts.store.load(opts.worldId)
    this.listeners = opts.listeners ?? []
  }

  get state(): WorldState {
    return this._state
  }

  get running(): boolean {
    return this.timer !== null
  }

  /** Run exactly one tick: phases 1–5 (pure), 6 (persist), 7 (notify). */
  step(): TickResult {
    if (this.stepping) throw new Error('Re-entrant tick')
    this.stepping = true
    try {
      const { store, worldId } = this.opts
      const submissions = store.pendingIntents(worldId)
      const result = advanceTick(this._state, submissions) // PHASES 1–5
      store.persistTick(result) // PHASE 6
      this._state = result.state
      for (const l of this.listeners) {
        // PHASE 7 — fire and forget. A failing listener never stops the world.
        try {
          l.onTick(result)
        } catch (err) {
          console.error('[engine] listener failed:', err)
        }
      }
      return result
    } finally {
      this.stepping = false
    }
  }

  /** Ticks owed since the world last ran, capped (spec §3.1). */
  ticksOwed(nowMs = Date.now()): number {
    const w = this.opts.store.world(this.opts.worldId)
    if (!w?.lastTickAt) return 0
    return Math.min(CATCH_UP_CAP, Math.max(0, Math.floor((nowMs - w.lastTickAt) / this.opts.tickMs)))
  }

  start(): void {
    if (this.timer) return
    const owed = this.ticksOwed()
    for (let i = 0; i < owed; i++) this.step()
    this.opts.store.setRunning(this.opts.worldId, true, this.opts.tickMs)
    this.timer = setInterval(() => {
      try {
        this.step()
      } catch (err) {
        console.error('[engine] tick failed:', err)
      }
    }, this.opts.tickMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.opts.store.setRunning(this.opts.worldId, false)
  }
}
