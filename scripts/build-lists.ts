// Construit les listes embarquées dans l'appli à partir de la base d'ingrédients
// d'Open Beauty Facts (reprise de CosIng, Commission européenne).
//
// Usage : npm run build-lists            (télécharge la base si elle manque)
//         node scripts/build-lists.ts --refresh   (force un nouveau téléchargement)
//
// Produit :
//   public/data/inci.json          noms INCI + traductions + CAS + fonctions (analyse)
//   public/data/details/<x>.json   descriptions et restrictions (fiche d'un ingrédient)
//   public/data/pfas.json          noms INCI classés PFAS / fluorés non PFAS

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classer, compact, familleDe, type Famille } from '../src/engine/rules.ts'

const racine = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_URL = 'https://static.openbeautyfacts.org/data/taxonomies/ingredients.json'
const brut = join(racine, 'raw-data', 'obf', 'ingredients.json')
const sortie = join(racine, 'public', 'data')

if (!existsSync(brut) || process.argv.includes('--refresh')) {
  console.log(`Téléchargement de ${SOURCE_URL}…`)
  const rep = await fetch(SOURCE_URL)
  if (!rep.ok) throw new Error(`Téléchargement impossible : HTTP ${rep.status}`)
  mkdirSync(dirname(brut), { recursive: true })
  writeFileSync(brut, Buffer.from(await rep.arrayBuffer()))
}

type Valeurs = Record<string, string>
interface EntreeObf {
  name?: Valeurs
  'inn-name'?: Valeurs
  'ph-eur-name'?: Valeurs
  cas?: Valeurs
  inci_functions?: Valeurs
  inci_description?: Valeurs
  inci_restriction?: Valeurs
  cosing?: Valeurs
}

const base: Record<string, EntreeObf> = JSON.parse(readFileSync(brut, 'utf8'))
const date = new Date().toISOString().slice(0, 10)

const inci: [string, string, string, string][] = []
const details: Record<string, Record<string, [string, string]>> = {}
const pfas: { n: string; cas?: string; f: Famille }[] = []
const nonPfas: { n: string; r: string }[] = []
const vus = new Set<string>()

for (const e of Object.values(base)) {
  const nom = e.name?.en?.trim()
  // Les quelques entrées sans numéro CosIng sont gardées (Cyclopentasiloxane, Synthetic Beeswax…),
  // sauf les codes de parfumeurs (« F.I.L. b4885/3 ») et les regroupements (« Ingredients derived from… »).
  if (!nom || /^f\.i\.l\./i.test(nom) || /^ingredients\b/i.test(nom)) continue
  const cle = compact(nom)
  if (!cle || vus.has(cle)) continue
  vus.add(cle)

  const autres = new Set<string>()
  for (const [langue, v] of Object.entries(e.name ?? {})) {
    if (langue === 'en' || !v) continue
    if (compact(v) !== cle) autres.add(v.trim())
  }
  // Noms de pharmacopée (DCI, Ph. Eur.) : « macrogol 200 », « natrii chloridum »…
  for (const champ of [e['inn-name']?.en, e['ph-eur-name']?.en]) {
    for (const v of (champ ?? '').split(';')) {
      const propre = v.replace(/\[[^\]]*\]/g, '').trim()
      if (propre && compact(propre) !== cle) autres.add(propre)
    }
  }
  const cas = (e.cas?.en ?? '').trim()
  const fonctions = (e.inci_functions?.en ?? '')
    .split(',')
    .map((f) => f.trim().replace(/^en:/, ''))
    .filter(Boolean)
    .join(',')
  inci.push([nom, [...autres].join('|'), cas, fonctions])

  const desc = (e.inci_description?.en ?? '').trim()
  const restr = (e.inci_restriction?.en ?? '').trim()
  if (desc || restr) {
    const tiroir = /[a-z]/.test(cle[0]) ? cle[0] : '0'
    ;(details[tiroir] ??= {})[cle] = [desc, restr]
  }

  const cl = classer(nom)
  if (cl.niveau === 'mot_cle') pfas.push({ n: nom, ...(cas ? { cas } : {}), f: cl.famille ?? 'autre' })
  else if (cl.niveau === 'possible')
    // Revue manuelle du 08/11/2026 : dans CosIng, tous ces noms portent un fluor sur un cycle
    // aromatique ou un fluor isolé, sans CF2 ni CF3.
    nonPfas.push({ n: nom, r: 'fluor sur un cycle aromatique ou isolé, sans CF2 ni CF3' })
  else if (cl.niveau === 'exclu') nonPfas.push({ n: nom, r: cl.regle.replace(/^Fluoré mais pas un PFAS : /, '') })
}

