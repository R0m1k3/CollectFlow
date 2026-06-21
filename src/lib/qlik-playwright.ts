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
 * tous les Article Code possibles pour ce mois. Le filtrage fournisseur se fait
 * ensuite côté Node, ce qui évite les gros SelectValues Article Code + 365 jours.
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

        // Pré-calcul des mois côté Node (pour pouvoir logger X/Y et propager au script in-page).
        const monthRanges: QlikDateFilter[] = dateFilter ? getMonthRanges(dateFilter) : [];
        const monthlyPayload = monthRanges.map((m) => ({
            label: m.label,
            dateDebut: m.dateDebut,
            dateFin: m.dateFin,
            serials: m.dailySerials, // ~30 valeurs → SelectValues en une fois
        }));

        const result = (await page.evaluate(
            ({ app, dim, mca, mqte, mnb, mcamag, mmarge, codes, token, monthlyPayload, noDateMode }: {
                app: string; dim: string; mca: string; mqte: string; mnb: string; mcamag: string; mmarge: string;
                codes: string[]; token: string;
                monthlyPayload: Array<{ label: string; dateDebut: string; dateFin: string; serials: number[] }>;
                noDateMode: boolean;
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
                            if (m.id && pend.has(m.id)) { const x = pend.get(m.id)!; pend.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); }
                        };
                        ws.onerror = () => rej(new Error("ws error (403 ?)"));
                        setTimeout(() => rej(new Error("ws timeout")), 30000);
                    });

                    // Sélectionne Date + Article Code puis pagine le cube. Renvoie le nb de lignes
                    // brutes lues (avant dédoublonnage côté Node).
                    const PAGE = 1400;
                    const fetchCubeForSelection = async (oh: number, sink: Array<Array<string | number>>): Promise<number> => {
                        const layout = await rpc("GetLayout", {}, oh);
                        const size = ((layout.qLayout as { qHyperCube: { qSize: { qcy: number } } }).qHyperCube).qSize.qcy;
                        let got = 0;
                        for (let top = 0; top < size; top += PAGE) {
                            const d = await rpc("GetHyperCubeData", { qPath: "/qHyperCubeDef", qPages: [{ qTop: top, qLeft: 0, qWidth: 6, qHeight: PAGE }] }, oh);
                            const matrix = (d.qDataPages as Array<{ qMatrix?: Array<Array<{ qText?: string; qNum?: number }>> }>)?.[0]?.qMatrix ?? [];
                            if (!matrix.length) break;
                            for (const r of matrix) sink.push([
                                String(r[0]?.qText ?? ""),
                                Number(r[1]?.qNum) || 0,
                                Number(r[2]?.qNum) || 0,
                                Number(r[3]?.qNum) || 0,
                                Number(r[4]?.qNum) || 0,
                                Number(r[5]?.qNum) || 0,
                            ]);
                            got += matrix.length;
                            if (matrix.length < PAGE) break;
                        }
                        return got;
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
                            const df = await rpc("GetField", { qFieldName: "Date" }, doc);
                            dfh = (df.qReturn as { qHandle: number }).qHandle;
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

                            if (noDateMode) {
                                // Aucun filtre Date : extraction en un seul appel (tous les codes d'un coup).
                                // On sélectionne uniquement Article Code ; Date reste libre.
                                console.log("mode sans dateFilter — sélection de " + codes.length + " codes en une fois");
                                if (codes.length && fh !== -1) {
                                    const sel = await rpc("SelectValues", { qFieldValues: codes.map((c) => ({ qText: c })), qToggleMode: false, qSoftLock: true }, fh);
                                    console.log("SelectValues Article Code → " + JSON.stringify(sel.qReturn));
                                }
                                const got = await fetchCubeForSelection(oh, out);
                                console.log("extraction sans date — " + got + " ligne(s), cumul=" + out.length);
                            } else {
                                // Itération par mois : pour chaque mois, SelectValues Date (~30 serials) puis
                                // SelectAll Article Code. On lit le mois complet, puis on filtre côté Node sur
                                // `codeCentraux`. C'est plus stable que SelectValues(419 codes) + 365 jours :
                                // chaque cube reste borné à ~30 jours × articles actifs du mois.
                                // Clear Date + Clear Article Code avant le mois suivant.
                                const total = monthlyPayload.length;
                                console.log("itération par mois — " + total + " mois, SelectAll Article Code, filtre Node sur " + codes.length + " codes");
                                for (let mi = 0; mi < total; mi++) {
                                    const m = monthlyPayload[mi];
                                    const prefix = "[qlik-pw] mois " + (mi + 1) + "/" + total + " " + m.label + " (" + m.dateDebut + "→" + m.dateFin + ", " + m.serials.length + "j)";
                                    try {
                                        // 1) Sélection Date pour le mois (un seul SelectValues, ~30 valeurs).
                                        const dsel = await rpc("SelectValues", {
                                            qFieldValues: m.serials.map((s) => ({ qNum: s, qText: String(s) })),
                                            qToggleMode: false,
                                            qSoftLock: true,
                                        }, dfh);
                                        console.log(prefix + " — SelectValues Date " + m.serials.length + " serials → " + JSON.stringify(dsel.qReturn));
                                        // 2) Sélection Article Code : tous les articles possibles pour ce mois.
                                        // Le filtrage sur les codes demandés se fait ensuite côté Node.
                                        if (fh !== -1) {
                                            const csel = await rpc("SelectAll", { qSoftLock: true }, fh);
                                            console.log(prefix + " — SelectAll Article Code → " + JSON.stringify(csel.qReturn));
                                        }
                                        // 3) Lecture du cube mensuel.
                                        const got = await fetchCubeForSelection(oh, out);
                                        console.log(prefix + " — " + got + " ligne(s), cumul=" + out.length);
                                    } catch (monthErr) {
                                        const msg = String((monthErr as Error)?.message || monthErr);
                                        console.error(prefix + " — ABORT — " + msg);
                                        throw new Error(prefix + " — " + msg);
                                    }
                                    // 4) Clear Date + Clear Article Code avant le mois suivant (soulage l'Engine).
                                    if (mi < total - 1) {
                                        try {
                                            await rpc("Clear", {}, dfh);
                                            if (fh !== -1) await rpc("Clear", {}, fh);
                                        } catch (clearErr) {
                                            console.log(prefix + " — Clear ignoré: " + String((clearErr as Error)?.message || clearErr));
                                        }
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
                monthlyPayload,
                noDateMode: !dateFilter,
            },
        )) as InPageResult;

        if (!result.ok) throw new Error(`[qlik-pw] ${result.error}`);

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
