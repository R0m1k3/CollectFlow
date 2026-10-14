// Faux serveur Qlik Sense pour tester l'extraction CollectFlow de bout en bout
// (test `extraction_faux_qlik` de `src/qlik/tests_navigateur.rs`, lancement : `lancer.sh`).
//
//  - HTTPS (certificat auto-signé) sur :443 ;
//  - flux d'authentification : /hub/ → targetId → NTLM (type 1 → 2 → 3) → ticket → cookie ;
//  - /sense/app/<id> : page qui exige le cookie et ouvre un websocket avec un jeton CSRF ;
//  - /app/<id> (wss) : mini-moteur Engine (champs, sélections, hypercubes, list objects).
//
// Variables : NB_CODES (codes du fournisseur testé), NB_AUTRES, FOURNISSEUR,
// DELAI_MS (latence par GetLayout), MOIS_MANQUANT (YYYY-MM sans ventes).
"use strict";
const https = require("https");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const ICI = __dirname;
const APP = process.env.APP || "9872ee6e-d64a-4b43-984a-076bf1f7f647";
const FOURNISSEUR = process.env.FOURNISSEUR || "SOVA";
const NB_CODES = Number(process.env.NB_CODES || 400);
const NB_AUTRES = Number(process.env.NB_AUTRES || 600);
const DELAI_MS = Number(process.env.DELAI_MS || 0);
const MOIS_MANQUANT = process.env.MOIS_MANQUANT || "";
const SESSION = "s3ss10n-" + Math.random().toString(36).slice(2);
const JETON = "Jt" + Math.random().toString(36).slice(2) + "_x-Y";
const TYPE2 = "TlRMTVNTUAACAAAADgAOADAAAAAVgoniASNFZ4mrze8AAAAAAAAAACQAJAA+AAAARABPAE0AQQBJAE4ARQACAA4ARABPAE0AQQBJAE4AAQAMAFMARQBSAFYARQBSAAAAAAA=";

const stats = { ntlm1: 0, ntlm3: 0, ticket: 0, page: 0, pageRefusee: 0, ws: 0, wsRefuse: 0, rpc: 0, methodes: {} };
const log = (...a) => console.log("[faux-qlik]", ...a);

// ─── Données ────────────────────────────────────────────────────────────────
const serial = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
const codesFou = Array.from({ length: NB_CODES }, (_, i) => String(10000100000 + i));
const codesAutres = Array.from({ length: NB_AUTRES }, (_, i) => String(10000900000 + i));
// Pseudo-aléa déterministe.
let graine = 42;
const alea = () => { graine = (graine * 1103515245 + 12345) % 2147483648; return graine / 2147483648; };
const faits = [];
const aujourdHui = new Date();
for (let y = 2024; y <= aujourdHui.getFullYear(); y++) {
    for (let m = 1; m <= 12; m++) {
        if (y === aujourdHui.getFullYear() && m > aujourdHui.getMonth() + 1) break;
        const mois = `${y}${String(m).padStart(2, "0")}`;
        if (MOIS_MANQUANT && MOIS_MANQUANT.replace("-", "") === mois) continue;
        for (const [codes, fou] of [[codesFou, FOURNISSEUR], [codesAutres, "AUTRE"]]) {
            for (const code of codes) {
                // 2 magasins par mois, 1 fait chacun (jour variable dans le mois).
                for (let k = 0; k < 2; k++) {
                    if (alea() < 0.15) continue;
                    const jour = 1 + Math.floor(alea() * 28);
                    const quantite = 1 + Math.floor(alea() * 20);
                    const ca = Math.round(quantite * (2 + alea() * 10) * 100) / 100;
                    faits.push({
                        "Article Code": code, code_fournisseur: fou, "Magasin Code": "M" + Math.floor(alea() * 270),
                        Date: serial(y, m, jour), "Année": y, Mois: mois,
                        quantite, ca_ht: ca, marge: Math.round(ca * 0.35 * 100) / 100,
                    });
                }
            }
        }
    }
}
log(`${faits.length} faits, ${codesFou.length} codes ${FOURNISSEUR}, ${codesAutres.length} autres`);
const CHAMPS_NUM = new Set(["Date", "Année"]);
const CHAMPS = ["Article Code", "code_fournisseur", "Magasin Code", "Date", "Année", "Mois", "Période"];
// Valeurs distinctes de chaque champ (ordre de chargement), pour les qElemNumber.
const valeursChamp = {};
for (const c of CHAMPS) valeursChamp[c] = [];
const indexValeur = {};
for (const c of CHAMPS) indexValeur[c] = new Map();
const ajouterValeur = (c, v) => { if (!indexValeur[c].has(v)) { indexValeur[c].set(v, valeursChamp[c].length); valeursChamp[c].push(v); } };
for (const f of faits) for (const c of CHAMPS) if (c in f) ajouterValeur(c, f[c]);
// « Période » : champ déconnecté des faits (comme un pont de calendrier sans effet ici).
for (const p of ["Année à date", "Mois à date", "12 mois glissants"]) ajouterValeur("Période", p);

