/**
 * CollectFlow — Extraction Qlik via Playwright (Chromium headless).
 *
 * Le proxy Qlik refuse un websocket "raw" côté serveur (403). On ouvre donc
 * l'app dans Chromium avec une session authentifiée (cookie X-Qlik-Session
 * injecté via le flux ticket NTLM), on récupère le **qlik-csrf-token** que le
 * client Qlik utilise pour SON websocket, puis on ouvre notre propre websocket
 * Engine **in-page** avec ce token (le proxy l'accepte).
 *
 * Efficacité : on filtre d'abord Date par mois (~30 jours), puis on sélectionne
 * les Article Code demandés par petits lots. Chaque cube reste borné à
 * ~30 jours × batch d'articles, sans lire tout le catalogue Qlik.
 */

import "server-only";
import { chromium, type Browser } from "playwright-core";
import { getQlikConfig, qlikNtlmSession, type QlikConfig, type NetworkMetric, type QlikMonthMetrics } from "@/lib/qlik-client";
import { buildGridNetworkQlikDateFilter, getMonthRanges, type QlikDateFilter } from "@/lib/qlik-date-range";

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
    if (!browserPromise) {
        const execPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
        browserPromise = chromium.launch({
            headless: true,
            executablePath: execPath || undefined,
            args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"],
        }).catch((e) => { browserPromise = null; throw e; });
    }
    return browserPromise;
}

interface InPageResult {
    ok: boolean;
    rows?: Array<Array<string | number>>;
    /**
     * Métriques réseau par code central et par mois : { code: { "YYYY-MM": {…} } }.
     *
     * Le cube mensuel renvoie déjà les 6 mesures par (Article Code, Mois) ; on les
     * conserve toutes. Seule `qte` est systématiquement présente : les mois N-1
     * dérivés de « Quantité COMP » n'ont que la quantité (COMP ne porte pas les
     * autres mesures), et la passe complémentaire N-1 les complète quand le champ
     * `Année` existe.
     */
    monthly?: Record<string, Record<string, { qte: number; ca?: number; nbMag?: number; caMag?: number; margePct?: number }>>;
    size?: number;
    error?: string;
    // Compteurs agrégés pour le résumé timing final côté Node (cf. qlik-playwright).
    months?: number;
    batches?: number;
    code15Retries?: number;
    fallbackCount?: number;
    /** true si le résultat vient d'un point de contrôle (extraction interrompue). */
    partiel?: boolean;
    /** Diagnostics clés du chemin par expressions, répétés en fin de sync. */
    diagExpr?: string[];
}

function envNumber(name: string, defaultValue: number, min: number, max: number): number {
    const raw = process.env[name];
    if (raw == null || raw.trim() === "") return defaultValue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return defaultValue;
    return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function envNumberCsv(name: string, min: number, max: number): number[] {
    const raw = process.env[name];
    if (!raw) return [];
    return raw
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isFinite(value))
        .map((value) => Math.min(max, Math.max(min, Math.trunc(value))));
}

