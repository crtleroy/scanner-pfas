import { useEffect, useState } from 'preact/hooks'
import type { IngredientAnalyse, Morceau, Resultat } from './engine/analyse.ts'
import { estPfas } from './engine/rules.ts'
import { evaluerGravite, usageDuProduit } from './engine/gravite.ts'
import { chargerDetails, chargerExplications, chargerRessources, type Explications, type Produit } from './donnees.ts'
import { T, traduireFonctions } from './textes.ts'

const LIBELLE_SOURCE: Record<Resultat['source'], string> = {
  base_beaute: 'Open Beauty Facts',
  base_alimentaire: 'Open Food Facts',
  base_produits: 'Open Products Facts',
  photo: 'photo de l’étiquette, lue sur le téléphone (Tesseract)',
  texte: 'texte saisi ou collé',
  ia: 'photo de l’étiquette, lue par Claude Haiku 5.5 (Anthropic)',
  recherche: 'produit reconnu sur la photo, composition cherchée sur internet par Claude Haiku 5.5 (Anthropic)',
}

function classeIngredient(i: IngredientAnalyse): string {
  if (estPfas(i.classement.niveau)) return 'pfas'
  if (i.classement.niveau === 'possible') return 'possible'
  if (i.classement.niveau === 'exclu') return 'exclu'
  if (!i.reconnu) return 'inconnu'
  return 'reconnu'
}

interface Infos {
  date: string
  nbPfas: number
  entrees: [string, string, string, string][]
}

type Cible =
  | { type: 'ingredient'; ing: IngredientAnalyse; lu?: string; morceau?: Morceau }
  | { type: 'bruit'; lu: string }
  | { type: 'general' }

