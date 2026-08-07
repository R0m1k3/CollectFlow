/**
 * CollectFlow — Synchronisation nocturne des fournisseurs.
 *
 * Deux sources aux coûts très différents, donc deux files distinctes :
 *   • **SQL** — l'instantané de grille (`getProductRows`), ~43 s sur le plus gros
 *     fournisseur du catalogue. Alimente la Grille et `/api/v1`.
 *   • **Qlik** — les métriques réseau, jusqu'à 8 min par fournisseur, sur un
 *     serveur externe qui abandonne quand on le sollicite trop. Ce sont des
 *     agrégats mensuels : les rafraîchir chaque nuit n'apporterait rien.
 *
 * ORDRE DE PASSAGE — le point de conception central. La file est simplement
 * « le plus ancien d'abord », en ignorant ceux déjà traités depuis l'ouverture
 * de la fenêtre courante. Il en découle, sans curseur ni compteur de tour :
 *   • la nuit 2 reprend là où la nuit 1 s'est arrêtée (les non-traités sont les
 *     plus anciens) ;
 *   • quand plus personne n'est en attente, le tour est fini ; la nuit suivante
 *     tout le monde redevient éligible et le tour recommence ;
 *   • un fournisseur en échec garde une date ancienne, donc il repasse en tête —
 *     le rattrapage est automatique.
 *
 * La fenêtre ne peut pas interrompre un fournisseur en cours : elle signifie
 * « ne plus en **démarrer** après l'heure de fin ».
 */

import "server-only";

