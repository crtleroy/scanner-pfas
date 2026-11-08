// Relais Cloudflare du Scanner PFAS.
// - analyser   : une ou plusieurs photos → Claude lit la liste d'ingrédients et reconnaît le produit
// - rechercher : produit reconnu → recherche internet (composition, preuves, bases de données, historique,
//                ce que dit la marque, ce que disent les autres), chaque fait avec ses sources
// - memoire    : résultat d'une recherche déjà faite, retrouvé par code-barres
// La clé d'API reste ici (secret Cloudflare), jamais dans l'appli. Le verdict PFAS est calculé par l'appli.
//
// Secrets (wrangler secret put … ou tableau de bord) : ANTHROPIC_API_KEY, CODE_ACCES
// Variables (wrangler.toml) : MODELE_PHOTO, MODELE_RECHERCHE, RECHERCHES_MAX
// Mémoire partagée : espace KV « MEMOIRE »
// En local, .dev.vars peut contenir MODE=factice pour répondre sans appeler Claude.
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'

export interface Env {
  ANTHROPIC_API_KEY: string
  CODE_ACCES: string
  MODE?: string
  MODELE_PHOTO?: string
  MODELE_RECHERCHE?: string
  RECHERCHES_MAX?: string
  MEMOIRE?: KVNamespace
}

const ORIGINES = ['https://crtleroy.github.io', 'http://localhost:5173']
const TAILLE_MAX = 8 * 1024 * 1024 // base64 par image, soit environ 6 Mo
const IMAGES_MAX = 4
const DUREE_MEMOIRE = 180 * 24 * 3600 // secondes
const VERSION_MEMOIRE = 'v2' // change quand la forme d'une recherche change : les anciennes sont ignorées

// ---------- Schémas des réponses ----------

const Ingredient = z.object({
  nom_lu: z.string(),
  nom_normalise: z.string(),
  quantite: z.string().nullable(),
  commentaire: z.string(),
})

const Etiquette = z.object({
  type_produit: z.enum(['cosmetique', 'aliment', 'medicament', 'biocide', 'menager', 'ustensile', 'textile', 'autre', 'inconnu']),
  liste_trouvee: z.boolean(),
  liste_complete: z.boolean(),
  lisibilite: z.enum(['bonne', 'partielle', 'mauvaise']),
  nom_produit: z.string().nullable(),
  produit: z.object({
    identifiable: z.boolean(),
    marque: z.string().nullable(),
    nom: z.string().nullable(),
    categorie: z.string().nullable(),
    confiance: z.enum(['haute', 'moyenne', 'faible']),
  }),
  ingredients: z.array(Ingredient),
  remarque: z.string().nullable(),
  texte_lu: z.string(),
})
export type Etiquette = z.infer<typeof Etiquette>

/** Un fait relevé dans des sources : jamais sans au moins une adresse */
const Fait = z.object({
  texte: z.string(),
  date: z.string().nullable(),
  sources: z.array(z.string()),
})

const Recherche = z.object({
  produit: z.object({ marque: z.string().nullable(), nom: z.string(), categorie: z.string().nullable() }),
  composition_trouvee: z.boolean(),
  ingredients: z.array(Ingredient),
  sources_composition: z.array(z.string()),
  preuves: z.object({
    niveau: z.enum(['absence_prouvee', 'inconnu', 'presence_prouvee']),
    commentaire: z.string(),
    faits: z.array(Fait),
  }),
  bases: z.array(z.object({ nom: z.string(), resultat: z.string(), url: z.string().nullable() })),
  historique: z.array(Fait),
  marque_dit: z.array(Fait),
  autres_disent: z.array(Fait),
  deduction_categorie: z.object({
    niveau: z.enum(['probable', 'possible', 'peu_probable', 'inconnu']),
    explication: z.string(),
  }),
  contradictions: z.array(Fait),
  sources: z.array(z.object({ titre: z.string(), url: z.string() })),
  remarque: z.string().nullable(),
})
export type Recherche = z.infer<typeof Recherche>

// ---------- Consignes ----------

