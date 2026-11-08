import { useEffect, useRef, useState } from 'preact/hooks'
import { analyse, type Resultat, type Source } from './engine/analyse.ts'
import { analyseIA } from './engine/ia.ts'
import { chargerRessources, chercherProduit, type Produit } from './donnees.ts'
import { normaliserCode } from './codes.ts'
import { bip, debloquerSon, demarrerCamera, lireCode, type Camera } from './scanner.ts'
import { lireTexte, prechargerOcr, pretraiter, type Cadre } from './ocr.ts'
import { codeAcces, enregistrerCode, ErreurRelais, lireEtiquette, preparerImage } from './relais.ts'
import { T } from './textes.ts'
import { Recadrage } from './recadrage.tsx'
import { EcranResultat } from './resultat.tsx'
import { EcranSources } from './sources.tsx'

type Ecran =
  | { nom: 'scan' }
  | { nom: 'saisie' }
  | { nom: 'chargement'; message: string }
  | { nom: 'introuvable'; code: string; erreurs: string[] }
  | { nom: 'lecture-ia'; apercu: string }
  | { nom: 'code'; image?: Blob; erreur?: boolean }
  | { nom: 'erreur-ia'; message: string; image: Blob }
  | { nom: 'recadrage'; image: HTMLImageElement }
  | { nom: 'lecture'; progression: number; etape: string }
  | { nom: 'texte'; texte: string; source: 'photo' | 'texte' }
  | { nom: 'resultat'; resultat: Resultat; texte?: string; nomLu?: string }
  | { nom: 'sources' }
  | { nom: 'erreur'; message: string }

async function chargerImage(fichier: Blob): Promise<HTMLImageElement> {
  const img = new Image()
  img.src = URL.createObjectURL(fichier)
  await img.decode()
  return img
}