import { and, asc, eq, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { syncFournisseurs } from "@/db/schema";
import { getProductRows } from "@/features/grid/api/get-product-rows";
import { pgGetFournisseurs, pgGetArticlesByFournisseur } from "@/lib/pg-ff-client";
import { fetchNetworkMetricsPlaywright } from "@/lib/qlik-playwright";
import { upsertNetworkMetrics } from "@/lib/qlik-network-cache";
import { buildGridNetworkQlikDateFilter, envMonthsBack, QLIK_MONTHS_BACK_DEFAULT } from "@/lib/qlik-date-range";
import { readSyncSettings, type SyncSettings } from "@/features/admin/api/sync-settings";

export type { SyncSettings };

// ─── État courant, en mémoire ────────────────────────────────────────────────

export interface SyncSchedulerState {
    enCours: boolean;
    /** "auto" = déclenché par la fenêtre nocturne, "manuel" = lancé depuis l'admin. */
    origine: "auto" | "manuel" | null;
    debutAt: string | null;
    finAt: string | null;
    fournisseurCourant: string | null;
    etape: "sql" | "qlik" | null;
    sqlFaits: number;
    sqlEchecs: number;
    qlikFaits: number;
    qlikEchecs: number;
    /** Renseigné quand la file s'est vidée : le tour est bouclé. */
    tourTermine: boolean;
    arretDemande: boolean;
    derniereErreur: string | null;
}

const etat: SyncSchedulerState = {
    enCours: false, origine: null, debutAt: null, finAt: null,
    fournisseurCourant: null, etape: null,
    sqlFaits: 0, sqlEchecs: 0, qlikFaits: 0, qlikEchecs: 0,
    tourTermine: false, arretDemande: false, derniereErreur: null,
};

export function getSyncSchedulerState(): SyncSchedulerState {
    return { ...etat };
}

export function demanderArret(): void {
    if (etat.enCours) etat.arretDemande = true;
}

// ─── Fenêtre horaire ─────────────────────────────────────────────────────────

/**
 * Début de la fenêtre en cours, ou `null` si l'heure courante est en dehors.
 *
 * Gère le passage par minuit (ex. 22h → 5h) : dans ce cas, entre 0h et l'heure
 * de fin, la fenêtre a commencé **la veille**.
 */
export function debutFenetre(s: SyncSettings, maintenant = new Date()): Date | null {
    const h = maintenant.getHours();
    const debutDuJour = new Date(maintenant);
    debutDuJour.setHours(s.heureDebut, 0, 0, 0);

    if (s.heureDebut < s.heureFin) {
        return h >= s.heureDebut && h < s.heureFin ? debutDuJour : null;
    }
    // Fenêtre à cheval sur minuit.
    if (h >= s.heureDebut) return debutDuJour;
    if (h < s.heureFin) {
        const veille = new Date(debutDuJour);
        veille.setDate(veille.getDate() - 1);
        return veille;
    }
    return null;
}

// ─── Référentiel des fournisseurs ────────────────────────────────────────────

/**
 * Aligne la table de paramétrage sur le référentiel FF : ajoute les nouveaux
 * fournisseurs (actifs par défaut), rafraîchit les noms. Ne supprime rien —
 * l'historique de synchronisation d'un fournisseur disparu reste consultable.
 */
export async function seedSyncFournisseurs(): Promise<number> {
    const fournisseurs = await pgGetFournisseurs();
    if (fournisseurs.length === 0) return 0;

    const CHUNK = 500;
    for (let i = 0; i < fournisseurs.length; i += CHUNK) {
        const lot = fournisseurs.slice(i, i + CHUNK);
        await db
            .insert(syncFournisseurs)
            .values(lot.map((f) => ({ codeFournisseur: f.code, nomFournisseur: f.nom })))
            .onConflictDoUpdate({
                target: syncFournisseurs.codeFournisseur,
                // Seul le nom est réaligné : les choix d'activation appartiennent à l'admin.
                set: { nomFournisseur: sql`excluded.nom_fournisseur` },
            });
    }
    return fournisseurs.length;
}

// ─── Files d'attente ─────────────────────────────────────────────────────────

/** Le plus ancien fournisseur SQL pas encore traité depuis l'ouverture de la fenêtre. */
async function prochainSql(depuis: Date) {
    const [row] = await db
        .select()
        .from(syncFournisseurs)
        .where(and(
            eq(syncFournisseurs.actifSql, true),
            or(isNull(syncFournisseurs.dernierSqlAt), lt(syncFournisseurs.dernierSqlAt, depuis)) as SQL,
        ))
        .orderBy(asc(sql`${syncFournisseurs.dernierSqlAt} nulls first`))
        .limit(1);
    return row ?? null;
}

/**
 * Le plus ancien fournisseur Qlik dont les données dépassent `qlikMinJours`.
 * Le seuil en jours, plutôt que la fenêtre courante, évite de relancer chaque
 * nuit une extraction de plusieurs minutes pour des agrégats mensuels.
 */
async function prochainQlik(qlikMinJours: number, maintenant: Date) {
    const seuil = new Date(maintenant.getTime() - qlikMinJours * 24 * 3600 * 1000);
    const [row] = await db
        .select()
        .from(syncFournisseurs)
        .where(and(
            eq(syncFournisseurs.actifQlik, true),
            or(isNull(syncFournisseurs.dernierQlikAt), lt(syncFournisseurs.dernierQlikAt, seuil)) as SQL,
        ))
        .orderBy(asc(sql`${syncFournisseurs.dernierQlikAt} nulls first`))
        .limit(1);
    return row ?? null;
}

// ─── Traitement d'un fournisseur ─────────────────────────────────────────────

/**
 * Instantané SQL. `dernierSqlAt` est renseigné **même en cas d'échec** : sans
 * cela, un fournisseur qui échoue resterait éternellement le plus ancien et
 * bloquerait la file derrière lui.
 */
async function traiterSql(code: string, nom: string | null): Promise<void> {
    const t0 = Date.now();
    etat.fournisseurCourant = `${code}${nom ? ` — ${nom}` : ""}`;
    etat.etape = "sql";
    try {
        const rows = await getProductRows({ codeFournisseur: code, magasin: "TOTAL", forceRefresh: true });
        const vide = rows.length === 0;
        await db.update(syncFournisseurs).set({
            dernierSqlAt: new Date(),
            dernierSqlStatut: vide ? "vide" : "succes",
            dernierSqlLignes: rows.length,
            dernierSqlErreur: null,
            dernierSqlMs: Date.now() - t0,
            // Un fournisseur sans article n'a rien à donner : on le sort des deux
            // files plutôt que de le réessayer chaque nuit. L'admin voit le motif
            // et peut le réactiver.
            ...(vide ? { actifSql: false, actifQlik: false, desactiveMotif: "Aucun article — désactivé automatiquement" } : {}),
            updatedAt: new Date(),
        }).where(eq(syncFournisseurs.codeFournisseur, code));
        if (vide) console.log(`[sync-nuit] ${code} sans article — désactivé automatiquement`);
        else etat.sqlFaits++;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        etat.sqlEchecs++;
        etat.derniereErreur = `${code} (SQL) : ${msg}`;
        console.error(`[sync-nuit] SQL ${code} en échec :`, msg);
        await db.update(syncFournisseurs).set({
            dernierSqlAt: new Date(),
            dernierSqlStatut: "echec",
            dernierSqlErreur: msg.slice(0, 500),
            dernierSqlMs: Date.now() - t0,
            updatedAt: new Date(),
        }).where(eq(syncFournisseurs.codeFournisseur, code)).catch(() => { /* le suivi ne doit pas casser la boucle */ });
    }
}

/** Format d'un code centrale plausible — même filtre que la synchro manuelle. */
const CODE_CENTRALE = /^[A-Z0-9][A-Z0-9_-]{1,29}$/i;

/** Extraction Qlik. Même politique que le SQL sur l'horodatage en cas d'échec. */
async function traiterQlik(code: string, nom: string | null): Promise<void> {
    const t0 = Date.now();
    etat.fournisseurCourant = `${code}${nom ? ` — ${nom}` : ""}`;
    etat.etape = "qlik";
    try {
        const articles = await pgGetArticlesByFournisseur(code);
        const codes = [...new Set(
            articles
                .map((a) => String(a.codeCentrale ?? "").trim())
                .filter((c) => c && c !== "-" && CODE_CENTRALE.test(c)),
        )];

        if (codes.length === 0) {
            await db.update(syncFournisseurs).set({
                dernierQlikAt: new Date(), dernierQlikStatut: "vide", dernierQlikCodes: 0,
                dernierQlikErreur: null, dernierQlikMs: Date.now() - t0, updatedAt: new Date(),
            }).where(eq(syncFournisseurs.codeFournisseur, code));
            return;
        }

        const dateFilter = buildGridNetworkQlikDateFilter(new Date(), envMonthsBack("QLIK_SYNC_MONTHS_BACK", QLIK_MONTHS_BACK_DEFAULT));
        const metrics = await fetchNetworkMetricsPlaywright(codes, undefined, dateFilter, code);
        const n = await upsertNetworkMetrics([...metrics.values()]);

        await db.update(syncFournisseurs).set({
            dernierQlikAt: new Date(), dernierQlikStatut: "succes", dernierQlikCodes: n,
            dernierQlikErreur: null, dernierQlikMs: Date.now() - t0, updatedAt: new Date(),
        }).where(eq(syncFournisseurs.codeFournisseur, code));
        etat.qlikFaits++;
        console.log(`[sync-nuit] Qlik ${code} — ${n} codes en ${Math.round((Date.now() - t0) / 1000)} s`);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        etat.qlikEchecs++;
        etat.derniereErreur = `${code} (Qlik) : ${msg}`;
        console.error(`[sync-nuit] Qlik ${code} en échec :`, msg);
        await db.update(syncFournisseurs).set({
            dernierQlikAt: new Date(), dernierQlikStatut: "echec",
            dernierQlikErreur: msg.slice(0, 500), dernierQlikMs: Date.now() - t0, updatedAt: new Date(),
        }).where(eq(syncFournisseurs.codeFournisseur, code)).catch(() => { /* idem */ });
    }
}

// ─── Boucle de travail ───────────────────────────────────────────────────────

/**
 * Traite les files jusqu'à épuisement, sortie de fenêtre, ou demande d'arrêt.
 *
 * Les deux files avancent en parallèle : une extraction Qlik est intercalée
 * tous les `sqlParQlik` fournisseurs SQL. Sans cet entrelacement, Qlik ne
 * démarrerait jamais tant que la file SQL n'est pas vide.
 */
export async function lancerRound(origine: "auto" | "manuel", forcerHorsFenetre = false): Promise<void> {
    if (etat.enCours) return;

    const s = await readSyncSettings();
    const maintenant = new Date();
    const debut = debutFenetre(s, maintenant);
    if (!forcerHorsFenetre && !debut) return;
    // Un lancement manuel hors fenêtre borne la file sur « depuis ce matin ».
    const depuis = debut ?? new Date(new Date(maintenant).setHours(0, 0, 0, 0));

    Object.assign(etat, {
        enCours: true, origine, debutAt: maintenant.toISOString(), finAt: null,
        fournisseurCourant: null, etape: null,
        sqlFaits: 0, sqlEchecs: 0, qlikFaits: 0, qlikEchecs: 0,
        tourTermine: false, arretDemande: false, derniereErreur: null,
    });
    console.log(`[sync-nuit] round ${origine} démarré (fenêtre ${s.heureDebut}h-${s.heureFin}h, Qlik ≤ ${s.qlikParNuit})`);

    try {
        await seedSyncFournisseurs();

        let depuisDernierQlik = 0;
        for (;;) {
            if (etat.arretDemande) break;
            if (!forcerHorsFenetre && !debutFenetre(s, new Date())) {
                console.log("[sync-nuit] fin de fenêtre — arrêt après le fournisseur en cours");
                break;
            }

            const qlikPossible = etat.qlikFaits + etat.qlikEchecs < s.qlikParNuit;

            // Qlik prioritaire quand le quota d'entrelacement est atteint.
            if (qlikPossible && depuisDernierQlik >= s.sqlParQlik) {
                const cible = await prochainQlik(s.qlikMinJours, new Date());
                if (cible) {
                    await traiterQlik(cible.codeFournisseur, cible.nomFournisseur);
                    depuisDernierQlik = 0;
                    continue;
                }
            }

            const cibleSql = await prochainSql(depuis);
            if (cibleSql) {
                await traiterSql(cibleSql.codeFournisseur, cibleSql.nomFournisseur);
                depuisDernierQlik++;
                continue;
            }

            // File SQL vide : on consacre le temps restant à Qlik.
            if (qlikPossible) {
                const cible = await prochainQlik(s.qlikMinJours, new Date());
                if (cible) {
                    await traiterQlik(cible.codeFournisseur, cible.nomFournisseur);
                    depuisDernierQlik = 0;
                    continue;
                }
            }

            etat.tourTermine = true;
            console.log("[sync-nuit] plus rien en attente — tour terminé");
            break;
        }
    } catch (e) {
        etat.derniereErreur = e instanceof Error ? e.message : String(e);
        console.error("[sync-nuit] round interrompu :", etat.derniereErreur);
    } finally {
        etat.enCours = false;
        etat.fournisseurCourant = null;
        etat.etape = null;
        etat.finAt = new Date().toISOString();
        console.log(
            `[sync-nuit] round terminé — SQL ${etat.sqlFaits} ok / ${etat.sqlEchecs} en échec,`
            + ` Qlik ${etat.qlikFaits} ok / ${etat.qlikEchecs} en échec, tour bouclé=${etat.tourTermine}`,
        );
    }
}

/**
 * Battement du minuteur : ne fait quelque chose que dans la fenêtre, et jamais
 * deux rounds à la fois. Volontairement silencieux hors fenêtre — il est appelé
 * chaque minute.
 */
export async function tickScheduler(): Promise<void> {
    try {
        const s = await readSyncSettings();
        if (!s.actif || etat.enCours) return;
        if (!debutFenetre(s)) return;
        await lancerRound("auto");
    } catch (e) {
        console.error("[sync-nuit] tick en erreur :", e instanceof Error ? e.message : String(e));
    }
}