const CONSIGNES_PHOTO = `Tu regardes une ou plusieurs photos d'un même produit (cosmétique, aliment, médicament, biocide comme un anti-moustique, produit ménager, ustensile comme une poêle, textile…) pour une appli qui repère les PFAS. Plusieurs photos sont des parties de la même étiquette : assemble-les en une seule liste, sans doublon.

1. Liste d'ingrédients ou composition visible : recopie-la ingrédient par ingrédient.
- Ne recopie que ce qui est visible. N'invente jamais un ingrédient.
- nom_lu : l'ingrédient tel qu'il est écrit (corrige seulement les erreurs de lecture évidentes).
- nom_normalise : le nom INCI officiel pour un cosmétique (« AQUA », « PTFE ») ; pour un médicament ou un biocide, la substance (« ETHYL BUTYLACETYLAMINOPROPIONATE » pour l'IR3535, « PEG-8 » pour le macrogol 400) ; pour un aliment, le nom courant en français (« raisin »).
- quantite : la quantité ou le pourcentage écrit à côté (« 35 % », « 10 g »), sinon null.
- commentaire : en français, 12 mots au plus, ce qu'est l'ingrédient et à quoi il sert. Ne dis pas si c'est un PFAS : l'appli le vérifie elle-même.
- liste_complete : false si la liste est visiblement coupée (bord de la photo, pouce, courbure du flacon, texte qui continue ailleurs), sinon true.
- lisibilite : "partielle" ou "mauvaise" si une partie est floue, coupée ou cachée.
- texte_lu : le texte brut de la liste, tel que tu le lis.

2. Produit : identifie toujours le produit si tu le peux, même quand la liste est visible, pour qu'on puisse chercher des informations en ligne. identifiable = true si la marque et le nom (ou un modèle précis) sont lisibles ou reconnaissables avec une bonne certitude. marque, nom (le plus précis possible : gamme, teinte, référence), categorie (en français : « vernis à ongles », « poêle antiadhésive », « gel douche »). confiance : "haute" si la marque et le nom sont écrits lisiblement, "moyenne" si tu les reconnais sans les lire entièrement, "faible" sinon.

3. Ignore le reste de l'étiquette (mode d'emploi, valeurs nutritionnelles, adresse, slogans), mais sers-t'en pour type_produit.
4. S'il n'y a pas de liste d'ingrédients, liste_trouvee = false, ingredients = [], et dis en une phrase dans remarque ce que montre la photo.`

