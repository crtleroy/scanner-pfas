// Niveau de préoccupation quand un PFAS est trouvé : famille de PFAS, place dans la liste, usage du produit.
// Les textes (explication, conseils) sont dans public/data/explications.json ; ici, seulement la décision.
import { estPfas, type Famille } from './rules.ts'
import type { Resultat } from './analyse.ts'

export type NiveauGravite = 'elevee' | 'moderee' | 'faible'
export type Usage = 'cuisine' | 'cosmetique' | 'textile' | 'emballage' | 'autre'

/**
 * Petites molécules (alcools fluorés et leurs phosphates, éthers et alcanes perfluorés) : passent plus facilement
 * dans l'organisme et l'environnement, ou se dégradent en acides perfluorés. Polymères et silicones fluorés : moins
 * absorbés, mais persistants.
 */
const NIVEAU_FAMILLE: Record<Famille, NiveauGravite> = {
  phosphates: 'elevee',
  ethers_alcanes: 'elevee',
  fluoropolymeres: 'moderee',
  silicones: 'moderee',
  copolymeres: 'moderee',
  cf3: 'moderee',
  gaz: 'moderee',
  autre: 'moderee',
}

const RANG: Record<NiveauGravite, number> = { faible: 0, moderee: 1, elevee: 2 }
const UN_CRAN_DESSOUS: Record<NiveauGravite, NiveauGravite> = { elevee: 'moderee', moderee: 'faible', faible: 'faible' }

function sansAccents(s: string) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

export function usageDuProduit(r: Resultat): Usage {
  const t = sansAccents(r.typeProduit ?? '')
  if (/poele|casserole|wok|cocotte|moule|ustensile|cuisson|faitout|sauteuse|plancha|gaufrier|crepiere|grill/.test(t)) return 'cuisine'
  if (/textile|vetement|veste|manteau|chaussure|tissu|parapluie|nappe|impermeable|blouson/.test(t)) return 'textile'
  if (/emballage|papier|pop-?corn|gobelet|barquette|boite a pizza/.test(t)) return 'emballage'
  if (
    r.source === 'base_beaute' ||
    /cosmeti|maquillage|vernis|creme|shampo|gel douche|mascara|levres|fond de teint|soin|parfum|dentifrice|deodorant|fard|poudre|serum/.test(t)
  )
    return 'cosmetique'
  if (!r.aliment && (r.source === 'texte' || r.source === 'photo' || r.source === 'ia') && r.partComprise >= 0.5) return 'cosmetique'
  return 'autre'
}

export interface Gravite {
  niveau: NiveauGravite
  usage: Usage
  /** Faits qui expliquent le niveau, déjà rédigés */
  raisons: string[]
  familles: Famille[]
}

export function evaluerGravite(r: Resultat): Gravite | null {
  const pfas = r.ingredients.filter((i) => estPfas(i.classement.niveau))
  if (!pfas.length) return null
  const usage = usageDuProduit(r)
  const familles = [...new Set(pfas.map((i) => i.classement.famille ?? 'autre'))]
  let niveau: NiveauGravite = 'faible'
  for (const f of familles) if (RANG[NIVEAU_FAMILLE[f]] > RANG[niveau]) niveau = NIVEAU_FAMILLE[f]
  const raisons: string[] = []

  // Place dans la liste : les ingrédients sont rangés du plus abondant au moins abondant
  const liste = r.ingredients.filter((i) => i.reconnu)
  const positions = pfas.map((i) => liste.indexOf(i)).filter((p) => p >= 0)
  if (liste.length >= 6 && positions.length) {
    const premier = Math.min(...positions)
    if (premier >= Math.floor((liste.length * 2) / 3)) {
      niveau = UN_CRAN_DESSOUS[niveau]
      raisons.push(`En fin de liste (${premier + 1}e ingrédient sur ${liste.length}) : présent en faible quantité.`)
    } else if (premier < liste.length / 3) {
      raisons.push(`Parmi les premiers ingrédients (${premier + 1}e sur ${liste.length}) : présent en quantité notable.`)
    } else {
      raisons.push(`En milieu de liste (${premier + 1}e ingrédient sur ${liste.length}).`)
    }
  }
  for (const i of pfas) if (i.quantite) raisons.push(`${i.nom} : ${i.quantite}.`)
  if (usage === 'cuisine' && familles.includes('fluoropolymeres'))
    raisons.push('Revêtement de cuisson : le risque vient surtout de la surchauffe et de l’usure du revêtement.')

  return { niveau, usage, raisons, familles }
}
