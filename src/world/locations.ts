import type { LocationDef } from '../core/types.js'

/**
 * The v1 map of Fortitude. A ring station: the habitat ring turns around a
 * central axial corridor, the Spine. The crack is in the Spine.
 */
export const LOCATIONS: readonly LocationDef[] = [
  {
    id: 'throne-ring',
    name: 'The Throne Ring',
    description:
      'The old command deck, long since renamed. A curved hall of dead consoles and one live one. The Queen keeps her chair facing the window, not the room.',
    kind: 'civic',
    color: '#b58a3c',
    evidence: [{ fact: 'f-cassian-list', chance: 0.03 }],
  },
  {
    id: 'spine',
    name: 'The Spine',
    description:
      'The axial corridor that holds the ring to the hub. Low gravity, long sightlines, and a hairline crack that is no longer hairline. It ticks when the station turns.',
    kind: 'work',
    color: '#6a7f96',
    subsystem: 'hull',
    evidence: [{ fact: 'f-crack', chance: 0.04 }],
  },
  {
    id: 'third-bay',
    name: 'The Third Bay',
    description:
      'A maintenance bay at the Spine’s root. Tool racks, a pressure door, and set into the far wall, the seal — a hatch nobody has officially opened in eighty years.',
    kind: 'work',
    color: '#556270',
    evidence: [{ fact: 'f-toolmarks', chance: 0.12 }],
  },
  {
    id: 'sealed-deck',
    name: 'The Sealed Deck',
    description: 'Behind the seal. The lights are on. They should not be.',
    kind: 'restricted',
    color: '#2b2f36',
    access: 'seal override|master key ring',
    evidence: [{ fact: 'f-seal-interior', chance: 0.3 }],
  },
  {
    id: 'hydroponics',
    name: 'The Hydroponic Terraces',
    description:
      'Stepped green tiers under grow-lamps; the only place on the station that smells of anything but metal. Mira knows every tray by its yield.',
    kind: 'work',
    color: '#4f8a4b',
    subsystem: 'air',
    evidence: [{ fact: 'f-mira-rations', chance: 0.04 }],
  },
  {
    id: 'reclamation',
    name: 'Reclamation',
    description: 'Water tanks, filters, and the constant sound of something being recovered. Warm, damp, rarely visited.',
    kind: 'work',
    color: '#3f7c8c',
    subsystem: 'water',
    evidence: [{ fact: 'f-water-short', chance: 0.08 }],
  },
  {
    id: 'archive',
    name: 'The Archive',
    description:
      'Two centuries of logs on failing media, and Inés, who has read most of them. Some drawers are labelled in her hand over older labels.',
    kind: 'work',
    color: '#8a6d4f',
    evidence: [{ fact: 'f-ines-edits', chance: 0.05 }, { fact: 'f-old-seal', chance: 0.03 }],
  },
  {
    id: 'chapel',
    name: 'The Quiet Chapel',
    description:
      'A converted observation blister with a view straight down at the Earth. People come here to say things out loud to nobody. Juno is always here.',
    kind: 'social',
    color: '#9c8fb5',
  },
  {
    id: 'medbay',
    name: 'Medbay',
    description: 'Four beds, one scanner that works, and Kavi, who works harder than the scanner.',
    kind: 'work',
    color: '#c9d6df',
  },
  {
    id: 'market',
    name: 'The Turning Market',
    description:
      'Stalls bolted to the inner curve of the ring. Things change hands here that the ration board doesn’t know about.',
    kind: 'social',
    color: '#c47a3a',
  },
  {
    id: 'long-bar',
    name: 'The Long Bar',
    description:
      'A single counter forty metres long, following the curve of the ring. Bex keeps it neutral ground. Everyone comes here eventually.',
    kind: 'social',
    color: '#8b3a3a',
    evidence: [{ fact: 'f-bex-passed', chance: 0.03 }],
  },
  {
    id: 'promenade',
    name: 'The Promenade',
    description: 'The long window walk on the ring’s outer edge. The Earth turns past every ninety minutes.',
    kind: 'transit',
    color: '#5a7fa8',
  },
  {
    id: 'mess',
    name: 'The Mess Hall',
    description: 'Long tables, ration trays, and the station’s noticeboard, where the reported hull figure is posted every morning.',
    kind: 'civic',
    color: '#a39b8b',
  },
  {
    id: 'dock',
    name: 'Dirtside Dock',
    description: 'The cargo lock where the occasional shuttle from the surface docks. Manifests are checked here. Mostly.',
    kind: 'work',
    color: '#6d6a5f',
    evidence: [{ fact: 'f-olen-buyer', chance: 0.06 }],
  },
  {
    id: 'quarters',
    name: 'The Residential Ring',
    description: 'Cabins stacked three high along the ring. Thin walls.',
    kind: 'quarters',
    color: '#7a7a7a',
  },
]

export const LOCATION_IDS = LOCATIONS.map((l) => l.id)
const byId = new Map(LOCATIONS.map((l) => [l.id, l]))

export function locationDef(id: string): LocationDef {
  const def = byId.get(id)
  if (!def) throw new Error(`Unknown location: ${id}`)
  return def
}

export function isLocation(id: unknown): id is string {
  return typeof id === 'string' && byId.has(id)
}

/** Items that grant access, parsed from `access` ("a|b" = either). */
export function accessItems(def: LocationDef): string[] {
  return def.access ? def.access.split('|') : []
}