export function EcranResultat(props: {
  resultat: Resultat
  produit?: Produit
  /** Nom du produit lu sur la photo par Claude */
  nomLu?: string
  onAutre: () => void
  onCorriger: () => void
  onLireEtiquette: () => void
  onCompleter: () => void
  onSources: () => void
}) {
  const { resultat: r, produit } = props
  const [expl, setExpl] = useState<Explications | null>(null)
  const [infos, setInfos] = useState<Infos | null>(null)
  const [fiche, setFiche] = useState<Cible | null>(null)

  useEffect(() => {
    chargerExplications().then(setExpl).catch(() => {})
    chargerRessources()
      .then((x) => setInfos({ date: x.pfasJson.source.date, nbPfas: x.pfasJson.pfas.length, entrees: x.dictionnaire.entrees }))
      .catch(() => {})
  }, [])

  const ia = r.source === 'ia' || r.source === 'recherche'
  const rech = r.recherche
  const gravite = evaluerGravite(r)
  const depuisBase = r.source.startsWith('base_')
  // La mention réglementaire ne concerne que les cosmétiques (pas une poêle ni un textile)
  const cosmetique = usageDuProduit(r) === 'cosmetique'
  const lignes = r.ingredients.filter((i) => i.reconnu || i.classement.niveau !== 'aucun')
  const signales = r.ingredients.filter((i) => i.classement.niveau !== 'aucun')
  const nbBruits = r.morceaux.filter((m) => m.type === 'bruit').length
  const aDuTexte = r.texte.trim().length > 0

  /** Commentaire d'une ligne : l'état PFAS d'abord (nos règles), puis ce qu'est l'ingrédient */
  function commentaire(i: IngredientAnalyse) {
    const n = i.classement.niveau
    let etat = null
    if (estPfas(n))
      etat = <span class="etat pfas">PFAS · {expl?.familles[i.classement.famille ?? 'autre']?.titre ?? 'famille des PFAS'}</span>
    else if (n === 'possible') etat = <span class="etat possible">Fluoré, à vérifier</span>
    else if (n === 'exclu') etat = <span class="etat exclu">Contient du fluor, pas un PFAS</span>
    else if (!i.reconnu) etat = <span class="etat inconnu">Non reconnu</span>
    const fonctions = i.index !== undefined ? infos?.entrees[i.index]?.[3] : undefined
    const texte = i.commentaire ?? (fonctions ? traduireFonctions(fonctions) : '')
    return (
      <>
        {etat}
        {etat && texte && <br />}
        {texte}
      </>
    )
  }

  return (
    <div class="ecran resultat">
      <div class="defilement">
        {produit ? (
          <div class="produit">
            {produit.image && <img src={produit.image} alt="" />}
            <div>
              <strong>{produit.nom ?? 'Produit sans nom'}</strong>
              {produit.marque && <span>{produit.marque}</span>}
              <small>Code {produit.code}</small>
            </div>
          </div>
        ) : rech ? (
          <div class="produit">
            <div>
              <strong>{[rech.produit.marque, rech.produit.nom].filter(Boolean).join(' ')}</strong>
              {rech.produit.categorie && <span>{rech.produit.categorie}</span>}
              <small>{rech.depuisMemoire ? T.recherche.memoire : T.recherche.reconnu}</small>
            </div>
          </div>
        ) : (
          props.nomLu && (
            <div class="produit">
              <div>
                <strong>{props.nomLu}</strong>
              </div>
            </div>
          )
        )}

        <section class={`verdict ${r.verdict}`} aria-live="polite">
          <h1>
            <span class="pastille" aria-hidden="true" />
            {r.titre}
          </h1>
          <p class="phrase">{r.phrase}</p>
          {lignes.length > 0 && (
            <p class="confiance">
              {T.resultat.confiance} : {r.confiance} · {lignes.length} ingrédient{lignes.length > 1 ? 's' : ''}
              {!r.aliment && !ia && ` · ${Math.round(r.partComprise * 100)} % du texte compris`}
            </p>
          )}
          {r.verdict !== 'vert' && (
            <button class="lien" onClick={() => setFiche({ type: 'general' })}>
              {T.resultat.qu_est_ce}
            </button>
          )}
        </section>

        {/* Les contradictions ont leur propre encadré : pas de doublon */}
        {r.avertissement && !(rech && rech.contradictions.length) && <p class="avertissement">{r.avertissement}</p>}
        {r.listeIncomplete && (
          <button class="bouton secondaire completer" onClick={props.onCompleter}>
            {T.boutons.completer}
          </button>
        )}
        {rech && rech.contradictions.length > 0 && (
          <section class="alerte-contradiction">
            <h2>{T.recherche.contradictions}</h2>
            <ul>
              {rech.contradictions.map((c, n) => (
                <li key={n}>{c}</li>
              ))}
            </ul>
          </section>
        )}
        {gravite && expl && (
          <section class={`carte gravite ${gravite.niveau}`}>
            <h2>
              <span class="jauge" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              {expl.gravite.niveaux[gravite.niveau].titre}
            </h2>
            <p>{expl.gravite.niveaux[gravite.niveau].texte}</p>
            {gravite.raisons.length > 0 && (
              <ul class="liste-simple">
                {gravite.raisons.map((x, n) => (
                  <li key={n}>{x}</li>
                ))}
              </ul>
            )}
            {gravite.familles.map((f) => (
              <details key={f}>
                <summary>{expl.familles[f].titre} : les risques</summary>
                <p>{expl.familles[f].probleme}</p>
              </details>
            ))}
            <h3>{T.gravite.conseils}</h3>
            <ul class="liste-simple">
              {expl.gravite.conseils[gravite.usage].map((c, n) => (
                <li key={n}>{c}</li>
              ))}
            </ul>
          </section>
        )}
        {r.remarque && <p class="note">{r.remarque}</p>}
        {r.aliment && expl && <p class="note">{expl.aliment}</p>}
        {r.verdict === 'rouge' && cosmetique && expl && <p class="reglementaire">{expl.reglementaire.texte}</p>}
        {produit && !produit.ingredients && !ia && <p class="aide">{T.resultat.sansComposition}</p>}

        {lignes.length > 0 && (
          <section class="carte tableau-carte">
            <h2>
              {T.resultat.ingredients} ({lignes.length})
            </h2>
            <table class="tableau-ing">
              <thead>
                <tr>
                  <th>{T.resultat.colIngredient}</th>
                  <th>{T.resultat.colQuantite}</th>
                  <th>{T.resultat.colCommentaire}</th>
                </tr>
              </thead>
              <tbody>
                {lignes.map((i, n) => (
                  <tr key={n} class={classeIngredient(i)} onClick={() => setFiche({ type: 'ingredient', ing: i })}>
                    <td class="nom">
                      {i.nom}
                      {ia && i.brut.trim().toLowerCase() !== i.nom.trim().toLowerCase() && <small>lu : {i.brut}</small>}
                    </td>
                    <td class="qte">{i.quantite ?? '—'}</td>
                    <td class="com">{commentaire(i)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p class="aide">{T.resultat.toucherLigne}</p>
          </section>
        )}

        {rech && rech.indices.length > 0 && (
          <section class="carte">
            <h2>{T.recherche.indices}</h2>
            <ul class="indices">
              {rech.indices.map((i, n) => (
                <li key={n} class={i.sens}>
                  <span class="sens">{T.recherche.sens[i.sens]}</span> {i.fait}
                  {i.source && (
                    <>
                      {' '}
                      <a href={i.source} target="_blank" rel="noopener">
                        ({domaine(i.source)})
                      </a>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {rech && (
          <section class="carte">
            <h2>{T.recherche.sources}</h2>
            {rech.sources.length ? (
              <ul class="liste-simple">
                {rech.sources.map((s, n) => (
                  <li key={n}>
                    <a href={s.url} target="_blank" rel="noopener">
                      {s.titre || domaine(s.url)}
                    </a>{' '}
                    <small>({domaine(s.url)})</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="aide">{T.recherche.aucuneSource}</p>
            )}
            {rech.deduction.explication && rech.deduction.niveau !== 'inconnu' && (
              <p class="aide">
                {T.recherche.deduction} {rech.deduction.explication}
              </p>
            )}
          </section>
        )}
        {aDuTexte && (
          <details class="carte" open={r.verdict === 'gris'}>
            <summary>{ia ? T.resultat.texteLuIA : T.resultat.texteLu}</summary>
            {ia ? (
              <p class="texte-lu">{r.texte}</p>
            ) : (
              <>
                <Legende bruits={nbBruits > 0 && !r.aliment} />
                <p class="texte-lu">
                  <TexteSurligne
                    resultat={r}
                    onIngredient={(ing, lu, morceau) => setFiche({ type: 'ingredient', ing, lu, morceau })}
                    onBruit={(lu) => setFiche({ type: 'bruit', lu })}
                  />
                </p>
              </>
            )}
          </details>
        )}

        <details class="carte">
          <summary>{T.resultat.commentTrouve}</summary>
          <ul class="liste-simple">
            <li>
              Composition : {LIBELLE_SOURCE[r.source]}
              {produit && depuisBase && ` (code ${produit.code})`}.
            </li>
            {rech && (
              <li>
                {rech.depuisMemoire
                  ? 'Résultat d’une recherche déjà faite pour ce produit (mémoire partagée), sans nouvelle recherche payante.'
                  : `Recherche internet : ${rech.recherches} recherche${rech.recherches > 1 ? 's' : ''} (4 au plus par produit).`}
              </li>
            )}
            {ia ? (
              <li>
                Claude a recopié la liste d’ingrédients et rédigé les commentaires. Le verdict PFAS ne vient pas de Claude :
                l’appli vérifie chaque nom dans ses propres listes (CosIng et définition OCDE 2021).
              </li>
            ) : (
              <li>
                L’appli cherche chaque nom d’ingrédient connu partout dans le texte, mot par mot, en tolérant une à trois
                lettres fausses selon la longueur du nom. Elle reconnaît aussi les numéros CAS et quelques noms commerciaux.
              </li>
            )}
            {signales.map((i, n) => (
              <li key={n}>
                <strong>{i.nom}</strong> : {i.classement.regle}
                {i.correction && ` (lu « ${i.brut} »)`}.
              </li>
            ))}
            {nbBruits > 0 && !r.aliment && (
              <li>
                {nbBruits} morceau{nbBruits > 1 ? 'x' : ''} de texte non compris : ni ingrédient connu, ni racine fluorée.
              </li>
            )}
            {r.categorieARisque && <li>Catégorie à risque : {r.categorieARisque}.</li>}
            {infos && (
              <li>
                Listes : CosIng (Commission européenne) via Open Beauty Facts, et {infos.nbPfas} noms INCI classés PFAS
                selon la définition OCDE 2021. Mise à jour du {new Date(infos.date).toLocaleDateString('fr-FR')}.
              </li>
            )}
            {expl && <li>{expl.limites}</li>}
          </ul>
          <button class="lien" onClick={props.onSources}>
            {T.boutons.sources}
          </button>
        </details>

        {expl && <p class="mention">{expl.mention}</p>}
        {produit && depuisBase && (
          <p class="licence">
            Données : {produit.base.nom}, contributeurs, licence ODbL ·{' '}
            <a href={`${produit.base.site}/product/${produit.code}`} target="_blank" rel="noopener">
              voir la fiche
            </a>
          </p>
        )}
      </div>

      <footer class="actions">
        <button class="bouton principal" onClick={props.onAutre}>
          {T.boutons.autreProduit}
        </button>
        {ia ? (
          <button class="bouton secondaire" onClick={props.onLireEtiquette}>
            {T.boutons.reprendre}
          </button>
        ) : depuisBase ? (
          <button class="bouton secondaire" onClick={props.onLireEtiquette}>
            {T.boutons.lireEtiquette}
          </button>
        ) : (
          <button class="bouton secondaire" onClick={props.onCorriger}>
            {T.boutons.corriger}
          </button>
        )}
      </footer>

      {fiche && expl && (
        <Fiche cible={fiche} expl={expl} infos={infos} onGeneral={() => setFiche({ type: 'general' })} onFermer={() => setFiche(null)} />
      )}
    </div>
  )
}

function Legende(props: { bruits: boolean }) {
  return (
    <p class="legende">
      <span class="surligne reconnu">reconnu</span> <span class="surligne pfas">PFAS</span>{' '}
      <span class="surligne exclu">fluoré non PFAS</span>
      {props.bruits && (
        <>
          {' '}
          <span class="surligne bruit">non compris</span>
        </>
      )}
      <br />
      {T.resultat.legende}
    </p>
  )
}

function TexteSurligne(props: {
  resultat: Resultat
  onIngredient: (ing: IngredientAnalyse, lu: string, morceau: Morceau) => void
  onBruit: (lu: string) => void
}) {
  const { texte, morceaux, ingredients, aliment } = props.resultat
  const parts = []
  let pos = 0
  morceaux.forEach((m, n) => {
    if (m.debut > pos) parts.push(texte.slice(pos, m.debut))
    const lu = texte.slice(m.debut, m.fin)
    // Des <span> et non des <button> : un bouton forme un bloc et casse le fil du texte
    if (m.type === 'ingredient' && m.ingredient !== undefined) {
      const ing = ingredients[m.ingredient]
      parts.push(
        <span key={n} role="button" tabIndex={0} class={`surligne ${classeIngredient(ing)}`} onClick={() => props.onIngredient(ing, lu, m)}>
          {lu}
        </span>,
      )
    } else if (m.type === 'bruit' && !aliment) {
      parts.push(
        <span key={n} role="button" tabIndex={0} class="surligne bruit" onClick={() => props.onBruit(lu)}>
          {lu}
        </span>,
      )
    } else parts.push(<span key={n} class="neutre">{lu}</span>)
    pos = m.fin
  })
  if (pos < texte.length) parts.push(texte.slice(pos))
  return <>{parts}</>
}

function Fiche(props: { cible: Cible; expl: Explications; infos: Infos | null; onGeneral: () => void; onFermer: () => void }) {
  const { cible, expl } = props
  const [details, setDetails] = useState<{ description: string; restriction: string } | null>(null)

  useEffect(() => {
    setDetails(null)
    if (cible.type === 'ingredient' && cible.ing.index !== undefined)
      chargerDetails(props.infos?.entrees[cible.ing.index]?.[0] ?? cible.ing.nom).then(setDetails)
  }, [cible])

  let corps
  if (cible.type === 'general') {
    const g = expl.general
    corps = (
      <>
        <h2>{g.titre}</h2>
        <p>{g.quoi}</p>
        <h3>{T.fiche.pourquoi}</h3>
        <p>{g.pourquoi}</p>
        <h3>{T.fiche.probleme}</h3>
        <p>{g.probleme}</p>
        <p class="aide">{g.definition}</p>
        <p class="source">
          {T.fiche.source} :{' '}
          <a href={g.source.url} target="_blank" rel="noopener">
            {g.source.nom}
          </a>
        </p>
      </>
    )
  } else if (cible.type === 'bruit') {
    corps = (
      <>
        <h2>{T.fiche.nonCompris}</h2>
        <p class="cite">« {cible.lu} »</p>
        <p>{T.fiche.nonComprisTexte}</p>
      </>
    )
  } else {
    const ing = cible.ing
    const lu = cible.lu ?? ing.brut
    // L'écart vaut pour le morceau touché (un même ingrédient peut être lu juste à un endroit, avec des fautes ailleurs)
    const correction = cible.morceau ? cible.morceau.correction : ing.correction
    const distance = cible.morceau ? cible.morceau.distance : ing.distance
    const n = ing.classement.niveau
    const fam = estPfas(n) ? expl.familles[ing.classement.famille ?? 'autre'] : null
    const entree = ing.index !== undefined ? props.infos?.entrees[ing.index] : undefined
    corps = (
      <>
        <h2>{ing.nom}</h2>
        {ing.commentaire && <p>{ing.commentaire}</p>}
        {ing.quantite && <p class="aide">Quantité : {ing.quantite}</p>}
        {ing.reconnu && lu.trim().toUpperCase() !== ing.nom.toUpperCase() && (
          <p class="aide">
            Lu « {lu} »
            {correction === 'approx' && distance
              ? `, rapproché de ce nom officiel (${distance} lettre${distance > 1 ? 's' : ''} d’écart).`
              : correction === 'ocr'
                ? ', des chiffres lus à la place de lettres ont été corrigés.'
                : ', reconnu sous ce nom.'}
          </p>
        )}
        {fam && (
          <>
            <p class="badge pfas">Famille des PFAS · {fam.titre}</p>
            <h3>{T.fiche.quoi}</h3>
            <p>{fam.quoi}</p>
            <h3>{T.fiche.pourquoi}</h3>
            <p>{fam.pourquoi}</p>
            <h3>{T.fiche.probleme}</h3>
            <p>{fam.probleme}</p>
          </>
        )}
        {n === 'possible' && (
          <>
            <p class="badge possible">{expl.possible.titre}</p>
            <p>{expl.possible.texte}</p>
          </>
        )}
        {n === 'exclu' && (
          <>
            <p class="badge exclu">{expl.exclu.titre}</p>
            <p>{expl.exclu.texte}</p>
          </>
        )}
        {n === 'aucun' && ing.reconnu && <p class="badge reconnu">{T.fiche.pasPfas}</p>}
        {ing.classement.regle && (
          <>
            <h3>{T.fiche.filtre}</h3>
            <p>{ing.classement.regle}.</p>
          </>
        )}
        {!ing.reconnu && <p class="avertissement">{T.fiche.nonReconnu}</p>}
        {entree?.[3] && (
          <>
            <h3>{T.fiche.fonctions}</h3>
            <p>{traduireFonctions(entree[3])}</p>
          </>
        )}
        {details?.description && (
          <>
            <h3>{T.fiche.description}</h3>
            <p lang="en">{details.description}</p>
          </>
        )}
        {details?.restriction && (
          <>
            <h3>{T.fiche.restriction}</h3>
            <p lang="en">{details.restriction}</p>
          </>
        )}
        {entree?.[2] && <p class="aide">CAS {entree[2]}</p>}
        {fam && (
          <button class="lien" onClick={props.onGeneral}>
            {T.resultat.qu_est_ce}
          </button>
        )}
      </>
    )
  }

  return (
    <div class="voile" onClick={props.onFermer}>
      <div class="feuille" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div class="feuille-corps">{corps}</div>
        <button class="bouton principal" onClick={props.onFermer}>
          {T.boutons.fermer}
        </button>
      </div>
    </div>
  )
}

function domaine(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
