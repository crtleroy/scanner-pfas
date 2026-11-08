// Lecture d'un texte d'étiquette : retrouve les ingrédients connus où qu'ils soient dans le texte,
// même sans virgules et avec des fautes, et note les morceaux non compris (pour le texte surligné).
import { classer, compact, plusGrave, type Classement, type ListesPfas } from './rules.ts'
import { variantes } from './texte.ts'
import type { Dictionnaire, Trouve } from './dictionnaire.ts'

export interface IngredientAnalyse {
  /** Texte tel que lu (première occurrence) */
  brut: string
  /** Nom INCI si reconnu, sinon le texte lu */
  nom: string
  reconnu: boolean
  correction?: Trouve['mode']
  distance?: number
  index?: number
  classement: Classement
  /** Quantité écrite à côté de l'ingrédient (« 35 % »), quand on la connaît */
  quantite?: string
  /** Commentaire court sur l'ingrédient (lecture par Claude) */
  commentaire?: string
}

export type TypeMorceau = 'ingredient' | 'bruit' | 'neutre'

/** Un morceau du texte d'origine, repéré par ses positions (pour l'affichage surligné). */
export interface Morceau {
  debut: number
  fin: number
  type: TypeMorceau
  /** Position dans la liste `ingredients` quand type = 'ingredient' */
  ingredient?: number
  /** Pour ce morceau précis : lu avec des fautes ('approx') ou des chiffres pris pour des lettres ('ocr') */
  correction?: Trouve['mode']
  distance?: number
}

export interface Lecture {
  ingredients: IngredientAnalyse[]
  morceaux: Morceau[]
  /** Part du texte utile (hors mots neutres) qui correspond à un ingrédient, de 0 à 1 */
  partComprise: number
}

interface Outils {
  dictionnaire: Dictionnaire
  listes: ListesPfas
}

// Mots courants des étiquettes, qui ne sont ni des ingrédients ni du « bruit » à signaler.
const MOTS_NEUTRES = new Set(
  (
    'de du des la le les un une et ou en au aux sur pour par avec sans ne pas plus ce cet cette est sont dans a l d ' +
    'of the and or with for to in on from may contain contains contient peut contenir composition ingredients ingredient ' +
    'ingredients ingredienti ingredientes zutaten inci liste excipients excipient substance substances active actif actifs ' +
    'usage utilisation mode emploi precautions precaution attention danger conserver tenir hors portee enfants yeux peau ' +
    'appliquer vaporiser eviter contact produit produits pour g mg kg ml cl l mm cm cas m'
  ).split(' '),
)

const CAS = /^\d{2,7}-\d{2}-\d$/
const MOT = /[\p{L}\p{N}]+(?:[-/][\p{L}\p{N}]+)*/gu

/** Mot vide : ne peut ni commencer ni finir un nom d'ingrédient. */
function estVide(mot: string): boolean {
  const c = compact(mot)
  return c.length <= 1 || MOTS_NEUTRES.has(c)
}

interface Segment {
  debut: number
  fin: number
}

/** Coupe aux séparateurs d'une liste (virgule hors « 1,3 », point-virgule, deux-points, point, crochets). */
export function segmenter(t: string): Segment[] {
  const segments: Segment[] = []
  let debut = 0
  let profondeur = 0
  const couper = (fin: number) => {
    let a = debut
    let b = fin
    while (a < b && /[\s\-–—*°®©™.]/.test(t[a])) a++
    while (b > a && /[\s\-–—*°®©™.]/.test(t[b - 1])) b--
    if (b > a) segments.push({ debut: a, fin: b })
  }
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (ch === '(') profondeur++
    else if (ch === ')') profondeur = Math.max(0, profondeur - 1)
    let separateur = false
    let remise = false
    if (ch === ',' || ch === '‚') {
      separateur = profondeur === 0 && !(/\d/.test(t[i - 1] ?? '') && /\d/.test(t[i + 1] ?? ''))
    } else if (ch === ';' || ch === '•' || ch === '·') separateur = profondeur === 0
    else if (ch === ':' || ch === '[' || ch === ']') separateur = remise = true
    else if (ch === '.') separateur = remise = !/\d/.test(t[i + 1] ?? '') || !/\d/.test(t[i - 1] ?? '')
    else if (ch === '\n' && /\n\s*$/.test(t.slice(debut, i))) separateur = remise = true // ligne vide
    if (separateur) {
      couper(i)
      debut = i + 1
      // Une parenthèse jamais refermée (lecture ratée) ne doit pas avaler tout le reste
      if (remise) profondeur = 0
    }
  }
  couper(t.length)
  return segments
}

