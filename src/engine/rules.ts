// Règles de détection des PFAS à partir d'un nom d'ingrédient.
// Utilisé par l'appli et par scripts/build-lists.ts (Node lit ce fichier directement).
// Définition de référence : OCDE 2021, au moins un carbone saturé entièrement fluoré
// (CF2 ou CF3) sans hydrogène, chlore, brome ni iode attaché.

export type Niveau = 'liste' | 'mot_cle' | 'possible' | 'exclu' | 'aucun'

export type Famille =
  | 'fluoropolymeres'
  | 'ethers_alcanes'
  | 'phosphates'
  | 'silicones'
  | 'copolymeres'
  | 'cf3'
  | 'gaz'
  | 'autre'

export interface Classement {
  niveau: Niveau
  famille?: Famille
  /** Explication courte de la règle qui a tranché, affichée dans « Comment on a trouvé ». */
  regle: string
}

/** Clé de comparaison : minuscules, sans accents, sans espaces ni ponctuation. */
export function compact(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

// Racines qui signalent presque toujours un CF2 ou un CF3 sans hydrogène.
const RACINES_FORTES =
  /perfluoro|polyfluoro|ptfe|polytetrafluoro|tetrafluoroethylene|hexafluoropropylene|trifluoro|fluoroalcohol|fluoroalkyl|(tetra|penta|hexa|hepta|octa|nona|deca|undeca|dodeca|trideca|tetradeca|pentadeca|hexadeca|heptadeca|octadeca|nonadeca|icosa|eicosa|henicosa|heneicosa)fluoro|teflon|pvdf|vinylidene(di)?fluoride|polychlorotrifluoro/

// Fluor porté par un cycle aromatique ou isolé : pas un PFAS selon l'OCDE, sauf autre groupe.
const FLUOR_AROMATIQUE_OU_ISOLE =
  /fluoro(phenyl|benzyl|benz|nitrophenyl|pyridin|anil|toluen|indol|uracil)|\dfluoro\d|monofluoro|difluorophenyl/

// Fluorures et fluoro-sels minéraux : contiennent du fluor, ne sont pas des PFAS.
const SELS_MINERAUX =
  /^(sodium|potassium|calcium|magnesium|ammonium|aluminum|aluminium|zinc|stannous|tin|lithium|strontium|barium)+(mono)?fluoro(silicate|phosphate|borate|titanate|zirconate|aluminate)$/

const FLUORURE_FINAL = /fluoride$/

// Gaz fluorés désignés par leur code : CF3 présent ou non.
const CODES_GAZ: Record<string, boolean> = {
  hydrofluorocarbon227ea: true,
  hydrofluorocarbon134a: true,
  hydrofluorocarbon245fa: true,
  hydrofluorocarbon365mfc: true,
  hydrofluorocarbon125: true,
  hydrofluorocarbon143a: true,
  hydrofluorocarbon236fa: true,
  hydrofluorocarbon152a: false,
  hydrofluorocarbon32: false,
  hydrofluorocarbon41: false,
  hydrochlorofluorocarbon123: true,
  hydrochlorofluorocarbon124: true,
  hydrochlorofluorocarbon22: false,
  hydrochlorofluorocarbon141b: false,
  hydrochlorofluorocarbon142b: false,
}

/** Exclusions nommées (clé compacte → raison), en plus des règles ci-dessus. */
export const EXCLUSIONS_NOMMEES: Record<string, string> = {
  sodiumfluoride: 'fluorure minéral',
  stannousfluoride: 'fluorure minéral',
  sodiummonofluorophosphate: 'fluoro-sel minéral',
  olaflur: 'fluorure d’amine',
  aminefluoride: 'fluorure d’amine',
  calciumfluoride: 'fluorure minéral',
  potassiumfluoride: 'fluorure minéral',
  fluorphlogopite: 'mica minéral au fluor',
  syntheticfluorphlogopite: 'mica minéral au fluor',
  difluoroethane: 'pas de carbone entièrement fluoré (HFC-152a)',
  '11difluoroethane': 'pas de carbone entièrement fluoré (HFC-152a)',
}

export function familleDe(c: string): Famille {
  if (/ptfe|polytetrafluoro|tetrafluoroethylene|hexafluoropropylene|teflon|vinylidene|pvdf|polychlorotrifluoro/.test(c))
    return 'fluoropolymeres'
  if (/hydrofluorocarbon|hydrochlorofluorocarbon|(propane|propene|butane|ethane|ethylene)$/.test(c)) return 'gaz'
  if (/dimethicon|methicon|siloxan|silane|silsesquioxane|siloxysilicate|silyl/.test(c)) return 'silicones'
  if (/acrylate|copolymer|crosspolymer/.test(c)) return 'copolymeres'
  if (/phosphate|phosphon|sulfonat|sulfonic|fluoroalcohol|alkylethanol|carboxylic/.test(c)) return 'phosphates'
  if (/perfluoro|polyperfluoro/.test(c)) return 'ethers_alcanes'
  if (/trifluoro/.test(c)) return 'cf3'
  return 'autre'
}

export interface ListesPfas {
  /** clé compacte → famille, pour les noms reconnus comme PFAS */
  pfas: Map<string, Famille>
  /** numéro CAS → famille */
  cas: Map<string, Famille>
  /** clé compacte → raison, pour les noms fluorés reconnus comme non PFAS */
  nonPfas: Map<string, string>
}

/**
 * Classe un nom d'ingrédient. `listes` est absent pendant la construction des listes.
 */
export function classer(nom: string, listes?: ListesPfas): Classement {
  const c = compact(nom)
  if (!c) return { niveau: 'aucun', regle: '' }

  // 1. Listes compilées (nom INCI ou numéro CAS)
  if (listes) {
    const fam = listes.pfas.get(c)
    if (fam) return { niveau: 'liste', famille: fam, regle: 'Nom présent dans la liste des PFAS cosmétiques' }
    const cas = nom.match(/\b\d{2,7}-\d{2}-\d\b/)
    if (cas) {
      const famCas = listes.cas.get(cas[0])
      if (famCas) return { niveau: 'liste', famille: famCas, regle: `Numéro CAS ${cas[0]} présent dans la liste des PFAS` }
    }
    const raison = listes.nonPfas.get(c)
    if (raison) return { niveau: 'exclu', regle: `Fluoré mais pas un PFAS : ${raison}` }
  }

  // 2. Exclusions obligatoires (fluorures minéraux et cas connus)
  const raisonNommee = EXCLUSIONS_NOMMEES[c]
  if (raisonNommee) return { niveau: 'exclu', regle: `Fluoré mais pas un PFAS : ${raisonNommee}` }
  if (c.includes('borontrifluoride')) return { niveau: 'exclu', regle: 'Fluoré mais pas un PFAS : fluorure de bore, sans carbone fluoré' }
  if (SELS_MINERAUX.test(c)) return { niveau: 'exclu', regle: 'Fluoré mais pas un PFAS : fluoro-sel minéral' }
  if (FLUORURE_FINAL.test(c) && !RACINES_FORTES.test(c))
    return { niveau: 'exclu', regle: 'Fluoré mais pas un PFAS : fluorure (le fluor n’est pas lié à une chaîne carbonée)' }

  // 3. Gaz désignés par leur code
  const gaz = c.match(/(hydrofluorocarbon|hydrochlorofluorocarbon)[0-9a-z]+/)
  if (gaz) {
    const cf3 = CODES_GAZ[gaz[0]]
    if (cf3 === true) return { niveau: 'mot_cle', famille: 'gaz', regle: 'Gaz fluoré portant un groupe CF3' }
    if (cf3 === false) return { niveau: 'exclu', regle: 'Fluoré mais pas un PFAS : gaz sans carbone entièrement fluoré' }
    return { niveau: 'possible', famille: 'gaz', regle: 'Gaz fluoré de structure inconnue' }
  }

  // 4. Mots-clés fluorés
  const forte = c.match(RACINES_FORTES)
  if (forte) return { niveau: 'mot_cle', famille: familleDe(c), regle: `Racine fluorée « ${forte[0]} » dans le nom` }
  if (FLUOR_AROMATIQUE_OU_ISOLE.test(c))
    return { niveau: 'possible', famille: 'autre', regle: 'Fluor sur un cycle ou isolé : en principe pas un PFAS, à vérifier' }
  if (c.includes('fluoro')) return { niveau: 'mot_cle', famille: familleDe(c), regle: 'Racine fluorée « fluoro » dans le nom' }
  if (/fluor(?!esc|ene|ide|phlogopite|ite|apatite|spar)/.test(c))
    return { niveau: 'possible', famille: 'autre', regle: 'Mention de fluor dans le nom, structure inconnue' }

  return { niveau: 'aucun', regle: '' }
}

const GRAVITE: Record<Niveau, number> = { liste: 4, mot_cle: 3, possible: 2, exclu: 1, aucun: 0 }

export function plusGrave(a: Classement, b: Classement): Classement {
  return GRAVITE[b.niveau] > GRAVITE[a.niveau] ? b : a
}

export function estPfas(n: Niveau): boolean {
  return n === 'liste' || n === 'mot_cle'
}