const CONSIGNES_RECHERCHE = (max: number, listeConnue: boolean) => `Tu es l'assistant de recherche d'une appli qui repère les PFAS (substances per- et polyfluoroalkylées). On te donne un produit reconnu sur une photo. Tu fais au plus ${max} recherches internet en tout ; répartis-les sur les sujets ci-dessous.

Sujets :
1. Composition${listeConnue ? ' : déjà lue sur la photo, ne la cherche pas (laisse ingredients vide, composition_trouvee = false)' : ' de CE produit : liste INCI pour un cosmétique (site de la marque, Sephora, Nocibé, INCI Beauty, Open Beauty Facts…), ingrédients pour un aliment, matériaux et revêtements pour un objet (poêle, textile, emballage)'}.
2. Preuves et certifications : une analyse en laboratoire ou une certification indépendante qui porte explicitement sur les PFAS. niveau = "absence_prouvee" seulement si une telle preuve montre l'absence de PFAS ; "presence_prouvee" si une analyse, un rappel, une liste officielle ou la composition déclarée montre un PFAS dans ce produit ; "inconnu" sinon. Une simple déclaration de la marque n'est PAS une preuve : dis-le dans commentaire.
3. Bases de données : ce que disent INCI Beauty, Open Beauty Facts, EWG Skin Deep, QuelCosmetic, Safety Gate (rappels UE), les listes officielles… pour ce produit. Une ligne par base consultée, avec son adresse.
4. Historique : faits datés sur la marque et le produit vis-à-vis des PFAS (reformulations, études, rappels, procès, pollution d'une usine, engagements passés), même pour d'autres produits de la marque. Des faits, pas des accusations.
5. Ce que dit la marque : ses déclarations publiques sur les PFAS (politique, engagements, mentions « sans PFAS », « sans PFOA »…).
6. Ce que disent les autres : tests indépendants (UFC-Que Choisir, 60 Millions de consommateurs, Générations Futures, EWG, Mamavation…), associations, presse, plaintes.

Règles :
- N'invente rien. Chaque fait (preuves, historique, marque_dit, autres_disent, contradictions) doit citer au moins une adresse de page réellement trouvée par tes recherches dans sources. Sans source, n'écris pas le fait.
- Donne dès que possible des chiffres, des noms de molécules (PTFE, PFOA, PFHxA…), des familles et des quantités (« 1 200 ng/g de fluor organique »), et la date (année au moins).
- Ne recopie que des ingrédients trouvés pour ce produit précis. Si tu ne trouves que la composition d'un produit voisin, dis-le dans remarque et mets composition_trouvee = false. Pour un objet, liste les matériaux et revêtements comme ingrédients (« PTFE », commentaire « revêtement antiadhésif »). nom_normalise : nom INCI pour un cosmétique, nom de la substance ou du matériau sinon. commentaire : 12 mots au plus.
- « Sans PFOA » ne veut pas dire « sans PFAS » : le PTFE est un PFAS.
- deduction_categorie : ce que la nature du produit laisse penser (une poêle antiadhésive contient en général du PTFE sauf revêtement céramique annoncé ; un vernis à ongles en contient rarement…). C'est un raisonnement, pas un fait sourcé.
- contradictions : chaque désaccord entre sources (déclaration « sans PFAS » contredite par un test ou un ingrédient fluoré, compositions différentes…), avec les sources des deux côtés. Liste vide s'il n'y en a pas.
- Les listes peuvent rester vides : c'est mieux qu'un fait douteux.
- sources : toutes les pages utilisées, avec leur titre et leur adresse.
- Écris en français.

Quand tu as fini, appelle l'outil « rapport » avec ton résultat, sans autre texte.`

// ---------- Outils ----------

function reponse(corps: unknown, statut: number, entetes: Record<string, string>) {
  return new Response(JSON.stringify(corps), { status: statut, headers: { ...entetes, 'Content-Type': 'application/json; charset=utf-8' } })
}

/** Clé de mémoire d'un produit : marque + nom, sans accents ni ponctuation. */
function cleProduit(marque: string | null, nom: string): string {
  return (
    `${VERSION_MEMOIRE}p:` +
    `${marque ?? ''} ${nom}`
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  )
}
const cleCode = (code: string) => `${VERSION_MEMOIRE}c:${code}`

