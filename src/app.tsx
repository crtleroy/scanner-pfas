import { useEffect, useRef, useState } from 'preact/hooks'
import { analyse, type Resultat, type Source } from './engine/analyse.ts'
import { chargerRessources, chercherProduit, type Produit } from './donnees.ts'
import { normaliserCode } from './codes.ts'
import { bip, debloquerSon, demarrerCamera, lireCode, type Camera } from './scanner.ts'
import { lireTexte, prechargerOcr, pretraiter, type Cadre } from './ocr.ts'
import { T } from './textes.ts'
import { Recadrage } from './recadrage.tsx'
import { EcranResultat } from './resultat.tsx'
import { EcranSources } from './sources.tsx'

type Ecran =
  | { nom: 'scan' }
  | { nom: 'saisie' }
  | { nom: 'chargement'; message: string }
  | { nom: 'introuvable'; code: string; erreurs: string[] }
  | { nom: 'recadrage'; image: HTMLImageElement }
  | { nom: 'lecture'; progression: number; etape: string }
  | { nom: 'texte'; texte: string; source: 'photo' | 'texte' }
  | { nom: 'resultat'; resultat: Resultat; texte?: string }
  | { nom: 'sources' }
  | { nom: 'erreur'; message: string }

async function chargerImage(fichier: File): Promise<HTMLImageElement> {
  const img = new Image()
  img.src = URL.createObjectURL(fichier)
  await img.decode()
  return img
}

export function App() {
  const [ecran, setEcran] = useState<Ecran>({ nom: 'scan' })
  // Produit en cours : on le garde quand on passe à la photo des ingrédients
  const [produit, setProduit] = useState<Produit | undefined>()
  const precedent = useRef<Ecran>({ nom: 'scan' })

  useEffect(() => {
    // Les listes (≈ 400 Ko compressés) se chargent en fond pour que la première analyse soit immédiate
    const t = setTimeout(() => chargerRessources().catch(() => {}), 1500)
    const debloquer = () => debloquerSon()
    window.addEventListener('pointerdown', debloquer, { once: true })
    return () => clearTimeout(t)
  }, [])

  const accueil = () => {
    setProduit(undefined)
    setEcran({ nom: 'scan' })
  }

  async function analyser(texte: string, source: Source, p?: Produit) {
    setEcran({ nom: 'chargement', message: T.chargement.listes })
    try {
      const r = await chargerRessources()
      const resultat = analyse(texte, { source, categories: p?.categories, nomProduit: p?.nom }, r)
      setEcran({ nom: 'resultat', resultat, texte })
    } catch {
      setEcran({ nom: 'erreur', message: 'Impossible de charger les listes d’ingrédients. Vérifiez la connexion et réessayez.' })
    }
  }

  async function surCode(code: string) {
    setProduit(undefined)
    setEcran({ nom: 'chargement', message: T.chargement.bases })
    const { produit: p, erreurs } = await chercherProduit(code)
    if (!p) {
      setEcran({ nom: 'introuvable', code, erreurs })
      return
    }
    setProduit(p)
    await analyser(p.ingredients ?? '', p.base.id, p)
  }

  async function surPhotoIngredients(e: Event) {
    const entree = e.currentTarget as HTMLInputElement
    const fichier = entree.files?.[0]
    entree.value = ''
    if (!fichier) return
    prechargerOcr()
    try {
      const image = await chargerImage(fichier)
      setEcran({ nom: 'recadrage', image })
    } catch {
      setEcran({ nom: 'erreur', message: 'Impossible d’ouvrir cette photo.' })
    }
  }

  async function lire(image: HTMLImageElement, cadre: Cadre) {
    setEcran({ nom: 'lecture', progression: 0, etape: 'Préparation de la photo…' })
    await new Promise((r) => setTimeout(r, 50))
    try {
      const toile = pretraiter(image, cadre)
      const texte = await lireTexte(toile, (progression, etape) => setEcran({ nom: 'lecture', progression, etape }))
      setEcran({ nom: 'texte', texte, source: 'photo' })
    } catch {
      setEcran({
        nom: 'erreur',
        message: 'La lecture du texte a échoué. La première fois, le moteur de lecture se télécharge (une dizaine de Mo) : vérifiez la connexion et réessayez.',
      })
    }
  }

  function vers(e: Ecran) {
    precedent.current = ecran
    setEcran(e)
  }

  let contenu
  switch (ecran.nom) {
    case 'scan':
      contenu = (
        <EcranScan
          surCode={surCode}
          onLireListe={() => vers({ nom: 'texte', texte: '', source: 'texte' })}
          onSaisir={() => vers({ nom: 'saisie' })}
          onSources={() => vers({ nom: 'sources' })}
        />
      )
      break
    case 'saisie':
      contenu = <EcranSaisie onCode={surCode} onRetour={accueil} />
      break
    case 'chargement':
      contenu = <EcranAttente message={ecran.message} />
      break
    case 'lecture':
      contenu = <EcranAttente message={ecran.etape} progression={ecran.progression} />
      break
    case 'introuvable':
      contenu = (
        <div class="ecran">
          <div class="defilement">
            <h1>{T.introuvable.titre}</h1>
            <p class="code">Code {ecran.code}</p>
            <p>{T.introuvable.texte}</p>
            {ecran.erreurs.length > 0 && (
              <p class="avertissement">
                {T.introuvable.reseau} {ecran.erreurs.join(', ')}.
              </p>
            )}
          </div>
          <footer class="actions">
            <button class="bouton principal" onClick={() => vers({ nom: 'texte', texte: '', source: 'texte' })}>
              {T.boutons.lireListe}
            </button>
            <button class="bouton discret" onClick={accueil}>
              {T.boutons.retour}
            </button>
          </footer>
        </div>
      )
      break
    case 'recadrage':
      contenu = <Recadrage image={ecran.image} onValider={(c) => lire(ecran.image, c)} onAnnuler={accueil} />
      break
    case 'texte':
      contenu = (
        <EcranTexte
          texte={ecran.texte}
          photo={ecran.source === 'photo'}
          onAnalyser={(t) => analyser(t, ecran.source, produit)}
          onRetour={accueil}
        />
      )
      break
    case 'resultat':
      contenu = (
        <EcranResultat
          resultat={ecran.resultat}
          produit={produit}
          onAutre={accueil}
          onCorriger={() => vers({ nom: 'texte', texte: ecran.texte ?? '', source: ecran.resultat.source === 'photo' ? 'photo' : 'texte' })}
          onLireListe={() => vers({ nom: 'texte', texte: '', source: 'texte' })}
          onSources={() => vers({ nom: 'sources' })}
        />
      )
      break
    case 'sources':
      contenu = <EcranSources onRetour={() => setEcran(precedent.current.nom === 'sources' ? { nom: 'scan' } : precedent.current)} />
      break
    case 'erreur':
      contenu = (
        <div class="ecran">
          <div class="defilement">
            <h1>Oups</h1>
            <p>{ecran.message}</p>
          </div>
          <footer class="actions">
            <button class="bouton principal" onClick={accueil}>
              {T.boutons.retour}
            </button>
          </footer>
        </div>
      )
  }

  return (
    <div class="appli">
      {contenu}
      <input id="entree-photo" type="file" accept="image/*" capture="environment" class="cache" onChange={surPhotoIngredients} />
      <input id="entree-galerie" type="file" accept="image/*" class="cache" onChange={surPhotoIngredients} />
    </div>
  )
}

