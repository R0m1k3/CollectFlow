//! `GET /api/v1/openapi.json` — spécification OpenAPI 3.1 de l'API CollectFlow
//! (port de `src/app/api/v1/openapi.json/route.ts`).
//!
//! **Volontairement accessible sans authentification.** Le document ne décrit que la
//! structure de l'API (chemins, paramètres, schémas) et ne contient aucune donnée
//! métier ; or ChatGPT et les autres plateformes d'agents importent le schéma par URL,
//! avant même que la clé ne soit configurée. Exiger une clé ici rendrait l'import
//! impossible.
//!
//! `servers` est construit depuis l'hôte appelant (ou COLLECTFLOW_PUBLIC_URL) : les
//! Actions ChatGPT exigent une URL **absolue**, une URL relative étant rejetée.
//!
//! Le document est construit comme en TS (mêmes fragments partagés :
//! `paginationParams`, `sortParams`, `erreur`), avec des objets à clés ordonnées
//! pour que le JSON produit soit identique à celui de la version Node.

use super::gammes::GAMMES;
use super::store::GRID_SORT_KEYS;
use axum::http::{header, HeaderMap};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{Map, Value};

/// Objet JSON aux clés ordonnées comme un objet JS : indices entiers croissants
/// d'abord (les codes de réponse « 200 », « 401 », « 404 »…), puis les autres clés
/// dans l'ordre d'écriture.
fn o<const N: usize>(entrees: [(&str, Value); N]) -> Value {
    let mut m = Map::new();
    for (k, v) in entrees {
        m.insert(k.to_string(), v);
    }
    Value::Object(super::js::js_object_order(m))
}