function uniqueOrdered(values: number[]): number[] {
    const seen = new Set<number>();
    const out: number[] = [];
    for (const value of values) {
        if (seen.has(value)) continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}

export async function fetchNetworkMetricsPlaywright(
    codeCentraux?: string[],
    cfg: QlikConfig = getQlikConfig(),
    dateFilter: QlikDateFilter | null = buildGridNetworkQlikDateFilter(),
    /**
     * Code fournisseur FF (ex. `J009`), tel qu'il figure dans la base SQL / l'API.
     *
     * Quand il est fourni, on sélectionne LE fournisseur côté Qlik au lieu des
     * dizaines de milliers de codes articles : `SelectValues` sur « Article Code »
     * coûte 8 à 100 s par appel quel que soit le nombre de valeurs (le moteur
     * balaie un symbole de plus d'un million d'entrées), et il faut le refaire à
     * chaque passe annuelle.
     *
     * La bascule n'est retenue que si la sélection fournisseur **couvre** les
     * codes demandés — sinon on revient à la sélection par codes.
     */
    fournisseur?: string,
): Promise<Map<string, NetworkMetric>> {
    if (!cfg.appNetwork) throw new Error("[qlik-pw] QLIK_APP_NETWORK manquant");
    if (!cfg.user || !cfg.password) throw new Error("[qlik-pw] identifiants Qlik manquants");

    // Démarre l'horloge pour le résumé timing final (cf. bloc [qlik-pw][summary]).
    const totalStart = Date.now();
    console.log(`[qlik-pw] host=${cfg.host} app=${cfg.appNetwork} — ${(codeCentraux ?? []).length} codes à sélectionner`);
    if (dateFilter) {
        console.log(`[qlik-pw] filtre Date=${dateFilter.label} (${dateFilter.dateDebut} → ${dateFilter.dateFin}, ${dateFilter.setAnalysis})`);
    }
    const sess = await qlikNtlmSession(cfg);
    console.log(`[qlik-pw] session NTLM OK, cookie=${sess.cookie.split("=")[0]}=…`);
    const [cookieName, ...rest] = sess.cookie.split("=");
    const cookieValue = rest.join("=");
    const qlikSettleMs = envNumber("QLIK_SETTLE_MS", 150, 0, 2000);
    const qlikCode15MaxAttempts = envNumber("QLIK_CODE15_MAX_ATTEMPTS", 4, 1, 8);
    const qlikArticleBatchSize = envNumber("QLIK_ARTICLE_BATCH_SIZE", 150, 1, 500);
    const csvFallbacks = envNumberCsv("QLIK_ARTICLE_BATCH_FALLBACKS", 1, 500);
    const qlikArticleBatchFallbacks = uniqueOrdered([qlikArticleBatchSize, ...(csvFallbacks.length ? csvFallbacks : [75, 50]), 75, 50]);
    // Chemin rapide : sélectionner TOUS les Article Code une seule fois, puis ne
    // changer que la Date par mois (au lieu de re-sélectionner par lots de 150 chaque
    // mois). Repli automatique sur le chemin par lots en cas de code 15.
    // ACTIVÉ PAR DÉFAUT (validé fiable) — désactivable seulement avec QLIK_SELECT_ALL_CODES=0.
    const qlikSelectAllCodes = !["0", "false", "no", "off"].includes((process.env.QLIK_SELECT_ALL_CODES ?? "").trim().toLowerCase());
    // Découpage mensuel réel via la dimension "Mois" (cube [Article Code, Mois]) : donne
    // les vraies quantités par mois ET le vrai total (au lieu de 12× la valeur annuelle).
    // Activé par défaut ; désactivable via QLIK_MONTH_DIM=0 (revient à l'itération par mois).
    const qlikMonthDim = !["0", "false", "no", "off"].includes((process.env.QLIK_MONTH_DIM ?? "").trim().toLowerCase());
    const qlikMoisDimId = (process.env.QLIK_MOIS_DIM_ID ?? "pfGAwTs").trim();
    // Mesure "Quantité COMP" (année N-1) pour compléter les mois de l'année précédente
    // → 12 mois glissants (Quantité N ne couvre que l'année en cours).
    const qlikMeasQteCompId = (process.env.QLIK_MEAS_QTE_COMP_ID ?? "96862880-76cd-4957-bf25-b96901f2ac5f").trim();
    // Agrégations directes des champs de faits. Les master measures « N » ignorent
    // la sélection Date (mesures « cumul année en cours ») : elles ne peuvent pas
    // produire une fenêtre 12 mois glissants. Surchargeables si le modèle change.
    // Agrégation directe des faits : chemin de SECOURS, utilisé quand aucune valeur
    // de `Période` ne couvre les 12 mois. Activé par défaut, mais second choix :
    // `Sum(quantite)` ignore `Type_Cal` et additionne les lignes de la période
    // courante ET de la période de comparaison, alors que les master measures
    // portent le bon filtre dès que `Période` est bien calé (cf. `choisirPeriode`).
    const qlikUseExpr = !["0", "false", "no", "off"].includes((process.env.QLIK_USE_EXPR ?? "").trim().toLowerCase());
    const qlikExprQte = (process.env.QLIK_EXPR_QTE ?? "Sum(quantite)").trim();
    const qlikExprCa = (process.env.QLIK_EXPR_CA ?? "Sum(ca_ht)").trim();
    const qlikExprNbMag = (process.env.QLIK_EXPR_NBMAG ?? "Count(DISTINCT [Magasin Code])").trim();
    const qlikExprMarge = (process.env.QLIK_EXPR_MARGE ?? "Sum(marge)").trim();
    // Champs date candidats, essayés dans l'ordre. Un champ n'est retenu que s'il
    // FILTRE réellement les faits (total non nul et strictement inférieur au total
    // sans filtre) : personne n'avait pu le vérifier tant que seules des mesures
    // insensibles à la sélection étaient utilisées.
    // Champs Qlik susceptibles de porter le CODE fournisseur (et non son libellé) :
    // c'est `code_fournisseur` qui remontait des valeurs de la forme « F005 »,
    // « A0491 » — même format que les codes de la base FF.
    const qlikSupplierFields = [
        (process.env.QLIK_FIELD_CODE_FOURNISSEUR ?? "").trim(),
        "code_fournisseur", "Fournisseur", "fournisseur_code_centrale",
    ].filter((c, i, arr) => c && arr.indexOf(c) === i);
    /** Part des codes demandés que la sélection fournisseur doit couvrir pour être retenue. */
    const qlikSupplierMinCoverage = Math.min(1, Math.max(0.5, Number(process.env.QLIK_SUPPLIER_MIN_COVERAGE ?? "0.99") || 0.99));

    const qlikDateFields = [
        (process.env.QLIK_DATE_FIELD ?? "").trim(),
        "Date", "Date calendrier", "Date_Key",
    ].filter((c, i, arr) => c && arr.indexOf(c) === i);
    const yearN = new Date().getFullYear();
    console.log(`[qlik-pw] tuning settle=${qlikSettleMs}ms code15Attempts=${qlikCode15MaxAttempts} batchFallbacks=${qlikArticleBatchFallbacks.join(">")} selectAllCodes=${qlikSelectAllCodes} monthDim=${qlikMonthDim} useExpr=${qlikUseExpr}`);
    if (qlikUseExpr) {
        console.log(`[qlik-pw] expressions mensuelles: qte="${qlikExprQte}" ca="${qlikExprCa}" nbMag="${qlikExprNbMag}" marge="${qlikExprMarge}"`);
        console.log(`[qlik-pw] champs date candidats: ${JSON.stringify(qlikDateFields)}`);
    }

    const browser = await getBrowser();
    console.log(`[qlik-pw] chromium lancé`);
    const ctx = await browser.newContext({
        httpCredentials: { username: cfg.user, password: cfg.password, origin: `https://${cfg.host}` },
        ignoreHTTPSErrors: true,
    });
    await ctx.addCookies([{ name: cookieName, value: cookieValue, domain: cfg.host, path: "/", secure: true }]);

    try {
        const page = await ctx.newPage();
        page.on("console", (msg) => console.log(`[qlik-pw][page] ${msg.text()}`));
        page.on("pageerror", (e) => console.log(`[qlik-pw][pageerror] ${e.message}`));

        // Capture le qlik-csrf-token depuis le websocket que le client Qlik ouvre
        let csrfToken: string | null = null;
        let resolveToken: (() => void) | null = null;
        const tokenReady = new Promise<void>((r) => { resolveToken = r; });
        page.on("websocket", (ws) => {
            const m = ws.url().match(/qlik-csrf-token=([^&]+)/);
            if (m && !csrfToken) { csrfToken = decodeURIComponent(m[1]); resolveToken?.(); }
        });

        await page.goto(`https://${cfg.host}/sense/app/${cfg.appNetwork}`, { waitUntil: "domcontentloaded", timeout: cfg.timeoutMs })
            .catch(() => { /* le client ouvre son ws ensuite */ });
        console.log(`[qlik-pw] page chargée, attente du qlik-csrf-token…`);
        await Promise.race([tokenReady, page.waitForTimeout(15000)]);
        if (!csrfToken) throw new Error("[qlik-pw] qlik-csrf-token introuvable (client Qlik non chargé ?)");
        const jeton: string = csrfToken;
        console.log(`[qlik-pw] csrf-token capturé, ouverture du websocket Engine in-page…`);

        // Pré-calcul des mois côté Node (pour pouvoir logger X/Y et propager au script in-page).
        const monthRanges: QlikDateFilter[] = dateFilter ? getMonthRanges(dateFilter) : [];
        const monthlyPayload = monthRanges.map((m) => ({
            label: m.label,
            dateDebut: m.dateDebut,
            dateFin: m.dateFin,
            serials: m.dailySerials, // ~30 valeurs → SelectValues en une fois
            // Même fenêtre au format entier AAAAMMJJ : certains modèles Qlik
            // n'exposent la date que par une clé numérique (`Date_Key`), pas par
            // un champ date sérialisé.
            ymd: m.dailySerials.map((serial) => {
                const d = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
                return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
            }),
        }));

        // Point de contrôle : le script in-page pousse ses résultats intermédiaires
        // à chaque passe. Si la session Qlik meurt en cours de route (« Socket
        // closed », « Execution context was destroyed »), on repart de là au lieu
        // de tout perdre — les codes déjà traités ont des données complètes, la
        // dimension Mois livrant tous leurs mois d'un coup.
        let checkpoint: { rows?: Array<Array<string | number>>; monthly?: InPageResult["monthly"] } | null = null;
        await page.exposeFunction("cfCheckpoint", (payload: { rows?: Array<Array<string | number>>; monthly?: InPageResult["monthly"] }) => {
            checkpoint = payload;
            return true;
        });

        const evaluer = () => page.evaluate(
            ({ app, dim, mca, mqte, mnb, mcamag, mmarge, codes, token, monthlyPayload, noDateMode, qlikSettleMs, qlikCode15MaxAttempts, qlikArticleBatchFallbacks, selectAllCodes, monthDim, moisDimId, mqteComp, yearN, useExpr, exprQte, exprCa, exprNbMag, exprMarge, champsDateCandidats, fournisseurCode, champsFournisseurCandidats, couvertureFournisseurMin }: {
                app: string; dim: string; mca: string; mqte: string; mnb: string; mcamag: string; mmarge: string;
                codes: string[]; token: string;
                monthlyPayload: Array<{ label: string; dateDebut: string; dateFin: string; serials: number[]; ymd: number[] }>;
                noDateMode: boolean;
                qlikSettleMs: number;
                qlikCode15MaxAttempts: number;
                qlikArticleBatchFallbacks: number[];
                selectAllCodes: boolean;
                monthDim: boolean;
                moisDimId: string;
                mqteComp: string;
                yearN: number;
                useExpr: boolean;
                exprQte: string;
                exprCa: string;
                exprNbMag: string;
                exprMarge: string;
                champsDateCandidats: string[];
                fournisseurCode: string;
                champsFournisseurCandidats: string[];
                couvertureFournisseurMin: number;
            }) =>
                new Promise<InPageResult>((resolve) => {
                    const loc = (window as unknown as { location: Location }).location;
                    const url = `wss://${loc.host}/app/${app}?reloadUri=${encodeURIComponent(loc.href)}&qlik-csrf-token=${token}`;
                    const ws = new WebSocket(url);
                    let id = 0;
                    const pend = new Map<number, { res: (v: { [k: string]: unknown }) => void; rej: (e: unknown) => void }>();
                    const rpc = (method: string, params: unknown, handle = -1) => new Promise<{ [k: string]: unknown }>((res, rej) => {
                        const i = ++id; pend.set(i, { res, rej });
                        ws.send(JSON.stringify({ jsonrpc: "2.0", id: i, handle, method, params }));
                    });
                    const ready = new Promise<void>((res, rej) => {
                        ws.onmessage = (ev: MessageEvent) => {
                            const m = JSON.parse(ev.data as string);
                            if (m.method === "OnConnected") return res();
                            if (m.id && pend.has(m.id)) {
                                const x = pend.get(m.id)!;
                                pend.delete(m.id);
                                if (m.error) x.rej(new Error(JSON.stringify(m.error)));
                                else x.res(m.result);
                            }
                        };
                        ws.onerror = () => rej(new Error("ws error (403 ?)"));
                        setTimeout(() => rej(new Error("ws timeout")), 30000);
                    });
                    // Qlik Engine code 15 = "Request aborted" : déclenché quand une requête
                    // (GetLayout / GetHyperCubeData / CreateSessionObject) entre en collision
                    // avec une évaluation de sélection encore en cours côté Engine. On retente
                    // quelques fois avec un court backoff et un log explicite de l'étape.
                    const isEngineCode15 = (e: unknown): boolean => {
                        const msg = String((e as Error)?.message ?? e);
                        return /"code"\s*:\s*15\b/.test(msg);
                    };
                    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
                    const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
                    const timed = async <T>(etape: string, method: string, fn: () => Promise<T>, timings?: Record<string, number>): Promise<{ value: T; ms: number }> => {
                        const start = nowMs();
                        const value = await fn();
                        const ms = Math.round(nowMs() - start);
                        const label = `${etape}:${method}`;
                        if (timings) timings[label] = (timings[label] ?? 0) + ms;
                        console.log(`[qlik-pw][timing] ${label} ms=${ms}`);
                        return { value, ms };
                    };
                    const timingSummary = (timings: Record<string, number>) => JSON.stringify(timings);
                    const rpcWithRetry = async (
                        etape: string,
                        method: string,
                        params: unknown,
                        handle: number,
                        onCode15Retry?: () => void,
                    ): Promise<{ [k: string]: unknown }> => {
                        let lastErr: unknown;
                        for (let attempt = 1; attempt <= qlikCode15MaxAttempts; attempt++) {
                            try {
                                return await rpc(method, params, handle);
                            } catch (e) {
                                lastErr = e;
                                if (!isEngineCode15(e) || attempt === qlikCode15MaxAttempts) throw e;
                                onCode15Retry?.();
                                const backoff = qlikSettleMs * attempt;
                                console.log(`[qlik-pw] retry code15 étape=${etape} méthode=${method} tentative=${attempt}/${qlikCode15MaxAttempts} backoff=${backoff}ms`);
                                await sleep(backoff);
                            }
                        }
                        throw lastErr;
                    };

                    // Accumulateurs déclarés au niveau de l'IIFE (et non dans le `try`) :
                    // le `catch` doit pouvoir remonter ce qui a déjà été extrait.
                    const out: Array<Array<string | number>> = [];
                    // Quantité réseau par code central et par mois (label "YYYY-MM").
                    // Accumulée en parallèle du total, sans toucher l'agrégation existante.
                    const monthlyByCode: Record<string, Record<string, { qte: number; ca?: number; nbMag?: number; caMag?: number; margePct?: number }>> = {};
                    // Diagnostics clés, RÉPÉTÉS en fin de sync : le log d'une sync fait
                    // des milliers de lignes de timings, et ce qui explique un échec se
                    // trouve tout au début — là où personne ne va le chercher.
                    const diagnostics: string[] = [];
                    const diag = (msg: string) => { diagnostics.push(msg); console.log("[qlik-pw][expr] " + msg); };

                    (async () => {
                        try {
                            await ready;
                            console.log("ws connecté (OnConnected)");
                            const open = await rpc("OpenDoc", { qDocName: app });
                            const doc = (open.qReturn as { qHandle: number }).qHandle;
                            console.log("OpenDoc OK handle=" + doc);

                            // Handles des champs Date / Article Code.
                            let dfh = -1;
                            let fh = -1;
                            let yfh = -1;
                            /**
                             * Handle du CHAMP « Période ».
                             *
                             * ⚠️ `Clear` et `SelectValues` sont des méthodes de **champ**. Les
                             * appeler sur un objet de session renvoie
                             * `{"code":-32601,"parameter":"Clear","message":"Method not found"}`,
                             * ce qui a fait avorter en production la cartographie des périodes ET
                             * le chemin d'extraction par date brute. Le list object ne sert donc
                             * plus qu'à ÉNUMÉRER les valeurs ; les sélections passent par ici.
                             */
                            let pfh = -1;
                            const df = await rpc("GetField", { qFieldName: "Date" }, doc);
                            dfh = (df.qReturn as { qHandle: number }).qHandle;
                            try {
                                const yf = await rpc("GetField", { qFieldName: "Année" }, doc);
                                yfh = (yf.qReturn as { qHandle: number }).qHandle;
                            } catch { yfh = -1; }
                            try {
                                const pf = await rpc("GetField", { qFieldName: "Période" }, doc);
                                pfh = (pf.qReturn as { qHandle: number }).qHandle;
                            } catch { pfh = -1; }
                            if (codes.length) {
                                const gf = await rpc("GetField", { qFieldName: "Article Code" }, doc);
                                fh = (gf.qReturn as { qHandle: number }).qHandle;
                            }

                            // Résoudre les master measures par TITRE (le qLibraryId fiable = qInfo.qId, ≠ GUID QRS).
                            const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
                            const ml = await rpc("CreateSessionObject", { qProp: { qInfo: { qType: "MeasureList" }, qMeasureListDef: { qType: "measure", qData: { title: "/qMetaDef/title", expr: "/qMeasure/qDef" } } } }, doc);
                            const mll = await rpc("GetLayout", {}, (ml.qReturn as { qHandle: number }).qHandle);
                            const items = (((mll.qLayout as { qMeasureList?: { qItems?: Array<{ qInfo: { qId: string }; qMeta?: { title?: string }; qData?: { title?: string; expr?: string } }> } }).qMeasureList?.qItems) ?? []);
                            const byTitle = new Map<string, string>();
                            for (const it of items) { const t = it.qMeta?.title ?? it.qData?.title ?? ""; if (t) byTitle.set(norm(t), it.qInfo.qId); }
                            const pickMeasure = (title: string, fallback: string) => byTitle.get(norm(title)) ?? fallback;
                            const rCamag = pickMeasure("CA par Magasin N", mcamag);
                            const rMarge = pickMeasure("Marge % N", mmarge);
                            // Résolution par TITRE aussi pour CA / Quantité / Nb magasins : évite tout
                            // décalage si un qId d'env ne pointe pas sur la mesure attendue.
                            const rCa = pickMeasure("CA N", mca);
                            const rQte = pickMeasure("Quantité N", mqte);
                            const rNbMag = pickMeasure("Magasin Ventes Nb N", mnb);
                            console.log("[qlik-pw] mesures utilisées: " + JSON.stringify({
                                "CA N": rCa, "Quantité N": rQte, "Magasin Ventes Nb N": rNbMag,
                                "CA par Magasin N": rCamag, "Marge % N": rMarge,
                                env: { mca, mqte, mnb },
                            }));
                            console.log("measures résolues par titre: " + JSON.stringify({ rCamag, rMarge }) + " (sur " + items.length + " mesures)");
                            // DUMP diagnostic : inventaire des mesures + dimensions (titre + id) pour
                            // identifier une mesure "Quantité" NON annuelle et/ou une dimension "Mois/Période"
                            // permettant un vrai découpage mensuel du réseau.
                            // L'EXPRESSION est indispensable au diagnostic : c'est elle qui dit
                            // si la mesure est bornée à une année (et comment), donc pourquoi des
                            // mois de la fenêtre glissante peuvent ressortir vides.
                            console.log("[qlik-pw][dump] MESURES (" + items.length + "): " + JSON.stringify(items.map((it) => ({ t: it.qMeta?.title ?? it.qData?.title ?? "", id: it.qInfo.qId }))));
                            for (const it of items) {
                                const titre = it.qMeta?.title ?? it.qData?.title ?? "";
                                if (/^(CA N|Quantité N|Magasin Ventes Nb N|CA par Magasin N|Marge % N|Quantité COMP)$/i.test(titre.trim())) {
                                    console.log("[qlik-pw][dump] expression « " + titre + " » = " + (it.qData?.expr ?? "?"));
                                }
                            }
                            try {
                                const dl = await rpc("CreateSessionObject", { qProp: { qInfo: { qType: "DimensionList" }, qDimensionListDef: { qType: "dimension", qData: { title: "/qMetaDef/title" } } } }, doc);
                                const dll = await rpc("GetLayout", {}, (dl.qReturn as { qHandle: number }).qHandle);
                                const ditems = (((dll.qLayout as { qDimensionList?: { qItems?: Array<{ qInfo: { qId: string }; qMeta?: { title?: string }; qData?: { title?: string } }> } }).qDimensionList?.qItems) ?? []);
                                console.log("[qlik-pw][dump] DIMENSIONS (" + ditems.length + "): " + JSON.stringify(ditems.map((it) => ({ t: it.qMeta?.title ?? it.qData?.title ?? "", id: it.qInfo.qId }))));
                            } catch (e) { console.log("[qlik-pw][dump] DimensionList error: " + String((e as Error)?.message || e)); }
                            // L'hypercube session object est désormais créé JETABLE dans fetchCubeForSelection
                            // (un objet par lot) puis DestroySessionObject — corrige "Request aborted" (code 15)
                            // causé par la réutilisation du même objet sur des centaines de recalculs.

                            // (déclaré au niveau de l'IIFE — voir plus haut)
                            // (monthlyByCode est déclaré au niveau de l'IIFE — voir plus haut)
                            const accMonthly = (batchRows: Array<Array<string | number>>, monthLabel: string) => {
                                for (const r of batchRows) {
                                    const c = String(r[0] ?? "").trim();
                                    if (!c || c === "-") continue;
                                    const q = Number(r[2]) || 0;
                                    (monthlyByCode[c] ??= {});
                                    const cur = monthlyByCode[c][monthLabel];
                                    monthlyByCode[c][monthLabel] = {
                                        qte: (cur?.qte ?? 0) + q,
                                        ca: (cur?.ca ?? 0) + (Number(r[1]) || 0),
                                        nbMag: Math.max(cur?.nbMag ?? 0, Number(r[3]) || 0),
                                        caMag: Number(r[4]) || 0,
                                        margePct: Number(r[5]) || 0,
                                    };
                                }
                            };
                            // Compteurs agrégés pour le résumé timing final (loggué côté Node après la sync).
                            let aggMonths = 0;
                            let aggBatches = 0;
                            let aggCode15Retries = 0;
                            let aggFallbackCount = 0;

                            // Sélectionne Date + Article Code puis pagine le cube. Renvoie le nb de lignes
                            // brutes lues (avant dédoublonnage côté Node).
                            //
                            // IMPORTANT : crée un hypercube session object JETABLE par lot (Date + Article Code
                            // déjà sélectionnés) puis le détruit. Réutiliser le même objet sur des centaines de
                            // lots force Qlik à recalculer en boucle et finit par "Request aborted" (code 15).
                            const PAGE = 1400;
                            // Petite latence après chaque mutation de sélection : laisser l'Engine
                            // finaliser l'évaluation de la sélection avant la prochaine requête layout/cube.
                            const createCubeForBatch = async (timings?: Record<string, number>, onCode15Retry?: () => void): Promise<{ handle: number; id: string }> => {
                                const { value: obj } = await timed("createCube", "CreateSessionObject", () => rpcWithRetry("createCube", "CreateSessionObject", { qProp: { qInfo: { qType: "cf-net" }, qHyperCubeDef: {
                                    qDimensions: [{ qLibraryId: dim }],
                                    qMeasures: [{ qLibraryId: rCa }, { qLibraryId: rQte }, { qLibraryId: rNbMag }, { qLibraryId: rCamag }, { qLibraryId: rMarge }],
                                    qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 6, qHeight: PAGE }],
                                } } }, doc, onCode15Retry), timings);
                                const qReturn = obj.qReturn as { qHandle: number; qGenericId?: string; qId?: string };
                                return { handle: qReturn.qHandle, id: String(qReturn.qGenericId ?? qReturn.qId ?? "") };
                            };
                            const destroyCube = async (cube: { handle: number; id: string }, timings?: Record<string, number>) => {
                                if (!cube.id) return;
                                try {
                                    await timed("destroyCube", "DestroySessionObject", () => rpcWithRetry("destroyCube", "DestroySessionObject", { qId: cube.id }, doc), timings);
                                } catch (e) {
                                    // Non fatal : l'objet est de toute façon scopé à la session websocket.
                                    // Un code 15 ici signifie que l'Engine l'a déjà libéré après un abort.
                                    console.log("[qlik-pw] DestroySessionObject ignoré: " + String((e as Error)?.message || e));
                                }
                            };
                            const appendMatrix = (matrix: Array<Array<{ qText?: string; qNum?: number }>>, sink: Array<Array<string | number>>): number => {
                                for (const r of matrix) sink.push([
                                    String(r[0]?.qText ?? ""),
                                    Number(r[1]?.qNum) || 0,
                                    Number(r[2]?.qNum) || 0,
                                    Number(r[3]?.qNum) || 0,
                                    Number(r[4]?.qNum) || 0,
                                    Number(r[5]?.qNum) || 0,
                                ]);
                                return matrix.length;
                            };
                            const fetchCubeForSelection = async (sink: Array<Array<string | number>>, timings?: Record<string, number>, onCode15Retry?: () => void): Promise<number> => {
                                const cube = await createCubeForBatch(timings, onCode15Retry);
                                const oh = cube.handle;
                                try {
                                    const { value: layout } = await timed("layout", "GetLayout", () => rpcWithRetry("layout", "GetLayout", {}, oh, onCode15Retry), timings);
                                    const hyperCube = (layout.qLayout as { qHyperCube: { qSize: { qcy: number }; qDataPages?: Array<{ qArea?: { qTop?: number }; qMatrix?: Array<Array<{ qText?: string; qNum?: number }>> }> } }).qHyperCube;
                                    const size = hyperCube.qSize.qcy;
                                    const firstPage = hyperCube.qDataPages?.find((page) => (page.qArea?.qTop ?? 0) === 0);
                                    let got = 0;
                                    let top = 0;
                                    if (firstPage?.qMatrix?.length) {
                                        got += appendMatrix(firstPage.qMatrix, sink);
                                        top = PAGE;
                                    }
                                    for (; top < size; top += PAGE) {
                                        const { value: d } = await timed("getCubeData", "GetHyperCubeData", () => rpcWithRetry("getCubeData", "GetHyperCubeData", { qPath: "/qHyperCubeDef", qPages: [{ qTop: top, qLeft: 0, qWidth: 6, qHeight: PAGE }] }, oh, onCode15Retry), timings);
                                        const matrix = (d.qDataPages as Array<{ qMatrix?: Array<Array<{ qText?: string; qNum?: number }>> }>)?.[0]?.qMatrix ?? [];
                                        if (!matrix.length) break;
                                        got += appendMatrix(matrix, sink);
                                        if (matrix.length < PAGE) break;
                                    }
                                    return got;
                                } finally {
                                    await destroyCube(cube, timings);
                                }
                            };

                            // ─── Découpage mensuel réel via dimension "Mois" ────────────────────
                            // Cube [Article Code, Mois] × 5 mesures. Chaque ligne = (code, mois, ca,
                            // qte, nbMag, caMag, marge). Le "Mois" est au format "YYYYMM" → "YYYY-MM".
                            const normMois = (m: string): string => (/^\d{6}$/.test(m) ? m.slice(0, 4) + "-" + m.slice(4) : m);
                            const PAGEM = 1200; // 8 colonnes × 1200 = 9600 cellules < 10000 (limite Qlik)
                            const fetchMonthCube = async (
                                onRow: (code: string, mois: string, ca: number, qte: number, nbMag: number, caMag: number, marge: number, qteComp: number) => void,
                                timings?: Record<string, number>,
                                onCode15Retry?: () => void,
                            ): Promise<number> => {
                                const { value: obj } = await timed("createCube", "CreateSessionObject", () => rpcWithRetry("createCube", "CreateSessionObject", { qProp: { qInfo: { qType: "cf-net-mois" }, qHyperCubeDef: {
                                    qDimensions: [{ qLibraryId: dim }, { qLibraryId: moisDimId }],
                                    qMeasures: [{ qLibraryId: rCa }, { qLibraryId: rQte }, { qLibraryId: rNbMag }, { qLibraryId: rCamag }, { qLibraryId: rMarge }, { qLibraryId: mqteComp }],
                                    qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 8, qHeight: PAGEM }],
                                } } }, doc, onCode15Retry), timings);
                                const qReturn = obj.qReturn as { qHandle: number; qGenericId?: string; qId?: string };
                                const cube = { handle: qReturn.qHandle, id: String(qReturn.qGenericId ?? qReturn.qId ?? "") };
                                const oh = cube.handle;
                                const process = (matrix: Array<Array<{ qText?: string; qNum?: number }>>): number => {
                                    for (const r of matrix) {
                                        onRow(
                                            String(r[0]?.qText ?? ""), String(r[1]?.qText ?? ""),
                                            Number(r[2]?.qNum) || 0, Number(r[3]?.qNum) || 0, Number(r[4]?.qNum) || 0,
                                            Number(r[5]?.qNum) || 0, Number(r[6]?.qNum) || 0, Number(r[7]?.qNum) || 0,
                                        );
                                    }
                                    return matrix.length;
                                };
                                try {
                                    const { value: layout } = await timed("layout", "GetLayout", () => rpcWithRetry("layout", "GetLayout", {}, oh, onCode15Retry), timings);
                                    const hc = (layout.qLayout as { qHyperCube: { qSize: { qcy: number }; qDataPages?: Array<{ qArea?: { qTop?: number }; qMatrix?: Array<Array<{ qText?: string; qNum?: number }>> }> } }).qHyperCube;
                                    const size = hc.qSize.qcy;
                                    let got = 0, top = 0;
                                    const firstPage = hc.qDataPages?.find((p) => (p.qArea?.qTop ?? 0) === 0);
                                    if (firstPage?.qMatrix?.length) { got += process(firstPage.qMatrix); top = PAGEM; }
                                    for (; top < size; top += PAGEM) {
                                        const { value: d } = await timed("getCubeData", "GetHyperCubeData", () => rpcWithRetry("getCubeData", "GetHyperCubeData", { qPath: "/qHyperCubeDef", qPages: [{ qTop: top, qLeft: 0, qWidth: 8, qHeight: PAGEM }] }, oh, onCode15Retry), timings);
                                        const matrix = (d.qDataPages as Array<{ qMatrix?: Array<Array<{ qText?: string; qNum?: number }>> }>)?.[0]?.qMatrix ?? [];
                                        if (!matrix.length) break;
                                        got += process(matrix);
                                        if (matrix.length < PAGEM) break;
                                    }
                                    return got;
                                } finally {
                                    await destroyCube(cube, timings);
                                }
                            };

                            // ─── Cube mensuel par EXPRESSIONS (respecte la sélection Date) ─────
                            //
                            // Constat de production : les master measures « CA N » / « Quantité N »
                            // **ignorent la sélection Date**. Vérifié arithmétiquement : avec août
                            // 2025 seul sélectionné, le cube renvoyait 164 unités / 2 220,75 € —
                            // soit exactement la somme de janvier à juillet 2026. Ce sont des
                            // mesures « cumul année en cours », pas des mesures de période.
                            //
                            // Conséquences : les totaux réseau étaient un cumul année en cours
                            // (mois courant partiel inclus) et non 12 mois glissants, les mois de
                            // l'année précédente non couverts par « Quantité COMP » restaient
                            // vides, et la passe de rattrapage y recopiait le total de période.
                            //
                            // Aucune sélection ne peut corriger cela : on agrège donc directement
                            // les champs de faits, qui eux respectent les sélections.
                            const PAGEX = 1200; // 7 colonnes × 1200 = 8400 cellules < 10000
                            const fetchMonthCubeExpr = async (
                                eCa: string,
                                eQte: string,
                                eNbMag: string,
                                eMarge: string,
                                onRow: (code: string, mois: string, ca: number, qte: number, nbMag: number, marge: number, qteMaster: number) => void,
                                timings?: Record<string, number>,
                                onCode15Retry?: () => void,
                                /**
                                 * Inclure la master « Quantité N » (colonne de calibrage) ?
                                 *
                                 * ⚠️ Elle ne coûte rien quand elle vit, mais **annule tout le cube**
                                 * quand elle est morte : mesuré en production, 4 expressions valides
                                 * à 6 mois chacune et le cube complet à **0 ligne** après 25 s de
                                 * calcul. L'appelant ne l'ajoute donc qu'après l'avoir sondée.
                                 */
                                avecMaster = true,
                            ): Promise<number> => {
                                const largeur = avecMaster ? 7 : 6;
                                const { value: obj } = await timed("createCubeExpr", "CreateSessionObject", () => rpcWithRetry("createCubeExpr", "CreateSessionObject", { qProp: { qInfo: { qType: "cf-net-mois-expr" }, qHyperCubeDef: {
                                    qDimensions: [{ qLibraryId: dim }, { qLibraryId: moisDimId }],
                                    qMeasures: [
                                        { qDef: { qDef: eCa } },
                                        { qDef: { qDef: eQte } },
                                        { qDef: { qDef: eNbMag } },
                                        { qDef: { qDef: eMarge } },
                                        // Master « Quantité N », uniquement pour le calibrage : sur les
                                        // mois de l'année en cours les deux doivent coïncider.
                                        ...(avecMaster ? [{ qLibraryId: rQte }] : []),
                                    ],
                                    qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: largeur, qHeight: PAGEX }],
                                } } }, doc, onCode15Retry), timings);
                                const qReturn = obj.qReturn as { qHandle: number; qGenericId?: string; qId?: string };
                                const cube = { handle: qReturn.qHandle, id: String(qReturn.qGenericId ?? qReturn.qId ?? "") };
                                const oh = cube.handle;
                                const process = (matrix: Array<Array<{ qText?: string; qNum?: number }>>): number => {
                                    for (const r of matrix) {
                                        onRow(
                                            String(r[0]?.qText ?? ""), String(r[1]?.qText ?? ""),
                                            Number(r[2]?.qNum) || 0, Number(r[3]?.qNum) || 0,
                                            Number(r[4]?.qNum) || 0, Number(r[5]?.qNum) || 0,
                                            avecMaster ? Number(r[6]?.qNum) || 0 : 0,
                                        );
                                    }
                                    return matrix.length;
                                };
                                try {
                                    const { value: layout } = await timed("layout", "GetLayout", () => rpcWithRetry("layout", "GetLayout", {}, oh, onCode15Retry), timings);
                                    const hc = (layout.qLayout as { qHyperCube: { qSize: { qcy: number }; qDataPages?: Array<{ qArea?: { qTop?: number }; qMatrix?: Array<Array<{ qText?: string; qNum?: number }>> }> } }).qHyperCube;
                                    const size = hc.qSize.qcy;
                                    let got = 0, top = 0;
                                    const firstPage = hc.qDataPages?.find((pg) => (pg.qArea?.qTop ?? 0) === 0);
                                    if (firstPage?.qMatrix?.length) { got += process(firstPage.qMatrix); top = PAGEX; }
                                    for (; top < size; top += PAGEX) {
                                        const { value: d } = await timed("getCubeData", "GetHyperCubeData", () => rpcWithRetry("getCubeData", "GetHyperCubeData", { qPath: "/qHyperCubeDef", qPages: [{ qTop: top, qLeft: 0, qWidth: largeur, qHeight: PAGEX }] }, oh, onCode15Retry), timings);
                                        const matrix = (d.qDataPages as Array<{ qMatrix?: Array<Array<{ qText?: string; qNum?: number }>> }>)?.[0]?.qMatrix ?? [];
                                        if (!matrix.length) break;
                                        got += process(matrix);
                                        if (matrix.length < PAGEX) break;
                                    }
                                    return got;
                                } finally {
                                    await destroyCube(cube, timings);
                                }
                            };

                            /**
                             * Passe unique par expressions : sélectionne la fenêtre 12 mois et tous
                             * les codes, puis lit un seul cube [Article Code, Mois].
                             *
                             * Renvoie false si le résultat est inexploitable (expression invalide,
                             * champ absent) — l'appelant repart alors sur les master measures.
                             */
                            /**
                             * Total de contrôle : un cube 1 cellule, sans dimension, sur
                             * l'expression quantité. Sert à savoir si une sélection de dates
                             * FILTRE réellement les faits — ce que les master measures, qui
                             * l'ignorent, ne permettaient pas de vérifier.
                             */
                            const totalDeControle = async (): Promise<number> => {
                                const o = await rpc("CreateSessionObject", { qProp: {
                                    qInfo: { qType: "cf-ctrl" },
                                    qHyperCubeDef: {
                                        qDimensions: [],
                                        qMeasures: [{ qDef: { qDef: exprQte } }],
                                        qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 1, qHeight: 1 }],
                                    },
                                } }, doc);
                                const ret = o.qReturn as { qHandle: number; qGenericId?: string; qId?: string };
                                try {
                                    const lay = await rpc("GetLayout", {}, ret.qHandle);
                                    const cell = (lay.qLayout as { qHyperCube?: { qDataPages?: Array<{ qMatrix?: Array<Array<{ qNum?: number; qText?: string }>> }> } })
                                        .qHyperCube?.qDataPages?.[0]?.qMatrix?.[0]?.[0];
                                    return Number(cell?.qNum) || 0;
                                } finally {
                                    const id = String(ret.qGenericId ?? ret.qId ?? "");
                                    if (id) { try { await rpc("DestroySessionObject", { qId: id }, doc); } catch { /* noop */ } }
                                }
                            };

                            /**
                             * Sélectionne la fenêtre sur un champ date candidat.
                             *
                             * Renvoie le handle pour que l'appelant puisse impérativement
                             * effacer une sélection rejetée avant d'essayer le candidat
                             * suivant. Sans ce Clear, un premier champ qui ne matche aucune
                             * date maintient l'ensemble courant à zéro et condamne tous les
                             * essais suivants à renvoyer zéro eux aussi.
                             */
                            const selectionnerFenetreSur = async (champ: string, valeurs: number[]): Promise<number | null> => {
                                let h: number;
                                try {
                                    const gf = await rpc("GetField", { qFieldName: champ }, doc);
                                    h = (gf.qReturn as { qHandle: number }).qHandle;
                                    if (typeof h !== "number" || h < 0) return null;
                                } catch { return null; }
                                await rpc("Clear", {}, h);
                                await sleep(qlikSettleMs);
                                for (let i = 0; i < valeurs.length; i += 500) {
                                    await rpc("SelectValues", {
                                        qFieldValues: valeurs.slice(i, i + 500).map((v) => ({ qNum: v, qText: String(v) })),
                                        qToggleMode: i > 0,
                                        qSoftLock: true,
                                    }, h);
                                }
                                await sleep(qlikSettleMs);
                                return h;
                            };

                            /**
                             * Sélectionne les 12 mois via la dimension maître « Mois ».
                             *
                             * Dans l'app Magasins Vision Consolidée, les champs Date exposés
                             * existent mais sont dissociés des faits de vente : leur sélection
                             * laisse Sum(quantite) à 100 %. La dimension maître utilisée par le
                             * cube, elle, porte les vraies valeurs associées. Un list object
                             * permet de sélectionner ses qElemNumber sans connaître le nom du
                             * champ sous-jacent ni le format dual exact.
                             */
                            const selectionnerFenetreViaDimensionMois = async (
                                moisAttendus: Set<string>,
                            ): Promise<{ total: number; trouves: string[] } | null> => {
                                let objet: { handle: number; id: string } | null = null;
                                try {
                                    const cree = await rpcWithRetry("createMonthList", "CreateSessionObject", {
                                        qProp: {
                                            qInfo: { qType: "cf-month-list" },
                                            qListObjectDef: {
                                                qLibraryId: moisDimId,
                                                qShowAlternatives: true,
                                                qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 1, qHeight: 100 }],
                                            },
                                        },
                                    }, doc);
                                    const ret = cree.qReturn as { qHandle: number; qGenericId?: string; qId?: string };
                                    objet = {
                                        handle: ret.qHandle,
                                        id: String(ret.qGenericId ?? ret.qId ?? ""),
                                    };

                                    const layout = await rpcWithRetry("layoutMonthList", "GetLayout", {}, objet.handle);
                                    const lo = (layout.qLayout as {
                                        qListObject?: {
                                            qSize?: { qcy?: number };
                                            qDataPages?: Array<{
                                                qArea?: { qTop?: number };
                                                qMatrix?: Array<Array<{ qText?: string; qElemNumber?: number }>>;
                                            }>;
                                        };
                                    }).qListObject;
                                    const size = Number(lo?.qSize?.qcy) || 0;
                                    const cellules: Array<{ qText?: string; qElemNumber?: number }> = [];
                                    for (const page of lo?.qDataPages ?? []) {
                                        for (const row of page.qMatrix ?? []) if (row[0]) cellules.push(row[0]);
                                    }
                                    for (let top = cellules.length; top < size; top += 500) {
                                        const data = await rpcWithRetry("monthListData", "GetListObjectData", {
                                            qPath: "/qListObjectDef",
                                            qPages: [{ qTop: top, qLeft: 0, qWidth: 1, qHeight: Math.min(500, size - top) }],
                                        }, objet.handle);
                                        const matrix = (data.qDataPages as Array<{
                                            qMatrix?: Array<Array<{ qText?: string; qElemNumber?: number }>>;
                                        }>)?.[0]?.qMatrix ?? [];
                                        for (const row of matrix) if (row[0]) cellules.push(row[0]);
                                        if (matrix.length === 0) break;
                                    }

                                    const parMois = new Map<string, number>();
                                    for (const cellule of cellules) {
                                        const mois = normMois(String(cellule.qText ?? "").trim());
                                        const elem = Number(cellule.qElemNumber);
                                        if (moisAttendus.has(mois) && Number.isInteger(elem) && elem >= 0) {
                                            parMois.set(mois, elem);
                                        }
                                    }
                                    const trouves = [...parMois.keys()].sort();
                                    console.log(
                                        "[qlik-pw][expr] dimension Mois : " + trouves.length + "/" + moisAttendus.size +
                                        " valeurs trouvées " + JSON.stringify(trouves),
                                    );
                                    if (trouves.length !== moisAttendus.size) return null;

                                    const selection = await rpcWithRetry("selectMonthList", "SelectListObjectValues", {
                                        qPath: "/qListObjectDef",
                                        qValues: [...parMois.values()],
                                        qToggleMode: false,
                                        qSoftLock: true,
                                    }, objet.handle);
                                    console.log("[qlik-pw][expr] sélection dimension Mois → " + JSON.stringify(selection.qReturn));
                                    await sleep(qlikSettleMs);
                                    const total = await totalDeControle();
                                    return { total, trouves };
                                } catch (e) {
                                    console.log("[qlik-pw][expr] sélection dimension Mois impossible : " + String((e as Error)?.message || e));
                                    return null;
                                } finally {
                                    if (objet?.id) {
                                        try {
                                            await rpc("DestroySessionObject", { qId: objet.id }, doc);
                                        } catch { /* objet limité à la session */ }
                                    }
                                }
                            };

                            /**
                             * Cale le champ `Période` du modèle sur la fenêtre 12 mois glissants.
                             *
                             * L'app n'est pas un modèle « faits + calendrier » classique : TOUTES
                             * ses mesures sont bornées par un type de calendrier —
                             *
                             *   « Quantité N »    = Sum({<Type_Cal={'N'}>} quantite)
                             *   « Quantité COMP » = Sum({<Type_Cal={'$(vPeriod_comp)'}…>} quantite)
                             *
                             * `Type_Cal` marque les lignes de la période analysée (`N`) et celles
                             * de la période de comparaison (`COMP`), et c'est le champ `Période`
                             * (4 valeurs, une sélectionnée) qui décide de quelle période il s'agit.
                             *
                             * Cela explique tout ce qu'on observait :
                             *  - sélectionner `Date` ne change RIEN (le périmètre vient du pont de
                             *    périodes, pas du champ date) — mesuré : 100 % du total avant comme
                             *    après ;
                             *  - « Quantité N » ne renvoie que les mois de la période courante
                             *    (janvier→juillet avec « année en cours »), d'où août→décembre
                             *    vides ;
                             *  - « Quantité COMP » ne couvre que les mois ayant un comparable dans
                             *    cette période, d'où janvier→juillet de l'année précédente ;
                             *  - `Sum(quantite)` brut mélange les lignes N et COMP : il double
                             *    compte, et ne peut pas se substituer aux mesures.
                             *
                             * La solution n'est donc pas de contourner le modèle mais de le
                             * piloter : on essaie chaque valeur de `Période`, on mesure combien de
                             * mois de la fenêtre elle rend réellement disponibles, et on garde la
                             * meilleure. Aucun libellé n'est deviné — c'est la couverture mesurée
                             * qui décide.
                             */
                            /**
                             * Vrai quand le périmètre articles est posé par une sélection
                             * fournisseur : dans ce cas, plus aucun `SelectValues` sur
                             * « Article Code » n'est émis (ni par passe annuelle, ni par
                             * l'agrégation directe) — c'est tout l'intérêt de la bascule.
                             */
                            let parFournisseur = false;

                            /**
                             * Sélectionne LE fournisseur plutôt que ses dizaines de milliers de
                             * codes articles.
                             *
                             * `SelectValues` sur « Article Code » coûte 8 à 100 s **par appel**,
                             * quasi indépendamment du nombre de valeurs — le moteur balaie un
                             * symbole de plus d'un million d'entrées — et il faut le refaire à
                             * chaque passe annuelle. Une valeur de fournisseur produit le même
                             * périmètre en un appel trivial.
                             *
                             * La bascule n'est retenue QUE si la sélection couvre les codes
                             * demandés : un article rattaché à plusieurs fournisseurs, ou un
                             * référencement Qlik différent du référencement FF, doit faire
                             * revenir à la sélection par codes plutôt que perdre des articles.
                             */
                            const selectionnerParFournisseur = async (): Promise<boolean> => {
                                if (!fournisseurCode || codes.length === 0) return false;
                                const attendus = new Set(codes.map((c) => c.trim()));
                                /**
                                 * Au-delà de ce nombre de codes visibles, la sélection fournisseur
                                 * ne restreint rien (elle laisse tout le catalogue) : inutile de
                                 * finir la lecture, la réponse est déjà connue.
                                 */
                                const plafond = attendus.size * 3;

                                /** Codes articles visibles sous la sélection courante. */
                                const lireCodesVisibles = async (): Promise<Set<string>> => {
                                    const vus = new Set<string>();
                                    const o = await rpc("CreateSessionObject", { qProp: {
                                        qInfo: { qType: "cf-codes-fou" },
                                        qHyperCubeDef: {
                                            qDimensions: [{ qLibraryId: dim, qNullSuppression: true }],
                                            qMeasures: [],
                                            qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 1, qHeight: 5000 }],
                                        },
                                    } }, doc);
                                    const ret = o.qReturn as { qHandle: number; qGenericId?: string; qId?: string };
                                    try {
                                        const lay = await rpc("GetLayout", {}, ret.qHandle);
                                        const hc = (lay.qLayout as { qHyperCube?: { qSize?: { qcy?: number }; qDataPages?: Array<{ qMatrix?: Array<Array<{ qText?: string }>> }> } }).qHyperCube;
                                        const total = Number(hc?.qSize?.qcy) || 0;
                                        for (const r of hc?.qDataPages?.[0]?.qMatrix ?? []) {
                                            const c = String(r[0]?.qText ?? "").trim();
                                            if (c && c !== "-") vus.add(c);
                                        }
                                        for (let top = vus.size ? 5000 : 0; top < total; top += 5000) {
                                            const d = await rpc("GetHyperCubeData", {
                                                qPath: "/qHyperCubeDef",
                                                qPages: [{ qTop: top, qLeft: 0, qWidth: 1, qHeight: Math.min(5000, total - top) }],
                                            }, ret.qHandle);
                                            const matrix = (d.qDataPages as Array<{ qMatrix?: Array<Array<{ qText?: string }>> }>)?.[0]?.qMatrix ?? [];
                                            if (matrix.length === 0) break;
                                            for (const r of matrix) {
                                                const c = String(r[0]?.qText ?? "").trim();
                                                if (c && c !== "-") vus.add(c);
                                            }
                                            // Inutile de lire tout le catalogue pour conclure : au-delà
                                            // du plafond, la sélection ne restreint manifestement rien.
                                            // Mesuré : 1 207 205 codes lus en 240 pages, ×3 champs =
                                            // 87 s perdues avant un rejet joué d'avance.
                                            if (vus.size > plafond) break;
                                        }
                                        return vus;
                                    } finally {
                                        const id = String(ret.qGenericId ?? ret.qId ?? "");
                                        if (id) { try { await rpc("DestroySessionObject", { qId: id }, doc); } catch { /* noop */ } }
                                    }
                                };

                                for (const champ of champsFournisseurCandidats) {
                                    let h = -1;
                                    try {
                                        const gf = await rpc("GetField", { qFieldName: champ }, doc);
                                        h = (gf.qReturn as { qHandle: number }).qHandle;
                                        if (typeof h !== "number" || h < 0) continue;
                                    } catch { continue; }

                                    await rpc("Clear", {}, h);
                                    await sleep(qlikSettleMs);
                                    const sel = await rpc("SelectValues", {
                                        qFieldValues: [{ qText: fournisseurCode }],
                                        qToggleMode: false,
                                        qSoftLock: true,
                                    }, h);
                                    await sleep(qlikSettleMs);
                                    if (sel.qReturn === false) {
                                        diag("  champ « " + champ + " » : valeur « " + fournisseurCode + " » inconnue");
                                        await rpc("Clear", {}, h);
                                        continue;
                                    }

                                    const visibles = await lireCodesVisibles();
                                    // Un vrai périmètre fournisseur est de l'ordre de grandeur des
                                    // codes demandés. Mesuré en production : « J009 » laissait
                                    // 1 207 205 articles visibles, soit tout le catalogue — la
                                    // sélection n'avait rien restreint, et la « couverture » de 97 %
                                    // ne faisait que constater que le catalogue contient nos codes.
                                    if (visibles.size > plafond) {
                                        diag(
                                            "  champ « " + champ + " » = « " + fournisseurCode + " » → plus de " + plafond +
                                            " articles visibles pour " + attendus.size + " demandés : la sélection ne restreint rien, ignorée",
                                        );
                                        await rpc("Clear", {}, h);
                                        await sleep(qlikSettleMs);
                                        continue;
                                    }
                                    let couverts = 0;
                                    for (const c of attendus) if (visibles.has(c)) couverts++;
                                    const couverture = attendus.size > 0 ? couverts / attendus.size : 0;
                                    diag(
                                        "  champ « " + champ + " » = « " + fournisseurCode + " » → " + visibles.size +
                                        " articles Qlik, couvre " + couverts + "/" + attendus.size +
                                        " codes demandés (" + Math.round(couverture * 100) + "%)",
                                    );
                                    if (couverture >= couvertureFournisseurMin) {
                                        diag("sélection PAR FOURNISSEUR retenue sur « " + champ + " » — " + attendus.size + " SelectValues économisés par passe");
                                        return true;
                                    }
                                    await rpc("Clear", {}, h);
                                    await sleep(qlikSettleMs);
                                }
                                diag("aucun champ fournisseur ne couvre les codes demandés → sélection par codes articles");
                                return false;
                            };

                            /** Valeur de `Période` à poser avant la passe d'une année donnée. */
                            const periodeParAnnee = new Map<number, { texte: string | null }>();

                            /**
                             * Pose (ou efface, si `texte` est nul) la sélection `Période`.
                             *
                             * Passe par le HANDLE DU CHAMP, comme pour `Année` et `Date` : c'est la
                             * seule API qui expose `Clear` et `SelectValues`. Ne propage jamais
                             * d'erreur — une `Période` qu'on n'arrive pas à poser doit dégrader le
                             * résultat, pas interrompre l'extraction (leçon de production : un
                             * `Clear` en échec a fait avorter deux chemins entiers).
                             */
                            const appliquerPeriode = async (texte: string | null): Promise<boolean> => {
                                if (pfh === -1) return texte == null;
                                try {
                                    await rpc("Clear", {}, pfh);
                                    await sleep(qlikSettleMs);
                                    if (texte == null) return true;
                                    const sel = await rpc("SelectValues", {
                                        qFieldValues: [{ qText: texte }],
                                        qToggleMode: false,
                                        qSoftLock: true,
                                    }, pfh);
                                    await sleep(qlikSettleMs);
                                    return sel.qReturn !== false;
                                } catch (e) {
                                    diag("  sélection Période « " + (texte ?? "(aucune)") + " » impossible : " + String((e as Error)?.message || e));
                                    return false;
                                }
                            };

                            /**
                             * Choisit la valeur de `Période` sous laquelle l'extraction aura lieu.
                             *
                             * CE QUE DIT LA MESURE (production, 2026-08-01, sonde paginée) :
                             *
                             *     Période « (aucune) » → master exposée : 2024-01…2026-07 (31 mois)
                             *
                             * Sans aucune `Période` sélectionnée, « Quantité N » couvre **31 mois**,
                             * et une seule passe (`Année=2026`) sert les 12 mois de la fenêtre.
                             * L'état libre est donc le bon — encore fallait-il pouvoir le voir.
                             *
                             * Deux erreurs successives l'avaient masqué, toutes deux dans l'outil
                             * de mesure et non dans le modèle Qlik :
                             *  1. la sonde ne lisait que les 60 premières lignes du cube `[Mois]`,
                             *     donc jamais les mois récents → « 0/12 » pour toute valeur ;
                             *  2. `Clear` était appelée sur le list object au lieu du champ, ce qui
                             *     faisait avorter la cartographie entière avant son premier essai.
                             *
                             * D'où le principe retenu ici : **ne rien présumer, tout mesurer**. La
                             * couverture est évaluée par année et dans le contexte exact où elle
                             * sera exploitée (`monthDimPath` pose la même valeur), l'état sans
                             * `Période` étant un candidat comme un autre — et, en l'occurrence, le
                             * gagnant.
                             */
                            const choisirPeriode = async (annees: number[]): Promise<number> => {
                                const fenetre = new Set(monthlyPayload.map((m) => m.label));
                                let lo: { qHandle: number; qGenericId?: string; qId?: string } | null = null;
                                try {
                                    const obj = await rpc("CreateSessionObject", { qProp: {
                                        qInfo: { qType: "cf-periodes" },
                                        qListObjectDef: {
                                            qDef: { qFieldDefs: ["Période"] },
                                            qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 1, qHeight: 50 }],
                                        },
                                    } }, doc);
                                    lo = obj.qReturn as { qHandle: number; qGenericId?: string; qId?: string };
                                    const lay = await rpc("GetLayout", {}, lo.qHandle);
                                    const matrix = ((lay.qLayout as { qListObject?: { qDataPages?: Array<{ qMatrix?: Array<Array<{ qText?: string; qElemNumber?: number }>> }> } })
                                        .qListObject?.qDataPages?.[0]?.qMatrix) ?? [];
                                    const valeurs = matrix
                                        .map((r) => ({ texte: String(r[0]?.qText ?? ""), elem: r[0]?.qElemNumber ?? -1 }))
                                        .filter((v) => v.texte && v.elem >= 0);
                                    diag("valeurs de « Période » : " + JSON.stringify(valeurs.map((v) => v.texte)));
                                    if (valeurs.length === 0) return 0;

                                    /**
                                     * Couverture réelle : quels mois « Quantité N » rend-elle vivants ?
                                     *
                                     * ⚠️ Le cube est PAGINÉ intégralement. La version précédente ne
                                     * lisait que les 60 premières lignes : la dimension Mois porte
                                     * tout l'historique de l'app, les mois récents tombaient hors
                                     * de la première page, et la sonde annonçait 0/12 quelle que
                                     * soit la `Période` — alors que la master vivait (mesuré :
                                     * total 9 721 153). C'est ce faux zéro qui faisait effacer
                                     * `Période` et condamnait toute l'extraction.
                                     *
                                     * Renvoie les mois vivants DE LA FENÊTRE, et journalise aussi
                                     * ce que la dimension expose hors fenêtre : sans cela on ne
                                     * distingue pas « le modèle ne donne rien » de « le modèle
                                     * donne autre chose que ce qu'on attend ».
                                     */
                                    const mesurerCouverture = async (): Promise<{ fenetre: string[]; tous: string[] }> => {
                                        const sonde = await rpc("CreateSessionObject", { qProp: {
                                            qInfo: { qType: "cf-periode-sonde" },
                                            qHyperCubeDef: {
                                                qDimensions: [{ qLibraryId: moisDimId }],
                                                qMeasures: [{ qLibraryId: rQte }],
                                                qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 2, qHeight: 500 }],
                                            },
                                        } }, doc);
                                        const sRet = sonde.qReturn as { qHandle: number; qGenericId?: string; qId?: string };
                                        try {
                                            const sl = await rpc("GetLayout", {}, sRet.qHandle);
                                            const hc = (sl.qLayout as { qHyperCube?: { qSize?: { qcy?: number }; qDataPages?: Array<{ qMatrix?: Array<Array<{ qText?: string; qNum?: number }>> }> } }).qHyperCube;
                                            const lignes: Array<Array<{ qText?: string; qNum?: number }>> = [...(hc?.qDataPages?.[0]?.qMatrix ?? [])];
                                            const total = Number(hc?.qSize?.qcy) || 0;
                                            for (let top = lignes.length; top < total; top += 500) {
                                                const d = await rpc("GetHyperCubeData", {
                                                    qPath: "/qHyperCubeDef",
                                                    qPages: [{ qTop: top, qLeft: 0, qWidth: 2, qHeight: Math.min(500, total - top) }],
                                                }, sRet.qHandle);
                                                const m = (d.qDataPages as Array<{ qMatrix?: Array<Array<{ qText?: string; qNum?: number }>> }>)?.[0]?.qMatrix ?? [];
                                                if (m.length === 0) break;
                                                lignes.push(...m);
                                            }
                                            const vivants = lignes
                                                .filter((r) => (Number(r[1]?.qNum) || 0) > 0)
                                                .map((r) => normMois(String(r[0]?.qText ?? "")))
                                                .sort();
                                            return { fenetre: vivants.filter((m) => fenetre.has(m)), tous: vivants };
                                        } finally {
                                            const sid = String(sRet.qGenericId ?? sRet.qId ?? "");
                                            if (sid) { try { await rpc("DestroySessionObject", { qId: sid }, doc); } catch { /* noop */ } }
                                        }
                                    };

                                    /** Résumé compact d'une liste de mois : « 2025-01…2025-12 (12) ». */
                                    const resume = (mois: string[]) =>
                                        mois.length === 0 ? "aucun" : mois[0] + "…" + mois[mois.length - 1] + " (" + mois.length + ")";

                                    /**
                                     * Couverture d'une `Période` telle qu'elle sera RÉELLEMENT
                                     * exploitée : une passe par année, comme `monthDimPath`, puis
                                     * union. C'est le seul chiffre qui a un sens ici — mesurer
                                     * sans année revient à juger « Année à date » sur la seule
                                     * année en cours (6/12) et à la rejeter à tort.
                                     */
                                    // ─── Une `Période` PAR ANNÉE ─────────────────────────────
                                    //
                                    // C'est le point que la version globale manquait : la bonne
                                    // valeur dépend de l'année analysée. « Année à date » convient
                                    // à 2026 (janvier → mois courant) mais pas à 2025, dont on veut
                                    // les 12 mois. On cartographie donc, pour chaque année de la
                                    // fenêtre, la valeur qui sert le PLUS de mois attendus de cette
                                    // année-là — l'état sans `Période` étant un candidat comme un
                                    // autre.
                                    const couvertsGlobal = new Set<string>();
                                    for (const annee of annees) {
                                        const attendusAnnee = [...fenetre].filter((m) => m.startsWith(String(annee) + "-"));
                                        diag("  année " + annee + " — mois attendus " + JSON.stringify(attendusAnnee.sort()));

                                        if (yfh !== -1) {
                                            await rpc("Clear", {}, yfh);
                                            await sleep(qlikSettleMs);
                                            await rpc("SelectValues", {
                                                qFieldValues: [{ qNum: annee, qText: String(annee) }],
                                                qToggleMode: false,
                                                qSoftLock: true,
                                            }, yfh);
                                            await sleep(qlikSettleMs);
                                        }

                                        // `null` = état sans `Période`, candidat comme un autre.
                                        const candidats: Array<string | null> = [null, ...valeurs.map((v) => v.texte)];
                                        let meilleure: { texte: string | null; servis: string[] } | null = null;
                                        for (const c of candidats) {
                                            const libelle = c ?? "(aucune)";
                                            // Un candidat qui échoue ne doit pas emporter toute la
                                            // cartographie : on le note et on passe au suivant.
                                            let servis: string[] = [];
                                            try {
                                                const pose = await appliquerPeriode(c);
                                                if (!pose && c !== null) {
                                                    diag("    Période « " + libelle + " » → non sélectionnable, ignorée");
                                                    continue;
                                                }
                                                const mois = await mesurerCouverture();
                                                servis = mois.fenetre.filter((m) => attendusAnnee.includes(m));
                                                diag(
                                                    "    Période « " + libelle + " » → sert " + servis.length + "/" + attendusAnnee.length +
                                                    " mois attendus " + JSON.stringify(servis) + " ; master exposée : " + resume(mois.tous),
                                                );
                                            } catch (e) {
                                                diag("    Période « " + libelle + " » → erreur " + String((e as Error)?.message || e));
                                                continue;
                                            }
                                            if (!meilleure || servis.length > meilleure.servis.length) {
                                                meilleure = { texte: c, servis };
                                            }
                                            if (servis.length >= attendusAnnee.length) break; // année complète
                                        }

                                        if (meilleure) {
                                            periodeParAnnee.set(annee, { texte: meilleure.texte });
                                            for (const m of meilleure.servis) couvertsGlobal.add(m);
                                            diag(
                                                "  → année " + annee + " sera extraite sous Période « " + (meilleure.texte ?? "(aucune)") + " » (" +
                                                meilleure.servis.length + "/" + attendusAnnee.length + " mois)",
                                            );
                                        }
                                    }

                                    if (yfh !== -1) {
                                        // Chaque passe pose sa propre année.
                                        await rpc("Clear", {}, yfh);
                                        await sleep(qlikSettleMs);
                                    }
                                    return couvertsGlobal.size;
                                } catch (e) {
                                    diag("choix de « Période » impossible : " + String((e as Error)?.message || e));
                                    return 0;
                                } finally {
                                    // Le list object est conservé jusqu'au bout : le détruire
                                    // annulerait la sélection qu'il porte.
                                    void lo;
                                }
                            };

                            /**
                             * Teste UNE expression isolément sur un petit cube `[Mois]`.
                             *
                             * Une seule mesure invalide suffit à faire renvoyer **zéro ligne** à
                             * tout un hypercube — observé en production : le cube à 5 mesures
                             * calculait 26 s puis rendait 0 ligne, alors que `Sum(quantite)` seul
                             * donnait 35 424 324. Impossible de savoir laquelle sans les isoler.
                             *
                             * Renvoie l'expression si elle produit des lignes, sinon `"0"` — une
                             * colonne neutre qui préserve les indices sans casser le cube.
                             */
                            const validerExpression = async (nom: string, expr: string): Promise<string> => {
                                let ret: { qHandle: number; qGenericId?: string; qId?: string } | null = null;
                                try {
                                    const o = await rpc("CreateSessionObject", { qProp: {
                                        qInfo: { qType: "cf-test-expr" },
                                        qHyperCubeDef: {
                                            qDimensions: [{ qLibraryId: moisDimId }],
                                            qMeasures: [{ qDef: { qDef: expr } }],
                                            qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 2, qHeight: 30 }],
                                        },
                                    } }, doc);
                                    ret = o.qReturn as { qHandle: number; qGenericId?: string; qId?: string };
                                    const lay = await rpc("GetLayout", {}, ret.qHandle);
                                    const hc = (lay.qLayout as { qHyperCube?: { qSize?: { qcy?: number }; qError?: unknown; qDataPages?: Array<{ qMatrix?: Array<Array<{ qText?: string; qNum?: number }>> }> } }).qHyperCube;
                                    const matrix = hc?.qDataPages?.[0]?.qMatrix ?? [];
                                    const lignes = Number(hc?.qSize?.qcy) || 0;
                                    let total = 0;
                                    let texteErreur = "";
                                    for (const r of matrix) {
                                        total += Number(r[1]?.qNum) || 0;
                                        const t = String(r[1]?.qText ?? "");
                                        if (!texteErreur && /error|erreur|garbage|^-$/i.test(t)) texteErreur = t;
                                    }
                                    if (hc?.qError) texteErreur = texteErreur || JSON.stringify(hc.qError);
                                    if (lignes === 0 || texteErreur) {
                                        diag("  mesure « " + nom + " » = " + expr + " → INVALIDE (" + (texteErreur || "cube vide") + ")");
                                        return "0";
                                    }
                                    diag("  mesure « " + nom + " » = " + expr + " → " + lignes + " mois, total=" + Math.round(total));
                                    return expr;
                                } catch (e) {
                                    diag("  mesure « " + nom + " » = " + expr + " → ERREUR " + String((e as Error)?.message || e));
                                    return "0";
                                } finally {
                                    const id = String(ret?.qGenericId ?? ret?.qId ?? "");
                                    if (id) { try { await rpc("DestroySessionObject", { qId: id }, doc); } catch { /* noop */ } }
                                }
                            };

                            /**
                             * La master « Quantité N » produit-elle la moindre ligne sur `[Mois]`
                             * dans l'état de sélection courant ? Même sonde que
                             * `validerExpression`, mais par `qLibraryId`.
                             */
                            const masterQteVivante = async (): Promise<boolean> => {
                                let ret: { qHandle: number; qGenericId?: string; qId?: string } | null = null;
                                try {
                                    const o = await rpc("CreateSessionObject", { qProp: {
                                        qInfo: { qType: "cf-test-master" },
                                        qHyperCubeDef: {
                                            qDimensions: [{ qLibraryId: moisDimId }],
                                            qMeasures: [{ qLibraryId: rQte }],
                                            qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 2, qHeight: 30 }],
                                        },
                                    } }, doc);
                                    ret = o.qReturn as { qHandle: number; qGenericId?: string; qId?: string };
                                    const lay = await rpc("GetLayout", {}, ret.qHandle);
                                    const hc = (lay.qLayout as { qHyperCube?: { qDataPages?: Array<{ qMatrix?: Array<Array<{ qNum?: number }>> }> } }).qHyperCube;
                                    let total = 0;
                                    for (const r of hc?.qDataPages?.[0]?.qMatrix ?? []) total += Number(r[1]?.qNum) || 0;
                                    diag("  master « Quantité N » (calibrage) → total=" + Math.round(total));
                                    return total > 0;
                                } catch (e) {
                                    diag("  master « Quantité N » → ERREUR " + String((e as Error)?.message || e));
                                    return false;
                                } finally {
                                    const id = String(ret?.qGenericId ?? ret?.qId ?? "");
                                    if (id) { try { await rpc("DestroySessionObject", { qId: id }, doc); } catch { /* noop */ } }
                                }
                            };

                            /**
                             * Somme de `expr` VENTILÉE par la dimension Mois.
                             *
                             * Comparée au total sans dimension, elle dit si la dimension Mois
                             * démultiplie les faits à travers le pont de périodes — auquel cas
                             * l'agrégation directe est inexploitable.
                             */
                            const totalVentileParMois = async (expr: string): Promise<number> => {
                                let ret: { qHandle: number; qGenericId?: string; qId?: string } | null = null;
                                try {
                                    const o = await rpc("CreateSessionObject", { qProp: {
                                        qInfo: { qType: "cf-ventil-mois" },
                                        qHyperCubeDef: {
                                            qDimensions: [{ qLibraryId: moisDimId }],
                                            qMeasures: [{ qDef: { qDef: expr } }],
                                            qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 2, qHeight: 200 }],
                                        },
                                    } }, doc);
                                    ret = o.qReturn as { qHandle: number; qGenericId?: string; qId?: string };
                                    const lay = await rpc("GetLayout", {}, ret.qHandle);
                                    const hc = (lay.qLayout as { qHyperCube?: { qDataPages?: Array<{ qMatrix?: Array<Array<{ qNum?: number }>> }> } }).qHyperCube;
                                    let total = 0;
                                    for (const r of hc?.qDataPages?.[0]?.qMatrix ?? []) total += Number(r[1]?.qNum) || 0;
                                    return total;
                                } catch {
                                    return 0;
                                } finally {
                                    const id = String(ret?.qGenericId ?? ret?.qId ?? "");
                                    if (id) { try { await rpc("DestroySessionObject", { qId: id }, doc); } catch { /* noop */ } }
                                }
                            };

                            /**
                             * Cube `[Article Code] × 4 expressions`, SANS dimension Mois.
                             *
                             * C'est tout l'intérêt : la dimension Mois passe par le pont de
                             * périodes et rattache une même ligne de fait à plusieurs contextes
                             * (mesuré : ×5,3). Sans elle, `Sum(quantite)` porte une fois et une
                             * seule sur les faits visibles — donc sur le mois sélectionné.
                             */
                            const fetchCodeCubeExpr = async (
                                eCa: string, eQte: string, eNbMag: string, eMarge: string,
                                onRow: (code: string, ca: number, qte: number, nbMag: number, marge: number) => void,
                                timings?: Record<string, number>,
                            ): Promise<number> => {
                                const LARGEUR = 5;
                                const PAGE = 1800; // 5 × 1800 = 9000 cellules < 10000
                                const { value: obj } = await timed("createCubeCode", "CreateSessionObject", () => rpcWithRetry("createCubeCode", "CreateSessionObject", { qProp: { qInfo: { qType: "cf-net-code-expr" }, qHyperCubeDef: {
                                    qDimensions: [{ qLibraryId: dim }],
                                    qMeasures: [
                                        { qDef: { qDef: eCa } },
                                        { qDef: { qDef: eQte } },
                                        { qDef: { qDef: eNbMag } },
                                        { qDef: { qDef: eMarge } },
                                    ],
                                    qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: LARGEUR, qHeight: PAGE }],
                                } } }, doc), timings);
                                const qReturn = obj.qReturn as { qHandle: number; qGenericId?: string; qId?: string };
                                const cube = { handle: qReturn.qHandle, id: String(qReturn.qGenericId ?? qReturn.qId ?? "") };
                                const traiter = (matrix: Array<Array<{ qText?: string; qNum?: number }>>): number => {
                                    for (const r of matrix) {
                                        onRow(
                                            String(r[0]?.qText ?? ""),
                                            Number(r[1]?.qNum) || 0, Number(r[2]?.qNum) || 0,
                                            Number(r[3]?.qNum) || 0, Number(r[4]?.qNum) || 0,
                                        );
                                    }
                                    return matrix.length;
                                };
                                try {
                                    const { value: layout } = await timed("layout", "GetLayout", () => rpcWithRetry("layout", "GetLayout", {}, cube.handle), timings);
                                    const hc = (layout.qLayout as { qHyperCube: { qSize: { qcy: number }; qDataPages?: Array<{ qArea?: { qTop?: number }; qMatrix?: Array<Array<{ qText?: string; qNum?: number }>> }> } }).qHyperCube;
                                    const size = hc.qSize.qcy;
                                    let got = 0, top = 0;
                                    const p0 = hc.qDataPages?.find((p) => (p.qArea?.qTop ?? 0) === 0);
                                    if (p0?.qMatrix?.length) { got += traiter(p0.qMatrix); top = PAGE; }
                                    for (; top < size; top += PAGE) {
                                        const { value: d } = await timed("getCubeData", "GetHyperCubeData", () => rpcWithRetry("getCubeData", "GetHyperCubeData", { qPath: "/qHyperCubeDef", qPages: [{ qTop: top, qLeft: 0, qWidth: LARGEUR, qHeight: PAGE }] }, cube.handle), timings);
                                        const matrix = (d.qDataPages as Array<{ qMatrix?: Array<Array<{ qText?: string; qNum?: number }>> }>)?.[0]?.qMatrix ?? [];
                                        if (!matrix.length) break;
                                        got += traiter(matrix);
                                        if (matrix.length < PAGE) break;
                                    }
                                    return got;
                                } finally {
                                    await destroyCube(cube, timings);
                                }
                            };

                            /**
                             * EXTRACTION MOIS PAR MOIS SUR LE CHAMP DATE BRUT.
                             *
                             * Le chemin que rien n'avait encore essayé, et le seul qui n'emprunte
                             * ni le pont de périodes ni les master measures :
                             *
                             *  - on sélectionne les jours d'UN mois sur le champ date ;
                             *  - on lit un cube `[Article Code]` sans dimension Mois, donc sans
                             *    démultiplication ;
                             *  - `Type_Cal`, `Période` et `Année` sont effacés : les expressions
                             *    brutes n'ont pas besoin du pont, elles agrègent les faits visibles.
                             *
                             * Il n'y a donc plus de « mois inatteignable » : chaque mois est un
                             * filtre de dates, pas un contexte de calendrier.
                             *
                             * CONTRÔLE D'INTÉGRITÉ. La somme des 12 mois ne doit pas dépasser le
                             * total sans filtre de date : si la dimension ou le champ démultipliait
                             * les faits, elle exploserait (le pont donne ×5,3). Et chaque mois doit
                             * être servi. Sinon rien n'est écrit.
                             */
                            const moisParDateBrute = async (): Promise<boolean> => {
                                const timings: Record<string, number> = {};

                                // Aucun contexte de calendrier : on veut les faits nus.
                                if (yfh !== -1) { await rpc("Clear", {}, yfh); await sleep(qlikSettleMs); }
                                await appliquerPeriode(null);
                                if (dfh !== -1) { await rpc("Clear", {}, dfh); await sleep(qlikSettleMs); }

                                if (codes.length && fh !== -1 && !parFournisseur) {
                                    await timed("clearCode", "Clear", () => rpc("Clear", {}, fh), timings);
                                    await sleep(qlikSettleMs);
                                    await timed("selectCodeAll", "SelectValues", () => rpcWithRetry("selectCodeAll", "SelectValues", {
                                        qFieldValues: codes.map((c) => ({ qText: c })),
                                        qToggleMode: false,
                                        qSoftLock: true,
                                    }, fh, () => { aggCode15Retries++; }), timings);
                                    await sleep(qlikSettleMs);
                                }

                                const sansFiltre = await totalDeControle();
                                diag("[date brute] contrôle « " + exprQte + " » sans filtre date = " + Math.round(sansFiltre));
                                if (sansFiltre <= 0) {
                                    diag("[date brute] ÉCHEC : l'expression quantité ne renvoie rien (corriger QLIK_EXPR_QTE)");
                                    return false;
                                }

                                // ─── Quel champ date filtre les faits ? ──────────────────
                                //
                                // ⚠️ On teste avec UN SEUL MOIS, pas avec la fenêtre entière.
                                // Toute la table de faits tient dans les 12 mois (mesuré : 100 %
                                // du total) : sélectionner la fenêtre ne réduit donc RIEN, et
                                // l'ancien test « le total doit baisser » rejetait tous les
                                // champs, y compris les bons.
                                const moisTest = monthlyPayload[Math.floor(monthlyPayload.length / 2)];
                                let champDate: string | null = null;
                                let handleDate = -1;
                                for (const cand of champsDateCandidats) {
                                    const valeurs = /key/i.test(cand) ? moisTest.ymd : moisTest.serials;
                                    const h = await selectionnerFenetreSur(cand, valeurs);
                                    if (h == null) { diag("[date brute]   champ « " + cand + " » : inexistant"); continue; }
                                    const t = await totalDeControle();
                                    const part = sansFiltre > 0 ? t / sansFiltre : 0;
                                    diag(
                                        "[date brute]   champ « " + cand + " » sur le seul mois " + moisTest.label + " → " +
                                        Math.round(t) + " (" + (part * 100).toFixed(1) + "% du total)",
                                    );
                                    // Un mois isolé doit peser une fraction du total : ni zéro
                                    // (le champ ne touche pas les faits) ni la totalité (il ne
                                    // filtre pas).
                                    if (t > 0 && part < 0.5) { champDate = cand; handleDate = h; break; }
                                    await rpc("Clear", {}, h);
                                    await sleep(qlikSettleMs);
                                }
                                if (!champDate || handleDate === -1) {
                                    diag(
                                        "[date brute] ÉCHEC : aucun champ date ne filtre les faits mois par mois " +
                                        "(essayés : " + JSON.stringify(champsDateCandidats) + ")",
                                    );
                                    return false;
                                }
                                diag("[date brute] champ date retenu : « " + champDate + " »");

                                // À partir d'ici la série sera reconstruite entièrement : les
                                // passes annuelles (master measures) et la série brute n'ont pas
                                // la même sémantique, on ne les mélange pas.
                                out.length = 0;
                                for (const k of Object.keys(monthlyByCode)) delete monthlyByCode[k];

                                const totauxMois: Record<string, number> = {};
                                let sommeMois = 0;
                                for (let i = 0; i < monthlyPayload.length; i++) {
                                    const m = monthlyPayload[i];
                                    const valeurs = /key/i.test(champDate) ? m.ymd : m.serials;
                                    await rpc("Clear", {}, handleDate);
                                    await sleep(qlikSettleMs);
                                    await rpcWithRetry("selectDate", "SelectValues", {
                                        qFieldValues: valeurs.map((v) => ({ qNum: v, qText: String(v) })),
                                        qToggleMode: false,
                                        qSoftLock: true,
                                    }, handleDate, () => { aggCode15Retries++; });
                                    await sleep(qlikSettleMs);

                                    let totalDuMois = 0;
                                    const lignes = await fetchCodeCubeExpr(exprCa, exprQte, exprNbMag, exprMarge, (code, ca, qte, nbMag, marge) => {
                                        if (!code || code === "-") return;
                                        if (qte === 0 && ca === 0) return;
                                        totalDuMois += qte;
                                        out.push([code, ca, qte, nbMag, nbMag > 0 ? ca / nbMag : 0, ca > 0 ? marge / ca : 0]);
                                        (monthlyByCode[code] ??= {});
                                        monthlyByCode[code][m.label] = {
                                            qte, ca, nbMag,
                                            caMag: nbMag > 0 ? ca / nbMag : 0,
                                            margePct: ca > 0 ? marge / ca : 0,
                                        };
                                    }, timings);
                                    totauxMois[m.label] = totalDuMois;
                                    sommeMois += totalDuMois;
                                    aggBatches++;
                                    console.log(
                                        "[qlik-pw][date brute] mois " + (i + 1) + "/" + monthlyPayload.length + " " + m.label +
                                        " → " + lignes + " articles, quantité=" + Math.round(totalDuMois),
                                    );
                                    await pousserCheckpoint("date brute " + m.label);
                                }
                                aggMonths = monthlyPayload.length;

                                diag("[date brute] quantités par mois : " + JSON.stringify(
                                    Object.fromEntries(Object.entries(totauxMois).map(([k, v]) => [k, Math.round(v)])),
                                ));

                                // ─── Intégrité ───────────────────────────────────────────
                                const vides = Object.entries(totauxMois).filter(([, v]) => v <= 0).map(([k]) => k);
                                if (vides.length) {
                                    diag("[date brute] ÉCHEC : mois sans aucune vente " + JSON.stringify(vides));
                                    return false;
                                }
                                if (sommeMois > sansFiltre * 1.02) {
                                    diag(
                                        "[date brute] ÉCHEC : la somme des 12 mois (" + Math.round(sommeMois) +
                                        ") dépasse le total sans filtre (" + Math.round(sansFiltre) + ") — les faits sont " +
                                        "démultipliés, les ventes réseau seraient fausses",
                                    );
                                    return false;
                                }
                                diag(
                                    "[date brute] OK — somme des 12 mois = " + Math.round(sommeMois) + " pour un total sans filtre de " +
                                    Math.round(sansFiltre) + " (" + Math.round((sommeMois / sansFiltre) * 100) + "%), " +
                                    Object.keys(monthlyByCode).length + " articles",
                                );
                                console.log("[qlik-pw][date brute] timings=" + timingSummary(timings));
                                return true;
                            };

                            const moisParExpressions = async (): Promise<boolean> => {
                                const timings: Record<string, number> = {};
                                const marqueOut = out.length;
                                try {
                                    if (yfh !== -1) { await rpc("Clear", {}, yfh); await sleep(qlikSettleMs); }

                                    // Les codes d'abord : les totaux de contrôle portent alors sur
                                    // le même périmètre que l'extraction. Sauf si le fournisseur
                                    // pose déjà ce périmètre — le re-sélectionner par codes ne
                                    // changerait rien au résultat et coûterait une minute.
                                    if (codes.length && fh !== -1 && !parFournisseur) {
                                        await timed("clearCode", "Clear", () => rpc("Clear", {}, fh), timings);
                                        await sleep(qlikSettleMs);
                                        await timed("selectCodeAll", "SelectValues", () => rpcWithRetry("selectCodeAll", "SelectValues", {
                                            qFieldValues: codes.map((c) => ({ qText: c })),
                                            qToggleMode: false,
                                            qSoftLock: true,
                                        }, fh, () => { aggCode15Retries++; }), timings);
                                        await sleep(qlikSettleMs);
                                    }

                                    // ─── Quel champ date filtre RÉELLEMENT les faits ? ───────
                                    //
                                    // Les master measures ignorant la sélection Date, personne
                                    // n'avait jamais pu vérifier que « Date » filtrait quoi que
                                    // ce soit. Un champ valide doit donner un total non nul ET
                                    // strictement inférieur au total sans filtre.
                                    const sansFiltre = await totalDeControle();
                                    diag("contrôle « " + exprQte + " » sans filtre date = " + Math.round(sansFiltre));
                                    if (sansFiltre <= 0) {
                                        diag("ÉCHEC : « " + exprQte + " » renvoie 0 même sans filtre → expression ou champ invalide (corriger QLIK_EXPR_QTE)");
                                        return false;
                                    }

                                    const allSerials = monthlyPayload.flatMap((m) => m.serials);
                                    const allYmd = monthlyPayload.flatMap((m) => m.ymd);
                                    const moisFenetre = new Set(monthlyPayload.map((m) => m.label));
                                    let champDate: string | null = null;
                                    let totalFenetre = 0;
                                    for (const cand of champsDateCandidats) {
                                        const valeurs = /key/i.test(cand) ? allYmd : allSerials;
                                        const handleCand = await selectionnerFenetreSur(cand, valeurs);
                                        if (handleCand == null) {
                                            diag("  champ « " + cand + " » : inexistant");
                                            continue;
                                        }
                                        const filtre = await totalDeControle();
                                        const ratio = sansFiltre > 0 ? filtre / sansFiltre : 0;
                                        diag("  champ « " + cand + " » → " + Math.round(filtre) + " (" + Math.round(ratio * 100) + "% du total sans filtre)");
                                        // ⚠️ 100 % ne veut PAS dire « ce champ ne filtre rien » : toute
                                        // la table de faits tient dans les 12 mois (mesuré), donc
                                        // sélectionner la fenêtre entière ne retire rien. Exiger une
                                        // baisse rejetait donc les champs valides. Ici la sélection
                                        // ne sert qu'à borner la fenêtre : un total non nul suffit,
                                        // et on préfère simplement un champ qui filtre s'il existe.
                                        if (filtre > 0) {
                                            champDate = cand;
                                            totalFenetre = filtre;
                                            if (ratio < 0.995) break;
                                            diag("    (la fenêtre couvre 100 % des faits — normal si l'app ne porte que ces 12 mois)");
                                            break;
                                        }
                                        // Un candidat rejeté ne doit jamais polluer l'essai
                                        // suivant (cas observé : Date=0 puis tous les autres=0).
                                        await rpc("Clear", {}, handleCand);
                                        await sleep(qlikSettleMs);
                                    }
                                    if (!champDate) {
                                        // Les champs date exposés sont dissociés des faits : la
                                        // dimension maître « Mois », elle, porte les vraies valeurs.
                                        const selectionMois = await selectionnerFenetreViaDimensionMois(moisFenetre);
                                        const ratio = selectionMois && sansFiltre > 0 ? selectionMois.total / sansFiltre : 0;
                                        if (selectionMois) {
                                            diag("  dimension « Mois » → " + Math.round(selectionMois.total) + " (" + Math.round(ratio * 100) + "% du total sans filtre)");
                                        }
                                        if (selectionMois && selectionMois.total > 0 && ratio < 0.995) {
                                            champDate = "dimension Mois";
                                            totalFenetre = selectionMois.total;
                                        }
                                    }
                                    if (!champDate) {
                                        diag(
                                            "ÉCHEC : ni les champs date ni la dimension Mois ne filtrent les faits " +
                                            "(champs essayés : " + JSON.stringify(champsDateCandidats) + ") → impossible de borner la fenêtre 12 mois.",
                                        );
                                        return false;
                                    }
                                    diag("champ date retenu : « " + champDate + " »");

                                    // Chaque expression est validée SÉPARÉMENT : une seule mesure
                                    // invalide fait rendre zéro ligne à tout l'hypercube, sans
                                    // qu'aucun message ne dise laquelle.
                                    diag("validation des expressions, une par une :");
                                    const vQte = await validerExpression("quantité", exprQte);
                                    if (vQte === "0") {
                                        diag("ÉCHEC : l'expression quantité est inutilisable, rien à extraire");
                                        return false;
                                    }
                                    const vCa = await validerExpression("CA", exprCa);
                                    const vNbMag = await validerExpression("magasins", exprNbMag);
                                    const vMarge = await validerExpression("marge", exprMarge);

                                    // La master « Quantité N » n'est là que pour le calibrage, mais
                                    // une master morte suffit à vider tout l'hypercube. On la sonde
                                    // donc comme les autres, et on l'omet plutôt que de perdre
                                    // l'extraction entière pour une colonne de contrôle.
                                    const avecMaster = await masterQteVivante();
                                    if (!avecMaster) {
                                        diag("  master « Quantité N » morte sous cette sélection → colonne de calibrage retirée du cube");
                                    }

                                    // ─── La dimension Mois démultiplie-t-elle les faits ? ────
                                    //
                                    // Le pont de périodes rattache une même ligne de fait à
                                    // plusieurs contextes. Ventilé par `Mois`, `Sum(quantite)` peut
                                    // donc dépasser le total sans dimension — mesuré : 179 574 616
                                    // contre 33 945 285, soit ×5,3. Écrire cela dans le cache
                                    // donnerait des ventes réseau cinq fois trop hautes : on refuse.
                                    const totalVentile = await totalVentileParMois(vQte);
                                    if (totalVentile > totalFenetre * 1.05) {
                                        diag(
                                            "ÉCHEC : ventilée par Mois, « " + vQte + " » totalise " + Math.round(totalVentile) +
                                            " contre " + Math.round(totalFenetre) + " sans dimension (×" +
                                            (totalFenetre > 0 ? (totalVentile / totalFenetre).toFixed(1) : "?") +
                                            "). La dimension Mois passe par le pont de périodes et démultiplie les faits — " +
                                            "l'agrégation directe donnerait des ventes réseau fausses, elle est refusée.",
                                        );
                                        return false;
                                    }

                                    // Seuls les mois de la fenêtre nous intéressent ; la dimension
                                    // Mois peut en exposer d'autres si une sélection déborde.
                                    let totalQte = 0;
                                    let calibrees = 0, calibrOk = 0;
                                    let horsFenetre = 0;
                                    let echantillon = false;

                                    const got = await timed("cube", "expr", () => fetchMonthCubeExpr(vCa, vQte, vNbMag, vMarge, (code, mois, ca, qte, nbMag, marge, qteMaster) => {
                                        if (!code || code === "-") return;
                                        const mm = normMois(mois);
                                        if (!echantillon) {
                                            echantillon = true;
                                            // Échantillon AVANT filtrage : si le mois ne tombe pas dans
                                            // la fenêtre, c'est le format de la dimension Mois qui est
                                            // en cause, pas les mesures.
                                            diag("échantillon brut: " + JSON.stringify({
                                                code, moisBrut: mois, moisNormalise: mm, dansLaFenetre: moisFenetre.has(mm),
                                                ca, qte, nbMag, marge, "Quantité N (master)": qteMaster,
                                            }));
                                        }
                                        if (!moisFenetre.has(mm)) { horsFenetre++; return; }
                                        // Calibrage sur l'année en cours, seul périmètre où la master
                                        // measure est censée être juste.
                                        if (avecMaster && parseInt(mm.slice(0, 4), 10) === yearN && (qte > 0 || qteMaster > 0)) {
                                            calibrees++;
                                            if (Math.abs(qte - qteMaster) <= Math.max(1, qteMaster * 0.02)) calibrOk++;
                                        }
                                        totalQte += qte;
                                        // Totaux = somme des mois de la fenêtre (et non un cumul année).
                                        out.push([code, ca, qte, nbMag, nbMag > 0 ? ca / nbMag : 0, ca > 0 ? marge / ca : 0]);
                                        (monthlyByCode[code] ??= {});
                                        // Agrège au lieu d'écraser : protège contre deux valeurs
                                        // brutes de la dimension Mois qui se normaliseraient vers
                                        // la même clé YYYY-MM.
                                        const precedent = monthlyByCode[code][mm];
                                        const qteCumulee = (precedent?.qte ?? 0) + qte;
                                        const caCumule = (precedent?.ca ?? 0) + ca;
                                        const margeMontant = ((precedent?.margePct ?? 0) * (precedent?.ca ?? 0)) + marge;
                                        monthlyByCode[code][mm] = {
                                            qte: qteCumulee,
                                            ca: caCumule,
                                            nbMag: Math.max(precedent?.nbMag ?? 0, nbMag),
                                            caMag: nbMag > 0 ? ca / nbMag : 0,
                                            margePct: caCumule > 0 ? margeMontant / caCumule : 0,
                                        };
                                    }, timings, undefined, avecMaster), timings);

                                    aggMonths = monthlyPayload.length;
                                    aggBatches++;
                                    diag(
                                        got.value + " lignes (" + horsFenetre + " hors fenêtre), quantité totale=" + Math.round(totalQte) +
                                        ", calibrage année " + yearN + " : " + calibrOk + "/" + calibrees + " mois conformes à « Quantité N »",
                                    );
                                    console.log("[qlik-pw][expr] timings=" + timingSummary(timings));

                                    if (totalQte <= 0) {
                                        diag(
                                            "ÉCHEC : quantité totale nulle sur la fenêtre alors que le contrôle global valait " +
                                            Math.round(sansFiltre) + " — " + horsFenetre + " ligne(s) écartées comme hors fenêtre. " +
                                            "Si ce nombre est élevé, c'est le format de la dimension Mois qui ne correspond pas aux libellés attendus.",
                                        );
                                        out.length = marqueOut;
                                        for (const k of Object.keys(monthlyByCode)) delete monthlyByCode[k];
                                        return false;
                                    }
                                    // Contrôle global indépendant : le cube sans dimension,
                                    // calculé sur exactement les mêmes sélections, doit être
                                    // égal à la somme de toutes les lignes mensuelles paginées.
                                    const ecartGlobal = Math.abs(totalQte - totalFenetre);
                                    const toleranceGlobale = Math.max(0.001, Math.abs(totalFenetre) * 1e-9);
                                    if (ecartGlobal > toleranceGlobale) {
                                        console.error(
                                            "[qlik-pw][expr] INTÉGRITÉ REFUSÉE : somme mensuelle=" + totalQte +
                                            " mais total Qlik fenêtre=" + totalFenetre + " (écart=" + ecartGlobal + ")",
                                        );
                                        out.length = marqueOut;
                                        for (const k of Object.keys(monthlyByCode)) delete monthlyByCode[k];
                                        return false;
                                    }

                                    // Contrôle et normalisation PAR ARTICLE. Chaque article
                                    // retourné possède ensuite exactement les 12 clés de la
                                    // fenêtre ; une clé absente du cube Qlik signifie qu'aucun
                                    // fait n'existe pour ce mois, donc une vraie valeur 0.
                                    const totauxParCode: Record<string, number> = {};
                                    for (let i = marqueOut; i < out.length; i++) {
                                        const ligne = out[i];
                                        const code = String(ligne[0] ?? "").trim();
                                        if (code) totauxParCode[code] = (totauxParCode[code] ?? 0) + (Number(ligne[2]) || 0);
                                    }
                                    for (const [code, mois] of Object.entries(monthlyByCode)) {
                                        for (const label of moisFenetre) {
                                            mois[label] ??= { qte: 0, ca: 0, nbMag: 0, caMag: 0, margePct: 0 };
                                        }
                                        // Ne conserve aucune clé hors de la fenêtre glissante.
                                        for (const label of Object.keys(mois)) {
                                            if (!moisFenetre.has(label)) delete mois[label];
                                        }
                                        const somme12 = Array.from(moisFenetre).reduce((s, label) => s + (Number(mois[label]?.qte) || 0), 0);
                                        const totalArticle = totauxParCode[code] ?? 0;
                                        if (Math.abs(somme12 - totalArticle) > Math.max(0.001, Math.abs(totalArticle) * 1e-9)) {
                                            console.error(
                                                "[qlik-pw][expr] INTÉGRITÉ ARTICLE REFUSÉE code=" + code +
                                                " somme12=" + somme12 + " total=" + totalArticle,
                                            );
                                            out.length = marqueOut;
                                            for (const k of Object.keys(monthlyByCode)) delete monthlyByCode[k];
                                            return false;
                                        }
                                    }
                                    if (calibrees > 20 && calibrOk / calibrees < 0.5) {
                                        console.warn(
                                            "[qlik-pw][expr] ⚠ calibrage faible (" + calibrOk + "/" + calibrees + ") : " + exprQte +
                                            " diverge de « Quantité N ». Vérifier l'expression (QLIK_EXPR_QTE).",
                                        );
                                    }
                                    return true;
                                } catch (e) {
                                    diag("ÉCHEC : " + String((e as Error)?.message || e) + " → repli sur les master measures");
                                    out.length = marqueOut;
                                    for (const k of Object.keys(monthlyByCode)) delete monthlyByCode[k];
                                    return false;
                                }
                            };

                            // Sélectionne toute la fenêtre de dates une fois, puis parcourt les codes par
                            // lots ; un seul cube [Article Code, Mois] par lot donne TOUS les mois d'un coup.
                            // selectYear = null → passe principale (année N + N-1 dérivée via COMP).
                            // selectYear = 2025 → passe complémentaire : on sélectionne l'année pour
                            // récupérer directement ses mois (seul moyen d'obtenir août→déc N-1, que
                            // COMP ne peut pas fournir puisque l'année N ne va pas jusque-là).
                            let loggedSampleRow = false;
                            const monthDimPath = async (selectYear: number): Promise<void> => {
                                const moisFenetre = new Set(monthlyPayload.map((m) => m.label));

                                /**
                                 * Traitement d'une ligne du cube [Article Code, Mois].
                                 *
                                 * Une passe = UNE année explicitement sélectionnée, exactement ce
                                 * que fait un utilisateur dans l'app (« je sélectionne 2026 et
                                 * j'obtiens N + la comparaison N-1 »). Chaque passe n'écrit que
                                 * les mois DE LA FENÊTRE, et les totaux s'additionnent sur ces
                                 * mois-là : deux années différentes ne peuvent donc pas se
                                 * doubler, puisqu'elles ne partagent aucun mois.
                                 */
                                const onRowMois = (code: string, mois: string, ca: number, qte: number, nbMag: number, caMag: number, marge: number, qteComp: number) => {
                                    if (!code || code === "-") return;
                                    const mm = normMois(mois);
                                    if (!moisFenetre.has(mm)) return;
                                    out.push([code, ca, qte, nbMag, caMag, marge]);
                                    const y = parseInt(mm.slice(0, 4), 10);
                                    if (!loggedSampleRow) {
                                        loggedSampleRow = true;
                                        console.log("[qlik-pw][mesures] échantillon ligne mensuelle: " + JSON.stringify({
                                            code, mois: mm, "CA N": ca, "Quantité N (utilisée pour la courbe)": qte,
                                            "Magasin Ventes Nb N": nbMag, "CA par Magasin N": caMag, "Marge % N": marge, "Quantité COMP": qteComp,
                                        }));
                                    }
                                    (monthlyByCode[code] ??= {});
                                    // Les 5 mesures du mois courant de la ligne. Le cube les renvoie
                                    // déjà toutes : les conserver ne coûte aucune requête Qlik en plus.
                                    const full = { qte, ca, nbMag, caMag, margePct: marge };
                                    // « Quantité COMP » n'est plus nécessaire : chaque année de la
                                    // fenêtre est extraite directement par sa propre passe, ce qui
                                    // donne les 5 mesures et non la seule quantité.
                                    void y; void qteComp;
                                    // Une passe ultérieure ne doit JAMAIS écraser un mois servi par
                                    // un zéro : hors de son année, la passe voit la combinaison
                                    // (article, mois) mais toutes ses mesures sont nulles.
                                    const precedent = monthlyByCode[code][mm];
                                    if (precedent && (precedent.qte ?? 0) > 0 && qte <= 0) return;
                                    monthlyByCode[code][mm] = full;
                                };

                                if (yfh === -1) throw new Error("champ « Année » introuvable : impossible d'extraire année par année");

                                // La `Période` qui sert cette année-là — pas la même pour toutes :
                                // « Année à date » convient à l'année en cours, une autre valeur à
                                // une année révolue (cf. choisirPeriode).
                                const periodeAnnee = periodeParAnnee.get(selectYear);
                                if (periodeAnnee) {
                                    console.log("[qlik-pw] (mois) Période « " + (periodeAnnee.texte ?? "(aucune)") + " » pour l'année " + selectYear);
                                    await appliquerPeriode(periodeAnnee.texte);
                                }

                                await rpc("Clear", {}, yfh);
                                await sleep(qlikSettleMs);
                                const ysel = await rpc("SelectValues", { qFieldValues: [{ qNum: selectYear, qText: String(selectYear) }], qToggleMode: false, qSoftLock: true }, yfh);
                                console.log("[qlik-pw] (mois) sélection Année=" + selectYear + " → " + JSON.stringify(ysel.qReturn));
                                await sleep(qlikSettleMs);
                                const allSerials = monthlyPayload.flatMap((m) => m.serials);
                                if (dfh !== -1 && allSerials.length) {
                                    await rpc("Clear", {}, dfh);
                                    await sleep(qlikSettleMs);
                                    await rpc("SelectValues", { qFieldValues: allSerials.map((s) => ({ qNum: s, qText: String(s) })), qToggleMode: false, qSoftLock: true }, dfh);
                                    await sleep(qlikSettleMs);
                                }
                                aggMonths = monthlyPayload.length;

                                // ─── Chemin rapide : UNE seule sélection Article Code ────
                                //
                                // Mesuré en production : `SelectValues` sur « Article Code »
                                // coûte 8 à 100 s **par appel**, quasi indépendamment du
                                // nombre de valeurs (le moteur balaie un symbole de plus d'un
                                // million d'entrées). Avec 7 200 codes en lots de 300, cela
                                // faisait 24 appels, ~15 min de sync, et la session Qlik
                                // mourait avant la fin (« Socket closed » puis « Execution
                                // context was destroyed »).
                                //
                                // La dimension Mois donne déjà tous les mois d'un coup : rien
                                // n'oblige à découper les codes. On tente donc un seul appel
                                // pour tous les codes et un seul cube paginé — la lecture des
                                // pages, elle, coûte ~50 ms. Repli sur les lots si l'Engine
                                // refuse (cube trop gros, code 15, saturation mémoire).
                                const marqueOut = out.length;
                                if ((codes.length || parFournisseur) && fh !== -1) {
                                    const timingsAll: Record<string, number> = {};
                                    try {
                                        // Le périmètre fournisseur est posé une fois pour toutes
                                        // avant la première passe : il survit aux sélections
                                        // Année/Date, qui portent sur d'autres champs.
                                        if (!parFournisseur) {
                                            await timed("clearCodeAll", "Clear", () => rpc("Clear", {}, fh), timingsAll);
                                            await sleep(qlikSettleMs);
                                            await timed("selectCodeAll", "SelectValues", () => rpc("SelectValues", {
                                                qFieldValues: codes.map((c) => ({ qText: c })),
                                                qToggleMode: false,
                                                qSoftLock: true,
                                            }, fh), timingsAll);
                                            await sleep(qlikSettleMs);
                                        }
                                        const got = await timed("cube", "all", () => fetchMonthCube(onRowMois, timingsAll), timingsAll);
                                        aggBatches++;
                                        console.log(
                                            "[qlik-pw][timing] (mois) chemin rapide — " +
                                            (parFournisseur ? "périmètre fournisseur (0 sélection code)" : codes.length + " codes en 1 sélection") +
                                            ", rows=" + got.value +
                                            " cumul=" + out.length + " timings=" + timingSummary(timingsAll),
                                        );
                                        return;
                                    } catch (e) {
                                        // Les lignes déjà lues seraient recomptées par le repli :
                                        // on les retire (les écritures mensuelles, elles, sont
                                        // des affectations idempotentes).
                                        out.length = marqueOut;
                                        console.log("[qlik-pw] (mois) chemin rapide échoué → repli par lots : " + String((e as Error)?.message || e));
                                    }
                                }

                                // Lots plus petits = cubes plus légers (moins de pression mémoire côté
                                // moteur Qlik, qui a tendance à saturer "Out of memory" sur les gros cubes).
                                const fallbackSizes = [300, 150, 75];
                                const totalCodes = codes.length;
                                let codeIndex = 0, batchNumber = 0, fallbackIndex = 0;
                                while (codes.length ? codeIndex < totalCodes : batchNumber === 0) {
                                    const batch = codes.length ? codes.slice(codeIndex, Math.min(codeIndex + fallbackSizes[fallbackIndex], totalCodes)) : [];
                                    const timings: Record<string, number> = {};
                                    let code15Retries = 0;
                                    batchNumber++;
                                    const bp = "[qlik-pw] (mois) lot " + batchNumber + " [" + codeIndex + "," + (codeIndex + batch.length) + ") size=" + batch.length;
                                    try {
                                        if (batch.length && fh !== -1) {
                                            await timed("clearCode", "Clear", () => rpc("Clear", {}, fh), timings);
                                            await sleep(qlikSettleMs);
                                            await timed("selectCode", "SelectValues", () => rpc("SelectValues", { qFieldValues: batch.map((c) => ({ qText: c })), qToggleMode: false, qSoftLock: true }, fh), timings);
                                            await sleep(qlikSettleMs);
                                        }
                                        const got = await timed("cube", "batch", () => fetchMonthCube(onRowMois, timings, () => { code15Retries++; }), timings);
                                        aggBatches++;
                                        aggCode15Retries += code15Retries;
                                        console.log("[qlik-pw][timing] " + bp + " — rows=" + got.value + " cumul=" + out.length + " retries15=" + code15Retries + " timings=" + timingSummary(timings));
                                        if (!codes.length) break;
                                        codeIndex += batch.length;
                                        fallbackIndex = 0;
                                    } catch (batchErr) {
                                        const nextSize = fallbackSizes[fallbackIndex + 1];
                                        if (codes.length && isEngineCode15(batchErr) && nextSize && batch.length > nextSize) {
                                            console.log("[qlik-pw] " + bp + " — fallback code15 " + batch.length + "→" + nextSize);
                                            fallbackIndex += 1;
                                            aggFallbackCount++;
                                            continue;
                                        }
                                        throw new Error(bp + " — " + String((batchErr as Error)?.message || batchErr));
                                    }
                                }
                            };

                            // Chemin rapide (flag QLIK_SELECT_ALL_CODES) : sélectionne TOUS les
                            // Article Code une seule fois, puis n'itère que la sélection Date par
                            // mois avec UN cube paginé (au lieu de re-sélectionner les codes par lots
                            // de 150 à chaque mois — la SelectValues répétée coûte ~22 s × 120).
                            // Renvoie true si le mois complet a réussi ; false si repli code 15 (les
                            // résultats partiels et sélections sont réinitialisés avant le chemin par lots).
                            const trySelectAllCodesPath = async (): Promise<boolean> => {
                                const savedLen = out.length;
                                try {
                                    if (codes.length && fh !== -1) {
                                        await timed("clearCodeAll", "Clear", () => rpc("Clear", {}, fh), {});
                                        await sleep(qlikSettleMs);
                                        const { value: sel } = await timed("selectCodeAll", "SelectValues", () => rpc("SelectValues", {
                                            qFieldValues: codes.map((c) => ({ qText: c })),
                                            qToggleMode: false,
                                            qSoftLock: true,
                                        }, fh), {});
                                        console.log("[qlik-pw] select-all — SelectValues Article Code (" + codes.length + " codes) → " + JSON.stringify(sel.qReturn));
                                        await sleep(qlikSettleMs);
                                    }
                                    const total = monthlyPayload.length;
                                    console.log("[qlik-pw] chemin rapide select-all — " + total + " mois, 1 sélection Article Code globale");
                                    for (let mi = 0; mi < total; mi++) {
                                        const m = monthlyPayload[mi];
                                        const prefix = "[qlik-pw] (rapide) mois " + (mi + 1) + "/" + total + " " + m.label + " (" + m.dateDebut + "→" + m.dateFin + ", " + m.serials.length + "j)";
                                        const monthStart = nowMs();
                                        const monthTimings: Record<string, number> = {};
                                        aggMonths = mi + 1;
                                        let code15Retries = 0;
                                        // Sélection Date du mois uniquement (la sélection Article Code reste active).
                                        const { value: dsel } = await timed("selectDate", "SelectValues", () => rpc("SelectValues", {
                                            qFieldValues: m.serials.map((s) => ({ qNum: s, qText: String(s) })),
                                            qToggleMode: false,
                                            qSoftLock: true,
                                        }, dfh), monthTimings);
                                        console.log(prefix + " — SelectValues Date " + m.serials.length + " serials → " + JSON.stringify(dsel.qReturn));
                                        await sleep(qlikSettleMs);
                                        // Un seul cube paginé pour tous les articles du mois.
                                        const batchRows: Array<Array<string | number>> = [];
                                        const { value: got, ms } = await timed("cube", "batch", () => fetchCubeForSelection(batchRows, monthTimings, () => { code15Retries++; }), monthTimings);
                                        out.push(...batchRows);
                                        accMonthly(batchRows, m.label);
                                        aggBatches++;
                                        aggCode15Retries += code15Retries;
                                        console.log("[qlik-pw][timing] " + prefix + " — rows=" + got + " cumul=" + out.length + " ms=" + ms + " retries15=" + code15Retries + " timings=" + timingSummary(monthTimings));
                                        // Clear Date uniquement — on garde la sélection Article Code pour le mois suivant.
                                        if (mi < total - 1) {
                                            try { await timed("clearDate", "Clear", () => rpc("Clear", {}, dfh), monthTimings); }
                                            catch (e) { console.log(prefix + " — Clear Date ignoré: " + String((e as Error)?.message || e)); }
                                        }
                                        console.log("[qlik-pw][timing] " + prefix + " — done ms=" + Math.round(nowMs() - monthStart) + " timings=" + timingSummary(monthTimings));
                                    }
                                    return true;
                                } catch (e) {
                                    if (isEngineCode15(e)) {
                                        console.log("[qlik-pw] chemin rapide échoué (code 15) → repli sur le chemin par lots");
                                        out.length = savedLen;
                                        for (const k of Object.keys(monthlyByCode)) delete monthlyByCode[k];
                                        aggMonths = 0; aggBatches = 0; aggCode15Retries = 0;
                                        try { await rpc("Clear", {}, dfh); if (fh !== -1) await rpc("Clear", {}, fh); } catch { /* noop */ }
                                        await sleep(qlikSettleMs);
                                        return false;
                                    }
                                    throw e;
                                }
                            };

                            // La passe de « rattrapage des mois vides » a été SUPPRIMÉE.
                            //
                            // Elle ré-extrayait un mois vide en ne sélectionnant que ses dates.
                            // Or les master measures ignorent la sélection Date : le cube lui
                            // renvoyait le total de période, qu'elle recopiait dans chacun des
                            // mois manquants. D'où les plateaux identiques d'août à décembre
                            // (87 648 sur douze mois pour un article, etc.) et les tendances
                            // « -162 % » qu'ils fabriquaient.
                            //
                            // Un mois qu'on ne sait pas extraire doit rester ABSENT.

                            /** Pousse l'état courant vers Node (voir `cfCheckpoint`). */
                            const pousserCheckpoint = async (etape: string) => {
                                try {
                                    const fn = (window as unknown as { cfCheckpoint?: (p: unknown) => Promise<unknown> }).cfCheckpoint;
                                    if (!fn) return;
                                    await fn({ rows: out, monthly: monthlyByCode });
                                    console.log("[qlik-pw] point de contrôle « " + etape + " » : " + out.length + " lignes");
                                } catch (e) {
                                    console.log("[qlik-pw] point de contrôle « " + etape + " » ignoré : " + String((e as Error)?.message || e));
                                }
                            };

                            if (!noDateMode) {
                                // ÉTAPE 0 — poser le périmètre articles, une fois pour toutes.
                                //
                                // Le code fournisseur FF (base SQL / API) existe aussi dans Qlik :
                                // une seule valeur y désigne le même périmètre que les dizaines de
                                // milliers de codes articles qu'on envoyait jusqu'ici. La bascule
                                // n'est retenue que si la couverture mesurée le justifie, sinon on
                                // retombe sur la sélection par codes (cf. selectionnerParFournisseur).
                                parFournisseur = await selectionnerParFournisseur();

                                const attendus = monthlyPayload.map((m) => m.label);
                                // Années de la fenêtre, la PLUS RÉCENTE D'ABORD — c'est l'usage de
                                // l'app (« je sélectionne 2026 »), et cela met les mois les plus
                                // utiles en tête des points de contrôle.
                                const annees = [...new Set(attendus.map((m) => Number(m.slice(0, 4))))].sort((a, b) => b - a);

                                // ÉTAPE 1 — caler le champ `Période` du modèle sur la fenêtre.
                                //
                                // Toutes les mesures de l'app sont bornées par `Type_Cal`
                                // (`Sum({<Type_Cal={'N'}>} quantite)`), lui-même piloté par
                                // `Période`. C'est cette sélection — et elle seule — qui détermine
                                // quels mois sont atteignables. Sous la période par défaut,
                                // « Quantité N » ne couvre que l'année en cours : d'où les mois
                                // d'août à décembre vides quelle que soit la sélection de dates.
                                const couvertureMaster = await choisirPeriode(annees);

                                // ÉTAPE 2 — extraire, puis REFUSER tout résultat incomplet.
                                //
                                // Un cache partiel est pire que pas de cache : il se lit comme des
                                // ventes nulles. Les deux chemins sont donc validés sur le même
                                // critère — les 12 mois de la fenêtre, ou rien.
                                const moisManquants = () => {
                                    const vus = new Set<string>();
                                    for (const parMois of Object.values(monthlyByCode)) {
                                        for (const [mois, v] of Object.entries(parMois)) {
                                            if ((v?.qte ?? 0) > 0) vus.add(mois);
                                        }
                                    }
                                    return attendus.filter((m) => !vus.has(m));
                                };
                                const couvre12 = () => moisManquants().length === 0;

                                // ÉTAPE 2 — extraire ANNÉE PAR ANNÉE, comme dans l'app.
                                //
                                // Dans l'interface, on sélectionne « 2026 » et on obtient l'année
                                // plus sa comparaison N-1. C'est le mécanisme natif du modèle :
                                // `Type_Cal='N'` désigne l'année sélectionnée. Il suffit donc
                                // d'enchaîner les années couvertes par la fenêtre — ici 2025 puis
                                // 2026 — pour reconstituer les 12 mois glissants.
                                //
                                // Chaque passe est faite SOUS la `Période` retenue : c'est elle qui
                                // donne son sens à `Type_Cal='N'`. Avec `Année=2025`, « Année à
                                // date » vaut l'année 2025 entière (elle est passée) ; avec
                                // `Année=2026`, elle s'arrête au mois courant. L'union des deux
                                // passes reconstitue donc bien les 12 mois glissants.
                                diag("extraction année par année : " + JSON.stringify(annees));

                                let extraitParAnnee = false;
                                if (monthDim) {
                                    try {
                                        for (const annee of annees) {
                                            const manquantsAvant = moisManquants();
                                            await monthDimPath(annee);
                                            const manquantsApres = moisManquants();
                                            const gagnes = manquantsAvant.filter((m) => !manquantsApres.includes(m));
                                            diag(
                                                "  année " + annee + " → mois de la fenêtre désormais servis : " + JSON.stringify(gagnes) +
                                                " ; encore manquants : " + JSON.stringify(manquantsApres),
                                            );
                                            await pousserCheckpoint("année " + annee);
                                            if (manquantsApres.length === 0) break; // fenêtre complète, inutile de continuer
                                        }
                                        extraitParAnnee = couvre12();
                                        if (!extraitParAnnee) {
                                            diag(
                                                "l'extraction année par année ne couvre pas les 12 mois (manquants : " +
                                                JSON.stringify(moisManquants()) + ") — essai de l'agrégation directe",
                                            );
                                        }
                                    } catch (e) {
                                        diag("extraction année par année interrompue : " + String((e as Error)?.message || e));
                                    }
                                }

                                // REPLI 1 — mois par mois sur le champ date brut.
                                //
                                // Passe en premier car c'est le seul chemin sans pont de périodes :
                                // aucun mois n'y est « inatteignable », puisqu'un mois y est un
                                // filtre de dates et non un contexte de calendrier.
                                if (!extraitParAnnee && useExpr) {
                                    try {
                                        if (await moisParDateBrute()) {
                                            extraitParAnnee = couvre12();
                                            if (extraitParAnnee) {
                                                diag("extraction par date brute retenue — les " + attendus.length + " mois sont servis");
                                                await pousserCheckpoint("date brute complète");
                                            } else {
                                                diag("extraction par date brute incomplète (manquants : " + JSON.stringify(moisManquants()) + ")");
                                            }
                                        }
                                    } catch (e) {
                                        diag("extraction par date brute interrompue : " + String((e as Error)?.message || e));
                                    }
                                }

                                if (!extraitParAnnee) {
                                    if (!(monthDim && useExpr && (await moisParExpressions()))) {
                                        throw new Error(
                                            "extraction 12 mois refusée : ni l'extraction année par année " +
                                            "(couverture master annoncée = " + couvertureMaster + "/" + attendus.length + ") " +
                                            "ni l'agrégation directe des faits n'ont couvert la fenêtre — mois manquants : " +
                                            JSON.stringify(moisManquants()),
                                        );
                                    }
                                    await pousserCheckpoint("expressions vérifiées");
                                }

                                if (!couvre12()) {
                                    throw new Error(
                                        "extraction 12 mois refusée : la fenêtre " + JSON.stringify(attendus) +
                                        " n'est pas entièrement couverte (manquants : " + JSON.stringify(moisManquants()) +
                                        ") — cache laissé inchangé",
                                    );
                                }
                            } else if (noDateMode) {
                                // Aucun filtre Date : extraction en un seul appel (tous les codes d'un coup).
                                // On sélectionne uniquement Article Code ; Date reste libre.
                                const timings: Record<string, number> = {};
                                let code15Retries = 0;
                                console.log("mode sans dateFilter — sélection de " + codes.length + " codes en une fois");
                                if (codes.length && fh !== -1) {
                                    const { value: sel } = await timed("selectCode", "SelectValues", () => rpc("SelectValues", { qFieldValues: codes.map((c) => ({ qText: c })), qToggleMode: false, qSoftLock: true }, fh), timings);
                                    console.log("SelectValues Article Code → " + JSON.stringify(sel.qReturn));
                                }
                                const batchRows: Array<Array<string | number>> = [];
                                const { value: got, ms } = await timed("cube", "batch", () => fetchCubeForSelection(batchRows, timings, () => { code15Retries++; }), timings);
                                out.push(...batchRows);
                                aggMonths = 1;
                                aggBatches = 1;
                                aggCode15Retries = code15Retries;
                                console.log("[qlik-pw][timing] noDate rows=" + got + " cumul=" + out.length + " ms=" + ms + " retries15=" + code15Retries + " timings=" + timingSummary(timings));
                            } else if (selectAllCodes && (await trySelectAllCodesPath())) {
                                // Chemin rapide terminé avec succès (voir trySelectAllCodesPath).
                                // Si false (repli code 15), on tombe dans le chemin par lots ci-dessous.
                            } else {
                                // Itération par mois × lots de codes : pour chaque mois, SelectValues Date
                                // (~30 serials), puis SelectValues Article Code par petits lots. Le cube
                                // reste borné à ~30 jours × batch contrôlé, sans lire tout le catalogue Qlik.
                                const total = monthlyPayload.length;
                                const fallbackSizes = qlikArticleBatchFallbacks.length ? qlikArticleBatchFallbacks : [150, 75, 50];
                                const fallbackLabel = fallbackSizes.join(">");
                                const estimatedBatches = codes.length ? Math.ceil(codes.length / fallbackSizes[0]) : 1;
                                console.log("itération par mois — " + total + " mois × ~" + estimatedBatches + " lot(s), batchFallbacks=" + fallbackLabel);
                                for (let mi = 0; mi < total; mi++) {
                                    const m = monthlyPayload[mi];
                                    const prefix = "[qlik-pw] mois " + (mi + 1) + "/" + total + " " + m.label + " (" + m.dateDebut + "→" + m.dateFin + ", " + m.serials.length + "j)";
                                    const monthStart = nowMs();
                                    const monthTimings: Record<string, number> = {};
                                    aggMonths = mi + 1;
                                    try {
                                        // 1) Sélection Date pour le mois (un seul SelectValues, ~30 valeurs).
                                        const { value: dsel } = await timed("selectDate", "SelectValues", () => rpc("SelectValues", {
                                            qFieldValues: m.serials.map((s) => ({ qNum: s, qText: String(s) })),
                                            qToggleMode: false,
                                            qSoftLock: true,
                                        }, dfh), monthTimings);
                                        console.log(prefix + " — SelectValues Date " + m.serials.length + " serials → " + JSON.stringify(dsel.qReturn));
                                        // Laisser l'Engine finaliser l'évaluation de la sélection Date
                                        // avant la première SelectValues Article Code du 1er lot.
                                        await sleep(qlikSettleMs);

                                        // 2) Sélection Article Code par lots contrôlés.
                                        let codeIndex = 0;
                                        let batchNumber = 0;
                                        let fallbackIndex = 0;
                                        const totalCodes = codes.length || 0;
                                        while (codes.length ? codeIndex < totalCodes : batchNumber === 0) {
                                            const batchSize = codes.length ? fallbackSizes[fallbackIndex] : 0;
                                            const batch = codes.length ? codes.slice(codeIndex, Math.min(codeIndex + batchSize, totalCodes)) : [];
                                            const batchStart = codeIndex;
                                            const batchEnd = codeIndex + batch.length;
                                            const timings: Record<string, number> = {};
                                            let code15Retries = 0;
                                            batchNumber++;
                                            const batchPrefix = prefix + " — lot " + batchNumber + " [" + batchStart + "," + batchEnd + ") size=" + batch.length;
                                            try {
                                                if (fh !== -1) {
                                                    await timed("clearCode", "Clear", () => rpc("Clear", {}, fh), timings);
                                                    // Laisser l'Engine appliquer le Clear avant la nouvelle sélection.
                                                    await sleep(qlikSettleMs);
                                                    const { value: csel } = await timed("selectCode", "SelectValues", () => rpc("SelectValues", {
                                                        qFieldValues: batch.map((c) => ({ qText: c })),
                                                        qToggleMode: false,
                                                        qSoftLock: true,
                                                    }, fh), timings);
                                                    console.log(batchPrefix + " — SelectValues Article Code → " + JSON.stringify(csel.qReturn));
                                                    // Laisser l'Engine finaliser l'évaluation de la sélection
                                                    // avant de créer / interroger le cube (évite code 15 sur le 1er lot).
                                                    await sleep(qlikSettleMs);
                                                }
                                                const batchRows: Array<Array<string | number>> = [];
                                                const { value: got, ms } = await timed("cube", "batch", () => fetchCubeForSelection(batchRows, timings, () => { code15Retries++; }), timings);
                                                out.push(...batchRows);
                                                accMonthly(batchRows, m.label);
                                                aggBatches++;
                                                aggCode15Retries += code15Retries;
                                                console.log("[qlik-pw][timing] " + batchPrefix + " — rows=" + got + " cumul=" + out.length + " ms=" + ms + " retries15=" + code15Retries + " timings=" + timingSummary(timings));
                                                if (!codes.length) break;
                                                codeIndex = batchEnd;
                                                fallbackIndex = 0;
                                            } catch (batchErr) {
                                                const msg = String((batchErr as Error)?.message || batchErr);
                                                const nextFallbackIndex = fallbackIndex + 1;
                                                const nextSize = fallbackSizes[nextFallbackIndex];
                                                if (codes.length && isEngineCode15(batchErr) && nextSize && batch.length > nextSize) {
                                                    console.log("[qlik-pw][timing] " + batchPrefix + " — fallback code15 " + batch.length + "→" + nextSize + " retries15=" + code15Retries + " timings=" + timingSummary(timings));
                                                    fallbackIndex = nextFallbackIndex;
                                                    aggFallbackCount++;
                                                    continue;
                                                }
                                                console.error(batchPrefix + " — ABORT — " + msg);
                                                throw new Error(batchPrefix + " — " + msg);
                                            }
                                        }
                                    } catch (monthErr) {
                                        const msg = String((monthErr as Error)?.message || monthErr);
                                        console.error(prefix + " — ABORT — " + msg);
                                        throw new Error(prefix + " — " + msg);
                                    }
                                    // 3) Clear Date + Article Code avant le mois suivant (soulage l'Engine).
                                    if (mi < total - 1) {
                                        try {
                                            await timed("clearDate", "Clear", () => rpc("Clear", {}, dfh), monthTimings);
                                            if (fh !== -1) await timed("clearCodeMonth", "Clear", () => rpc("Clear", {}, fh), monthTimings);
                                        } catch (clearErr) {
                                            console.log(prefix + " — Clear ignoré: " + String((clearErr as Error)?.message || clearErr));
                                        }
                                    }
                                    console.log("[qlik-pw][timing] " + prefix + " — done ms=" + Math.round(nowMs() - monthStart) + " cumul=" + out.length + " timings=" + timingSummary(monthTimings));
                                }
                            }

                            // La sonde de diagnostic du cube [Article Code, Mois] a été retirée :
                            // elle refaisait une sélection complète des codes et des 365 jours en
                            // fin de sync (des dizaines de secondes) alors que le découpage
                            // mensuel est validé et en production depuis.

                            ws.close();
                            resolve({ ok: true, rows: out, monthly: monthlyByCode, size: out.length, months: aggMonths, batches: aggBatches, code15Retries: aggCode15Retries, fallbackCount: aggFallbackCount, diagExpr: diagnostics });
                        } catch (e) {
                            try { ws.close(); } catch { /* noop */ }
                            // On remonte ce qui a été extrait : les codes déjà traités ont
                            // toutes leurs données, seul le reliquat manque.
                            resolve({ ok: false, error: String((e as Error)?.message || e), rows: out, monthly: monthlyByCode, size: out.length, diagExpr: diagnostics });
                        }
                    })();
                }),
            {
                app: cfg.appNetwork,
                dim: cfg.dimCodeArticleId,
                mca: cfg.measCaId,
                mqte: cfg.measQteId,
                mnb: cfg.measNbMagId,
                mcamag: cfg.measCaMagId,
                mmarge: cfg.measMargePctId,
                codes: codeCentraux ?? [],
                token: jeton,
                monthlyPayload,
                noDateMode: !dateFilter,
                qlikSettleMs,
                qlikCode15MaxAttempts,
                qlikArticleBatchFallbacks,
                selectAllCodes: qlikSelectAllCodes,
                monthDim: qlikMonthDim,
                moisDimId: qlikMoisDimId,
                mqteComp: qlikMeasQteCompId,
                yearN,
                useExpr: qlikUseExpr,
                exprQte: qlikExprQte,
                exprCa: qlikExprCa,
                exprNbMag: qlikExprNbMag,
                exprMarge: qlikExprMarge,
                champsDateCandidats: qlikDateFields,
                fournisseurCode: (fournisseur ?? "").trim(),
                champsFournisseurCandidats: qlikSupplierFields,
                couvertureFournisseurMin: qlikSupplierMinCoverage,
            },
        );

        // Reprise globale sur erreur transitoire.
        //
        // Le moteur Qlik abandonne les requêtes longues quand il est chargé
        // (« code 15 / Request aborted »). Observé sur un même fournisseur, avec
        // le même code : réussite à 4 h du matin (OpenDoc en 78 s), échec à 6 h
        // (OpenDoc en 233 s, puis abandon). Les reprises par requête de
        // `rpcWithRetry` ne suffisent pas — c'est toute l'extraction qui tombe.
        //
        // La pause est volontairement longue : relancer aussitôt ne ferait
        // qu'ajouter de la charge au serveur qui vient déjà de renoncer.
        const extractionEssais = 1 + envNumber("QLIK_EXTRACTION_RETRIES", 1, 0, 3);
        const extractionPauseMs = envNumber("QLIK_EXTRACTION_RETRY_PAUSE_MS", 60_000, 0, 600_000);
        const estTransitoire = (m: string) => /"code"\s*:\s*15\b/.test(m) || /request aborted/i.test(m);
        const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

        let result: InPageResult;
        let essai = 0;
        for (;;) {
            essai++;
            const reste = essai < extractionEssais;
            try {
                const candidat = (await evaluer()) as InPageResult;
                if (candidat.ok || !reste || !estTransitoire(String(candidat.error ?? ""))) {
                    result = candidat;
                    break;
                }
                console.warn(
                    `[qlik-pw] tentative ${essai}/${extractionEssais} abandonnée par le moteur (${String(candidat.error).slice(0, 160)})`
                    + ` — nouvelle tentative dans ${Math.round(extractionPauseMs / 1000)} s`,
                );
            } catch (e) {
                const msg = String((e as Error)?.message || e);
                if (reste && estTransitoire(msg)) {
                    console.warn(
                        `[qlik-pw] tentative ${essai}/${extractionEssais} interrompue (${msg.slice(0, 160)})`
                        + ` — nouvelle tentative dans ${Math.round(extractionPauseMs / 1000)} s`,
                    );
                } else {
                    // Comportement d'origine, une fois les reprises épuisées.
                    // Une fenêtre 12 mois n'est publiable que si l'extraction est
                    // complète et a passé tous les contrôles. Conserver un checkpoint
                    // partiel fabriquerait précisément des graphiques à 2 ou 3 mois.
                    if (dateFilter) {
                        throw new Error(`[qlik-pw] extraction 12 mois interrompue, cache inchangé : ${msg}`);
                    }
                    const secours = checkpoint as { rows?: Array<Array<string | number>>; monthly?: InPageResult["monthly"] } | null;
                    if (secours?.rows?.length) {
                        console.error(`[qlik-pw] extraction interrompue (${msg.slice(0, 200)}) — reprise du dernier point de contrôle : ${secours.rows.length} lignes`);
                        result = { ok: true, rows: secours.rows, monthly: secours.monthly, size: secours.rows.length, partiel: true };
                        break;
                    }
                    throw e;
                }
            }
            checkpoint = null; // la nouvelle tentative repart d'une extraction vierge
            await pause(extractionPauseMs);
        }

        if (!result.ok) {
            if (dateFilter) {
                throw new Error(`[qlik-pw] extraction 12 mois refusée, cache inchangé : ${result.error}`);
            }
            // Même logique qu'un crash : un résultat partiel vaut mieux que rien.
            if (result.rows?.length) {
                console.error(`[qlik-pw] extraction en échec (${String(result.error).slice(0, 200)}) — ${result.rows.length} lignes déjà extraites conservées`);
                result = { ...result, ok: true, partiel: true };
            } else {
                throw new Error(`[qlik-pw] ${result.error}`);
            }
        }
        if (result.partiel) {
            if (dateFilter) {
                throw new Error("[qlik-pw] extraction 12 mois partielle refusée, cache inchangé");
            }
            console.warn("[qlik-pw] ⚠ résultat PARTIEL : certains codes n'ont pas été extraits, relancer la sync pour compléter");
        }

        // Résumé timing final : synthèse compacte de la sync pour audit/debug.
        // Les logs détaillés par étape restent en place (timings batch/mois) ;
        // ici on consolide les compteurs agrégés et la durée totale.
        const totalMs = Date.now() - totalStart;
        if (result.diagExpr?.length) {
            console.log("[qlik-pw][diag] ─── diagnostic du chemin par expressions ───");
            for (const d of result.diagExpr) console.log("[qlik-pw][diag] " + d);
        }
        console.log(
            `[qlik-pw][summary] rows=${result.size ?? 0} months=${result.months ?? 0} batches=${result.batches ?? 0} code15Retries=${result.code15Retries ?? 0} fallbackCount=${result.fallbackCount ?? 0} totalMs=${totalMs}`,
        );

        const wanted = codeCentraux ? new Set(codeCentraux) : null;
        const out = new Map<string, NetworkMetric>();
        const margeWeight = new Map<string, number>();
        for (const r of result.rows ?? []) {
            const code = String(r[0]).trim();
            if (!code || code === "-") continue;
            if (wanted && !wanted.has(code)) continue;

            const ca = Number(r[1]) || 0;
            const qte = Number(r[2]) || 0;
            const nbMag = Number(r[3]) || 0;
            const margePct = Number(r[5]) || 0;
            const prev = out.get(code);
            if (!prev) {
                out.set(code, {
                    codeCentrale: code,
                    caReseau: ca,
                    qteReseau: qte,
                    nbMagasinsReseau: nbMag,
                    caParMagasinReseau: nbMag > 0 ? ca / nbMag : 0,
                    margePctReseau: margePct,
                    periode: dateFilter?.label,
                });
                margeWeight.set(code, ca);
                continue;
            }

            prev.caReseau += ca;
            prev.qteReseau += qte;
            prev.nbMagasinsReseau = Math.max(prev.nbMagasinsReseau, nbMag);
            const weight = margeWeight.get(code) ?? 0;
            const nextWeight = weight + ca;
            prev.margePctReseau = nextWeight > 0 ? ((prev.margePctReseau * weight) + (margePct * ca)) / nextWeight : Math.max(prev.margePctReseau, margePct);
            prev.caParMagasinReseau = prev.nbMagasinsReseau > 0 ? prev.caReseau / prev.nbMagasinsReseau : 0;
            margeWeight.set(code, nextWeight);
        }
        // Rattache le détail mensuel (par code central) au métrique agrégé.
        // On produit DEUX représentations :
        //   - `qteByMonth`  : { "YYYY-MM": qté } — format historique, dont dépend la
        //                     colonne « Tendance / Réseau » de la Grille. Inchangé.
        //   - `metricsByMonth` : toutes les mesures du mois, pour la fiche produit.
        const monthly = result.monthly ?? {};

        // Mois RÉELLEMENT couverts par l'extraction = union des mois vus sur
        // l'ensemble des codes. Distinguer « couvert, zéro vente » de « non
        // extrait » est indispensable : sans cela, un article vendu seulement
        // depuis mai voyait sa tendance calculée sur deux points (« +4 100 % »),
        // et un mois non extrait passait pour une absence de vente.
        const couverts = new Set<string>();
        for (const parMois of Object.values(monthly)) {
            for (const mois of Object.keys(parMois)) couverts.add(mois);
        }
        const moisCouverts = [...couverts].sort();
        console.log(`[qlik-pw] mois couverts par l'extraction (${moisCouverts.length}) : ${JSON.stringify(moisCouverts)}`);

        for (const [code, metric] of out) {
            const mm = monthly[code] ?? {};
            const qteByMonth: Record<string, number> = {};
            const metricsByMonth: Record<string, QlikMonthMetrics> = {};
            for (const mois of moisCouverts) {
                const v = mm[mois];
                // Zéro EXPLICITE sur un mois couvert sans vente : c'est une
                // information, au même titre qu'une vente. Un mois non couvert
                // reste absent et sera ignoré par la tendance.
                qteByMonth[mois] = Number(v?.qte) || 0;
                // ⚠️ Toutes les mesures à zéro, pas seulement la quantité. Écrire
                // `{ qte: 0 }` seul laissait `nbMag` absent sur les mois sans
                // vente : la courbe « magasins vendeurs » exigeant les 12 mois,
                // elle disparaissait dès qu'un produit avait un mois creux.
                metricsByMonth[mois] = v ?? { qte: 0, ca: 0, nbMag: 0, caMag: 0, margePct: 0 };
            }
            metric.qteByMonth = qteByMonth;
            metric.metricsByMonth = metricsByMonth;
        }
        // Diagnostic CONCLUSIF : combien de codes ont des mois qui VARIENT vs identiques.
        // Si presque tous varient → la mesure respecte le mois (feature OK).
        // Si tous identiques → la mesure Qlik ignore la sélection Date.
        let nVar = 0, nFlat = 0;
        let exVar: NetworkMetric | null = null, exFlat: NetworkMetric | null = null;
        for (const m of out.values()) {
            const bm = m.qteByMonth;
            if (!bm) continue;
            const vals = Object.values(bm);
            if (vals.length < 2) continue;
            const allEq = vals.every((v) => v === vals[0]);
            if (allEq) { nFlat++; if (!exFlat) exFlat = m; }
            else { nVar++; if (!exVar) exVar = m; }
        }
        console.log(`[qlik-pw] qteByMonth distribution: ${nVar} codes VARIENT / ${nFlat} identiques (total ${nVar + nFlat})`);
        if (exVar) console.log(`[qlik-pw] exemple VARIE ${exVar.codeCentrale}:`, JSON.stringify(exVar.qteByMonth));
        if (exFlat) console.log(`[qlik-pw] exemple IDENTIQUE ${exFlat.codeCentrale}:`, JSON.stringify(exFlat.qteByMonth));
        console.log(`[qlik-pw] ${out.size} produits réseau (cube ${result.size})`);
        // Échantillon brut pour vérifier que les 4 nouvelles mesures (cols 4-7) renvoient des valeurs
        const sample = (result.rows ?? []).slice(0, 3).map((r) => ({
            code: r[0], ca: r[1], qte: r[2], nbMag: r[3], caMag: r[4], margePct: r[5],
        }));
        console.log(`[qlik-pw] échantillon lignes:`, JSON.stringify(sample));
        return out;
    } finally {
        await ctx.close();
    }
}
