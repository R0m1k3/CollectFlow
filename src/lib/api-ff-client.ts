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

import fs from "fs/promises";
import path from "path";

const CONFIG_FILE = path.join(process.cwd(), "data", ".db-config.json");
const FF_API_BASE_DEFAULT = "https://api.ffnancy.fr";
const FF_API_BASE_TTL_MS = 30_000;

let ffApiBaseCache: { value: string; at: number } | null = null;

/**
 * URL de l'API FF Nancy, résolue **au moment de l'appel**.
 *
 * Ordre de priorité : réglage enregistré dans Paramètres → variable
 * d'environnement `FF_API_BASE_URL` → valeur par défaut. Auparavant l'URL était
 * figée au chargement du module depuis l'environnement seul : impossible de la
 * corriger depuis l'application quand le serveur changeait d'adresse.
 *
 * Le résultat est mémorisé 30 s pour ne pas relire le fichier à chaque requête.
 */
async function getFfApiBase(): Promise<string> {
    if (ffApiBaseCache && Date.now() - ffApiBaseCache.at < FF_API_BASE_TTL_MS) {
        return ffApiBaseCache.value;
    }
    let configured: string | undefined;
    try {
        const raw = await fs.readFile(CONFIG_FILE, "utf-8");
        const parsed = JSON.parse(raw) as { ffApiBaseUrl?: string };
        configured = parsed?.ffApiBaseUrl?.trim() || undefined;
    } catch {
        // Fichier absent ou illisible : on retombe sur l'environnement.
    }
    const value = (configured || process.env.FF_API_BASE_URL || FF_API_BASE_DEFAULT).replace(/\/+$/, "");
    ffApiBaseCache = { value, at: Date.now() };
    return value;
}

/** Vide le cache — appelé après un enregistrement dans Paramètres. */
export function resetFfApiBaseCache(): void {
    ffApiBaseCache = null;
}

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
    actif?: boolean;      // article actif
    suspendu?: boolean;   // article suspendu
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
    codefou_reel?: string;       // code fournisseur réel (dernière entrée avant cette vente, ou code de l'entrée)
    nom_fournisseur_reel?: string; // nom résolu du fournisseur réel
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

export interface FfSyncTable {
    nom: string;
    derniereSync: string;
    nbLignes?: number;
    /** "ok" ou état d'erreur renvoyé par la synchronisation. */
    statut?: string;
    erreur?: string | null;
}

export interface FfSyncStatus {
    lastSync: string;
    tables: FfSyncTable[];
}

/**
 * Normalise la réponse de `/api/sync/status`.
 *
 * L'API renvoie `{ sync: [{ table_name, last_sync, rows_synced, status, error_msg }] }`,
 * alors que l'application attendait `{ lastSync, tables: [{ nom, derniereSync, nbLignes }] }`.
 * Les champs lus n'existaient donc pas : le panneau des Paramètres affichait une
 * coquille vide sans la moindre erreur, puisque la requête HTTP réussissait.
 *
 * Les deux formes sont acceptées ici, pour rester compatible si l'API évolue.
 */