// ─── Mesures ────────────────────────────────────────────────────────────────
const somme = (rows, k) => rows.reduce((t, r) => t + r[k], 0);
const distinct = (rows, k) => new Set(rows.map((r) => r[k])).size;
const EXPRESSIONS = {
    "Sum(quantite)": (r) => somme(r, "quantite"),
    "Sum(ca_ht)": (r) => somme(r, "ca_ht"),
    "Sum(marge)": (r) => somme(r, "marge"),
    "Count(DISTINCT [Magasin Code])": (r) => distinct(r, "Magasin Code"),
    "0": () => 0,
};
const MAITRES = [
    { id: "JhqJ", titre: "CA N", expr: "Sum(ca_ht)", f: EXPRESSIONS["Sum(ca_ht)"] },
    { id: "41516861-5997-4635-8187-3643a2bde422", titre: "Quantité N", expr: "Sum(quantite)", f: EXPRESSIONS["Sum(quantite)"] },
    { id: "yNBLjc", titre: "Magasin Ventes Nb N", expr: "Count(DISTINCT [Magasin Code])", f: EXPRESSIONS["Count(DISTINCT [Magasin Code])"] },
    { id: "16778c00-a4e0-41c7-ab1c-179810d78172", titre: "CA par Magasin N", expr: "Sum(ca_ht)/Count(DISTINCT [Magasin Code])", f: (r) => { const n = distinct(r, "Magasin Code"); return n ? somme(r, "ca_ht") / n : 0; } },
    { id: "ea1e8feb-49ba-4eb3-8db6-72dcfb4c1222", titre: "Marge % N", expr: "Sum(marge)/Sum(ca_ht)", f: (r) => { const c = somme(r, "ca_ht"); return c ? somme(r, "marge") / c : 0; } },
    { id: "96862880-76cd-4957-bf25-b96901f2ac5f", titre: "Quantité COMP", expr: "0", f: () => 0 },
];
const DIMENSIONS = { yesCP: "Article Code", pfGAwTs: "Mois" };
const mesure = (m) => {
    if (m.qLibraryId) {
        const x = MAITRES.find((y) => y.id === m.qLibraryId);
        if (!x) throw { code: 2, message: "Invalid measure library id " + m.qLibraryId };
        return x.f;
    }
    const e = String(m.qDef?.qDef ?? "").trim();
    const f = EXPRESSIONS[e];
    if (!f) return () => NaN;
    return f;
};
const dimension = (d) => {
    if (d.qLibraryId) {
        const c = DIMENSIONS[d.qLibraryId];
        if (!c) throw { code: 2, message: "Invalid dimension library id " + d.qLibraryId };
        return c;
    }
    return d.qDef?.qFieldDefs?.[0];
};

