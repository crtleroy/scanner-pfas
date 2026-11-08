# Scanner PFAS

Web app mobile (PWA) qui dit si un produit contient probablement des PFAS, à partir de son code-barres ou d'une photo de sa liste d'ingrédients. Tout tourne dans le navigateur du téléphone : pas de serveur, pas de compte.

- Adresse : https://crtleroy.github.io/scanner-pfas/
- Cahier des charges : [document Claude « Scanner PFAS — Cahier des charges »](https://claude.ai/artifact/8yAMhaC4YnKEi3LVoQk7pv)

## Commandes

| Commande | Rôle |
| --- | --- |
| `npm run dev` | Lance l'appli en local sur http://localhost:5173/scanner-pfas/ |
| `npm test` | Tests du moteur d'analyse (jeu de test du cahier des charges inclus) |
| `npm run build-lists` | Recompile `public/data/` depuis la base d'ingrédients d'Open Beauty Facts (`--refresh` pour retélécharger, `--revue` pour afficher le classement des noms fluorés) |
| `npm run deploy` | Tests, construction, puis publication sur GitHub Pages (branche `gh-pages`) |

## Organisation

- `src/engine/` : moteur pur, sans interface. `rules.ts` (règles PFAS, définition OCDE 2021, exclusions), `texte.ts` (découpage, erreurs d'OCR), `dictionnaire.ts` (recherche exacte et tolérante aux fautes), `analyse.ts` (verdict).
- `src/scanner.ts` : caméra et codes-barres (API native sur Android, ZXing WebAssembly sur iPhone, fichier `.wasm` servi avec l'appli).
- `src/ocr.ts` : prétraitement de la photo et Tesseract.js (moteur et langues chargés depuis jsDelivr à la première lecture, puis gardés en cache).
- `src/donnees.ts` : Open Beauty / Food / Products Facts en parallèle, cache local de 7 jours ; chargement des listes.
- `public/data/` : `inci.json` (CosIng), `details/*.json` (descriptions, chargées à la demande), `pfas.json` (noms classés), `explications.json` (textes des fiches, mention réglementaire).

## Décisions prises le 08/11/2026

- Hébergement : GitHub Pages (gratuit, adresse fixe, dépôt public). Pas de tunnel Cloudflare.
- CosIng n'a pas d'export direct sur le portail de l'UE : la liste vient de la base d'ingrédients d'Open Beauty Facts, qui reprend CosIng (22 228 noms). Quelques noms INCI courants y manquent (Hydroxyethylcellulose, Acacia Senegal Gum) : un export CosIng complet améliorerait la reconnaissance.
- Le fluor sur un cycle aromatique (fluorophényle…) et les gaz sans carbone entièrement fluoré (HFC-152a, HCFC-22, HCFC-142b) ne déclenchent pas d'alerte rouge : ils ne sont pas des PFAS selon l'OCDE.
- Étapes 1 à 3 du cahier des charges faites.

## Décisions prises après le premier essai sur iPhone (08/11/2026)

- La lecture des étiquettes passe par le scanner de texte de l'iPhone (« Scanner du texte », Live Text) dans la zone de texte de l'appli ; la photo lue par Tesseract reste en secours (Android). Pas de lecture par IA payante.
- L'analyse ne dépend plus des virgules : `src/engine/lecture.ts` cherche les noms connus partout dans le texte, par groupes de 1 à 8 mots, avec tolérance aux fautes, numéros CAS et noms commerciaux (`scripts/alias.json` : IR3535, DEET, icaridine, macrogol, povidone iodée…).
- Le résultat montre le texte surligné : reconnu, PFAS, fluoré non PFAS, non compris. Un tap explique chaque morceau.
- Verdict « vert avec réserve » : vert dès qu'un ingrédient est reconnu sans signal PFAS, avec la part de texte comprise et une mise en garde si le texte ne ressemble pas à une liste d'ingrédients. Gris seulement si rien n'est reconnu. Les racines fluorées sont cherchées aussi dans les morceaux non compris.
- Un texte d'aliment (tableau nutritionnel) est signalé : les PFAS n'y figurent jamais dans la liste d'ingrédients.
- Photos de test réelles dans `photos-test/` (non publiées). Restent : listes EPA (4), test de structure PubChem + RDKit (5), historique, alertes secondaires (6).
