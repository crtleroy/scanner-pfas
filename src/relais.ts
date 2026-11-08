// Envoi d'une photo d'étiquette au relais Cloudflare, qui la fait lire par Claude.
import type { ReponseIA, ReponseRecherche } from './engine/ia.ts'

/** Adresse du relais : VITE_RELAIS_URL (fichier .env) en développement, sinon le relais publié. */
export const RELAIS_URL: string = import.meta.env.VITE_RELAIS_URL || 'https://scanner-pfas-relais.scanner-pfas-relais.workers.dev'

const CLE_CODE = 'code-acces'

export function codeAcces(): string | null {
  try {
    return localStorage.getItem(CLE_CODE)
  } catch {
    return null
  }
}

export function enregistrerCode(code: string | null) {
  try {
    if (code) localStorage.setItem(CLE_CODE, code.trim())
    else localStorage.removeItem(CLE_CODE)
  } catch {
    /* stockage interdit : le code sera redemandé */
  }
}

export type TypeErreur = 'code' | 'reseau' | 'limite' | 'image' | 'lecture' | 'service'

export class ErreurRelais extends Error {
  constructor(
    readonly type: TypeErreur,
    message: string,
  ) {
    super(message)
  }
}

const MESSAGES: Record<TypeErreur, string> = {
  code: 'Code d’accès manquant ou incorrect.',
  reseau: 'Pas de connexion avec le service de lecture. Vérifiez le réseau.',
  limite: 'Trop de lectures d’un coup : réessayez dans une minute.',
  image: 'La photo n’a pas pu être envoyée (format ou taille).',
  lecture: 'Claude n’a pas réussi à lire cette photo. Reprenez-la plus près, bien à plat.',
  service: 'Le service de lecture ne répond pas correctement pour le moment.',
}

function enBase64(blob: Blob): Promise<string> {
  return new Promise((resoudre, rejeter) => {
    const lecteur = new FileReader()
    lecteur.onload = () => resoudre(String(lecteur.result).split(',')[1] ?? '')
    lecteur.onerror = () => rejeter(lecteur.error)
    lecteur.readAsDataURL(blob)
  })
}

/**
 * Réduit l'image à 1568 px sur le grand côté (au-delà, Claude la réduit de toute façon)
 * et la convertit en JPEG.
 */
export async function preparerImage(source: CanvasImageSource, largeur: number, hauteur: number): Promise<Blob> {
  const echelle = Math.min(1, 1568 / Math.max(largeur, hauteur))
  const toile = document.createElement('canvas')
  toile.width = Math.round(largeur * echelle)
  toile.height = Math.round(hauteur * echelle)
  const ctx = toile.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, toile.width, toile.height)
  return new Promise((resoudre, rejeter) =>
    toile.toBlob((b) => (b ? resoudre(b) : rejeter(new Error('image'))), 'image/jpeg', 0.85),
  )
}

/** Réponse du relais à « analyser » (une ou plusieurs photos) */
export type ReponseAnalyse = {
  mode: 'liste' | 'produit'
  etiquette: ReponseIA
  /** Recherche déjà faite pour ce produit (mémoire partagée), quand il y en a une */
  recherche?: ReponseRecherche
  depuis_memoire?: boolean
}

export type ReponseRecherchee = { mode: 'recherche'; recherche: ReponseRecherche; depuis_memoire: boolean }

/** Photos d'un même produit → Claude lit la liste, ou reconnaît le produit */
export async function analyserPhotos(images: Blob[], codeBarres?: string): Promise<ReponseAnalyse> {
  const donnees = await Promise.all(images.map(enBase64))
  return appeler({ action: 'analyser', images: donnees, type: images[0]?.type || 'image/jpeg', code_barres: codeBarres })
}

/** Produit reconnu → recherche internet (ou mémoire partagée) */
export function rechercherProduit(
  produit: { marque: string | null; nom: string | null; categorie: string | null; niveau: string },
  codeBarres?: string,
  listeConnue = false,
): Promise<ReponseRecherchee> {
  // listeConnue : la composition a déjà été lue (photo ou base) → la recherche ne la cherche pas
  return appeler({ action: 'rechercher', produit, code_barres: codeBarres, liste_connue: listeConnue })
}

/** Recherche déjà faite pour ce code-barres ? (gratuit) */
export async function memoireCodeBarres(code: string): Promise<ReponseRecherchee | null> {
  if (!codeAcces()) return null
  try {
    const rep = await appeler<ReponseRecherchee | { mode: 'aucun' }>({ action: 'memoire', code_barres: code })
    return rep.mode === 'recherche' ? rep : null
  } catch {
    return null
  }
}

async function appeler<T>(corps: Record<string, unknown>): Promise<T> {
  const code = codeAcces()
  if (!code) throw new ErreurRelais('code', MESSAGES.code)
  let rep: Response
  try {
    rep = await fetch(RELAIS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Code-Acces': code },
      body: JSON.stringify(corps),
    })
  } catch {
    throw new ErreurRelais('reseau', MESSAGES.reseau)
  }
  if (rep.ok) return (await rep.json()) as T
  let type: TypeErreur = 'service'
  if (rep.status === 401) type = 'code'
  else if (rep.status === 429) type = 'limite'
  else if (rep.status === 400) type = 'image'
  else if (rep.status === 422 || rep.status === 502) {
    const corps = await rep.json().catch(() => ({}))
    type = corps?.erreur === 'lecture' || corps?.erreur === 'refus' ? 'lecture' : 'service'
  }
  throw new ErreurRelais(type, MESSAGES[type])
}
