import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createInitialState } from '../src/sim/state.js'
import { advanceTick } from '../src/sim/tick.js'
import { learn, telling, believed } from '../src/sim/knowledge.js'
import { Engine } from '../src/engine/engine.js'
import { PlayerService } from '../src/player/service.js'
import { buildDebrief, TeaserService, narrateDebrief } from '../src/player/presence.js'
import { createApp } from '../src/server/http.js'
import { FACTS } from '../src/world/facts.js'
import { PLAYER_ID } from '../src/world/cast.js'
import { memoryStore, run, freshWorld } from './helpers.js'

describe('rumours (distortion in the telling)', () => {
  it('a garbled rumour makes people resent whoever it names — the truth corrects the belief, not the grudge', () => {
    const s = freshWorld('rumour-blame')
    const tomasBefore = s.edges['mira>tomas']!.grudge
    // Mira hears the rumour that SERA opened the seal.
    learn(s, 'mira', 'f-seal-opened', { kind: 'told', by: 'nadia', tick: 1, confided: false }, 1, { version: 2, hops: 3 })
    expect(believed(s, 'mira', 'f-seal-opened').text).toBe('Sera opened the seal on the third bay.')
    expect(s.edges['mira>sera']!.grudge).toBeGreaterThan(0)
    expect(s.edges['mira>tomas']!.grudge).toBe(tomasBefore)
    // Later she finds the truth. Now Tomas takes the hit; Sera's grudge lingers (misjudgments do).
    const upgraded = learn(s, 'mira', 'f-seal-opened', { kind: 'evidence', locationId: 'third-bay', tick: 5 }, 5)
    expect(upgraded).toBe(true)
    expect(believed(s, 'mira', 'f-seal-opened').text).toBe('Tomas opened the seal on the third bay.')
    expect(s.edges['mira>tomas']!.grudge).toBeGreaterThan(tomasBefore)
    expect(s.edges['mira>sera']!.grudge).toBeGreaterThan(0)
  })

  it('a rumour never overwrites the truth', () => {
    const s = freshWorld('rumour-truth')
    expect(learn(s, 'kavi', 'f-crack', { kind: 'told', by: 'alita', tick: 1, confided: true }, 1)).toBe(true)
    expect(learn(s, 'kavi', 'f-crack', { kind: 'told', by: 'nadia', tick: 2, confided: false }, 2, { version: 2 })).toBe(false)
    expect(believed(s, 'kavi', 'f-crack').text).toBe('The crack in the Spine is wider than the Queen has said.')
  })

  it('confidences are exact; gossip garbles more the further it travels', () => {
    const s = freshWorld('telling')
    for (const f of FACTS) if (f.rumours?.length) s.knowledge['nadia']![f.id] = { fact: f.id, tick: 0, source: { kind: 'self' }, hops: 0 }
    let firstHand = 0
    let thirdHand = 0
    for (let i = 0; i < 400; i++) {
      expect(telling(s, 'nadia', 'f-olen-buyer', 'confide', 'seed', i).version).toBe(0)
      if (telling(s, 'nadia', 'f-olen-buyer', 'gossip', 'seed', i).version) firstHand++
    }
    s.knowledge['nadia']!['f-olen-buyer']!.hops = 3
    for (let i = 0; i < 400; i++) if (telling(s, 'nadia', 'f-olen-buyer', 'gossip', 'seed', i).version) thirdHand++
    expect(firstHand).toBeGreaterThan(30)
    expect(thirdHand).toBeGreaterThan(firstHand)
  })

  it('only the truth counts toward a goal to learn something', () => {
    const s = freshWorld('goal-truth')
    learn(s, 'sera', 'f-seal-interior', { kind: 'told', by: 'nadia', tick: 1, confided: false }, 1, { version: 1 })
    const r = advanceTick(s, [])
    expect(r.state.agents.sera!.goals.find((g) => g.id === 'g-seal')!.progress).toBe(0)
  })

  it('rumours actually spread in a month, garbled', () => {
    let rumoursHeld = 0
    for (const seed of ['spread-a', 'spread-b']) {
      const s = run(freshWorld(seed), 24 * 30).state
      for (const ks of Object.values(s.knowledge)) for (const k of Object.values(ks)) if (k.version) rumoursHeld++
    }
    expect(rumoursHeld).toBeGreaterThan(0)
  }, 30_000)
})

describe('the autopilot never chooses for the player', () => {
  it('no gossip, betrayal, confiding or confrontation initiated by an untended player', () => {
    for (const seed of ['auto-a', 'auto-b']) {
      const evs = run(freshWorld(seed), 24 * 20).results.flatMap((r) => r.events)
      const led = evs.filter((e) => e.type === 'encounter' && e.actorId === PLAYER_ID)
      for (const e of led) expect(['gossip', 'betray', 'confide', 'confront']).not.toContain(e.outcome)
    }
  }, 30_000)
})

function persisted(seed: string) {
  const store = memoryStore()
  store.create(createInitialState({ id: 'aw', seed, settings: { playerName: 'Rowan' } }))
  const engine = new Engine({ store, worldId: 'aw', tickMs: 1000 })
  return { store, engine }
}

