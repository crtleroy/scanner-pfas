import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyse, preparerListes, type Ressources } from '../src/engine/analyse.ts'
import { Dictionnaire } from '../src/engine/dictionnaire.ts'
import { ajouterRecherche, analyseIA, analyseRecherche, type ReponseRecherche } from '../src/engine/ia.ts'
import { evaluerGravite } from '../src/engine/gravite.ts'

const inci = JSON.parse(readFileSync('public/data/inci.json', 'utf8'))
const pfasJson = JSON.parse(readFileSync('public/data/pfas.json', 'utf8'))
const r: Ressources = {
  dictionnaire: new Dictionnaire(inci.e, pfasJson.pfas.map((p: { n: string }) => p.n)),
  listes: preparerListes(pfasJson),
}

const vide: ReponseRecherche = {
  produit: { marque: 'Marque', nom: 'Produit', categorie: null },
  composition_trouvee: false,
  ingredients: [],
  sources_composition: [],
  preuves: { niveau: 'inconnu', commentaire: '', faits: [] },
  bases: [],
  historique: [],
  marque_dit: [],
  autres_disent: [],
  deduction_categorie: { niveau: 'inconnu', explication: '' },
  contradictions: [],
  sources: [],
  remarque: null,
}
const fait = (texte: string) => ({ texte, date: null, sources: ['https://exemple.fr'] })

describe('Recherche internet sur un produit reconnu', () => {
  it('poêle Tefal : PTFE trouvé, rouge, gravité modérée, conseils de cuisine', () => {
    const res = analyseRecherche(
      {
        ...vide,
        produit: { marque: 'Tefal', nom: 'Ingenio Easy Cook & Clean 28 cm', categorie: 'poêle antiadhésive' },
        composition_trouvee: true,
        ingredients: [
          { nom_lu: 'Revêtement antiadhésif PTFE', nom_normalise: 'PTFE', quantite: null, commentaire: 'revêtement antiadhésif' },
          { nom_lu: 'Aluminium', nom_normalise: 'aluminium', quantite: null, commentaire: 'corps de la poêle' },
        ],
        marque_dit: [fait('Tefal annonce un revêtement sans PFOA')],
        sources: [{ titre: 'Tefal', url: 'https://www.tefal.fr' }],
      },
      r,
    )
    expect(res.verdict).toBe('rouge')
    expect(res.source).toBe('recherche')
    const g = evaluerGravite(res)!
    expect(g.usage).toBe('cuisine')
    expect(g.niveau).toBe('moderee')
    expect(g.raisons.join(' ')).toContain('surchauffe')
  })
  it('une présence prouvée « revêtement PTFE » sans composition suffit pour le rouge', () => {
    const res = analyseRecherche(
      {
        ...vide,
        produit: { marque: 'Tefal', nom: 'Poêle', categorie: 'poêle' },
        preuves: { niveau: 'presence_prouvee', commentaire: '', faits: [fait('Revêtement en PTFE renforcé')] },
      },
      r,
    )
    expect(res.verdict).toBe('rouge')
  })
  it('« sans PFAS » déclaré par la marque ne déclenche pas d’alerte', () => {
    const res = analyseRecherche(
      { ...vide, composition_trouvee: true, ingredients: [{ nom_lu: 'Butyl Acetate', nom_normalise: 'BUTYL ACETATE', quantite: null, commentaire: 'solvant' }], marque_dit: [fait('La marque déclare ses vernis sans PFAS')] },
      r,
    )
    expect(res.verdict).toBe('vert')
  })
  it('vernis sans composition trouvée : déduction de la catégorie', () => {
    const res = analyseRecherche(
      { ...vide, produit: { marque: 'Sephora Collection', nom: 'Color Hit', categorie: 'vernis à ongles' }, deduction_categorie: { niveau: 'peu_probable', explication: 'Les vernis à ongles en contiennent rarement.' } },
      r,
    )
    expect(res.verdict).toBe('gris')
    expect(res.phrase).toContain('rarement')
  })
  it('poêle sans composition : PFAS probable d’après la catégorie', () => {
    const res = analyseRecherche(
      { ...vide, produit: { marque: 'X', nom: 'Poêle', categorie: 'poêle antiadhésive' }, deduction_categorie: { niveau: 'probable', explication: 'Une poêle antiadhésive contient en général du PTFE.' } },
      r,
    )
    expect(res.verdict).toBe('orange')
    expect(res.titre).toBe('PFAS probable')
  })
  it('contradiction entre sources : mise en garde et confiance faible', () => {
    const res = analyseRecherche(
      {
        ...vide,
        composition_trouvee: true,
        ingredients: [{ nom_lu: 'Aqua', nom_normalise: 'AQUA', quantite: null, commentaire: 'eau' }],
        contradictions: [fait('La marque annonce « sans PFAS » mais un revendeur liste du PTFE.')],
      },
      r,
    )
    expect(res.avertissement).toContain('contredisent')
    expect(res.confiance).toBe('faible')
    expect(res.recherche?.contradictions).toHaveLength(1)
  })
})