export function App() {
  const [ecran, setEcran] = useState<Ecran>({ nom: 'scan' })
  // Produit en cours : on le garde quand on photographie ensuite sa liste d'ingrédients
  const [produit, setProduit] = useState<Produit | undefined>()
  // Consigne affichée sur l'écran caméra (« visez la liste d'ingrédients… ») et code-barres à ignorer
  const [consigne, setConsigne] = useState<{ texte: string; ignorer?: string } | undefined>()
  const precedent = useRef<Ecran>({ nom: 'scan' })

  useEffect(() => {
    // Les listes (≈ 400 Ko compressés) se chargent en fond pour que la première analyse soit immédiate
    const t = setTimeout(() => chargerRessources().catch(() => {}), 1500)
    window.addEventListener('pointerdown', () => debloquerSon(), { once: true })
    // En développement seulement : « ?demo-ia » affiche un résultat de lecture par Claude sans photo
    if (import.meta.env.DEV && location.search.includes('demo-ia')) {
      chargerRessources().then((r) =>
        setEcran({
          nom: 'resultat',
          nomLu: 'Fond de teint (démonstration)',
          resultat: analyseIA(
            {
              type_produit: 'cosmetique',
              liste_trouvee: true,
              lisibilite: 'partielle',
              nom_produit: 'Fond de teint (démonstration)',
              remarque: 'Liste en anglais, la fin est cachée par le pouce.',
              texte_lu: 'AQUA, CYCLOPENTASILOXANE, PTFE, SODIUM FLUORIDE, TRIFLUOROPROPYL DIMETHICONE, PHENOXYETHANOL 0,8 %',
              ingredients: [
                { nom_lu: 'Aqua', nom_normalise: 'AQUA', quantite: null, commentaire: 'eau, base du produit' },
                { nom_lu: 'Cyclopentasiloxane', nom_normalise: 'CYCLOPENTASILOXANE', quantite: null, commentaire: 'silicone volatil, texture légère' },
                { nom_lu: 'PTFE', nom_normalise: 'PTFE', quantite: null, commentaire: 'poudre de texture glissante' },
                { nom_lu: 'Sodium Fluoride', nom_normalise: 'SODIUM FLUORIDE', quantite: null, commentaire: 'sel minéral de fluor' },
                { nom_lu: 'Trifluoropropyl Dimethicone', nom_normalise: 'TRIFLUOROPROPYL DIMETHICONE', quantite: null, commentaire: 'silicone filmogène' },
                { nom_lu: 'Phenoxyethanol', nom_normalise: 'PHENOXYETHANOL', quantite: '0,8 %', commentaire: 'conservateur' },
              ],
            },
            r,
          ),
        }),
      )
    }
    return () => clearTimeout(t)
  }, [])

  const accueil = () => {
    setProduit(undefined)
    setConsigne(undefined)
    setEcran({ nom: 'scan' })
  }

  /** Retour à la caméra pour photographier la liste d'ingrédients du produit en cours */
  const versEtiquette = (code?: string) => {
    setConsigne({ texte: T.scan.consigneListe, ignorer: code ?? produit?.code })
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
    setConsigne(undefined)
    setEcran({ nom: 'chargement', message: T.chargement.bases })
    const { produit: p, erreurs } = await chercherProduit(code)
    if (!p) {
      setEcran({ nom: 'introuvable', code, erreurs })
      return
    }
    setProduit(p)
    await analyser(p.ingredients ?? '', p.base.id, p)
  }

  /** Photo d'étiquette → relais → Claude → nos règles PFAS */
  async function lireAvecClaude(image: Blob) {
    if (!codeAcces()) {
      setEcran({ nom: 'code', image })
      return
    }
    const apercu = URL.createObjectURL(image)
    setEcran({ nom: 'lecture-ia', apercu })
    try {
      const [rep, r] = await Promise.all([lireEtiquette(image), chargerRessources()])
      setConsigne(undefined)
      setEcran({ nom: 'resultat', resultat: analyseIA(rep, r), nomLu: rep.nom_produit ?? undefined })
    } catch (e) {
      if (e instanceof ErreurRelais && e.type === 'code') {
        enregistrerCode(null)
        setEcran({ nom: 'code', image, erreur: true })
      } else {
        setEcran({ nom: 'erreur-ia', message: e instanceof ErreurRelais ? e.message : T.ia.erreur, image })
      }
    } finally {
      URL.revokeObjectURL(apercu)
    }
  }

  /** Photo prise avec l'appareil photo du téléphone (quand la caméra en direct n'est pas disponible) */
  async function surPhotoEtiquette(e: Event) {
    const entree = e.currentTarget as HTMLInputElement
    const fichier = entree.files?.[0]
    entree.value = ''
    if (!fichier) return
    try {
      const img = await chargerImage(fichier)
      const image = await preparerImage(img, img.naturalWidth, img.naturalHeight)
      URL.revokeObjectURL(img.src)
      lireAvecClaude(image)
    } catch {
      setEcran({ nom: 'erreur', message: 'Impossible d’ouvrir cette photo.' })
    }
  }

  /** Secours hors ligne : lecture de la photo par Tesseract, dans le téléphone */
  async function lireSurLeTelephone(image: Blob) {
    prechargerOcr()
    try {
      setEcran({ nom: 'recadrage', image: await chargerImage(image) })
    } catch {
      setEcran({ nom: 'erreur', message: 'Impossible d’ouvrir cette photo.' })
    }
  }

  async function surPhotoTesseract(e: Event) {
    const entree = e.currentTarget as HTMLInputElement
    const fichier = entree.files?.[0]
    entree.value = ''
    if (fichier) lireSurLeTelephone(fichier)
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
          consigne={consigne?.texte}
          ignorer={consigne?.ignorer}
          surCode={surCode}
          onEtiquette={lireAvecClaude}
          onOublierConsigne={() => setConsigne(undefined)}
          onSaisir={() => vers({ nom: 'saisie' })}
          onSources={() => vers({ nom: 'sources' })}
        />
      )
      break
    case 'saisie':
      contenu = <EcranSaisie onCode={surCode} onTexte={() => vers({ nom: 'texte', texte: '', source: 'texte' })} onRetour={accueil} />
      break
    case 'chargement':
      contenu = <EcranAttente message={ecran.message} />
      break
    case 'lecture':
      contenu = <EcranAttente message={ecran.etape} progression={ecran.progression} />
      break
    case 'lecture-ia':
      contenu = <EcranAttente message={T.ia.lecture} apercu={ecran.apercu} />
      break
    case 'code':
      contenu = (
        <EcranCode
          erreur={!!ecran.erreur}
          onValider={(code) => {
            enregistrerCode(code)
            if (ecran.image) lireAvecClaude(ecran.image)
            else accueil()
          }}
          onRetour={accueil}
        />
      )
      break
    case 'erreur-ia':
      contenu = (
        <div class="ecran">
          <div class="defilement">
            <h1>{T.ia.titreErreur}</h1>
            <p>{ecran.message}</p>
          </div>
          <footer class="actions">
            <button class="bouton principal" onClick={() => lireAvecClaude(ecran.image)}>
              {T.boutons.reessayer}
            </button>
            <button class="bouton secondaire" onClick={() => lireSurLeTelephone(ecran.image)}>
              {T.boutons.photoAppli}
            </button>
            <button class="bouton discret" onClick={() => setEcran({ nom: 'scan' })}>
              {T.boutons.retour}
            </button>
          </footer>
        </div>
      )
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
            <button class="bouton principal" onClick={() => versEtiquette(ecran.code)}>
              {T.boutons.lireEtiquette}
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
          nomLu={ecran.nomLu}
          onAutre={accueil}
          onCorriger={() => vers({ nom: 'texte', texte: ecran.texte ?? '', source: ecran.resultat.source === 'photo' ? 'photo' : 'texte' })}
          onLireEtiquette={() => versEtiquette()}
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
      <input id="entree-etiquette" type="file" accept="image/*" capture="environment" class="cache" onChange={surPhotoEtiquette} />
      <input id="entree-photo" type="file" accept="image/*" capture="environment" class="cache" onChange={surPhotoTesseract} />
    </div>
  )
}