// ─── Session Engine ─────────────────────────────────────────────────────────
function nouvelleSession(ws) {
    const selections = {}; // champ → Set de valeurs
    const handles = new Map(); // handle → { type, ... }
    const parId = new Map();
    let prochainHandle = 2;
    const filtre = () => {
        const actifs = Object.entries(selections).filter(([c, s]) => s.size > 0 && c !== "Période");
        return actifs.length === 0 ? faits : faits.filter((f) => actifs.every(([c, s]) => s.has(f[c])));
    };
    const nouveauHandle = (obj) => { const h = prochainHandle++; handles.set(h, obj); return h; };
    const calculerCube = (def) => {
        const dims = (def.qDimensions ?? []).map(dimension);
        const mes = (def.qMeasures ?? []).map(mesure);
        const rows = filtre();
        const groupes = new Map();
        if (dims.length === 0) groupes.set("", rows);
        else for (const r of rows) {
            const k = dims.map((d) => r[d]).join("\u0001");
            let g = groupes.get(k);
            if (!g) { g = []; groupes.set(k, g); }
            g.push(r);
        }
        const lignes = [];
        for (const g of groupes.values()) {
            const cellules = dims.map((d) => ({ qText: String(g[0][d]), qNum: CHAMPS_NUM.has(d) ? g[0][d] : "NaN", qElemNumber: indexValeur[d].get(g[0][d]) ?? 0, qState: "O" }));
            for (const f of mes) {
                const v = f(g);
                cellules.push({ qText: Number.isFinite(v) ? String(v) : "-", qNum: Number.isFinite(v) ? v : "NaN", qElemNumber: 0, qState: "L" });
            }
            lignes.push(cellules);
        }
        return { lignes, largeur: dims.length + mes.length };
    };
    const page = (lignes, p) => ({
        qArea: { qTop: p.qTop, qLeft: p.qLeft ?? 0, qWidth: p.qWidth, qHeight: Math.min(p.qHeight, Math.max(0, lignes.length - p.qTop)) },
        qMatrix: lignes.slice(p.qTop, p.qTop + p.qHeight).map((l) => l.slice(p.qLeft ?? 0, (p.qLeft ?? 0) + p.qWidth)),
    });
    const listeValeurs = (champ) => valeursChamp[champ].map((v, i) => [{ qText: String(v), qNum: CHAMPS_NUM.has(champ) ? v : "NaN", qElemNumber: i, qState: "O" }]);
    const selectionner = (champ, valeurs, bascule) => {
        const connues = valeursChamp[champ];
        const trouvees = [];
        for (const fv of valeurs) {
            let v;
            if (CHAMPS_NUM.has(champ) && typeof fv.qNum === "number") v = connues.find((x) => x === fv.qNum);
            else v = connues.find((x) => String(x) === String(fv.qText));
            if (v !== undefined) trouvees.push(v);
        }
        if (!bascule || !selections[champ]) selections[champ] = new Set();
        for (const v of trouvees) {
            if (bascule && selections[champ].has(v)) selections[champ].delete(v);
            else selections[champ].add(v);
        }
        return trouvees.length > 0;
    };

    const methodes = {
        OpenDoc: (h, p) => {
            if (p.qDocName !== APP) throw { code: 1002, message: "App not found" };
            return { qReturn: { qType: "Doc", qHandle: 1, qGenericId: APP } };
        },
        GetField: (h, p) => {
            if (!CHAMPS.includes(p.qFieldName)) throw { code: 2, message: "Field not found " + p.qFieldName };
            return { qReturn: { qType: "Field", qHandle: nouveauHandle({ type: "champ", champ: p.qFieldName }) } };
        },
        Clear: (h) => {
            const o = handles.get(h);
            if (o?.type !== "champ") throw { code: -32601, parameter: "Clear", message: "Method not found" };
            delete selections[o.champ];
            return { qReturn: true };
        },
        SelectValues: (h, p) => {
            const o = handles.get(h);
            if (o?.type !== "champ") throw { code: -32601, parameter: "SelectValues", message: "Method not found" };
            return { qReturn: selectionner(o.champ, p.qFieldValues ?? [], !!p.qToggleMode) };
        },
        CreateSessionObject: (h, p) => {
            const prop = p.qProp ?? {};
            const id = "obj-" + prochainHandle;
            const obj = { type: "objet", id, prop };
            const handle = nouveauHandle(obj);
            parId.set(id, handle);
            return { qReturn: { qType: "GenericObject", qHandle: handle, qGenericType: prop.qInfo?.qType, qGenericId: id } };
        },
        DestroySessionObject: (h, p) => {
            const handle = parId.get(p.qId);
            if (handle == null) throw { code: 15, message: "Request aborted" };
            parId.delete(p.qId);
            handles.delete(handle);
            return { qSuccess: true };
        },
        GetLayout: (h) => {
            const o = handles.get(h);
            if (o?.type !== "objet") throw { code: -32601, parameter: "GetLayout", message: "Method not found" };
            const prop = o.prop;
            if (prop.qMeasureListDef) {
                return { qLayout: { qInfo: prop.qInfo, qMeasureList: { qItems: MAITRES.map((m) => ({ qInfo: { qId: m.id, qType: "measure" }, qMeta: { title: m.titre }, qData: { title: m.titre, expr: m.expr } })) } } };
            }
            if (prop.qDimensionListDef) {
                return { qLayout: { qInfo: prop.qInfo, qDimensionList: { qItems: Object.entries(DIMENSIONS).map(([id, t]) => ({ qInfo: { qId: id, qType: "dimension" }, qMeta: { title: t }, qData: { title: t } })) } } };
            }
            if (prop.qListObjectDef) {
                const champ = dimension(prop.qListObjectDef);
                const lignes = listeValeurs(champ);
                o.lignes = lignes;
                o.champ = champ;
                const pages = (prop.qListObjectDef.qInitialDataFetch ?? []).map((p) => page(lignes, p));
                return { qLayout: { qInfo: prop.qInfo, qListObject: { qSize: { qcx: 1, qcy: lignes.length }, qDataPages: pages } } };
            }
            if (prop.qHyperCubeDef) {
                const { lignes, largeur } = calculerCube(prop.qHyperCubeDef);
                o.lignes = lignes;
                if (largeur * Math.max(...(prop.qHyperCubeDef.qInitialDataFetch ?? [{ qHeight: 0 }]).map((p) => p.qHeight)) > 10000) {
                    throw { code: 7009, message: "Too many cells requested" };
                }
                const pages = (prop.qHyperCubeDef.qInitialDataFetch ?? []).map((p) => page(lignes, p));
                return { qLayout: { qInfo: prop.qInfo, qHyperCube: { qSize: { qcx: largeur, qcy: lignes.length }, qDataPages: pages } } };
            }
            throw { code: 2, message: "Unsupported object" };
        },
        GetHyperCubeData: (h, p) => {
            const o = handles.get(h);
            if (!o?.lignes) throw { code: -32601, parameter: "GetHyperCubeData", message: "Method not found" };
            for (const pg of p.qPages) if (pg.qWidth * pg.qHeight > 10000) throw { code: 7009, message: "Too many cells requested" };
            return { qDataPages: p.qPages.map((pg) => page(o.lignes, pg)) };
        },
        GetListObjectData: (h, p) => {
            const o = handles.get(h);
            if (!o?.lignes) throw { code: -32601, parameter: "GetListObjectData", message: "Method not found" };
            return { qDataPages: p.qPages.map((pg) => page(o.lignes, pg)) };
        },
        SelectListObjectValues: (h, p) => {
            const o = handles.get(h);
            if (!o?.champ) throw { code: -32601, parameter: "SelectListObjectValues", message: "Method not found" };
            const vals = (p.qValues ?? []).map((i) => valeursChamp[o.champ][i]).filter((v) => v !== undefined);
            if (!p.qToggleMode || !selections[o.champ]) selections[o.champ] = new Set();
            for (const v of vals) selections[o.champ].add(v);
            return { qReturn: vals.length > 0 };
        },
    };

    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "OnConnected", params: { qSessionState: "SESSION_CREATED" } }));
    ws.on("message", async (raw) => {
        let m;
        try { m = JSON.parse(String(raw)); } catch { return; }
        stats.rpc++;
        stats.methodes[m.method] = (stats.methodes[m.method] ?? 0) + 1;
        const f = methodes[m.method];
        if (DELAI_MS && m.method === "GetLayout") await new Promise((r) => setTimeout(r, DELAI_MS));
        try {
            if (!f) throw { code: -32601, parameter: m.method, message: "Method not found" };
            const result = f(m.handle, m.params ?? {});
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
        } catch (e) {
            const error = e && typeof e === "object" && "code" in e ? e : { code: -1, message: String(e?.message || e) };
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error }));
        }
    });
}

