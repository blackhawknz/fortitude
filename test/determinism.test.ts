import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { rng, weighted, fingerprint } from '../src/core/rng.js'
import { simFingerprint } from '../src/sim/state.js'
import { replay } from '../src/sim/replay.js'
import { freshWorld, run, proposal } from './helpers.js'

describe('rng', () => {
  it('is a pure function of seed and keys', () => {
    expect(rng('s', 1, 'a')).toBe(rng('s', 1, 'a'))
    expect(rng('s', 1, 'a')).not.toBe(rng('s', 1, 'b'))
    expect(rng('s', 1, 'a')).not.toBe(rng('t', 1, 'a'))
  })
  it('is roughly uniform', () => {
    const buckets = new Array(10).fill(0)
    for (let i = 0; i < 20_000; i++) buckets[Math.floor(rng('u', i) * 10)]++
    for (const b of buckets) expect(b).toBeGreaterThan(1700)
  })
  it('weighted never picks zero-weight entries', () => {
    for (let i = 0; i < 500; i++) expect(weighted([['a', 0], ['b', 1]], 'w', i)).toBe('b')
    expect(weighted([['a', 0]], 'w', 0)).toBeUndefined()
  })
  it('fingerprint ignores key order', () => {
    expect(fingerprint({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(fingerprint({ b: [1, { d: 3, c: 2 }], a: 1 }))
  })
})

describe('determinism contract (spec §3.3)', () => {
  it('same seed + same intents ⇒ identical state and events', () => {
    const a = run(freshWorld('det'), 24 * 5)
    const b = run(freshWorld('det'), 24 * 5)
    expect(simFingerprint(a.state)).toBe(simFingerprint(b.state))
    expect(a.results.flatMap((r) => r.events)).toEqual(b.results.flatMap((r) => r.events))
  })

  it('different seeds diverge', () => {
    const a = run(freshWorld('det-1'), 48)
    const b = run(freshWorld('det-2'), 48)
    expect(simFingerprint(a.state)).not.toBe(simFingerprint(b.state))
  })

  it('advanceTick does not mutate its input', () => {
    const s = freshWorld('pure')
    const before = simFingerprint(s)
    run(s, 10)
    expect(simFingerprint(s)).toBe(before)
  })

  it('replaying the external intent log reproduces the world exactly', () => {
    const log = new Map<number, ReturnType<typeof proposal>[]>()
    const subs = (tick: number) => {
      const list =
        tick % 7 === 0
          ? [proposal({ agentId: 'sera', kind: 'seek', target: 'tomas' }, tick), proposal({ agentId: 'kavi', kind: 'move', to: 'chapel' }, tick)]
          : tick % 11 === 0
            ? [proposal({ agentId: 'nadia', kind: 'confront', target: 'olen' }, tick), proposal({ agentId: 'olen', kind: 'move', to: 'sealed-deck' }, tick)]
            : []
      if (list.length) log.set(tick, list)
      return list
    }
    const live = run(freshWorld('rep'), 24 * 4, subs).state
    const rebuilt = replay({ id: live.id, seed: 'rep', settings: live.settings, toTick: live.tick, submissions: log })
    expect(simFingerprint(rebuilt)).toBe(simFingerprint(live))
    // ...and the intents made a difference, so the test is meaningful.
    const without = run(freshWorld('rep'), 24 * 4).state
    expect(simFingerprint(without)).not.toBe(simFingerprint(live))
  })
})

describe('RNG discipline', () => {
  const roots = ['src/sim', 'src/world', 'src/core']
  const files = roots.flatMap(function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f)
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
    })
  })
  it.each(files)('%s uses no ambient randomness or wall clock', (file) => {
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    expect(src).not.toMatch(/Math\.random|Date\.now|new Date\(|performance\.now|crypto\./)
  })
})
