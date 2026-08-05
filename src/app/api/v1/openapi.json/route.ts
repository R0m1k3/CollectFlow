import { NextRequest } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { GRID_SORT_KEYS } from "@/lib/grid-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/openapi.json
 *
 * Spécification lisible par machine de l'API CollectFlow. Permet aux outils externes
 * — et à l'assistant IA — de découvrir les endpoints sans documentation manuscrite.
 * Authentifiée comme le reste de l'API : la spec décrit une surface interne.
 */
export async function GET(req: NextRequest) {
    const authCtx = await requireApiAuth(req);
    if (authCtx instanceof Response) return authCtx;

    const paginationParams = [
        { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
    ];
    const sortParams = [
        { name: "sort", in: "query", schema: { type: "string", enum: GRID_SORT_KEYS }, description: "Colonne de tri." },
        { name: "order", in: "query", schema: { type: "string", enum: ["asc", "desc"], default: "desc" } },
        {
            name: "fields",
            in: "query",
            schema: { type: "string" },
            description: "Champs de ProductRow à conserver, séparés par des virgules (allège fortement la réponse). `codein` est toujours inclus.",
        },
        {
            name: "enrich",
            in: "query",
            schema: { type: "string", enum: ["0", "1"], default: "1" },
            description:
                "1 (défaut) : relit les métriques réseau Qlik (`network`) et la gamme serveur (`codeGammeServeur`) au moment de l'appel. "
                + "0 : sert l'instantané brut, légèrement plus rapide.",
        },
    ];

    const spec = {
        openapi: "3.1.0",
        info: {
            title: "CollectFlow API",
            version: "1.0.0",
            description:
                "Lecture de la grille CollectFlow (ventes 12 mois, stock, marges, gammes, métriques réseau Qlik) "
                + "et recherche de produits.\n\n"
                + "**Aucun endpoint ne déclenche de recalcul ni d'appel à Qlik.** Toutes les réponses proviennent "
                + "de données déjà persistées : l'instantané de grille (`grid_rows`), rempli quand la Grille est "
                + "ouverte dans l'application, et le cache des métriques réseau (`qlik_network_metrics`). "
                + "Un fournisseur jamais ouvert renvoie donc `202 not_ready` au lieu d'imposer une attente.\n\n"
                + "Deux informations sont relues à chaque appel car elles évoluent indépendamment du calcul de "
                + "la grille : les **métriques réseau Qlik** (`network`, `null` quand il n'y en a pas) et la "
                + "**gamme serveur non modifiée** (`codeGammeServeur`). Passer `enrich=0` pour s'en dispenser.",
        },
        servers: [{ url: "/api/v1" }],
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        components: {
            securitySchemes: {
                ApiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" },
                BearerAuth: { type: "http", scheme: "bearer" },
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
                                details: {},
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
                ProductRow: {
                    type: "object",
                    description: "Ligne de grille. Voir src/types/grid.ts pour la liste complète des champs.",
                    properties: {
                        codein: { type: "string", description: "Identifiant interne FF Nancy." },
                        codeFournisseur: { type: "string" },
                        nomFournisseur: { type: "string" },
                        libelle1: { type: "string" },
                        gtin: { type: "string" },
                        codeCentrale: { type: "string", description: "Clé de jointure avec Qlik (format 10000XXXXXX)." },
                        codeGamme: { type: ["string", "null"], description: "Gamme courante — peut être surchargée par un snapshot de session." },
                        codeGammeServeur: {
                            type: ["string", "null"],
                            description: "Gamme **non modifiée**, telle qu'elle existe sur le serveur PostgreSQL. Relue à chaque appel (sauf `enrich=0`). `null` = aucune gamme en base.",
                        },
                        codeGammeInit: { type: ["string", "null"], description: "Alias historique de `codeGammeServeur`, maintenu aligné." },
                        network: {
                            type: ["object", "null"],
                            description: "Métriques réseau Qlik en cache, `null` si le produit n'en a pas.",
                            properties: {
                                caReseau: { type: "number" },
                                qteReseau: { type: "number" },
                                nbMagasinsReseau: { type: "integer" },
                                caParMagasinReseau: { type: "number" },
                                margePctReseau: { type: "number", description: "Ratio brut Qlik (0.32 = 32 %)." },
                                qteByMonth: { type: ["object", "null"], description: "Quantités par mois, clés YYYY-MM." },
                                fetchedAt: { type: ["string", "null"], format: "date-time" },
                            },
                        },
                        totalCa: { type: "number" },
                        totalQuantite: { type: "number" },
                        totalMarge: { type: "number" },
                        tauxMarge: { type: "number" },
                        stockActuel: { type: "number" },
                        sales12m: { type: "object", description: "Quantités vendues par mois, clés YYYYMM." },
                        stock12m: { type: "object", description: "Stock fin de mois, clés YYYYMM." },
                        sales12mByStore: { type: "object", description: "Ventes par magasin puis par mois." },
                        caReseau: { type: "number" },
                        qteReseau: { type: "number" },
                        nbMagasinsReseau: { type: "integer" },
                        caParMagasinReseau: { type: "number" },
                        margePctReseau: { type: "number", description: "Ratio brut Qlik (0.32 = 32 %)." },
                        qteReseauByMonth: { type: ["object", "null"], description: "Quantités réseau par mois, clés YYYY-MM." },
                    },
                },
            },
        },
        paths: {
            "/fournisseurs": {
                get: {
                    summary: "Liste des fournisseurs, avec la fraîcheur de leur instantané de grille",
                    parameters: [
                        { name: "search", in: "query", schema: { type: "string" } },
                        {
                            name: "withData",
                            in: "query",
                            schema: { type: "string", enum: ["0", "1"] },
                            description: "1 = uniquement les fournisseurs déjà présents dans l'instantané.",
                        },
                    ],
                    responses: { "200": { description: "OK" }, "401": { description: "Non authentifié" } },
                },
            },
            "/grid": {
                get: {
                    summary: "Lignes de grille d'un fournisseur",
                    description: "Répond `202 not_ready` si le fournisseur n'a pas encore d'instantané.",
                    parameters: [
                        { name: "fournisseur", in: "query", required: true, schema: { type: "string" } },
                        { name: "gamme", in: "query", schema: { type: "string" } },
                        { name: "code1", in: "query", schema: { type: "string" } },
                        { name: "code2", in: "query", schema: { type: "string" } },
                        { name: "code3", in: "query", schema: { type: "string" } },
                        { name: "search", in: "query", schema: { type: "string" }, description: "Libellé, codein, GTIN, référence ou code centrale." },
                        ...sortParams,
                        ...paginationParams,
                    ],
                    responses: {
                        "200": { description: "OK" },
                        "202": { description: "Instantané pas encore calculé" },
                        "400": { description: "Paramètres invalides" },
                        "401": { description: "Non authentifié" },
                    },
                },
            },
            "/products/search": {
                get: {
                    summary: "Recherche transversale de produits, tous fournisseurs confondus",
                    parameters: [
                        { name: "q", in: "query", required: true, schema: { type: "string", maxLength: 120 } },
                        { name: "fournisseur", in: "query", schema: { type: "string" }, description: "Restreint la recherche à un fournisseur." },
                        { name: "gamme", in: "query", schema: { type: "string" } },
                        ...sortParams,
                        ...paginationParams,
                    ],
                    responses: { "200": { description: "OK" }, "401": { description: "Non authentifié" } },
                },
            },
            "/products/{codein}": {
                get: {
                    summary: "Fiche complète d'un produit",
                    parameters: [
                        { name: "codein", in: "path", required: true, schema: { type: "string" } },
                        { name: "fournisseur", in: "query", schema: { type: "string" }, description: "Lève l'ambiguïté d'un article multi-fournisseurs." },
                    ],
                    responses: { "200": { description: "OK" }, "404": { description: "Inconnu de l'instantané" } },
                },
            },
            "/network/{codeCentrale}": {
                get: {
                    summary: "Métriques réseau Qlik en cache + courbe 12 mois",
                    parameters: [{ name: "codeCentrale", in: "path", required: true, schema: { type: "string" } }],
                    responses: { "200": { description: "OK" }, "404": { description: "Absent du cache réseau" } },
                },
            },
        },
    };

    return Response.json(spec);
}
