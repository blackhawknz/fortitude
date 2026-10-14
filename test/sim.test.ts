import { describe, expect, it } from 'vitest'
import { advanceTick } from '../src/sim/tick.js'
import { validateIntent } from '../src/sim/intents.js'
import { simFingerprint } from '../src/sim/state.js'
import { tickOf } from '../src/core/clock.js'
import { CAST } from '../src/world/cast.js'
import { freshWorld, run, proposal } from './helpers.js'

describe('intent validation (phase 2)', () => {
  const s = run(freshWorld('val'), 10).state
  const t = s.tick + 1
  const check = (p: Parameters<typeof proposal>[0]) => validateIntent(s, proposal(p, t), t)

  it('rejects unknown actions, people, places and self-targeting', () => {
    expect(check({ agentId: 'sera', kind: 'murder' as never, target: 'tomas' }).ok).toBe(false)
    expect(check({ agentId: 'sera', kind: 'seek', target: 'nobody' }).ok).toBe(false)
    expect(check({ agentId: 'sera', kind: 'move', to: 'the-moon' }).ok).toBe(false)
    expect(check({ agentId: 'sera', kind: 'seek', target: 'sera' }).ok).toBe(false)
    expect(check({ agentId: 'sera', kind: 'seek' }).ok).toBe(false)
  })

  it('enforces access: the sealed deck needs a key', () => {
    expect(check({ agentId: 'sera', kind: 'move', to: 'sealed-deck' }).ok).toBe(true) // master key ring
    expect(check({ agentId: 'tomas', kind: 'move', to: 'sealed-deck' }).ok).toBe(true) // seal override
    const r = check({ agentId: 'bex', kind: 'move', to: 'sealed-deck' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/locked/)
  })

  it('clamps weight and horizon, truncates speech', () => {
    const here = Object.values(s.agents).find((a) => a.id !== 'sera' && a.locationId === s.agents.sera!.locationId && !a.asleep)
    const r = check({ agentId: 'sera', kind: 'seek', target: 'tomas', weight: 7, expiresTick: t + 999 })
    expect(r.ok && r.value.weight).toBe(1)
    expect(r.ok && r.value.expiresTick).toBe(t + 48)
    if (here) {
      const sp = check({ agentId: 'sera', kind: 'speak', target: here.id, say: 'x'.repeat(2000) })
      expect(sp.ok && sp.value.say!.length).toBe(400)
    }
  })

  it('speech requires the listener to be present', () => {
    const away = Object.values(s.agents).find((a) => a.locationId !== s.agents.sera!.locationId)!
    expect(check({ agentId: 'sera', kind: 'speak', target: away.id, say: 'hello' }).ok).toBe(false)
  })
})

describe('intents change the world only through adjudication', () => {
  it('a committed move puts the agent there next tick', () => {
    const s = run(freshWorld('mv'), tickOf(2, 10)).state
    expect(s.agents.mira!.locationId).not.toBe('chapel')
    const r = advanceTick(s, [proposal({ agentId: 'mira', kind: 'move', to: 'chapel' }, s.tick + 1)])
    expect(r.state.agents.mira!.locationId).toBe('chapel')
    expect(r.intents.find((i) => i.agentId === 'mira' && i.source === 'agent')?.status).toBe('committed')
  })

  it('a rejected intent changes nothing but leaves a private trace for the agent', () => {
    const s = run(freshWorld('rj'), tickOf(2, 10)).state
    const r = advanceTick(s, [proposal({ agentId: 'bex', kind: 'move', to: 'sealed-deck' }, s.tick + 1)])
    const baseline = advanceTick(s, [])
    expect(simFingerprint(r.state)).toBe(simFingerprint(baseline.state))
    const ev = r.events.find((e) => e.type === 'intent')!
    expect(ev.privateTo).toEqual(['bex'])
    expect(r.intents.find((i) => i.agentId === 'bex' && i.source === 'agent')?.status).toBe('rejected')
  })

  it('seeking someone makes meeting them much more likely', () => {
    let met = 0
    let metBaseline = 0
    for (let d = 0; d < 12; d++) {
      const s = run(freshWorld(`seek-${d}`), tickOf(2, 14)).state
      const sub = (tick: number) => (tick === s.tick + 1 ? [proposal({ agentId: 'kavi', kind: 'seek', target: 'cassian', expiresTick: tick + 8 }, tick)] : [])
      const withSeek = run(s, 8, sub).results.flatMap((r) => r.events)
      const without = run(s, 8).results.flatMap((r) => r.events)
      const meets = (evs: typeof withSeek) => evs.some((e) => e.type === 'encounter' && [e.actorId, e.targetId].includes('kavi') && [e.actorId, e.targetId].includes('cassian'))
      if (meets(withSeek)) met++
      if (meets(without)) metBaseline++
    }
    expect(met).toBeGreaterThan(metBaseline + 4)
  })
})

describe('station', () => {
  it('hull never increases', () => {
    const { results } = run(freshWorld('hull'), 24 * 20)
    let prev = Infinity
    for (const r of results) {
      expect(r.state.station.hull).toBeLessThanOrEqual(prev)
      prev = r.state.station.hull
    }
  })

  it('the board overstates the hull (the Queen’s secret)', () => {
    const s = run(freshWorld('board'), 24 * 10).state
    expect(s.station.reportedHull).toBeGreaterThan(s.station.hull + 5)
  })
})

describe('information boundaries in events', () => {
  const evs = run(freshWorld('vis'), 24 * 10).results.flatMap((r) => r.events)
  it('private events name only who may know them', () => {
    for (const e of evs) {
      if (e.type === 'milestone' || e.type === 'discovery' || e.type === 'betrayal_discovered') expect(e.privateTo).toHaveLength(1)
      if (e.outcome === 'observe') expect(e.privateTo).toEqual([e.actorId])
    }
  })
  it('every encounter includes both parties unless one-sided', () => {
    for (const e of evs.filter((x) => x.type === 'encounter' && x.outcome !== 'observe')) {
      expect(e.privateTo).toContain(e.actorId)
      expect(e.privateTo).toContain(e.targetId)
    }
  })
  it('all twelve slots: eleven authored residents, twelfth left open', () => {
    expect(CAST).toHaveLength(11)
  })
})
