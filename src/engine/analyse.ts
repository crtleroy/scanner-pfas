// Moteur d'analyse : fonction pure, testée à part de l'interface.
import { classer, compact, estPfas, plusGrave, type Classement, type Famille, type ListesPfas } from './rules.ts'
import { decouper, variantes } from './texte.ts'
import type { Dictionnaire, Trouve } from './dictionnaire.ts'

export type Source = 'base_beaute' | 'base_alimentaire' | 'base_produits' | 'photo' | 'texte'
export type Verdict = 'rouge' | 'orange' | 'vert' | 'gris'
export type Confiance = 'élevée' | 'moyenne' | 'faible'

export interface Contexte {
  source: Source
  categories?: string[]
  nomProduit?: string
}

export interface Ressources {
  dictionnaire: Dictionnaire
  listes: ListesPfas
}

export interface IngredientAnalyse {
  /** Texte tel que lu sur l'étiquette ou dans la base */
  brut: string
  /** Nom INCI si reconnu, sinon le texte nettoyé */
  nom: string
  reconnu: boolean
  correction?: Trouve['mode']
  index?: number
  classement: Classement
}

export interface Resultat {
  verdict: Verdict
  titre: string
  phrase: string
  confiance: Confiance
  ingredients: IngredientAnalyse[]
  /** Part des ingrédients reconnus dans le dictionnaire, de 0 à 1 */
  tauxReconnus: number
  categorieARisque?: string
  familles: Famille[]
  source: Source
}

/** Analyse une liste d'ingrédients (texte brut ou déjà découpée). */
export function analyse(entree: string | string[], contexte: Contexte, r: Ressources): Resultat {
  const morceaux = typeof entree === 'string' ? decouper(entree) : entree.flatMap((x) => decouper(x))
  const ingredients = morceaux.map((m) => analyserIngredient(m, r))
  return conclure(ingredients, contexte)
}

export function analyserIngredient(brut: string, r: Ressources): IngredientAnalyse {
  const vs = variantes(brut)
  let trouve: Trouve | undefined
  // D'abord une correspondance exacte sur l'une des variantes, ensuite seulement l'approximation
  for (const v of vs) {
    trouve = r.dictionnaire.chercher(v, false)
    if (trouve) break
  }
  if (!trouve) trouve = r.dictionnaire.chercher(vs[0]) ?? (vs[1] ? r.dictionnaire.chercher(vs[1]) : undefined)

  let classement: Classement = { niveau: 'aucun', regle: '' }
  if (trouve) classement = classer(trouve.nom, r.listes)
  // Le texte brut compte aussi : un nom fluoré mal rapproché ne doit pas disparaître.
  // Sauf si le nom reconnu est un fluoré non PFAS connu (le texte brut contient alors les mêmes racines).
  if (classement.niveau !== 'exclu') {
    for (const v of vs) classement = plusGrave(classement, classer(v, r.listes))
  }
  const reconnu = !!trouve || classement.niveau !== 'aucun'
  return {
    brut,
    nom: trouve ? trouve.nom : brut,
    reconnu,
    ...(trouve && trouve.mode !== 'exact' ? { correction: trouve.mode } : {}),
    ...(trouve ? { index: trouve.index } : {}),
    classement,
  }
}

// Catégories où l'on trouve des PFAS quand la composition manque (cahier des charges).
const CATEGORIES_A_RISQUE: [RegExp, string][] = [
  [/waterproof|water-proof|longue tenue|long-lasting|long lasting|longwear|24h/, 'maquillage waterproof ou longue tenue'],
  [/dental-floss|fil-dentaire|fils-dentaires|fil dentaire|dental floss|\bfloss\b/, 'fil dentaire'],
  [/non-stick|antiadhesi|anti-adhesi|poele|frying-pan|cookware|baking-mold/, 'ustensile anti-adhésif'],
  [/water-repellent|deperlant|impermeable|anti-tache|stain-resist|rain-jacket|raincoat/, 'textile déperlant ou anti-taches'],
  [/ski-wax|\bfart\b|ski wax/, 'fart'],
  [/microwave-popcorn|pop-corn|popcorn|papier cuisson|baking-paper/, 'emballage alimentaire résistant à la graisse'],
]

