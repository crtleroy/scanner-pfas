// Relais Cloudflare du Scanner PFAS.
// - analyser   : une ou plusieurs photos → Claude lit la liste d'ingrédients, ou reconnaît le produit
// - rechercher : produit reconnu → recherche internet orientée composition et PFAS (nombre de recherches plafonné)
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

interface KVNamespace {
  get(cle: string): Promise<string | null>
  put(cle: string, valeur: string, options?: { expirationTtl?: number }): Promise<void>
}

const ORIGINES = ['https://crtleroy.github.io', 'http://localhost:5173']
const TAILLE_MAX = 8 * 1024 * 1024 // base64 par image, soit environ 6 Mo
const IMAGES_MAX = 4
const DUREE_MEMOIRE = 180 * 24 * 3600 // secondes

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

const Recherche = z.object({
  produit: z.object({ marque: z.string().nullable(), nom: z.string(), categorie: z.string().nullable() }),
  composition_trouvee: z.boolean(),
  ingredients: z.array(Ingredient),
  indices: z.array(
    z.object({
      fait: z.string(),
      sens: z.enum(['presence', 'absence', 'incertain']),
      source: z.string().nullable(),
    }),
  ),
  sources: z.array(z.object({ titre: z.string(), url: z.string() })),
  deduction_categorie: z.object({
    niveau: z.enum(['probable', 'possible', 'peu_probable', 'inconnu']),
    explication: z.string(),
  }),
  contradictions: z.array(z.string()),
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

2. Produit : même s'il n'y a pas de liste, identifie le produit pour qu'on puisse chercher sa composition en ligne. identifiable = true si la marque et le nom (ou un modèle précis) sont lisibles ou reconnaissables avec une bonne certitude. marque, nom (le plus précis possible : gamme, teinte, référence), categorie (en français : « vernis à ongles », « poêle antiadhésive », « gel douche »). confiance : "haute" si la marque et le nom sont écrits lisiblement, "moyenne" si tu les reconnais sans les lire entièrement, "faible" sinon.

3. Ignore le reste de l'étiquette (mode d'emploi, valeurs nutritionnelles, adresse, slogans), mais sers-t'en pour type_produit.
4. S'il n'y a pas de liste d'ingrédients, liste_trouvee = false, ingredients = [], et dis en une phrase dans remarque ce que montre la photo.`

const CONSIGNES_RECHERCHE = (max: number) => `Tu es l'assistant de recherche d'une appli qui repère les PFAS (substances per- et polyfluoroalkylées). On te donne un produit reconnu sur une photo.

Étapes (au plus ${max} recherches internet en tout) :
1. Trouve la composition de CE produit : liste INCI pour un cosmétique (site de la marque, Sephora, Nocibé, Douglas, INCI Beauty, Open Beauty Facts…), ingrédients pour un aliment, matériaux et revêtements pour un objet (poêle, textile, emballage).
2. Cherche des informations sur les PFAS pour ce produit et cette marque : « marque produit PFAS », PTFE, téflon, fluor, déclarations « sans PFAS » ou « sans PFOA ».

Règles :
- N'invente rien. Ne recopie que des ingrédients trouvés dans une source pour ce produit précis. Si tu ne trouves que la composition d'un produit voisin de la gamme, dis-le dans remarque et mets composition_trouvee = false.
- Pour un objet, liste les matériaux et revêtements comme ingrédients (par exemple « PTFE » avec le commentaire « revêtement antiadhésif »).
- nom_normalise : nom INCI pour un cosmétique, nom de la substance ou du matériau sinon. commentaire : en français, 12 mots au plus, ce qu'est l'ingrédient. Ne juge pas toi-même si c'est un PFAS dans les ingrédients : l'appli le fait.
- indices : les faits utiles sur les PFAS relevés dans les sources (« la marque annonce un revêtement PTFE », « la marque déclare ses vernis sans PFAS depuis 2025 »), avec sens = "presence", "absence" ou "incertain", et l'adresse de la source.
- « Sans PFOA » ne veut pas dire « sans PFAS » : le PTFE est un PFAS. Le dire dans un indice si la source l'affirme.
- deduction_categorie : ce que la nature du produit laisse penser (une poêle antiadhésive contient en général du PTFE sauf revêtement céramique annoncé ; un vernis à ongles en contient rarement…), niveau "probable", "possible", "peu_probable" ou "inconnu".
- contradictions : chaque désaccord entre sources (compositions différentes, « sans PFAS » contredit par un ingrédient fluoré…), décrit en une phrase. Liste vide s'il n'y en a pas.
- sources : uniquement des pages réellement trouvées par tes recherches, avec leur titre et leur adresse.

Quand tu as fini, appelle l'outil « rapport » avec ton résultat, sans autre texte.`

// ---------- Outils ----------

function reponse(corps: unknown, statut: number, entetes: Record<string, string>) {
  return new Response(JSON.stringify(corps), { status: statut, headers: { ...entetes, 'Content-Type': 'application/json; charset=utf-8' } })
}

/** Clé de mémoire d'un produit : marque + nom, sans accents ni ponctuation. */
function cleProduit(marque: string | null, nom: string): string {
  return (
    'p:' +
    `${marque ?? ''} ${nom}`
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  )
}

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

const EXEMPLE_RECHERCHE: Recherche = {
  produit: { marque: 'Exemple', nom: 'Poêle antiadhésive (réponse simulée)', categorie: 'poêle antiadhésive' },
  composition_trouvee: true,
  ingredients: [
    { nom_lu: 'Revêtement PTFE', nom_normalise: 'PTFE', quantite: null, commentaire: 'revêtement antiadhésif' },
    { nom_lu: 'Aluminium', nom_normalise: 'aluminium', quantite: null, commentaire: 'corps de la poêle' },
  ],
  indices: [
    { fait: 'La marque annonce un revêtement « sans PFOA » : le PTFE reste un PFAS.', sens: 'presence', source: 'https://exemple.fr/poele' },
  ],
  sources: [{ titre: 'Fiche produit (simulée)', url: 'https://exemple.fr/poele' }],
  deduction_categorie: { niveau: 'probable', explication: 'Une poêle antiadhésive contient en général du PTFE.' },
  contradictions: [],
  remarque: 'Réponse simulée (MODE=factice).',
}

// ---------- Étapes ----------

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

class ErreurEtape extends Error {}

async function rechercherProduit(client: Anthropic, env: Env, produit: Recherche['produit']): Promise<Recherche & { recherches: number }> {
  const max = Math.max(1, Math.min(8, Number(env.RECHERCHES_MAX) || 4))
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
      description: 'Rendre le résultat final de la recherche sur la composition et les PFAS du produit.',
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
      max_tokens: 8000,
      system: CONSIGNES_RECHERCHE(max),
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
  const sources = [...trouvees].map(([url, titre]) => `- ${titre} : ${url}`).join('\n')
  const remise = await client.messages.parse({
    model: modele,
    max_tokens: 8000,
    system: CONSIGNES_RECHERCHE(0),
    output_config: { effort: 'low', format: zodOutputFormat(Recherche) },
    messages: [
      {
        role: 'user',
        content: `Produit : ${produit.marque ?? ''} ${produit.nom} (${produit.categorie ?? ''}).\n\nCompte rendu de recherche :\n${texte || '(aucun)'}\n\nPages trouvées :\n${sources || '(aucune)'}\n\nMets ce compte rendu au format demandé.`,
      },
    ],
  })
  if (!remise.parsed_output) throw new ErreurEtape('lecture')
  return { ...nettoyer(remise.parsed_output, trouvees), recherches }
}

/** Ne garde que les sources réellement renvoyées par la recherche (pas d'adresse inventée). */
function nettoyer(r: Recherche, trouvees: Map<string, string>): Recherche {
  const connues = new Set([...trouvees.keys()])
  const domaines = new Set([...connues].map(domaine))
  const verifiee = (url: string | null) => (url && (connues.has(url) || domaines.has(domaine(url))) ? url : null)
  return {
    ...r,
    sources: r.sources.filter((s) => verifiee(s.url)),
    indices: r.indices.map((i) => ({ ...i, source: verifiee(i.source) })),
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
        const r = codeBarres ? await lireMemoire(env, `c:${codeBarres}`) : null
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
          if (codeBarres) await ecrireMemoire(env, [`c:${codeBarres}`], connue)
          return reponse({ mode: 'recherche', recherche: connue, depuis_memoire: true }, 200, cors)
        }
        const recherche = factice ? { ...EXEMPLE_RECHERCHE, recherches: 0 } : await rechercherProduit(client, env, produit)
        await ecrireMemoire(env, codeBarres ? [cle, `c:${codeBarres}`] : [cle], recherche)
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
      if (etiquette.liste_trouvee && etiquette.ingredients.length) return reponse({ mode: 'liste', etiquette }, 200, cors)
      const p = etiquette.produit
      if (p.identifiable && p.nom && p.confiance !== 'faible') {
        // Produit déjà recherché : réponse immédiate, sans nouvelle recherche payante
        const connue = await lireMemoire(env, cleProduit(p.marque, p.nom))
        if (connue) return reponse({ mode: 'recherche', etiquette, recherche: connue, depuis_memoire: true }, 200, cors)
        return reponse({ mode: 'produit', etiquette }, 200, cors)
      }
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
