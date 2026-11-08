import { useEffect, useRef, useState } from 'preact/hooks'
import { analyse, type Resultat, type Source } from './engine/analyse.ts'
import { ajouterRecherche, analyseIA, analyseRecherche } from './engine/ia.ts'
import { chargerRessources, chercherProduit, type Produit } from './donnees.ts'
import { normaliserCode } from './codes.ts'
import { debloquerSon, demarrerCamera, lireCode, type Camera } from './scanner.ts'
import { lireTexte, prechargerOcr, pretraiter, type Cadre } from './ocr.ts'
import { analyserPhotos, codeAcces, enregistrerCode, ErreurRelais, memoireCodeBarres, preparerImage, rechercherProduit } from './relais.ts'
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
  | { nom: 'recherche-en-cours'; apercu?: string; produit: string }
  | { nom: 'code'; image?: Blob; erreur?: boolean }
  | { nom: 'erreur-ia'; message: string; image: Blob }
  | { nom: 'recadrage'; image: HTMLImageElement }
  | { nom: 'lecture'; progression: number; etape: string }
  | { nom: 'texte'; texte: string; source: 'photo' | 'texte' }
  | {
      nom: 'resultat'
      resultat: Resultat
      texte?: string
      nomLu?: string
      /** Photo prise par l'utilisateur, affichée en haut */
      photo?: string
      /** Recherche internet : en cours, échouée, ou impossible (produit non identifié) */
      rechercheEtat?: 'en_cours' | 'erreur' | 'aucune'
    }
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
  // Photos du produit en cours (pour compléter une liste coupée) et code-barres inconnu des bases
  const photos = useRef<Blob[]>([])
  const completer = useRef(false)
  const [codeInconnu, setCodeInconnu] = useState<string | undefined>()
  // Jeton de la photo en cours : une recherche qui revient après un changement de produit est ignorée
  const jeton = useRef(0)
  // Adresse locale de la photo du produit, gardée pour l'afficher en haut du résultat
  const photoProduit = useRef<string | undefined>()
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
    // En développement seulement : « ?demo-recherche » affiche le résultat d'une recherche internet
    if (import.meta.env.DEV && location.search.includes('demo-recherche')) {
      const src = (n: number) => [`https://source${n}.exemple/page`]
      chargerRessources().then((r) =>
        setEcran({
          nom: 'resultat',
          resultat: analyseRecherche(
            {
              produit: { marque: 'Elephant', nom: null, categorie: 'bouillotte' },
              composition_trouvee: false,
              ingredients: [],
              sources_composition: [],
              preuves: {
                niveau: 'inconnu',
                commentaire: 'Aucune analyse ni certification sur les PFAS trouvée pour les bouillottes de la marque.',
                faits: [{ texte: 'Une analyse de 20 bouillottes n’a trouvé aucun composé fluoré.', date: '2023', sources: src(1), portee: 'categorie' }],
              },
              bases: [{ nom: 'Safety Gate (rappels UE)', resultat: '3 rappels de bouillottes pour phtalates depuis 2020.', url: src(2)[0], portee: 'categorie' }],
              historique: [{ texte: 'La marque vend des bouillottes en caoutchouc naturel depuis 1985.', date: '1985', sources: src(3), portee: 'marque' }],
              marque_dit: [],
              autres_disent: [{ texte: 'Une association conseille les bouillottes en caoutchouc naturel plutôt qu’en PVC.', date: '2024', sources: src(4), portee: 'categorie' }],
              autres_substances: [
                { texte: 'Des HAP ont été mesurés dans des bouillottes en caoutchouc noir bon marché.', date: '2022', sources: src(2), portee: 'categorie' },
              ],
              deduction_categorie: { niveau: 'peu_probable', explication: 'Une bouillotte en caoutchouc ou en PVC ne contient en général pas de PFAS.' },
              contradictions: [],
              sources: [1, 2, 3, 4].map((n) => ({ titre: `Source ${n}`, url: src(n)[0] })),
              remarque: null,
              recherches: 6,
            },
            r,
          ),
        }),
      )
    }
    return () => clearTimeout(t)
  }, [])

  const libererPhoto = () => {
    if (photoProduit.current) URL.revokeObjectURL(photoProduit.current)
    photoProduit.current = undefined
  }

  const accueil = () => {
    jeton.current++
    libererPhoto()
    setProduit(undefined)
    setConsigne(undefined)
    setCodeInconnu(undefined)
    photos.current = []
    completer.current = false
    setEcran({ nom: 'scan' })
  }

  /** Retour à la caméra pour photographier la liste d'ingrédients (ou le produit) en cours */
  const versEtiquette = (code?: string) => {
    if (code) setCodeInconnu(code)
    completer.current = false
    setConsigne({ texte: T.scan.consigneListe })
    setEcran({ nom: 'scan' })
  }

  /** Liste coupée : une photo de plus, envoyée avec les précédentes */
  const completerPhoto = () => {
    completer.current = true
    setConsigne({ texte: T.scan.consigneSuite })
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

  /** Code-barres tapé à la main : base ouverte, puis recherche internet sur le produit */
  async function surCode(code: string) {
    const n = ++jeton.current
    libererPhoto()
    setProduit(undefined)
    setConsigne(undefined)
    photos.current = []
    completer.current = false
    setEcran({ nom: 'chargement', message: T.chargement.bases })
    const { produit: p, erreurs } = await chercherProduit(code)
    if (jeton.current !== n) return
    if (!p) {
      // Inconnu des bases ouvertes, mais peut-être déjà recherché d'après une photo (mémoire partagée)
      setCodeInconnu(code)
      const [connu, r] = await Promise.all([memoireCodeBarres(code), chargerRessources().catch(() => null)])
      if (jeton.current !== n) return
      if (connu && r) {
        setEcran({ nom: 'resultat', resultat: analyseRecherche(connu.recherche, r, true) })
        return
      }
      setEcran({ nom: 'introuvable', code, erreurs })
      return
    }
    setProduit(p)
    try {
      const r = await chargerRessources()
      const res = analyse(p.ingredients ?? '', { source: p.base.id, categories: p.categories, nomProduit: p.nom }, r)
      if (!p.nom || !codeAcces()) {
        setEcran({ nom: 'resultat', resultat: res, rechercheEtat: 'aucune' })
        return
      }
      setEcran({ nom: 'resultat', resultat: res, rechercheEtat: 'en_cours' })
      try {
        const rech = await rechercherProduit({ marque: p.marque ?? null, nom: p.nom, categorie: null, niveau: 'modele' }, code, !!p.ingredients)
        if (jeton.current === n) setEcran({ nom: 'resultat', resultat: ajouterRecherche(res, rech.recherche, rech.depuis_memoire) })
      } catch {
        if (jeton.current === n) setEcran({ nom: 'resultat', resultat: res, rechercheEtat: 'erreur' })
      }
    } catch {
      setEcran({ nom: 'erreur', message: 'Impossible de charger les listes d’ingrédients. Vérifiez la connexion et réessayez.' })
    }
  }

  /**
   * Une photo, et l'appli décide : code-barres visible (lu dans le téléphone) → base ouverte ;
   * liste d'ingrédients → lue par Claude ; sinon le produit est reconnu. Puis, dès que le produit est identifié,
   * recherche internet (preuves, bases, historique, marque, avis) en fond. Le verdict PFAS vient de nos règles.
   */
  async function traiterPhoto(image: Blob, pleineDefinition?: CanvasImageSource) {
    if (!codeAcces()) {
      setEcran({ nom: 'code', image })
      return
    }
    const n = ++jeton.current
    const ajout = completer.current
    const images = ajout ? [...photos.current, image].slice(-4) : [image]
    if (!ajout) {
      libererPhoto()
      photoProduit.current = URL.createObjectURL(image)
    }
    setEcran({ nom: 'lecture-ia', apercu: photoProduit.current ?? URL.createObjectURL(image) })
    try {
      // 1. Code-barres sur la photo, lu dans le téléphone (gratuit)
      let code = ajout ? (produit?.code ?? codeInconnu) : undefined
      if (!ajout && pleineDefinition) code = (await lireCode(pleineDefinition).catch(() => null)) ?? undefined
      // 2. En même temps : Claude lit la photo, et la base ouverte est interrogée si un code a été lu
      const [rep, trouve, r] = await Promise.all([
        analyserPhotos(images, code),
        !ajout && code ? chercherProduit(code).catch(() => null) : Promise.resolve(null),
        chargerRessources(),
      ])
      if (jeton.current !== n) return
      photos.current = images
      completer.current = false
      setConsigne(undefined)
      const pBase = trouve?.produit ?? (ajout ? produit : undefined)
      setProduit(pBase ?? undefined)
      setCodeInconnu(code && !pBase ? code : undefined)

      const et = rep.etiquette
      let res: Resultat | null = null
      if (et.liste_trouvee && et.ingredients.length) res = analyseIA(et, r)
      else if (pBase?.ingredients)
        res = analyse(pBase.ingredients, { source: pBase.base.id, categories: pBase.categories, nomProduit: pBase.nom }, r)
      const pc = et.produit
      // Du plus précis au plus général : produit de la base, sinon ce que Claude a reconnu (modèle, marque ou type)
      const identite = pBase?.nom
        ? { marque: pBase.marque ?? null, nom: pBase.nom, categorie: pc?.categorie ?? null, niveau: 'modele' }
        : pc && pc.niveau !== 'aucun' && (pc.categorie || pc.marque || pc.nom)
          ? { marque: pc.marque, nom: pc.nom, categorie: pc.categorie, niveau: pc.niveau }
          : null
      const extra = { photo: photoProduit.current, nomLu: et.nom_produit ?? undefined }

      // Déjà recherché (mémoire partagée) : tout s'affiche d'un coup
      if (rep.recherche) {
        const final = res ? ajouterRecherche(res, rep.recherche, true) : analyseRecherche(rep.recherche, r, true)
        setEcran({ nom: 'resultat', resultat: final, ...extra })
        return
      }
      if (!identite) {
        setEcran({ nom: 'resultat', resultat: res ?? analyseIA(et, r), ...extra, rechercheEtat: 'aucune' })
        return
      }
      if (res) setEcran({ nom: 'resultat', resultat: res, ...extra, rechercheEtat: 'en_cours' })
      else
        setEcran({
          nom: 'recherche-en-cours',
          apercu: photoProduit.current,
          produit: [identite.categorie && !identite.nom ? identite.categorie : null, identite.marque, identite.nom].filter(Boolean).join(' '),
        })
      try {
        const rech = await rechercherProduit(identite, code, !!res)
        if (jeton.current !== n) return
        const final = res ? ajouterRecherche(res, rech.recherche, rech.depuis_memoire) : analyseRecherche(rech.recherche, r, rech.depuis_memoire)
        setEcran({ nom: 'resultat', resultat: final, ...extra })
      } catch (e) {
        if (jeton.current !== n) return
        if (res) setEcran({ nom: 'resultat', resultat: res, ...extra, rechercheEtat: 'erreur' })
        else throw e
      }
    } catch (e) {
      if (jeton.current !== n) return
      if (e instanceof ErreurRelais && e.type === 'code') {
        enregistrerCode(null)
        setEcran({ nom: 'code', image, erreur: true })
      } else {
        setEcran({ nom: 'erreur-ia', message: e instanceof ErreurRelais ? e.message : T.ia.erreur, image })
      }
    }
  }

  // En développement seulement : porte d'entrée pour tester le parcours photo sans caméra
  if (import.meta.env.DEV) (window as unknown as { __traiterPhoto: typeof traiterPhoto }).__traiterPhoto = traiterPhoto

  /** Photo prise avec l'appareil photo du téléphone (quand la caméra en direct n'est pas disponible) */
  async function surPhotoEtiquette(e: Event) {
    const entree = e.currentTarget as HTMLInputElement
    const fichier = entree.files?.[0]
    entree.value = ''
    if (!fichier) return
    try {
      const img = await chargerImage(fichier)
      const image = await preparerImage(img, img.naturalWidth, img.naturalHeight)
      traiterPhoto(image, img)
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
          onPhoto={traiterPhoto}
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
      contenu = <EcranAttente apercu={ecran.apercu} />
      break
    case 'recherche-en-cours':
      contenu = <EcranAttente apercu={ecran.apercu} titre={ecran.produit} message={T.ia.recherche} />
      break
    case 'code':
      contenu = (
        <EcranCode
          erreur={!!ecran.erreur}
          onValider={(code) => {
            enregistrerCode(code)
            if (ecran.image) traiterPhoto(ecran.image)
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
            <button class="bouton principal" onClick={() => traiterPhoto(ecran.image)}>
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
          photo={ecran.photo}
          rechercheEtat={ecran.rechercheEtat}
          onAutre={accueil}
          onCorriger={() => vers({ nom: 'texte', texte: ecran.texte ?? '', source: ecran.resultat.source === 'photo' ? 'photo' : 'texte' })}
          onLireEtiquette={() => versEtiquette()}
          onCompleter={completerPhoto}
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
  onPhoto: (image: Blob, pleineDefinition?: CanvasImageSource) => void
  onOublierConsigne: () => void
  onSaisir: () => void
  onSources: () => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const camera = useRef<Camera | null>(null)
  const [etat, setEtat] = useState<'demarrage' | 'actif' | 'refus' | 'indisponible'>('demarrage')
  const [capture, setCapture] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let annule = false
    if (!navigator.mediaDevices?.getUserMedia) {
      setEtat('indisponible')
      return
    }
    demarrerCamera(video.current!)
      .then((c) => {
        if (annule) c.arreter()
        else {
          camera.current = c
          setEtat('actif')
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
      const photo = await camera.current.capturer()
      props.onPhoto(photo.image, photo.toile)
    } catch {
      setMessage(T.scan.captureRatee)
      setCapture(false)
    }
  }

  const sansCamera = etat === 'refus' || etat === 'indisponible'
  let texte = message
  if (!texte && etat === 'refus') texte = T.scan.refus
  else if (!texte && etat === 'indisponible') texte = T.scan.indisponible

  return (
    <div class="ecran scan">
      <video ref={video} class="video" playsInline muted autoPlay />
      <header class="scan-entete">
        <span class="titre-appli">
          {T.appli} <small class="version">version du {__VERSION__}</small>
        </span>
        <span class="liens-entete">
          <button class="lien-clair" onClick={props.onSaisir}>
            {T.boutons.saisirCodeCourt}
          </button>
          <button class="lien-clair" onClick={props.onSources}>
            {T.boutons.sources}
          </button>
        </span>
      </header>
      {props.consigne && (
        <div class="consigne" role="status">
          <span>{props.consigne}</span>
          <button class="lien-clair" onClick={props.onOublierConsigne} aria-label="Fermer la consigne">
            ✕
          </button>
        </div>
      )}
      <div class="scan-espace">{texte && <p class="scan-message fort">{texte}</p>}</div>
      <footer class="zone-declencheur">
        {sansCamera ? (
          <label for="entree-etiquette" class="bouton-photo" aria-label={T.boutons.photo}>
            <span />
          </label>
        ) : (
          <button class="bouton-photo" disabled={etat !== 'actif' || capture} onClick={declencher} aria-label={T.boutons.photo}>
            <span />
          </button>
        )}
        <small>{capture ? T.scan.capture : T.scan.aide}</small>
      </footer>
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

function EcranAttente(props: { message?: string; progression?: number; apercu?: string; titre?: string }) {
  return (
    <div class="ecran attente">
      {props.apercu && <img class="apercu" src={props.apercu} alt="" />}
      {props.titre && <strong class="attente-titre">{props.titre}</strong>}
      <div class="roue" aria-label="Lecture en cours" role="status" />
      {props.message && <p role="status">{props.message}</p>}
      {props.progression !== undefined && (
        <div class="barre">
          <div style={{ width: `${Math.round(props.progression * 100)}%` }} />
        </div>
      )}
    </div>
  )
}
