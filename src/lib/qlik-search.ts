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
 * L'API Engine utilisée est la recherche globale (`SearchResults`) : elle
 * renvoie, pour chaque champ, les valeurs qui matchent le terme. On sélectionne
 * ensuite ces valeurs dans leur champ, ce qui restreint la dimension
 * « Article Code » aux articles correspondants — sans avoir à connaître à
 * l'avance le nom exact du champ libellé, qui varie selon les apps.
 */

import "server-only";
import { chromium, type Browser } from "playwright-core";
import { getQlikConfig, qlikNtlmSession, type QlikConfig } from "@/lib/qlik-client";

/** Un article trouvé côté Qlik. Seul `codeCentrale` est garanti. */
export interface QlikArticleMatch {
    /** Valeur de la dimension « Article Code » = code centrale FF (`articles.artcentrale`). */
    codeCentrale: string;
    /** Libellé réseau, si l'app expose un champ libellé article. */
    libelle: string;
    /** Fournisseur réseau, si l'app expose un champ fournisseur. */
    fournisseur: string;
}

export interface QlikSearchOutcome {
    matches: QlikArticleMatch[];
    /** Champ Qlik effectivement interrogé (diagnostic UI). */
    champUtilise: string | null;
    /** true si Qlik a renvoyé plus de résultats que la limite demandée. */
    tronque: boolean;
}

/**
 * Nombre maximum d'articles renvoyés par une recherche.
 *
 * Chaque code trouvé est ensuite ré-extrait avec son détail mensuel : au-delà
 * de quelques dizaines, la seconde passe devient longue et le résultat
 * illisible. L'utilisateur affine son terme.
 */
export const QLIK_SEARCH_MAX_RESULTS = 40;

