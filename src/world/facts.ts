import type { FactDef } from '../core/types.js'

/**
 * Everything that can be known. Secrets are facts with a subject and high
 * secrecy. The simulation moves facts between heads; it never invents them.
 *
 * `rumours` are how a fact sounds after it has been passed around. They are
 * authored, not generated, so distortion is deliberate and on-theme — and a
 * garbled rumour can point at the wrong person entirely.
 */
export const FACTS: readonly FactDef[] = [
  // The seal thread
  {
    id: 'f-seal-opened', text: 'Tomas opened the seal on the third bay.', subject: 'tomas', implicates: ['sera'], secrecy: 0.95, valence: -0.8, topic: 'the seal',
    rumours: [
      { text: 'Someone has been through the seal on the third bay.', subject: null, valence: 0 },
      { text: 'Sera opened the seal on the third bay.', subject: 'sera', valence: -0.8 },
    ],
  },
  {
    id: 'f-sera-helped', text: 'Sera held the lamp while Tomas opened the seal.', subject: 'sera', implicates: ['tomas'], secrecy: 0.95, valence: -0.8, topic: 'the seal',
    rumours: [{ text: 'The Hand was seen at the third bay with a lamp, late at night.', subject: 'sera', valence: -0.4 }],
  },
  {
    id: 'f-kavi-saw', text: 'Kavi has been behind the seal, and will not say what he saw.', subject: 'kavi', implicates: ['tomas'], secrecy: 0.7, valence: -0.2, topic: 'the seal',
    rumours: [{ text: 'Kavi went behind the seal and came out sick.', subject: 'kavi', valence: 0.1 }],
  },
  {
    id: 'f-seal-interior', text: 'The air behind the seal is warm. Something has been keeping it warm.', secrecy: 0.85, valence: 0, topic: 'the sealed deck',
    rumours: [
      { text: 'There is something alive behind the seal.', subject: null },
      { text: 'Someone has been living on the sealed deck.', subject: null },
    ],
  },
  {
    id: 'f-toolmarks', text: 'The seal on the third bay has been worked recently. The scoring is fresh.', secrecy: 0.4, valence: 0, topic: 'the seal',
    rumours: [{ text: 'Someone has been trying to break into the sealed deck.', subject: null }],
  },
  {
    id: 'f-old-seal', text: 'The deck was sealed eighty years ago on the Queen’s own order.', subject: 'alita', secrecy: 0.6, valence: -0.4, topic: 'the sealed deck',
    rumours: [{ text: 'The Queen sealed that deck herself, to hide something.', subject: 'alita', valence: -0.7 }],
  },

  // The Queen
  {
    id: 'f-crack', text: 'The crack in the Spine is wider than the Queen has said.', subject: 'alita', secrecy: 0.9, valence: -0.6, topic: 'the crack',
    rumours: [
      { text: 'The Spine will fail within the year.', subject: null, valence: 0 },
      { text: 'The Queen has been lying about the hull figures.', subject: 'alita', valence: -0.9 },
    ],
  },

  // Court
  {
    id: 'f-cassian-list', text: 'Cassian is keeping a list of who would be saved.', subject: 'cassian', secrecy: 0.85, valence: -1, topic: 'the list',
    rumours: [
      { text: 'Cassian has a list of who gets a berth off the ring.', subject: 'cassian', valence: -1 },
      { text: 'The court has a list of who will be left behind.', subject: 'alita', valence: -0.8 },
    ],
  },
  {
    id: 'f-cassian-ambition', text: 'Cassian means to have the crown after her.', subject: 'cassian', secrecy: 0.5, valence: -0.5, topic: 'the succession',
    rumours: [{ text: 'Cassian is planning to take the crown.', subject: 'cassian', valence: -0.8 }],
  },
  {
    id: 'f-bex-passed', text: 'Bex has been passing Long Bar talk to Cassian.', subject: 'bex', implicates: ['cassian'], secrecy: 0.75, valence: -0.9, topic: 'the Long Bar',
    rumours: [{ text: 'Bex sells what he hears at the bar to the court.', subject: 'bex', valence: -0.9 }],
  },

  // The ring
  {
    id: 'f-mira-rations', text: 'Mira has been giving away her own rations.', subject: 'mira', secrecy: 0.6, valence: 0.8, topic: 'the rations',
    rumours: [{ text: 'Mira is sick and hiding it.', subject: 'mira', valence: 0.3 }],
  },
  {
    id: 'f-water-short', text: 'The reclamation tanks are lower than the board says.', secrecy: 0.3, valence: 0, topic: 'the water',
    rumours: [{ text: 'The water is going to run out.', subject: null }],
  },
  {
    id: 'f-ines-edits', text: 'Inés has been editing the station record.', subject: 'ines', secrecy: 0.85, valence: -0.7, topic: 'the record',
    rumours: [{ text: 'Inés has been destroying records.', subject: 'ines', valence: -0.9 }],
  },
  {
    id: 'f-olen-buyer', text: 'Olen has a buyer waiting dirtside.', subject: 'olen', secrecy: 0.7, valence: -0.5, topic: 'the manifest',
    rumours: [{ text: 'Olen is smuggling station parts dirtside.', subject: 'olen', valence: -0.8 }],
  },
  {
    id: 'f-nadia-sold', text: 'Nadia sold something she overheard to someone dirtside.', subject: 'nadia', implicates: ['olen'], secrecy: 0.8, valence: -1, topic: 'the market',
    rumours: [{ text: 'Nadia is a spy for someone dirtside.', subject: 'nadia', valence: -1 }],
  },
  {
    id: 'f-tomas-drinking', text: 'Tomas has been drinking alone at the Long Bar since the alarm.', subject: 'tomas', secrecy: 0.3, valence: 0.2, topic: 'Tomas',
    rumours: [{ text: 'Tomas is drinking himself to death.', subject: 'tomas', valence: 0.1 }],
  },
]

const byId = new Map(FACTS.map((f) => [f.id, f]))

export function factDef(id: string): FactDef {
  const f = byId.get(id)
  if (!f) throw new Error(`Unknown fact: ${id}`)
  return f
}

export function isFact(id: unknown): id is string {
  return typeof id === 'string' && byId.has(id)
}

/** What a fact looks like in someone's head at a given version (0 = the truth). */
export function factVersion(id: string, version = 0): { text: string; subject?: string; valence: number; true: boolean } {
  const f = factDef(id)
  const r = version > 0 ? f.rumours?.[version - 1] : undefined
  if (!r) return { text: f.text, subject: f.subject, valence: f.valence, true: true }
  return { text: r.text, subject: r.subject ?? undefined, valence: r.valence ?? f.valence, true: false }
}
