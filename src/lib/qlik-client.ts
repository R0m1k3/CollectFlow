/**
 * CollectFlow — Client Qlik Sense (donnees reseau ~270 magasins)
 *
 * Recupere par produit (cle = code centrale via la dimension "Article Code") :
 *   - CA reseau, Qte vendue reseau, Nb magasins travaillant le produit.
 *
 * Auth = NTLM (Qlik Sense Enterprise on Windows) via flux ticket SSO :
 *   1. GET /hub/ (non authentifie) -> 302 vers le proxy forms, on extrait le targetId
 *   2. NTLM sur /internal_windows_authentication/?targetId=... -> 302 /hub/?qlikTicket=XXX
 *   3. GET /hub/?qlikTicket=XXX -> Qlik pose le cookie X-Qlik-Session
 * Le cookie + Xrfkey servent ensuite pour QRS (REST) et l'Engine API (websocket).
 *
 * Extraction = Engine API (QIX) sur websocket, hypercube generique reference par
 * master items (qLibraryId) -> pas besoin des expressions brutes.
 *
 * Tout est parametrable par variables d'environnement (defauts = discovery 2026-06-20).
 */

import httpntlm from "httpntlm";
import { WebSocket } from "ws";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Lit les réglages Qlik depuis data/.db-config.json (configurés dans Paramètres). */
function readQlikFileConfig(): { qlikHost?: string; qlikUser?: string; qlikPassword?: string } {
    try {
        const raw = readFileSync(join(process.cwd(), "data", ".db-config.json"), "utf-8");
        const c = JSON.parse(raw);
        return { qlikHost: c.qlikHost, qlikUser: c.qlikUser, qlikPassword: c.qlikPassword };
    } catch {
        return {};
    }
}

// ---------------------------------------------------------------------------
// Config (env) — defauts issus de la discovery
// ---------------------------------------------------------------------------

export interface QlikConfig {
    host: string;
    user: string;
    password: string;
    domain: string;        // vide par defaut (NTLM sans domaine, comme requests_ntlm)
    workstation: string;
    appNetwork: string;    // GUID app "Magasins Vision Consolidee" (article x reseau)
    dimCodeArticleId: string; // master dimension "Article Code"
    measCaId: string;         // master measure "CA N"
    measQteId: string;        // master measure "Quantite N"
    measNbMagId: string;      // master measure "Magasin Ventes Nb N"
    measCaMagId: string;      // master measure "CA par Magasin N"
    measMargePctId: string;   // master measure "Marge % N"
    tlsInsecure: boolean;
    timeoutMs: number;
}

export function getQlikConfig(): QlikConfig {
    // Priorité : réglages UI (data/.db-config.json) > env > défaut
    const f = readQlikFileConfig();
    return {
        host: f.qlikHost || process.env.QLIK_HOST || "reporting-magasins.lafoirfouille.fr",
        user: f.qlikUser || process.env.QLIK_USER || "FFSCH",
        password: f.qlikPassword || process.env.QLIK_PWD || "",
        domain: process.env.QLIK_DOMAIN ?? "",
        workstation: process.env.QLIK_WORKSTATION ?? "",
        appNetwork: process.env.QLIK_APP_NETWORK ?? "9872ee6e-d64a-4b43-984a-076bf1f7f647",
        // qIds engine (master items de l'app "Magasins Vision Consolidée")
        dimCodeArticleId: process.env.QLIK_DIM_CODE_ARTICLE_ID ?? "yesCP",
        measCaId: process.env.QLIK_MEAS_CA_ID ?? "JhqJ",
        measQteId: process.env.QLIK_MEAS_QTE_ID ?? "41516861-5997-4635-8187-3643a2bde422",
        measNbMagId: process.env.QLIK_MEAS_NBMAG_ID ?? "yNBLjc",
        // Master GUIDs de l'app "Magasins Vision Consolidée" (9872ee6e). Si l'engine
        // les refuse (qId court attendu), override via env après discovery.
        measCaMagId: process.env.QLIK_MEAS_CAMAG_ID ?? "16778c00-a4e0-41c7-ab1c-179810d78172",
        measMargePctId: process.env.QLIK_MEAS_MARGEPCT_ID ?? "ea1e8feb-49ba-4eb3-8db6-72dcfb4c1222",
        tlsInsecure: (process.env.QLIK_TLS_INSECURE ?? "true") === "true",
        timeoutMs: Number(process.env.QLIK_TIMEOUT_MS ?? "60000"),
    };
}

export interface NetworkMetric {
    codeCentrale: string;
    caReseau: number;
    qteReseau: number;
    nbMagasinsReseau: number;
    /** CA moyen par magasin (productivité normalisée présence) */
    caParMagasinReseau: number;
    /** Taux de marge réseau (ratio brut Qlik, ex 0.32 = 32%) */
    margePctReseau: number;
    periode?: string;
}