function EcranScan(props: {
  consigne?: string
  /** Code-barres à ignorer (celui du produit dont on photographie la liste) */
  ignorer?: string
  surCode: (c: string) => void
  onEtiquette: (image: Blob) => void
  onOublierConsigne: () => void
  onSaisir: () => void
  onSources: () => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const camera = useRef<Camera | null>(null)
  // Toujours les valeurs à jour dans le rappel de la caméra, qui tourne en continu
  const surCodeActuel = useRef(props.surCode)
  surCodeActuel.current = props.surCode
  const ignorerActuel = useRef(props.ignorer)
  ignorerActuel.current = props.ignorer
  const [etat, setEtat] = useState<'demarrage' | 'actif' | 'lu' | 'refus' | 'indisponible'>('demarrage')
  const [message, setMessage] = useState('')
  const [capture, setCapture] = useState(false)

  useEffect(() => {
    let annule = false
    if (!navigator.mediaDevices?.getUserMedia) {
      setEtat('indisponible')
      return
    }
    demarrerCamera(video.current!, (code) => {
      if (ignorerActuel.current === code) return false
      setEtat('lu')
      bip()
      setTimeout(() => surCodeActuel.current(code), 350)
    })
      .then((c) => {
        if (annule) c.arreter()
        else {
          camera.current = c
          setEtat((e) => (e === 'lu' ? e : 'actif'))
        }
      })
      .catch((err: { name?: string }) => {
        if (!annule) setEtat(err?.name === 'NotAllowedError' ? 'refus' : 'indisponible')
      })
    return () => {
      annule = true
      camera.current?.arreter()
      camera.current = null
    }
  }, [])

  async function declencher() {
    if (!camera.current || capture) return
    debloquerSon()
    setCapture(true)
    try {
      const image = await camera.current.capturer()
      props.onEtiquette(image)
    } catch {
      setMessage(T.scan.captureRatee)
      setCapture(false)
    }
  }

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
    else if (etat === 'actif') texte = props.consigne ? '' : T.scan.viser
    else if (etat === 'lu') texte = T.scan.lu
    else if (etat === 'refus') texte = T.scan.refus
    else texte = T.scan.indisponible
  }

  return (
    <div class="ecran scan">
      <video ref={video} class="video" playsInline muted autoPlay />
      <header class="scan-entete">
        <span class="titre-appli">
          {T.appli} <small class="version">version du {__VERSION__}</small>
        </span>
        <button class="lien-clair" onClick={props.onSources}>
          {T.boutons.sources}
        </button>
      </header>
      {props.consigne && (
        <div class="consigne" role="status">
          <span>{props.consigne}</span>
          <button class="lien-clair" onClick={props.onOublierConsigne} aria-label="Fermer la consigne">
            ✕
          </button>
        </div>
      )}
      {!sansCamera && (
        <div class="viseur" aria-hidden="true">
          <div class={`cadre${etat === 'lu' ? ' lu' : ''}`} />
        </div>
      )}
      {texte && (
        <p class={`scan-message${sansCamera ? ' fort' : ''}`} role="status">
          {texte}
        </p>
      )}
      <footer class="actions sombre">
        {sansCamera ? (
          <>
            <label for="entree-etiquette" class="bouton principal">
              {T.boutons.photoEtiquette}
            </label>
            <label for="entree-photo-code" class="bouton secondaire">
              {T.scan.photoCode}
            </label>
          </>
        ) : (
          <button class="bouton principal declencheur" disabled={etat !== 'actif' || capture} onClick={declencher}>
            <span class="pastille-photo" aria-hidden="true" />
            {capture ? T.scan.capture : T.boutons.lireEtiquette}
          </button>
        )}
        <button class="bouton secondaire" onClick={props.onSaisir}>
          {T.boutons.saisirCode}
        </button>
      </footer>
      <input id="entree-photo-code" type="file" accept="image/*" capture="environment" class="cache" onChange={surPhotoCode} />
    </div>
  )
}