export function normalizeSyncStatus(raw: unknown): FfSyncStatus | null {
    if (!raw || typeof raw !== "object") return null;
    const d = raw as Record<string, unknown>;

    // Forme déjà attendue par l'application.
    if (Array.isArray(d.tables)) {
        return {
            lastSync: String(d.lastSync ?? ""),
            tables: d.tables as FfSyncTable[],
        };
    }

    // Forme réelle de l'API FF Nancy.
    const sync = Array.isArray(d.sync) ? (d.sync as Array<Record<string, unknown>>) : null;
    if (!sync) return null;

    const tables: FfSyncTable[] = sync.map((t) => ({
        nom: String(t.table_name ?? t.nom ?? "—"),
        derniereSync: String(t.last_sync ?? t.derniereSync ?? ""),
        nbLignes: Number(t.rows_synced ?? t.nbLignes ?? 0) || 0,
        statut: t.status != null ? String(t.status) : undefined,
        erreur: t.error_msg != null ? String(t.error_msg) : null,
    }));

    // Pas de date globale dans la réponse : on prend la plus récente des tables.
    const lastSync = tables
        .map((t) => t.derniereSync)
        .filter(Boolean)
        .sort()
        .at(-1) ?? "";

    return { lastSync, tables };
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
    _extractItems: (data: unknown) => T[],
    pageSize = 500
): Promise<T[]> {
    // Page 1 — récupère les items et tente d'obtenir le total pour paralléliser
    const url1 = buildUrl(1);
    console.log(`[api-ff] GET ${url1}`);
    const res1 = await fetch(url1, { cache: "no-store" });
    if (!res1.ok) {
        console.error(`[api-ff] HTTP ${res1.status} — ${url1}`);
        return [];
    }
    const data1 = await res1.json();
    const items1 = extractList(data1) as T[];
    console.log(`[api-ff] page 1: ${items1.length} items, keys: ${items1[0] ? Object.keys(items1[0] as object).join(",") : "empty"}`);

    // Si la première page est incomplète, pas besoin de continuer
    if (items1.length < pageSize) return items1;

    // Cherche un total dans la réponse pour paralléliser les pages suivantes
    const d1 = data1 as Record<string, unknown>;
    const total = Number(d1.count ?? d1.total ?? d1.nb_total ?? d1.totalCount ?? 0);

    if (total > pageSize) {
        const totalPages = Math.ceil(total / pageSize);
        const remaining = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
        // Fetch en chunks de 10 pages en parallèle
        const all = [...items1];
        for (let i = 0; i < remaining.length; i += 10) {
            const chunk = remaining.slice(i, i + 10);
            const results = await Promise.all(chunk.map(async (p) => {
                const url = buildUrl(p);
                console.log(`[api-ff] GET ${url}`);
                const res = await fetch(url, { cache: "no-store" });
                if (!res.ok) return [] as T[];
                const data = await res.json();
                return extractList(data) as T[];
            }));
            for (const r of results) all.push(...r);
        }
        return all;
    }

    // Fallback parallèle sans total : fetch 10 pages à la fois, arrêt dès qu'une page est incomplète
    const all = [...items1];
    let startPage = 2;
    while (true) {
        const chunk = Array.from({ length: 10 }, (_, i) => startPage + i);
        const results = await Promise.all(chunk.map(async (p) => {
            const url = buildUrl(p);
            console.log(`[api-ff] GET ${url}`);
            const res = await fetch(url, { cache: "no-store" });
            if (!res.ok) return { p, items: [] as T[] };
            const data = await res.json();
            return { p, items: extractList(data) as T[] };
        }));
        results.sort((a, b) => a.p - b.p);
        let done = false;
        for (const { items } of results) {
            all.push(...items);
            if (items.length < pageSize) { done = true; break; }
        }
        if (done) break;
        startPage += 10;
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
    const FF_API_BASE = await getFfApiBase();
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
    const FF_API_BASE = await getFfApiBase();
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
        actif:      r.actif != null ? Boolean(Number(r.actif)) : undefined,
        suspendu:   r.suspendu != null ? Boolean(Number(r.suspendu)) : undefined,
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
    const FF_API_BASE = await getFfApiBase();
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
        codefou_reel:         r.codefou_reel         ?? undefined,
        nom_fournisseur_reel: r.nom_fournisseur_reel ?? undefined,
    })).filter(m => m.codein && m.datemvt);
}

/**
 * Retourne les mouvements pour une plage de dates (sans filtre fournisseur).
 * Utilisé pour extraire codefou_reel / nom_fournisseur_reel par codein.
 */
export async function getMouvementsForDate(
    dateDebut: string,
    dateFin: string
): Promise<FfMouvement[]> {
    const FF_API_BASE = await getFfApiBase();
    const raw = await fetchAllPages<unknown>(
        (page) =>
            `${FF_API_BASE}/api/mouvements/articles?dateDebut=${dateDebut}&dateFin=${dateFin}&page=${page}&limit=1000`,
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
        codefou_reel:         r.codefou_reel         ?? undefined,
        nom_fournisseur_reel: r.nom_fournisseur_reel ?? undefined,
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
    batchSize = 50
): Promise<Map<string, FfMensuelEntry[]>> {
    const result = new Map<string, FfMensuelEntry[]>();
    const FF_API_BASE = await getFfApiBase();

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
    batchSize = 50
): Promise<Map<string, FfReferentiel>> {
    const result = new Map<string, FfReferentiel>();
    const FF_API_BASE = await getFfApiBase();

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
    const FF_API_BASE = await getFfApiBase();
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
    const FF_API_BASE = await getFfApiBase();
        const res = await fetch(`${FF_API_BASE}/api/sync/status`, { cache: "no-store" });
        if (!res.ok) return null;
        return normalizeSyncStatus(await res.json());
    } catch (err) {
        console.error("[api-ff] getSyncStatus error:", err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Sites (magasins)
// ---------------------------------------------------------------------------

export async function getSitesFromApi(): Promise<{ code: string; nom: string }[]> {
    return [
        { code: "292", nom: "Frouard (Nancy)" },
        { code: "579", nom: "Houdemont" },
    ];
}