/// Origine publique : `COLLECTFLOW_PUBLIC_URL` (sans `/` final), sinon celle de la
/// requête (`req.nextUrl.origin`), reconstruite depuis les en-têtes — ceux du
/// mandataire inverse en priorité.
pub fn origine(headers: &HeaderMap) -> String {
    let configured = std::env::var("COLLECTFLOW_PUBLIC_URL")
        .ok()
        .map(|v| super::js::js_trim(&v).trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty());
    if let Some(c) = configured {
        return c;
    }
    let premier = |nom: &str| {
        headers
            .get(nom)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let proto = premier("x-forwarded-proto").unwrap_or_else(|| "http".into());
    let hote = premier("x-forwarded-host").or_else(|| premier("host")).unwrap_or_else(|| "localhost".into());
    format!("{proto}://{hote}")
}

/// Document OpenAPI complet pour une origine donnée.
pub fn build_spec(origin: &str) -> Value {
    let grid_sort_keys: Vec<&str> = GRID_SORT_KEYS.to_vec();
    let pagination_params: Vec<Value> = vec![
            o([
                ("name", Value::from("page")),
                ("in", Value::from("query")),
                ("schema", o([
                    ("type", Value::from("integer")),
                    ("minimum", Value::from(1)),
                    ("default", Value::from(1)),
                ])),
                ("description", Value::from("Numéro de page.")),
            ]),
            o([
                ("name", Value::from("limit")),
                ("in", Value::from("query")),
                ("schema", o([
                    ("type", Value::from("integer")),
                    ("minimum", Value::from(1)),
                ])),
                ("description", Value::from("Lignes par page, sans plafond. Sur /grid, OMETTRE ce paramètre renvoie toutes les lignes du fournisseur en un seul appel — c'est le mode recommandé. Sur les autres endpoints, le défaut est 100.")),
            ]),
        ];

    let sort_params: Vec<Value> = vec![
        o([
            ("name", Value::from("sort")),
            ("in", Value::from("query")),
            ("schema", o([("type", Value::from("string")), ("enum", Value::from(grid_sort_keys.clone()))])),
            ("description", Value::from("Colonne de tri.")),
        ]),
        o([
            ("name", Value::from("order")),
            ("in", Value::from("query")),
            (
                "schema",
                o([
                    ("type", Value::from("string")),
                    ("enum", Value::Array(vec![Value::from("asc"), Value::from("desc")])),
                    ("default", Value::from("desc")),
                ]),
            ),
            ("description", Value::from("Sens du tri.")),
        ]),
        o([
            ("name", Value::from("fields")),
            ("in", Value::from("query")),
            ("schema", o([("type", Value::from("string"))])),
            (
                "description",
                Value::from(concat!(
                    "Colonnes à retourner, séparées par des virgules (ex. « codein,libelle1,totalCa »). ",
                    "À utiliser systématiquement : une ligne complète contient les séries mensuelles et les ",
                    "ventilations par magasin, ce qui est très volumineux. `codein` est toujours inclus."
                )),
            ),
        ]),
        o([
            ("name", Value::from("enrich")),
            ("in", Value::from("query")),
            (
                "schema",
                o([
                    ("type", Value::from("string")),
                    ("enum", Value::Array(vec![Value::from("0"), Value::from("1")])),
                    ("default", Value::from("1")),
                ]),
            ),
            (
                "description",
                Value::from(concat!(
                    "1 (défaut) : relit les métriques réseau Qlik (`network`) et la gamme serveur ",
                    "(`codeGammeServeur`) au moment de l'appel. 0 : sert l'instantané brut."
                )),
            ),
        ]),
    ];

    let codes_gamme: Vec<&str> = GAMMES.iter().map(|g| g.code).collect();
    let legende_gammes = GAMMES.iter().map(|g| format!("{} ({})", g.code, g.nom)).collect::<Vec<_>>().join(", ");
    let erreur = |description: Value| {
        o([
            ("description", description),
            ("content", o([("application/json", o([("schema", o([("$ref", Value::from("#/components/schemas/Error"))]))]))])),
        ])
    };

    let spec = o([
            ("openapi", Value::from("3.1.0")),
            ("info", o([
                ("title", Value::from("CollectFlow API")),
                ("version", Value::from("1.0.0")),
                ("description", Value::from(concat!("Données de la grille CollectFlow : ventes sur 12 mois par magasin, stock, marges, ", "gammes et métriques du réseau Qlik (~270 magasins Foir'Fouille), plus la recherche de produits.\n\n", "**N'importe quel fournisseur peut être interrogé directement.** Les réponses sont servies ", "depuis un instantané persisté ; si le fournisseur demandé n'en a pas encore, `/grid` le calcule ", "à la demande. Ce premier appel prend alors plusieurs secondes, les suivants sont immédiats. ", "Passez `compute=0` pour refuser ce calcul et obtenir un `202 not_ready` immédiat.\n\n", "**Aucun endpoint ne contacte Qlik en direct** : les métriques réseau viennent d'un cache ", "alimenté par une synchronisation séparée.\n\n", "Deux informations sont relues à chaque appel car elles évoluent indépendamment : les métriques ", "réseau Qlik (`network`, `null` s'il n'y en a pas) et la gamme serveur non modifiée ", "(`codeGammeServeur`).\n\n", "**Gammes** : `PUT /products/{codein}/gamme` (un article) et `POST /gammes` (plusieurs) ", "**proposent** une gamme. La proposition reste **à valider** : elle apparaît dans la Grille ", "comme une modification non enregistrée, pour voir quels produits changent de gamme, et ", "n'est appliquée qu'une fois validée par un utilisateur (« Enregistrer »). D'ici là, ", "`codeGamme` est inchangée et la proposition figure dans `gammeAValider`. Une fois validée, ", "`codeGammeServeur` reste la gamme en base FF jusqu'à l'import des gammes modifiées."))),
            ])),
            ("servers", Value::Array(vec![
                o([
                    ("url", Value::from(format!("{}/api/v1", origin))),
                    ("description", Value::from("API CollectFlow")),
                ]),
            ])),
            ("security", Value::Array(vec![
                o([
                    ("ApiKeyAuth", Value::Array(vec![])),
                ]),
            ])),
            ("components", o([
                ("securitySchemes", o([
                    ("ApiKeyAuth", o([
                        ("type", Value::from("apiKey")),
                        ("in", Value::from("header")),
                        ("name", Value::from("X-API-Key")),
                    ])),
                ])),
                ("schemas", o([
                    ("Error", o([
                        ("type", Value::from("object")),
                        ("properties", o([
                            ("error", o([
                                ("type", Value::from("object")),
                                ("properties", o([
                                    ("code", o([
                                        ("type", Value::from("string")),
                                        ("enum", Value::Array(vec![
                                            Value::from("unauthorized"),
                                            Value::from("forbidden"),
                                            Value::from("bad_request"),
                                            Value::from("not_found"),
                                            Value::from("not_ready"),
                                            Value::from("internal_error"),
                                        ])),
                                    ])),
                                    ("message", o([
                                        ("type", Value::from("string")),
                                    ])),
                                ])),
                            ])),
                        ])),
                    ])),
                    ("Pagination", o([
                        ("type", Value::from("object")),
                        ("properties", o([
                            ("page", o([
                                ("type", Value::from("integer")),
                            ])),
                            ("limit", o([
                                ("type", Value::from("integer")),
                            ])),
                            ("total", o([
                                ("type", Value::from("integer")),
                            ])),
                            ("totalPages", o([
                                ("type", Value::from("integer")),
                            ])),
                            ("hasMore", o([
                                ("type", Value::from("boolean")),
                                ("description", Value::from("true = il reste des pages. Sur /grid, meta.complet dit la même chose en positif.")),
                            ])),
                        ])),
                    ])),
                    ("Fournisseur", o([
                        ("type", Value::from("object")),
                        ("properties", o([
                            ("code", o([
                                ("type", Value::from("string")),
                                ("description", Value::from("Code fournisseur, à passer au paramètre `fournisseur`.")),
                            ])),
                            ("nom", o([
                                ("type", Value::Array(vec![Value::from("string"), Value::from("null")])),
                            ])),
                            ("hasSnapshot", o([
                                ("type", Value::from("boolean")),
                                ("description", Value::from("false = données pas encore disponibles pour ce fournisseur.")),
                            ])),
                            ("rowCount", o([
                                ("type", Value::from("integer")),
                            ])),
                            ("computedAt", o([
                                ("type", Value::Array(vec![Value::from("string"), Value::from("null")])),
                                ("format", Value::from("date-time")),
                            ])),
                        ])),
                    ])),
                    ("NetworkMetrics", o([
                        ("type", Value::Array(vec![Value::from("object"), Value::from("null")])),
                        ("description", Value::from("Métriques du réseau Qlik. `null` quand le produit n'a pas de données réseau.")),
                        ("properties", o([
                            ("caReseau", o([
                                ("type", Value::from("number")),
                            ])),
                            ("qteReseau", o([
                                ("type", Value::from("number")),
                            ])),
                            ("nbMagasinsReseau", o([
                                ("type", Value::from("integer")),
                                ("description", Value::from("Nombre de magasins du réseau vendant le produit (sur ~270).")),
                            ])),
                            ("caParMagasinReseau", o([
                                ("type", Value::from("number")),
                                ("description", Value::from("CA moyen par magasin : normalise la présence, préférable au CA brut pour comparer.")),
                            ])),
                            ("margePctReseau", o([
                                ("type", Value::from("number")),
                                ("description", Value::from("Taux de marge, ratio brut (0.32 = 32 %).")),
                            ])),
                            ("qteByMonth", o([
                                ("type", Value::Array(vec![Value::from("object"), Value::from("null")])),
                                ("description", Value::from("Quantités vendues par mois, clés « YYYY-MM ».")),
                            ])),
                            ("fetchedAt", o([
                                ("type", Value::Array(vec![Value::from("string"), Value::from("null")])),
                                ("format", Value::from("date-time")),
                            ])),
                        ])),
                    ])),
                    ("Product", o([
                        ("type", Value::from("object")),
                        ("description", Value::from(concat!("Ligne de grille : un article chez un fournisseur. La liste de propriétés ci-dessous ", "n'est pas exhaustive — la réponse contient l'intégralité de la ligne (une soixantaine ", "de champs). Utilisez `fields` pour n'en garder qu'une partie."))),
                        ("properties", o([
                            ("codein", o([
                                ("type", Value::from("string")),
                                ("description", Value::from("Identifiant interne de l'article.")),
                            ])),
                            ("codeFournisseur", o([
                                ("type", Value::from("string")),
                            ])),
                            ("nomFournisseur", o([
                                ("type", Value::from("string")),
                            ])),
                            ("libelle1", o([
                                ("type", Value::from("string")),
                                ("description", Value::from("Libellé de l'article.")),
                            ])),
                            ("gtin", o([
                                ("type", Value::from("string")),
                            ])),
                            ("reference", o([
                                ("type", Value::from("string")),
                            ])),
                            ("codeCentrale", o([
                                ("type", Value::from("string")),
                                ("description", Value::from("Code centrale — clé de jointure avec le réseau Qlik.")),
                            ])),
                            ("codeGammeServeur", o([
                                ("type", Value::Array(vec![Value::from("string"), Value::from("null")])),
                                ("description", Value::from(format!("Gamme **non modifiée**, telle qu'elle existe en base. C'est celle à utiliser pour raisonner. `null` = aucune gamme. Valeurs : {}.", legende_gammes))),
                            ])),
                            ("codeGamme", o([
                                ("type", Value::Array(vec![Value::from("string"), Value::from("null")])),
                                ("description", Value::from("Gamme courante, modifications validées dans CollectFlow comprises.")),
                            ])),
                            ("gammeAValider", o([
                                ("type", Value::Array(vec![Value::from("string"), Value::from("null")])),
                                ("description", Value::from("Gamme proposée par l'API et pas encore validée dans la Grille. `null` = aucune proposition en attente.")),
                            ])),
                            ("totalCa", o([
                                ("type", Value::from("number")),
                                ("description", Value::from("CA sur 12 mois, nos magasins.")),
                            ])),
                            ("totalQuantite", o([
                                ("type", Value::from("number")),
                            ])),
                            ("totalMarge", o([
                                ("type", Value::from("number")),
                            ])),
                            ("tauxMarge", o([
                                ("type", Value::from("number")),
                            ])),
                            ("stockActuel", o([
                                ("type", Value::from("number")),
                            ])),
                            ("pcb", o([
                                ("type", Value::from("number")),
                                ("description", Value::from("Conditionnement (nombre d'unités par colis).")),
                            ])),
                            ("prixAchat", o([
                                ("type", Value::from("number")),
                            ])),
                            ("prixVente", o([
                                ("type", Value::from("number")),
                            ])),
                            ("derniereVente", o([
                                ("type", Value::from("string")),
                                ("format", Value::from("date")),
                            ])),
                            ("nbJoursDerniereVente", o([
                                ("type", Value::from("integer")),
                            ])),
                            ("sales12m", o([
                                ("type", Value::from("object")),
                                ("description", Value::from("Quantités vendues par mois, clés « YYYYMM ».")),
                            ])),
                            ("stock12m", o([
                                ("type", Value::from("object")),
                                ("description", Value::from("Stock de fin de mois, clés « YYYYMM ».")),
                            ])),
                            ("receptions12m", o([
                                ("type", Value::from("object")),
                                ("description", Value::from("Quantités reçues par mois, clés « YYYYMM ».")),
                            ])),
                            ("sales12mByStore", o([
                                ("type", Value::from("object")),
                                ("description", Value::from("Ventes par magasin (292, 579) puis par mois.")),
                            ])),
                            ("stock12mByStore", o([
                                ("type", Value::from("object")),
                                ("description", Value::from("Stock de fin de mois par magasin puis par mois.")),
                            ])),
                            ("receptions12mByStore", o([
                                ("type", Value::from("object")),
                                ("description", Value::from("Réceptions par magasin puis par mois.")),
                            ])),
                            ("qteReseauByMonth", o([
                                ("type", Value::Array(vec![Value::from("object"), Value::from("null")])),
                                ("description", Value::from("Quantités vendues par le réseau, clés « YYYY-MM » — série derrière la tendance.")),
                            ])),
                            ("network", o([
                                ("$ref", Value::from("#/components/schemas/NetworkMetrics")),
                            ])),
                            ("trend", o([
                                ("$ref", Value::from("#/components/schemas/Trend")),
                            ])),
                        ])),
                    ])),
                    ("ResultatGamme", o([
                        ("type", Value::from("object")),
                        ("properties", o([
                            ("codein", o([
                                ("type", Value::from("string")),
                            ])),
                            ("gamme", o([
                                ("type", Value::from("string")),
                                ("enum", Value::from(codes_gamme.clone())),
                                ("description", Value::from("Gamme proposée.")),
                            ])),
                            ("gammePrecedente", o([
                                ("type", Value::Array(vec![Value::from("string"), Value::from("null")])),
                                ("description", Value::from("Gamme enregistrée au moment de l'appel.")),
                            ])),
                            ("codeGammeServeur", o([
                                ("type", Value::Array(vec![Value::from("string"), Value::from("null")])),
                                ("description", Value::from("Gamme en base FF, non modifiée par l'API.")),
                            ])),
                            ("modifie", o([
                                ("type", Value::from("boolean")),
                                ("description", Value::from("true = proposition déposée, à valider dans la Grille. false = l'article a déjà cette gamme (une proposition en attente pour lui est retirée).")),
                            ])),
                            ("statut", o([
                                ("type", Value::from("string")),
                                ("enum", Value::Array(vec![Value::from("a_valider"), Value::from("inchangee")])),
                                ("description", Value::from("`a_valider` : en attente de validation dans la Grille.")),
                            ])),
                        ])),
                    ])),
                    ("Trend", o([
                        ("type", Value::Array(vec![Value::from("object"), Value::from("null")])),
                        ("description", Value::from(concat!("Tendance réseau sur 12 mois, par régression linéaire — la même que la colonne ", "« Tendance » de l'application. `null` si aucune série mensuelle n'est disponible."))),
                        ("properties", o([
                            ("direction", o([
                                ("type", Value::from("string")),
                                ("enum", Value::Array(vec![Value::from("up"), Value::from("down"), Value::from("flat")])),
                                ("description", Value::from("Seuil à ±8 % de variation modélisée.")),
                            ])),
                            ("pct", o([
                                ("type", Value::Array(vec![Value::from("number"), Value::from("null")])),
                                ("description", Value::from("Variation modélisée sur la période (0.23 = +23 %).")),
                            ])),
                            ("label", o([
                                ("type", Value::from("string")),
                                ("description", Value::from("Libellé prêt à afficher : « Forte hausse », « Stable »…")),
                            ])),
                            ("monthsUsed", o([
                                ("type", Value::from("integer")),
                                ("description", Value::from("Nombre de mois réellement utilisés (12 au maximum).")),
                            ])),
                        ])),
                    ])),
                ])),
            ])),
            ("paths", o([
                ("/fournisseurs", o([
                    ("get", o([
                        ("operationId", Value::from("listerFournisseurs")),
                        ("summary", Value::from("Lister les fournisseurs")),
                        ("description", Value::from(concat!("Renvoie les fournisseurs et indique, via `hasSnapshot`, lesquels ont des données ", "immédiatement disponibles. À appeler en premier quand le code fournisseur est inconnu."))),
                        ("parameters", Value::Array(vec![
                            o([
                                ("name", Value::from("search")),
                                ("in", Value::from("query")),
                                ("schema", o([
                                    ("type", Value::from("string")),
                                ])),
                                ("description", Value::from("Filtre sur le nom ou le code.")),
                            ]),
                            o([
                                ("name", Value::from("withData")),
                                ("in", Value::from("query")),
                                ("schema", o([
                                    ("type", Value::from("string")),
                                    ("enum", Value::Array(vec![Value::from("0"), Value::from("1")])),
                                ])),
                                ("description", Value::from("1 = uniquement ceux dont les données sont disponibles.")),
                            ]),
                        ])),
                        ("responses", o([
                            ("200", o([
                                ("description", Value::from("Liste des fournisseurs")),
                                ("content", o([
                                    ("application/json", o([
                                        ("schema", o([
                                            ("type", Value::from("object")),
                                            ("properties", o([
                                                ("data", o([
                                                    ("type", Value::from("array")),
                                                    ("items", o([
                                                        ("$ref", Value::from("#/components/schemas/Fournisseur")),
                                                    ])),
                                                ])),
                                                ("meta", o([
                                                    ("type", Value::from("object")),
                                                ])),
                                            ])),
                                        ])),
                                    ])),
                                ])),
                            ])),
                            ("401", o([
                                ("description", Value::from("Clé d'API absente, invalide ou révoquée")),
                                ("content", o([
                                    ("application/json", o([
                                        ("schema", o([
                                            ("$ref", Value::from("#/components/schemas/Error")),
                                        ])),
                                    ])),
                                ])),
                            ])),
                        ])),
                    ])),
                ])),
                ("/nomenclatures", o([
                    ("get", o([
                        ("operationId", Value::from("listerNomenclaturesFournisseur")),
                        ("summary", Value::from("Postes de nomenclature d'un fournisseur")),
                        ("description", Value::from(concat!("Répartition des articles d'un fournisseur par poste de nomenclature, avec le nombre ", "d'articles et le CA de chacun. **À utiliser avant /grid sur un gros fournisseur** : ", "certains dépassent 130 000 articles. On liste les postes (quelques dizaines de lignes), ", "puis on interroge /grid poste par poste avec le filtre indiqué par `meta.filtreGrid` ", "(code1, code2 ou code3)."))),
                        ("parameters", Value::Array(vec![
                            o([
                                ("name", Value::from("fournisseur")),
                                ("in", Value::from("query")),
                                ("required", Value::from(true)),
                                ("schema", o([
                                    ("type", Value::from("string")),
                                ])),
                            ]),
                            o([
                                ("name", Value::from("niveau")),
                                ("in", Value::from("query")),
                                ("schema", o([
                                    ("type", Value::from("integer")),
                                    ("enum", Value::Array(vec![Value::from(1), Value::from(2), Value::from(3)])),
                                    ("default", Value::from(1)),
                                ])),
                                ("description", Value::from("1 = univers, 2 = famille, 3 = sous-famille.")),
                            ]),
                            o([
                                ("name", Value::from("parent")),
                                ("in", Value::from("query")),
                                ("schema", o([
                                    ("type", Value::from("string")),
                                ])),
                                ("description", Value::from("Préfixe du poste parent, ex. « 32 » pour lister ses familles.")),
                            ]),
                        ])),
                        ("responses", o([
                            ("200", o([
                                ("description", Value::from("Postes de nomenclature")),
                                ("content", o([
                                    ("application/json", o([
                                        ("schema", o([
                                            ("type", Value::from("object")),
                                            ("properties", o([
                                                ("data", o([
                                                    ("type", Value::from("array")),
                                                    ("items", o([
                                                        ("type", Value::from("object")),
                                                        ("properties", o([
                                                            ("code", o([
                                                                ("type", Value::from("string")),
                                                                ("description", Value::from("À passer au filtre code1/code2/code3 de /grid.")),
                                                            ])),
                                                            ("libelle", o([
                                                                ("type", Value::Array(vec![Value::from("string"), Value::from("null")])),
                                                            ])),
                                                            ("nbArticles", o([
                                                                ("type", Value::from("integer")),
                                                            ])),
                                                            ("totalCa", o([
                                                                ("type", Value::from("number")),
                                                            ])),
                                                            ("totalQuantite", o([
                                                                ("type", Value::from("number")),
                                                            ])),
                                                        ])),
                                                    ])),
                                                ])),
                                                ("meta", o([
                                                    ("type", Value::from("object")),
                                                ])),
                                            ])),
                                        ])),
                                    ])),
                                ])),
                            ])),
                            ("202", o([
                                ("description", Value::from("Fournisseur pas encore calculé")),
                                ("content", o([
                                    ("application/json", o([
                                        ("schema", o([
                                            ("$ref", Value::from("#/components/schemas/Error")),
                                        ])),
                                    ])),
                                ])),
                            ])),
                            ("400", o([
                                ("description", Value::from("Paramètres invalides")),
                                ("content", o([
                                    ("application/json", o([
                                        ("schema", o([
                                            ("$ref", Value::from("#/components/schemas/Error")),
                                        ])),
                                    ])),
                                ])),
                            ])),
                        ])),
                    ])),
                ])),
                ("/grid", o([
                    ("get", o([
                        ("operationId", Value::from("listerProduitsFournisseur")),
                        ("summary", Value::from("Lister les produits d'un fournisseur")),
                        ("description", Value::from(concat!("Lignes de grille d'un fournisseur : ventes 12 mois, stock, marges, gammes et métriques ", "réseau. Fonctionne pour **n'importe quel** fournisseur : si ses données n'ont jamais été ", "calculées, l'API les calcule à la demande (premier appel de quelques secondes, ", "`meta.computedOnDemand = true`). Un `404` signifie que le code fournisseur n'existe pas ", "ou n'a aucun article — le signaler plutôt que de conclure à une panne."))),
                        ("parameters", Value::Array([vec![
                            o([
                                ("name", Value::from("fournisseur")),
                                ("in", Value::from("query")),
                                ("required", Value::from(true)),
                                ("schema", o([
                                    ("type", Value::from("string")),
                                ])),
                                ("description", Value::from("Code fournisseur (voir listerFournisseurs).")),
                            ]),
                            o([
                                ("name", Value::from("gamme")),
                                ("in", Value::from("query")),
                                ("schema", o([
                                    ("type", Value::from("string")),
                                ])),
                                ("description", Value::from(format!("Filtre sur la gamme ({}).", codes_gamme.join(", ")))),
                            ]),
                            o([
                                ("name", Value::from("code1")),
                                ("in", Value::from("query")),
                                ("schema", o([
                                    ("type", Value::from("string")),
                                ])),
                                ("description", Value::from("Filtre nomenclature niveau 1.")),
                            ]),
                            o([
                                ("name", Value::from("code2")),
                                ("in", Value::from("query")),
                                ("schema", o([
                                    ("type", Value::from("string")),
                                ])),
                                ("description", Value::from("Filtre nomenclature niveau 2.")),
                            ]),
                            o([
                                ("name", Value::from("code3")),
                                ("in", Value::from("query")),
                                ("schema", o([
                                    ("type", Value::from("string")),
                                ])),
                                ("description", Value::from("Filtre nomenclature niveau 3 (code exact).")),
                            ]),
                            o([
                                ("name", Value::from("nomenclature")),
                                ("in", Value::from("query")),
                                ("schema", o([
                                    ("type", Value::from("string")),
                                ])),
                                ("description", Value::from("Préfixe de nomenclature renvoyé par listerNomenclaturesFournisseur : 32, 3202 ou 320211. À préférer à code1/code2, qui peuvent être vides.")),
                            ]),
                            o([
                                ("name", Value::from("search")),
                                ("in", Value::from("query")),
                                ("schema", o([
                                    ("type", Value::from("string")),
                                ])),
                                ("description", Value::from("Filtre texte : libellé, codein, GTIN, référence ou code centrale.")),
                            ]),
                            o([
                                ("name", Value::from("compute")),
                                ("in", Value::from("query")),
                                ("schema", o([
                                    ("type", Value::from("string")),
                                    ("enum", Value::Array(vec![Value::from("0"), Value::from("1")])),
                                    ("default", Value::from("1")),
                                ])),
                                ("description", Value::from(concat!("1 (défaut) : calcule les données du fournisseur si elles n'existent pas encore. ", "0 : refuse le calcul et répond immédiatement 202 not_ready."))),
                            ]),
                        ], sort_params.clone(), pagination_params.clone()].concat())),
                        ("responses", o([
                            ("200", o([
                                ("description", Value::from("Produits du fournisseur")),
                                ("content", o([
                                    ("application/json", o([
                                        ("schema", o([
                                            ("type", Value::from("object")),
                                            ("properties", o([
                                                ("data", o([
                                                    ("type", Value::from("array")),
                                                    ("items", o([
                                                        ("$ref", Value::from("#/components/schemas/Product")),
                                                    ])),
                                                ])),
                                                ("pagination", o([
                                                    ("$ref", Value::from("#/components/schemas/Pagination")),
                                                ])),
                                                ("meta", o([
                                                    ("type", Value::from("object")),
                                                ])),
                                            ])),
                                        ])),
                                    ])),
                                ])),
                            ])),
                            ("202", o([
                                ("description", Value::from("Données pas encore calculées (uniquement avec compute=0)")),
                                ("content", o([
                                    ("application/json", o([
                                        ("schema", o([
                                            ("$ref", Value::from("#/components/schemas/Error")),
                                        ])),
                                    ])),
                                ])),
                            ])),
                            ("400", o([
                                ("description", Value::from("Paramètres invalides")),
                                ("content", o([
                                    ("application/json", o([
                                        ("schema", o([
                                            ("$ref", Value::from("#/components/schemas/Error")),
                                        ])),
                                    ])),
                                ])),
                            ])),
                            ("401", o([
                                ("description", Value::from("Clé d'API absente, invalide ou révoquée")),
                                ("content", o([
                                    ("application/json", o([
                                        ("schema", o([
                                            ("$ref", Value::from("#/components/schemas/Error")),
                                        ])),
                                    ])),
                                ])),
                            ])),
                            ("404", o([
                                ("description", Value::from("Fournisseur inconnu ou sans article")),
                                ("content", o([
                                    ("application/json", o([
                                        ("schema", o([
                                            ("$ref", Value::from("#/components/schemas/Error")),
                                        ])),
                                    ])),
                                ])),
                            ])),
                        ])),
                    ])),
                ])),
                ("/products/search", o([
                    ("get", o([
                        ("operationId", Value::from("rechercherProduits")),
                        ("summary", Value::from("Rechercher des produits, tous fournisseurs confondus")),
                        ("description", Value::from(concat!("Recherche sur le libellé, le codein, le GTIN, la référence et le code centrale, sans ", "avoir à connaître le fournisseur. À utiliser dès qu'un produit est désigné par son nom."))),
                        ("parameters", Value::Array([vec![
                            o([
                                ("name", Value::from("q")),
                                ("in", Value::from("query")),
                                ("required", Value::from(true)),
                                ("schema", o([
                                    ("type", Value::from("string")),
                                    ("maxLength", Value::from(120)),
                                ])),
                                ("description", Value::from("Termes recherchés.")),
                            ]),
                            o([
                                ("name", Value::from("fournisseur")),
                                ("in", Value::from("query")),
                                ("schema", o([
                                    ("type", Value::from("string")),
                                ])),
                                ("description", Value::from("Restreint à un fournisseur.")),
                            ]),
                            o([
                                ("name", Value::from("gamme")),
                                ("in", Value::from("query")),
                                ("schema", o([
                                    ("type", Value::from("string")),
                                ])),
                                ("description", Value::from("Filtre sur la gamme.")),
                            ]),
                        ], sort_params.clone(), pagination_params.clone()].concat())),
                        ("responses", o([
                            ("200", o([
                                ("description", Value::from("Produits correspondants")),
                                ("content", o([
                                    ("application/json", o([
                                        ("schema", o([
                                            ("type", Value::from("object")),
                                            ("properties", o([
                                                ("data", o([
                                                    ("type", Value::from("array")),
                                                    ("items", o([
                                                        ("$ref", Value::from("#/components/schemas/Product")),
                                                    ])),
                                                ])),
                                                ("pagination", o([
                                                    ("$ref", Value::from("#/components/schemas/Pagination")),
                                                ])),
                                                ("meta", o([
                                                    ("type", Value::from("object")),
                                                ])),
                                            ])),
                                        ])),
                                    ])),
                                ])),
                            ])),
                            ("401", o([
                                ("description", Value::from("Clé d'API absente, invalide ou révoquée")),
                                ("content", o([
                                    ("application/json", o([
                                        ("schema", o([
                                            ("$ref", Value::from("#/components/schemas/Error")),
                                        ])),
                                    ])),
                                ])),
                            ])),
                        ])),
                    ])),
                ])),
                ("/products/{codein}", o([
                    ("get", o([
                        ("operationId", Value::from("obtenirProduit")),
                        ("summary", Value::from("Fiche complète d'un produit")),
                        ("description", Value::from("Toutes les données d'un article : séries mensuelles, ventilation par magasin, stock, marges, gammes et métriques réseau.")),
                        ("parameters", Value::Array(vec![
                            o([
                                ("name", Value::from("codein")),
                                ("in", Value::from("path")),
                                ("required", Value::from(true)),
                                ("schema", o([
                                    ("type", Value::from("string")),
                                ])),
                                ("description", Value::from("Identifiant interne de l'article.")),
                            ]),
                            o([
                                ("name", Value::from("fournisseur")),
                                ("in", Value::from("query")),
                                ("schema", o([
                                    ("type", Value::from("string")),
                                ])),
                                ("description", Value::from("Lève l'ambiguïté d'un article référencé chez plusieurs fournisseurs.")),
                            ]),
                        ])),
                        ("responses", o([
                            ("200", o([
                                ("description", Value::from("Fiche produit")),
                                ("content", o([
                                    ("application/json", o([
                                        ("schema", o([
                                            ("type", Value::from("object")),
                                            ("properties", o([
                                                ("data", o([
                                                    ("$ref", Value::from("#/components/schemas/Product")),
                                                ])),
                                                ("meta", o([
                                                    ("type", Value::from("object")),
                                                ])),
                                            ])),
                                        ])),
                                    ])),
                                ])),
                            ])),
                            ("404", o([
                                ("description", Value::from("Produit absent de l'instantané")),
                                ("content", o([
                                    ("application/json", o([
                                        ("schema", o([
                                            ("$ref", Value::from("#/components/schemas/Error")),
                                        ])),
                                    ])),
                                ])),
                            ])),
                            ("401", o([
                                ("description", Value::from("Clé d'API absente, invalide ou révoquée")),
                                ("content", o([
                                    ("application/json", o([
                                        ("schema", o([
                                            ("$ref", Value::from("#/components/schemas/Error")),
                                        ])),
                                    ])),
                                ])),
                            ])),
                        ])),
                    ])),
                ])),
                ("/products/{codein}/gamme", o([
                    ("put", o([
                        ("operationId", Value::from("changerGammeProduit")),
                        ("summary", Value::from("Proposer la gamme d'un produit (à valider)")),
                        ("description", Value::from(format!("Propose une gamme pour un article. Elle reste à valider dans la Grille, où elle apparaît comme une modification non enregistrée. Valeurs : {}. `fournisseur` n'est requis que si l'article est référencé chez plusieurs fournisseurs (réponse 400 listant les fournisseurs) ou s'il n'a encore jamais été calculé. Pour plusieurs articles d'un même fournisseur, préférer changerGammes.", legende_gammes))),
                        ("parameters", Value::Array(vec![
                            o([
                                ("name", Value::from("codein")),
                                ("in", Value::from("path")),
                                ("required", Value::from(true)),
                                ("schema", o([
                                    ("type", Value::from("string")),
                                ])),
                                ("description", Value::from("Identifiant interne de l'article.")),
                            ]),
                        ])),
                        ("requestBody", o([
                            ("required", Value::from(true)),
                            ("content", o([
                                ("application/json", o([
                                    ("schema", o([
                                        ("type", Value::from("object")),
                                        ("required", Value::Array(vec![Value::from("gamme")])),
                                        ("properties", o([
                                            ("gamme", o([
                                                ("type", Value::from("string")),
                                                ("enum", Value::from(codes_gamme.clone())),
                                            ])),
                                            ("fournisseur", o([
                                                ("type", Value::from("string")),
                                                ("description", Value::from("Code fournisseur de l'article.")),
                                            ])),
                                            ("compute", o([
                                                ("type", Value::from("boolean")),
                                                ("default", Value::from(true)),
                                                ("description", Value::from("Calcule le fournisseur à la demande s'il n'a jamais été calculé.")),
                                            ])),
                                        ])),
                                    ])),
                                ])),
                            ])),
                        ])),
                        ("responses", o([
                            ("200", o([
                                ("description", Value::from("Gamme proposée, à valider")),
                                ("content", o([
                                    ("application/json", o([
                                        ("schema", o([
                                            ("type", Value::from("object")),
                                            ("properties", o([
                                                ("data", o([
                                                    ("allOf", Value::Array(vec![
                                                        o([
                                                            ("$ref", Value::from("#/components/schemas/ResultatGamme")),
                                                        ]),
                                                        o([
                                                            ("type", Value::from("object")),
                                                            ("properties", o([
                                                                ("codeFournisseur", o([
                                                                    ("type", Value::from("string")),
                                                                ])),
                                                                ("nomFournisseur", o([
                                                                    ("type", Value::Array(vec![Value::from("string"), Value::from("null")])),
                                                                ])),
                                                            ])),
                                                        ]),
                                                    ])),
                                                ])),
                                                ("meta", o([
                                                    ("type", Value::from("object")),
                                                ])),
                                            ])),
                                        ])),
                                    ])),
                                ])),
                            ])),
                            ("400", erreur(Value::from("Gamme invalide, ou article chez plusieurs fournisseurs sans « fournisseur »"))),
                            ("401", erreur(Value::from("Clé d'API absente, invalide ou révoquée"))),
                            ("404", erreur(Value::from("Article introuvable chez ce fournisseur"))),
                        ])),
                    ])),
                ])),
                ("/gammes", o([
                    ("post", o([
                        ("operationId", Value::from("changerGammes")),
                        ("summary", Value::from("Proposer la gamme de plusieurs produits (à valider)")),
                        ("description", Value::from(format!("Propose en un appel les gammes de plusieurs articles d'un même fournisseur, à valider dans la Grille. Tout ou rien : si un article est inconnu chez le fournisseur, rien n'est proposé et la réponse 404 liste les articles en cause dans `error.details.inconnus`. Valeurs : {}.", legende_gammes))),
                        ("requestBody", o([
                            ("required", Value::from(true)),
                            ("content", o([
                                ("application/json", o([
                                    ("schema", o([
                                        ("type", Value::from("object")),
                                        ("required", Value::Array(vec![Value::from("fournisseur"), Value::from("changes")])),
                                        ("properties", o([
                                            ("fournisseur", o([
                                                ("type", Value::from("string")),
                                                ("description", Value::from("Code fournisseur.")),
                                            ])),
                                            ("changes", o([
                                                ("type", Value::from("array")),
                                                ("minItems", Value::from(1)),
                                                ("maxItems", Value::from(10000)),
                                                ("items", o([
                                                    ("type", Value::from("object")),
                                                    ("required", Value::Array(vec![Value::from("codein"), Value::from("gamme")])),
                                                    ("properties", o([
                                                        ("codein", o([
                                                            ("type", Value::from("string")),
                                                        ])),
                                                        ("gamme", o([
                                                            ("type", Value::from("string")),
                                                            ("enum", Value::from(codes_gamme.clone())),
                                                        ])),
                                                    ])),
                                                ])),
                                            ])),
                                            ("compute", o([
                                                ("type", Value::from("boolean")),
                                                ("default", Value::from(true)),
                                                ("description", Value::from("Calcule le fournisseur à la demande s'il n'a jamais été calculé.")),
                                            ])),
                                        ])),
                                    ])),
                                ])),
                            ])),
                        ])),
                        ("responses", o([
                            ("200", o([
                                ("description", Value::from("Gammes proposées, à valider")),
                                ("content", o([
                                    ("application/json", o([
                                        ("schema", o([
                                            ("type", Value::from("object")),
                                            ("properties", o([
                                                ("data", o([
                                                    ("type", Value::from("array")),
                                                    ("items", o([
                                                        ("$ref", Value::from("#/components/schemas/ResultatGamme")),
                                                    ])),
                                                ])),
                                                ("meta", o([
                                                    ("type", Value::from("object")),
                                                ])),
                                            ])),
                                        ])),
                                    ])),
                                ])),
                            ])),
                            ("400", erreur(Value::from("Corps de requête invalide"))),
                            ("401", erreur(Value::from("Clé d'API absente, invalide ou révoquée"))),
                            ("404", erreur(Value::from("Un ou plusieurs articles introuvables chez ce fournisseur"))),
                        ])),
                    ])),
                ])),
                ("/network/{codeCentrale}", o([
                    ("get", o([
                        ("operationId", Value::from("obtenirMetriquesReseau")),
                        ("summary", Value::from("Métriques du réseau Qlik pour un produit")),
                        ("description", Value::from("Performances du produit sur l'ensemble du réseau Foir'Fouille (~270 magasins) et courbe des quantités sur 12 mois glissants.")),
                        ("parameters", Value::Array(vec![
                            o([
                                ("name", Value::from("codeCentrale")),
                                ("in", Value::from("path")),
                                ("required", Value::from(true)),
                                ("schema", o([
                                    ("type", Value::from("string")),
                                ])),
                                ("description", Value::from("Code centrale du produit (format 10000XXXXXX).")),
                            ]),
                        ])),
                        ("responses", o([
                            ("200", o([
                                ("description", Value::from("Métriques réseau")),
                                ("content", o([
                                    ("application/json", o([
                                        ("schema", o([
                                            ("type", Value::from("object")),
                                            ("properties", o([
                                                ("data", o([
                                                    ("$ref", Value::from("#/components/schemas/NetworkMetrics")),
                                                ])),
                                                ("meta", o([
                                                    ("type", Value::from("object")),
                                                ])),
                                            ])),
                                        ])),
                                    ])),
                                ])),
                            ])),
                            ("404", o([
                                ("description", Value::from("Aucune donnée réseau pour ce code centrale")),
                                ("content", o([
                                    ("application/json", o([
                                        ("schema", o([
                                            ("$ref", Value::from("#/components/schemas/Error")),
                                        ])),
                                    ])),
                                ])),
                            ])),
                            ("401", o([
                                ("description", Value::from("Clé d'API absente, invalide ou révoquée")),
                                ("content", o([
                                    ("application/json", o([
                                        ("schema", o([
                                            ("$ref", Value::from("#/components/schemas/Error")),
                                        ])),
                                    ])),
                                ])),
                            ])),
                        ])),
                    ])),
                ])),
            ])),
        ]);

    spec
}

/// `GET /api/v1/openapi.json`.
pub async fn get_openapi(headers: HeaderMap) -> Response {
    let spec = build_spec(&origine(&headers));
    // CORS ouvert en lecture : le schéma est public et peut être chargé par un outil tiers.
    ([(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")], Json(spec)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_complet() {
        let spec = build_spec("http://exemple.test:5643");
        assert_eq!(spec["servers"][0]["url"], "http://exemple.test:5643/api/v1");
        assert_eq!(spec["paths"]["/grid"]["get"]["parameters"].as_array().unwrap().len(), 14);
        assert_eq!(
            spec["components"]["schemas"]["ResultatGamme"]["properties"]["gamme"]["enum"],
            serde_json::json!(["A", "B", "C", "Y", "Z"])
        );
        // Comparaison octet par octet avec le document produit par la version Node
        // (`OPENAPI_REFERENCE` : chemin du JSON de référence, origine ci-dessus).
        if let Ok(chemin) = std::env::var("OPENAPI_REFERENCE") {
            let reference = std::fs::read_to_string(&chemin).unwrap();
            let produit = serde_json::to_string(&spec).unwrap();
            if produit != reference.trim() {
                std::fs::write(format!("{chemin}.rust"), &produit).unwrap();
            }
            assert_eq!(produit, reference.trim());
        }
    }

    #[test]
    fn origine_depuis_les_en_tetes() {
        let mut h = HeaderMap::new();
        h.insert("host", "collectflow.local:5643".parse().unwrap());
        assert_eq!(origine(&h), "http://collectflow.local:5643");
        h.insert("x-forwarded-proto", "https".parse().unwrap());
        h.insert("x-forwarded-host", "cf.exemple.fr".parse().unwrap());
        assert_eq!(origine(&h), "https://cf.exemple.fr");
    }
}
