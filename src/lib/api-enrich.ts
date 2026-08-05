/**
 * CollectFlow — Enrichissement des lignes servies par `/api/v1`.
 *
 * L'instantané `grid_rows` fige la ligne au moment du calcul. Deux informations
 * doivent pourtant refléter l'état **courant** au moment de l'appel :
 *
 * 1. **Métriques réseau Qlik** — la table `qlik_network_metrics` est mise à jour par
 *    les synchronisations et les recherches réseau, indépendamment du calcul de la
 *    grille. On les relit donc à la lecture, et on les expose telles quelles quand
 *    elles existent (`network: null` sinon).
 *
 * 2. **Gamme serveur** — `codeGamme` peut être surchargée par un snapshot de session
 *    (modification locale non enregistrée côté serveur). L'API expose la gamme **non
 *    modifiée**, celle réellement présente en base PostgreSQL, relue à chaque appel.
 *
 * Ce n'est pas un recalcul : deux lectures indexées bornées au nombre de lignes de la
 * page (500 au maximum), de l'ordre de quelques millisecondes.
 */

import "server-only";

import type { ProductRow } from "@/types/grid";
import { getNetworkMetricsByCodeCentrale, type NetworkMetricCached } from "@/lib/qlik-network-cache";
import { pgGetGammesByCodeins } from "@/lib/pg-ff-client";

export interface EnrichedProductRow extends ProductRow {
    /**
     * Gamme telle qu'elle existe sur le serveur PostgreSQL — non modifiée.
     * `null` si l'article n'a aucune gamme en base.
     */
    codeGammeServeur: string | null;
    /** Métriques réseau Qlik en cache, ou `null` si le produit n'en a pas. */
    network: NetworkMetricCached | null;
}

/**
 * Enrichit un lot de lignes. Les deux lectures sont indépendantes et lancées en
 * parallèle ; un échec de l'une n'empêche pas l'autre (l'API reste servie, avec
 * la valeur de l'instantané en repli).
 */
export async function enrichRows(rows: ProductRow[]): Promise<EnrichedProductRow[]> {
    if (rows.length === 0) return [];

    const codesCentraux = [...new Set(rows.map((r) => r.codeCentrale).filter((c): c is string => Boolean(c)))];
    const codeins = [...new Set(rows.map((r) => r.codein).filter(Boolean))];

    const [network, gammes] = await Promise.all([
        codesCentraux.length
            ? getNetworkMetricsByCodeCentrale(codesCentraux).catch((e) => {
                console.error("[api-enrich] métriques réseau KO:", (e as Error).message?.slice(0, 160));
                return new Map<string, NetworkMetricCached>();
            })
            : Promise.resolve(new Map<string, NetworkMetricCached>()),
        codeins.length
            ? pgGetGammesByCodeins(codeins).catch((e) => {
                console.error("[api-enrich] gammes serveur KO:", (e as Error).message?.slice(0, 160));
                return new Map<string, string>();
            })
            : Promise.resolve(new Map<string, string>()),
    ]);

    return rows.map((row) => {
        const metrics = row.codeCentrale ? network.get(row.codeCentrale) ?? null : null;
        // Gamme absente de la base = pas de gamme, et non « inconnue » : on distingue
        // explicitement par `null` plutôt que de retomber sur la valeur du snapshot.
        const gammeServeur = gammes.get(row.codein) ?? null;

        const enriched: EnrichedProductRow = {
            ...row,
            codeGammeServeur: gammeServeur,
            network: metrics,
        };

        // `codeGammeInit` porte déjà la sémantique « état serveur » dans la Grille :
        // on la garde alignée pour que les deux champs ne divergent jamais.
        if (gammes.size > 0) {
            enriched.codeGammeInit = gammeServeur as ProductRow["codeGammeInit"];
        }

        // Les colonnes réseau de la ligne datent du calcul : on les réaligne sur le
        // cache quand il a quelque chose à dire.
        if (metrics) {
            enriched.caReseau = metrics.caReseau;
            enriched.qteReseau = metrics.qteReseau;
            enriched.nbMagasinsReseau = metrics.nbMagasinsReseau;
            enriched.caParMagasinReseau = metrics.caParMagasinReseau;
            enriched.margePctReseau = metrics.margePctReseau;
            enriched.qteReseauByMonth = metrics.qteByMonth;
            enriched.networkFetchedAt = metrics.fetchedAt ?? undefined;
        }

        return enriched;
    });
}
