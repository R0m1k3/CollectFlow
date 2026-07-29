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
 * L'API Engine utilisée est la recherche de **list object**
 * (`SearchListObjectFor` + `AcceptListObjectSearch`), c'est-à-dire exactement ce
 * que fait un volet de filtre Qlik quand on tape dans sa zone de recherche :
 * Qlik applique sa propre sémantique (tous les mots présents, insensible à la
 * casse et aux accents) puis sélectionne les valeurs trouvées. La sélection
 * restreint alors la dimension « Article Code » aux articles correspondants.
 *
 * Le résultat est **revérifié côté client** avant d'être renvoyé : si la
 * sélection ne prend pas, le cube renvoie le début du catalogue, et une liste
 * sans rapport avec la recherche est pire que pas de résultat du tout.
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
    /**
     * Message de diagnostic quand la recherche aboutit à zéro article alors que
     * Qlik a bien renvoyé des lignes : le filtre n'a pas été appliqué côté
     * Engine et le garde-fou a tout écarté. `null` en fonctionnement nominal.
     */
    avertissement: string | null;
}

/**
 * Nombre maximum d'articles renvoyés par une recherche.
 *
 * Chaque code trouvé est ensuite ré-extrait avec son détail mensuel : au-delà
 * de quelques dizaines, la seconde passe devient longue et le résultat
 * illisible. L'utilisateur affine son terme.
 */
