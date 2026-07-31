/**
 * CollectFlow — Recherche produit **dans Qlik Sense** (source primaire).
 *
 * La recherche produit part du réseau, pas du catalogue Nancy : on interroge
 * d'abord l'app Qlik « Magasins Vision Consolidée » pour trouver les articles
 * qui correspondent au terme saisi (libellé ou code centrale), puis l'appelant
 * rapproche les codes centraux trouvés de la base FF Nancy.
 *
 * Pourquoi Qlik d'abord : le réseau (~270 magasins) référence beaucoup plus de
 * produits que Nancy. Chercher dans la base locale d'abord masquait tous les
 * produits que le réseau travaille et que nous ne référençons pas — c'est
 * précisément ce qu'on veut voir.
 *
 * Technique : même plomberie que `qlik-playwright.ts` (Chromium headless +
 * websocket Engine in-page avec le qlik-csrf-token), car le proxy Qlik refuse
 * un websocket « raw » côté serveur.
 *
 * ## Comment la sélection est construite
 *
 * La recherche d'un list object Qlik (`SearchListObjectFor`) applique un **OU**
 * entre les mots : « tapis anti » a ramené 17 696 libellés sur l'app FF, dont
 * l'immense majorité ne contient que « anti ». Sélectionner ces 17 696 valeurs
 * faisait ensuite exploser le cube (`code 15 — Request aborted`).
 *
 * On procède donc en trois temps :
 *   1. une recherche par mot, pour retenir le **plus sélectif** (celui qui
 *      ramène le moins de valeurs) ;
 *   2. lecture de ces valeurs et filtrage **ET** côté client (tous les mots
 *      présents, insensible casse/accents) ;
 *   3. sélection des seules valeurs retenues, **par numéro d'élément**
 *      (`SelectListObjectValues`) — exact, sans ré-appariement de texte.
 *
 * Le résultat final est revérifié une dernière fois avant d'être renvoyé : une
 * liste sans rapport avec la recherche est pire que pas de résultat du tout.
 */

import "server-only";
import { chromium, type Browser } from "playwright-core";
import { getQlikConfig, qlikNtlmSession, type QlikConfig } from "@/lib/qlik-client";
import { buildGridNetworkQlikDateFilter, QLIK_MONTHS_BACK_DEFAULT } from "@/lib/qlik-date-range";

/**
 * Un article trouvé côté Qlik, **avec ses mesures réseau sur 12 mois glissants**.
 *
 * Les mesures sortent du même cube que l'identité : une seule session Qlik pour
 * toute la recherche. Les extraire dans une seconde session concurrente faisait
 * abandonner le moteur (`code 15 — Request aborted`).
 */
export interface QlikArticleMatch {
    /** Valeur de la dimension « Article Code » — clé de jointure de la Grille. */
    codeCentrale: string;
    /**
     * Champ `article_no_centrale` quand l'app l'expose : second candidat pour la
     * jointure avec `articles.artcentrale`, les deux ne portant pas toujours le
     * même format.
     */
    codeCentraleAlt: string;
    /** Libellé réseau, si l'app expose un champ libellé article. */
    libelle: string;
    /** Fournisseur réseau, si l'app expose un champ fournisseur. */
    fournisseur: string;
    /** CA réseau sur la fenêtre 12 mois glissants. */
    caReseau: number;
    qteReseau: number;
    nbMagasinsReseau: number;
    caParMagasinReseau: number;
    /** Taux de marge réseau, ratio brut Qlik (0.32 = 32 %). */
    margePctReseau: number;
}

export interface QlikSearchOutcome {
    matches: QlikArticleMatch[];
    /** Champ Qlik effectivement interrogé (diagnostic UI). */
    champUtilise: string | null;
    /** true si Qlik a renvoyé plus de résultats que la limite demandée. */
    tronque: boolean;
    /**
     * Message de diagnostic quand la recherche aboutit à zéro article alors que
     * Qlik a bien répondu (filtre non appliqué, terme trop large…). `null` en
     * fonctionnement nominal.
     */
    avertissement: string | null;
    /** Fenêtre couverte par les mesures (`YYYY-MM_YYYY-MM`). */
    periode: string | null;
}