describe('Recherche ajoutée à une liste lue sur la photo', () => {
  it('le verdict reste celui de la liste, la recherche remplit les encarts', () => {
    const liste = analyseIA(
      {
        type_produit: 'cosmetique',
        liste_trouvee: true,
        liste_complete: true,
        lisibilite: 'bonne',
        nom_produit: 'Vernis',
        ingredients: [{ nom_lu: 'Butyl Acetate', nom_normalise: 'BUTYL ACETATE', quantite: null, commentaire: 'solvant' }],
        remarque: null,
        texte_lu: 'BUTYL ACETATE',
      },
      r,
    )
    const res = ajouterRecherche(
      liste,
      { ...vide, historique: [fait('En 2023, la marque a reformulé sa gamme.')], preuves: { niveau: 'inconnu', commentaire: 'Aucune analyse.', faits: [] } },
      false,
    )
    expect(res.verdict).toBe('vert')
    expect(res.recherche?.historique).toHaveLength(1)
    expect(res.recherche?.preuves.niveau).toBe('inconnu')
  })
})

describe('Gravité', () => {
  it('PTFE en fin de longue liste cosmétique : préoccupation faible', () => {
    const res = analyse(
      'Aqua, Glycerin, Butylene Glycol, Dimethicone, Phenoxyethanol, Parfum, Tocopherol, Citric Acid, Sodium Benzoate, PTFE',
      { source: 'texte' },
      r,
    )
    const g = evaluerGravite(res)!
    expect(g.niveau).toBe('faible')
    expect(g.raisons[0]).toContain('fin de liste')
    expect(g.usage).toBe('cosmetique')
  })
  it('phosphate fluoré en tête de liste : préoccupation élevée', () => {
    const res = analyse('C9-15 Fluoroalcohol Phosphate, Aqua, Glycerin, Dimethicone, Phenoxyethanol, Parfum', { source: 'texte' }, r)
    expect(evaluerGravite(res)!.niveau).toBe('elevee')
  })
  it('pas de PFAS : pas de gravité', () => {
    expect(evaluerGravite(analyse('Aqua, Glycerin', { source: 'texte' }, r))).toBeNull()
  })
  it('photo de liste coupée : à compléter', () => {
    const res = analyseIA(
      {
        type_produit: 'cosmetique',
        liste_trouvee: true,
        liste_complete: false,
        lisibilite: 'bonne',
        nom_produit: null,
        ingredients: [{ nom_lu: 'Aqua', nom_normalise: 'AQUA', quantite: null, commentaire: 'eau' }],
        remarque: null,
        texte_lu: 'AQUA, GLYC',
      },
      r,
    )
    expect(res.listeIncomplete).toBe(true)
    expect(res.avertissement).toContain('Complétez')
  })
})
