/**
 * CollectFlow — Validation des expressions Qlik et de la clé de jointure.
 *
 * À lancer DEPUIS le réseau qui atteint Qlik (typiquement le conteneur de l'app) :
 *
 *   docker exec -e QLIK_PWD='<mot de passe>' -it <conteneur> node scripts/qlik-validate.mjs
 *
 * Répond aux deux questions encore ouvertes :
 *
 *  1. Les master measures « CA N » / « Quantité N » ignorent-elles la sélection
 *     Date, et les agrégations directes (`Sum(quantite)`, `Sum(ca_ht)`…) sont-elles
 *     un substitut fidèle ? Le script affiche, pour quelques articles réellement
 *     vendus, un tableau mois par mois comparant les deux — dont les mois d'août à
 *     décembre qui ressortaient vides.
 *
 *  2. Quelle valeur joint avec `articles.artcentrale` : la dimension « Article
 *     Code » ou le champ `article_no_centrale` ? Le script affiche les deux
 *     côte à côte.
 *
 * Aucun secret n'est écrit ni affiché : le mot de passe vient de l'environnement.
 * Le script est en LECTURE SEULE (sélections en soft lock, objets de session
 * détruits) — il ne modifie rien dans Qlik.
 */

import httpntlm from "httpntlm";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright-core";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // certificat interne

const HOST = process.env.QLIK_HOST || "reporting-magasins.lafoirfouille.fr";
const USER = process.env.QLIK_USER || "FFSCH";
const PWD = process.env.QLIK_PWD || "";
const DOMAIN = process.env.QLIK_DOMAIN ?? "";
const APP = process.env.QLIK_APP_NETWORK || "9872ee6e-d64a-4b43-984a-076bf1f7f647";
const DIM_ARTICLE = process.env.QLIK_DIM_CODE_ARTICLE_ID || "yesCP";
const DIM_MOIS = process.env.QLIK_MOIS_DIM_ID || "pfGAwTs";
const NB_ARTICLES = Number(process.env.QLIK_VALIDATE_ARTICLES || "3");

if (!PWD) {
    console.error("ERREUR : définir QLIK_PWD dans l'environnement.");
    console.error("  docker exec -e QLIK_PWD='…' -it <conteneur> node scripts/qlik-validate.mjs");
    process.exit(1);
}

const xrfkey = randomBytes(12).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 16).padEnd(16, "0");

// ─── Fenêtre 12 mois glissants, mois courant exclu (même règle que l'app) ────

const QLIK_EPOCH_MS = Date.UTC(1899, 11, 30);
const serialDe = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - QLIK_EPOCH_MS) / 86_400_000);

function fenetre12Mois(now = new Date()) {
    const debut = new Date(now.getFullYear(), now.getMonth() - 12, 1);
    const fin = new Date(now.getFullYear(), now.getMonth(), 0);
    const serials = [];
    const s0 = serialDe(debut.getFullYear(), debut.getMonth() + 1, debut.getDate());
    const s1 = serialDe(fin.getFullYear(), fin.getMonth() + 1, fin.getDate());
    for (let s = s0; s <= s1; s++) serials.push(s);
    const labels = [];
    for (let i = 12; i >= 1; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        labels.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    return { serials, labels, debut: debut.toISOString().slice(0, 10), fin: fin.toISOString().slice(0, 10) };
}

// ─── Auth NTLM → cookie de session ──────────────────────────────────────────

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
                headers: { "User-Agent": "Mozilla/5.0 CollectFlow", "X-Qlik-Xrfkey": xrfkey },
            },
            (err, res) => (err ? reject(err) : resolve(res)),
        );
    });
}

function cookieDepuis(setCookie) {
    const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [String(setCookie)] : [];
    return arr.map((c) => String(c).split(";")[0]).find((c) => /X-Qlik-Session/i.test(c)) ?? null;
}

