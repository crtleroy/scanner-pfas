// Variantes d'un nom d'ingrédient et nettoyage des erreurs de lecture.
import { compact } from './rules.ts'

const CONFUSIONS_OCR: Record<string, string> = { '0': 'o', '1': 'l', '5': 's' }

/**
 * Sur une clé compacte, remplace les chiffres pris pour des lettres au milieu d'un mot
 * (« perflu0r0decalin » → « perfluorodecalin »). Les chiffres en bord de mot (PEG-100, C9-15) restent.
 */
export function corrigerOcr(cle: string): string {
  return cle.replace(/([a-z])([015]+)(?=[a-z])/g, (_, avant: string, suite: string) =>
    avant + suite.split('').map((ch) => CONFUSIONS_OCR[ch]).join(''),
  )
}

/** Variantes à essayer pour un morceau : entier, sans parenthèses, contenu des parenthèses, parties séparées par « / ». */
export function variantes(morceau: string): string[] {
  const v = new Set<string>([morceau])
  const sansParentheses = morceau.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  if (sansParentheses) v.add(sansParentheses)
  for (const m of morceau.matchAll(/\(([^)]*)\)/g)) {
    for (const p of m[1].split(/[,/]/)) if (p.trim()) v.add(p.trim())
  }
  if (sansParentheses.includes('/')) for (const p of sansParentheses.split('/')) if (p.trim()) v.add(p.trim())
  return [...v].filter((x) => compact(x).length >= 2)
}
