import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyse, categorieARisque, preparerListes, type Ressources } from '../src/engine/analyse.ts'
import { Dictionnaire, levenshteinBorne } from '../src/engine/dictionnaire.ts'
import { classer } from '../src/engine/rules.ts'
import { corrigerOcr, decouper } from '../src/engine/texte.ts'

const inci = JSON.parse(readFileSync('public/data/inci.json', 'utf8'))
const pfasJson = JSON.parse(readFileSync('public/data/pfas.json', 'utf8'))
const listes = preparerListes(pfasJson)
const r: Ressources = {
  dictionnaire: new Dictionnaire(inci.e, pfasJson.pfas.map((p: { n: string }) => p.n)),
  listes,
}
const texte = (t: string) => analyse(t, { source: 'texte' }, r)

describe('Jeu de test minimal du cahier des charges', () => {
  it.each([
    ['PTFE', 'rouge'],
    ['Polyperfluoromethylisopropyl Ether', 'rouge'],
    ['Perfluorodecalin', 'rouge'],
    ['C9-15 Fluoroalcohol Phosphate', 'rouge'],
    ['PERFLU0R0DECALIN', 'rouge'],
    ['Aqua, Sodium Laureth Sulfate, Glycerin', 'vert'],
  ])('%s → %s', (t, attendu) => {
    expect(texte(t).verdict).toBe(attendu)
  })

  it.each(['Sodium Fluoride', 'Synthetic Fluorphlogopite', 'Sodium Monofluorophosphate', 'Stannous Fluoride', 'Olaflur'])(
    '%s → aucune alerte PFAS',
    (t) => {
      const res = texte(`Aqua, Glycerin, ${t}`)
      expect(res.verdict).not.toBe('rouge')
      expect(res.verdict).not.toBe('orange')
    },
  )
})

describe('Règles', () => {
  it('reconnaît les PFAS de la liste avec leur famille', () => {
    expect(classer('PTFE', listes)).toMatchObject({ niveau: 'liste', famille: 'fluoropolymeres' })
    expect(classer('Trifluoropropyl Dimethicone', listes)).toMatchObject({ niveau: 'liste', famille: 'silicones' })
  })
  it('signale un nom fluoré inconnu par mot-clé', () => {
    expect(classer('Perfluorooctyl Glycerin Ether').niveau).toBe('mot_cle')
    expect(classer('Heptadecafluorodecyl Something').niveau).toBe('mot_cle')
  })
  it('ne classe pas PFAS un fluor aromatique', () => {
    expect(classer('Difluorophenyl Propylcyclopentene Oxime', listes).niveau).toBe('exclu')
    expect(classer('4-Fluorobenzyl Alcohol').niveau).toBe('possible')
  })
  it('écarte les gaz sans carbone entièrement fluoré', () => {
    expect(classer('Hydrofluorocarbon 152a').niveau).toBe('exclu')
    expect(classer('Hydrofluorocarbon 227ea').niveau).toBe('mot_cle')
  })
  it('ignore les azurants fluorescents', () => {
    expect(classer('Fluorescent Brightener 230').niveau).toBe('aucun')
  })
  it('reconnaît le PVDF', () => {
    expect(classer('Polyvinylidene Difluoride', listes).niveau).toBe('liste')
  })
})

describe('Découpage du texte', () => {
  it('sépare une liste INCI typique', () => {
    expect(decouper('Ingredients: AQUA (WATER), GLYCERIN, PARFUM (FRAGRANCE). [+/- CI 77891, CI 77491]')).toEqual([
      'AQUA (WATER)',
      'GLYCERIN',
      'PARFUM (FRAGRANCE)',
      'CI 77891',
      'CI 77491',
    ])
  })
  it('garde les virgules à l’intérieur des parenthèses', () => {
    expect(decouper('Parfum (Fragrance, Limonene), Glycerin')).toEqual(['Parfum (Fragrance, Limonene)', 'Glycerin'])
  })
  it('recolle un mot coupé en fin de ligne', () => {
    expect(decouper('Aqua, Perfluoro-\nDecalin, Glycerin')).toContain('PerfluoroDecalin')
  })
  it('garde « 1,3 » dans un nom chimique', () => {
    expect(decouper('Aqua, 2-Oleamido-1,3-Octadecanediol, Glycerin')).toEqual(['Aqua', '2-Oleamido-1,3-Octadecanediol', 'Glycerin'])
  })
  it('écarte une phrase d’avertissement', () => {
    expect(decouper('Aqua, Please refer to the ingredient list on your product package for the most up to date list')).toEqual(['Aqua'])
  })
  it('ne coupe pas les décimales', () => {
    expect(decouper('Sucre 12.5 %, sel')).toEqual(['Sucre', 'sel'])
  })
})