async function session() {
    const hub = await fetch(`https://${HOST}/hub/`, { redirect: "manual" });
    const targetId = ((hub.headers.get("location") ?? "").match(/targetId=([0-9a-f-]+)/i) ?? [])[1] ?? "";
    const chemin = targetId
        ? `/internal_windows_authentication/?targetId=${targetId}&xrfkey=${xrfkey}`
        : `/hub/?xrfkey=${xrfkey}`;
    const res = await ntlmGet(chemin);

    const direct = cookieDepuis(res.headers["set-cookie"]);
    if (direct) return direct;

    const loc = String(res.headers["location"] ?? "");
    if (!/qlikTicket=/.test(loc)) throw new Error(`auth NTLM sans ticket (HTTP ${res.statusCode})`);
    const ech = await fetch(loc, { redirect: "manual" });
    const sc = typeof ech.headers.getSetCookie === "function" ? ech.headers.getSetCookie() : [];
    const cookie = sc.map((c) => c.split(";")[0]).filter((c) => /X-Qlik-Session/i.test(c)).join("; ");
    if (!cookie) throw new Error("ticket non échangé contre un cookie de session");
    return cookie;
}

// ─── Script exécuté dans la page (websocket Engine accepté par le proxy) ────

function scriptInPage({ app, token, dimArticle, dimMois, serials, labels, nbArticles }) {
    return new Promise((resolve) => {
        const url = `wss://${location.host}/app/${app}?reloadUri=${encodeURIComponent(location.href)}&qlik-csrf-token=${token}`;
        const ws = new WebSocket(url);
        const sortie = [];
        const log = (l) => { sortie.push(l); console.log("[cf] " + l); };
        let id = 0;
        const pend = new Map();
        const rpc = (method, params, handle = -1) => new Promise((res, rej) => {
            const i = ++id; pend.set(i, { res, rej });
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: i, handle, method, params }));
        });
        const pret = new Promise((res, rej) => {
            ws.onmessage = (ev) => {
                const m = JSON.parse(ev.data);
                if (m.method === "OnConnected") return res();
                if (m.id && pend.has(m.id)) {
                    const p = pend.get(m.id); pend.delete(m.id);
                    if (m.error) p.rej(new Error(JSON.stringify(m.error)));
                    else p.res(m.result);
                }
            };
            ws.onerror = () => rej(new Error("websocket refusé (403 ?)"));
            setTimeout(() => rej(new Error("timeout websocket")), 30000);
        });
        const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

        (async () => {
            try {
                await pret;
                const doc = (await rpc("OpenDoc", { qDocName: app })).qReturn.qHandle;

                // ─── 1. Expressions des master measures ──────────────────────
                const ml = await rpc("CreateSessionObject", {
                    qProp: {
                        qInfo: { qType: "MeasureList" },
                        qMeasureListDef: { qType: "measure", qData: { title: "/qMetaDef/title", expr: "/qMeasure/qDef" } },
                    },
                }, doc);
                const items = (await rpc("GetLayout", {}, ml.qReturn.qHandle)).qLayout.qMeasureList?.qItems ?? [];
                const parTitre = new Map();
                log("=== EXPRESSIONS DES MASTER MEASURES ===");
                for (const it of items) {
                    const t = (it.qMeta?.title ?? it.qData?.title ?? "").trim();
                    if (!t) continue;
                    parTitre.set(t.toLowerCase(), it.qInfo.qId);
                    if (/^(CA N|Quantité N|Magasin Ventes Nb N|CA par Magasin N|Marge % N|Quantité COMP)$/i.test(t)) {
                        log(`  « ${t} » = ${it.qData?.expr ?? "?"}`);
                    }
                }
                const mesure = (t) => parTitre.get(t.toLowerCase()) ?? null;

                // ─── 2. Sélection de la fenêtre 12 mois ──────────────────────
                const champDate = await rpc("GetField", { qFieldName: "Date" }, doc);
                const dh = champDate.qReturn.qHandle;
                await rpc("Clear", {}, dh);
                await dormir(300);
                for (let i = 0; i < serials.length; i += 500) {
                    await rpc("SelectValues", {
                        qFieldValues: serials.slice(i, i + 500).map((s) => ({ qNum: s, qText: String(s) })),
                        qToggleMode: i > 0,
                        qSoftLock: true,
                    }, dh);
                }
                await dormir(500);
                log("");
                log(`=== FENÊTRE SÉLECTIONNÉE : ${labels[0]} → ${labels[labels.length - 1]} (${serials.length} jours) ===`);

                // ─── 3. Articles les plus vendus (par agrégation directe) ────
                const cubeTop = await rpc("CreateSessionObject", {
                    qProp: {
                        qInfo: { qType: "cf-val-top" },
                        qHyperCubeDef: {
                            qDimensions: [{ qLibraryId: dimArticle }],
                            qMeasures: [{ qDef: { qDef: "Sum(quantite)" }, qSortBy: { qSortByNumeric: -1 } }],
                            qInterColumnSortOrder: [1, 0],
                            qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 2, qHeight: nbArticles }],
                        },
                    },
                }, doc);
                const topMatrix = (await rpc("GetLayout", {}, cubeTop.qReturn.qHandle))
                    .qLayout.qHyperCube.qDataPages?.[0]?.qMatrix ?? [];
                const codes = topMatrix.map((r) => String(r[0]?.qText ?? "")).filter(Boolean);
                log(`articles testés (top ventes) : ${JSON.stringify(codes)}`);
                if (codes.length === 0) { ws.close(); return resolve({ ok: false, error: "aucun article vendu sur la fenêtre", sortie }); }

                const champArticle = await rpc("GetField", { qFieldName: "Article Code" }, doc);
                const ah = champArticle.qReturn.qHandle;
                await rpc("Clear", {}, ah);
                await dormir(300);
                await rpc("SelectValues", { qFieldValues: codes.map((c) => ({ qText: c })), qToggleMode: false, qSoftLock: true }, ah);
                await dormir(500);

                // ─── 4. Comparaison mois par mois ────────────────────────────
                const mesures = [
                    { qDef: { qDef: "Sum(quantite)" } },
                    { qDef: { qDef: "Sum(ca_ht)" } },
                    { qDef: { qDef: "Sum(ca_ttc)" } },
                    { qDef: { qDef: "Count(DISTINCT [Magasin Code])" } },
                    { qDef: { qDef: "Sum(marge)" } },
                ];
                const idQte = mesure("Quantité N");
                const idCa = mesure("CA N");
                const idNbMag = mesure("Magasin Ventes Nb N");
                if (idQte) mesures.push({ qLibraryId: idQte });
                if (idCa) mesures.push({ qLibraryId: idCa });
                if (idNbMag) mesures.push({ qLibraryId: idNbMag });
                const largeur = 2 + mesures.length;

                const cube = await rpc("CreateSessionObject", {
                    qProp: {
                        qInfo: { qType: "cf-val-mois" },
                        qHyperCubeDef: {
                            qDimensions: [{ qLibraryId: dimArticle }, { qLibraryId: dimMois }],
                            qMeasures: mesures,
                            qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: largeur, qHeight: 400 }],
                        },
                    },
                }, doc);
                const hc = (await rpc("GetLayout", {}, cube.qReturn.qHandle)).qLayout.qHyperCube;
                const lignes = hc.qDataPages?.[0]?.qMatrix ?? [];

                log("");
                log("=== COMPARAISON MOIS PAR MOIS (agrégation directe vs master measure) ===");
                log("article       mois     Sum(quantite)  Quantité N | Sum(ca_ht)  Sum(ca_ttc)     CA N | Count(mag)  Mag Nb N");
                const pad = (v, n) => String(v).padStart(n);
                for (const r of lignes) {
                    const code = String(r[0]?.qText ?? "");
                    const moisBrut = String(r[1]?.qText ?? "");
                    const mois = /^\d{6}$/.test(moisBrut) ? moisBrut.slice(0, 4) + "-" + moisBrut.slice(4) : moisBrut;
                    const n = (i) => Number(r[2 + i]?.qNum ?? 0) || 0;
                    log(
                        code.padEnd(13) + mois.padEnd(9) +
                        pad(Math.round(n(0)), 13) + pad(Math.round(n(5)), 12) + " |" +
                        pad(Math.round(n(1)), 11) + pad(Math.round(n(2)), 13) + pad(Math.round(n(6)), 9) + " |" +
                        pad(Math.round(n(3)), 11) + pad(Math.round(n(7)), 10),
                    );
                }
                log("");
                log("LECTURE : si « Quantité N » vaut 0 sur les mois de l'année précédente alors que");
                log("          Sum(quantite) est renseigné, la master measure est bien inutilisable");
                log("          pour une fenêtre glissante — et l'agrégation directe la remplace.");
                log("          Si Sum(quantite) == Quantité N sur les mois de l'année en cours,");
                log("          l'expression par défaut de CollectFlow est validée.");
                log("          Comparer aussi Sum(ca_ht) et Sum(ca_ttc) à « CA N » pour choisir");
                log("          QLIK_EXPR_CA.");

                // ─── 5. Clé de jointure : Article Code vs article_no_centrale ─
                const cubeCle = await rpc("CreateSessionObject", {
                    qProp: {
                        qInfo: { qType: "cf-val-cle" },
                        qHyperCubeDef: {
                            qDimensions: [
                                { qLibraryId: dimArticle },
                                { qDef: { qFieldDefs: ["article_no_centrale"] } },
                                { qDef: { qFieldDefs: ["article_codein"] } },
                            ],
                            qMeasures: [],
                            qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 3, qHeight: 20 }],
                        },
                    },
                }, doc);
                const cles = (await rpc("GetLayout", {}, cubeCle.qReturn.qHandle))
                    .qLayout.qHyperCube.qDataPages?.[0]?.qMatrix ?? [];
                log("");
                log("=== CLÉ DE JOINTURE ===");
                log("Article Code        article_no_centrale   article_codein");
                for (const r of cles) {
                    log(
                        String(r[0]?.qText ?? "").padEnd(20) +
                        String(r[1]?.qText ?? "").padEnd(22) +
                        String(r[2]?.qText ?? ""),
                    );
                }
                log("");
                log("LECTURE : la bonne clé est celle qui a le format de `articles.artcentrale`");
                log("          côté FF Nancy (ex. 10000167303 — préfixe 10000 + 6 chiffres).");

                ws.close();
                resolve({ ok: true, sortie });
            } catch (e) {
                try { ws.close(); } catch { /* noop */ }
                resolve({ ok: false, error: String(e?.message || e), sortie });
            }
        })();
    });
}

