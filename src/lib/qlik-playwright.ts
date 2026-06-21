/**
 * CollectFlow — Extraction Qlik via Playwright (Chromium headless).
 *
 * Le proxy Qlik refuse un websocket "raw" côté serveur (403). On ouvre donc
 * l'app dans Chromium avec une session authentifiée (cookie X-Qlik-Session
 * injecté via le flux ticket NTLM), on récupère le **qlik-csrf-token** que le
 * client Qlik utilise pour SON websocket, puis on ouvre notre propre websocket
 * Engine **in-page** avec ce token (le proxy l'accepte).
 *
 * Efficacité : sélection des codes du fournisseur sur le champ "Article Code"
 * (l'app contient ~1,2M codes) → l'hypercube ne renvoie que ces lignes.
 */

import "server-only";
import { chromium, type Browser } from "playwright-core";
import { getQlikConfig, qlikNtlmSession, type QlikConfig, type NetworkMetric } from "@/lib/qlik-client";
import { buildGridNetworkQlikDateFilter, chunkSerials, type QlikDateFilter } from "@/lib/qlik-date-range";

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
    if (!browserPromise) {
        const execPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
        browserPromise = chromium.launch({
            headless: true,
            executablePath: execPath || undefined,
            channel: execPath ? undefined : "chrome",
            args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"],
        }).catch((e) => { browserPromise = null; throw e; });
    }
    return browserPromise;
}

interface InPageResult { ok: boolean; rows?: Array<Array<string | number>>; size?: number; error?: string; diag?: Record<string, unknown>; }

