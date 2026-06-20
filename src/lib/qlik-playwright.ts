/**
 * CollectFlow — Extraction Qlik via Playwright (Chromium headless).
 *
 * Le proxy Qlik refuse un websocket "raw" (403) ET un ws in-page avec xrfkey
 * arbitraire. On réutilise donc la **session de la page** via la Capability API
 * Qlik (`require(['js/qlik'])` → `qlik.openApp` → `createCube`), qui gère le ws
 * et le xrfkey en interne avec la session authentifiée du navigateur.
 *
 * Auth : cookie X-Qlik-Session injecté (obtenu via le flux ticket NTLM côté Node,
 * fiable) + httpCredentials en secours.
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
            .catch(() => { /* le client Qlik se charge ensuite */ });
        // Laisse le client Qlik (RequireJS) se charger
        await page.waitForFunction(() => typeof (window as { require?: unknown }).require === "function", { timeout: cfg.timeoutMs })
            .catch(() => { /* diagnostiqué plus bas */ });

        const result = (await page.evaluate(
            ({ app, dim, mca, mqte, mnb, codes }: { app: string; dim: string; mca: string; mqte: string; mnb: string; codes: string[] }) =>
                new Promise<InPageResult>((resolve) => {
                    const w = window as unknown as {
                        require?: (deps: string[], cb: (q: unknown) => void) => void;
                        __BOOTSTRAP__?: { xrfkey?: string; config?: { websocketUrl?: string } };
                        location: Location;
                    };
                    const diag: Record<string, unknown> = {
                        href: w.location.href,
                        hasRequire: typeof w.require === "function",
                        bootstrapXrf: w.__BOOTSTRAP__?.xrfkey,
                        wsUrl: w.__BOOTSTRAP__?.config?.websocketUrl,
                        winKeys: Object.keys(window).filter((k) => /qlik|require|bootstrap|enigma/i.test(k)),
                    };
                    const fail = (error: string) => resolve({ ok: false, error, diag });
                    if (typeof w.require !== "function") return fail("require indisponible (page non authentifiée ?)");

                    w.require(["js/qlik"], (qlikRaw: unknown) => {
                        try {
                            const qlik = qlikRaw as {
                                openApp: (id: string, cfg?: unknown) => {
                                    createCube: (def: unknown, cb: (reply: { qHyperCube?: { qSize?: { qcy?: number }; qDataPages?: Array<{ qMatrix?: Array<Array<{ qText?: string; qNum?: number }>> }> } }) => void) => void;
                                    field: (name: string) => { selectValues: (vals: Array<{ qText: string }>, toggle: boolean, soft: boolean) => void };
                                };
                            };
                            const appHandle = qlik.openApp(app);
                            // Sélection des codes du fournisseur (efficacité) — best-effort
                            if (codes.length) {
                                try { appHandle.field("Article Code").selectValues(codes.map((c) => ({ qText: c })), false, true); } catch { /* noop */ }
                            }
                            appHandle.createCube({
                                qDimensions: [{ qLibraryId: dim, qType: "dimension" }],
                                qMeasures: [{ qLibraryId: mca }, { qLibraryId: mqte }, { qLibraryId: mnb }],
                                qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 4, qHeight: 5000 }],
                                qSuppressMissing: true,
                            }, (reply) => {
                                try {
                                    const hc = reply.qHyperCube;
                                    const matrix = hc?.qDataPages?.[0]?.qMatrix ?? [];
                                    const rows = matrix.map((r) => [String(r[0]?.qText ?? ""), Number(r[1]?.qNum) || 0, Number(r[2]?.qNum) || 0, Number(r[3]?.qNum) || 0]);
                                    resolve({ ok: true, rows, size: hc?.qSize?.qcy, diag });
                                } catch (e) { fail("createCube reply: " + String((e as Error)?.message || e)); }
                            });
                        } catch (e) { fail("openApp/createCube: " + String((e as Error)?.message || e)); }
                    });
                    setTimeout(() => fail("timeout extraction"), 45000);
                }),
            { app: cfg.appNetwork, dim: cfg.dimCodeArticleId, mca: cfg.measCaId, mqte: cfg.measQteId, mnb: cfg.measNbMagId, codes: codeCentraux ?? [] },
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