function EcranSaisie(props: { onCode: (c: string) => void; onTexte: () => void; onRetour: () => void }) {
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
        <button class="lien" onClick={props.onTexte}>
          {T.saisie.collerTexte}
        </button>
      </div>
      <footer class="actions">
        <button class="bouton discret" onClick={props.onRetour}>
          {T.boutons.retour}
        </button>
      </footer>
    </div>
  )
}

function EcranCode(props: { erreur: boolean; onValider: (code: string) => void; onRetour: () => void }) {
  const [code, setCode] = useState('')
  return (
    <div class="ecran">
      <div class="defilement">
        <h1>{T.code.titre}</h1>
        <p>{T.code.texte}</p>
        {props.erreur && <p class="avertissement">{T.code.erreur}</p>}
        <form
          class="champ"
          onSubmit={(e) => {
            e.preventDefault()
            if (code.trim()) props.onValider(code)
          }}
        >
          <label for="code-acces">{T.code.libelle}</label>
          <input
            id="code-acces"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellcheck={false}
            value={code}
            onInput={(e) => setCode((e.currentTarget as HTMLInputElement).value)}
          />
        </form>
      </div>
      <footer class="actions">
        <button class="bouton principal" disabled={!code.trim()} onClick={() => props.onValider(code)}>
          {T.boutons.valider}
        </button>
        <button class="bouton discret" onClick={props.onRetour}>
          {T.boutons.retour}
        </button>
      </footer>
    </div>
  )
}

function EcranTexte(props: { texte: string; photo: boolean; onAnalyser: (t: string) => void; onRetour: () => void }) {
  const [texte, setTexte] = useState(props.texte)
  return (
    <div class="ecran">
      <div class="defilement">
        <h1>{props.photo ? T.texte.titrePhoto : T.texte.titre}</h1>
        {props.photo && !props.texte && <p class="avertissement">{T.texte.vide}</p>}
        <p class="aide">{T.texte.aide}</p>
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
        {props.photo && (
          <label for="entree-photo" class="bouton secondaire">
            {T.boutons.reprendre}
          </label>
        )}
        <button class="bouton discret" onClick={props.onRetour}>
          {T.boutons.retour}
        </button>
      </footer>
    </div>
  )
}

function EcranAttente(props: { message: string; progression?: number; apercu?: string }) {
  return (
    <div class="ecran attente">
      {props.apercu && <img class="apercu" src={props.apercu} alt="" />}
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
