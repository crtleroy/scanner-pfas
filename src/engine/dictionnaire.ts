// Dictionnaire INCI (CosIng) avec recherche exacte et recherche tolérante aux fautes.
import { compact } from './rules.ts'
import { corrigerOcr } from './texte.ts'

/** Une entrée de public/data/inci.json : [nom INCI, autres noms séparés par |, CAS, fonctions séparées par ,] */
export type EntreeInci = [string, string, string, string]

export interface Trouve {
  index: number
  nom: string
  /** 'exact' : texte identique ; 'ocr' : chiffres pris pour des lettres ; 'approx' : quelques lettres différentes */
  mode: 'exact' | 'ocr' | 'approx'
  distance: number
}

export class Dictionnaire {
  readonly entrees: EntreeInci[]
  private exact = new Map<string, number>()
  private parLongueur = new Map<number, [string, number][]>()
  private cas = new Map<string, number>()

  constructor(entrees: EntreeInci[], noms_supplementaires: string[] = []) {
    this.entrees = [...entrees]
    for (const n of noms_supplementaires) {
      if (!this.exact.has(compact(n))) this.entrees.push([n, '', '', ''])
    }
    // Les noms INCI d'abord, les traductions ensuite : « PARFUM » doit désigner l'entrée PARFUM,
    // pas une autre entrée dont c'est la traduction française.
    this.entrees.forEach((e, i) => this.ajouter(compact(e[0]), i))
    this.entrees.forEach((e, i) => {
      if (e[1]) for (const autre of e[1].split('|')) this.ajouter(compact(autre), i)
      for (const c of e[2].match(/\d{2,7}-\d{2}-\d/g) ?? []) if (!this.cas.has(c)) this.cas.set(c, i)
    })
  }

  /** Ingrédient désigné par son numéro CAS (« 52304-36-6 »). */
  parCas(numero: string): Trouve | undefined {
    const i = this.cas.get(numero)
    return i === undefined ? undefined : { index: i, nom: this.entrees[i][0], mode: 'exact', distance: 0 }
  }

  private ajouter(cle: string, i: number) {
    if (cle.length < 2 || this.exact.has(cle)) return
    this.exact.set(cle, i)
    const l = cle.length
    let seau = this.parLongueur.get(l)
    if (!seau) this.parLongueur.set(l, (seau = []))
    seau.push([cle, i])
  }

  /** Cherche un nom. Renvoie undefined si rien d'assez proche. */
  chercher(nom: string, tolerance = true): Trouve | undefined {
    return this.chercherCle(compact(nom), tolerance)
  }

  /** Même chose à partir d'une clé déjà compactée. */
  chercherCle(cle: string, tolerance = true): Trouve | undefined {
    if (cle.length < 2) return undefined
    const i = this.exact.get(cle)
    if (i !== undefined) return { index: i, nom: this.entrees[i][0], mode: 'exact', distance: 0 }
    const corrigee = corrigerOcr(cle)
    if (corrigee !== cle) {
      const j = this.exact.get(corrigee)
      if (j !== undefined) return { index: j, nom: this.entrees[j][0], mode: 'ocr', distance: 0 }
    }
    if (!tolerance) return undefined
    const max = distanceMax(corrigee.length)
    if (max === 0) return undefined
    let meilleur: Trouve | undefined
    for (let l = corrigee.length - max; l <= corrigee.length + max; l++) {
      const seau = this.parLongueur.get(l)
      if (!seau) continue
      for (const [candidat, idx] of seau) {
        const limite = meilleur ? meilleur.distance - 1 : max
        if (limite < 1) break
        const d = levenshteinBorne(corrigee, candidat, limite)
        if (d <= limite) meilleur = { index: idx, nom: this.entrees[idx][0], mode: 'approx', distance: d }
      }
    }
    return meilleur
  }
}

/** Nombre de fautes tolérées selon la longueur du mot (sans espaces). */
export function distanceMax(longueur: number): number {
  if (longueur < 6) return 0
  if (longueur <= 9) return 1
  if (longueur <= 16) return 2
  return 3
}

/** Distance de Levenshtein, abandonnée dès qu'elle dépasse `limite` (renvoie alors limite + 1). */
export function levenshteinBorne(a: string, b: string, limite: number): number {
  if (Math.abs(a.length - b.length) > limite) return limite + 1
  let prec = new Array<number>(b.length + 1)
  let cour = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prec[j] = j
  for (let i = 1; i <= a.length; i++) {
    cour[0] = i
    let minLigne = cour[0]
    const debut = Math.max(1, i - limite)
    const fin = Math.min(b.length, i + limite)
    if (debut > 1) cour[debut - 1] = limite + 1
    for (let j = debut; j <= fin; j++) {
      const cout = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      const v = Math.min(prec[j] + 1, cour[j - 1] + 1, prec[j - 1] + cout)
      cour[j] = v
      if (v < minLigne) minLigne = v
    }
    if (fin < b.length) cour[fin + 1] = limite + 1
    if (minLigne > limite) return limite + 1
    ;[prec, cour] = [cour, prec]
  }
  return prec[b.length]
}
