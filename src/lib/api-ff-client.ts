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
    noid?: number;        // SQL Server internal ID (pour endpoint /mensuel)
    reference?: string;   // référence fournisseur (ref_fou_principale)
    gtin?: string;        // code-barres EAN/GTIN
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractList(data: unknown): any[] {
    if (Array.isArray(data)) return data;
    const d = data as Record<string, unknown>;
    // Essaie les wrappers courants
    for (const key of ["items", "data", "result", "results", "records", "list", "mouvements", "articles", "fournisseurs", "ventes", "stocks", "commandes"]) {
        if (Array.isArray(d[key])) return d[key] as unknown[];
    }
    // Cherche la première propriété qui est un tableau
    for (const val of Object.values(d)) {
        if (Array.isArray(val)) return val as unknown[];
    }
    return [];
}

async function fetchAllPages<T>(
    buildUrl: (page: number) => string,
    _extractItems: (data: unknown) => T[],  // conservé pour compatibilité, mais on utilise extractList
    pageSize = 500
): Promise<T[]> {
    const all: T[] = [];
    let page = 1;

    while (true) {
        const url = buildUrl(page);
        console.log(`[api-ff] GET ${url}`);
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
            console.error(`[api-ff] HTTP ${res.status} — ${url}`);
            break;
        }
        const data = await res.json();
        const items = extractList(data) as T[];
        if (page === 1) {
            console.log(`[api-ff] page 1: ${items.length} items, keys: ${items[0] ? Object.keys(items[0] as object).join(",") : "empty"}`);
        }
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

/** Extrait le code fournisseur depuis n'importe quelle forme de réponse API */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractFouCode(f: any): string {
    return f.codefou ?? f.CodeFou ?? f.code_fournisseur ?? f.codeFournisseur ?? f.code ?? String(f.id ?? "");
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractFouNom(f: any): string {
    return f.nomfou ?? f.NomFou ?? f.nom_fournisseur ?? f.nomFournisseur ?? f.nom ?? f.libelle ?? f.name ?? "Inconnu";
}

export async function getFournisseursFromApi(
    search?: string
): Promise<{ code: string; nom: string }[]> {
    try {
        const url = search
            ? `${FF_API_BASE}/api/fournisseurs?search=${encodeURIComponent(search)}&limit=500`
            : `${FF_API_BASE}/api/fournisseurs?limit=500`;

        console.log(`[api-ff] GET ${url}`);
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
        const data = await res.json();

        // Log premier item pour diagnostic
        const rawList = extractList(data);
        console.log(`[api-ff] fournisseurs: ${rawList.length} items, sample keys:`, rawList[0] ? Object.keys(rawList[0] as object) : "empty");

        return rawList
            .map((f: unknown) => ({ code: extractFouCode(f), nom: extractFouNom(f) }))
            .filter((f: { code: string; nom: string }) => f.code);
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
    const raw = await fetchAllPages<unknown>(
        (page) => `${FF_API_BASE}/api/articles?codefou=${encodeURIComponent(codefou)}&page=${page}&limit=500`,
        extractList,
        500
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return raw.map((r: any): FfArticle => ({
        codein:     r.codein            ?? r.Codein    ?? r.code_article      ?? r.codeArticle    ?? String(r.id ?? ""),
        libelle1:   r.libelle1          ?? r.Libelle1  ?? r.libelle           ?? r.designation    ?? r.nom ?? "",
        codefou:    r.codefou_principal ?? r.codefou   ?? r.Codefou           ?? r.code_fournisseur ?? r.codeFournisseur ?? codefou,
        nomfou:     r.nom_fou_principal ?? r.nomfou    ?? r.Nomfou            ?? r.nom_fournisseur  ?? r.nomFournisseur ?? "",
        pcb:        r.pcb_principal     ?? r.pcb       ?? r.Pcb               ?? r.conditionnement  ?? r.colisage,
        pv_central: r.pv_central        ?? r.PvCentral ?? r.prix_vente_mini   ?? r.pv ?? r.prixVente,
        noid:       r.no_id             ?? r.noid      ?? r.NoId,
        reference:  r.ref_fou_principale ?? r.reference ?? r.ref_fournisseur  ?? undefined,
        gtin:       r.gtin              ?? r.Gtin      ?? r.ean               ?? r.barcode        ?? undefined,
    })).filter(a => a.codein);
}

// ---------------------------------------------------------------------------
// Mouvements (ventes + stock12m)
// ---------------------------------------------------------------------------

export async function getMouvementsByFournisseur(
    codefou: string,
    dateDebut: string,
    dateFin: string
): Promise<FfMouvement[]> {
    const raw = await fetchAllPages<unknown>(
        (page) =>
            `${FF_API_BASE}/api/mouvements/articles?codefou=${encodeURIComponent(codefou)}&dateDebut=${dateDebut}&dateFin=${dateFin}&page=${page}&limit=1000`,
        extractList,
        1000
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return raw.map((r: any): FfMouvement => ({
        codein:   r.codein    ?? r.Codein   ?? r.code_article   ?? "",
        genremvt: Number(r.genremvt  ?? r.GenreMvt  ?? r.genre_mvt ?? r.type ?? 0),
        datemvt:  r.datmvt    ?? r.datemvt  ?? r.DateMvt  ?? r.date_mvt ?? r.date ?? "",
        qte:      Number(r.qtemvt    ?? r.qte        ?? r.Qte      ?? r.quantite ?? 0),
        montant:  Number(r.mntmvtht  ?? r.montant    ?? r.Montant  ?? r.montant_mvt ?? r.ca ?? 0),
        marge:    Number(r.margemvt  ?? r.marge      ?? r.Marge    ?? r.marge_mvt ?? 0),
        qtestock: Number(r.qtestock  ?? r.QteStock   ?? r.qte_stock ?? r.stock ?? 0),
        site:     r.site      ?? r.Site     ?? r.magasin         ?? r.code_magasin ?? r.codesite ?? "",
    })).filter(m => m.codein && m.datemvt);
}

// ---------------------------------------------------------------------------
// Mensuel — stock fin de mois + ventes + réceptions par article et par site
// GET /api/articles/:no_id/mensuel?dateDebut=&dateFin=
// ---------------------------------------------------------------------------

export interface FfMensuelVentes {
    nb_passages: string;
    qte_vendue: string;   // négatif (ex: "-2.000")
    ca_ht: string;        // négatif (ex: "-26.6600")
    ca_ttc: string;
    marge: string;        // positif (ex: "12.7600")
    taux_marge: string;
}

export interface FfMensuelReceptions {
    nb_receptions: string;
    qte_recue: string;
}

export interface FfMensuelEntry {
    mois: string;              // "YYYY-MM"
    site: string;              // code site ("292", "579")
    stock_fin_mois: string;    // stock fin de mois
    prmp_fin_mois: string;     // PRMP fin de mois
    ventes: FfMensuelVentes | null;
    receptions: FfMensuelReceptions | null;
}

/**
 * Récupère les données mensuelles (stock + ventes + réceptions) pour un lot d'articles.
 * Utilise no_id comme identifiant (obligatoire pour l'API).
 * Retourne Map<codein, FfMensuelEntry[]>
 */
export async function getMensuelByArticles(
    articles: FfArticle[],
    dateDebut: string,
    dateFin: string,
    batchSize = 20
): Promise<Map<string, FfMensuelEntry[]>> {
    const result = new Map<string, FfMensuelEntry[]>();

    for (let i = 0; i < articles.length; i += batchSize) {
        const batch = articles.slice(i, i + batchSize);
        await Promise.all(
            batch.map(async (art) => {
                const noId = art.noid;
                if (!noId) return;
                try {
                    const url = `${FF_API_BASE}/api/articles/${encodeURIComponent(String(noId))}/mensuel?dateDebut=${dateDebut}&dateFin=${dateFin}`;
                    const res = await fetch(url, { cache: "no-store" });
                    if (!res.ok) return;
                    const data = await res.json();
                    const entries: FfMensuelEntry[] = Array.isArray(data.data) ? data.data : [];
                    if (entries.length > 0) {
                        result.set(art.codein, entries);
                    }
                } catch (err) {
                    console.error(`[api-ff] getMensuel error for ${art.codein}:`, err);
                }
            })
        );
    }

    return result;
}

// ---------------------------------------------------------------------------
// Referentiel — article complet : nomenclature, gammes, stock, prix, fournisseurs
// GET /api/articles/:no_id/referentiel
// ---------------------------------------------------------------------------

export interface FfReferentiel {
    article: {
        no_id: string;
        codein: string;
        nom_code: string | null;    // code nomenclature (ex: "360504")
        nom_libelle: string | null; // libellé nomenclature
        nom_niveau: number | null;
        nom_chemin_pere: string | null;
    };
    gammes: {
        gamme_code: string;
        gamme_libelle: string;
        saison_code: string;
        saison_libelle: string;
    }[];
    stock: {
        site: string;
        stockdispo: string;
        qte: string;
        prmp: string;
        valstock: string;
        pv: string;
        dernierevente: string;
        dernierereception: string;
        stockmort: boolean;
    }[];
    prix: {
        achat: string | null;
        vente_par_site: { site: string; pv: string }[];
    } | null;
    fournisseurs: {
        codefou: string;
        ref_fou: string;
        pcb: string;
        prixachat: string;
    }[];
    performance: {
        derniere_vente: string | null;
        derniere_entree: string | null;
        qte_totale_vendue: string | null;
        ca_ttc_total: string | null;
        marge_totale: string | null;
    } | null;
}

/**
 * Récupère le référentiel complet (nomenclature, gamme, stock, prix) pour un lot d'articles.
 * Utilise no_id comme identifiant.
 * Retourne Map<codein, FfReferentiel>
 */
export async function getReferentielByArticles(
    articles: FfArticle[],
    batchSize = 20
): Promise<Map<string, FfReferentiel>> {
    const result = new Map<string, FfReferentiel>();

    for (let i = 0; i < articles.length; i += batchSize) {
        const batch = articles.slice(i, i + batchSize);
        await Promise.all(
            batch.map(async (art) => {
                const noId = art.noid;
                if (!noId) return;
                try {
                    const url = `${FF_API_BASE}/api/articles/${encodeURIComponent(String(noId))}/referentiel`;
                    const res = await fetch(url, { cache: "no-store" });
                    if (!res.ok) return;
                    const data: FfReferentiel = await res.json();
                    if (data?.article) result.set(art.codein, data);
                } catch (err) {
                    console.error(`[api-ff] getReferentiel error for ${art.codein}:`, err);
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
// Ranking — classement réseau et magasin
// GET /api/ranking?codein=<codein>
// Réponse : { count: number, ranking: RankingEntry[] }
// Les valeurs ranking sont des string|null, à parser en number.
// ---------------------------------------------------------------------------

export interface FfRanking {
    ranking_ca?: number;
    ranking_qte?: number;
    ranking_mag_ca?: number;
    ranking_mag_qte?: number;
    ranking_mag_marge?: number;
    pv_calcule?: number;
    pv_mag?: number;
    pv_cen?: number;
}

/** Parse une valeur string|null en number|undefined */
function parseRankNum(val: string | null | undefined): number | undefined {
    if (val == null || val === "") return undefined;
    const n = Number(val);
    return isNaN(n) ? undefined : n;
}

export interface RankingResult {
    rankings: Map<string, FfRanking>;
    /** Nombre total de produits dans le classement (produits avec ventes sur la période) */
    totalRankedProducts: number;
}

/**
 * Récupère le ranking (réseau + magasin) pour un lot d'articles via codein.
 * Fait d'abord un appel pour connaître le nombre total de produits classés,
 * puis récupère le ranking de chaque article.
 */
export async function getRankingByArticles(
    articles: { codein: string; gtin?: string }[],
    batchSize = 20
): Promise<RankingResult> {
    const rankings = new Map<string, FfRanking>();
    if (articles.length === 0) return { rankings, totalRankedProducts: 0 };

    // 1. Récupérer le nombre total de produits classés (1 seul appel)
    let totalRankedProducts = 0;
    try {
        const countUrl = `${FF_API_BASE}/api/ranking?limit=1`;
        const countRes = await fetch(countUrl, { cache: "no-store" });
        if (countRes.ok) {
            const countData = await countRes.json();
            totalRankedProducts = countData?.count ?? 0;
            console.log(`[api-ff] Ranking total produits classés : ${totalRankedProducts}`);
        }
    } catch (err) {
        console.warn(`[api-ff] Failed to get ranking total count:`, err);
    }

    // 2. Récupérer le ranking de chaque article
    for (let i = 0; i < articles.length; i += batchSize) {
        const batch = articles.slice(i, i + batchSize);
        await Promise.all(
            batch.map(async (art) => {
                try {
                    const url = `${FF_API_BASE}/api/ranking?codein=${encodeURIComponent(art.codein)}`;
                    const res = await fetch(url, { cache: "no-store" });
                    if (!res.ok) return;
                    const data = await res.json();

                    const rankingList = data?.ranking;
                    if (!Array.isArray(rankingList) || rankingList.length === 0) return;

                    if (rankings.size === 0) {
                        console.log(`[api-ff] Ranking sample keys: ${Object.keys(rankingList[0]).join(",")}`);
                    }

                    const entry = rankingList[0];
                    rankings.set(art.codein, {
                        ranking_ca: parseRankNum(entry.ranking_ca),
                        ranking_qte: parseRankNum(entry.ranking_qte),
                        ranking_mag_ca: parseRankNum(entry.ranking_mag_ca),
                        ranking_mag_qte: parseRankNum(entry.ranking_mag_qte),
                        ranking_mag_marge: parseRankNum(entry.ranking_mag_marge),
                        pv_calcule: parseRankNum(entry.pv_calcule),
                        pv_mag: parseRankNum(entry.pv_mag),
                        pv_cen: parseRankNum(entry.pv_cen),
                    });
                } catch (err) {
                    console.error(`[api-ff] getRanking error for ${art.codein}:`, err);
                }
            })
        );
    }

    console.log(`[api-ff] Ranking: ${rankings.size}/${articles.length} articles enrichis`);
    return { rankings, totalRankedProducts };
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
        // Fallback : sites connus de FF Nancy
        return [
            { code: "292", nom: "Frouard (Nancy)" },
            { code: "579", nom: "Houdemont" },
        ];
    }
}