// Noms commerciaux, pharmaceutiques et français (scripts/alias.json)
const alias: Record<string, string[] | string> = JSON.parse(readFileSync(join(racine, 'scripts', 'alias.json'), 'utf8'))
for (const [cible, noms] of Object.entries(alias)) {
  if (cible.startsWith('_') || !Array.isArray(noms)) continue
  const entree = inci.find((x) => compact(x[0]) === compact(cible))
  if (entree) entree[1] = [...new Set([...entree[1].split('|').filter(Boolean), ...noms])].join('|')
  else {
    inci.push([cible, noms.join('|'), '', ''])
    console.log(`Alias : « ${cible} » absent de CosIng, entrée ajoutée`)
  }
}

// Ajouts manuels : noms courants absents de CosIng ou écrits autrement sur les emballages.
const AJOUTS: string[] = ['POLYTETRAFLUOROETHYLENE', 'TEFLON', 'POLYVINYLIDENE FLUORIDE', 'PVDF', 'TETRAFLUOROETHANE']
for (const n of AJOUTS) {
  if (!pfas.some((p) => compact(p.n) === compact(n))) pfas.push({ n, f: familleDe(compact(n)) })
}

inci.sort((a, b) => a[0].localeCompare(b[0]))
pfas.sort((a, b) => a.n.localeCompare(b.n))
nonPfas.sort((a, b) => a.n.localeCompare(b.n))

rmSync(join(sortie, 'details'), { recursive: true, force: true })
mkdirSync(join(sortie, 'details'), { recursive: true })

const source = {
  nom: 'CosIng (Commission européenne), via la base d’ingrédients d’Open Beauty Facts',
  url: SOURCE_URL,
  licence: 'ODbL',
  date,
}

writeFileSync(join(sortie, 'inci.json'), JSON.stringify({ source, e: inci }))
for (const [tiroir, contenu] of Object.entries(details)) {
  writeFileSync(join(sortie, 'details', `${tiroir}.json`), JSON.stringify(contenu))
}
writeFileSync(
  join(sortie, 'pfas.json'),
  JSON.stringify(
    {
      source,
      methode:
        'Noms INCI de CosIng contenant du fluor, classés selon la définition OCDE 2021 (au moins un CF2 ou CF3 sans H, Cl, Br ni I), revus à la main le 08/11/2026. À recouper avec les listes EPA (étape 4).',
      pfas,
      nonPfas,
    },
    null,
    1,
  ),
)

const taille = (f: string) => `${Math.round(readFileSync(join(sortie, f)).length / 1024)} Ko`
console.log(`Ingrédients CosIng : ${inci.length} → inci.json (${taille('inci.json')})`)
console.log(`Fiches détaillées : ${Object.keys(details).length} fichiers dans details/`)
console.log(`PFAS : ${pfas.length} noms · fluorés non PFAS : ${nonPfas.length} → pfas.json (${taille('pfas.json')})`)
if (process.argv.includes('--revue')) {
  console.log('\n--- Fluorés non PFAS ---')
  for (const x of nonPfas) console.log(`${x.n}  →  ${x.r}`)
  console.log('\n--- PFAS par famille ---')
  for (const x of pfas) console.log(`[${x.f}] ${x.n}`)
}