// ─── HTTP ───────────────────────────────────────────────────────────────────
const cookies = (req) => Object.fromEntries(String(req.headers.cookie ?? "").split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf("="); return [c.slice(0, i), c.slice(i + 1)]; }));
const pageApp = () => `<!doctype html><html><head><meta charset="utf-8"><title>Qlik Sense</title></head><body>
<div id="qv-page-container">faux client Qlik</div>
<script>
  // Le vrai client ouvre son websocket Engine avec le jeton CSRF dans l'URL.
  console.log("client Qlik : démarrage");
  const ws = new WebSocket("wss://" + location.host + "/app/${APP}?reloadUri=" + encodeURIComponent(location.href) + "&qlik-csrf-token=${encodeURIComponent(JETON)}");
  ws.onopen = () => console.log("client Qlik : websocket ouvert");
</script></body></html>`;

const serveur = https.createServer({ key: fs.readFileSync(path.join(ICI, "key.pem")), cert: fs.readFileSync(path.join(ICI, "cert.pem")) }, (req, res) => {
    const url = new URL(req.url, "https://localhost");
    const auth = String(req.headers.authorization ?? "");
    if (url.pathname === "/hub/" && url.searchParams.has("qlikTicket")) {
        stats.ticket++;
        if (url.searchParams.get("qlikTicket") !== "TICKET-OK") { res.writeHead(403); return res.end("ticket"); }
        res.writeHead(302, { Location: "/hub/", "Set-Cookie": `X-Qlik-Session=${SESSION}; Path=/; HttpOnly; Secure` });
        return res.end();
    }
    if (url.pathname === "/hub/") {
        res.writeHead(302, { Location: "https://localhost/forms/?targetId=1a2b3c4d-0000-1111-2222-333344445555" });
        return res.end();
    }
    if (url.pathname === "/internal_windows_authentication/") {
        if (auth.startsWith("NTLM TlRMTVNTUAAB")) {
            stats.ntlm1++;
            res.writeHead(401, { "WWW-Authenticate": ["Negotiate", "NTLM " + TYPE2], Connection: "keep-alive", "Content-Length": 0 });
            return res.end();
        }
        if (auth.startsWith("NTLM TlRMTVNTUAAD")) {
            stats.ntlm3++;
            res.writeHead(302, { Location: "https://localhost/hub/?qlikTicket=TICKET-OK" });
            return res.end();
        }
        res.writeHead(401, { "WWW-Authenticate": ["Negotiate", "NTLM"], "Content-Length": 0 });
        return res.end();
    }
    if (url.pathname.startsWith("/sense/app/")) {
        if (cookies(req)["X-Qlik-Session"] !== SESSION) { stats.pageRefusee++; res.writeHead(302, { Location: "/hub/" }); return res.end(); }
        stats.page++;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(pageApp());
    }
    if (url.pathname === "/__stats") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(stats)); }
    res.writeHead(404); res.end("introuvable");
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 * 1024 });
serveur.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "https://localhost");
    const ok = url.pathname === "/app/" + APP && cookies(req)["X-Qlik-Session"] === SESSION && url.searchParams.get("qlik-csrf-token") === JETON;
    if (!ok) {
        stats.wsRefuse++;
        log("websocket refusé", url.pathname, "cookie=" + (cookies(req)["X-Qlik-Session"] === SESSION), "jeton=" + (url.searchParams.get("qlik-csrf-token") === JETON));
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        return socket.destroy();
    }
    stats.ws++;
    wss.handleUpgrade(req, socket, head, (ws) => nouvelleSession(ws));
});
const PORT = Number(process.env.PORT || 443);
serveur.listen(PORT, "127.0.0.1", () => log(`à l'écoute sur https://localhost:${PORT}`));