/**
 * Nombre maximum d'articles renvoyés par une recherche.
 *
 * Chaque code trouvé est ensuite ré-extrait avec son détail mensuel : au-delà
 * de quelques dizaines, la seconde passe devient longue et le résultat
 * illisible. L'utilisateur affine son terme.
 */
export const QLIK_SEARCH_MAX_RESULTS = 40;

/**
 * Champs candidats pour le libellé article, par ordre de préférence.
 *
 * Sur l'app FF, `Article` est le libellé métier et `article_libelle_ticket` le
 * libellé (tronqué) imprimé sur le ticket. On essaie le premier qui donne des
 * résultats : si un candidat ne matche rien, on passe au suivant.
 */
const CHAMPS_LIBELLE_PREFERES = ["Article", "article_libelle_ticket"];

/** Champs candidats pour le fournisseur, par ordre de préférence (nom avant code). */
const CHAMPS_FOURNISSEUR_PREFERES = ["Fournisseur", "code_fournisseur"];

/**
 * Champ portant le code centrale « brut » de l'article, quand il existe.
 * Second candidat de jointure avec `articles.artcentrale` : sur l'app FF, la
 * dimension « Article Code » ne renvoie pas le même format.
 */
const CHAMP_CODE_CENTRALE_ALT = "article_no_centrale";

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

interface InPageSearchResult {
    ok: boolean;
    error?: string;
    /** [code, codeAlt, libellé, fournisseur, ca, qte, nbMag, caMag, margePct] */
    rows?: Array<[string, string, string, string, number, number, number, number, number]>;
    champUtilise?: string | null;
    /** Nombre d'articles uniques correspondant au terme (avant plafonnement). */
    total?: number;
    /** Lignes brutes lues dans le cube (avant garde-fou). */
    lues?: number;
    /** Lignes écartées parce qu'elles ne correspondaient pas au terme. */
    rejetees?: number;
    /** true si le terme ramenait trop de valeurs pour être traité intégralement. */
    tropLarge?: boolean;
    /** Journal compact des étapes, remonté dans les logs serveur. */
    trace?: string[];
}

/**
 * Cherche dans Qlik les articles correspondant à `term`.
 *
 * Ne fait **aucune** mesure : on veut juste la liste des codes centraux (plus
 * libellé / fournisseur si l'app les expose). Les métriques réseau sont
 * ensuite extraites par `fetchNetworkMetricsPlaywright`, qui sait déjà produire
 * le détail mensuel sur 12 mois glissants.
 */
