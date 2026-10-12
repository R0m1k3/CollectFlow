// Script exécuté DANS la page Qlik (Chromium) par `search.rs`.
// Copie conforme de la fonction passée à `page.evaluate` dans
// `src/lib/qlik-search.ts` (types TypeScript retirés, code inchangé).
// Appelée avec un unique objet d'arguments ; résout un `InPageSearchResult`.
({ app, dim, token, terme, limite, settleMs, serialsDate, mCa, mQte, mNbMag, mCaMag, mMarge, champCodeAlt, champsLibellePreferes, champsFournisseurPreferes, champLibelleForce, champFournisseurForce }) => new Promise((resolve) => {
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
    const loc = window.location;
    const url = `wss://${loc.host}/app/${app}?reloadUri=${encodeURIComponent(loc.href)}&qlik-csrf-token=${token}`;
    const ws = new WebSocket(url);
    const trace = [];
    let id = 0;
    const pend = new Map();
    const rpc = (method, params, handle = -1) => new Promise((res, rej) => {
        const i = ++id;
        pend.set(i, { res, rej });
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: i, handle, method, params }));
    });
    const ready = new Promise((res, rej) => {
        ws.onmessage = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.method === "OnConnected")
                return res();
            if (m.id && pend.has(m.id)) {
                const x = pend.get(m.id);
                pend.delete(m.id);
                if (m.error)
                    x.rej(new Error(JSON.stringify(m.error)));
                else
                    x.res(m.result);
            }
        };
        ws.onerror = () => rej(new Error("ws error (403 ?)"));
        setTimeout(() => rej(new Error("ws timeout")), 30000);
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    /** Qlik Engine code 15 = « Request aborted » : requête entrée en collision avec une évaluation. */
    const estCode15 = (e) => /"code"\s*:\s*15\b/.test(String(e?.message ?? e));
    const rpcRetry = async (method, params, handle, tentatives = 3) => {
        let derniere;
        for (let i = 1; i <= tentatives; i++) {
            try {
                return await rpc(method, params, handle);
            }
            catch (e) {
                derniere = e;
                if (!estCode15(e) || i === tentatives)
                    throw e;
                trace.push("code15 sur " + method + ", tentative " + i + "/" + tentatives);
                await sleep(settleMs * (i + 1));
            }
        }
        throw derniere;
    };
    const normaliser = (s) => s
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
            const doc = open.qReturn.qHandle;
            // ─── 1. Inventaire des champs ────────────────────────────
            const fl = await rpc("CreateSessionObject", {
                qProp: {
                    qInfo: { qType: "FieldList" },
                    qFieldListDef: { qShowSystem: false, qShowHidden: false, qShowSemantic: true, qShowSrcTables: true },
                },
            }, doc);
            const fll = await rpc("GetLayout", {}, fl.qReturn.qHandle);
            const champs = (((fll.qLayout.qFieldList?.qItems) ?? [])
                .map((f) => f.qName));
            const has = (nom, re) => re.test(nom);
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
            const chercherEtSelectionner = async (champ) => {
                const lo = await rpcRetry("CreateSessionObject", {
                    qProp: {
                        qInfo: { qType: "cf-search-lb" },
                        qListObjectDef: {
                            qDef: { qFieldDefs: [champ] },
                            qInitialDataFetch: [],
                        },
                    },
                }, doc);
                const ret = lo.qReturn;
                const loId = String(ret.qGenericId ?? ret.qId ?? "");
                const lh = ret.qHandle;
                try {
                    // 2a. Mot le plus sélectif (une recherche par mot, on ne lit que le compteur).
                    let meilleurMot = terme;
                    let meilleurNb = Number.POSITIVE_INFINITY;
                    for (const mot of (mots.length > 1 ? mots : [terme])) {
                        await rpcRetry("SearchListObjectFor", { qPath: "/qListObjectDef", qMatch: mot }, lh);
                        const lay = await rpcRetry("GetLayout", {}, lh);
                        const nb = (lay.qLayout.qListObject?.qSize?.qcy) ?? 0;
                        trace.push("  « " + mot + " » dans " + champ + " → " + nb + " valeur(s)");
                        if (nb > 0 && nb < meilleurNb) {
                            meilleurNb = nb;
                            meilleurMot = mot;
                        }
                    }
                    if (!Number.isFinite(meilleurNb) || meilleurNb === 0)
                        return { retenues: 0, brut: 0, tropLarge: false };
                    // 2b. Relecture des valeurs du mot retenu. On relance la
                    // recherche systématiquement : la boucle ci-dessus a pu
                    // laisser le list object sur un autre mot.
                    await rpcRetry("SearchListObjectFor", { qPath: "/qListObjectDef", qMatch: meilleurMot }, lh);
                    const aLire = Math.min(meilleurNb, MAX_VALEURS_LUES);
                    const elems = [];
                    let lues = 0;
                    for (let top = 0; top < aLire; top += PAGE_VALEURS) {
                        const d = await rpcRetry("GetListObjectData", {
                            qPath: "/qListObjectDef",
                            qPages: [{ qTop: top, qLeft: 0, qWidth: 1, qHeight: Math.min(PAGE_VALEURS, aLire - top) }],
                        }, lh);
                        const matrix = (d.qDataPages?.[0]?.qMatrix) ?? [];
                        if (matrix.length === 0)
                            break;
                        lues += matrix.length;
                        for (const ligne of matrix) {
                            const cell = ligne[0];
                            const texte = String(cell?.qText ?? "");
                            const elem = cell?.qElemNumber;
                            if (elem == null || elem < 0)
                                continue;
                            // Filtre ET : tous les mots du terme présents.
                            const n = normaliser(texte);
                            if (!mots.every((m) => n.includes(m)))
                                continue;
                            elems.push(elem);
                            if (elems.length >= MAX_VALEURS_SELECTION)
                                break;
                        }
                        if (elems.length >= MAX_VALEURS_SELECTION)
                            break;
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
                }
                finally {
                    if (loId) {
                        try {
                            await rpc("DestroySessionObject", { qId: loId }, doc);
                        }
                        catch { /* noop */ }
                    }
                }
            };
            await rpc("ClearAll", { qLockedAlso: false }, doc);
            await sleep(settleMs);
            let champChoisi = null;
            let tropLarge = false;
            for (const candidat of candidatsLibelle) {
                const r = await chercherEtSelectionner(candidat);
                tropLarge = tropLarge || r.tropLarge;
                if (r.retenues > 0) {
                    champChoisi = candidat;
                    break;
                }
                await rpc("ClearAll", { qLockedAlso: false }, doc);
                await sleep(settleMs);
            }
            if (!champChoisi) {
                // Repli code centrale (terme saisi = un code).
                const r = await chercherEtSelectionner(champCode);
                if (r.retenues > 0)
                    champChoisi = champCode;
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
                const csl = await rpc("GetLayout", {}, cs.qReturn.qHandle);
                const sel = ((csl.qLayout
                    .qSelectionObject?.qSelections) ?? [])
                    .map((s) => `${s.qField}:${s.qSelectedCount}/${s.qTotal}`);
                trace.push("sélections actives=" + JSON.stringify(sel));
            }
            catch (e) {
                trace.push("sélections actives: lecture impossible (" + String(e?.message || e) + ")");
            }
            // ─── 3. Fenêtre 12 mois glissants ────────────────────────
            // Sélectionnée APRÈS les libellés : restreindre les dates avant
            // la recherche masquerait les articles non vendus sur la période.
            if (serialsDate.length > 0) {
                try {
                    const gd = await rpc("GetField", { qFieldName: "Date" }, doc);
                    const dh = gd.qReturn.qHandle;
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
                }
                catch (e) {
                    trace.push("sélection Date impossible, mesures sur toute la période : " + String(e?.message || e));
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
            const norm = (x) => x.replace(/\s+/g, " ").trim().toLowerCase();
            const ml = await rpcRetry("CreateSessionObject", {
                qProp: { qInfo: { qType: "MeasureList" }, qMeasureListDef: { qType: "measure", qData: { title: "/qMetaDef/title" } } },
            }, doc);
            const mll = await rpcRetry("GetLayout", {}, ml.qReturn.qHandle);
            const items = ((mll.qLayout.qMeasureList?.qItems) ?? []);
            const parTitre = new Map();
            for (const it of items) {
                const t = it.qMeta?.title ?? it.qData?.title ?? "";
                if (t)
                    parTitre.set(norm(t), it.qInfo.qId);
            }
            const mesure = (titre, repli) => parTitre.get(norm(titre)) ?? repli;
            const idCa = mesure("CA N", mCa);
            const idQte = mesure("Quantité N", mQte);
            const idNbMag = mesure("Magasin Ventes Nb N", mNbMag);
            const idCaMag = mesure("CA par Magasin N", mCaMag);
            const idMarge = mesure("Marge % N", mMarge);
            const champLibelleAffiche = champChoisi === champCode ? candidatsLibelle[0] ?? null : champChoisi;
            const champAlt = champs.includes(champCodeAlt) ? champCodeAlt : null;
            const dims = [{ qLibraryId: dim }];
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
            const defCube = (trie) => ({
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
            let cube;
            try {
                cube = await rpcRetry("CreateSessionObject", defCube(true), doc);
            }
            catch (e) {
                // Le tri par mesure est un confort (meilleures ventes en
                // tête) : si l'Engine refuse cette forme, on repart sans.
                if (estCode15(e))
                    throw e;
                trace.push("tri par quantité refusé, cube non trié : " + String(e?.message || e));
                cube = await rpcRetry("CreateSessionObject", defCube(false), doc);
            }
            const ch = cube.qReturn.qHandle;
            const layout = await rpcRetry("GetLayout", {}, ch);
            const hc = layout.qLayout.qHyperCube;
            const matrix = hc.qDataPages?.[0]?.qMatrix ?? [];
            // ─── 4. Garde-fou : le résultat DOIT correspondre au terme ──
            const termeCode = terme.trim().toLowerCase();
            const correspond = (code, libelle) => {
                if (mots.length === 0)
                    return true;
                const c = code.toLowerCase();
                if (c === termeCode || c.startsWith(termeCode))
                    return true;
                if (!libelle)
                    return champChoisi === champCode;
                const l = normaliser(libelle);
                return mots.every((m) => l.includes(m));
            };
            const texte = (r, i) => {
                if (i < 0)
                    return "";
                const v = String(r[i]?.qText ?? "").trim();
                return v === "-" ? "" : v;
            };
            const parCode = new Map();
            let rejetees = 0;
            for (const r of matrix) {
                const code = String(r[0]?.qText ?? "").trim();
                if (!code || code === "-")
                    continue;
                const codeAlt = texte(r, idxAlt);
                const libelle = texte(r, idxLibelle);
                const fournisseur = texte(r, idxFournisseur);
                if (!correspond(code, libelle)) {
                    rejetees++;
                    continue;
                }
                const nombre = (i) => Number(r[nbDims + i]?.qNum) || 0;
                const ligne = [
                    code, codeAlt, libelle, fournisseur,
                    nombre(0), nombre(1), nombre(2), nombre(3), nombre(4),
                ];
                const existant = parCode.get(code);
                if (!existant) {
                    parCode.set(code, ligne);
                    continue;
                }
                // Même article chez plusieurs fournisseurs : une seule ligne.
                // Les mesures sont identiques (elles ne dépendent pas de la
                // dimension fournisseur), on complète juste les libellés.
                if (!existant[1] && codeAlt)
                    existant[1] = codeAlt;
                if (!existant[2] && libelle)
                    existant[2] = libelle;
                if (!existant[3] && fournisseur)
                    existant[3] = fournisseur;
            }
            const uniques = [...parCode.values()];
            const rows = uniques.slice(0, limite);
            trace.push("cube=" + hc.qSize.qcy + " lignes lues=" + matrix.length +
                " rejetées(hors terme)=" + rejetees +
                " articles uniques=" + uniques.length + " retenus=" + rows.length);
            if (rows.length > 0) {
                trace.push("échantillon=" + JSON.stringify(rows.slice(0, 3)));
            }
            ws.close();
            resolve({
                ok: true, rows, champUtilise: champChoisi, total: uniques.length,
                lues: matrix.length, rejetees, tropLarge, trace,
            });
        }
        catch (e) {
            try {
                ws.close();
            }
            catch { /* noop */ }
            resolve({ ok: false, error: String(e?.message || e), trace });
        }
    })();
})
