// Analyse des réponses du relais Cloudflare : étiquette lue par Claude, ou produit reconnu puis cherché sur internet.
// Claude lit, recopie et cherche ; le verdict PFAS vient toujours de nos règles, nom par nom.
import { classer, estPfas, plusGrave, type Classement } from './rules.ts'
import type { IngredientAnalyse } from './lecture.ts'
import type { Confiance, FaitSource, InfosRecherche, Resultat, Ressources } from './analyse.ts'

type IngredientIA = { nom_lu: string; nom_normalise: string; quantite: string | null; commentaire: string }

/** Réponse « étiquette » du relais (schéma Etiquette de relais/src/index.ts) */
export interface ReponseIA {
  type_produit: string
  liste_trouvee: boolean
  liste_complete?: boolean
  lisibilite: 'bonne' | 'partielle' | 'mauvaise'
  nom_produit: string | null
  produit?: {
    niveau: 'modele' | 'marque' | 'categorie' | 'aucun'
    marque: string | null
    nom: string | null
    categorie: string | null
    confiance: string
  }
  ingredients: IngredientIA[]
  remarque: string | null
  texte_lu: string
}

/** Réponse « recherche » du relais (schéma Recherche de relais/src/index.ts) */
export interface ReponseRecherche {
  produit: { marque: string | null; nom: string | null; categorie: string | null }
  composition_trouvee: boolean
  ingredients: IngredientIA[]
  sources_composition: string[]
  preuves: { niveau: 'absence_prouvee' | 'inconnu' | 'presence_prouvee'; commentaire: string; faits: FaitSource[] }
  bases: { nom: string; resultat: string; url: string | null; portee?: 'produit' | 'marque' | 'categorie' }[]
  historique: FaitSource[]
  marque_dit: FaitSource[]
  autres_disent: FaitSource[]
  autres_substances?: FaitSource[]
  deduction_categorie: { niveau: 'probable' | 'possible' | 'peu_probable' | 'inconnu'; explication: string }
  contradictions: FaitSource[]
  sources: { titre: string; url: string }[]
  remarque: string | null
  recherches?: number
}

export function infosRecherche(rep: ReponseRecherche, depuisMemoire: boolean): InfosRecherche {
  return {
    produit: rep.produit,
    compositionTrouvee: rep.composition_trouvee,
    sourcesComposition: rep.sources_composition ?? [],
    preuves: rep.preuves ?? { niveau: 'inconnu', commentaire: '', faits: [] },
    bases: rep.bases ?? [],
    historique: rep.historique ?? [],
    marqueDit: rep.marque_dit ?? [],
    autresDisent: rep.autres_disent ?? [],
    autresSubstances: rep.autres_substances ?? [],
    contradictions: rep.contradictions ?? [],
    deduction: rep.deduction_categorie,
    sources: rep.sources ?? [],
    recherches: rep.recherches ?? 0,
    depuisMemoire,
  }
}

/**
 * Ajoute une recherche internet à un résultat déjà établi (liste lue sur la photo ou base de données) :
 * le verdict « PFAS listés » reste celui de la liste ; la recherche remplit les autres encarts.
 */
export function ajouterRecherche(res: Resultat, rep: ReponseRecherche, depuisMemoire: boolean): Resultat {
  const infos = infosRecherche(rep, depuisMemoire)
  return {
    ...res,
    recherche: infos,
    typeProduit: res.typeProduit && res.typeProduit !== 'inconnu' ? res.typeProduit : (rep.produit.categorie ?? res.typeProduit),
  }
}

function pluriel(n: number, mot: string): string {
  return `${n} ${mot}${n > 1 ? 's' : ''}`
}

export function ingredientIA(item: IngredientIA, r: Ressources): IngredientAnalyse {
  // Recherche exacte seulement : Claude a déjà corrigé l'orthographe, et un rapprochement approximatif
  // pourrait faire passer un nom ordinaire pour un nom fluoré voisin.
  const trouve = r.dictionnaire.chercher(item.nom_normalise, false) ?? r.dictionnaire.chercher(item.nom_lu, false)
  let classement: Classement = trouve ? classer(trouve.nom, r.listes) : { niveau: 'aucun', regle: '' }
  // Les noms écrits comptent aussi : une racine fluorée ne doit pas se perdre dans la normalisation
  if (classement.niveau !== 'exclu') {
    classement = plusGrave(classement, classer(item.nom_normalise, r.listes))
    classement = plusGrave(classement, classer(item.nom_lu, r.listes))
  }
  return {
    brut: item.nom_lu,
    nom: item.nom_normalise || item.nom_lu,
    reconnu: true,
    ...(trouve ? { index: trouve.index } : {}),
    classement,
    ...(item.quantite ? { quantite: item.quantite } : {}),
    ...(item.commentaire ? { commentaire: item.commentaire } : {}),
  }
}

