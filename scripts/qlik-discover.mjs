/**
 * Discovery Qlik Sense — autonome, à lancer à la main :
 *
 *   QLIK_PWD='<mot de passe>' node scripts/qlik-discover.mjs            # liste les apps
 *   QLIK_PWD='<mot de passe>' node scripts/qlik-discover.mjs <appGUID>  # + champs & mesures de l'app
 *
 * Env (défauts adaptés à La Foir'Fouille) :
 *   QLIK_HOST=reporting-magasins.lafoirfouille.fr
 *   QLIK_USER=FFSCH
 *   QLIK_DOMAIN=FOIRFOUILLE
 *   QLIK_PWD=<requis>
 *
 * But : récupérer le GUID de l'app réseau (~270 magasins) + les noms exacts du champ
 * "code article" et des mesures (CA / Qté / nb magasins) pour remplir .env.local :
 *   QLIK_APP_NETWORK / QLIK_DIM_CODE_ARTICLE / QLIK_MEAS_CA / QLIK_MEAS_QTE / QLIK_MEAS_NB_MAG
 */

import httpntlm from "httpntlm";
import { WebSocket } from "ws";
import { randomBytes } from "node:crypto";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // certif Qlik interne

const HOST = process.env.QLIK_HOST || "reporting-magasins.lafoirfouille.fr";
const USER = process.env.QLIK_USER || "FFSCH";
// Domaine vide par défaut : requests_ntlm("FFSCH", pwd) marche sans domaine explicite.
const DOMAIN = process.env.QLIK_DOMAIN || "";
const PWD = process.env.QLIK_PWD || "";
const APP = process.argv[2] || process.env.QLIK_APP_NETWORK || "";

if (!PWD) {
    console.error("ERREUR: définis QLIK_PWD. Ex: QLIK_PWD='xxx' node scripts/qlik-discover.mjs");
    process.exit(1);
}

const xrfkey = randomBytes(12).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 16).padEnd(16, "0");

function ntlmGet(path) {
    return new Promise((resolve, reject) => {
        httpntlm.get(
            {
                url: `https://${HOST}${path}`,
                username: USER,
                password: PWD,
                domain: DOMAIN,
                workstation: "",
                rejectUnauthorized: false,
                headers: { "X-Qlik-Xrfkey": xrfkey, "User-Agent": "Mozilla/5.0 CollectFlow" },
            },
            (err, res) => (err ? reject(err) : resolve(res)),
        );
    });
}

// Récupère un targetId en initiant une requête non authentifiée vers /hub/.
async function getTargetId() {
    const res = await fetch(`https://${HOST}/hub/`, { redirect: "manual" });
    const loc = res.headers.get("location") || "";
    const m = loc.match(/targetId=([0-9a-f-]+)/i);
    return m ? m[1] : "";
}

// Flux SSO ticket Qlik :
//   1. NTLM sur /internal_windows_authentication/?targetId=... -> 302 /hub/?qlikTicket=XXX
//   2. GET /hub/?qlikTicket=XXX -> Qlik valide le ticket et pose le cookie X-Qlik-Session
async function authCookie() {
    const tid = await getTargetId();
    const res = await ntlmGet(`/internal_windows_authentication/?targetId=${tid}&xrfkey=${xrfkey}`);
    const loc = res.headers.location || "";
    const ticket = (loc.match(/qlikTicket=([^&\s]+)/) || [])[1];
    console.log(`  [auth] NTLM HTTP ${res.statusCode}, ticket=${ticket ? "oui" : "non"}`);
    if (!ticket) throw new Error(`pas de qlikTicket (HTTP ${res.statusCode})`);

    // Échange ticket -> cookies de session (on garde TOUS les cookies posés)
    const r2 = await fetch(loc, { redirect: "manual" });
    const sc = typeof r2.headers.getSetCookie === "function"
        ? r2.headers.getSetCookie()
        : (r2.headers.get("set-cookie") ? [r2.headers.get("set-cookie")] : []);
    const pairs = sc.map((c) => c.split(";")[0]);
    const hasSession = pairs.some((c) => /X-Qlik-Session/i.test(c));
    console.log(`  [auth] échange ticket HTTP ${r2.status}, cookies=${JSON.stringify(pairs.map(p=>p.split("=")[0]))}`);
    if (!hasSession) throw new Error("ticket non échangé contre un cookie de session");
    return pairs.join("; ");
}

// QRS via cookie de session + Xrfkey.
async function qrsGet(path, cookie) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`https://${HOST}${path}${sep}xrfkey=${xrfkey}`, {
        headers: { Cookie: cookie, "X-Qlik-Xrfkey": xrfkey, Accept: "application/json" },
    });
    if (res.status !== 200) throw new Error(`QRS ${path} HTTP ${res.status}`);
    return res.json();
}