export const QLIK_SEARCH_MAX_RESULTS = 40;

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
    /** Lignes brutes lues dans le cube (avant garde-fou). */
    lues?: number;
    /** Lignes écartées parce qu'elles ne correspondaient pas au terme. */
    rejetees?: number;
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
    if (cleaned.length < 3) return { matches: [], champUtilise: null, tronque: false, avertissement: null };
    if (!cfg.appNetwork) throw new Error("[qlik-search] QLIK_APP_NETWORK manquant");
    if (!cfg.user || !cfg.password) throw new Error("[qlik-search] identifiants Qlik manquants");

    const started = Date.now();
    // Latence laissée à l'Engine après chaque mutation de sélection. Même réglage
    // que l'extraction (`QLIK_SETTLE_MS`) : sans elle, l'objet créé juste après
    // est calculé sur l'état de sélection précédent.
    const settleMs = Math.min(2000, Math.max(0, Number(process.env.QLIK_SETTLE_MS ?? "250") || 250));
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
            ({ app, dim, token, terme, limite, settleMs, champLibelleForce, champFournisseurForce }: {
                app: string; dim: string; token: string; terme: string; limite: number; settleMs: number;
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

                            // ─── 2. Sélection par recherche de champ ─────────────────
                            //
                            // On passe par un **list object** + `SearchListObjectFor` /
                            // `AcceptListObjectSearch` : c'est exactement ce que fait un
                            // volet de filtre Qlik quand on tape dans sa zone de recherche.
                            // Qlik applique lui-même sa sémantique (mots multiples = tous
                            // présents, insensible casse/accents) et sélectionne les valeurs
                            // trouvées — sans qu'on ait à ré-injecter des `qText` à
                            // l'identique, ce qui échouait silencieusement et laissait le
                            // cube renvoyer le début du catalogue.
                            const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

                            const chercherEtSelectionner = async (champ: string): Promise<number> => {
                                const lo = await rpc("CreateSessionObject", {
                                    qProp: {
                                        qInfo: { qType: "cf-search-lb" },
                                        qListObjectDef: {
                                            qDef: { qFieldDefs: [champ] },
                                            qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 1, qHeight: 1 }],
                                        },
                                    },
                                }, doc);
                                const ret = lo.qReturn as { qHandle: number; qGenericId?: string; qId?: string };
                                const loId = String(ret.qGenericId ?? ret.qId ?? "");
                                try {
                                    await rpc("SearchListObjectFor", { qPath: "/qListObjectDef", qMatch: terme }, ret.qHandle);
                                    await sleep(settleMs);
                                    const lay = await rpc("GetLayout", {}, ret.qHandle);
                                    const nb = ((lay.qLayout as { qListObject?: { qSize?: { qcy?: number } } }).qListObject?.qSize?.qcy) ?? 0;
                                    trace.push("recherche " + champ + " → " + nb + " valeur(s)");
                                    if (nb > 0) {
                                        await rpc("AcceptListObjectSearch", {
                                            qPath: "/qListObjectDef",
                                            qToggleMode: false,
                                            qSoftLock: true,
                                        }, ret.qHandle);
                                        // L'Engine doit finir d'évaluer la sélection avant que
                                        // le cube suivant soit calculé, sinon il est construit
                                        // sur l'état précédent (= catalogue entier).
                                        await sleep(settleMs);
                                    }
                                    return nb;
                                } finally {
                                    if (loId) { try { await rpc("DestroySessionObject", { qId: loId }, doc); } catch { /* noop */ } }
                                }
                            };

                            await rpc("ClearAll", { qLockedAlso: false }, doc);
                            await sleep(settleMs);

                            // Le libellé d'abord (cas courant), le code centrale ensuite.
                            let champChoisi: string | null = null;
                            if (champLibelle && (await chercherEtSelectionner(champLibelle)) > 0) {
                                champChoisi = champLibelle;
                            } else if ((await chercherEtSelectionner(champCode)) > 0) {
                                champChoisi = champCode;
                            }
                            if (!champChoisi) {
                                ws.close();
                                return resolve({ ok: true, rows: [], champUtilise: null, total: 0, lues: 0, rejetees: 0, trace });
                            }

                            // Trace des sélections réellement actives : si elle est vide, la
                            // sélection n'a pas pris côté Engine et le cube ci-dessous
                            // renverra tout le catalogue (le garde-fou de l'étape 4 le
                            // rattrape, mais c'est ici qu'on voit pourquoi).
                            try {
                                const cs = await rpc("CreateSessionObject", {
                                    qProp: {
                                        qInfo: { qType: "cf-search-sel" },
                                        qSelectionObjectDef: {},
                                    },
                                }, doc);
                                const csl = await rpc("GetLayout", {}, (cs.qReturn as { qHandle: number }).qHandle);
                                const sel = (((csl.qLayout as { qSelectionObject?: { qSelections?: Array<{ qField?: string; qSelectedCount?: number; qTotal?: number }> } })
                                    .qSelectionObject?.qSelections) ?? [])
                                    .map((s) => `${s.qField}:${s.qSelectedCount}/${s.qTotal}`);
                                trace.push("sélections actives=" + JSON.stringify(sel));
                            } catch (e) {
                                trace.push("sélections actives: lecture impossible (" + String((e as Error)?.message || e) + ")");
                            }

                            // ─── 3. Liste des articles correspondants ────────────────
                            // Cube sans mesure : uniquement l'identité de l'article. Les
                            // métriques réseau sont extraites juste après par
                            // fetchNetworkMetricsPlaywright (qui produit aussi le mensuel).
                            const dims: Array<{ qLibraryId?: string; qDef?: { qFieldDefs: string[] } }> = [{ qLibraryId: dim }];
                            if (champLibelle) dims.push({ qDef: { qFieldDefs: [champLibelle] } });
                            if (champFournisseur) dims.push({ qDef: { qFieldDefs: [champFournisseur] } });
                            const largeur = dims.length;
                            // On lit large puis on dédoublonne : un article référencé chez
                            // plusieurs fournisseurs produit autant de lignes que de
                            // fournisseurs, il ne doit pas consommer plusieurs places.
                            const hauteur = Math.min(1000, Math.floor(9000 / Math.max(largeur, 1)));

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

                            // ─── 4. Garde-fou : le résultat DOIT correspondre au terme ──
                            // Si la sélection Qlik n'a pas pris (droits, modèle de données,
                            // évaluation en retard), le cube renvoie le début du catalogue.
                            // On revérifie donc chaque ligne côté client : mots tous présents
                            // dans le libellé, ou code correspondant au terme. Mieux vaut
                            // zéro résultat qu'une liste sans rapport avec la recherche.
                            const normaliser = (s: string) => s
                                .toLowerCase()
                                .normalize("NFD")
                                .replace(/[\u0300-\u036f]/g, "")
                                .replace(/[^a-z0-9]+/g, " ")
                                .trim();
                            const mots = normaliser(terme).split(" ").filter(Boolean);
                            const termeCode = terme.trim().toLowerCase();
                            const correspond = (code: string, libelle: string): boolean => {
                                if (mots.length === 0) return true;
                                const c = code.toLowerCase();
                                if (c === termeCode || c.startsWith(termeCode)) return true;
                                if (!libelle) return champChoisi === champCode;
                                const l = normaliser(libelle);
                                return mots.every((m) => l.includes(m));
                            };

                            const parCode = new Map<string, [string, string, string]>();
                            let rejetees = 0;
                            for (const r of matrix) {
                                const code = String(r[0]?.qText ?? "").trim();
                                if (!code || code === "-") continue;
                                const libelleBrut = champLibelle ? String(r[1]?.qText ?? "").trim() : "";
                                const idxFou = champLibelle ? 2 : 1;
                                const fournisseurBrut = champFournisseur ? String(r[idxFou]?.qText ?? "").trim() : "";
                                const libelle = libelleBrut === "-" ? "" : libelleBrut;
                                const fournisseur = fournisseurBrut === "-" ? "" : fournisseurBrut;
                                if (!correspond(code, libelle)) { rejetees++; continue; }
                                const existant = parCode.get(code);
                                if (!existant) { parCode.set(code, [code, libelle, fournisseur]); continue; }
                                // Complète les champs manquants d'une ligne déjà vue.
                                if (!existant[1] && libelle) existant[1] = libelle;
                                if (!existant[2] && fournisseur) existant[2] = fournisseur;
                            }
                            const uniques = [...parCode.values()];
                            const rows = uniques.slice(0, limite);
                            trace.push(
                                "cube=" + hc.qSize.qcy + " lignes lues=" + matrix.length +
                                " rejetées(hors terme)=" + rejetees +
                                " articles uniques=" + uniques.length + " retenus=" + rows.length,
                            );

                            ws.close();
                            resolve({
                                ok: true, rows, champUtilise: champChoisi, total: uniques.length,
                                lues: matrix.length, rejetees, trace,
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
        // Toutes les lignes écartées = Qlik a bien répondu mais sans appliquer la
        // sélection. On le dit au lieu d'afficher un « aucun résultat » trompeur.
        const filtreNonApplique = matches.length === 0 && (result.rejetees ?? 0) > 0;
        if (filtreNonApplique) {
            console.warn(
                `[qlik-search] filtre non appliqué : ${result.rejetees} ligne(s) lues sans rapport avec "${cleaned}" — vérifier le champ ${result.champUtilise} et les traces ci-dessus`,
            );
        }

        return {
            matches,
            champUtilise: result.champUtilise ?? null,
            tronque: (result.total ?? 0) > matches.length,
            avertissement: filtreNonApplique
                ? "Qlik a répondu sans appliquer le filtre de recherche : les articles renvoyés ne correspondaient pas au terme et ont été écartés. Voir les logs [qlik-search]."
                : null,
        };
    } finally {
        await ctx.close();
    }
}
