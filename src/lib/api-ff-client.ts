/**
 * CollectFlow — API FF Nancy Client
 *
 * Client HTTP centralisé pour l'API REST https://api.ffnancy.fr
 * Sync nuit SQL Server → données fraîches J-1
 *
 * Stratégie mouvements : appeler SANS filtre genremvt (tous types)
 *   - genremvt = 3 → alimenter sales12m (ventes)
 *   - Tous types → lire qtestock pour reconstruire stock12m
 */

const FF_API_BASE = process.env.FF_API_BASE_URL ?? "https://api.ffnancy.fr";

// ---------------------------------------------------------------------------
// Types API (shapes des réponses brutes)
// ---------------------------------------------------------------------------

export interface FfFournisseur {
    codefou: string;
    nomfou: string;
}

export interface FfArticle {
    codein: string;
    libelle1: string;
    codefou: string;
    nomfou?: string;
    pcb?: number;         // conditionnement
    pv_central?: number;  // prix de vente central
    noid?: number;        // SQL Server internal ID
}

export interface FfMouvement {
    codein: string;
    genremvt: number;     // 3 = vente client
    datemvt: string;      // ISO date (YYYY-MM-DD)
    qte: number;          // quantité du mouvement
    montant: number;      // montant HT
    marge?: number;       // marge (si disponible)
    qtestock: number;     // stock APRÈS ce mouvement — clé pour stock12m
    site: string;         // code magasin / site
}

export interface FfStock {
    codein: string;
    site?: string;
    stockdispo: number;
    qte: number;
    valstock: number;
    prmp?: number;        // PRMP (prix de revient moyen pondéré)
    pv?: number;          // prix de vente
    dernieresventes?: string;
    dernierereception?: string;
    nbjoursdernsventes?: number;
}

export interface FfCommande {
    codein: string;
    qtecde: number;
}

export interface FfSyncStatus {
    lastSync: string;
    tables: { nom: string; derniereSync: string; nbLignes?: number }[];
}

/** Stock agrégé sur tous les sites pour un codein */
export interface AggregatedStock {
    stockActuel: number;           // sum stockdispo
    stockTotal: number;            // sum qte
    stockValeur: number;           // sum valstock
    pa: number;                    // prmp (premier site non-zéro)
    prixVente: number;             // pv premier site
    derniereVente: string;         // max date tous sites
    derniereLivraison: string;     // max dernierereception tous sites
    nbJoursDerniereVente: number;  // min tous sites
}

// ---------------------------------------------------------------------------
// Pagination générique
// ---------------------------------------------------------------------------

async function fetchAllPages<T>(
    buildUrl: (page: number) => string,
    extractItems: (data: unknown) => T[],
    pageSize = 500
): Promise<T[]> {
    const all: T[] = [];
    let page = 1;

    while (true) {
        const url = buildUrl(page);
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
            console.error(`[api-ff] HTTP ${res.status} — ${url}`);
            break;
        }
        const data = await res.json();
        const items = extractItems(data);
        all.push(...items);
        if (items.length < pageSize) break;
        page++;
    }

    return all;
}

// ---------------------------------------------------------------------------
// Helpers date
// ---------------------------------------------------------------------------

/** Retourne la fenêtre des 12 mois complets précédant le mois en cours.
 * En mars 2026 → { dateDebut: "2025-03-01", dateFin: "2026-02-28" }
 */
export function buildLast12MonthsRange(): { dateDebut: string; dateFin: string } {
    const now = new Date();
    // Fin : dernier jour du mois précédent le mois courant
    const endMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    // Début : 12 mois avant le mois courant
    const startMonth = new Date(now.getFullYear(), now.getMonth() - 12, 1);

    return {
        dateDebut: startMonth.toISOString().slice(0, 10),
        dateFin: endMonth.toISOString().slice(0, 10),
    };
}

/** "2025-03-15" → "202503" */
export function dateToYYYYMM(isoDate: string): string {
    return isoDate.slice(0, 7).replace("-", "");
}

// ---------------------------------------------------------------------------
// Fournisseurs
// ---------------------------------------------------------------------------

export async function getFournisseursFromApi(
    search?: string
): Promise<{ code: string; nom: string }[]> {
    try {
        const url = search
            ? `${FF_API_BASE}/api/fournisseurs?search=${encodeURIComponent(search)}&limit=500`
            : `${FF_API_BASE}/api/fournisseurs?limit=500`;

        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        // L'API peut renvoyer { items: [...] } ou directement [...]
        const list: FfFournisseur[] = Array.isArray(data) ? data : (data.items ?? data.data ?? []);
        return list.map(f => ({ code: f.codefou, nom: f.nomfou }));
    } catch (err) {
        console.error("[api-ff] getFournisseursFromApi error:", err);
        return [];
    }
}

// ---------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------

export async function getArticlesByFournisseur(
    codefou: string
): Promise<FfArticle[]> {
    return fetchAllPages<FfArticle>(
        (page) => `${FF_API_BASE}/api/articles?codefou=${encodeURIComponent(codefou)}&page=${page}&limit=500`,
        (data) => Array.isArray(data) ? data : ((data as any).items ?? (data as any).data ?? []),
        500
    );
}