async function qrsApps(cookie) {
    const apps = await qrsGet("/qrs/app", cookie);
    return apps.map((a) => ({ id: a.id, name: a.name, published: a.published, stream: a.stream?.name }));
}

function engine(appGuid, cookie) {
    const ident = randomBytes(8).toString("hex");
    const url = `wss://${HOST}/app/${appGuid}/identity/${ident}?Xrfkey=${xrfkey}`;
    const ws = new WebSocket(url, {
        headers: { Cookie: cookie, "X-Qlik-Xrfkey": xrfkey, "User-Agent": "Mozilla/5.0" },
        rejectUnauthorized: false,
    });
    let id = 1;
    const pending = new Map();
    const ready = new Promise((resolve, reject) => {
        ws.on("message", (raw) => {
            const m = JSON.parse(raw.toString());
            if (m.method === "OnConnected") return resolve();
            if (m.id != null && pending.has(m.id)) {
                const p = pending.get(m.id);
                pending.delete(m.id);
                m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
            }
        });
        ws.on("unexpected-response", (_req, res) => {
            let body = "";
            res.on("data", (d) => (body += d));
            res.on("end", () => reject(new Error(`ws ${res.statusCode} server=${res.headers.server} wwwauth=${res.headers["www-authenticate"]} body=${body.slice(0, 120)}`)));
        });
        ws.on("error", reject);
    });
    const rpc = (method, params, handle = -1) =>
        new Promise((resolve, reject) => {
            const i = id++;
            pending.set(i, { resolve, reject });
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: i, handle, method, params }));
        });
    return { ready, rpc, close: () => ws.close() };
}

async function dumpFieldsMeasures(appGuid, cookie) {
    const e = engine(appGuid, cookie);
    await e.ready;
    const open = await e.rpc("OpenDoc", { qDocName: appGuid });
    const doc = open.qReturn.qHandle;

    // Liste des champs
    const fl = await e.rpc("CreateSessionObject", {
        qProp: { qInfo: { qType: "FieldList" }, qFieldListDef: { qShowSystem: false, qShowHidden: false, qShowSemantic: true, qShowSrcTables: true } },
    }, doc);
    const flLayout = await e.rpc("GetLayout", {}, fl.qReturn.qHandle);
    const fields = (flLayout.qLayout.qFieldList.qItems || []).map((f) => f.qName);

    // Liste des mesures (master items)
    const ml = await e.rpc("CreateSessionObject", {
        qProp: { qInfo: { qType: "MeasureList" }, qMeasureListDef: { qType: "measure", qData: { title: "/qMetaDef/title", expr: "/qMeasure/qDef" } } },
    }, doc);
    const mlLayout = await e.rpc("GetLayout", {}, ml.qReturn.qHandle);
    const measures = (mlLayout.qLayout.qMeasureList.qItems || []).map((m) => ({
        title: m.qMeta?.title ?? m.qData?.title,
        expr: m.qData?.expr,
    }));

    e.close();
    return { fields, measures };
}

(async () => {
    try {
        console.log(`Auth NTLM ${DOMAIN}\\${USER} @ ${HOST} ...`);
        const cookie = await authCookie();
        console.log("✓ Authentifié.\n");

        const apps = await qrsApps(cookie);
        console.log(`=== ${apps.length} apps ===`);
        for (const a of apps) console.log(`  ${a.id}  [${a.stream || "-"}]  ${a.name}`);

        if (APP) {
            console.log(`\n=== Champs & mesures de l'app ${APP} ===`);
            const { fields, measures } = await dumpFieldsMeasures(APP, cookie);
            console.log(`\n-- Champs (${fields.length}) --`);
            for (const f of fields) console.log(`  ${f}`);
            console.log(`\n-- Mesures master (${measures.length}) --`);
            for (const m of measures) console.log(`  ${m.title}  =  ${m.expr}`);
            console.log(`\n→ Repère le champ "code article", et les expressions CA / Qté / nb magasins,`);
            console.log(`  puis remplis QLIK_APP_NETWORK / QLIK_DIM_CODE_ARTICLE / QLIK_MEAS_* dans .env.local.`);
        } else {
            console.log(`\n→ Relance avec le GUID de l'app réseau pour lister ses champs & mesures :`);
            console.log(`  QLIK_PWD='...' node scripts/qlik-discover.mjs <appGUID>`);
        }
    } catch (e) {
        console.error("ERREUR:", e.message);
        process.exit(1);
    }
})();
