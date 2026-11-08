import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyse, categorieARisque, estTexteAliment, preparerListes, type Ressources } from '../src/engine/analyse.ts'
import { Dictionnaire, levenshteinBorne } from '../src/engine/dictionnaire.ts'
import { segmenter } from '../src/engine/lecture.ts'
import { analyseIA } from '../src/engine/ia.ts'
import { classer } from '../src/engine/rules.ts'
import { corrigerOcr } from '../src/engine/texte.ts'

const inci = JSON.parse(readFileSync('public/data/inci.json', 'utf8'))
const pfasJson = JSON.parse(readFileSync('public/data/pfas.json', 'utf8'))
const listes = preparerListes(pfasJson)
const r: Ressources = {
  dictionnaire: new Dictionnaire(inci.e, pfasJson.pfas.map((p: { n: string }) => p.n)),
  listes,
}
const texte = (t: string) => analyse(t, { source: 'texte' }, r)
const noms = (t: string) => texte(t).ingredients.filter((i) => i.reconnu).map((i) => i.nom)
const morceauxDe = (res: ReturnType<typeof texte>, type: string) =>
  res.morceaux.filter((m) => m.type === type).map((m) => res.texte.slice(m.debut, m.fin))

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

describe('Photos réelles du 08/11/2026', () => {
  it('anti-moustique, texte du scanner de l’iPhone', () => {
    const res = texte(
      'Fabriqué dans l’U.E. / Produit à usage biocide\n(TP19, Répulsif - Liquide, prêt à l’emploi (AL)) Vaporisateur\nCOMPOSITION : Contient de l’IR3535® 35% (m/m)\n(ethyl butylacetylaminopropionate - CAS 52304-36-6).',
    )
    expect(res.ingredients.filter((i) => i.reconnu).map((i) => i.nom)).toEqual(['ETHYL BUTYLACETYLAMINOPROPIONATE'])
    // Trouvé trois fois (nom commercial, nom chimique, numéro CAS), compté une fois
    expect(res.morceaux.filter((m) => m.type === 'ingredient')).toHaveLength(3)
    expect(res.verdict).toBe('vert')
    expect(res.phrase).toBe('Aucun PFAS dans ce qui a été lu.')
    expect(morceauxDe(res, 'bruit').join(' ')).toContain('biocide')
  })

  it('anti-moustique, texte mal lu sans virgules', () => {
    const res = texte(
      'COMPOSITION Contient de l IR 3535 ° 35% (m/m) élylbutylacétylaminopropionate CAS 52304 36 6 Usage Vaporiser sur la peau Ne pas appliquer sur les yeux Tenir hors de portée des enfants',
    )
    const ing = res.ingredients.find((i) => i.nom === 'ETHYL BUTYLACETYLAMINOPROPIONATE')
    expect(ing).toBeDefined()
    expect(res.verdict).toBe('vert')
    const lu = morceauxDe(res, 'ingredient')
    expect(lu).toContain('élylbutylacétylaminopropionate')
    expect(lu).toContain('IR 3535')
  })

  it('anti-moustique, texte lu par Tesseract sur l’iPhone (capture du 08/11)', () => {
    const res = analyse(
      `PROPRIÉTÉS : Produit a usage biocide
(TP14
a àlusoge humain, qui repousse
efficocemes +.
Mo |ledes spp., Culex spp. et Anopheles
4 ie fabriqué dans I'U.E. / –
4  Ls (P19, Répulsif – Liquide, prêt 0!
empo + 9      '
    "COMPOSITION : Contient de | 1R3535
5 °F
(ethyl butylacetylaminopropionate – (53
q`,
      { source: 'photo' },
      r,
    )
    expect(res.ingredients.filter((i) => i.reconnu).map((i) => i.nom)).toEqual(['ETHYL BUTYLACETYLAMINOPROPIONATE'])
    expect(morceauxDe(res, 'ingredient')).toContain('1R3535')
    expect(res.verdict).toBe('vert')
    expect(res.avertissement).toContain('autour de la composition')
  })

  it('médicament : noms de pharmacie', () => {
    const t =
      'COMPOSITION EN SUBSTANCE ACTIVE\nPovidone iodée .............. 10 g\nPour 100 g de gel.\nLISTE DES EXCIPIENTS\nMacrogol 400, macrogol 4000,\nmacrogol 6000, eau purifiée.\nFORME PHARMACEUTIQUE\nET CONTENU\nGel\nTube de 30g'
    expect(noms(t)).toEqual(expect.arrayContaining(['POVIDONE-IODINE', 'PEG-8', 'PEG-90', 'PEG-150', 'AQUA']))
    expect(texte(t).verdict).toBe('vert')
  })

  it('jus de raisin : aliment reconnu au tableau nutritionnel', () => {
    const t =
      '100% PUR JUS DE RAISINS PASTEURISÉ\nIngrédients : Raisins issus de cépages Syrah,\nChardonnay et Grenache\nValeurs nutritionnelles moyennes pour 100mL\nEnergie 42kcal\nMatières grasses >0,1 g\ndont acides gras saturés >0,1 g\nGlucides 14,5 g\ndont sucres totaux 14 g\nProtéines >0,1 g\nSel >0,1 g\nConserver dans un endroit frais et sec à l’abri de la lumière.'
    expect(estTexteAliment(t)).toBe(true)
    const res = texte(t)
    expect(res.aliment).toBe(true)
    expect(res.verdict).toBe('vert')
  })

  it('fond de teint, face sans liste d’ingrédients : vert avec mise en garde', () => {
    const res = texte(
      'Gives up to 12H of continuous hydration\nfond de teint hydratant\n+ACIDE HYALURONIQUE +COLLAGENE\nFeuchtigkeitsspendendes Make-Up\n+ HYALURONSÄURE +\nKOLLAGEN\nfondotinte idratante\nCON ACIDO IALURONICO E COLLAGENE\nmaquillaje hidratante CON ACIDO HIALURONICO Y COLAGENO\ne 30 ml MADE IN FRANCE\nGEMEY PARIS MAYBELLINE NEW YORK 14, RUE ROYALE 75008 PARIS FRANCE',
    )
    expect(res.verdict).toBe('vert')
    expect(res.confiance).toBe('faible')
    expect(res.avertissement).toBeDefined()
  })
})