// ---------------------------------------------------------------------------
// Mouvements (ventes + stock12m)
// ---------------------------------------------------------------------------

export async function getMouvementsByFournisseur(
    codefou: string,
    dateDebut: string,
    dateFin: string
): Promise<FfMouvement[]> {
    return fetchAllPages<FfMouvement>(
        (page) =>
            `${FF_API_BASE}/api/mouvements/articles?codefou=${encodeURIComponent(codefou)}&datedeb=${dateDebut}&datefin=${dateFin}&page=${page}&limit=1000`,
        (data) => Array.isArray(data) ? data : ((data as any).items ?? (data as any).data ?? []),
        1000
    );
}

// ---------------------------------------------------------------------------
// Stock (agrégé tous sites)
// ---------------------------------------------------------------------------

export async function getStockByFournisseur(
    articles: FfArticle[]
): Promise<Map<string, AggregatedStock>> {
    const result = new Map<string, AggregatedStock>();
    const BATCH_SIZE = 10;

    for (let i = 0; i < articles.length; i += BATCH_SIZE) {
        const batch = articles.slice(i, i + BATCH_SIZE);
        await Promise.all(
            batch.map(async (art) => {
                try {
                    const res = await fetch(
                        `${FF_API_BASE}/api/stocks/articles?codein=${encodeURIComponent(art.codein)}`,
                        { cache: "no-store" }
                    );
                    if (!res.ok) return;
                    const data = await res.json();
                    const sites: FfStock[] = Array.isArray(data) ? data : ((data as any).items ?? (data as any).data ?? []);
                    if (sites.length === 0) return;

                    const agg: AggregatedStock = {
                        stockActuel: 0,
                        stockTotal: 0,
                        stockValeur: 0,
                        pa: 0,
                        prixVente: 0,
                        derniereVente: "",
                        derniereLivraison: "",
                        nbJoursDerniereVente: 9999,
                    };

                    for (const s of sites) {
                        agg.stockActuel += s.stockdispo ?? 0;
                        agg.stockTotal += s.qte ?? 0;
                        agg.stockValeur += s.valstock ?? 0;
                        if (!agg.pa && s.prmp) agg.pa = s.prmp;
                        if (!agg.prixVente && s.pv) agg.prixVente = s.pv;
                        if (s.dernieresventes && s.dernieresventes > agg.derniereVente) {
                            agg.derniereVente = s.dernieresventes;
                        }
                        if (s.dernierereception && s.dernierereception > agg.derniereLivraison) {
                            agg.derniereLivraison = s.dernierereception;
                        }
                        if (s.nbjoursdernsventes !== undefined && s.nbjoursdernsventes < agg.nbJoursDerniereVente) {
                            agg.nbJoursDerniereVente = s.nbjoursdernsventes;
                        }
                    }
                    if (agg.nbJoursDerniereVente === 9999) agg.nbJoursDerniereVente = 0;

                    result.set(art.codein, agg);
                } catch (err) {
                    console.error(`[api-ff] getStock error for ${art.codein}:`, err);
                }
            })
        );
    }

    return result;
}

// ---------------------------------------------------------------------------
// Commandes en cours
// ---------------------------------------------------------------------------

export async function getCommandesByFournisseur(
    codefou: string
): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    try {
        const res = await fetch(
            `${FF_API_BASE}/api/commandes/articles?codefou=${encodeURIComponent(codefou)}`,
            { cache: "no-store" }
        );
        if (!res.ok) return result;
        const data = await res.json();
        const list: FfCommande[] = Array.isArray(data) ? data : ((data as any).items ?? (data as any).data ?? []);
        for (const c of list) {
            result.set(c.codein, (result.get(c.codein) ?? 0) + (c.qtecde ?? 0));
        }
    } catch (err) {
        console.error("[api-ff] getCommandesByFournisseur error:", err);
    }
    return result;
}

// ---------------------------------------------------------------------------
// Statut de synchronisation
// ---------------------------------------------------------------------------

export async function getSyncStatus(): Promise<FfSyncStatus | null> {
    try {
        const res = await fetch(`${FF_API_BASE}/api/sync/status`, { cache: "no-store" });
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        console.error("[api-ff] getSyncStatus error:", err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Sites (magasins)
// ---------------------------------------------------------------------------

export async function getSitesFromApi(): Promise<{ code: string; nom: string }[]> {
    try {
        const res = await fetch(`${FF_API_BASE}/api/sites`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const list = Array.isArray(data) ? data : ((data as any).items ?? (data as any).data ?? []);
        return list.map((s: any) => ({ code: s.code ?? s.codesite ?? s.site, nom: s.nom ?? s.libelle ?? s.code }));
    } catch (err) {
        console.error("[api-ff] getSitesFromApi error:", err);
        // Fallback : 2 sites connus de FF Nancy
        return [
            { code: "NANCY1", nom: "FF Nancy 1" },
            { code: "NANCY2", nom: "FF Nancy 2" },
        ];
    }
}
