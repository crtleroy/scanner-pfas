// Moteur d'analyse : fonction pure, testée à part de l'interface.
import { compact, estPfas, type Famille, type ListesPfas } from './rules.ts'
import { lire, type IngredientAnalyse, type Morceau } from './lecture.ts'
import type { Dictionnaire } from './dictionnaire.ts'

export type { IngredientAnalyse, Morceau } from './lecture.ts'

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

export interface Resultat {
  verdict: Verdict
  titre: string
  phrase: string
  confiance: Confiance
  /** Ingrédients trouvés, sans doublon (un même ingrédient lu deux fois n'apparaît qu'une fois) */
  ingredients: IngredientAnalyse[]
  /** Texte analysé et découpage pour l'affichage surligné */
  texte: string
  morceaux: Morceau[]
  /** Part du texte utile qui correspond à un ingrédient, de 0 à 1 */
  partComprise: number
  /** Texte d'aliment (tableau nutritionnel, base Open Food Facts) */
  aliment: boolean
  /** Mise en garde à afficher sous le verdict */
  avertissement?: string
  categorieARisque?: string
  familles: Famille[]
  source: Source
}

/** Analyse un texte d'étiquette ou une liste d'ingrédients. */
export function analyse(entree: string | string[], contexte: Contexte, r: Ressources): Resultat {
  const texte = typeof entree === 'string' ? entree : entree.join(', ')
  const lecture = lire(texte, r)
  return conclure(texte, lecture.ingredients, lecture.morceaux, lecture.partComprise, contexte)
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

/** Un tableau nutritionnel signale un aliment. */
export function estTexteAliment(texte: string): boolean {
  const t = texte.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const indices = [/valeurs? nutritionnelles?/, /\bkcal\b|\d\s*kcal/, /\bglucides\b/, /\bproteines\b/, /matieres grasses/, /nutrition facts/, /\bsucres\b/]
  return indices.filter((r) => r.test(t)).length >= 2
}

function pluriel(n: number, mot: string): string {
  return `${n} ${mot}${n > 1 ? 's' : ''}`
}

export function conclure(
  texte: string,
  ingredients: IngredientAnalyse[],
  morceaux: Morceau[],
  partComprise: number,
  contexte: Contexte,
): Resultat {
  const source = contexte.source
  const aliment = source === 'base_alimentaire' || source === 'base_produits' || estTexteAliment(texte)
  const base = { ingredients, texte, morceaux, partComprise, aliment, source }
  const familles = [...new Set(ingredients.flatMap((i) => (estPfas(i.classement.niveau) && i.classement.famille ? [i.classement.famille] : [])))]
  const textePresent = /[\p{L}]{2}/u.test(texte)

  if (!textePresent) {
    if (source === 'photo' || source === 'texte')
      return { ...base, verdict: 'gris', titre: 'Indéterminé', phrase: 'Aucun texte à analyser.', confiance: 'faible', familles }
    const risque = categorieARisque(contexte.categories, contexte.nomProduit)
    if (risque)
      return {
        ...base,
        verdict: 'orange',
        titre: 'À vérifier',
        phrase: `Composition inconnue. Ce type de produit (${risque}) contient parfois des PFAS : lisez la liste des ingrédients.`,
        confiance: 'faible',
        categorieARisque: risque,
        familles,
      }
    return {
      ...base,
      verdict: 'gris',
      titre: 'Indéterminé',
      phrase: 'La base ne connaît pas la composition de ce produit : lisez la liste des ingrédients au dos.',
      confiance: 'faible',
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
      familles,
    }
  }

  const reconnus = ingredients.filter((i) => i.reconnu).length

  // Aliments : les PFAS n'y sont jamais déclarés comme ingrédients, et les noms ne sont pas des noms INCI
  if (aliment) {
    return {
      ...base,
      verdict: 'vert',
      titre: 'Aucun PFAS détecté',
      phrase: 'Aucun PFAS dans la liste d’ingrédients.',
      confiance: 'moyenne',
      familles,
    }
  }

  if (reconnus === 0) {
    return {
      ...base,
      verdict: 'gris',
      titre: 'Indéterminé',
      phrase: 'Rien dans ce texte ne correspond à un ingrédient connu. Vérifiez que c’est bien la liste d’ingrédients, ou corrigez le texte.',
      confiance: 'faible',
      familles,
    }
  }

  const complet = partComprise >= 0.85
  const confiance: Confiance = complet ? 'élevée' : partComprise >= 0.5 ? 'moyenne' : 'faible'
  const marqueur = /ingr[eé]dien|composition|\binci\b|excipient|zutaten/i.test(texte)
  let avertissement: string | undefined
  if (partComprise < 0.3)
    avertissement = 'La plus grande partie du texte n’a pas été comprise : ce n’est peut-être pas la liste d’ingrédients.'
  else if (!marqueur && reconnus <= 3 && partComprise < 0.6)
    avertissement = 'Ce texte ne ressemble pas à une liste d’ingrédients : pas de mention « Ingrédients » ou « Composition », et peu d’ingrédients reconnus.'
  return {
    ...base,
    verdict: 'vert',
    titre: 'Aucun PFAS détecté',
    phrase: complet ? 'Aucun PFAS dans la composition déclarée.' : 'Aucun PFAS dans ce qui a été lu.',
    confiance,
    ...(avertissement ? { avertissement } : {}),
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
