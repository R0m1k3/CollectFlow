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
): Promise<Map<string, NetworkMetric>> {
    if (!cfg.appNetwork) throw new Error("[qlik-pw] QLIK_APP_NETWORK manquant");
    if (!cfg.user || !cfg.password) throw new Error("[qlik-pw] identifiants Qlik manquants");

    console.log(`[qlik-pw] host=${cfg.host} app=${cfg.appNetwork} — ${(codeCentraux ?? []).length} codes à sélectionner`);
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
            ({ app, dim, mca, mqte, mnb, mcamag, mcouv, mmarge, mrupt, codes, token }: { app: string; dim: string; mca: string; mqte: string; mnb: string; mcamag: string; mcouv: string; mmarge: string; mrupt: string; codes: string[]; token: string }) =>
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
                            // Sélection des codes du fournisseur (sinon ~1,2M lignes)
                            if (codes.length) {
                                const gf = await rpc("GetField", { qFieldName: "Article Code" }, doc);
                                const fh = (gf.qReturn as { qHandle: number }).qHandle;
                                const sel = await rpc("SelectValues", { qFieldValues: codes.map((c) => ({ qText: c })), qToggleMode: false, qSoftLock: true }, fh);
                                console.log("SelectValues " + codes.length + " codes → " + JSON.stringify(sel.qReturn));
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
                            const rCouv = pickMeasure("Couverture de stock Quantité N", mcouv);
                            const rMarge = pickMeasure("Marge % N", mmarge);
                            const rRupt = pickMeasure("Stock Rupture % N", mrupt);
                            console.log("measures résolues par titre: " + JSON.stringify({ rCamag, rCouv, rMarge, rRupt }) + " (sur " + items.length + " mesures)");
                            // Lit l'expression réelle d'une master measure (GetMeasure → GetProperties).
                            const measExpr = async (qId: string): Promise<string> => {
                                try {
                                    const gm = await rpc("GetMeasure", { qId }, doc);
                                    const h = (gm.qReturn as { qHandle: number }).qHandle;
                                    const p = await rpc("GetProperties", {}, h);
                                    const def = (p.qProp as { qMeasure?: { qDef?: { qDef?: string; qLabel?: string } } })?.qMeasure?.qDef;
                                    return def?.qDef ?? def?.qLabel ?? JSON.stringify(def ?? "n/a");
                                } catch (e) { return "err:" + String((e as Error)?.message || e); }
                            };
                            console.log("expr rupture (" + rRupt + "): " + await measExpr(rRupt));
                            console.log("expr couverture (" + rCouv + "): " + await measExpr(rCouv));
                            console.log("expr camag (" + rCamag + "): " + await measExpr(rCamag));
                            const obj = await rpc("CreateSessionObject", { qProp: { qInfo: { qType: "cf-net" }, qHyperCubeDef: {
                                qDimensions: [{ qLibraryId: dim }],
                                qMeasures: [{ qLibraryId: mca }, { qLibraryId: mqte }, { qLibraryId: mnb }, { qLibraryId: rCamag }, { qLibraryId: rCouv }, { qLibraryId: rMarge }, { qLibraryId: rRupt }],
                                qInitialDataFetch: [],
                            } } }, doc);
                            const oh = (obj.qReturn as { qHandle: number }).qHandle;
                            const layout = await rpc("GetLayout", {}, oh);
                            const size = ((layout.qLayout as { qHyperCube: { qSize: { qcy: number } } }).qHyperCube).qSize.qcy;
                            console.log("cube qSize.qcy=" + size + " lignes");
                            const out: Array<Array<string | number>> = [];
                            const PAGE = 1250;
                            for (let top = 0; top < size; top += PAGE) {
                                const d = await rpc("GetHyperCubeData", { qPath: "/qHyperCubeDef", qPages: [{ qTop: top, qLeft: 0, qWidth: 8, qHeight: PAGE }] }, oh);
                                const matrix = (d.qDataPages as Array<{ qMatrix?: Array<Array<{ qText?: string; qNum?: number }>> }>)?.[0]?.qMatrix ?? [];
                                if (!matrix.length) break;
                                for (const r of matrix) out.push([String(r[0]?.qText ?? ""), Number(r[1]?.qNum) || 0, Number(r[2]?.qNum) || 0, Number(r[3]?.qNum) || 0, Number(r[4]?.qNum) || 0, Number(r[5]?.qNum) || 0, Number(r[6]?.qNum) || 0, Number(r[7]?.qNum) || 0]);
                                if (matrix.length < PAGE) break;
                            }
                            ws.close();
                            resolve({ ok: true, rows: out, size });
                        } catch (e) { try { ws.close(); } catch { /* noop */ } fail(String((e as Error)?.message || e)); }
                    })();
                }),
            { app: cfg.appNetwork, dim: cfg.dimCodeArticleId, mca: cfg.measCaId, mqte: cfg.measQteId, mnb: cfg.measNbMagId, mcamag: cfg.measCaMagId, mcouv: cfg.measCouvQteId, mmarge: cfg.measMargePctId, mrupt: cfg.measRuptPctId, codes: codeCentraux ?? [], token: csrfToken },
        )) as InPageResult;

        if (!result.ok) throw new Error(`[qlik-pw] ${result.error}`);

        const wanted = codeCentraux ? new Set(codeCentraux) : null;
        const out = new Map<string, NetworkMetric>();
        for (const r of result.rows ?? []) {
            const code = String(r[0]).trim();
            if (!code || code === "-") continue;
            if (wanted && !wanted.has(code)) continue;
            out.set(code, { codeCentrale: code, caReseau: Number(r[1]) || 0, qteReseau: Number(r[2]) || 0, nbMagasinsReseau: Number(r[3]) || 0, caParMagasinReseau: Number(r[4]) || 0, couvertureStockReseau: Number(r[5]) || 0, margePctReseau: Number(r[6]) || 0, rupturePctReseau: Number(r[7]) || 0 });
        }
        console.log(`[qlik-pw] ${out.size} produits réseau (cube ${result.size})`);
        // Échantillon brut pour vérifier que les 4 nouvelles mesures (cols 4-7) renvoient des valeurs
        const sample = (result.rows ?? []).slice(0, 3).map((r) => ({
            code: r[0], ca: r[1], qte: r[2], nbMag: r[3], caMag: r[4], couv: r[5], margePct: r[6], ruptPct: r[7],
        }));
        console.log(`[qlik-pw] échantillon lignes:`, JSON.stringify(sample));
        return out;
    } finally {
        await ctx.close();
    }
}
