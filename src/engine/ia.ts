// Analyse d'une étiquette lue par Claude (relais Cloudflare).
// Claude ne fait que lire et recopier la liste ; le verdict PFAS vient de nos règles, nom par nom.
import { classer, estPfas, plusGrave, type Classement } from './rules.ts'
import type { IngredientAnalyse } from './lecture.ts'
import type { Confiance, Resultat, Ressources } from './analyse.ts'

/** Réponse du relais (même forme que le schéma Etiquette de relais/src/index.ts) */
export interface ReponseIA {
  type_produit: 'cosmetique' | 'aliment' | 'medicament' | 'biocide' | 'menager' | 'autre' | 'inconnu'
  liste_trouvee: boolean
  lisibilite: 'bonne' | 'partielle' | 'mauvaise'
  nom_produit: string | null
  ingredients: { nom_lu: string; nom_normalise: string; quantite: string | null; commentaire: string }[]
  remarque: string | null
  texte_lu: string
}

function pluriel(n: number, mot: string): string {
  return `${n} ${mot}${n > 1 ? 's' : ''}`
}

export function ingredientIA(
  item: ReponseIA['ingredients'][number],
  r: Ressources,
): IngredientAnalyse {
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

export function analyseIA(rep: ReponseIA, r: Ressources): Resultat {
  // Un même ingrédient écrit deux fois (nom commercial + nom chimique) n'apparaît qu'une fois
  const ingredients: IngredientAnalyse[] = []
  const vus = new Map<string, number>()
  for (const item of rep.ingredients) {
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

  const aliment = rep.type_produit === 'aliment'
  const partComprise = rep.lisibilite === 'bonne' ? 1 : rep.lisibilite === 'partielle' ? 0.6 : 0.3
  const familles = [...new Set(ingredients.flatMap((i) => (estPfas(i.classement.niveau) && i.classement.famille ? [i.classement.famille] : [])))]
  const base = {
    ingredients,
    texte: rep.texte_lu,
    morceaux: [],
    partComprise,
    aliment,
    source: 'ia' as const,
    familles,
    ...(rep.remarque && rep.liste_trouvee ? { remarque: rep.remarque } : {}),
  }
  const confiance: Confiance = rep.lisibilite === 'bonne' ? 'élevée' : rep.lisibilite === 'partielle' ? 'moyenne' : 'faible'
  let avertissement: string | undefined
  if (rep.lisibilite === 'partielle')
    avertissement = 'Une partie de la liste était coupée ou illisible sur la photo : les ingrédients cachés n’ont pas pu être vérifiés.'
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
      titre: 'PFAS détecté',
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
    titre: 'Aucun PFAS détecté',
    phrase: aliment ? 'Aucun PFAS dans la liste d’ingrédients.' : 'Aucun PFAS dans la composition lue.',
    confiance,
    ...(avertissement ? { avertissement } : {}),
  }
}