export async function searchQlikArticles(
    term: string,
    limit: number = QLIK_SEARCH_MAX_RESULTS,
    cfg: QlikConfig = getQlikConfig(),
): Promise<QlikSearchOutcome> {
    const cleaned = term.trim();
    if (cleaned.length < 3) return { matches: [], champUtilise: null, tronque: false, avertissement: null, periode: null };
    if (!cfg.appNetwork) throw new Error("[qlik-search] QLIK_APP_NETWORK manquant");
    if (!cfg.user || !cfg.password) throw new Error("[qlik-search] identifiants Qlik manquants");

    const started = Date.now();
    // Latence laissée à l'Engine après chaque mutation de sélection. Même réglage
    // que l'extraction (`QLIK_SETTLE_MS`) : sans elle, l'objet créé juste après
    // est calculé sur l'état de sélection précédent.
    const settleMs = Math.min(2000, Math.max(0, Number(process.env.QLIK_SETTLE_MS ?? "250") || 250));
    // Même fenêtre que la Grille : 12 mois complets glissants, mois courant exclu.
    const dateFilter = buildGridNetworkQlikDateFilter(
        new Date(),
        QLIK_MONTHS_BACK_DEFAULT,
    );
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
        page.on("console", (msg) => {
            // Le client Qlik est très bavard au chargement (thèmes, extensions) :
            // on ne relaie que ce qui vient de notre script.
            const t = msg.text();
            if (t.startsWith("[cf]")) console.log(`[qlik-search][page] ${t}`);
        });

        let csrfToken: string | null = null;
        let resolveToken: (() => void) | null = null;
        const tokenReady = new Promise<void>((r) => { resolveToken = r; });
        page.on("websocket", (ws) => {
            const m = ws.url().match(/qlik-csrf-token=([^&]+)/);
            if (m && !csrfToken) { csrfToken = decodeURIComponent(m[1]); resolveToken?.(); }
        });

        await page.goto(`https://${cfg.host}/sense/app/${cfg.appNetwork}`, { waitUntil: "domcontentloaded", timeout: cfg.timeoutMs })
            .catch(() => { /* le client Qlik ouvre son ws juste après */ });
        await Promise.race([tokenReady, page.waitForTimeout(15000)]);
        if (!csrfToken) throw new Error("[qlik-search] qlik-csrf-token introuvable (client Qlik non chargé ?)");

        const result = (await page.evaluate(
            ({ app, dim, token, terme, limite, settleMs, serialsDate, mCa, mQte, mNbMag, mCaMag, mMarge,
               champCodeAlt, champsLibellePreferes, champsFournisseurPreferes, champLibelleForce, champFournisseurForce }: {
                app: string; dim: string; token: string; terme: string; limite: number; settleMs: number;
                serialsDate: number[];
                mCa: string; mQte: string; mNbMag: string; mCaMag: string; mMarge: string;
                champCodeAlt: string;
                champsLibellePreferes: string[]; champsFournisseurPreferes: string[];
                champLibelleForce: string; champFournisseurForce: string;
            }) =>
                new Promise<InPageSearchResult>((resolve) => {
                    /** Valeurs lues au maximum dans le champ recherché (2 pages Engine). */
                    const MAX_VALEURS_LUES = 10000;
                    /**
                     * Valeurs sélectionnées au maximum.
                     *
                     * Mesuré en production : sélectionner les 13 446 libellés contenant
                     * « tapis » a mis 81 s puis 486 s, et faisait abandonner le cube
                     * (code 15). Le cube étant trié par quantité réseau décroissante et
                     * l'affichage plafonné à quelques dizaines de lignes, 300 libellés
                     * suffisent largement.
                     */
                    const MAX_VALEURS_SELECTION = 300;
                    const PAGE_VALEURS = 5000;

                    const loc = (window as unknown as { location: Location }).location;
                    const url = `wss://${loc.host}/app/${app}?reloadUri=${encodeURIComponent(loc.href)}&qlik-csrf-token=${token}`;
                    const ws = new WebSocket(url);
                    const trace: string[] = [];
                    let id = 0;
                    const pend = new Map<number, { res: (v: { [k: string]: unknown }) => void; rej: (e: unknown) => void }>();
                    const rpc = (method: string, params: unknown, handle = -1) => new Promise<{ [k: string]: unknown }>((res, rej) => {
                        const i = ++id; pend.set(i, { res, rej });
                        ws.send(JSON.stringify({ jsonrpc: "2.0", id: i, handle, method, params }));
                    });
                    const ready = new Promise<void>((res, rej) => {
                        ws.onmessage = (ev: MessageEvent) => {
                            const m = JSON.parse(ev.data as string);
                            if (m.method === "OnConnected") return res();
                            if (m.id && pend.has(m.id)) {
                                const x = pend.get(m.id)!;
                                pend.delete(m.id);
                                if (m.error) x.rej(new Error(JSON.stringify(m.error)));
                                else x.res(m.result);
                            }
                        };
                        ws.onerror = () => rej(new Error("ws error (403 ?)"));
                        setTimeout(() => rej(new Error("ws timeout")), 30000);
                    });

                    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
                    /** Qlik Engine code 15 = « Request aborted » : requête entrée en collision avec une évaluation. */
                    const estCode15 = (e: unknown) => /"code"\s*:\s*15\b/.test(String((e as Error)?.message ?? e));
                    const rpcRetry = async (method: string, params: unknown, handle: number, tentatives = 3) => {
                        let derniere: unknown;
                        for (let i = 1; i <= tentatives; i++) {
                            try {
                                return await rpc(method, params, handle);
                            } catch (e) {
                                derniere = e;
                                if (!estCode15(e) || i === tentatives) throw e;
                                trace.push("code15 sur " + method + ", tentative " + i + "/" + tentatives);
                                await sleep(settleMs * (i + 1));
                            }
                        }
                        throw derniere;
                    };

                    const normaliser = (s: string) => s
                        .toLowerCase()
                        .normalize("NFD")
                        .replace(/[\u0300-\u036f]/g, "")
                        .replace(/[^a-z0-9]+/g, " ")
                        .trim();
                    const mots = normaliser(terme).split(" ").filter(Boolean);

                    (async () => {
                        try {
                            await ready;
                            const open = await rpc("OpenDoc", { qDocName: app });
                            const doc = (open.qReturn as { qHandle: number }).qHandle;

                            // ─── 1. Inventaire des champs ────────────────────────────
                            const fl = await rpc("CreateSessionObject", {
                                qProp: {
                                    qInfo: { qType: "FieldList" },
                                    qFieldListDef: { qShowSystem: false, qShowHidden: false, qShowSemantic: true, qShowSrcTables: true },
                                },
                            }, doc);
                            const fll = await rpc("GetLayout", {}, (fl.qReturn as { qHandle: number }).qHandle);
                            const champs = ((((fll.qLayout as { qFieldList?: { qItems?: Array<{ qName: string }> } }).qFieldList?.qItems) ?? [])
                                .map((f) => f.qName));

                            const has = (nom: string, re: RegExp) => re.test(nom);
                            const champCode = champs.find((c) => c === "Article Code")
                                ?? champs.find((c) => has(c, /article/i) && has(c, /code/i))
                                ?? "Article Code";

                            // Candidats libellé : surcharge d'env, puis noms connus de
                            // l'app FF, puis heuristique. On essaiera chacun dans l'ordre
                            // jusqu'à en trouver un qui ramène des valeurs.
                            const candidatsLibelle = [
                                champLibelleForce,
                                ...champsLibellePreferes,
                                ...champs.filter((c) => has(c, /article/i) && has(c, /(libell|designation|désignation|denomination|dénomination)/i)),
                                ...champs.filter((c) => has(c, /(libell|designation|désignation)/i) && !has(c, /(magasin|region|région|famille|rayon|fournisseur)/i)),
                            ].filter((c, i, arr) => c && champs.includes(c) && arr.indexOf(c) === i);

                            const champFournisseur = [
                                champFournisseurForce,
                                ...champsFournisseurPreferes,
                                ...champs.filter((c) => has(c, /fournisseur/i)),
                                ...champs.filter((c) => has(c, /(fabricant|supplier)/i)),
                            ].find((c) => c && champs.includes(c)) ?? null;

                            trace.push("code=" + champCode + " libellé candidats=" + JSON.stringify(candidatsLibelle) + " fournisseur=" + champFournisseur);

                            // ─── 2. Recherche + sélection sur le champ le plus adapté ─
                            //
                            // `SearchListObjectFor` applique un OU entre les mots. On
                            // cherche donc mot par mot pour retenir le plus sélectif,
                            // puis on filtre en ET côté client avant de sélectionner.
                            const chercherEtSelectionner = async (champ: string): Promise<{ retenues: number; brut: number; tropLarge: boolean }> => {
                                const lo = await rpcRetry("CreateSessionObject", {
                                    qProp: {
                                        qInfo: { qType: "cf-search-lb" },
                                        qListObjectDef: {
                                            qDef: { qFieldDefs: [champ] },
                                            qInitialDataFetch: [],
                                        },
                                    },
                                }, doc);
                                const ret = lo.qReturn as { qHandle: number; qGenericId?: string; qId?: string };
                                const loId = String(ret.qGenericId ?? ret.qId ?? "");
                                const lh = ret.qHandle;
                                try {
                                    // 2a. Mot le plus sélectif (une recherche par mot, on ne lit que le compteur).
                                    let meilleurMot = terme;
                                    let meilleurNb = Number.POSITIVE_INFINITY;
                                    for (const mot of (mots.length > 1 ? mots : [terme])) {
                                        await rpcRetry("SearchListObjectFor", { qPath: "/qListObjectDef", qMatch: mot }, lh);
                                        const lay = await rpcRetry("GetLayout", {}, lh);
                                        const nb = ((lay.qLayout as { qListObject?: { qSize?: { qcy?: number } } }).qListObject?.qSize?.qcy) ?? 0;
                                        trace.push("  « " + mot + " » dans " + champ + " → " + nb + " valeur(s)");
                                        if (nb > 0 && nb < meilleurNb) { meilleurNb = nb; meilleurMot = mot; }
                                    }
                                    if (!Number.isFinite(meilleurNb) || meilleurNb === 0) return { retenues: 0, brut: 0, tropLarge: false };

                                    // 2b. Relecture des valeurs du mot retenu. On relance la
                                    // recherche systématiquement : la boucle ci-dessus a pu
                                    // laisser le list object sur un autre mot.
                                    await rpcRetry("SearchListObjectFor", { qPath: "/qListObjectDef", qMatch: meilleurMot }, lh);
                                    const aLire = Math.min(meilleurNb, MAX_VALEURS_LUES);
                                    const elems: number[] = [];
                                    let lues = 0;
                                    for (let top = 0; top < aLire; top += PAGE_VALEURS) {
                                        const d = await rpcRetry("GetListObjectData", {
                                            qPath: "/qListObjectDef",
                                            qPages: [{ qTop: top, qLeft: 0, qWidth: 1, qHeight: Math.min(PAGE_VALEURS, aLire - top) }],
                                        }, lh);
                                        const matrix = ((d.qDataPages as Array<{ qMatrix?: Array<Array<{ qText?: string; qElemNumber?: number }>> }>)?.[0]?.qMatrix) ?? [];
                                        if (matrix.length === 0) break;
                                        lues += matrix.length;
                                        for (const ligne of matrix) {
                                            const cell = ligne[0];
                                            const texte = String(cell?.qText ?? "");
                                            const elem = cell?.qElemNumber;
                                            if (elem == null || elem < 0) continue;
                                            // Filtre ET : tous les mots du terme présents.
                                            const n = normaliser(texte);
                                            if (!mots.every((m) => n.includes(m))) continue;
                                            elems.push(elem);
                                            if (elems.length >= MAX_VALEURS_SELECTION) break;
                                        }
                                        if (elems.length >= MAX_VALEURS_SELECTION) break;
                                    }
                                    trace.push("  mot retenu « " + meilleurMot + " » : " + lues + " valeur(s) lues → " + elems.length + " après filtre ET");
                                    if (elems.length === 0) {
                                        return { retenues: 0, brut: meilleurNb, tropLarge: meilleurNb > MAX_VALEURS_LUES };
                                    }

                                    // 2c. Sélection par numéro d'élément : exact, aucun
                                    // ré-appariement de texte possible.
                                    await rpcRetry("SelectListObjectValues", {
                                        qPath: "/qListObjectDef",
                                        qValues: elems,
                                        qToggleMode: false,
                                        qSoftLock: true,
                                    }, lh);
                                    await sleep(settleMs);
                                    return { retenues: elems.length, brut: meilleurNb, tropLarge: meilleurNb > MAX_VALEURS_LUES };
                                } finally {
                                    if (loId) { try { await rpc("DestroySessionObject", { qId: loId }, doc); } catch { /* noop */ } }
                                }
                            };

                            await rpc("ClearAll", { qLockedAlso: false }, doc);
                            await sleep(settleMs);

                            let champChoisi: string | null = null;
                            let tropLarge = false;
                            for (const candidat of candidatsLibelle) {
                                const r = await chercherEtSelectionner(candidat);
                                tropLarge = tropLarge || r.tropLarge;
                                if (r.retenues > 0) { champChoisi = candidat; break; }
                                await rpc("ClearAll", { qLockedAlso: false }, doc);
                                await sleep(settleMs);
                            }
                            if (!champChoisi) {
                                // Repli code centrale (terme saisi = un code).
                                const r = await chercherEtSelectionner(champCode);
                                if (r.retenues > 0) champChoisi = champCode;
                                tropLarge = tropLarge || r.tropLarge;
                            }
                            if (!champChoisi) {
                                ws.close();
                                return resolve({ ok: true, rows: [], champUtilise: null, total: 0, lues: 0, rejetees: 0, tropLarge, trace });
                            }
                            trace.push("champ retenu = " + champChoisi);

                            // Trace des sélections réellement actives : si elle est vide,
                            // la sélection n'a pas pris côté Engine.
                            try {
                                const cs = await rpc("CreateSessionObject", {
                                    qProp: { qInfo: { qType: "cf-search-sel" }, qSelectionObjectDef: {} },
                                }, doc);
                                const csl = await rpc("GetLayout", {}, (cs.qReturn as { qHandle: number }).qHandle);
                                const sel = (((csl.qLayout as { qSelectionObject?: { qSelections?: Array<{ qField?: string; qSelectedCount?: number; qTotal?: number }> } })
                                    .qSelectionObject?.qSelections) ?? [])
                                    .map((s) => `${s.qField}:${s.qSelectedCount}/${s.qTotal}`);
                                trace.push("sélections actives=" + JSON.stringify(sel));
                            } catch (e) {
                                trace.push("sélections actives: lecture impossible (" + String((e as Error)?.message || e) + ")");
                            }

                            // ─── 3. Fenêtre 12 mois glissants ────────────────────────
                            // Sélectionnée APRÈS les libellés : restreindre les dates avant
                            // la recherche masquerait les articles non vendus sur la période.
                            if (serialsDate.length > 0) {
                                try {
                                    const gd = await rpc("GetField", { qFieldName: "Date" }, doc);
                                    const dh = (gd.qReturn as { qHandle: number }).qHandle;
                                    for (let i = 0; i < serialsDate.length; i += 500) {
                                        const lot = serialsDate.slice(i, i + 500);
                                        await rpcRetry("SelectValues", {
                                            qFieldValues: lot.map((v) => ({ qNum: v, qText: String(v) })),
                                            qToggleMode: i > 0,
                                            qSoftLock: true,
                                        }, dh);
                                    }
                                    await sleep(settleMs);
                                    trace.push("fenêtre Date sélectionnée (" + serialsDate.length + " jours)");
                                } catch (e) {
                                    trace.push("sélection Date impossible, mesures sur toute la période : " + String((e as Error)?.message || e));
                                }
                            }

                            // ─── 4. Identité + mesures réseau, dans UN SEUL cube ─────
                            //
                            // Les mesures sont dans le même cube que l'identité, et donc
                            // dans la même session Qlik : une seconde session concurrente
                            // pour les extraire faisait abandonner le moteur (code 15).
                            //
                            // Les master measures sont résolues par TITRE : le qLibraryId
                            // fiable est `qInfo.qId`, qui n'est pas le GUID du QRS — même
                            // approche que l'extraction de la Grille.
                            const norm = (x: string) => x.replace(/\s+/g, " ").trim().toLowerCase();
                            const ml = await rpcRetry("CreateSessionObject", {
                                qProp: { qInfo: { qType: "MeasureList" }, qMeasureListDef: { qType: "measure", qData: { title: "/qMetaDef/title" } } },
                            }, doc);
                            const mll = await rpcRetry("GetLayout", {}, (ml.qReturn as { qHandle: number }).qHandle);
                            const items = (((mll.qLayout as { qMeasureList?: { qItems?: Array<{ qInfo: { qId: string }; qMeta?: { title?: string }; qData?: { title?: string } }> } }).qMeasureList?.qItems) ?? []);
                            const parTitre = new Map<string, string>();
                            for (const it of items) {
                                const t = it.qMeta?.title ?? it.qData?.title ?? "";
                                if (t) parTitre.set(norm(t), it.qInfo.qId);
                            }
                            const mesure = (titre: string, repli: string) => parTitre.get(norm(titre)) ?? repli;
                            const idCa = mesure("CA N", mCa);
                            const idQte = mesure("Quantité N", mQte);
                            const idNbMag = mesure("Magasin Ventes Nb N", mNbMag);
                            const idCaMag = mesure("CA par Magasin N", mCaMag);
                            const idMarge = mesure("Marge % N", mMarge);

                            const champLibelleAffiche = champChoisi === champCode ? candidatsLibelle[0] ?? null : champChoisi;
                            const champAlt = champs.includes(champCodeAlt) ? champCodeAlt : null;
                            const dims: Array<{ qLibraryId?: string; qDef?: { qFieldDefs: string[] } }> = [{ qLibraryId: dim }];
                            const idxAlt = champAlt ? dims.push({ qDef: { qFieldDefs: [champAlt] } }) - 1 : -1;
                            const idxLibelle = champLibelleAffiche ? dims.push({ qDef: { qFieldDefs: [champLibelleAffiche] } }) - 1 : -1;
                            const idxFournisseur = champFournisseur ? dims.push({ qDef: { qFieldDefs: [champFournisseur] } }) - 1 : -1;

                            const nbDims = dims.length;
                            // Colonnes mesures, dans l'ordre : CA, Qté, NbMag, CA/mag, Marge %.
                            const idxQteCol = nbDims + 1;
                            const largeur = nbDims + 5;
                            // Cube trié par quantité réseau décroissante : la première page
                            // contient donc directement les meilleures ventes du réseau, et
                            // on n'a pas besoin de lire tout l'ensemble sélectionné.
                            const hauteur = Math.max(50, Math.min(400, Math.floor(9000 / largeur)));

                            const defCube = (trie: boolean) => ({
                                qProp: {
                                    qInfo: { qType: "cf-search" },
                                    qHyperCubeDef: {
                                        qDimensions: dims.map((d) => ({ ...d, qNullSuppression: true })),
                                        qMeasures: [
                                            { qLibraryId: idCa },
                                            trie ? { qLibraryId: idQte, qSortBy: { qSortByNumeric: -1 } } : { qLibraryId: idQte },
                                            { qLibraryId: idNbMag },
                                            { qLibraryId: idCaMag },
                                            { qLibraryId: idMarge },
                                        ],
                                        ...(trie ? { qInterColumnSortOrder: [idxQteCol, 0] } : {}),
                                        qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: largeur, qHeight: hauteur }],
                                        qSuppressZero: false,
                                        qSuppressMissing: true,
                                    },
                                },
                            });
                            let cube: { [k: string]: unknown };
                            try {
                                cube = await rpcRetry("CreateSessionObject", defCube(true), doc);
                            } catch (e) {
                                // Le tri par mesure est un confort (meilleures ventes en
                                // tête) : si l'Engine refuse cette forme, on repart sans.
                                if (estCode15(e)) throw e;
                                trace.push("tri par quantité refusé, cube non trié : " + String((e as Error)?.message || e));
                                cube = await rpcRetry("CreateSessionObject", defCube(false), doc);
                            }
                            const ch = (cube.qReturn as { qHandle: number }).qHandle;
                            const layout = await rpcRetry("GetLayout", {}, ch);
                            const hc = (layout.qLayout as {
                                qHyperCube: {
                                    qSize: { qcy: number };
                                    qDataPages?: Array<{ qMatrix?: Array<Array<{ qText?: string; qNum?: number }>> }>;
                                };
                            }).qHyperCube;
                            const matrix = hc.qDataPages?.[0]?.qMatrix ?? [];

                            // ─── 4. Garde-fou : le résultat DOIT correspondre au terme ──
                            const termeCode = terme.trim().toLowerCase();
                            const correspond = (code: string, libelle: string): boolean => {
                                if (mots.length === 0) return true;
                                const c = code.toLowerCase();
                                if (c === termeCode || c.startsWith(termeCode)) return true;
                                if (!libelle) return champChoisi === champCode;
                                const l = normaliser(libelle);
                                return mots.every((m) => l.includes(m));
                            };

                            type Ligne = [string, string, string, string, number, number, number, number, number];
                            const texte = (r: Array<{ qText?: string }>, i: number) => {
                                if (i < 0) return "";
                                const v = String(r[i]?.qText ?? "").trim();
                                return v === "-" ? "" : v;
                            };
                            const parCode = new Map<string, Ligne>();
                            let rejetees = 0;
                            for (const r of matrix) {
                                const code = String(r[0]?.qText ?? "").trim();
                                if (!code || code === "-") continue;
                                const codeAlt = texte(r, idxAlt);
                                const libelle = texte(r, idxLibelle);
                                const fournisseur = texte(r, idxFournisseur);
                                if (!correspond(code, libelle)) { rejetees++; continue; }
                                const nombre = (i: number) => Number(r[nbDims + i]?.qNum) || 0;
                                const ligne: Ligne = [
                                    code, codeAlt, libelle, fournisseur,
                                    nombre(0), nombre(1), nombre(2), nombre(3), nombre(4),
                                ];
                                const existant = parCode.get(code);
                                if (!existant) { parCode.set(code, ligne); continue; }
                                // Même article chez plusieurs fournisseurs : une seule ligne.
                                // Les mesures sont identiques (elles ne dépendent pas de la
                                // dimension fournisseur), on complète juste les libellés.
                                if (!existant[1] && codeAlt) existant[1] = codeAlt;
                                if (!existant[2] && libelle) existant[2] = libelle;
                                if (!existant[3] && fournisseur) existant[3] = fournisseur;
                            }
                            const uniques = [...parCode.values()];
                            const rows = uniques.slice(0, limite);
                            trace.push(
                                "cube=" + hc.qSize.qcy + " lignes lues=" + matrix.length +
                                " rejetées(hors terme)=" + rejetees +
                                " articles uniques=" + uniques.length + " retenus=" + rows.length,
                            );
                            if (rows.length > 0) {
                                trace.push("échantillon=" + JSON.stringify(rows.slice(0, 3)));
                            }

                            ws.close();
                            resolve({
                                ok: true, rows, champUtilise: champChoisi, total: uniques.length,
                                lues: matrix.length, rejetees, tropLarge, trace,
                            });
                        } catch (e) {
                            try { ws.close(); } catch { /* noop */ }
                            resolve({ ok: false, error: String((e as Error)?.message || e), trace });
                        }
                    })();
                }),
            {
                app: cfg.appNetwork,
                dim: cfg.dimCodeArticleId,
                token: csrfToken,
                terme: cleaned,
                limite: limit,
                settleMs,
                serialsDate: dateFilter.dailySerials,
                mCa: cfg.measCaId,
                mQte: cfg.measQteId,
                mNbMag: cfg.measNbMagId,
                mCaMag: cfg.measCaMagId,
                mMarge: cfg.measMargePctId,
                champCodeAlt: CHAMP_CODE_CENTRALE_ALT,
                champsLibellePreferes: CHAMPS_LIBELLE_PREFERES,
                champsFournisseurPreferes: CHAMPS_FOURNISSEUR_PREFERES,
                champLibelleForce: (process.env.QLIK_FIELD_ARTICLE_LIBELLE ?? "").trim(),
                champFournisseurForce: (process.env.QLIK_FIELD_FOURNISSEUR ?? "").trim(),
            },
        )) as InPageSearchResult;

        for (const t of result.trace ?? []) console.log(`[qlik-search] ${t}`);
        if (!result.ok) throw new Error(`[qlik-search] ${result.error}`);

        const matches: QlikArticleMatch[] = (result.rows ?? []).map(
            ([codeCentrale, codeCentraleAlt, libelle, fournisseur, caReseau, qteReseau, nbMagasinsReseau, caParMagasinReseau, margePctReseau]) => ({
                codeCentrale, codeCentraleAlt, libelle, fournisseur,
                caReseau, qteReseau, nbMagasinsReseau, caParMagasinReseau, margePctReseau,
            }),
        );
        console.log(
            `[qlik-search] "${cleaned}" → ${matches.length} article(s) (total ${result.total ?? 0}, champ=${result.champUtilise}) en ${Date.now() - started} ms`,
        );

        // Zéro article alors que Qlik a répondu : on explique pourquoi plutôt que
        // d'afficher un « aucun résultat » qui laisserait croire à une absence
        // réelle dans le réseau.
        let avertissement: string | null = null;
        if (matches.length === 0 && (result.rejetees ?? 0) > 0) {
            avertissement = "Qlik a répondu sans appliquer le filtre de recherche : les articles renvoyés ne correspondaient pas au terme et ont été écartés. Voir les logs [qlik-search].";
        } else if (matches.length === 0 && result.tropLarge) {
            avertissement = "Le terme est trop large pour Qlik (plus de 10 000 libellés correspondants). Ajoutez un mot plus précis.";
        }
        if (avertissement) console.warn(`[qlik-search] ${avertissement}`);

        return {
            matches,
            champUtilise: result.champUtilise ?? null,
            tronque: (result.total ?? 0) > matches.length,
            avertissement,
            periode: dateFilter.label,
        };
    } finally {
        await ctx.close();
    }
}
