import { NextRequest } from "next/server";
import { GRID_SORT_KEYS } from "@/lib/grid-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/openapi.json — spécification OpenAPI 3.1 de l'API CollectFlow.
 *
 * **Volontairement accessible sans authentification.** Le document ne décrit que la
 * structure de l'API (chemins, paramètres, schémas) et ne contient aucune donnée
 * métier ; or ChatGPT et les autres plateformes d'agents importent le schéma par URL,
 * avant même que la clé ne soit configurée. Exiger une clé ici rendrait l'import
 * impossible.
 *
 * `servers` est construit depuis l'hôte appelant (ou COLLECTFLOW_PUBLIC_URL) : les
 * Actions ChatGPT exigent une URL **absolue**, une URL relative étant rejetée.
 */
export async function GET(req: NextRequest) {
    const configured = process.env.COLLECTFLOW_PUBLIC_URL?.trim().replace(/\/+$/, "");
    const origin = configured || req.nextUrl.origin;

    const paginationParams = [
        { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 }, description: "Numéro de page." },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 }, description: "Nombre de lignes par page (500 maximum)." },
    ];
    const sortParams = [
        { name: "sort", in: "query", schema: { type: "string", enum: GRID_SORT_KEYS }, description: "Colonne de tri." },
        { name: "order", in: "query", schema: { type: "string", enum: ["asc", "desc"], default: "desc" }, description: "Sens du tri." },
        {
            name: "fields",
            in: "query",
            schema: { type: "string" },
            description:
                "Colonnes à retourner, séparées par des virgules (ex. « codein,libelle1,totalCa »). "
                + "À utiliser systématiquement : une ligne complète contient les séries mensuelles et les "
                + "ventilations par magasin, ce qui est très volumineux. `codein` est toujours inclus.",
        },
        {
            name: "enrich",
            in: "query",
            schema: { type: "string", enum: ["0", "1"], default: "1" },
            description:
                "1 (défaut) : relit les métriques réseau Qlik (`network`) et la gamme serveur "
                + "(`codeGammeServeur`) au moment de l'appel. 0 : sert l'instantané brut.",
        },
    ];

    const spec = {
        openapi: "3.1.0",
        info: {
            title: "CollectFlow API",
            version: "1.0.0",
            description:
                "Lecture des données de la grille CollectFlow : ventes sur 12 mois par magasin, stock, marges, "
                + "gammes et métriques du réseau Qlik (~270 magasins Foir'Fouille), plus la recherche de produits.\n\n"
                + "**N'importe quel fournisseur peut être interrogé directement.** Les réponses sont servies "
                + "depuis un instantané persisté ; si le fournisseur demandé n'en a pas encore, `/grid` le calcule "
                + "à la demande. Ce premier appel prend alors plusieurs secondes, les suivants sont immédiats. "
                + "Passez `compute=0` pour refuser ce calcul et obtenir un `202 not_ready` immédiat.\n\n"
                + "**Aucun endpoint ne contacte Qlik en direct** : les métriques réseau viennent d'un cache "
                + "alimenté par une synchronisation séparée.\n\n"
                + "Deux informations sont relues à chaque appel car elles évoluent indépendamment : les métriques "
                + "réseau Qlik (`network`, `null` s'il n'y en a pas) et la gamme serveur non modifiée "
                + "(`codeGammeServeur`).",
        },
        servers: [{ url: `${origin}/api/v1`, description: "API CollectFlow" }],
        security: [{ ApiKeyAuth: [] }],
        components: {
            securitySchemes: {
                ApiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" },
            },
            schemas: {
                Error: {
                    type: "object",
                    properties: {
                        error: {
                            type: "object",
                            properties: {
                                code: {
                                    type: "string",
                                    enum: ["unauthorized", "forbidden", "bad_request", "not_found", "not_ready", "internal_error"],
                                },
                                message: { type: "string" },
                            },
                        },
                    },
                },
                Pagination: {
                    type: "object",
                    properties: {
                        page: { type: "integer" },
                        limit: { type: "integer" },
                        total: { type: "integer" },
                        totalPages: { type: "integer" },
                    },
                },
                Fournisseur: {
                    type: "object",
                    properties: {
                        code: { type: "string", description: "Code fournisseur, à passer au paramètre `fournisseur`." },
                        nom: { type: ["string", "null"] },
                        hasSnapshot: { type: "boolean", description: "false = données pas encore disponibles pour ce fournisseur." },
                        rowCount: { type: "integer" },
                        computedAt: { type: ["string", "null"], format: "date-time" },
                    },
                },
                NetworkMetrics: {
                    type: ["object", "null"],
                    description: "Métriques du réseau Qlik. `null` quand le produit n'a pas de données réseau.",
                    properties: {
                        caReseau: { type: "number" },
                        qteReseau: { type: "number" },
                        nbMagasinsReseau: { type: "integer", description: "Nombre de magasins du réseau vendant le produit (sur ~270)." },
                        caParMagasinReseau: { type: "number", description: "CA moyen par magasin : normalise la présence, préférable au CA brut pour comparer." },
                        margePctReseau: { type: "number", description: "Taux de marge, ratio brut (0.32 = 32 %)." },
                        qteByMonth: { type: ["object", "null"], description: "Quantités vendues par mois, clés « YYYY-MM »." },
                        fetchedAt: { type: ["string", "null"], format: "date-time" },
                    },
                },
                Product: {
                    type: "object",
                    description:
                        "Ligne de grille : un article chez un fournisseur. La liste de propriétés ci-dessous "
                        + "n'est pas exhaustive — la réponse contient l'intégralité de la ligne (une soixantaine "
                        + "de champs). Utilisez `fields` pour n'en garder qu'une partie.",
                    properties: {
                        codein: { type: "string", description: "Identifiant interne de l'article." },
                        codeFournisseur: { type: "string" },
                        nomFournisseur: { type: "string" },
                        libelle1: { type: "string", description: "Libellé de l'article." },
                        gtin: { type: "string" },
                        reference: { type: "string" },
                        codeCentrale: { type: "string", description: "Code centrale — clé de jointure avec le réseau Qlik." },
                        codeGammeServeur: {
                            type: ["string", "null"],
                            description:
                                "Gamme **non modifiée**, telle qu'elle existe en base. C'est celle à utiliser pour "
                                + "raisonner. `null` = aucune gamme. Valeurs : A (pilier), B (bonne rotation), "
                                + "C (performance), D (saisonnier/niche), Z (sortie).",
                        },
                        codeGamme: { type: ["string", "null"], description: "Gamme courante, éventuellement surchargée par une modification locale non enregistrée." },
                        totalCa: { type: "number", description: "CA sur 12 mois, nos magasins." },
                        totalQuantite: { type: "number" },
                        totalMarge: { type: "number" },
                        tauxMarge: { type: "number" },
                        stockActuel: { type: "number" },
                        pcb: { type: "number", description: "Conditionnement (nombre d'unités par colis)." },
                        prixAchat: { type: "number" },
                        prixVente: { type: "number" },
                        derniereVente: { type: "string", format: "date" },
                        nbJoursDerniereVente: { type: "integer" },
                        sales12m: { type: "object", description: "Quantités vendues par mois, clés « YYYYMM »." },
                        stock12m: { type: "object", description: "Stock de fin de mois, clés « YYYYMM »." },
                        receptions12m: { type: "object", description: "Quantités reçues par mois, clés « YYYYMM »." },
                        sales12mByStore: { type: "object", description: "Ventes par magasin (292, 579) puis par mois." },
                        stock12mByStore: { type: "object", description: "Stock de fin de mois par magasin puis par mois." },
                        receptions12mByStore: { type: "object", description: "Réceptions par magasin puis par mois." },
                        qteReseauByMonth: { type: ["object", "null"], description: "Quantités vendues par le réseau, clés « YYYY-MM » — série derrière la tendance." },
                        network: { $ref: "#/components/schemas/NetworkMetrics" },
                        trend: { $ref: "#/components/schemas/Trend" },
                    },
                },
                Trend: {
                    type: ["object", "null"],
                    description:
                        "Tendance réseau sur 12 mois, par régression linéaire — la même que la colonne "
                        + "« Tendance » de l'application. `null` si aucune série mensuelle n'est disponible.",
                    properties: {
                        direction: { type: "string", enum: ["up", "down", "flat"], description: "Seuil à ±8 % de variation modélisée." },
                        pct: { type: ["number", "null"], description: "Variation modélisée sur la période (0.23 = +23 %)." },
                        label: { type: "string", description: "Libellé prêt à afficher : « Forte hausse », « Stable »…" },
                        monthsUsed: { type: "integer", description: "Nombre de mois réellement utilisés (12 au maximum)." },
                    },
                },
            },
        },
        paths: {
            "/fournisseurs": {
                get: {
                    operationId: "listerFournisseurs",
                    summary: "Lister les fournisseurs",
                    description:
                        "Renvoie les fournisseurs et indique, via `hasSnapshot`, lesquels ont des données "
                        + "immédiatement disponibles. À appeler en premier quand le code fournisseur est inconnu.",
                    parameters: [
                        { name: "search", in: "query", schema: { type: "string" }, description: "Filtre sur le nom ou le code." },
                        { name: "withData", in: "query", schema: { type: "string", enum: ["0", "1"] }, description: "1 = uniquement ceux dont les données sont disponibles." },
                    ],
                    responses: {
                        "200": {
                            description: "Liste des fournisseurs",
                            content: {
                                "application/json": {
                                    schema: {
                                        type: "object",
                                        properties: {
                                            data: { type: "array", items: { $ref: "#/components/schemas/Fournisseur" } },
                                            meta: { type: "object" },
                                        },
                                    },
                                },
                            },
                        },
                        "401": { description: "Clé d'API absente, invalide ou révoquée", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    },
                },
            },
            "/grid": {
                get: {
                    operationId: "listerProduitsFournisseur",
                    summary: "Lister les produits d'un fournisseur",
                    description:
                        "Lignes de grille d'un fournisseur : ventes 12 mois, stock, marges, gammes et métriques "
                        + "réseau. Fonctionne pour **n'importe quel** fournisseur : si ses données n'ont jamais été "
                        + "calculées, l'API les calcule à la demande (premier appel de quelques secondes, "
                        + "`meta.computedOnDemand = true`). Un `404` signifie que le code fournisseur n'existe pas "
                        + "ou n'a aucun article — le signaler plutôt que de conclure à une panne.",
                    parameters: [
                        { name: "fournisseur", in: "query", required: true, schema: { type: "string" }, description: "Code fournisseur (voir listerFournisseurs)." },
                        { name: "gamme", in: "query", schema: { type: "string" }, description: "Filtre sur la gamme (A, B, C, D, Z)." },
                        { name: "code1", in: "query", schema: { type: "string" }, description: "Filtre nomenclature niveau 1." },
                        { name: "code2", in: "query", schema: { type: "string" }, description: "Filtre nomenclature niveau 2." },
                        { name: "code3", in: "query", schema: { type: "string" }, description: "Filtre nomenclature niveau 3." },
                        { name: "search", in: "query", schema: { type: "string" }, description: "Filtre texte : libellé, codein, GTIN, référence ou code centrale." },
                        {
                            name: "compute",
                            in: "query",
                            schema: { type: "string", enum: ["0", "1"], default: "1" },
                            description:
                                "1 (défaut) : calcule les données du fournisseur si elles n'existent pas encore. "
                                + "0 : refuse le calcul et répond immédiatement 202 not_ready.",
                        },
                        ...sortParams,
                        ...paginationParams,
                    ],
                    responses: {
                        "200": {
                            description: "Produits du fournisseur",
                            content: {
                                "application/json": {
                                    schema: {
                                        type: "object",
                                        properties: {
                                            data: { type: "array", items: { $ref: "#/components/schemas/Product" } },
                                            pagination: { $ref: "#/components/schemas/Pagination" },
                                            meta: { type: "object" },
                                        },
                                    },
                                },
                            },
                        },
                        "202": { description: "Données pas encore calculées (uniquement avec compute=0)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                        "400": { description: "Paramètres invalides", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                        "401": { description: "Clé d'API absente, invalide ou révoquée", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                        "404": { description: "Fournisseur inconnu ou sans article", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    },
                },
            },
            "/products/search": {
                get: {
                    operationId: "rechercherProduits",
                    summary: "Rechercher des produits, tous fournisseurs confondus",
                    description:
                        "Recherche sur le libellé, le codein, le GTIN, la référence et le code centrale, sans "
                        + "avoir à connaître le fournisseur. À utiliser dès qu'un produit est désigné par son nom.",
                    parameters: [
                        { name: "q", in: "query", required: true, schema: { type: "string", maxLength: 120 }, description: "Termes recherchés." },
                        { name: "fournisseur", in: "query", schema: { type: "string" }, description: "Restreint à un fournisseur." },
                        { name: "gamme", in: "query", schema: { type: "string" }, description: "Filtre sur la gamme." },
                        ...sortParams,
                        ...paginationParams,
                    ],
                    responses: {
                        "200": {
                            description: "Produits correspondants",
                            content: {
                                "application/json": {
                                    schema: {
                                        type: "object",
                                        properties: {
                                            data: { type: "array", items: { $ref: "#/components/schemas/Product" } },
                                            pagination: { $ref: "#/components/schemas/Pagination" },
                                            meta: { type: "object" },
                                        },
                                    },
                                },
                            },
                        },
                        "401": { description: "Clé d'API absente, invalide ou révoquée", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    },
                },
            },
            "/products/{codein}": {
                get: {
                    operationId: "obtenirProduit",
                    summary: "Fiche complète d'un produit",
                    description: "Toutes les données d'un article : séries mensuelles, ventilation par magasin, stock, marges, gammes et métriques réseau.",
                    parameters: [
                        { name: "codein", in: "path", required: true, schema: { type: "string" }, description: "Identifiant interne de l'article." },
                        { name: "fournisseur", in: "query", schema: { type: "string" }, description: "Lève l'ambiguïté d'un article référencé chez plusieurs fournisseurs." },
                    ],
                    responses: {
                        "200": {
                            description: "Fiche produit",
                            content: {
                                "application/json": {
                                    schema: {
                                        type: "object",
                                        properties: { data: { $ref: "#/components/schemas/Product" }, meta: { type: "object" } },
                                    },
                                },
                            },
                        },
                        "404": { description: "Produit absent de l'instantané", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                        "401": { description: "Clé d'API absente, invalide ou révoquée", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    },
                },
            },
            "/network/{codeCentrale}": {
                get: {
                    operationId: "obtenirMetriquesReseau",
                    summary: "Métriques du réseau Qlik pour un produit",
                    description: "Performances du produit sur l'ensemble du réseau Foir'Fouille (~270 magasins) et courbe des quantités sur 12 mois glissants.",
                    parameters: [
                        { name: "codeCentrale", in: "path", required: true, schema: { type: "string" }, description: "Code centrale du produit (format 10000XXXXXX)." },
                    ],
                    responses: {
                        "200": {
                            description: "Métriques réseau",
                            content: {
                                "application/json": {
                                    schema: {
                                        type: "object",
                                        properties: { data: { $ref: "#/components/schemas/NetworkMetrics" }, meta: { type: "object" } },
                                    },
                                },
                            },
                        },
                        "404": { description: "Aucune donnée réseau pour ce code centrale", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                        "401": { description: "Clé d'API absente, invalide ou révoquée", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    },
                },
            },
        },
    };

    // CORS ouvert en lecture : le schéma est public et peut être chargé par un outil tiers.
    return Response.json(spec, { headers: { "Access-Control-Allow-Origin": "*" } });
}
