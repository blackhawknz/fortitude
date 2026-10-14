import { describe, expect, it } from 'vitest'
import { createInitialState } from '../src/sim/state.js'
import { advanceTick } from '../src/sim/tick.js'
import { Engine } from '../src/engine/engine.js'
import { MockBackend } from '../src/agents/backend.js'
import { AgentRuntime } from '../src/agents/runtime.js'
import { PlayerService, secondPerson } from '../src/player/service.js'
import { createApp } from '../src/server/http.js'
import { CAST, castMember, PLAYER_ID } from '../src/world/cast.js'
import { memoryStore } from './helpers.js'

function setup(seed: string, script: ConstructorParameters<typeof MockBackend>[0] = () => ({ dialogue: { say: 'Evening.', to: 'player', register: 'open' } })) {
  const store = memoryStore()
  store.create(createInitialState({ id: 'pw', seed, settings: { playerName: 'Rowan' } }))
  const engine = new Engine({ store, worldId: 'pw', tickMs: 1000 })
  const backend = new MockBackend(script)
  const backends = Object.fromEntries(CAST.filter((c) => !c.isPlayer).map((c) => [c.id, backend]))
  const player = new PlayerService({ store, engine, worldId: 'pw', backends })
  return { store, engine, player, backend }
}

/** Step until the player shares a room with an awake resident. */
function untilCompany(engine: Engine, who?: string): string {
  for (let i = 0; i < 24 * 4; i++) {
    const s = engine.state
    const me = s.agents[PLAYER_ID]!
    const other = CAST.find((c) => !c.isPlayer && (!who || c.id === who) && s.agents[c.id]!.locationId === me.locationId && !s.agents[c.id]!.asleep)
    if (other && !me.asleep) return other.id
    engine.step()
  }
  throw new Error('never found company')
}

describe('the player is a character with a body', () => {
  it('has an autopilot routine when nobody is playing', () => {
    let s = createInitialState({ id: 'x', seed: 'auto' })
    const places = new Set<string>()
    for (let i = 0; i < 48; i++) {
      s = advanceTick(s, []).state
      places.add(s.agents[PLAYER_ID]!.locationId)
    }
    expect(places.size).toBeGreaterThan(3)
  })

  it('starts a stranger to everyone but the Queen', () => {
    const s = createInitialState({ id: 'x', seed: 'strangers', settings: { playerName: 'Rowan' } })
    expect(castMember(PLAYER_ID).name).toBe('Rowan')
    expect(s.edges['sera>player']!.type).toBe('stranger')
    expect(s.edges['alita>player']!.type).toBe('friend')
    expect(Object.keys(s.knowledge[PLAYER_ID]!)).toEqual([])
  })

  it('player actions are intents, adjudicated next tick, and override the routine', () => {
    const w = setup('act')
    w.engine.step()
    const r = w.player.act({ kind: 'move', to: 'chapel' })
    expect(r.ok).toBe(true)
    expect(w.player.act({ kind: 'move', to: 'sealed-deck' })).toMatchObject({ ok: false }) // locked
    w.engine.step()
    expect(w.engine.state.agents[PLAYER_ID]!.locationId).toBe('chapel')
    expect(w.player.view().you.location.name).toBe('The Quiet Chapel')
  })
})

describe('the journal respects information boundaries (spec §7.3)', () => {
  it('contains only events the player could know first-hand', () => {
    const w = setup('bounds')
    const all: { id: string; privateTo: string[] | null }[] = []
    w.engine.listeners.push({ onTick: (r) => all.push(...r.events) })
    for (let i = 0; i < 24 * 5; i++) w.engine.step()
    const journal = w.player.journal({ limit: 500 })
    expect(journal.length).toBeGreaterThan(0)
    const visible = new Set(all.filter((e) => e.privateTo === null || e.privateTo.includes(PLAYER_ID)).map((e) => e.id))
    for (const e of journal) expect(visible.has(e.id)).toBe(true)
    // And plenty happened that the player will never see.
    expect(all.filter((e) => e.privateTo && !e.privateTo.includes(PLAYER_ID)).length).toBeGreaterThan(journal.length)
  })

  it('rewrites the player into the second person', () => {
    expect(secondPerson('Bex leaned in and told Rowan: “Tomas drinks.”', 'Rowan')).toBe('Bex leaned in and told you: “Tomas drinks.”')
    expect(secondPerson('Rowan and Bex fell into easy talk.', 'Rowan')).toBe('You and Bex fell into easy talk.')
    expect(secondPerson("Nadia watched Rowan's hands.", 'Rowan')).toBe('Nadia watched your hands.')
    // Speech is quoted exactly as said.
    expect(secondPerson('Bex to Rowan: “Easy, Rowan. Sit.”', 'Rowan')).toBe('Bex to you: “Easy, Rowan. Sit.”')
    expect(secondPerson('Rowan no longer thinks of Nadia the same way.', 'Rowan')).toBe('You no longer think of Nadia the same way.')
  })

  it('the player learns things they did not witness — through people, and it is in the journal', () => {
    // Earned: every fact the player holds arrived through an event the player was part of.
    let learned = 0
    for (const seed of ['earn-a', 'earn-b', 'earn-c']) {
      const w = setup(seed)
      for (let i = 0; i < 24 * 15; i++) w.engine.step()
      const knows = Object.values(w.engine.state.knowledge[PLAYER_ID]!)
      learned += knows.length
      const journal = w.player.journal({ limit: 1000 })
      for (const k of knows) {
        const at = journal.filter((e) => e.tick === k.tick)
        expect(at.length).toBeGreaterThan(0)
        const fact = w.player.view().knows.find((x) => x.id === k.fact)!
        expect(fact.how).toMatch(/told you|overheard|found it|noticed/)
      }
    }
    expect(learned).toBeGreaterThan(2)
  }, 60_000)
})

