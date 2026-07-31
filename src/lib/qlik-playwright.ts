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
import { getQlikConfig, qlikNtlmSession, type QlikConfig, type NetworkMetric } from "@/lib/qlik-client";
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
    diag?: Record<string, unknown>;
    // Compteurs agrégés pour le résumé timing final côté Node (cf. qlik-playwright).
    months?: number;
    batches?: number;
    code15Retries?: number;
    fallbackCount?: number;
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
    const yearN = new Date().getFullYear();
    console.log(`[qlik-pw] tuning settle=${qlikSettleMs}ms code15Attempts=${qlikCode15MaxAttempts} batchFallbacks=${qlikArticleBatchFallbacks.join(">")} selectAllCodes=${qlikSelectAllCodes} monthDim=${qlikMonthDim}`);

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
        console.log(`[qlik-pw] csrf-token capturé, ouverture du websocket Engine in-page…`);

        // Pré-calcul des mois côté Node (pour pouvoir logger X/Y et propager au script in-page).
        const monthRanges: QlikDateFilter[] = dateFilter ? getMonthRanges(dateFilter) : [];
        const monthlyPayload = monthRanges.map((m) => ({
            label: m.label,
            dateDebut: m.dateDebut,
            dateFin: m.dateFin,
            serials: m.dailySerials, // ~30 valeurs → SelectValues en une fois
        }));

        const result = (await page.evaluate(
            ({ app, dim, mca, mqte, mnb, mcamag, mmarge, codes, token, monthlyPayload, noDateMode, qlikSettleMs, qlikCode15MaxAttempts, qlikArticleBatchFallbacks, selectAllCodes, monthDim, moisDimId, mqteComp, yearN }: {
                app: string; dim: string; mca: string; mqte: string; mnb: string; mcamag: string; mmarge: string;
                codes: string[]; token: string;
                monthlyPayload: Array<{ label: string; dateDebut: string; dateFin: string; serials: number[] }>;
                noDateMode: boolean;
                qlikSettleMs: number;
                qlikCode15MaxAttempts: number;
                qlikArticleBatchFallbacks: number[];
                selectAllCodes: boolean;
                monthDim: boolean;
                moisDimId: string;
                mqteComp: string;
                yearN: number;
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
                    const fail = (error: string) => resolve({ ok: false, error });
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
                            const df = await rpc("GetField", { qFieldName: "Date" }, doc);
                            dfh = (df.qReturn as { qHandle: number }).qHandle;
                            try {
                                const yf = await rpc("GetField", { qFieldName: "Année" }, doc);
                                yfh = (yf.qReturn as { qHandle: number }).qHandle;
                            } catch { yfh = -1; }
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

                            const out: Array<Array<string | number>> = [];
                            // Quantité réseau par code central et par mois (label "YYYY-MM").
                            // Accumulée en parallèle du total, sans toucher l'agrégation existante.
                            const monthlyByCode: Record<string, Record<string, { qte: number; ca?: number; nbMag?: number; caMag?: number; margePct?: number }>> = {};
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

                            // Sélectionne toute la fenêtre de dates une fois, puis parcourt les codes par
                            // lots ; un seul cube [Article Code, Mois] par lot donne TOUS les mois d'un coup.
                            // selectYear = null → passe principale (année N + N-1 dérivée via COMP).
                            // selectYear = 2025 → passe complémentaire : on sélectionne l'année pour
                            // récupérer directement ses mois (seul moyen d'obtenir août→déc N-1, que
                            // COMP ne peut pas fournir puisque l'année N ne va pas jusque-là).
                            let loggedSampleRow = false;
                            const monthDimPath = async (selectYear: number | null): Promise<void> => {
                                const isMainPass = selectYear === null;
                                if (yfh !== -1) {
                                    await rpc("Clear", {}, yfh);
                                    await sleep(qlikSettleMs);
                                    if (selectYear !== null) {
                                        const ysel = await rpc("SelectValues", { qFieldValues: [{ qNum: selectYear, qText: String(selectYear) }], qToggleMode: false, qSoftLock: true }, yfh);
                                        console.log("[qlik-pw] (mois) sélection Année=" + selectYear + " → " + JSON.stringify(ysel.qReturn));
                                        await sleep(qlikSettleMs);
                                    }
                                }
                                const allSerials = monthlyPayload.flatMap((m) => m.serials);
                                if (dfh !== -1 && allSerials.length) {
                                    await rpc("Clear", {}, dfh);
                                    await sleep(qlikSettleMs);
                                    await rpc("SelectValues", { qFieldValues: allSerials.map((s) => ({ qNum: s, qText: String(s) })), qToggleMode: false, qSoftLock: true }, dfh);
                                    await sleep(qlikSettleMs);
                                }
                                aggMonths = monthlyPayload.length;
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
                                        const got = await timed("cube", "batch", () => fetchMonthCube((code, mois, ca, qte, nbMag, caMag, marge, qteComp) => {
                                            if (!code || code === "-") return;
                                            // Les totaux réseau ne viennent QUE de la passe principale
                                            // (sinon on doublerait CA/Qté avec la passe N-1).
                                            if (isMainPass) out.push([code, ca, qte, nbMag, caMag, marge]);
                                            const mm = normMois(mois);
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
                                            if (isMainPass && y === yearN) {
                                                // Mois de l'année N + son comparable N-1 (COMP = même mois, N-1).
                                                monthlyByCode[code][mm] = full;
                                                const mmPrev = String(y - 1) + mm.slice(4); // "2026-03" → "2025-03"
                                                // COMP ne porte QUE la quantité : les autres mesures restent
                                                // absentes tant que la passe N-1 ne les a pas complétées.
                                                // On n'écrit rien si COMP est vide : un mois ABSENT peut être
                                                // rattrapé plus tard, un mois à 0 se lit comme « pas de vente »
                                                // et masque définitivement le trou d'extraction.
                                                if (monthlyByCode[code][mmPrev] === undefined && qteComp > 0) {
                                                    monthlyByCode[code][mmPrev] = { qte: qteComp };
                                                }
                                            } else if (!isMainPass) {
                                                // Passe année sélectionnée : valeurs directes, prioritaires sur COMP.
                                                monthlyByCode[code][mm] = full;
                                            } else if (qte > 0 || ca > 0) {
                                                // Passe principale, mois HORS année N : « Quantité N » n'est pas
                                                // censée le couvrir. Écrire son 0 fabriquerait une absence de
                                                // vente là où il n'y a qu'une mesure hors périmètre.
                                                monthlyByCode[code][mm] = full;
                                            }
                                        }, timings, () => { code15Retries++; }), timings);
                                        aggBatches++;
                                        aggCode15Retries += code15Retries;
                                        console.log("[qlik-pw][timing] " + bp + " — rows=" + got + " cumul=" + out.length + " retries15=" + code15Retries + " timings=" + timingSummary(timings));
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

                            /**
                             * Rattrapage des mois RESTÉS VIDES pour tous les articles.
                             *
                             * Les mesures « N » de l'app sont bornées à une année : quand la
                             * fenêtre 12 mois glissants chevauche deux années civiles, les mois
                             * de l'année précédente non couverts par « Quantité COMP » ressortent
                             * vides — cinq mois d'affilée à 0 sur TOUS les articles, ce qui n'a
                             * aucun sens métier.
                             *
                             * La parade fiable est de ne sélectionner QUE les dates du mois
                             * concerné : la mesure se résout alors sur la bonne année, quelle que
                             * soit la façon dont son set analysis est écrit. On ne le fait que
                             * pour les mois réellement vides — au pire quelques cubes de plus.
                             */
                            const rattraperMoisVides = async (): Promise<void> => {
                                const moisRenseignes = new Set<string>();
                                for (const parMois of Object.values(monthlyByCode)) {
                                    for (const [mois, v] of Object.entries(parMois)) {
                                        if ((v?.qte ?? 0) > 0) moisRenseignes.add(mois);
                                    }
                                }
                                const manquants = monthlyPayload.filter((m) => !moisRenseignes.has(m.label));
                                if (manquants.length === 0) return;
                                console.log(
                                    "[qlik-pw] (mois) " + manquants.length + " mois vide(s) sur tous les articles : " +
                                    JSON.stringify(manquants.map((m) => m.label)) + " → passe de rattrapage mois par mois",
                                );

                                for (const m of manquants) {
                                    const prefix = "[qlik-pw] (rattrapage) " + m.label;
                                    try {
                                        // Année libre : c'est la sélection de dates qui doit
                                        // déterminer l'année vue par la mesure.
                                        if (yfh !== -1) { await rpc("Clear", {}, yfh); await sleep(qlikSettleMs); }
                                        await rpc("Clear", {}, dfh);
                                        await sleep(qlikSettleMs);
                                        await rpc("SelectValues", {
                                            qFieldValues: m.serials.map((s2) => ({ qNum: s2, qText: String(s2) })),
                                            qToggleMode: false,
                                            qSoftLock: true,
                                        }, dfh);
                                        await sleep(qlikSettleMs);

                                        const tailles = [300, 150, 75];
                                        let idx = 0, tailleIdx = 0;
                                        const total = codes.length;
                                        while (codes.length ? idx < total : tailleIdx === 0) {
                                            const lot = codes.length ? codes.slice(idx, Math.min(idx + tailles[tailleIdx], total)) : [];
                                            try {
                                                if (lot.length && fh !== -1) {
                                                    await rpc("Clear", {}, fh);
                                                    await sleep(qlikSettleMs);
                                                    await rpc("SelectValues", { qFieldValues: lot.map((c) => ({ qText: c })), qToggleMode: false, qSoftLock: true }, fh);
                                                    await sleep(qlikSettleMs);
                                                }
                                                const batchRows: Array<Array<string | number>> = [];
                                                await fetchCubeForSelection(batchRows);
                                                // Uniquement le mensuel : les totaux réseau restent ceux
                                                // de la passe principale, sinon on les doublerait.
                                                accMonthly(batchRows, m.label);
                                                if (!codes.length) break;
                                                idx += lot.length;
                                                tailleIdx = 0;
                                            } catch (lotErr) {
                                                const suivante = tailles[tailleIdx + 1];
                                                if (codes.length && isEngineCode15(lotErr) && suivante && lot.length > suivante) {
                                                    tailleIdx += 1;
                                                    continue;
                                                }
                                                throw lotErr;
                                            }
                                        }
                                        const remplis = Object.values(monthlyByCode).filter((x) => (x[m.label]?.qte ?? 0) > 0).length;
                                        console.log(prefix + " — " + remplis + " article(s) renseigné(s)");
                                    } catch (e) {
                                        console.error(prefix + " — échec : " + String((e as Error)?.message || e));
                                    }
                                }
                            };

                            if (!noDateMode && monthDim) {
                                // Découpage mensuel réel (dimension Mois) — remplace l'itération par mois.
                                console.log("[qlik-pw] extraction via dimension Mois (" + monthlyPayload.length + " mois attendus, moisDim=" + moisDimId + ")");
                                await monthDimPath(null);
                                // Passe complémentaire : mois de l'année N-1 absents de l'année N
                                // (ex. août→déc), impossibles à obtenir via COMP. On sélectionne
                                // l'année N-1 pour que les mesures "N" portent sur cette année.
                                if (yfh !== -1) {
                                    const before = Object.values(monthlyByCode).reduce((s, m) => s + Object.keys(m).length, 0);
                                    try {
                                        await monthDimPath(yearN - 1);
                                        const after = Object.values(monthlyByCode).reduce((s, m) => s + Object.keys(m).length, 0);
                                        console.log("[qlik-pw] (mois) passe N-1 terminée : " + before + " → " + after + " points mensuels");
                                    } catch (e2) {
                                        console.log("[qlik-pw] (mois) passe N-1 ignorée: " + String((e2 as Error)?.message || e2));
                                    }
                                    try { await rpc("Clear", {}, yfh); } catch { /* noop */ }
                                } else {
                                    console.log("[qlik-pw] (mois) champ Année introuvable → pas de passe N-1");
                                }
                                await rattraperMoisVides();
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

                            // SONDE (à la FIN pour apparaître dans la queue du log) : sélectionne ~50
                            // codes + la fenêtre 12 mois, puis crée un petit cube [Article Code, Mois]
                            // × Quantité N. Montre le FORMAT des valeurs "Mois" et si la quantité VARIE
                            // par mois, pour concevoir le vrai découpage mensuel.
                            try {
                                const moisDimId = "pfGAwTs";
                                const probeCodes = (codes ?? []).slice(0, 50);
                                if (fh !== -1 && probeCodes.length) {
                                    await rpc("Clear", {}, fh);
                                    await rpc("SelectValues", { qFieldValues: probeCodes.map((c) => ({ qText: c })), qToggleMode: false, qSoftLock: true }, fh);
                                }
                                const allSerials = monthlyPayload.flatMap((m) => m.serials);
                                if (dfh !== -1 && allSerials.length) {
                                    await rpc("SelectValues", { qFieldValues: allSerials.map((s) => ({ qNum: s, qText: String(s) })), qToggleMode: false, qSoftLock: true }, dfh);
                                }
                                await sleep(qlikSettleMs);
                                const probe = await rpc("CreateSessionObject", { qProp: { qInfo: { qType: "cf-probe" }, qHyperCubeDef: {
                                    qDimensions: [{ qLibraryId: dim }, { qLibraryId: moisDimId }],
                                    qMeasures: [{ qLibraryId: mqte }],
                                    qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 3, qHeight: 40 }],
                                } } }, doc);
                                const pRet = probe.qReturn as { qHandle: number; qGenericId?: string; qId?: string };
                                const pl = await rpc("GetLayout", {}, pRet.qHandle);
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                const hc = (pl.qLayout as any)?.qHyperCube;
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                const matrix: any[] = hc?.qDataPages?.[0]?.qMatrix ?? [];
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                const sample = matrix.slice(0, 40).map((row: any[]) => [row[0]?.qText, row[1]?.qText, row[2]?.qNum]);
                                console.log("[qlik-pw][probe] cube [Article Code, Mois] x Quantite N — size=" + (hc?.qSize?.qcy ?? "?") + " echantillon: " + JSON.stringify(sample));
                                try { await rpc("DestroySessionObject", { qId: String(pRet.qGenericId ?? pRet.qId ?? "") }, doc); } catch { /* noop */ }
                            } catch (e) { console.log("[qlik-pw][probe] error: " + String((e as Error)?.message || e)); }

                            ws.close();
                            resolve({ ok: true, rows: out, monthly: monthlyByCode, size: out.length, months: aggMonths, batches: aggBatches, code15Retries: aggCode15Retries, fallbackCount: aggFallbackCount });
                        } catch (e) { try { ws.close(); } catch { /* noop */ } fail(String((e as Error)?.message || e)); }
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
                token: csrfToken,
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
            },
        )) as InPageResult;

        if (!result.ok) throw new Error(`[qlik-pw] ${result.error}`);

        // Résumé timing final : synthèse compacte de la sync pour audit/debug.
        // Les logs détaillés par étape restent en place (timings batch/mois) ;
        // ici on consolide les compteurs agrégés et la durée totale.
        const totalMs = Date.now() - totalStart;
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
        for (const [code, metric] of out) {
            const mm = monthly[code];
            if (!mm || Object.keys(mm).length === 0) continue;
            const qteByMonth: Record<string, number> = {};
            for (const [mois, v] of Object.entries(mm)) {
                qteByMonth[mois] = Number(v?.qte) || 0;
            }
            metric.qteByMonth = qteByMonth;
            metric.metricsByMonth = mm;
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