describe('Lecture du texte', () => {
  it('coupe aux séparateurs sans casser « 1,3 »', () => {
    const t = 'Aqua, 2-Oleamido-1,3-Octadecanediol; Glycerin'
    expect(segmenter(t).map((s) => t.slice(s.debut, s.fin))).toEqual(['Aqua', '2-Oleamido-1,3-Octadecanediol', 'Glycerin'])
  })
  it('garde un segment entier avec ses parenthèses', () => {
    const res = texte('AQUA (WATER), PARFUM (FRAGRANCE, LIMONENE)')
    expect(res.ingredients.map((i) => i.nom)).toEqual(['AQUA', 'PARFUM'])
    expect(morceauxDe(res, 'bruit')).toEqual([])
  })
  it('trouve les ingrédients sans virgules', () => {
    expect(noms('Aqua Glycerin Sodium Laureth Sulfate Cocamidopropyl Betaine Parfum')).toEqual([
      'AQUA',
      'GLYCERIN',
      'SODIUM LAURETH SULFATE',
      'COCAMIDOPROPYL BETAINE',
      'PARFUM',
    ])
  })
  it('recolle un nom coupé en fin de ligne', () => {
    expect(noms('Aqua, Perfluoro-\nDecalin, Glycerin')).toContain('PERFLUORODECALIN')
  })
  it('signale une racine fluorée même dans un morceau non compris', () => {
    const res = texte('Aqua, Glycerin, Perfluoroxyz Trucmuche Polymer')
    expect(res.verdict).toBe('rouge')
  })
  it('écarte une phrase d’avertissement sans bloquer le reste', () => {
    const res = texte('Aqua, Glycerin, Please refer to the ingredient list on your product package for the most up to date list')
    expect(res.ingredients.map((i) => i.nom)).toEqual(['AQUA', 'GLYCERIN'])
    expect(res.verdict).toBe('vert')
  })
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

describe('Corrections de lecture', () => {
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
  it('gris quand rien n’est reconnu', () => {
    const res = analyse('Xqzt plor vvbn kkjh mmnb tyre', { source: 'photo' }, r)
    expect(res.verdict).toBe('gris')
  })
  it('vert avec réserve quand une partie seulement est comprise', () => {
    const res = analyse('Xqzt plor, Vvbn kkjh, Aqua, Glycerin, Mmnb tyre', { source: 'photo' }, r)
    expect(res.verdict).toBe('vert')
    expect(res.phrase).toBe('Aucun PFAS dans ce qui a été lu.')
    expect(res.confiance).not.toBe('élevée')
  })
  it('texte vide après photo', () => {
    expect(analyse('  ', { source: 'photo' }, r).phrase).toBe('Aucun texte à analyser.')
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
    expect(res.phrase).toBe('2 ingrédients de la famille des PFAS')
  })
  it('dentifrice au fluor : pas de PFAS', () => {
    const res = texte('Aqua, Hydrated Silica, Sorbitol, Glycerin, Sodium Lauryl Sulfate, Aroma, Sodium Fluoride, Sodium Saccharin, Limonene')
    expect(res.verdict).toBe('vert')
    expect(res.ingredients.find((i) => i.nom === 'SODIUM FLUORIDE')?.classement.niveau).toBe('exclu')
  })
})

describe('Lecture par Claude (réponse du relais)', () => {
  const base = { liste_trouvee: true, lisibilite: 'bonne' as const, nom_produit: null, remarque: null, texte_lu: '' }
  it('jus de raisin : aliment, vert', () => {
    const res = analyseIA(
      {
        ...base,
        type_produit: 'aliment',
        ingredients: [{ nom_lu: 'Raisins issus de cépages Syrah, Chardonnay et Grenache', nom_normalise: 'raisin', quantite: '100 %', commentaire: 'fruit pressé' }],
      },
      r,
    )
    expect(res.verdict).toBe('vert')
    expect(res.aliment).toBe(true)
    expect(res.ingredients[0].quantite).toBe('100 %')
  })
  it('anti-moustique : IR3535 et nom chimique fusionnés, quantité gardée', () => {
    const res = analyseIA(
      {
        ...base,
        type_produit: 'biocide',
        ingredients: [
          { nom_lu: 'IR3535', nom_normalise: 'ETHYL BUTYLACETYLAMINOPROPIONATE', quantite: '35 %', commentaire: 'répulsif anti-moustique' },
          { nom_lu: 'ethyl butylacetylaminopropionate', nom_normalise: 'ETHYL BUTYLACETYLAMINOPROPIONATE', quantite: null, commentaire: 'répulsif' },
        ],
      },
      r,
    )
    expect(res.ingredients).toHaveLength(1)
    expect(res.ingredients[0].quantite).toBe('35 %')
    expect(res.verdict).toBe('vert')
  })
  it('PFAS : le verdict vient de nos règles, pas du commentaire', () => {
    const res = analyseIA(
      {
        ...base,
        type_produit: 'cosmetique',
        ingredients: [
          { nom_lu: 'Aqua', nom_normalise: 'AQUA', quantite: null, commentaire: 'eau' },
          { nom_lu: 'PTFE', nom_normalise: 'PTFE', quantite: null, commentaire: 'poudre de texture' },
          { nom_lu: 'Sodium Fluoride', nom_normalise: 'SODIUM FLUORIDE', quantite: null, commentaire: 'anti-caries' },
        ],
      },
      r,
    )
    expect(res.verdict).toBe('rouge')
    expect(res.ingredients.find((i) => i.nom === 'SODIUM FLUORIDE')?.classement.niveau).toBe('exclu')
  })
  it('aucune liste sur la photo : gris avec la remarque de Claude', () => {
    const res = analyseIA(
      { ...base, liste_trouvee: false, type_produit: 'cosmetique', ingredients: [], remarque: 'Face avant du flacon, la liste est sans doute au dos.' },
      r,
    )
    expect(res.verdict).toBe('gris')
    expect(res.phrase).toContain('au dos')
  })
  it('liste coupée : mise en garde', () => {
    const res = analyseIA(
      { ...base, lisibilite: 'partielle', type_produit: 'cosmetique', ingredients: [{ nom_lu: 'Aqua', nom_normalise: 'AQUA', quantite: null, commentaire: 'eau' }] },
      r,
    )
    expect(res.avertissement).toContain('coupée')
    expect(res.confiance).toBe('moyenne')
  })
})