export async function fetchNetworkMetricsPlaywright(
    codeCentraux?: string[],
    cfg: QlikConfig = getQlikConfig(),
    dateFilter: QlikDateFilter | null = buildGridNetworkQlikDateFilter(),
): Promise<Map<string, NetworkMetric>> {
    if (!cfg.appNetwork) throw new Error("[qlik-pw] QLIK_APP_NETWORK manquant");
    if (!cfg.user || !cfg.password) throw new Error("[qlik-pw] identifiants Qlik manquants");

    console.log(`[qlik-pw] host=${cfg.host} app=${cfg.appNetwork} — ${(codeCentraux ?? []).length} codes à sélectionner`);
    if (dateFilter) {
        console.log(`[qlik-pw] filtre Date=${dateFilter.label} (${dateFilter.dateDebut} → ${dateFilter.dateFin}, ${dateFilter.setAnalysis})`);
    }
    const sess = await qlikNtlmSession(cfg);
    console.log(`[qlik-pw] session NTLM OK, cookie=${sess.cookie.split("=")[0]}=…`);
    const [cookieName, ...rest] = sess.cookie.split("=");
    const cookieValue = rest.join("=");

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

        const result = (await page.evaluate(
            ({ app, dim, mca, mqte, mnb, mcamag, mmarge, codes, token, dateBatches, dateLabel }: { app: string; dim: string; mca: string; mqte: string; mnb: string; mcamag: string; mmarge: string; codes: string[]; token: string; dateBatches: number[][]; dateLabel: string | null }) =>
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
                            if (m.id && pend.has(m.id)) { const x = pend.get(m.id)!; pend.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); }
                        };
                        ws.onerror = () => rej(new Error("ws error (403 ?)"));
                        setTimeout(() => rej(new Error("ws timeout")), 30000);
                    });
                    (async () => {
                        try {
                            await ready;
                            console.log("ws connecté (OnConnected)");
                            const open = await rpc("OpenDoc", { qDocName: app });
                            const doc = (open.qReturn as { qHandle: number }).qHandle;
                            console.log("OpenDoc OK handle=" + doc);

                            // Aligne Qlik sur la timeline grille : 12 mois complets glissants,
                            // hors mois courant. La sélection du champ Date est héritée par les
                            // master measures du cube, sans dupliquer leurs expressions.
                            if (dateBatches.length) {
                                try {
                                    const df = await rpc("GetField", { qFieldName: "Date" }, doc);
                                    const dfh = (df.qReturn as { qHandle: number }).qHandle;
                                    for (let i = 0; i < dateBatches.length; i++) {
                                        const batch = dateBatches[i];
                                        await rpc(
                                            "SelectValues",
                                            { qFieldValues: batch.map((s) => ({ qNum: s, qText: String(s) })), qToggleMode: false, qSoftLock: true },
                                            dfh,
                                        );
                                        console.log("filtre Date " + (i + 1) + "/" + dateBatches.length + " — " + batch.length + " jours — " + dateLabel);
                                    }
                                } catch (e) {
                                    console.log("filtre Date ignoré: " + String((e as Error)?.message || e));
                                }
                            }

                            // Handle du champ de sélection (réutilisé pour chaque lot).
                            let fh = -1;
                            if (codes.length) {
                                const gf = await rpc("GetField", { qFieldName: "Article Code" }, doc);
                                fh = (gf.qReturn as { qHandle: number }).qHandle;
                            }
                            // Résoudre les master measures par TITRE (le qLibraryId fiable = qInfo.qId, ≠ GUID QRS).
                            const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
                            const ml = await rpc("CreateSessionObject", { qProp: { qInfo: { qType: "MeasureList" }, qMeasureListDef: { qType: "measure", qData: { title: "/qMetaDef/title" } } } }, doc);
                            const mll = await rpc("GetLayout", {}, (ml.qReturn as { qHandle: number }).qHandle);
                            const items = (((mll.qLayout as { qMeasureList?: { qItems?: Array<{ qInfo: { qId: string }; qMeta?: { title?: string }; qData?: { title?: string } }> } }).qMeasureList?.qItems) ?? []);
                            const byTitle = new Map<string, string>();
                            for (const it of items) { const t = it.qMeta?.title ?? it.qData?.title ?? ""; if (t) byTitle.set(norm(t), it.qInfo.qId); }
                            const pickMeasure = (title: string, fallback: string) => byTitle.get(norm(title)) ?? fallback;
                            const rCamag = pickMeasure("CA par Magasin N", mcamag);
                            const rMarge = pickMeasure("Marge % N", mmarge);
                            console.log("measures résolues par titre: " + JSON.stringify({ rCamag, rMarge }) + " (sur " + items.length + " mesures)");
                            const obj = await rpc("CreateSessionObject", { qProp: { qInfo: { qType: "cf-net" }, qHyperCubeDef: {
                                qDimensions: [{ qLibraryId: dim }],
                                qMeasures: [{ qLibraryId: mca }, { qLibraryId: mqte }, { qLibraryId: mnb }, { qLibraryId: rCamag }, { qLibraryId: rMarge }],
                                qInitialDataFetch: [],
                            } } }, doc);
                            const oh = (obj.qReturn as { qHandle: number }).qHandle;
                            const out: Array<Array<string | number>> = [];
                            const PAGE = 1400;
                            // Lots de sélection : avec le filtre Date actif (~365 jours), même ~400 codes
                            // forcés d'un coup déclenchent un recalcul de cube trop lourd → l'Engine
                            // annule (code 15 "Request aborted"). On extrait par petits lots, on vide la
                            // sélection "Article Code" entre chaque lot (le filtre Date est conservé car
                            // posé indépendamment), et on accumule les lignes côté client.
                            const BATCH = 100;
                            const batches: Array<string[] | null> = codes.length
                                ? Array.from({ length: Math.ceil(codes.length / BATCH) }, (_, i) => codes.slice(i * BATCH, i * BATCH + BATCH))
                                : [null];
                            console.log("codes=" + codes.length + " → " + batches.length + " lot(s) de ≤ " + BATCH);
                            for (let b = 0; b < batches.length; b++) {
                                const batch = batches[b];
                                const sample = batch ? batch.slice(0, 3).join(",") + (batch.length > 3 ? ",…" : "") : "∅";
                                try {
                                    if (batch && fh !== -1) {
                                        const sel = await rpc("SelectValues", { qFieldValues: batch.map((c) => ({ qText: c })), qToggleMode: false, qSoftLock: true }, fh);
                                        console.log("lot " + (b + 1) + "/" + batches.length + " — SelectValues " + batch.length + " codes [" + sample + "] → " + JSON.stringify(sel.qReturn));
                                    }
                                    const layout = await rpc("GetLayout", {}, oh);
                                    const size = ((layout.qLayout as { qHyperCube: { qSize: { qcy: number } } }).qHyperCube).qSize.qcy;
                                    let got = 0;
                                    for (let top = 0; top < size; top += PAGE) {
                                        const d = await rpc("GetHyperCubeData", { qPath: "/qHyperCubeDef", qPages: [{ qTop: top, qLeft: 0, qWidth: 6, qHeight: PAGE }] }, oh);
                                        const matrix = (d.qDataPages as Array<{ qMatrix?: Array<Array<{ qText?: string; qNum?: number }>> }>)?.[0]?.qMatrix ?? [];
                                        if (!matrix.length) break;
                                        for (const r of matrix) out.push([String(r[0]?.qText ?? ""), Number(r[1]?.qNum) || 0, Number(r[2]?.qNum) || 0, Number(r[3]?.qNum) || 0, Number(r[4]?.qNum) || 0, Number(r[5]?.qNum) || 0]);
                                        got += matrix.length;
                                        if (matrix.length < PAGE) break;
                                    }
                                    console.log("lot " + (b + 1) + "/" + batches.length + " — " + got + " ligne(s) (cube qcy=" + size + "), cumul=" + out.length);
                                } catch (batchErr) {
                                    const msg = String((batchErr as Error)?.message || batchErr);
                                    console.error("[qlik-pw] lot " + (b + 1) + "/" + batches.length + " abort [" + sample + "] — " + msg);
                                    throw new Error("[qlik-pw] abort lot " + (b + 1) + "/" + batches.length + " (" + (batch?.length ?? 0) + " codes) — " + msg);
                                }
                                // Vide la sélection Article Code avant le lot suivant : le filtre Date
                                // reste posé sur l'app, on évite l'accumulation côté Engine.
                                if (batch && fh !== -1 && b < batches.length - 1) {
                                    try {
                                        await rpc("Clear", {}, fh);
                                    } catch (clearErr) {
                                        console.log("[qlik-pw] Clear Article Code ignoré: " + String((clearErr as Error)?.message || clearErr));
                                    }
                                }
                            }
                            ws.close();
                            resolve({ ok: true, rows: out, size: out.length });
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
                dateBatches: dateFilter ? chunkSerials(dateFilter.dailySerials, 500) : [],
                dateLabel: dateFilter?.label ?? null,
            },
        )) as InPageResult;

        if (!result.ok) throw new Error(`[qlik-pw] ${result.error}`);

        const wanted = codeCentraux ? new Set(codeCentraux) : null;
        const out = new Map<string, NetworkMetric>();
        for (const r of result.rows ?? []) {
            const code = String(r[0]).trim();
            if (!code || code === "-") continue;
            if (wanted && !wanted.has(code)) continue;
            out.set(code, { codeCentrale: code, caReseau: Number(r[1]) || 0, qteReseau: Number(r[2]) || 0, nbMagasinsReseau: Number(r[3]) || 0, caParMagasinReseau: Number(r[4]) || 0, margePctReseau: Number(r[5]) || 0, periode: dateFilter?.label });
        }
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
