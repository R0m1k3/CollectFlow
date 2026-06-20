/**
 * CollectFlow — Extraction Qlik via Playwright (Chromium headless).
 *
 * Le proxy Qlik refuse un websocket "raw" côté serveur (403). On ouvre donc
 * l'app dans Chromium avec une **session authentifiée** (cookie X-Qlik-Session
 * injecté, obtenu via le flux ticket NTLM côté Node) puis on ouvre le websocket
 * Engine **in-page** (même origine + cookie navigateur = accepté par le proxy).
 *
 * L'API Engine (wss://host/app/<guid>) est stable quelle que soit la version du
 * client Qlik (ici qmfe/single-spa, sans l'ancienne Capability API js/qlik).
 *
 * Efficacité : sélection des codes du fournisseur sur le champ "Article Code"
 * → l'hypercube ne renvoie que ces lignes.
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

interface InPageResult {
    ok: boolean;
    rows?: Array<Array<string | number>>;
    size?: number;
    error?: string;
    diag?: Record<string, unknown>;
}

export async function fetchNetworkMetricsPlaywright(
    codeCentraux?: string[],
    cfg: QlikConfig = getQlikConfig(),
): Promise<Map<string, NetworkMetric>> {
    if (!cfg.appNetwork) throw new Error("[qlik-pw] QLIK_APP_NETWORK manquant");
    if (!cfg.user || !cfg.password) throw new Error("[qlik-pw] identifiants Qlik manquants");

    // 1. Session Qlik fiable (flux ticket NTLM côté Node) → cookie
    const sess = await qlikNtlmSession(cfg);
    const [cookieName, ...rest] = sess.cookie.split("=");
    const cookieValue = rest.join("=");

    const browser = await getBrowser();
    const ctx = await browser.newContext({
        httpCredentials: { username: cfg.user, password: cfg.password, origin: `https://${cfg.host}` },
        ignoreHTTPSErrors: true,
    });
    await ctx.addCookies([{ name: cookieName, value: cookieValue, domain: cfg.host, path: "/", secure: true }]);

    try {
        const page = await ctx.newPage();
        await page.goto(`https://${cfg.host}/sense/app/${cfg.appNetwork}`, { waitUntil: "domcontentloaded", timeout: cfg.timeoutMs })
            .catch(() => { /* le ws in-page suffit */ });

        const xrf = sess.xrfkey;
        const result = (await page.evaluate(
            ({ app, dim, mca, mqte, mnb, codes, xrf }: { app: string; dim: string; mca: string; mqte: string; mnb: string; codes: string[]; xrf: string }) =>
                new Promise<InPageResult>((resolve) => {
                    const loc = (window as unknown as { location: Location }).location;
                    const diag: Record<string, unknown> = { href: loc.href };
                    const ws = new WebSocket(`wss://${loc.host}/app/${app}?Xrfkey=${xrf}`);
                    let id = 0;
                    const pend = new Map<number, { res: (v: unknown) => void; rej: (e: unknown) => void }>();
                    const rpc = (method: string, params: unknown, handle = -1) => new Promise<{ [k: string]: unknown }>((res, rej) => {
                        const i = ++id; pend.set(i, { res: res as (v: unknown) => void, rej });
                        ws.send(JSON.stringify({ jsonrpc: "2.0", id: i, handle, method, params }));
                    });
                    const fail = (error: string) => resolve({ ok: false, error, diag });
                    const ready = new Promise<void>((res, rej) => {
                        ws.onmessage = (ev: MessageEvent) => {
                            const m = JSON.parse(ev.data as string);
                            if (m.method === "OnConnected") return res();
                            if (m.id && pend.has(m.id)) { const x = pend.get(m.id)!; pend.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); }
                        };
                        ws.onclose = (ev: CloseEvent) => { diag.wsClose = { code: ev.code, reason: ev.reason }; };
                        ws.onerror = () => rej(new Error("ws error (403 proxy ?)"));
                        setTimeout(() => rej(new Error("ws timeout")), 30000);
                    });
                    (async () => {
                        try {
                            await ready;
                            const open = await rpc("OpenDoc", { qDocName: app });
                            const doc = (open.qReturn as { qHandle: number }).qHandle;
                            // Sélection des codes du fournisseur (efficacité) — best-effort
                            if (codes.length) {
                                try {
                                    const gd = await rpc("GetField", { qFieldName: "Article Code" }, doc);
                                    const fh = (gd.qReturn as { qHandle: number }).qHandle;
                                    await rpc("SelectValues", { qFieldValues: codes.map((c) => ({ qText: c })), qToggleMode: false, qSoftLock: true }, fh);
                                } catch { /* noop */ }
                            }
                            const obj = await rpc("CreateSessionObject", { qProp: { qInfo: { qType: "cf-net" }, qHyperCubeDef: {
                                qDimensions: [{ qLibraryId: dim, qNullSuppression: true }],
                                qMeasures: [{ qLibraryId: mca }, { qLibraryId: mqte }, { qLibraryId: mnb }],
                                qInitialDataFetch: [], qSuppressMissing: true,
                            } } }, doc);
                            const oh = (obj.qReturn as { qHandle: number }).qHandle;
                            const layout = await rpc("GetLayout", {}, oh);
                            const size = ((layout.qLayout as { qHyperCube: { qSize: { qcy: number } } }).qHyperCube).qSize.qcy;
                            const out: Array<Array<string | number>> = [];
                            const PAGE = 2500;
                            for (let top = 0; top < size; top += PAGE) {
                                const d = await rpc("GetHyperCubeData", { qPath: "/qHyperCubeDef", qPages: [{ qTop: top, qLeft: 0, qWidth: 4, qHeight: PAGE }] }, oh);
                                const matrix = (d.qDataPages as Array<{ qMatrix?: Array<Array<{ qText?: string; qNum?: number }>> }>)?.[0]?.qMatrix ?? [];
                                if (!matrix.length) break;
                                for (const r of matrix) out.push([String(r[0]?.qText ?? ""), Number(r[1]?.qNum) || 0, Number(r[2]?.qNum) || 0, Number(r[3]?.qNum) || 0]);
                                if (matrix.length < PAGE) break;
                            }
                            ws.close();
                            resolve({ ok: true, rows: out, size, diag });
                        } catch (e) { try { ws.close(); } catch { /* noop */ } fail(String((e as Error)?.message || e)); }
                    })();
                }),
            { app: cfg.appNetwork, dim: cfg.dimCodeArticleId, mca: cfg.measCaId, mqte: cfg.measQteId, mnb: cfg.measNbMagId, codes: codeCentraux ?? [], xrf },
        )) as InPageResult;

        console.log(`[qlik-pw] diag: ${JSON.stringify(result.diag)}`);
        if (!result.ok) throw new Error(`[qlik-pw] ${result.error} | diag=${JSON.stringify(result.diag)}`);

        const wanted = codeCentraux ? new Set(codeCentraux) : null;
        const out = new Map<string, NetworkMetric>();
        for (const r of result.rows ?? []) {
            const code = String(r[0]).trim();
            if (!code) continue;
            if (wanted && !wanted.has(code)) continue;
            out.set(code, { codeCentrale: code, caReseau: Number(r[1]) || 0, qteReseau: Number(r[2]) || 0, nbMagasinsReseau: Number(r[3]) || 0 });
        }
        console.log(`[qlik-pw] ${out.size} produits réseau (cube size ${result.size})`);
        return out;
    } finally {
        await ctx.close();
    }
}