describe('absence debrief', () => {
  it('picks the few things worth telling, only from what the player could know', () => {
    let threeOrMore = 0
    for (const seed of ['away-a', 'away-b', 'away-c']) {
      const { store, engine } = persisted(seed)
      for (let i = 0; i < 24; i++) engine.step()
      store.markSeen('aw', engine.state.tick)
      for (let i = 0; i < 48; i++) engine.step()
      const d = buildDebrief(store, 'aw', engine.state.tick)
      expect(d.away.hours).toBe(48)
      expect(d.headline.length).toBeLessThanOrEqual(3)
      const visible = new Set(store.visibleEvents('aw', PLAYER_ID, { sinceTick: 25, limit: 5000 }).map((e) => e.id))
      for (const i of [...d.headline, ...d.more]) expect(visible.has(i.eventId)).toBe(true)
      if (d.headline.length >= 3) threeOrMore++
    }
    expect(threeOrMore).toBeGreaterThanOrEqual(2) // spec §14: "three things worth telling them about"
  }, 30_000)

  it('narration sees only the headline items', async () => {
    const { store, engine } = persisted('narrate')
    for (let i = 0; i < 48; i++) engine.step()
    const d = buildDebrief(store, 'aw', engine.state.tick, 0)
    let seen = ''
    const prose = await narrateDebrief({ text: async (_s, u) => ((seen = u), 'While you were away, things moved.') }, d)
    expect(prose).toContain('While you were away')
    for (const i of d.headline) expect(seen).toContain(i.text)
    for (const i of d.more) if (!d.headline.some((h) => h.text === i.text)) expect(seen).not.toContain(i.text)
  })
})

describe('teasers', () => {
  it('while away: one spoiler-free teaser, in-app and to the webhook, then a cooldown', async () => {
    const received: any[] = []
    const hook = createServer((req, res) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => (received.push(JSON.parse(b)), res.end('ok')))
    })
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()))
    const url = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/`
    try {
      const { store, engine } = persisted('teaser')
      let clock = 1_000_000
      store.markSeen('aw', 0, clock)
      const teasers: string[] = []
      const t = new TeaserService({ store, engine, worldId: 'aw', isPresent: () => false, webhookUrl: url, minAwayMs: 1000, cooldownMs: 60_000, now: () => clock, onTeaser: (x) => teasers.push(x) })
      engine.listeners.push(t)
      for (let i = 0; i < 72 && teasers.length === 0; i++) {
        clock += 500
        engine.step()
        await new Promise((r) => setTimeout(r, 5))
      }
      expect(teasers.length).toBe(1)
      const text = teasers[0]!
      for (const f of FACTS) {
        expect(text).not.toContain(f.text)
        for (const r of f.rumours ?? []) expect(text).not.toContain(r.text)
      }
      await new Promise((r) => setTimeout(r, 50))
      expect(received[0]?.text).toBe(text)
      expect(store.notificationsFor('aw', { unreadOnly: true })[0]!.text).toBe(text)
      // Cooldown: nothing more for a while.
      for (let i = 0; i < 24; i++) {
        clock += 500
        engine.step()
      }
      expect(teasers.length).toBe(1)
    } finally {
      hook.close()
    }
  }, 30_000)

  it('no teasers while the player is present', () => {
    const { store, engine } = persisted('present')
    store.markSeen('aw', 0, 0)
    const t = new TeaserService({ store, engine, worldId: 'aw', isPresent: () => true, minAwayMs: 0, cooldownMs: 0, now: () => 10 ** 12 })
    engine.listeners.push(t)
    for (let i = 0; i < 48; i++) engine.step()
    expect(store.notificationsFor('aw')).toHaveLength(0)
  })

  it('the spoiler-free seed says who and where, never what', () => {
    expect(TeaserService.seed({ kind: 'learned', text: 'Nadia passed something on to you: “Olen has a buyer waiting dirtside.”', when: '', place: 'The Turning Market', weight: 1, eventId: 'x' })).toBe('Nadia has something to tell you at the Turning Market.')
    expect(TeaserService.seed({ kind: 'sought', text: 'Cassian Vey to you: “We should talk.”', when: '', place: 'The Long Bar', weight: 1, eventId: 'x' })).toBe('Cassian Vey came looking for you at the Long Bar.')
  })
})

describe('presence over HTTP', () => {
  it('debrief and notifications endpoints', async () => {
    const { store, engine } = persisted('http-presence')
    for (let i = 0; i < 30; i++) engine.step()
    store.addNotification('aw', PLAYER_ID, 30, 'teaser', 'Someone came looking for you.')
    const player = new PlayerService({ store, engine, worldId: 'aw', backends: {} })
    const web = createApp({ player, engine, store, worldId: 'aw' })
    const d = (await (await web.request('/api/debrief')).json()) as { away: { hours: number }; headline: unknown[] }
    expect(d.away.hours).toBe(30)
    const n = (await (await web.request('/api/notifications')).json()) as { unread: number }
    expect(n.unread).toBe(1)
    await web.request('/api/notifications/read', { method: 'POST' })
    expect(((await (await web.request('/api/notifications')).json()) as { unread: number }).unread).toBe(0)
    expect(web.isPresent()).toBe(false)
  })
})
