/**
 * CollectFlow — Contrôles de plausibilité d'une extraction réseau Qlik.
 *
 * L'extracteur vérifie déjà que les 12 mois de la fenêtre sont servis. Il ne
 * peut pas voir deux pièges, observés ou attendus en production, qui donnent
 * des chiffres faux mais complets :
 *
 *  1. **Dernier mois pas encore chargé dans Qlik.** Les premiers jours du mois,
 *     le mois qui vient de se terminer peut n'être chargé qu'en partie. Il est
 *     « couvert » (quelques ventes), donc accepté — et toutes les tendances du
 *     fournisseur plongent d'un coup, jusqu'à la synchro suivante, une semaine
 *     ou plus après.
 *  2. **Mesure insensible au mois.** Quand une mesure ignore la sélection de
 *     dates, chaque mois reçoit la même valeur (le total de l'année). Le
 *     diagnostic existait dans les journaux ; rien n'empêchait l'écriture.
 *
 * Dans les deux cas, garder le cache précédent vaut mieux qu'écrire des
 * données fausses : l'extraction est refusée, et le planificateur la reprend
 * une nuit suivante.
 *
 * Module pur (aucune dépendance d'exécution) : testable hors serveur.
 */

import type { NetworkMetric } from "@/lib/qlik-client";

export interface ControleExtraction {
    ok: boolean;
    /** Raison du refus, lisible par l'administrateur (statut de synchro). */
    motif?: string;
    /** Anomalies corrigées ou tolérées, à journaliser. */
    avertissements: string[];
}

export interface OptionsControle {
    /**
     * Jusqu'à quel jour du mois le dernier mois est soupçonné d'être incomplet.
     * Au-delà, une baisse est prise pour ce qu'elle est : une baisse.
     */
    jourLimiteDernierMois?: number;
    /** Part minimale du dernier mois par rapport à la moyenne des 3 précédents. */
    ratioDernierMoisMin?: number;
    /** Volume mensuel moyen en dessous duquel le contrôle n'a pas de sens. */
    volumeMinimal?: number;
    /** Part maximale de séries plates (même valeur 12 mois) parmi les séries vendues. */
    partSeriesPlatesMax?: number;
}

const DEFAUTS: Required<OptionsControle> = {
    jourLimiteDernierMois: 10,
    ratioDernierMoisMin: 0.4,
    volumeMinimal: 30,
    partSeriesPlatesMax: 0.5,
};

const fini = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

/**
 * Corrige sur place les valeurs impossibles d'une métrique (NaN, infini,
 * nombre de magasins négatif) et renvoie la liste des corrections.
 */
export function assainirMetrique(m: NetworkMetric): string[] {
    const corrections: string[] = [];
    const champs = ["caReseau", "qteReseau", "nbMagasinsReseau", "caParMagasinReseau", "margePctReseau"] as const;
    for (const champ of champs) {
        if (!Number.isFinite(Number(m[champ]))) {
            corrections.push(`${m.codeCentrale} : ${champ} non numérique (${String(m[champ])}) remplacé par 0`);
            m[champ] = 0;
        }
    }
    if (m.nbMagasinsReseau < 0) {
        corrections.push(`${m.codeCentrale} : nombre de magasins négatif (${m.nbMagasinsReseau}) remplacé par 0`);
        m.nbMagasinsReseau = 0;
    }
    m.nbMagasinsReseau = Math.round(m.nbMagasinsReseau);
    m.caParMagasinReseau = m.nbMagasinsReseau > 0 ? m.caReseau / m.nbMagasinsReseau : 0;

    if (m.qteByMonth) {
        for (const [mois, v] of Object.entries(m.qteByMonth)) {
            if (!Number.isFinite(Number(v))) {
                corrections.push(`${m.codeCentrale} : quantité ${mois} non numérique remplacée par 0`);
                m.qteByMonth[mois] = 0;
            }
        }
    }
    if (m.metricsByMonth) {
        for (const [mois, v] of Object.entries(m.metricsByMonth)) {
            m.metricsByMonth[mois] = {
                qte: fini(v?.qte),
                ca: fini(v?.ca),
                nbMag: Math.max(0, Math.round(fini(v?.nbMag))),
                caMag: fini(v?.caMag),
                margePct: fini(v?.margePct),
            };
        }
    }
    return corrections;
}

/**
 * Contrôle d'ensemble d'une extraction 12 mois, AVANT écriture du cache.
 *
 * `fenetre` : les mois attendus (« YYYY-MM »), du plus ancien au plus récent.
 */
export function controlerExtraction(
    metriques: Iterable<NetworkMetric>,
    fenetre: string[],
    now: Date = new Date(),
    options: OptionsControle = {},
): ControleExtraction {
    const o = { ...DEFAUTS, ...options };
    const avertissements: string[] = [];
    const liste = [...metriques];
    if (liste.length === 0 || fenetre.length < 4) return { ok: true, avertissements };

    // ── 1. Séries plates : la mesure a ignoré la sélection de mois ──────────
    let vendues = 0;
    let plates = 0;
    for (const m of liste) {
        const valeurs = fenetre.map((mois) => fini(m.qteByMonth?.[mois]));
        if (!valeurs.some((v) => v !== 0)) continue;
        vendues++;
        if (valeurs.every((v) => v === valeurs[0])) plates++;
    }
    if (vendues >= 5 && plates / vendues > o.partSeriesPlatesMax) {
        return {
            ok: false,
            motif: `${plates} séries sur ${vendues} ont la même quantité les 12 mois : la mesure Qlik ignore le mois, données refusées`,
            avertissements,
        };
    }
    if (plates > 0) avertissements.push(`${plates} série(s) identique(s) sur 12 mois parmi ${vendues} vendues`);

    // ── 2. Dernier mois manifestement incomplet ─────────────────────────────
    const totaux = fenetre.map((mois) => liste.reduce((t, m) => t + fini(m.qteByMonth?.[mois]), 0));
    const dernier = totaux[totaux.length - 1];
    const precedents = totaux.slice(-4, -1);
    const reference = precedents.reduce((t, v) => t + v, 0) / precedents.length;
    if (
        now.getDate() <= o.jourLimiteDernierMois &&
        reference >= o.volumeMinimal &&
        dernier < reference * o.ratioDernierMoisMin
    ) {
        const pct = Math.round((dernier / reference) * 100);
        return {
            ok: false,
            motif: `le dernier mois (${fenetre[fenetre.length - 1]}) ne pèse que ${pct} % des 3 mois précédents : `
                + `probablement pas encore entièrement chargé dans Qlik, données refusées (nouvel essai une prochaine nuit)`,
            avertissements,
        };
    }

    return { ok: true, avertissements };
}
