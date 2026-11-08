// Accès aux données : bases de produits Open Facts (en direct) et listes embarquées (JSON).
import { preparerListes, type Ressources, type Source } from './engine/analyse.ts'
import { Dictionnaire } from './engine/dictionnaire.ts'
import { compact, type Famille } from './engine/rules.ts'

const BASE = import.meta.env.BASE_URL

export interface Base {
  id: Source
  nom: string
  site: string
}

export const BASES: Base[] = [
  { id: 'base_beaute', nom: 'Open Beauty Facts', site: 'https://world.openbeautyfacts.org' },
  { id: 'base_alimentaire', nom: 'Open Food Facts', site: 'https://world.openfoodfacts.org' },
  { id: 'base_produits', nom: 'Open Products Facts', site: 'https://world.openproductsfacts.org' },
]

export interface Produit {
  code: string
  base: Base
  nom?: string
  marque?: string
  image?: string
  categories: string[]
  ingredients?: string
}

const CHAMPS =
  'code,product_name,product_name_fr,brands,ingredients_text,ingredients_text_fr,ingredients_text_en,image_front_small_url,image_front_url,categories_tags'

interface ProduitOff {
  product_name?: string
  product_name_fr?: string
  brands?: string
  ingredients_text?: string
  ingredients_text_fr?: string
  ingredients_text_en?: string
  image_front_small_url?: string
  image_front_url?: string
  categories_tags?: string[]
}

async function interroger(base: Base, code: string, signal: AbortSignal): Promise<Produit | null> {
  const rep = await fetch(`${base.site}/api/v2/product/${code}.json?fields=${CHAMPS}`, { signal })
  if (rep.status === 404) return null
  if (!rep.ok) throw new Error(`${base.nom} : HTTP ${rep.status}`)
  const json = (await rep.json()) as { status?: number; product?: ProduitOff }
  if (json.status !== 1 || !json.product) return null
  const p = json.product
  const ingredients = (p.ingredients_text_fr || p.ingredients_text || p.ingredients_text_en || '').trim()
  return {
    code,
    base,
    nom: (p.product_name_fr || p.product_name || '').trim() || undefined,
    marque: p.brands?.split(',')[0]?.trim() || undefined,
    image: p.image_front_small_url || p.image_front_url,
    categories: p.categories_tags ?? [],
    ingredients: ingredients || undefined,
  }
}

const DUREE_CACHE = 7 * 24 * 3600 * 1000

function lireCache(code: string): Produit | null | undefined {
  try {
    const brut = localStorage.getItem(`produit:${code}`)
    if (!brut) return undefined
    const { date, produit } = JSON.parse(brut)
    if (Date.now() - date > DUREE_CACHE) return undefined
    return produit
  } catch {
    return undefined
  }
}

function ecrireCache(code: string, produit: Produit | null) {
  try {
    localStorage.setItem(`produit:${code}`, JSON.stringify({ date: Date.now(), produit }))
  } catch {
    /* stockage plein ou interdit : pas grave */
  }
}

export interface Recherche {
  produit: Produit | null
  /** Bases qui n'ont pas pu être interrogées (réseau, CORS…) */
  erreurs: string[]
}

/**
 * Interroge les trois bases en parallèle et garde la première réponse qui contient des ingrédients.
 * Sinon, le premier produit trouvé (nom et catégorie servent à estimer le risque).
 */
export async function chercherProduit(code: string): Promise<Recherche> {
  const enCache = lireCache(code)
  if (enCache !== undefined) return { produit: enCache, erreurs: [] }

  const controle = new AbortController()
  const minuterie = setTimeout(() => controle.abort(), 10000)
  const erreurs: string[] = []
  const trouves: (Produit | null)[] = new Array(BASES.length).fill(null)

  const produit = await new Promise<Produit | null>((resoudre) => {
    let restantes = BASES.length
    BASES.forEach((base, i) => {
      interroger(base, code, controle.signal)
        .then((p) => {
          trouves[i] = p
          if (p?.ingredients) resoudre(p)
        })
        .catch(() => erreurs.push(base.nom))
        .finally(() => {
          if (--restantes === 0) resoudre(trouves.find((p) => p) ?? null)
        })
    })
  })
  clearTimeout(minuterie)
  controle.abort()
  // On ne garde en cache une absence que si toutes les bases ont répondu
  if (produit || erreurs.length === 0) ecrireCache(code, produit)
  return { produit, erreurs }
}

// ---------- Listes embarquées ----------

export interface ListePfasJson {
  source: { nom: string; url: string; licence: string; date: string }
  methode: string
  pfas: { n: string; cas?: string; f: Famille }[]
  nonPfas: { n: string; r: string }[]
}

export interface Explications {
  general: { titre: string; quoi: string; pourquoi: string; probleme: string; definition: string; source: Lien }
  familles: Record<Famille, { titre: string; quoi: string; pourquoi: string; probleme: string }>
  exclu: { titre: string; texte: string }
  possible: { titre: string; texte: string }
  reglementaire: { texte: string; source: Lien }
  gravite: {
    niveaux: Record<'elevee' | 'moderee' | 'faible', { titre: string; texte: string }>
    conseils: Record<'cosmetique' | 'cuisine' | 'textile' | 'emballage' | 'autre', string[]>
  }
  aliment: string
  mention: string
  limites: string
}
export interface Lien {
  nom: string
  url: string
}

let ressources: Promise<Ressources & { pfasJson: ListePfasJson }> | null = null

async function json<T>(chemin: string): Promise<T> {
  const rep = await fetch(`${BASE}${chemin}`)
  if (!rep.ok) throw new Error(`${chemin} : HTTP ${rep.status}`)
  return rep.json() as Promise<T>
}

/** Dictionnaire INCI et listes PFAS, chargés une seule fois. */
export function chargerRessources() {
  ressources ??= Promise.all([
    json<{ e: [string, string, string, string][] }>('data/inci.json'),
    json<ListePfasJson>('data/pfas.json'),
  ]).then(([inci, pfasJson]) => ({
    dictionnaire: new Dictionnaire(
      inci.e,
      pfasJson.pfas.map((p) => p.n),
    ),
    listes: preparerListes(pfasJson),
    pfasJson,
  }))
  ressources.catch(() => (ressources = null))
  return ressources
}

let explications: Promise<Explications> | null = null
export function chargerExplications() {
  explications ??= json<Explications>('data/explications.json')
  explications.catch(() => (explications = null))
  return explications
}

/** Description CosIng et restrictions d'un ingrédient (fichiers découpés par initiale). */
export async function chargerDetails(nom: string): Promise<{ description: string; restriction: string } | null> {
  const cle = compact(nom)
  if (!cle) return null
  const tiroir = /[a-z]/.test(cle[0]) ? cle[0] : '0'
  try {
    const t = await json<Record<string, [string, string]>>(`data/details/${tiroir}.json`)
    const d = t[cle]
    return d ? { description: d[0], restriction: d[1] } : null
  } catch {
    return null
  }
}