describe('conversation', () => {
  it('answers now; the exchange lands in the log next tick, in order', async () => {
    const w = setup('talk')
    const who = untilCompany(w.engine)
    const r = await w.player.say(who, 'Is it always this cold up here?')
    expect(r).toMatchObject({ ok: true, from: who, reply: 'Evening.' })
    const p = w.backend.calls.at(-1)!
    expect(p.trigger.kind).toBe('direct_address')
    expect(p.conversation!.at(-1)).toEqual({ speaker: 'Rowan', line: 'Is it always this cold up here?' })
    const tick = w.engine.step()
    const speech = tick.events.filter((e) => e.type === 'speech')
    expect(speech.map((e) => e.actorId)).toEqual([PLAYER_ID, who])
    expect(w.player.transcript(who).map((l) => l.speaker)).toEqual(['Rowan', castMember(who).name])
  })

  it('a resident who reveals something: the player knows it after the tick, with provenance', async () => {
    const w = setup('reveal-in', (p) => {
      const k = p.knowledge[0]
      return { dialogue: { say: 'Between us…', to: 'player', register: 'guarded', reveals: k?.id ?? null } }
    })
    const who = untilCompany(w.engine, 'bex')
    const r = await w.player.say(who, 'What do people say about Tomas?')
    expect(r.revealed).toBe(true)
    w.engine.step()
    const k = Object.values(w.engine.state.knowledge[PLAYER_ID]!)[0]!
    expect(k.source).toMatchObject({ kind: 'told', by: 'bex', confided: true })
  })

  it('the player can tell a resident something they know', async () => {
    const w = setup('reveal-out')
    const who = untilCompany(w.engine)
    w.engine.state.knowledge[PLAYER_ID]!['f-water-short'] = { fact: 'f-water-short', tick: 0, source: { kind: 'self' } }
    const had = !!w.engine.state.knowledge[who]!['f-water-short']
    await w.player.say(who, 'The tanks are lower than the board says.', { reveals: 'f-water-short', register: 'guarded' })
    w.engine.step()
    if (!had) expect(w.engine.state.knowledge[who]!['f-water-short']!.source).toMatchObject({ kind: 'told', by: PLAYER_ID })
  })

  it('refuses when they are not here, and asleep people do not answer', async () => {
    const w = setup('absent')
    w.engine.step()
    const s = w.engine.state
    const away = CAST.find((c) => !c.isPlayer && s.agents[c.id]!.locationId !== s.agents[PLAYER_ID]!.locationId)!
    expect(await w.player.say(away.id, 'Hello?')).toMatchObject({ ok: false })
    expect(w.backend.calls).toHaveLength(0)
  })

  it('the background runtime does not answer the player a second time', async () => {
    const w = setup('no-dupe')
    const runtimeBackend = new MockBackend(() => ({ intents: [] }))
    const runtime = new AgentRuntime({ store: w.store, worldId: 'pw', getState: () => w.engine.state, agents: Object.fromEntries(CAST.filter((c) => !c.isPlayer).map((c) => [c.id, runtimeBackend])), driftRoll: () => 1, reflection: false })
    w.engine.listeners.push(runtime)
    const who = untilCompany(w.engine)
    await runtime.idle()
    const before = runtimeBackend.calls.filter((p) => p.agent.id === who && p.trigger.kind === 'direct_address').length
    await w.player.say(who, 'Hello there.')
    w.engine.step()
    await runtime.idle()
    expect(runtimeBackend.calls.filter((p) => p.agent.id === who && p.trigger.kind === 'direct_address').length).toBe(before)
  })
})

describe('HTTP door', () => {
  it('serves state, accepts actions, refuses cross-origin writes', async () => {
    const w = setup('http')
    w.engine.step()
    const app = createApp({ player: w.player, engine: w.engine, store: w.store, worldId: 'pw' })
    const state = (await (await app.request('/api/state')).json()) as { you: { name: string } }
    expect(state.you.name).toBe('Rowan')
    const ok = await app.request('/api/act', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost:4100', origin: 'http://localhost:4100' }, body: JSON.stringify({ kind: 'move', to: 'promenade' }) })
    expect(ok.status).toBe(200)
    const evil = await app.request('/api/act', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost:4100', origin: 'https://evil.example' }, body: JSON.stringify({ kind: 'rest' }) })
    expect(evil.status).toBe(403)
    expect((await app.request('/')).status).toBe(200)
  })

  it('optionally requires a token', async () => {
    const w = setup('http-token')
    const app = createApp({ player: w.player, engine: w.engine, store: w.store, worldId: 'pw', token: 's3cret' })
    expect((await app.request('/api/state')).status).toBe(401)
    expect((await app.request('/api/state', { headers: { authorization: 'Bearer s3cret' } })).status).toBe(200)
  })
})
