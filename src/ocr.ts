// Lecture de la liste d'ingrédients sur une photo (Tesseract.js, dans le navigateur, rien n'est envoyé).

export interface Cadre {
  x: number
  y: number
  l: number
  h: number
}

/** Recadre, passe en niveaux de gris, renforce le contraste et agrandit (×2 au plus) avant l'OCR. */
export function pretraiter(image: HTMLImageElement, c: Cadre): HTMLCanvasElement {
  let echelle = Math.min(2, 2400 / c.l)
  // Safari limite la taille des canvas (environ 16 millions de pixels)
  const aire = c.l * c.h * echelle * echelle
  if (aire > 12e6) echelle *= Math.sqrt(12e6 / aire)
  const toile = document.createElement('canvas')
  toile.width = Math.max(1, Math.round(c.l * echelle))
  toile.height = Math.max(1, Math.round(c.h * echelle))
  const ctx = toile.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, c.x, c.y, c.l, c.h, 0, 0, toile.width, toile.height)

  const img = ctx.getImageData(0, 0, toile.width, toile.height)
  const p = img.data
  const n = p.length / 4
  const gris = new Uint8ClampedArray(n)
  const histo = new Uint32Array(256)
  let somme = 0
  for (let i = 0; i < n; i++) {
    const v = (p[i * 4] * 299 + p[i * 4 + 1] * 587 + p[i * 4 + 2] * 114) / 1000
    gris[i] = v
    histo[gris[i]]++
    somme += v
  }
  // Étirement du contraste entre les centiles 2 et 98
  let cumul = 0
  let bas = 0
  let haut = 255
  for (let v = 0; v < 256; v++) {
    cumul += histo[v]
    if (cumul < n * 0.02) bas = v
    if (cumul < n * 0.98) haut = v
  }
  const etendue = Math.max(1, haut - bas)
  // Texte clair sur fond foncé : on inverse pour avoir du texte foncé sur fond clair
  const inverser = somme / n < 110
  for (let i = 0; i < n; i++) {
    let v = ((gris[i] - bas) * 255) / etendue
    if (inverser) v = 255 - v
    p[i * 4] = p[i * 4 + 1] = p[i * 4 + 2] = v
  }
  ctx.putImageData(img, 0, 0)
  return toile
}

type Progres = (progression: number, etape: string) => void
let ecouteur: Progres | null = null
let travailleur: Promise<import('tesseract.js').Worker> | null = null

const ETAPES: Record<string, string> = {
  'loading tesseract core': 'Chargement du moteur de lecture…',
  'initializing tesseract': 'Préparation du moteur de lecture…',
  'loading language traineddata': 'Chargement du français et de l’anglais…',
  'initializing api': 'Préparation…',
  'recognizing text': 'Lecture du texte…',
}

function obtenirTravailleur() {
  travailleur ??= import('tesseract.js').then(async ({ createWorker }) => {
    const w = await createWorker(['fra', 'eng'], 1, {
      logger: (m: { status: string; progress: number }) => ecouteur?.(m.progress ?? 0, ETAPES[m.status] ?? 'Lecture…'),
    })
    // Bloc de texte uniforme : c'est la forme d'une liste d'ingrédients
    await w.setParameters({ tessedit_pageseg_mode: '6' as never, preserve_interword_spaces: '1' })
    return w
  })
  travailleur.catch(() => (travailleur = null))
  return travailleur
}

/** Lance le chargement du moteur en avance (pendant le recadrage). */
export function prechargerOcr() {
  obtenirTravailleur().catch(() => {})
}

export async function lireTexte(toile: HTMLCanvasElement, progres: Progres): Promise<string> {
  ecouteur = progres
  try {
    const w = await obtenirTravailleur()
    const { data } = await w.recognize(toile)
    return data.text.replace(/\n{3,}/g, '\n\n').trim()
  } finally {
    ecouteur = null
  }
}