describe('Corrections d’OCR', () => {
  it('remplace les zéros pris pour des O', () => {
    expect(corrigerOcr('perflu0r0decalin')).toBe('perfluorodecalin')
  })
  it('laisse les nombres en bord de mot', () => {
    expect(corrigerOcr('peg100')).toBe('peg100')
    expect(corrigerOcr('c915fluoroalcoholphosphate')).toBe('c915fluoroalcoholphosphate')
  })
  it('rapproche un nom mal lu', () => {
    const res = texte('Aqua, Glycerln, Sodium Laurcth Sulfate, Dimethlcone')
    expect(res.ingredients.every((i) => i.reconnu)).toBe(true)
    expect(res.ingredients[1].nom).toBe('GLYCERIN')
  })
  it('levenshtein borné', () => {
    expect(levenshteinBorne('glycerln', 'glycerin', 2)).toBe(1)
    expect(levenshteinBorne('abcdefgh', 'zzzzzzzz', 2)).toBe(3)
  })
})

describe('Verdicts', () => {
  it('gris quand trop d’ingrédients ne sont pas reconnus après photo', () => {
    const res = analyse('Xqzt plor, Vvbn kkjh, Aqua, Mmnb tyre', { source: 'photo' }, r)
    expect(res.verdict).toBe('gris')
  })
  it('alimentaire : vert même si les noms ne sont pas INCI', () => {
    const res = analyse('farine de blé, sucre, beurre, œufs', { source: 'base_alimentaire' }, r)
    expect(res.verdict).toBe('vert')
  })
  it('sans composition : orange pour une catégorie à risque, gris sinon', () => {
    expect(analyse('', { source: 'base_beaute', categories: ['en:dental-floss'] }, r).verdict).toBe('orange')
    expect(analyse('', { source: 'base_beaute', nomProduit: 'Mascara waterproof' }, r).verdict).toBe('orange')
    expect(analyse('', { source: 'base_beaute', categories: ['en:shower-gels'] }, r).verdict).toBe('gris')
  })
  it('reconnaît une catégorie à risque', () => {
    expect(categorieARisque(['en:frying-pans', 'en:non-stick-cookware'])).toBe('ustensile anti-adhésif')
  })
  it('liste INCI réelle de fond de teint avec PFAS', () => {
    const res = texte(
      'AQUA, CYCLOPENTASILOXANE, TITANIUM DIOXIDE, BUTYLENE GLYCOL, PEG-10 DIMETHICONE, TRIFLUOROPROPYL DIMETHICONE, PERFLUORONONYL DIMETHICONE, SODIUM CHLORIDE, PHENOXYETHANOL, CI 77492',
    )
    expect(res.verdict).toBe('rouge')
    expect(res.ingredients.filter((i) => i.classement.niveau === 'liste')).toHaveLength(2)
    expect(res.confiance).toBe('élevée')
  })
  it('dentifrice au fluor : pas de PFAS', () => {
    const res = texte('Aqua, Hydrated Silica, Sorbitol, Glycerin, Sodium Lauryl Sulfate, Aroma, Sodium Fluoride, Sodium Saccharin, Limonene')
    expect(res.verdict).toBe('vert')
    expect(res.ingredients.find((i) => i.nom === 'SODIUM FLUORIDE')?.classement.niveau).toBe('exclu')
  })
})