// ─── Orchestration ──────────────────────────────────────────────────────────

(async () => {
    const f = fenetre12Mois();
    console.log(`Qlik ${HOST} — app ${APP}`);
    console.log(`Fenêtre : ${f.debut} → ${f.fin}\n`);

    const cookie = await session();
    console.log("✓ authentifié (NTLM + ticket)\n");
    const [nom, ...reste] = cookie.split("=");

    const navigateur = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"],
    });
    const ctx = await navigateur.newContext({
        httpCredentials: { username: USER, password: PWD, origin: `https://${HOST}` },
        ignoreHTTPSErrors: true,
    });
    await ctx.addCookies([{ name: nom, value: reste.join("="), domain: HOST, path: "/", secure: true }]);

    try {
        const page = await ctx.newPage();
        let token = null;
        let pret;
        const attente = new Promise((r) => { pret = r; });
        page.on("websocket", (ws) => {
            const m = ws.url().match(/qlik-csrf-token=([^&]+)/);
            if (m && !token) { token = decodeURIComponent(m[1]); pret(); }
        });
        await page.goto(`https://${HOST}/sense/app/${APP}`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        await Promise.race([attente, page.waitForTimeout(20000)]);
        if (!token) throw new Error("qlik-csrf-token introuvable (client Qlik non chargé ?)");

        const res = await page.evaluate(scriptInPage, {
            app: APP, token, dimArticle: DIM_ARTICLE, dimMois: DIM_MOIS,
            serials: f.serials, labels: f.labels, nbArticles: NB_ARTICLES,
        });

        console.log(res.sortie.join("\n"));
        if (!res.ok) {
            console.error("\nÉCHEC : " + res.error);
            process.exitCode = 1;
        }
    } finally {
        await ctx.close();
        await navigateur.close();
    }
})().catch((e) => {
    console.error("ERREUR :", e?.message || e);
    process.exit(1);
});