/** Ingrédients sans doublon (un même ingrédient écrit sous deux noms n'apparaît qu'une fois), dans l'ordre de la liste */
function ingredientsUniques(items: IngredientIA[], r: Ressources): IngredientAnalyse[] {
  const ingredients: IngredientAnalyse[] = []
  const vus = new Map<string, number>()
  for (const item of items) {
    const ing = ingredientIA(item, r)
    const cle = ing.index !== undefined ? `i${ing.index}` : ing.nom.toLowerCase()
    const deja = vus.get(cle)
    if (deja !== undefined) {
      ingredients[deja].classement = plusGrave(ingredients[deja].classement, ing.classement)
      ingredients[deja].quantite ??= ing.quantite
    } else {
      vus.set(cle, ingredients.push(ing) - 1)
    }
  }
  return ingredients
}

function famillesDe(ingredients: IngredientAnalyse[]) {
  return [...new Set(ingredients.flatMap((i) => (estPfas(i.classement.niveau) && i.classement.famille ? [i.classement.famille] : [])))]
}

export function analyseIA(rep: ReponseIA, r: Ressources): Resultat {
  const ingredients = ingredientsUniques(rep.ingredients, r)
  const aliment = rep.type_produit === 'aliment'
  const partComprise = rep.lisibilite === 'bonne' ? 1 : rep.lisibilite === 'partielle' ? 0.6 : 0.3
  const listeIncomplete = rep.liste_trouvee && (rep.liste_complete === false || rep.lisibilite !== 'bonne')
  const base = {
    ingredients,
    texte: rep.texte_lu,
    morceaux: [],
    partComprise,
    aliment,
    source: 'ia' as const,
    familles: famillesDe(ingredients),
    typeProduit: rep.produit?.categorie ?? rep.type_produit,
    ...(listeIncomplete ? { listeIncomplete } : {}),
    ...(rep.remarque && rep.liste_trouvee ? { remarque: rep.remarque } : {}),
  }
  const confiance: Confiance = rep.lisibilite === 'bonne' ? 'élevée' : rep.lisibilite === 'partielle' ? 'moyenne' : 'faible'
  let avertissement: string | undefined
  if (rep.liste_complete === false || rep.lisibilite === 'partielle')
    avertissement = 'La liste est coupée ou en partie illisible sur la photo : les ingrédients cachés n’ont pas pu être vérifiés. Complétez avec une autre photo.'
  else if (rep.lisibilite === 'mauvaise')
    avertissement = 'La photo était difficile à lire : reprenez-la plus près, bien à plat et sans reflet.'

  if (!rep.liste_trouvee || ingredients.length === 0) {
    return {
      ...base,
      verdict: 'gris',
      titre: 'Indéterminé',
      phrase: rep.remarque ?? 'Aucune liste d’ingrédients trouvée sur la photo.',
      confiance: 'faible',
    }
  }

  const pfas = ingredients.filter((i) => estPfas(i.classement.niveau))
  if (pfas.length)
    return {
      ...base,
      verdict: 'rouge',
      titre: 'PFAS dans la liste',
      phrase: `${pluriel(pfas.length, 'ingrédient')} de la famille des PFAS`,
      confiance: pfas.some((i) => i.classement.niveau === 'liste') && confiance !== 'faible' ? 'élevée' : 'moyenne',
      ...(avertissement ? { avertissement } : {}),
    }

  const possibles = ingredients.filter((i) => i.classement.niveau === 'possible')
  if (possibles.length)
    return {
      ...base,
      verdict: 'orange',
      titre: 'PFAS possible',
      phrase: `${pluriel(possibles.length, 'ingrédient')} fluoré${possibles.length > 1 ? 's' : ''} à vérifier`,
      confiance: 'faible',
      ...(avertissement ? { avertissement } : {}),
    }

  return {
    ...base,
    verdict: 'vert',
    titre: 'Aucun PFAS dans la liste',
    phrase: aliment ? 'Aucun PFAS dans la liste d’ingrédients.' : 'Aucun PFAS dans la composition lue.',
    confiance,
    ...(avertissement ? { avertissement } : {}),
  }
}