function construire(brut: string, trouve: Trouve | undefined, o: Outils): IngredientAnalyse {
  let classement: Classement = trouve ? classer(trouve.nom, o.listes) : { niveau: 'aucun', regle: '' }
  // Le texte lu compte aussi : un nom fluoré mal rapproché ne doit pas disparaître
  if (classement.niveau !== 'exclu') for (const v of variantes(brut)) classement = plusGrave(classement, classer(v, o.listes))
  return {
    brut,
    nom: trouve ? trouve.nom : brut,
    reconnu: !!trouve,
    ...(trouve && trouve.mode !== 'exact' ? { correction: trouve.mode, distance: trouve.distance } : {}),
    ...(trouve ? { index: trouve.index } : {}),
    classement,
  }
}

/** Un segment court qui est en entier un nom d'ingrédient (« AQUA (WATER) », « PEG-100 STEARATE »). */
function segmentEntier(brut: string, o: Outils): Trouve | undefined {
  if (brut.split(/\s+/).length > 10) return undefined
  const sansParentheses = brut.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  const candidats = [brut, sansParentheses]
  if (sansParentheses.includes('/')) candidats.push(...sansParentheses.split('/').map((s) => s.trim()))
  const cles = [...new Set(candidats.map(compact).filter((c) => c.length >= 3 && !MOTS_NEUTRES.has(c)))]
  for (const c of cles) {
    const t = o.dictionnaire.chercherCle(c, false)
    if (t) return t
  }
  for (const c of cles.slice(0, 2)) {
    if (c.length < 7) continue
    const t = o.dictionnaire.chercherCle(c, true)
    if (t) return t
  }
  return undefined
}

export function lire(texte: string, o: Outils): Lecture {
  const ingredients: IngredientAnalyse[] = []
  const parIndex = new Map<number, number>()
  const morceaux: Morceau[] = []

  const retenir = (ing: IngredientAnalyse, debut: number, fin: number) => {
    let pos = ing.index !== undefined ? parIndex.get(ing.index) : undefined
    if (pos === undefined) {
      pos = ingredients.push(ing) - 1
      if (ing.index !== undefined) parIndex.set(ing.index, pos)
    } else {
      ingredients[pos].classement = plusGrave(ingredients[pos].classement, ing.classement)
    }
    morceaux.push({
      debut,
      fin,
      type: 'ingredient',
      ingredient: pos,
      ...(ing.correction ? { correction: ing.correction, distance: ing.distance } : {}),
    })
  }

  for (const seg of segmenter(texte)) {
    const brut = texte.slice(seg.debut, seg.fin)
    const entier = segmentEntier(brut, o)
    if (entier) {
      retenir(construire(brut, entier, o), seg.debut, seg.fin)
      continue
    }
    balayer(texte, seg, o, retenir, morceaux)
  }

  morceaux.sort((a, b) => a.debut - b.debut)
  let compris = 0
  let utile = 0
  for (const m of morceaux) {
    if (m.type === 'neutre') continue
    const extrait = texte.slice(m.debut, m.fin)
    // Une phrase de plus de 8 mots (avertissement, mode d'emploi) n'est pas un ingrédient manqué
    if (m.type === 'bruit' && extrait.split(/\s+/).length > 8) continue
    const l = compact(extrait).length
    utile += l
    if (m.type === 'ingredient') compris += l
  }
  return { ingredients, morceaux, partComprise: utile ? compris / utile : 0 }
}