function domaine(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

async function lireMemoire(env: Env, cle: string): Promise<Recherche | null> {
  if (!env.MEMOIRE) return null
  try {
    const brut = await env.MEMOIRE.get(cle)
    return brut ? (JSON.parse(brut).recherche as Recherche) : null
  } catch {
    return null
  }
}

async function ecrireMemoire(env: Env, cles: string[], recherche: Recherche) {
  if (!env.MEMOIRE) return
  const valeur = JSON.stringify({ date: new Date().toISOString(), recherche })
  await Promise.all(cles.map((c) => env.MEMOIRE!.put(c, valeur, { expirationTtl: DUREE_MEMOIRE }).catch(() => {})))
}

const EXEMPLE_ETIQUETTE: Etiquette = {
  type_produit: 'biocide',
  liste_trouvee: true,
  liste_complete: true,
  lisibilite: 'bonne',
  nom_produit: 'Anti-moustique (réponse simulée)',
  produit: { identifiable: true, marque: 'Exemple', nom: 'Anti-moustique', categorie: 'répulsif', confiance: 'haute' },
  ingredients: [
    {
      nom_lu: 'IR3535 (ethyl butylacetylaminopropionate)',
      nom_normalise: 'ETHYL BUTYLACETYLAMINOPROPIONATE',
      quantite: '35 %',
      commentaire: 'répulsif anti-moustique',
    },
  ],
  remarque: 'Réponse simulée (MODE=factice), aucune photo n’a été lue.',
  texte_lu: "Contient de l'IR3535® 35% (m/m) (ethyl butylacetylaminopropionate - CAS 52304-36-6).",
}

const SRC = 'https://exemple.fr/produit'
const EXEMPLE_RECHERCHE: Recherche = {
  produit: { marque: 'Exemple', nom: 'Produit (réponse simulée)', categorie: 'répulsif' },
  composition_trouvee: false,
  ingredients: [],
  sources_composition: [],
  preuves: { niveau: 'inconnu', commentaire: 'Aucune analyse indépendante trouvée ; la marque seule ne vaut pas preuve.', faits: [] },
  bases: [{ nom: 'Open Beauty Facts', resultat: 'Produit absent de la base.', url: null }],
  historique: [{ texte: 'Fait historique simulé.', date: '2024', sources: [SRC] }],
  marque_dit: [{ texte: 'La marque déclare ses produits « sans PFAS » (simulé).', date: null, sources: [SRC] }],
  autres_disent: [],
  deduction_categorie: { niveau: 'peu_probable', explication: 'Ce type de produit en contient rarement.' },
  contradictions: [],
  sources: [{ titre: 'Page simulée', url: SRC }],
  remarque: 'Réponse simulée (MODE=factice).',
}

// ---------- Étapes ----------

class ErreurEtape extends Error {}

async function analyserPhotos(client: Anthropic, env: Env, images: { data: string; type: string }[]) {
  const message = await client.messages.parse({
    model: env.MODELE_PHOTO || 'claude-haiku-5-5',
    max_tokens: 8000,
    system: CONSIGNES_PHOTO,
    output_config: { effort: 'low', format: zodOutputFormat(Etiquette) },
    messages: [
      {
        role: 'user',
        content: [
          ...images.map((i) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: i.type as 'image/jpeg', data: i.data },
          })),
          {
            type: 'text' as const,
            text: images.length > 1 ? `Voici ${images.length} photos du même produit.` : 'Voici la photo du produit.',
          },
        ],
      },
    ],
  })
  console.log(`photo : ${message.stop_reason}, ${images.length} image(s), ${message.usage.input_tokens} jetons entrée, ${message.usage.output_tokens} sortie`)
  if (message.stop_reason === 'refusal') throw new ErreurEtape('refus')
  if (!message.parsed_output) throw new ErreurEtape('lecture')
  return message.parsed_output
}

