/**
 * CollectFlow — Extraction Qlik via Playwright (Chromium headless).
 *
 * Le proxy Qlik refuse un websocket "raw" côté serveur (403), mais l'accepte
 * depuis une vraie session navigateur. On ouvre donc l'app dans Chromium
 * (auth NTLM via httpCredentials, comme l'agent hermes), puis on extrait
 * l'hypercube via un websocket Engine **in-page** (même origine = accepté).
 *
 * Efficacité : on applique une sélection sur le champ "Article Code" = codes
 * du fournisseur → l'hypercube ne renvoie que ces lignes (pull minimal).
 */

import "server-only";
import { chromium, type Browser } from "playwright-core";
import { getQlikConfig, type QlikConfig, type NetworkMetric } from "@/lib/qlik-client";

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

interface InPageParams {
    app: string; dim: string; mca: string; mqte: string; mnb: string;
    codes: string[]; xrf: string;
}
interface InPageResult { ok: boolean; rows?: Array<Array<string | number>>; size?: number; error?: string; }

/** Code exécuté DANS la page (contexte navigateur) — ws Engine in-page. */
function inPageExtract(p: InPageParams): Promise<InPageResult> {
    // @ts-expect-error exécuté dans le navigateur
    return (async () => {
        const ws = new WebSocket(`wss://${location.host}/app/${p.app}?Xrfkey=${p.xrf}`);
        let id = 0;
        const pend = new Map<number, { res: (v: any) => void; rej: (e: any) => void }>();
        const rpc = (method: string, params: any, handle = -1) => new Promise<any>((res, rej) => {
            const i = ++id; pend.set(i, { res, rej });
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: i, handle, method, params }));
        });
        const ready = new Promise<void>((res, rej) => {
            ws.onmessage = (ev: MessageEvent) => {
                const m = JSON.parse(ev.data as string);
                if (m.method === "OnConnected") return res();
                if (m.id && pend.has(m.id)) { const x = pend.get(m.id)!; pend.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); }
            };
            ws.onerror = () => rej(new Error("ws error (403 proxy ?)"));
            setTimeout(() => rej(new Error("ws timeout")), 30000);
        });
        try {
            await ready;
            const open = await rpc("OpenDoc", { qDocName: p.app });
            const doc = open.qReturn.qHandle;

            // Sélection des codes du fournisseur sur le champ derrière "Article Code" (efficacité)
            if (p.codes.length) {
                try {
                    const gd = await rpc("GetDimension", { qId: p.dim }, doc);
                    const dh = gd.qReturn.qHandle;
                    const dl = await rpc("GetLayout", {}, dh);
                    const field = dl.qLayout?.qDim?.qFieldDefs?.[0];
                    if (field) {
                        const gf = await rpc("GetField", { qFieldName: field }, doc);
                        const fh = gf.qReturn.qHandle;
                        await rpc("SelectValues", { qFieldValues: p.codes.map((c) => ({ qText: c })), qToggleMode: false, qSoftLock: true }, fh);
                    }
                } catch { /* sélection best-effort */ }
            }

            const obj = await rpc("CreateSessionObject", { qProp: { qInfo: { qType: "cf-network" }, qHyperCubeDef: {
                qDimensions: [{ qLibraryId: p.dim, qNullSuppression: true }],
                qMeasures: [{ qLibraryId: p.mca }, { qLibraryId: p.mqte }, { qLibraryId: p.mnb }],
                qInitialDataFetch: [], qSuppressMissing: true,
            } } }, doc);
            const oh = obj.qReturn.qHandle;
            const layout = await rpc("GetLayout", {}, oh);
            const size = layout.qLayout.qHyperCube.qSize.qcy as number;

            const out: Array<Array<string | number>> = [];
            const PAGE = 2500;
            for (let top = 0; top < size; top += PAGE) {
                const d = await rpc("GetHyperCubeData", { qPath: "/qHyperCubeDef", qPages: [{ qTop: top, qLeft: 0, qWidth: 4, qHeight: PAGE }] }, oh);
                const matrix = d.qDataPages?.[0]?.qMatrix ?? [];
                if (!matrix.length) break;
                for (const r of matrix) out.push([String(r[0].qText ?? ""), Number(r[1].qNum) || 0, Number(r[2].qNum) || 0, Number(r[3].qNum) || 0]);
                if (matrix.length < PAGE) break;
            }
            ws.close();
            return { ok: true, rows: out, size };
        } catch (e: any) {
            try { ws.close(); } catch {}
            return { ok: false, error: String(e?.message || e) };
        }
    })();
}

export async function fetchNetworkMetricsPlaywright(
    codeCentraux?: string[],
    cfg: QlikConfig = getQlikConfig(),
): Promise<Map<string, NetworkMetric>> {
    if (!cfg.appNetwork) throw new Error("[qlik-pw] QLIK_APP_NETWORK manquant");
    if (!cfg.user || !cfg.password) throw new Error("[qlik-pw] identifiants Qlik manquants");

    const xrf = Array.from({ length: 16 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
    const browser = await getBrowser();
    const ctx = await browser.newContext({
        httpCredentials: { username: cfg.user, password: cfg.password, origin: `https://${cfg.host}` },
        ignoreHTTPSErrors: true,
    });
    try {
        const page = await ctx.newPage();
        await page.goto(`https://${cfg.host}/sense/app/${cfg.appNetwork}`, { waitUntil: "domcontentloaded", timeout: cfg.timeoutMs })
            .catch(() => { /* la page peut ne pas finir de charger, le ws in-page suffit */ });

        const result = (await page.evaluate(inPageExtract as never, {
            app: cfg.appNetwork, dim: cfg.dimCodeArticleId, mca: cfg.measCaId, mqte: cfg.measQteId, mnb: cfg.measNbMagId,
            codes: codeCentraux ?? [], xrf,
        })) as InPageResult;

        if (!result.ok) throw new Error(`[qlik-pw] extraction: ${result.error}`);

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
