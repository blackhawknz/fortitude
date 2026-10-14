import type { Intent, IntentProposal, WorldState } from '../src/core/types.js'
import { createInitialState } from '../src/sim/state.js'
import { advanceTick, type TickResult } from '../src/sim/tick.js'
import { openDb } from '../src/db/client.js'
import { WorldStore } from '../src/db/store.js'

export function freshWorld(seed = 'test-seed', id = 'tw'): WorldState {
  return createInitialState({ id, seed })
}

export function run(s: WorldState, ticks: number, subs: (tick: number, s: WorldState) => Intent[] = () => []): { state: WorldState; results: TickResult[] } {
  const results: TickResult[] = []
  for (let i = 0; i < ticks; i++) {
    const r = advanceTick(s, subs(s.tick + 1, s))
    results.push(r)
    s = r.state
  }
  return { state: s, results }
}

let seq = 0
export function proposal(p: Partial<IntentProposal> & Pick<IntentProposal, 'agentId' | 'kind'>, tick: number): Intent {
  return {
    reason: 'test',
    weight: 0.9,
    expiresTick: tick + 12,
    source: 'agent',
    ...p,
    id: `t${tick}.${p.agentId}.${seq++}`,
    createdTick: tick - 1,
    status: 'pending',
    appliedTick: null,
  }
}

export function memoryStore(): WorldStore {
  return new WorldStore(openDb(':memory:'))
}