/** Résultat d'une recherche internet sur un produit reconnu, quand aucune liste n'a été lue sur la photo */
export function analyseRecherche(rep: ReponseRecherche, r: Ressources, depuisMemoire = false): Resultat {
  const infos = infosRecherche(rep, depuisMemoire)
  const ingredients = ingredientsUniques(rep.ingredients, r)
  // Une présence prouvée qui nomme une substance fluorée (« revêtement PTFE ») compte comme un ingrédient
  if (infos.preuves.niveau === 'presence_prouvee') {
    for (const fait of infos.preuves.faits) {
      // Seuls les faits sur ce produit précis comptent (pas ceux sur la marque ou le type de produit)
      if (fait.portee && fait.portee !== 'produit') continue
      const cl = classer(fait.texte, r.listes)
      if (!estPfas(cl.niveau) || ingredients.some((i) => estPfas(i.classement.niveau) && i.classement.famille === cl.famille)) continue
      ingredients.push({ brut: fait.texte, nom: fait.texte, reconnu: false, classement: cl, commentaire: 'relevé dans une source' })
    }
  }

  const aliment = /aliment|boisson|jus|nourriture/i.test(rep.produit.categorie ?? '')
  const base = {
    ingredients,
    texte: '',
    morceaux: [],
    partComprise: rep.composition_trouvee ? 1 : 0,
    aliment,
    source: 'recherche' as const,
    familles: famillesDe(ingredients),
    typeProduit: rep.produit.categorie ?? undefined,
    recherche: infos,
    ...(rep.remarque ? { remarque: rep.remarque } : {}),
  }
  const contradiction = infos.contradictions.length > 0
  const avertissement = contradiction
    ? `Les sources se contredisent (${pluriel(infos.contradictions.length, 'point')}) : voyez le détail ci-dessous avant de conclure.`
    : undefined
  const avecAvertissement = avertissement ? { avertissement } : {}

  const pfas = ingredients.filter((i) => estPfas(i.classement.niveau))
  if (pfas.length)
    return {
      ...base,
      verdict: 'rouge',
      titre: 'PFAS dans la composition',
      phrase: rep.composition_trouvee
        ? `${pluriel(pfas.length, 'ingrédient')} de la famille des PFAS dans la composition trouvée en ligne`
        : 'Une source signale une substance de la famille des PFAS',
      confiance: contradiction ? 'faible' : 'moyenne',
      ...avecAvertissement,
    }

  const possibles = ingredients.filter((i) => i.classement.niveau === 'possible')
  if (possibles.length)
    return {
      ...base,
      verdict: 'orange',
      titre: 'PFAS possible',
      phrase: `${pluriel(possibles.length, 'ingrédient')} fluoré${possibles.length > 1 ? 's' : ''} à vérifier`,
      confiance: 'faible',
      ...avecAvertissement,
    }

  if (rep.composition_trouvee && ingredients.length)
    return {
      ...base,
      verdict: 'vert',
      titre: 'Aucun PFAS dans la composition',
      phrase: 'Aucun PFAS dans la composition trouvée en ligne.',
      confiance: contradiction ? 'faible' : 'moyenne',
      ...avecAvertissement,
    }

  // Composition introuvable : on s'appuie sur la nature du produit
  const d = rep.deduction_categorie
  if (d.niveau === 'probable')
    return { ...base, verdict: 'orange', titre: 'PFAS probable', phrase: d.explication, confiance: 'faible', ...avecAvertissement }
  if (d.niveau === 'possible')
    return { ...base, verdict: 'orange', titre: 'À vérifier', phrase: d.explication, confiance: 'faible', ...avecAvertissement }
  return {
    ...base,
    verdict: 'gris',
    titre: 'Composition inconnue',
    phrase: `Composition introuvable en ligne. ${d.explication}`.trim(),
    confiance: 'faible',
    ...avecAvertissement,
  }
}
