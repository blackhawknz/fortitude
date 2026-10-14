import type { Intent, WorldSettings, WorldState } from '../core/types.js'
import { createInitialState, simFingerprint } from './state.js'
import { advanceTick } from './tick.js'

/**
 * Rebuild a world from its seed and its intent log (spec §3.3). Given the
 * same seed, settings and external submissions per tick, phases 1–5 are
 * reproduced exactly — including everything the LLM layer caused.
 */
export function replay(opts: {
  id: string
  name?: string
  seed: string
  settings: WorldSettings
  toTick: number
  submissions: Map<number, Intent[]>
}): WorldState {
  let s = createInitialState({ id: opts.id, name: opts.name, seed: opts.seed, settings: opts.settings })
  while (s.tick < opts.toTick) s = advanceTick(s, opts.submissions.get(s.tick + 1) ?? []).state
  return s
}

export function sameWorld(a: WorldState, b: WorldState): boolean {
  return simFingerprint(a) === simFingerprint(b)
}