function EcranScan(props: { surCode: (c: string) => void; onLireListe: () => void; onSaisir: () => void; onSources: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [etat, setEtat] = useState<'demarrage' | 'actif' | 'lu' | 'refus' | 'indisponible'>('demarrage')
  const [message, setMessage] = useState('')

  useEffect(() => {
    let camera: Camera | undefined
    let annule = false
    if (!navigator.mediaDevices?.getUserMedia) {
      setEtat('indisponible')
      return
    }
    demarrerCamera(video.current!, (code) => {
      setEtat('lu')
      bip()
      setTimeout(() => props.surCode(code), 350)
    })
      .then((c) => {
        if (annule) c.arreter()
        else {
          camera = c
          setEtat((e) => (e === 'lu' ? e : 'actif'))
        }
      })
      .catch((err: { name?: string }) => {
        if (!annule) setEtat(err?.name === 'NotAllowedError' ? 'refus' : 'indisponible')
      })
    return () => {
      annule = true
      camera?.arreter()
    }
  }, [])

  async function surPhotoCode(e: Event) {
    const entree = e.currentTarget as HTMLInputElement
    const fichier = entree.files?.[0]
    entree.value = ''
    if (!fichier) return
    setMessage('Lecture du code-barres…')
    try {
      const image = await chargerImage(fichier)
      const code = await lireCode(image)
      URL.revokeObjectURL(image.src)
      if (code) props.surCode(code)
      else setMessage(T.scan.aucunCode)
    } catch {
      setMessage(T.scan.aucunCode)
    }
  }

  const sansCamera = etat === 'refus' || etat === 'indisponible'
  let texte = message
  if (!texte) {
    if (etat === 'demarrage') texte = T.scan.demarrage
    else if (etat === 'actif') texte = T.scan.viser
    else if (etat === 'lu') texte = T.scan.lu
    else if (etat === 'refus') texte = T.scan.refus
    else texte = T.scan.indisponible
  }

  return (
    <div class="ecran scan">
      <video ref={video} class="video" playsInline muted autoPlay />
      <header class="scan-entete">
        <span class="titre-appli">{T.appli}</span>
        <button class="lien-clair" onClick={props.onSources}>
          {T.boutons.sources}
        </button>
      </header>
      {!sansCamera && (
        <div class="viseur" aria-hidden="true">
          <div class={`cadre${etat === 'lu' ? ' lu' : ''}`} />
        </div>
      )}
      <p class={`scan-message${sansCamera ? ' fort' : ''}`} role="status">
        {texte}
      </p>
      <footer class="actions sombre">
        {sansCamera && (
          <label for="entree-photo-code" class="bouton principal">
            {T.scan.photoCode}
          </label>
        )}
        <button class={`bouton ${sansCamera ? 'secondaire' : 'principal'}`} onClick={props.onLireListe}>
          {T.boutons.lireListe}
        </button>
        <button class="bouton secondaire" onClick={props.onSaisir}>
          {T.boutons.saisirCode}
        </button>
      </footer>
      <input id="entree-photo-code" type="file" accept="image/*" capture="environment" class="cache" onChange={surPhotoCode} />
    </div>
  )
}

function EcranSaisie(props: { onCode: (c: string) => void; onRetour: () => void }) {
  const [code, setCode] = useState('')
  const [cleFausse, setCleFausse] = useState(false)

  function chercher(e: Event) {
    e.preventDefault()
    const chiffres = code.replace(/\D/g, '')
    if (!chiffres) return
    const n = normaliserCode(chiffres)
    if (n) props.onCode(n)
    else setCleFausse(true)
  }

  return (
    <div class="ecran">
      <div class="defilement">
        <h1>{T.saisie.titre}</h1>
        <form class="champ" onSubmit={chercher}>
          <label for="code">{T.saisie.code}</label>
          <div class="ligne">
            <input
              id="code"
              inputMode="numeric"
              autoComplete="off"
              placeholder="3600523000000"
              value={code}
              onInput={(e) => {
                setCode((e.currentTarget as HTMLInputElement).value)
                setCleFausse(false)
              }}
            />
            <button class="bouton principal compact" type="submit">
              {T.boutons.chercher}
            </button>
          </div>
          <small>{T.saisie.codeAide}</small>
          {cleFausse && (
            <p class="avertissement">
              {T.saisie.cleFausse}{' '}
              <button type="button" class="lien" onClick={() => props.onCode(code.replace(/\D/g, ''))}>
                {T.boutons.chercherQuandMeme}
              </button>
            </p>
          )}
        </form>
      </div>
      <footer class="actions">
        <button class="bouton discret" onClick={props.onRetour}>
          {T.boutons.retour}
        </button>
      </footer>
    </div>
  )
}

// « ?ios » dans l'adresse force le guide iPhone (pour le vérifier depuis un PC)
const IOS =
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
  new URLSearchParams(location.search).has('ios')

/** Icône « Scanner du texte » d'iOS : des lignes de texte dans un cadre à coins. */
function IconeScanTexte() {
  return (
    <svg class="icone-scan" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />
      <path d="M7 9h10M7 12h10M7 15h6" />
    </svg>
  )
}

function EcranTexte(props: { texte: string; photo: boolean; onAnalyser: (t: string) => void; onRetour: () => void }) {
  const [texte, setTexte] = useState(props.texte)
  const guide = !texte.trim()
  return (
    <div class="ecran">
      <div class="defilement">
        <h1>{props.photo ? T.texte.titrePhoto : T.texte.titre}</h1>
        {props.photo && !props.texte && <p class="avertissement">{T.texte.vide}</p>}
        {guide && IOS && (
          <div class="guide">
            <strong>{T.texte.iosTitre}</strong>
            <ol>
              <li>{T.texte.ios1}</li>
              <li>
                {T.texte.ios2} <IconeScanTexte /> {T.texte.ios2bis}
              </li>
              <li>{T.texte.ios3}</li>
            </ol>
            <small>{T.texte.iosNote}</small>
          </div>
        )}
        {guide && !IOS && <p class="guide">{T.texte.android}</p>}
        {!guide && <p class="aide">{T.texte.aide}</p>}
        <textarea
          class="texte-ocr"
          placeholder={T.texte.placeholder}
          autoCapitalize="off"
          autoCorrect="off"
          spellcheck={false}
          value={texte}
          onInput={(e) => setTexte((e.currentTarget as HTMLTextAreaElement).value)}
        />
      </div>
      <footer class="actions">
        <button class="bouton principal" disabled={!texte.trim()} onClick={() => props.onAnalyser(texte)}>
          {T.boutons.analyser}
        </button>
        <label for="entree-photo" class="bouton secondaire">
          {props.photo ? T.boutons.reprendre : T.boutons.photoAppli}
        </label>
        <button class="bouton discret" onClick={props.onRetour}>
          {T.boutons.retour}
        </button>
      </footer>
    </div>
  )
}

function EcranAttente(props: { message: string; progression?: number }) {
  return (
    <div class="ecran attente">
      <div class="roue" aria-hidden="true" />
      <p role="status">{props.message}</p>
      {props.progression !== undefined && (
        <div class="barre">
          <div style={{ width: `${Math.round(props.progression * 100)}%` }} />
        </div>
      )}
    </div>
  )
}
