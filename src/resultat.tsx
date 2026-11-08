import { useEffect, useState } from 'preact/hooks'
import type { IngredientAnalyse, Resultat } from './engine/analyse.ts'
import { estPfas } from './engine/rules.ts'
import { chargerDetails, chargerExplications, chargerRessources, type Explications, type Produit } from './donnees.ts'
import { T, traduireFonctions } from './textes.ts'

const LIBELLE_SOURCE: Record<Resultat['source'], string> = {
  base_beaute: 'Open Beauty Facts',
  base_alimentaire: 'Open Food Facts',
  base_produits: 'Open Products Facts',
  photo: 'photo de l’étiquette, lue sur le téléphone',
  texte: 'texte saisi',
}

function classeIngredient(i: IngredientAnalyse): string {
  if (estPfas(i.classement.niveau)) return 'pfas'
  if (i.classement.niveau === 'possible') return 'possible'
  if (i.classement.niveau === 'exclu') return 'exclu'
  if (!i.reconnu) return 'inconnu'
  return ''
}

interface Infos {
  date: string
  nbPfas: number
  entrees: [string, string, string, string][]
}

export function EcranResultat(props: {
  resultat: Resultat
  produit?: Produit
  onAutre: () => void
  onCorriger: () => void
  onSources: () => void
}) {
  const { resultat: r, produit } = props
  const [expl, setExpl] = useState<Explications | null>(null)
  const [infos, setInfos] = useState<Infos | null>(null)
  const [fiche, setFiche] = useState<IngredientAnalyse | 'general' | null>(null)

  useEffect(() => {
    chargerExplications().then(setExpl).catch(() => {})
    chargerRessources()
      .then((x) => setInfos({ date: x.pfasJson.source.date, nbPfas: x.pfasJson.pfas.length, entrees: x.dictionnaire.entrees }))
      .catch(() => {})
  }, [])

  const depuisBase = r.source.startsWith('base_')
  const cosmetique = r.source === 'base_beaute' || ((r.source === 'photo' || r.source === 'texte') && r.tauxReconnus >= 0.5)
  const signales = r.ingredients.filter((i) => i.classement.niveau !== 'aucun')
  const nbReconnus = r.ingredients.filter((i) => i.reconnu).length

  return (
    <div class="ecran resultat">
      <div class="defilement">
        {produit && (
          <div class="produit">
            {produit.image && <img src={produit.image} alt="" />}
            <div>
              <strong>{produit.nom ?? 'Produit sans nom'}</strong>
              {produit.marque && <span>{produit.marque}</span>}
              <small>Code {produit.code}</small>
            </div>
          </div>
        )}

        <section class={`verdict ${r.verdict}`} aria-live="polite">
          <h1>
            <span class="pastille" aria-hidden="true" />
            {r.titre}
          </h1>
          <p class="phrase">{r.phrase}</p>
          <p class="confiance">
            {T.resultat.confiance} : {r.confiance}
            {r.ingredients.length > 0 && ` · ${nbReconnus} ingrédient${nbReconnus > 1 ? 's' : ''} reconnu${nbReconnus > 1 ? 's' : ''} sur ${r.ingredients.length}`}
          </p>
          {r.verdict !== 'vert' && (
            <button class="lien" onClick={() => setFiche('general')}>
              {T.resultat.qu_est_ce}
            </button>
          )}
        </section>

        {r.verdict === 'rouge' && cosmetique && expl && <p class="reglementaire">{expl.reglementaire.texte}</p>}

        {produit && !produit.ingredients && <p class="aide">{T.resultat.sansComposition}</p>}

        {r.ingredients.length > 0 && (
          <section class="carte">
            <h2>
              {T.resultat.ingredients} ({r.ingredients.length})
            </h2>
            <p class="aide">{T.resultat.legende}</p>
            <ul class="ingredients">
              {r.ingredients.map((i, n) => (
                <li key={n}>
                  <button class={`ing ${classeIngredient(i)}`} onClick={() => setFiche(i)}>
                    {i.nom}
                    {!i.reconnu && <span class="etiquette"> · {T.resultat.nonReconnu}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <details class="carte">
          <summary>{T.resultat.commentTrouve}</summary>
          <ul class="liste-simple">
            <li>
              Composition : {LIBELLE_SOURCE[r.source]}
              {produit && depuisBase && ` (code ${produit.code})`}.
            </li>
            {r.ingredients.length > 0 && (
              <li>
                Ingrédients reconnus dans CosIng : {nbReconnus} sur {r.ingredients.length} ({Math.round(r.tauxReconnus * 100)} %).
              </li>
            )}
            {signales.map((i, n) => (
              <li key={n}>
                <strong>{i.nom}</strong> : {i.classement.regle}
                {i.correction && ` (lu « ${i.brut} »)`}.
              </li>
            ))}
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
        {depuisBase ? (
          <label for="entree-photo" class="bouton secondaire">
            {T.boutons.photoIngredients}
          </label>
        ) : (
          <button class="bouton secondaire" onClick={props.onCorriger}>
            {T.boutons.corriger}
          </button>
        )}
      </footer>

      {fiche && expl && (
        <Fiche
          cible={fiche}
          expl={expl}
          infos={infos}
          onGeneral={() => setFiche('general')}
          onFermer={() => setFiche(null)}
        />
      )}
    </div>
  )
}

function Fiche(props: {
  cible: IngredientAnalyse | 'general'
  expl: Explications
  infos: Infos | null
  onGeneral: () => void
  onFermer: () => void
}) {
  const { cible, expl } = props
  const [details, setDetails] = useState<{ description: string; restriction: string } | null>(null)

  useEffect(() => {
    setDetails(null)
    if (cible !== 'general' && cible.index !== undefined) chargerDetails(cible.nom).then(setDetails)
  }, [cible])

  let corps
  if (cible === 'general') {
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
  } else {
    const n = cible.classement.niveau
    const fam = estPfas(n) ? expl.familles[cible.classement.famille ?? 'autre'] : null
    const entree = cible.index !== undefined ? props.infos?.entrees[cible.index] : undefined
    corps = (
      <>
        <h2>{cible.nom}</h2>
        {cible.correction && <p class="aide">{T.fiche.corrige.replace('{brut}', cible.brut)}</p>}
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
        {cible.classement.regle && (
          <>
            <h3>{T.fiche.filtre}</h3>
            <p>{cible.classement.regle}.</p>
          </>
        )}
        {!cible.reconnu && <p class="avertissement">{T.fiche.nonReconnu}</p>}
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
