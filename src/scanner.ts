// Lecture des codes-barres : API native quand elle existe (Chrome Android), sinon ZXing en WebAssembly (Safari iOS).
import { BarcodeDetector as BarcodeDetectorZxing, prepareZXingModule } from 'barcode-detector/ponyfill'
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'
import { normaliserCode } from './codes.ts'
import { preparerImage } from './relais.ts'

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'] as const

interface Detecte {
  rawValue: string
  format: string
}
export interface Detecteur {
  detect(source: CanvasImageSource | ImageBitmap | ImageData): Promise<Detecte[]>
}

let detecteur: Promise<Detecteur> | null = null

export function obtenirDetecteur(): Promise<Detecteur> {
  detecteur ??= (async () => {
    const Natif = (globalThis as { BarcodeDetector?: any }).BarcodeDetector
    if (Natif?.getSupportedFormats) {
      try {
        const formats: string[] = await Natif.getSupportedFormats()
        if (FORMATS.every((f) => formats.includes(f))) return new Natif({ formats: [...FORMATS] }) as Detecteur
      } catch {
        /* on passe au repli */
      }
    }
    // Le fichier .wasm est servi avec l'appli (pas de CDN), pour marcher hors ligne.
    prepareZXingModule({
      overrides: {
        locateFile: (chemin: string, prefixe: string) => (chemin.endsWith('.wasm') ? wasmUrl : prefixe + chemin),
      },
    })
    return new BarcodeDetectorZxing({ formats: [...FORMATS] }) as unknown as Detecteur
  })()
  return detecteur
}

/** Premier code valide (clé de contrôle correcte) trouvé dans une image. */
export async function lireCode(source: CanvasImageSource | ImageBitmap): Promise<string | null> {
  const d = await obtenirDetecteur()
  const resultats = await d.detect(source)
  for (const r of resultats) {
    const code = normaliserCode(r.rawValue, r.format)
    if (code) return code
  }
  return null
}

export interface Photo {
  /** Image prête à envoyer (JPEG, 1568 px au plus) */
  image: Blob
  /** Image en pleine définition, pour y chercher un code-barres dans le téléphone */
  toile: HTMLCanvasElement
}

export interface Camera {
  arreter(): void
  /** Prend une photo dans l'image de la caméra */
  capturer(): Promise<Photo>
}

/**
 * Démarre la caméra arrière dans `video`, comme un appareil photo : pas de lecture continue.
 * Le code-barres éventuel est cherché sur la photo prise (voir lireCode).
 */
export async function demarrerCamera(video: HTMLVideoElement): Promise<Camera> {
  const flux = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  })
  const piste = flux.getVideoTracks()[0]
  try {
    await piste.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] })
  } catch {
    /* mise au point automatique non réglable : tant pis */
  }
  video.srcObject = flux
  video.setAttribute('playsinline', '')
  video.muted = true
  await video.play()

  return {
    arreter() {
      for (const p of flux.getTracks()) p.stop()
      video.srcObject = null
    },
    async capturer() {
      const toile = document.createElement('canvas')
      toile.width = video.videoWidth
      toile.height = video.videoHeight
      toile.getContext('2d')!.drawImage(video, 0, 0)
      const image = await preparerImage(toile, toile.width, toile.height)
      return { image, toile }
    },
  }
}

// Petit bip de confirmation (pas de vibration sur Safari iOS).
let audio: AudioContext | null = null
export function debloquerSon() {
  try {
    audio ??= new AudioContext()
    if (audio.state === 'suspended') audio.resume()
  } catch {
    /* pas de son */
  }
}
export function bip() {
  try {
    if (!audio || audio.state !== 'running') return
    const o = audio.createOscillator()
    const g = audio.createGain()
    o.frequency.value = 1320
    g.gain.setValueAtTime(0.15, audio.currentTime)
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.15)
    o.connect(g).connect(audio.destination)
    o.start()
    o.stop(audio.currentTime + 0.15)
  } catch {
    /* pas de son */
  }
}
