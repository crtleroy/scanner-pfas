import { useEffect, useState } from 'preact/hooks'
import { BASES, chargerExplications, chargerRessources, type Explications, type ListePfasJson } from './donnees.ts'
import { T } from './textes.ts'

export function EcranSources(props: { onRetour: () => void }) {
  const [pfas, setPfas] = useState<ListePfasJson | null>(null)
  const [expl, setExpl] = useState<Explications | null>(null)
  useEffect(() => {
    chargerRessources()
      .then((r) => setPfas(r.pfasJson))
      .catch(() => {})
    chargerExplications().then(setExpl).catch(() => {})
  }, [])

  return (
    <div class="ecran">
      <div class="defilement">
        <h1>{T.boutons.sources}</h1>
        <h2>Bases de produits</h2>
        <p>Interrogées en direct à partir du code-barres. Données collaboratives, sous licence ODbL.</p>
        <ul class="liste-simple">
          {BASES.map((b) => (
            <li key={b.id}>
              <a href={b.site} target="_blank" rel="noopener">
                {b.nom}
              </a>
            </li>
          ))}
        </ul>
        <h2>Ingrédients et PFAS</h2>
        <ul class="liste-simple">
          <li>
            Noms INCI, fonctions et numéros CAS : CosIng (Commission européenne), via{' '}
            <a href="https://world.openbeautyfacts.org/ingredients" target="_blank" rel="noopener">
              la base d’ingrédients d’Open Beauty Facts
            </a>
            {pfas && `, mise à jour du ${new Date(pfas.source.date).toLocaleDateString('fr-FR')}`}.
          </li>
          {pfas && (
            <li>
              Liste des PFAS cosmétiques : {pfas.pfas.length} noms, et {pfas.nonPfas.length} noms fluorés écartés. {pfas.methode}
            </li>
          )}
          {expl && (
            <>
              <li>
                Définition des PFAS :{' '}
                <a href={expl.general.source.url} target="_blank" rel="noopener">
                  {expl.general.source.nom}
                </a>
                , d’après l’OCDE (2021).
              </li>
              <li>
                Réglementation française :{' '}
                <a href={expl.reglementaire.source.url} target="_blank" rel="noopener">
                  {expl.reglementaire.source.nom}
                </a>
                .
              </li>
            </>
          )}
        </ul>
        <h2>Vie privée</h2>
        <p>
          Seul le code-barres est envoyé aux bases Open Facts. Les photos sont lues sur le téléphone (Tesseract.js) et ne
          quittent pas l’appareil. Aucun compte, aucune publicité.
        </p>
        {expl && (
          <>
            <h2>Limites</h2>
            <p>{expl.limites}</p>
            <p class="mention">{expl.mention}</p>
          </>
        )}
        <p class="aide">Lecture des codes-barres : ZXing (WebAssembly). Lecture du texte : Tesseract.js.</p>
      </div>
      <footer class="actions">
        <button class="bouton principal" onClick={props.onRetour}>
          {T.boutons.retour}
        </button>
      </footer>
    </div>
  )
}