/** Cherche les ingrédients mot par mot, par groupes de 1 à 8 mots, le plus long d'abord. */
function balayer(
  texte: string,
  seg: Segment,
  o: Outils,
  retenir: (ing: IngredientAnalyse, debut: number, fin: number) => void,
  morceaux: Morceau[],
) {
  const portion = texte.slice(seg.debut, seg.fin)
  const mots: { debut: number; fin: number; vide: boolean; nombre: boolean; cas: boolean }[] = []
  for (const m of portion.matchAll(MOT)) {
    const debut = seg.debut + (m.index ?? 0)
    mots.push({ debut, fin: debut + m[0].length, vide: estVide(m[0]), nombre: /^\d+$/.test(m[0]), cas: CAS.test(m[0]) })
  }
  const etat: ('ingredient' | 'bruit' | 'neutre')[] = mots.map((m) => (m.vide || m.nombre ? 'neutre' : 'bruit'))

  const cleFenetre = (i: number, l: number) => compact(texte.slice(mots[i].debut, mots[i + l - 1].fin))
  // Un nom ne commence ni ne finit par un mot vide ; il peut finir par un nombre (« Macrogol 400 », « CI 77891 »)
  const fenetreValide = (i: number, l: number) => !mots[i].vide && !mots[i + l - 1].vide && !(l === 1 && mots[i].nombre)

  const exactA = (i: number): [Trouve, number] | undefined => {
    for (let l = Math.min(8, mots.length - i); l >= 1; l--) {
      if (!fenetreValide(i, l)) continue
      const cle = cleFenetre(i, l)
      if (cle.length < 3) continue
      const t = o.dictionnaire.chercherCle(cle, false)
      if (t) return [t, l]
    }
    return undefined
  }

  let i = 0
  while (i < mots.length) {
    if (mots[i].vide || (mots[i].nombre && !mots[i].cas)) {
      i++
      continue
    }
    let trouve: Trouve | undefined
    let longueur = 0
    if (mots[i].cas) {
      trouve = o.dictionnaire.parCas(texte.slice(mots[i].debut, mots[i].fin))
      longueur = 1
    }
    if (!trouve) [trouve, longueur] = exactA(i) ?? [undefined, 0]
    if (!trouve) {
      for (let l = Math.min(4, mots.length - i); l >= 1 && !trouve; l--) {
        if (!fenetreValide(i, l)) continue
        const cle = cleFenetre(i, l)
        if (cle.length < 7) continue
        trouve = o.dictionnaire.chercherCle(cle, true)
        longueur = l
      }
      // Un nom approché ne doit pas avaler le mot d'avant si le nom exact commence au mot suivant
      if (trouve && longueur > 1 && i + 1 < mots.length && exactA(i + 1)) trouve = undefined
    }
    if (trouve) {
      const debut = mots[i].debut
      const fin = mots[i + longueur - 1].fin
      retenir(construire(texte.slice(debut, fin), trouve, o), debut, fin)
      for (let k = i; k < i + longueur; k++) etat[k] = 'ingredient'
      i += longueur
    } else i++
  }

  // Regroupe les mots non reconnus en morceaux ; un mot neutre entre deux mots non compris est absorbé
  let k = 0
  while (k < mots.length) {
    if (etat[k] === 'ingredient') {
      k++
      continue
    }
    let fin = k
    while (fin + 1 < mots.length && etat[fin + 1] !== 'ingredient') fin++
    // Dans la suite [k, fin], on isole le bloc entre le premier et le dernier mot « bruit »
    let a = k
    while (a <= fin && etat[a] === 'neutre') a++
    let b = fin
    while (b >= a && etat[b] === 'neutre') b--
    for (let n = k; n < a; n++) morceaux.push({ debut: mots[n].debut, fin: mots[n].fin, type: 'neutre' })
    if (a <= b) {
      const debut = mots[a].debut
      const finTexte = mots[b].fin
      const brut = texte.slice(debut, finTexte)
      // Une racine fluorée dans un morceau non compris compte quand même
      const cl = classer(brut, o.listes)
      if (cl.niveau === 'liste' || cl.niveau === 'mot_cle' || cl.niveau === 'possible')
        retenir({ brut, nom: brut, reconnu: false, classement: cl }, debut, finTexte)
      else morceaux.push({ debut, fin: finTexte, type: 'bruit' })
    }
    for (let n = Math.max(a, b + 1); n <= fin; n++) morceaux.push({ debut: mots[n].debut, fin: mots[n].fin, type: 'neutre' })
    k = fin + 1
  }
}