function makeXrfkey(): string {
    return randomBytes(12).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 16).padEnd(16, "0");
}

// ---------------------------------------------------------------------------
// 1. Auth NTLM -> ticket SSO -> cookie de session
// ---------------------------------------------------------------------------

interface QlikSession {
    cookie: string;
    xrfkey: string;
}

function ntlmGet(cfg: QlikConfig, path: string): Promise<{ statusCode: number; headers: Record<string, unknown>; body: string }> {
    return new Promise((resolve, reject) => {
        httpntlm.get(
            {
                url: `https://${cfg.host}${path}`,
                username: cfg.user,
                password: cfg.password,
                domain: cfg.domain,
                workstation: cfg.workstation,
                rejectUnauthorized: !cfg.tlsInsecure,
                headers: { "User-Agent": "Mozilla/5.0 CollectFlow", "X-Qlik-Xrfkey": "" },
            } as unknown as Parameters<typeof httpntlm.get>[0],
            (err: Error | null, res: { statusCode: number; headers: Record<string, unknown>; body: string }) =>
                err ? reject(err) : resolve(res),
        );
    });
}

export async function qlikNtlmSession(cfg = getQlikConfig()): Promise<QlikSession> {
    if (!cfg.user || !cfg.password) {
        throw new Error("[qlik] QLIK_USER / QLIK_PWD manquants dans l'environnement");
    }
    const xrfkey = makeXrfkey();
    const tlsRestore = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (cfg.tlsInsecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
        // 1. targetId
        const hub = await fetch(`https://${cfg.host}/hub/`, { redirect: "manual" });
        const loc1 = hub.headers.get("location") ?? "";
        const targetId = (loc1.match(/targetId=([0-9a-f-]+)/i) ?? [])[1] ?? "";

        // 2. NTLM -> ticket. Interne (reseau corp), /hub/ peut deja renvoyer 401 NTLM
        //    et poser le cookie directement ; on gere les 2 cas.
        const winPath = targetId
            ? `/internal_windows_authentication/?targetId=${targetId}&xrfkey=${xrfkey}`
            : `/hub/?xrfkey=${xrfkey}`;
        const ntlm = await ntlmGet(cfg, winPath);

        // Cookie posé directement (cas interne) ?
        const directCookie = extractSessionCookie(ntlm.headers["set-cookie"]);
        if (directCookie) return { cookie: directCookie, xrfkey };

        // 3. Échange ticket -> cookie
        const ticketLoc = String(ntlm.headers["location"] ?? "");
        if (!/qlikTicket=/.test(ticketLoc)) {
            throw new Error(`[qlik] Auth NTLM sans ticket (HTTP ${ntlm.statusCode}) — verifier mot de passe`);
        }
        const exch = await fetch(ticketLoc, { redirect: "manual" });
        const sc = typeof exch.headers.getSetCookie === "function" ? exch.headers.getSetCookie() : [];
        const cookie = sc.map((c) => c.split(";")[0]).filter((c) => /X-Qlik-Session/i.test(c)).join("; ");
        if (!cookie) throw new Error("[qlik] ticket non echange contre un cookie de session");
        return { cookie, xrfkey };
    } finally {
        if (cfg.tlsInsecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsRestore;
    }
}

function extractSessionCookie(setCookie: unknown): string | null {
    const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [String(setCookie)] : [];
    const c = arr.map((x) => String(x).split(";")[0]).find((x) => /X-Qlik-Session/i.test(x));
    return c ?? null;
}

// ---------------------------------------------------------------------------
// 2. Websocket Engine API (QIX) + JSON-RPC minimal
// ---------------------------------------------------------------------------

interface RpcConn {
    rpc: (method: string, params: unknown, handle?: number) => Promise<Record<string, unknown>>;
    close: () => void;
}

function openEngine(appGuid: string, sess: QlikSession, cfg: QlikConfig): Promise<RpcConn> {
    const url = `wss://${cfg.host}/app/${encodeURIComponent(appGuid)}?Xrfkey=${sess.xrfkey}`;
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, {
            headers: {
                Cookie: sess.cookie,
                "X-Qlik-Xrfkey": sess.xrfkey,
                // Le proxy Qlik valide l'Origin des websockets (whitelist) — un navigateur l'envoie toujours.
                Origin: `https://${cfg.host}`,
                "User-Agent": "Mozilla/5.0",
            },
            rejectUnauthorized: !cfg.tlsInsecure,
            handshakeTimeout: cfg.timeoutMs,
        });
        let nextId = 1;
        const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
        const timer = setTimeout(() => { ws.terminate(); reject(new Error("[qlik] timeout engine")); }, cfg.timeoutMs);

        ws.on("message", (raw: Buffer) => {
            let msg: Record<string, unknown>;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg.method === "OnConnected") { clearTimeout(timer); resolve(conn); return; }
            const id = msg.id as number | undefined;
            if (id != null && pending.has(id)) {
                const p = pending.get(id)!;
                pending.delete(id);
                if (msg.error) p.reject(new Error(`[qlik] RPC ${JSON.stringify(msg.error)}`));
                else p.resolve(msg.result as Record<string, unknown>);
            }
        });
        ws.on("unexpected-response", (_req, res) => {
            clearTimeout(timer);
            let body = "";
            res.on("data", (d: Buffer) => (body += d.toString()));
            res.on("end", () => reject(new Error(
                `[qlik] ws HTTP ${res.statusCode} server=${res.headers["server"]} wwwauth=${res.headers["www-authenticate"]} body=${body.slice(0, 160)}`,
            )));
        });
        ws.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
        ws.on("close", () => { for (const p of pending.values()) p.reject(new Error("[qlik] ws ferme")); pending.clear(); });

        const rpc = (method: string, params: unknown, handle = -1) =>
            new Promise<Record<string, unknown>>((res, rej) => {
                const id = nextId++;
                pending.set(id, { resolve: res, reject: rej });
                ws.send(JSON.stringify({ jsonrpc: "2.0", id, handle, method, params }));
            });
        const conn: RpcConn = { rpc, close: () => ws.close() };
    });
}