async function rechercherProduit(
  client: Anthropic,
  env: Env,
  produit: Recherche['produit'],
  listeConnue: boolean,
): Promise<Recherche & { recherches: number }> {
  const max = Math.max(1, Math.min(10, Number(env.RECHERCHES_MAX) || 6))
  const modele = env.MODELE_RECHERCHE || 'claude-haiku-5-5'
  const schema = zodOutputFormat(Recherche).schema as Anthropic.Tool.InputSchema
  const outils: Anthropic.ToolUnion[] = [
    {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: max,
      user_location: { type: 'approximate', country: 'FR', timezone: 'Europe/Paris' },
    },
    {
      name: 'rapport',
      description: 'Rendre le résultat final de la recherche sur le produit et les PFAS.',
      input_schema: schema,
      strict: true,
    },
  ]
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Produit reconnu sur la photo : marque « ${produit.marque ?? 'inconnue'} », nom « ${produit.nom} », catégorie « ${produit.categorie ?? 'inconnue'} ».`,
    },
  ]
  const trouvees = new Map<string, string>() // url → titre, pages réellement renvoyées par la recherche
  let recherches = 0
  let texte = ''

  for (let tour = 0; tour < 4; tour++) {
    const message = await client.messages.create({
      model: modele,
      max_tokens: 16000,
      system: CONSIGNES_RECHERCHE(max, listeConnue),
      output_config: { effort: 'medium' },
      tools: outils,
      messages,
    })
    recherches += message.usage.server_tool_use?.web_search_requests ?? 0
    console.log(
      `recherche : ${message.stop_reason}, ${recherches} recherche(s), ${message.usage.input_tokens} jetons entrée, ${message.usage.output_tokens} sortie`,
    )
    for (const bloc of message.content) {
      if (bloc.type === 'web_search_tool_result' && Array.isArray(bloc.content))
        for (const r of bloc.content) trouvees.set(r.url, r.title)
      if (bloc.type === 'text') texte += bloc.text + '\n'
    }
    const appel = message.content.find((b) => b.type === 'tool_use' && b.name === 'rapport')
    if (appel && appel.type === 'tool_use') {
      const lu = Recherche.safeParse(appel.input)
      if (lu.success) return { ...nettoyer(lu.data, trouvees), recherches }
      break // rapport mal formé : on passe au secours ci-dessous
    }
    if (message.stop_reason === 'refusal') throw new ErreurEtape('refus')
    if (message.stop_reason !== 'pause_turn') break
    messages.push({ role: 'assistant', content: message.content })
  }

  // Secours : Claude a répondu en texte sans appeler l'outil → on met ce texte au format, sans nouvelle recherche
  const pages = [...trouvees].map(([url, titre]) => `- ${titre} : ${url}`).join('\n')
  const remise = await client.messages.parse({
    model: modele,
    max_tokens: 16000,
    system: CONSIGNES_RECHERCHE(0, listeConnue),
    output_config: { effort: 'low', format: zodOutputFormat(Recherche) },
    messages: [
      {
        role: 'user',
        content: `Produit : ${produit.marque ?? ''} ${produit.nom} (${produit.categorie ?? ''}).\n\nCompte rendu de recherche :\n${texte || '(aucun)'}\n\nPages trouvées :\n${pages || '(aucune)'}\n\nMets ce compte rendu au format demandé.`,
      },
    ],
  })
  if (!remise.parsed_output) throw new ErreurEtape('lecture')
  return { ...nettoyer(remise.parsed_output, trouvees), recherches }
}

/**
 * Ne garde que les adresses réellement renvoyées par la recherche, et retire tout fait sans source vérifiée
 * (règle de l'appli : chaque affirmation est sourcée).
 */
function nettoyer(r: Recherche, trouvees: Map<string, string>): Recherche {
  const connues = new Set(trouvees.keys())
  const domaines = new Set([...connues].map(domaine))
  const verifiee = (url: string | null) => !!url && (connues.has(url) || domaines.has(domaine(url)))
  const faits = (liste: Recherche['historique']) =>
    liste.map((f) => ({ ...f, sources: f.sources.filter(verifiee) })).filter((f) => f.sources.length > 0)
  return {
    ...r,
    sources: r.sources.filter((s) => verifiee(s.url)),
    sources_composition: r.sources_composition.filter(verifiee),
    preuves: { ...r.preuves, faits: faits(r.preuves.faits) },
    // Une base sans lien vérifié n'est pas affichée : chaque affirmation doit être sourcée
    bases: r.bases.filter((b) => verifiee(b.url)),
    historique: faits(r.historique),
    marque_dit: faits(r.marque_dit),
    autres_disent: faits(r.autres_disent),
    contradictions: faits(r.contradictions),
  }
}

// ---------- Point d'entrée ----------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origine = req.headers.get('Origin') ?? ''
    const cors = {
      'Access-Control-Allow-Origin': ORIGINES.includes(origine) ? origine : ORIGINES[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Code-Acces',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    }
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (req.method !== 'POST') return reponse({ erreur: 'methode' }, 405, cors)
    if (!ORIGINES.includes(origine)) return reponse({ erreur: 'origine' }, 403, cors)
    // Le code d'accès empêche des inconnus d'utiliser le relais aux frais du propriétaire
    if (!env.CODE_ACCES || req.headers.get('X-Code-Acces') !== env.CODE_ACCES) return reponse({ erreur: 'code' }, 401, cors)

    let corps: {
      action?: unknown
      image?: unknown
      images?: unknown
      type?: unknown
      produit?: { marque?: unknown; nom?: unknown; categorie?: unknown }
      code_barres?: unknown
      liste_connue?: unknown
    }
    try {
      corps = await req.json()
    } catch {
      return reponse({ erreur: 'requete' }, 400, cors)
    }
    const action = corps.action === 'rechercher' || corps.action === 'memoire' ? corps.action : 'analyser'
    const codeBarres = typeof corps.code_barres === 'string' && /^\d{8,14}$/.test(corps.code_barres) ? corps.code_barres : null
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
    const factice = env.MODE === 'factice'

    try {
      // Résultat déjà connu pour ce code-barres
      if (action === 'memoire') {
        const r = codeBarres ? await lireMemoire(env, cleCode(codeBarres)) : null
        return reponse(r ? { mode: 'recherche', recherche: r, depuis_memoire: true } : { mode: 'aucun' }, 200, cors)
      }

      // Recherche internet sur un produit reconnu
      if (action === 'rechercher') {
        const nom = typeof corps.produit?.nom === 'string' ? corps.produit.nom.slice(0, 200) : ''
        if (!nom) return reponse({ erreur: 'requete' }, 400, cors)
        const produit = {
          marque: typeof corps.produit?.marque === 'string' ? corps.produit.marque.slice(0, 100) : null,
          nom,
          categorie: typeof corps.produit?.categorie === 'string' ? corps.produit.categorie.slice(0, 100) : null,
        }
        const cle = cleProduit(produit.marque, produit.nom)
        const connue = await lireMemoire(env, cle)
        if (connue) {
          if (codeBarres) await ecrireMemoire(env, [cleCode(codeBarres)], connue)
          return reponse({ mode: 'recherche', recherche: connue, depuis_memoire: true }, 200, cors)
        }
        const recherche = factice
          ? { ...EXEMPLE_RECHERCHE, produit, recherches: 0 }
          : await rechercherProduit(client, env, produit, corps.liste_connue === true)
        await ecrireMemoire(env, codeBarres ? [cle, cleCode(codeBarres)] : [cle], recherche)
        return reponse({ mode: 'recherche', recherche, depuis_memoire: false }, 200, cors)
      }

      // Lecture des photos
      const brutes = Array.isArray(corps.images) ? corps.images : typeof corps.image === 'string' ? [corps.image] : []
      const images = brutes
        .slice(0, IMAGES_MAX)
        .filter((i): i is string => typeof i === 'string' && i.length > 0 && i.length <= TAILLE_MAX && /^[A-Za-z0-9+/=]+$/.test(i.slice(0, 200)))
        .map((data) => ({ data, type: corps.type === 'image/png' || corps.type === 'image/webp' ? corps.type : 'image/jpeg' }))
      if (!images.length) return reponse({ erreur: 'image' }, 400, cors)

      const etiquette = factice ? EXEMPLE_ETIQUETTE : await analyserPhotos(client, env, images)
      const p = etiquette.produit
      const identifie = p.identifiable && !!p.nom && p.confiance !== 'faible'
      // Produit déjà recherché : la recherche part avec la réponse, sans nouvelle recherche payante
      const connue = identifie ? await lireMemoire(env, cleProduit(p.marque, p.nom!)) : null
      const memoire = connue ? { recherche: connue, depuis_memoire: true } : {}
      if (etiquette.liste_trouvee && etiquette.ingredients.length) return reponse({ mode: 'liste', etiquette, ...memoire }, 200, cors)
      if (identifie) return reponse({ mode: 'produit', etiquette, ...memoire }, 200, cors)
      return reponse({ mode: 'liste', etiquette }, 200, cors)
    } catch (e) {
      // Journal visible avec « wrangler tail » (jamais la clé ni l'image)
      console.error('erreur :', e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : String(e))
      if (e instanceof ErreurEtape) return reponse({ erreur: e.message === 'refus' ? 'refus' : 'lecture' }, 502, cors)
      if (e instanceof Anthropic.RateLimitError) return reponse({ erreur: 'limite' }, 429, cors)
      if (e instanceof Anthropic.AuthenticationError) return reponse({ erreur: 'cle' }, 500, cors)
      if (e instanceof Anthropic.APIError) return reponse({ erreur: 'claude', statut: e.status ?? null }, 502, cors)
      return reponse({ erreur: 'reseau' }, 502, cors)
    }
  },
}