export function categorieARisque(categories: string[] = [], nomProduit = ''): string | undefined {
  const texte = [...categories, nomProduit].join(' ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  for (const [motif, libelle] of CATEGORIES_A_RISQUE) if (motif.test(texte)) return libelle
  return undefined
}

function pluriel(n: number, mot: string): string {
  return `${n} ${mot}${n > 1 ? 's' : ''}`
}

export function conclure(ingredients: IngredientAnalyse[], contexte: Contexte): Resultat {
  const source = contexte.source
  const base = { ingredients, source }
  const familles = [...new Set(ingredients.flatMap((i) => (estPfas(i.classement.niveau) && i.classement.famille ? [i.classement.famille] : [])))]
  const nbReconnus = ingredients.filter((i) => i.reconnu).length
  const tauxReconnus = ingredients.length ? nbReconnus / ingredients.length : 0

  if (ingredients.length === 0) {
    const risque = categorieARisque(contexte.categories, contexte.nomProduit)
    if (risque)
      return {
        ...base,
        verdict: 'orange',
        titre: 'À vérifier',
        phrase: `Composition inconnue. Ce type de produit (${risque}) contient parfois des PFAS : photographiez la liste des ingrédients.`,
        confiance: 'faible',
        tauxReconnus,
        categorieARisque: risque,
        familles,
      }
    return {
      ...base,
      verdict: 'gris',
      titre: 'Indéterminé',
      phrase: 'Composition inconnue : photographiez la liste des ingrédients au dos du produit.',
      confiance: 'faible',
      tauxReconnus,
      familles,
    }
  }

  const pfas = ingredients.filter((i) => estPfas(i.classement.niveau))
  if (pfas.length) {
    const parListe = pfas.some((i) => i.classement.niveau === 'liste')
    return {
      ...base,
      verdict: 'rouge',
      titre: 'PFAS détecté',
      phrase: `${pluriel(pfas.length, 'ingrédient')} de la famille des PFAS`,
      confiance: parListe ? 'élevée' : 'moyenne',
      tauxReconnus,
      familles,
    }
  }

  const possibles = ingredients.filter((i) => i.classement.niveau === 'possible')
  if (possibles.length) {
    return {
      ...base,
      verdict: 'orange',
      titre: 'PFAS possible',
      phrase: `${pluriel(possibles.length, 'ingrédient')} fluoré${possibles.length > 1 ? 's' : ''} à vérifier`,
      confiance: 'faible',
      tauxReconnus,
      familles,
    }
  }

  // Pour les produits alimentaires et divers, les ingrédients ne sont pas des noms INCI :
  // le taux de reconnaissance ne veut rien dire.
  const tauxCompte = source === 'photo' || source === 'texte' || source === 'base_beaute'
  if (tauxCompte && tauxReconnus < (source === 'base_beaute' ? 0.4 : 0.6)) {
    return {
      ...base,
      verdict: 'gris',
      titre: 'Indéterminé',
      phrase: `Seuls ${Math.round(tauxReconnus * 100)} % des ingrédients sont reconnus : corrigez le texte ou reprenez la photo.`,
      confiance: 'faible',
      tauxReconnus,
      familles,
    }
  }

  let confiance: Confiance = 'moyenne'
  if (tauxCompte) confiance = tauxReconnus >= 0.9 ? 'élevée' : tauxReconnus >= 0.7 ? 'moyenne' : 'faible'
  return {
    ...base,
    verdict: 'vert',
    titre: 'Aucun PFAS détecté',
    phrase: 'Aucun PFAS dans la composition déclarée.',
    confiance,
    tauxReconnus,
    familles,
  }
}

/** Construit les listes de recherche à partir de public/data/pfas.json. */
export function preparerListes(donnees: {
  pfas: { n: string; cas?: string; f: Famille }[]
  nonPfas: { n: string; r: string }[]
}): ListesPfas {
  const pfas = new Map<string, Famille>()
  const cas = new Map<string, Famille>()
  for (const p of donnees.pfas) {
    pfas.set(compact(p.n), p.f)
    if (p.cas) for (const c of p.cas.split(/[\s/,;]+/)) if (/^\d{2,7}-\d{2}-\d$/.test(c)) cas.set(c, p.f)
  }
  const nonPfas = new Map<string, string>()
  for (const x of donnees.nonPfas) nonPfas.set(compact(x.n), x.r)
  return { pfas, cas, nonPfas }
}
