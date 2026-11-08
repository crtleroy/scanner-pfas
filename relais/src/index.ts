// Relais Cloudflare du Scanner PFAS.
// Reçoit une photo d'étiquette depuis l'appli, la fait lire par Claude Haiku 5.5 et renvoie la liste
// des ingrédients en JSON. La clé d'API reste ici (secret Cloudflare), jamais dans l'appli.
//
// Secrets (wrangler secret put …) : ANTHROPIC_API_KEY, CODE_ACCES
// En local, .dev.vars peut contenir MODE=factice pour répondre sans appeler Claude.
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'

export interface Env {
  ANTHROPIC_API_KEY: string
  CODE_ACCES: string
  MODE?: string
}

const MODELE = 'claude-haiku-5-5'
const ORIGINES = ['https://crtleroy.github.io', 'http://localhost:5173']
const TAILLE_MAX = 8 * 1024 * 1024 // base64, soit environ 6 Mo d'image

const Etiquette = z.object({
  type_produit: z.enum(['cosmetique', 'aliment', 'medicament', 'biocide', 'menager', 'autre', 'inconnu']),
  liste_trouvee: z.boolean(),
  lisibilite: z.enum(['bonne', 'partielle', 'mauvaise']),
  nom_produit: z.string().nullable(),
  ingredients: z.array(
    z.object({
      nom_lu: z.string(),
      nom_normalise: z.string(),
      quantite: z.string().nullable(),
      commentaire: z.string(),
    }),
  ),
  remarque: z.string().nullable(),
  texte_lu: z.string(),
})
export type Etiquette = z.infer<typeof Etiquette>

const CONSIGNES = `Tu lis la photo d'une étiquette de produit (cosmétique, aliment, médicament, biocide comme un anti-moustique, produit ménager…) pour une appli qui repère les PFAS.

Ta tâche : trouver sur la photo la liste des ingrédients ou la composition, et la recopier ingrédient par ingrédient.
- Ne recopie que ce qui est visible. N'invente jamais un ingrédient. Si la liste est coupée, floue ou en partie cachée, donne ce que tu lis et mets lisibilite à "partielle" (ou "mauvaise").
- nom_lu : l'ingrédient tel qu'il est écrit (corrige seulement les erreurs de lecture évidentes).
- nom_normalise : le nom INCI officiel pour un cosmétique (par exemple « AQUA », « PTFE ») ; pour un médicament ou un biocide, la substance (par exemple « ETHYL BUTYLACETYLAMINOPROPIONATE » pour l'IR3535, « PEG-8 » pour le macrogol 400, « POVIDONE-IODINE ») ; pour un aliment, le nom courant en français (« raisin », « sucre »).
- quantite : la quantité ou le pourcentage écrit à côté de l'ingrédient (« 35 % », « 10 g »), sinon null.
- commentaire : en français, 12 mots au plus, ce qu'est l'ingrédient et à quoi il sert (« fruit », « répulsif anti-moustique », « solvant », « conservateur »). Ne dis pas si c'est un PFAS : l'appli le vérifie elle-même avec ses propres listes.
- Ignore le reste de l'étiquette (mode d'emploi, valeurs nutritionnelles, adresse, slogans), mais sers-t'en pour deviner type_produit.
- texte_lu : le texte brut de la liste d'ingrédients ou de la composition, tel que tu le lis.
- S'il n'y a aucune liste d'ingrédients sur la photo, liste_trouvee = false, ingredients = [], et explique en une phrase dans remarque ce que montre la photo (par exemple « face avant avec le nom du produit, la liste est sans doute au dos »).
- remarque peut aussi signaler un point utile (liste dans une autre langue, plusieurs produits sur la photo…), sinon null.`

function reponse(corps: unknown, statut: number, entetes: Record<string, string>) {
  return new Response(JSON.stringify(corps), { status: statut, headers: { ...entetes, 'Content-Type': 'application/json; charset=utf-8' } })
}

const EXEMPLE: Etiquette = {
  type_produit: 'biocide',
  liste_trouvee: true,
  lisibilite: 'bonne',
  nom_produit: 'Anti-moustique (réponse simulée)',
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

    let corps: { image?: unknown; type?: unknown }
    try {
      corps = await req.json()
    } catch {
      return reponse({ erreur: 'requete' }, 400, cors)
    }
    const image = typeof corps.image === 'string' ? corps.image : ''
    const type = corps.type === 'image/png' || corps.type === 'image/webp' ? corps.type : 'image/jpeg'
    if (!image || image.length > TAILLE_MAX || !/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 200)))
      return reponse({ erreur: 'image' }, 400, cors)

    if (env.MODE === 'factice') return reponse({ ...EXEMPLE, modele: 'factice' }, 200, cors)

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
    try {
      const message = await client.messages.parse({
        model: MODELE,
        max_tokens: 8000,
        system: CONSIGNES,
        output_config: { effort: 'low', format: zodOutputFormat(Etiquette) },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: type, data: image } },
              { type: 'text', text: 'Lis la liste des ingrédients sur cette étiquette.' },
            ],
          },
        ],
      })
      if (message.stop_reason === 'refusal') return reponse({ erreur: 'refus' }, 422, cors)
      if (message.stop_reason === 'max_tokens' || !message.parsed_output) return reponse({ erreur: 'lecture' }, 502, cors)
      return reponse(
        {
          ...message.parsed_output,
          modele: message.model,
          jetons: { entree: message.usage.input_tokens, sortie: message.usage.output_tokens },
        },
        200,
        cors,
      )
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) return reponse({ erreur: 'limite' }, 429, cors)
      if (e instanceof Anthropic.AuthenticationError) return reponse({ erreur: 'cle' }, 500, cors)
      if (e instanceof Anthropic.APIError) return reponse({ erreur: 'claude', statut: e.status ?? null }, 502, cors)
      return reponse({ erreur: 'reseau' }, 502, cors)
    }
  },
}
