/**
 * CollectFlow — Comparatif local vs réseau pour un produit.
 *
 * Principe : rapporter les deux périmètres à un **magasin moyen**, sinon on
 * compare 2 magasins Nancy à ~270 magasins réseau et le chiffre ne veut rien dire.
 *
 * ⚠️ La comparaison de référence porte sur les **quantités**. Le CA local vient
 * de `mvtart.mntmvtttc` (TTC) alors que la base de la mesure Qlik « CA N » n'est
 * pas documentée : les montants sont donc affichés côte à côte à titre indicatif,
 * sans indice calculé.
 */

import { NB_MAGASINS_RESEAU } from "@/features/grid/lib/network-trend";
import { ffMonthToQlik } from "@/features/grid/lib/months";
import type { ProduitFiche } from "@/features/produits/types";

export interface ComparatifMois {
    /** Clé de mois FF "YYYYMM". */
    mois: string;
    /** Quantité vendue par magasin, chez nous. */
    local: number;
    /** Quantité vendue par magasin, au réseau. */
    reseau: number;
}

export interface ComparatifReseau {
    /** false si le produit n'a pas encore de données réseau en cache. */
    hasReseau: boolean;
    /** Nombre de nos magasins ayant vendu le produit (min. 1 pour éviter /0). */
    nbMagasinsLocaux: number;
    nbMagasinsReseau: number;
    /** Taux de présence réseau (0..1), ou null sans données. */
    tauxPresence: number | null;

    /** Quantité 12 mois, par magasin. */
    qteLocaleParMagasin: number;
    qteReseauParMagasin: number;
    /**
     * Indice de performance en % : 100 = on vend autant qu'un magasin moyen du
     * réseau, 150 = 50 % de mieux. `null` si le réseau ne vend rien.
     */
    indiceQte: number | null;

    /** CA 12 mois par magasin — indicatif (bases de calcul non alignées). */
    caLocalParMagasin: number;
    caReseauParMagasin: number | null;

    /** Taux de marge en %, local et réseau (indicatif). */
    tauxMargeLocal: number;
    tauxMargeReseau: number | null;

    /** Série mensuelle par magasin, alignée sur les 12 mois de la fiche. */
    monthly: ComparatifMois[];
    /** true si au moins un mois réseau est disponible. */
    hasMonthly: boolean;
}

/**
 * Le taux de marge Qlik est un ratio brut (0.32 = 32 %) mais certaines
 * configurations renvoient déjà des points de pourcentage. Même normalisation
 * que la colonne « Marge % / Réseau » de la Grille.
 */
export function normalizeMargePct(raw: number | null | undefined): number | null {
    if (raw == null) return null;
    const v = Number(raw);
    if (!Number.isFinite(v) || v === 0) return null;
    return Math.abs(v) <= 1 ? v * 100 : v;
}

/** Calcule le comparatif local vs réseau à partir d'une fiche produit. */
export function computeComparatif(fiche: ProduitFiche): ComparatifReseau {
    const { reseau, totaux, sitesActifs, months, mensuelTotal } = fiche;

    // Nos magasins actifs sur la période. Si aucun n'a vendu, on garde 1 pour
    // que la division reste définie — l'indice vaudra alors 0, ce qui est le
    // message voulu : « le réseau vend, nous non ».
    const nbMagasinsLocaux = Math.max(sitesActifs.length, 1);
    const qteLocaleParMagasin = totaux.qte / nbMagasinsLocaux;
    const caLocalParMagasin = totaux.ca / nbMagasinsLocaux;

    if (!reseau || !reseau.nbMagasinsReseau) {
        return {
            hasReseau: false,
            nbMagasinsLocaux,
            nbMagasinsReseau: 0,
            tauxPresence: null,
            qteLocaleParMagasin,
            qteReseauParMagasin: 0,
            indiceQte: null,
            caLocalParMagasin,
            caReseauParMagasin: null,
            tauxMargeLocal: totaux.tauxMarge,
            tauxMargeReseau: null,
            monthly: [],
            hasMonthly: false,
        };
    }

    const nbMagasinsReseau = reseau.nbMagasinsReseau;
    const qteReseauParMagasin = reseau.qteReseau / nbMagasinsReseau;
    const caReseauParMagasin = reseau.caReseau / nbMagasinsReseau;

    // Série mensuelle : quantité par magasin de part et d'autre.
    // Le nb de magasins réseau du mois est utilisé quand il est disponible
    // (`metricsByMonth`), sinon on retombe sur le total de la période.
    const monthly: ComparatifMois[] = [];
    let hasMonthly = false;
    for (const mois of months) {
        const qlikKey = ffMonthToQlik(mois);
        const mensuel = reseau.metricsByMonth?.[qlikKey];
        const qteReseauMois = mensuel?.qte ?? reseau.qteByMonth?.[qlikKey];
        const nbMagMois = mensuel?.nbMag && mensuel.nbMag > 0 ? mensuel.nbMag : nbMagasinsReseau;

        if (qteReseauMois != null) hasMonthly = true;
        monthly.push({
            mois,
            local: (mensuelTotal[mois]?.qte ?? 0) / nbMagasinsLocaux,
            reseau: qteReseauMois != null ? qteReseauMois / nbMagMois : 0,
        });
    }

    return {
        hasReseau: true,
        nbMagasinsLocaux,
        nbMagasinsReseau,
        tauxPresence: nbMagasinsReseau / NB_MAGASINS_RESEAU,
        qteLocaleParMagasin,
        qteReseauParMagasin,
        indiceQte: qteReseauParMagasin > 0 ? (qteLocaleParMagasin / qteReseauParMagasin) * 100 : null,
        caLocalParMagasin,
        caReseauParMagasin,
        tauxMargeLocal: totaux.tauxMarge,
        tauxMargeReseau: normalizeMargePct(reseau.margePctReseau),
        monthly,
        hasMonthly,
    };
}

/** Lecture métier de l'indice de performance. */
export function indiceVerdict(indice: number | null): { label: string; color: string } {
    if (indice == null) return { label: "Non comparable", color: "var(--text-muted)" };
    if (indice >= 150) return { label: "Forte surperformance", color: "#22c55e" };
    if (indice >= 110) return { label: "Surperformance", color: "#22c55e" };
    if (indice >= 90) return { label: "Dans la moyenne réseau", color: "var(--text-secondary)" };
    if (indice >= 50) return { label: "Sous-performance", color: "#f59e0b" };
    return { label: "Forte sous-performance", color: "#ef4444" };
}
