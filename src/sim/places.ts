import { chance } from '../core/rng.js'
import { timeOf } from '../core/clock.js'
import { CAST } from '../world/cast.js'
import { factDef } from '../world/facts.js'
import { locationDef } from '../world/locations.js'
import type { TickContext } from './context.js'
import { knows, learn } from './knowledge.js'
import { fulfil } from './intents.js'

/**
 * PHASE 4b. Places yield evidence. Investigating agents roll against each
 * piece of evidence at their location; anyone awake there has a small chance
 * of noticing by accident.
 */
export function resolvePlaces(ctx: TickContext): void {
  const s = ctx.state
  const { day } = timeOf(ctx.tick)
  for (const c of CAST) {
    const a = s.agents[c.id]!
    if (!a.alive || a.asleep) continue
    const loc = locationDef(a.locationId)
    if (!loc.evidence?.length) continue
    const investigating = s.intents.find((i) => i.agentId === c.id && i.kind === 'investigate' && i.to === a.locationId)
    const perception = c.traits.perception / 100
    const dark = s.locations[a.locationId]!.dark ? 0.5 : 1

    for (const ev of loc.evidence) {
      if (ev.fromDay && day < ev.fromDay) continue
      if (knows(s, c.id, ev.fact)) continue
      const p = ev.chance * (investigating ? 0.5 + perception : 0.12 * perception) * dark
      if (!chance(p, ctx.seed, ctx.tick, c.id, ev.fact, 'evidence')) continue
      learn(s, c.id, ev.fact, { kind: 'evidence', locationId: loc.id, tick: ctx.tick }, ctx.tick)
      const f = factDef(ev.fact)
      const e = ctx.emit({
        type: 'discovery',
        actorId: c.id,
        locationId: loc.id,
        text: investigating
          ? `${c.name} searched ${loc.name} and found it: ${f.text}`
          : `${c.name} noticed something at ${loc.name}: ${f.text}`,
        magnitude: 0.4 + f.secrecy * 0.5,
        privateTo: [c.id],
        data: { fact: f.id, investigated: !!investigating },
      })
      ctx.remember(c.id, `Found at ${loc.name}: ${f.text}`, 3 + Math.round(f.secrecy * 2), e.id)
      a.stress = Math.min(100, a.stress + 4 * f.secrecy)
      ctx.moodHints[c.id] = f.secrecy >= 0.7 ? 'anxious' : 'concerned'
      if (investigating) fulfil(s, investigating.id, ctx.intentChanges)
      break
    }
  }
}