/** Nombre maximum de valeurs de champ sélectionnées suite à la recherche. */
const MAX_FIELD_MATCHES = 400;

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
    rows?: Array<[string, string, string]>;
    champUtilise?: string | null;
    total?: number;
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
    if (cleaned.length < 3) return { matches: [], champUtilise: null, tronque: false };
    if (!cfg.appNetwork) throw new Error("[qlik-search] QLIK_APP_NETWORK manquant");
    if (!cfg.user || !cfg.password) throw new Error("[qlik-search] identifiants Qlik manquants");

    const started = Date.now();
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
        page.on("console", (msg) => console.log(`[qlik-search][page] ${msg.text()}`));

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
            ({ app, dim, token, terme, limite, maxFieldMatches, champLibelleForce, champFournisseurForce }: {
                app: string; dim: string; token: string; terme: string; limite: number; maxFieldMatches: number;
                champLibelleForce: string; champFournisseurForce: string;
            }) =>
                new Promise<InPageSearchResult>((resolve) => {
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

                    (async () => {
                        try {
                            await ready;
                            const open = await rpc("OpenDoc", { qDocName: app });
                            const doc = (open.qReturn as { qHandle: number }).qHandle;
                            trace.push("OpenDoc ok");

                            // ─── 1. Inventaire des champs ────────────────────────────
                            // Sert à repérer, sans connaître l'app par cœur, le champ
                            // libellé article et le champ fournisseur.
                            const fl = await rpc("CreateSessionObject", {
                                qProp: {
                                    qInfo: { qType: "FieldList" },
                                    qFieldListDef: { qShowSystem: false, qShowHidden: false, qShowSemantic: true, qShowSrcTables: true },
                                },
                            }, doc);
                            const fll = await rpc("GetLayout", {}, (fl.qReturn as { qHandle: number }).qHandle);
                            const champs = ((((fll.qLayout as { qFieldList?: { qItems?: Array<{ qName: string }> } }).qFieldList?.qItems) ?? [])
                                .map((f) => f.qName));
                            trace.push("champs=" + champs.length);

                            const has = (nom: string, re: RegExp) => re.test(nom);
                            const champCode = champs.find((c) => c === "Article Code")
                                ?? champs.find((c) => has(c, /article/i) && has(c, /code/i))
                                ?? "Article Code";
                            // Les noms exacts varient selon l'app Qlik : détection par
                            // heuristique, surchargeable par variable d'environnement si
                            // l'app expose un intitulé inattendu (cf. les logs [qlik-search]).
                            const champLibelle = (champLibelleForce && champs.includes(champLibelleForce) ? champLibelleForce : null)
                                ?? champs.find((c) => has(c, /article/i) && has(c, /(libell|designation|désignation|denomination|dénomination)/i))
                                ?? champs.find((c) => has(c, /(libell|designation|désignation)/i) && !has(c, /(magasin|region|région|famille|rayon|fournisseur)/i))
                                ?? null;
                            const champFournisseur = (champFournisseurForce && champs.includes(champFournisseurForce) ? champFournisseurForce : null)
                                ?? champs.find((c) => has(c, /fournisseur/i))
                                ?? champs.find((c) => has(c, /(fabricant|supplier)/i))
                                ?? null;
                            // Inventaire complet en trace : sans accès Qlik depuis le poste
                            // de dev, c'est le seul moyen de régler les surcharges ci-dessus.
                            trace.push("champs disponibles=" + JSON.stringify(champs));
                            trace.push("code=" + champCode + " libelle=" + champLibelle + " fournisseur=" + champFournisseur);

                            // ─── 2. Recherche globale Qlik ───────────────────────────
                            // On restreint aux champs article : sans restriction, un terme
                            // courant ("noir") matcherait des dizaines de champs sans
                            // rapport (couleur magasin, région…) et la sélection deviendrait
                            // absurde.
                            const champsRecherche = [champCode, ...(champLibelle ? [champLibelle] : [])];
                            const sr = await rpc("SearchResults", {
                                qOptions: { qSearchFields: champsRecherche, qContext: "Cleared" },
                                qTerms: [terme],
                                qPage: { qOffset: 0, qCount: champsRecherche.length, qMaxNbrFieldMatches: maxFieldMatches },
                            }, doc);

                            type Match = { qText?: string };
                            type Item = { qIdentifier?: string; qItemMatches?: Match[]; qTotalNumberOfMatches?: number };
                            type Group = { qItems?: Item[] };
                            const groupes = (((sr.qResult as { qSearchGroupArray?: Group[] })?.qSearchGroupArray) ?? []);
                            const parChamp = new Map<string, string[]>();
                            for (const g of groupes) {
                                for (const it of g.qItems ?? []) {
                                    const champ = it.qIdentifier ?? "";
                                    if (!champ) continue;
                                    const vals = (it.qItemMatches ?? []).map((m) => String(m.qText ?? "")).filter(Boolean);
                                    if (vals.length === 0) continue;
                                    parChamp.set(champ, [...(parChamp.get(champ) ?? []), ...vals]);
                                }
                            }
                            trace.push("groupes=" + JSON.stringify([...parChamp].map(([c, v]) => c + ":" + v.length)));

                            // Priorité au champ libellé (une recherche texte), sinon le code.
                            const champChoisi = (champLibelle && parChamp.has(champLibelle)) ? champLibelle
                                : parChamp.has(champCode) ? champCode
                                    : [...parChamp.keys()][0] ?? null;
                            if (!champChoisi) {
                                ws.close();
                                return resolve({ ok: true, rows: [], champUtilise: null, total: 0, trace });
                            }
                            const valeurs = [...new Set(parChamp.get(champChoisi) ?? [])].slice(0, maxFieldMatches);

                            // ─── 3. Sélection des valeurs trouvées ───────────────────
                            const gf = await rpc("GetField", { qFieldName: champChoisi }, doc);
                            const fh = (gf.qReturn as { qHandle: number }).qHandle;
                            await rpc("Clear", {}, fh);
                            await rpc("SelectValues", {
                                qFieldValues: valeurs.map((v) => ({ qText: v })),
                                qToggleMode: false,
                                qSoftLock: true,
                            }, fh);
                            trace.push("selection " + champChoisi + " = " + valeurs.length + " valeurs");

                            // ─── 4. Liste des articles correspondants ────────────────
                            // Cube sans mesure : uniquement l'identité de l'article. Les
                            // métriques réseau sont extraites juste après par
                            // fetchNetworkMetricsPlaywright (qui produit aussi le mensuel).
                            const dims: Array<{ qLibraryId?: string; qDef?: { qFieldDefs: string[] } }> = [{ qLibraryId: dim }];
                            if (champLibelle) dims.push({ qDef: { qFieldDefs: [champLibelle] } });
                            if (champFournisseur) dims.push({ qDef: { qFieldDefs: [champFournisseur] } });
                            const largeur = dims.length;
                            const hauteur = Math.min(limite, Math.floor(9000 / Math.max(largeur, 1)));

                            const cube = await rpc("CreateSessionObject", {
                                qProp: {
                                    qInfo: { qType: "cf-search" },
                                    qHyperCubeDef: {
                                        qDimensions: dims.map((d) => ({ ...d, qNullSuppression: true })),
                                        qMeasures: [],
                                        qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: largeur, qHeight: hauteur }],
                                        qSuppressMissing: true,
                                    },
                                },
                            }, doc);
                            const ch = (cube.qReturn as { qHandle: number }).qHandle;
                            const layout = await rpc("GetLayout", {}, ch);
                            const hc = (layout.qLayout as {
                                qHyperCube: {
                                    qSize: { qcy: number };
                                    qDataPages?: Array<{ qMatrix?: Array<Array<{ qText?: string }>> }>;
                                };
                            }).qHyperCube;
                            const matrix = hc.qDataPages?.[0]?.qMatrix ?? [];
                            const rows: Array<[string, string, string]> = [];
                            for (const r of matrix) {
                                const code = String(r[0]?.qText ?? "").trim();
                                if (!code || code === "-") continue;
                                const libelle = champLibelle ? String(r[1]?.qText ?? "").trim() : "";
                                const idxFou = champLibelle ? 2 : 1;
                                const fournisseur = champFournisseur ? String(r[idxFou]?.qText ?? "").trim() : "";
                                rows.push([code, libelle === "-" ? "" : libelle, fournisseur === "-" ? "" : fournisseur]);
                            }
                            trace.push("articles=" + rows.length + "/" + hc.qSize.qcy);

                            ws.close();
                            resolve({ ok: true, rows, champUtilise: champChoisi, total: hc.qSize.qcy, trace });
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
                maxFieldMatches: MAX_FIELD_MATCHES,
                champLibelleForce: (process.env.QLIK_FIELD_ARTICLE_LIBELLE ?? "").trim(),
                champFournisseurForce: (process.env.QLIK_FIELD_FOURNISSEUR ?? "").trim(),
            },
        )) as InPageSearchResult;

        for (const t of result.trace ?? []) console.log(`[qlik-search] ${t}`);
        if (!result.ok) throw new Error(`[qlik-search] ${result.error}`);

        const matches: QlikArticleMatch[] = (result.rows ?? []).map(([codeCentrale, libelle, fournisseur]) => ({
            codeCentrale, libelle, fournisseur,
        }));
        console.log(
            `[qlik-search] "${cleaned}" → ${matches.length} article(s) (total Qlik ${result.total ?? 0}, champ=${result.champUtilise}) en ${Date.now() - started} ms`,
        );
        return {
            matches,
            champUtilise: result.champUtilise ?? null,
            tronque: (result.total ?? 0) > matches.length,
        };
    } finally {
        await ctx.close();
    }
}