// ---------------------------------------------------------------------------
// 3. Extraction hypercube (master items) -> NetworkMetric[]
// ---------------------------------------------------------------------------

function hyperCubeDef(cfg: QlikConfig, height: number) {
    return {
        qInfo: { qType: "collectflow-network" },
        qHyperCubeDef: {
            qDimensions: [{ qLibraryId: cfg.dimCodeArticleId, qNullSuppression: true }],
            qMeasures: [
                { qLibraryId: cfg.measCaId },
                { qLibraryId: cfg.measQteId },
                { qLibraryId: cfg.measNbMagId },
                { qLibraryId: cfg.measCaMagId },
                { qLibraryId: cfg.measMargePctId },
            ],
            qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 6, qHeight: height }],
            qSuppressZero: false,
            qSuppressMissing: true,
        },
    };
}

type Matrix = Array<Array<{ qText?: string; qNum?: number }>>;

export async function fetchNetworkMetrics(
    codeCentraux?: string[],
    cfg = getQlikConfig(),
): Promise<Map<string, NetworkMetric>> {
    if (!cfg.appNetwork) throw new Error("[qlik] QLIK_APP_NETWORK manquant");
    const wanted = codeCentraux ? new Set(codeCentraux) : null;
    const out = new Map<string, NetworkMetric>();

    const sess = await qlikNtlmSession(cfg);
    const conn = await openEngine(cfg.appNetwork, sess, cfg);
    try {
        const openRes = await conn.rpc("OpenDoc", { qDocName: cfg.appNetwork });
        const docHandle = (((openRes.qReturn as Record<string, unknown>) ?? {}).qHandle as number) ?? 1;

        const pageHeight = 1400; // 6 colonnes * 1400 = 8400 cellules max
        const createRes = await conn.rpc("CreateSessionObject", { qProp: hyperCubeDef(cfg, pageHeight) }, docHandle);
        const objHandle = (((createRes.qReturn as Record<string, unknown>) ?? {}).qHandle as number);

        let top = 0;
        for (;;) {
            const dataRes = await conn.rpc(
                "GetHyperCubeData",
                { qPath: "/qHyperCubeDef", qPages: [{ qTop: top, qLeft: 0, qWidth: 6, qHeight: pageHeight }] },
                objHandle,
            );
            const pages = (dataRes.qDataPages as Array<{ qMatrix?: Matrix }>) ?? [];
            const matrix: Matrix = pages[0]?.qMatrix ?? [];
            if (matrix.length === 0) break;

            for (const row of matrix) {
                const codeCentrale = (row[0]?.qText ?? "").trim();
                if (!codeCentrale) continue;
                if (wanted && !wanted.has(codeCentrale)) continue;
                out.set(codeCentrale, {
                    codeCentrale,
                    caReseau: Number(row[1]?.qNum ?? 0) || 0,
                    qteReseau: Number(row[2]?.qNum ?? 0) || 0,
                    nbMagasinsReseau: Number(row[3]?.qNum ?? 0) || 0,
                    caParMagasinReseau: Number(row[4]?.qNum ?? 0) || 0,
                    margePctReseau: Number(row[5]?.qNum ?? 0) || 0,
                });
            }
            if (matrix.length < pageHeight) break;
            top += matrix.length;
        }
    } finally {
        conn.close();
    }

    console.log(`[qlik] fetchNetworkMetrics: ${out.size} produits reseau`);
    return out;
}
