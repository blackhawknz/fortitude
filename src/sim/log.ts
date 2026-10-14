import type { SimEvent } from '../core/types.js'
import { formatTime } from '../core/clock.js'
import { locationDef } from '../world/locations.js'

/** One readable line per event, for the headless log. */
export function formatEvent(e: SimEvent): string {
  const where = e.locationId ? ` · ${locationDef(e.locationId).name}` : ''
  const scope = e.privateTo === null ? 'public' : e.privateTo.length === 1 ? `private:${e.privateTo[0]}` : `seen:${e.privateTo.length}`
  return `${formatTime(e.tick)}${where}  [${e.type}${e.outcome ? ':' + e.outcome : ''}] ${e.text}  (${scope})`
}
