import type { FactDef } from '../core/types.js'

/**
 * Everything that can be known. Secrets are facts with a subject and high
 * secrecy. The simulation moves facts between heads; it never invents them.
 */
export const FACTS: readonly FactDef[] = [
  // The seal thread
  { id: 'f-seal-opened', text: 'Tomas opened the seal on the third bay.', subject: 'tomas', implicates: ['sera'], secrecy: 0.95, valence: -0.8, topic: 'the seal' },
  { id: 'f-sera-helped', text: 'Sera held the lamp while Tomas opened the seal.', subject: 'sera', implicates: ['tomas'], secrecy: 0.95, valence: -0.8, topic: 'the seal' },
  { id: 'f-kavi-saw', text: 'Kavi has been behind the seal, and will not say what he saw.', subject: 'kavi', implicates: ['tomas'], secrecy: 0.7, valence: -0.2, topic: 'the seal' },
  { id: 'f-seal-interior', text: 'The air behind the seal is warm. Something has been keeping it warm.', secrecy: 0.85, valence: 0, topic: 'the sealed deck' },
  { id: 'f-toolmarks', text: 'The seal on the third bay has been worked recently. The scoring is fresh.', secrecy: 0.4, valence: 0, topic: 'the seal' },
  { id: 'f-old-seal', text: 'The deck was sealed eighty years ago on the Queen’s own order.', subject: 'alita', secrecy: 0.6, valence: -0.4, topic: 'the sealed deck' },

  // The Queen
  { id: 'f-crack', text: 'The crack in the Spine is wider than the Queen has said.', subject: 'alita', secrecy: 0.9, valence: -0.6, topic: 'the crack' },

  // Court
  { id: 'f-cassian-list', text: 'Cassian is keeping a list of who would be saved.', subject: 'cassian', secrecy: 0.85, valence: -1, topic: 'the list' },
  { id: 'f-cassian-ambition', text: 'Cassian means to have the crown after her.', subject: 'cassian', secrecy: 0.5, valence: -0.5, topic: 'the succession' },
  { id: 'f-bex-passed', text: 'Bex has been passing Long Bar talk to Cassian.', subject: 'bex', implicates: ['cassian'], secrecy: 0.75, valence: -0.9, topic: 'the Long Bar' },

  // The ring
  { id: 'f-mira-rations', text: 'Mira has been giving away her own rations.', subject: 'mira', secrecy: 0.6, valence: 0.8, topic: 'the rations' },
  { id: 'f-water-short', text: 'The reclamation tanks are lower than the board says.', secrecy: 0.3, valence: 0, topic: 'the water' },
  { id: 'f-ines-edits', text: 'Inés has been editing the station record.', subject: 'ines', secrecy: 0.85, valence: -0.7, topic: 'the record' },
  { id: 'f-olen-buyer', text: 'Olen has a buyer waiting dirtside.', subject: 'olen', secrecy: 0.7, valence: -0.5, topic: 'the manifest' },
  { id: 'f-nadia-sold', text: 'Nadia sold something she overheard to someone dirtside.', subject: 'nadia', implicates: ['olen'], secrecy: 0.8, valence: -1, topic: 'the market' },
  { id: 'f-tomas-drinking', text: 'Tomas has been drinking alone at the Long Bar since the alarm.', subject: 'tomas', secrecy: 0.3, valence: 0.2, topic: 'Tomas' },
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
