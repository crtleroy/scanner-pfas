// Découpage d'une liste d'ingrédients en morceaux, et nettoyage des erreurs d'OCR.
import { compact } from './rules.ts'

/** Découpe un texte de liste d'ingrédients (INCI ou alimentaire) en ingrédients. */
export function decouper(texte: string): string[] {
  let t = texte.replace(/\r/g, '\n').replace(/‚/g, ',')
  t = t.replace(/[[(]\s*nano\s*[\])]/gi, ' ')
  // Marqueurs de début de liste, dans les langues courantes des emballages
  t = t.replace(/\b(ingr[eé]dients?|ingredienti|ingredientes|zutaten|inci|composition)\s*[:：]/gi, ',')
  // « peut contenir » et +/- : on garde les colorants qui suivent comme ingrédients
  t = t.replace(/\+\s*\/\s*-|\bmay contain\b|\bpeut contenir\b|\bkann enthalten\b|\bpuede contener\b/gi, ',')
  t = t.replace(/[[\]{}]/g, ',')
  t = t.replace(/\d+(?:[.,]\d+)?\s*%/g, ' ')
  // Mot coupé en fin de ligne : « PERFLUORO-\nDECALIN »
  t = t.replace(/([A-Za-z])-\s*\n\s*([A-Za-z])/g, '$1$2')
  t = t.replace(/\s*\n\s*/g, ' ')

  const morceaux: string[] = []
  let profondeur = 0
  let courant = ''
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (ch === '(') profondeur++
    else if (ch === ')') profondeur = Math.max(0, profondeur - 1)
    const finDePhrase = ch === '.' && !/\d/.test(t[i + 1] ?? '')
    // « 1,3-BUTYLENE GLYCOL » : une virgule entre deux chiffres fait partie du nom
    const virguleDeNom = ch === ',' && /\d/.test(t[i - 1] ?? '') && /\d/.test(t[i + 1] ?? '')
    const separateur =
      profondeur === 0 && ((ch === ',' && !virguleDeNom) || ch === ';' || ch === '•' || ch === '·' || finDePhrase)
    if (separateur) {
      morceaux.push(courant)
      courant = ''
    } else courant += ch
  }
  morceaux.push(courant)

  return morceaux
    .map((m) =>
      m
        .replace(/[*°¹²³†‡]+/g, '')
        .replace(/^[\s\-–—:.]+|[\s\-–—:.]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    // Plus de 10 mots : une phrase (avertissement, mode d'emploi), pas un ingrédient
    .filter((m) => m.length >= 2 && /[a-zA-Z]/.test(m) && m.split(' ').length <= 10)
}

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
