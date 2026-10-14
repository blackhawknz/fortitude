import type { Intent, IntentProposal, Tick, WorldState } from '../core/types.js'
import { chance } from '../core/rng.js'
import { HOURS_PER_DAY, timeOf } from '../core/clock.js'
import { CAST, castMember } from '../world/cast.js'
import { factDef } from '../world/facts.js'
import { edge } from './relationships.js'

/**
 * Instincts: the deterministic layer's own source of intents. They are what
 * dormant agents "want" without an LLM — authored drives plus a few generic
 * social reflexes. They are submitted to the same queue and validated by the
 * same rules as LLM intents. Pure function of state + seed.
 */

function windowEnd(tick: Tick, from: number, to: number): Tick {
  const dayStart = tick - timeOf(tick).hour
  return dayStart + (to > from ? to : to + HOURS_PER_DAY)
}

export function instinctProposals(state: WorldState, tick: Tick): Intent[] {
  const { day, hour } = timeOf(tick)
  const out: Intent[] = []
  const seed = state.seed

  const push = (p: IntentProposal) => {
    out.push({ ...p, id: `i${tick}.${p.agentId}.${out.length}`, createdTick: tick, status: 'pending', appliedTick: null })
  }

  for (const c of CAST) {
    const a = state.agents[c.id]!
    if (!a.alive || c.isPlayer) continue // the player decides for themselves

    // Authored drives fire at the start of their window.
    c.drives.forEach((d, i) => {
      if (d.hours[0] !== hour) return
      if (d.fromDay && day < d.fromDay) return
      if (!chance(d.chance, seed, tick, c.id, 'drive', i)) return
      push({
        agentId: c.id,
        kind: d.kind,
        target: d.target,
        to: d.to,
        reason: d.reason,
        weight: d.weight,
        expiresTick: windowEnd(tick, d.hours[0], d.hours[1]),
        source: 'instinct',
      })
    })

    // Generic reflexes, once a day at 07:00.
    if (hour !== 7) continue
    const t = c.traits
    const others = CAST.filter((o) => o.id !== c.id && state.agents[o.id]!.alive)

    // Friction: confront or avoid whoever you're most at odds with.
    const sore = others
      .map((o) => edge(state, c.id, o.id))
      .filter((e) => e.tension >= 55)
      .sort((x, y) => y.tension - x.tension)[0]
    if (sore) {
      if (t.kindness < 45 && t.candour >= 45) {
        if (chance(0.3, seed, tick, c.id, 'reflex-confront'))
          push({ agentId: c.id, kind: 'confront', target: sore.to, reason: 'This has gone on long enough.', weight: 0.6, expiresTick: tick + 15, source: 'instinct' })
      } else if (chance(0.45, seed, tick, c.id, 'reflex-avoid')) {
        push({ agentId: c.id, kind: 'avoid', target: sore.to, reason: 'Easier not to.', weight: 0.55, expiresTick: tick + 17, source: 'instinct' })
      }
    }

    // Pressure: find the person you trust most and tell them something.
    if (a.stress >= 55) {
      const confidant = others
        .map((o) => edge(state, c.id, o.id))
        .filter((e) => e.trust >= 65)
        .sort((x, y) => y.trust - x.trust)[0]
      if (confidant && chance(0.35, seed, tick, c.id, 'reflex-confide')) {
        push({ agentId: c.id, kind: 'confide', target: confidant.to, reason: 'I need to say it to someone.', weight: 0.55, expiresTick: tick + 15, source: 'instinct' })
        push({ agentId: c.id, kind: 'seek', target: confidant.to, reason: 'I need to find them.', weight: 0.5, expiresTick: tick + 15, source: 'instinct' })
      } else if (chance(0.25, seed, tick, c.id, 'reflex-chapel')) {
        push({ agentId: c.id, kind: 'move', to: 'chapel', reason: 'Somewhere quiet.', weight: 0.45, expiresTick: tick + 14, source: 'instinct' })
      }
    }

    // Fresh secret about someone: the candid go and ask.
    if (t.candour >= 50) {
      const fresh = Object.values(state.knowledge[c.id] ?? {}).find((k) => {
        if (k.source.kind === 'self' || tick - k.tick > 48) return false
        const f = factDef(k.fact)
        return f.subject && f.subject !== c.id && f.secrecy >= 0.5 && state.agents[f.subject]?.alive
      })
      if (fresh && chance(0.35, seed, tick, c.id, 'reflex-ask')) {
        const subject = factDef(fresh.fact).subject!
        push({ agentId: c.id, kind: 'confront', target: subject, reason: `I heard: ${factDef(fresh.fact).text}`, weight: 0.55, expiresTick: tick + 15, source: 'instinct' })
      }
    }
  }

  // Sanity: drives authored against unknown ids are a bug, not a runtime rejection.
  for (const i of out) castMember(i.agentId)
  return out
}
