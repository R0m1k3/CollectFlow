/**
 * Glossaire des termes métier affichés dans l'application.
 *
 * Une seule définition par terme, reprise par les infobulles (`<Terme>`) : un
 * utilisateur occasionnel ne doit pas avoir à deviner ce que signifient
 * « Franco », « PRMP » ou « Réseau ».
 */

import { NB_MAGASINS_RESEAU } from "@/features/grid/lib/network-trend";

export interface EntreeGlossaire {
    /** Libellé affiché. */
    terme: string;
    /** Explication en une ou deux phrases. */
    definition: string;
}

export const GLOSSAIRE = {
    gamme: {
        terme: "Gamme",
        definition: "Place du produit dans l'assortiment du magasin, de A (cœur de gamme) à Z (sortie).",
    },
    gammeInit: {
        terme: "Gamme actuelle",
        definition: "Gamme enregistrée aujourd'hui dans FF, avant vos modifications.",
    },
    reseau: {
        terme: "Réseau",
        definition: `Les ${NB_MAGASINS_RESEAU} magasins du réseau La Foir'Fouille, toutes enseignes confondues.`,
    },
    nosMagasins: {
        terme: "Nos magasins",
        definition: "Frouard (Nancy) et Houdemont.",
    },
    presenceReseau: {
        terme: "Magasins vendeurs",
        definition: `Nombre de magasins du réseau (sur ${NB_MAGASINS_RESEAU}) qui ont vendu ce produit sur la période.`,
    },
    caParMagasin: {
        terme: "CA par magasin",
        definition: "Chiffre d'affaires moyen d'un magasin du réseau qui vend ce produit.",
    },
    franco: {
        terme: "Franco",
        definition: "Montant de commande à atteindre pour que le fournisseur livre sans frais de port.",
    },
    commandeAuto: {
        terme: "Commande automatique",
        definition: "Proposition de commande calculée par FF à partir des ventes et du stock.",
    },
    cadencier: {
        terme: "Cadencier",
        definition: "Rythme de commande choisi pour un fournisseur (toutes les X semaines) : l'alerte se déclenche quand l'échéance approche.",
    },
    pcb: {
        terme: "PCB",
        definition: "« Par combien » : nombre d'unités dans un colis du fournisseur.",
    },
    prmp: {
        terme: "PRMP",
        definition: "Prix de revient moyen pondéré : coût d'achat moyen d'une unité en stock.",
    },
    gtin: {
        terme: "Code-barres",
        definition: "Code EAN / GTIN imprimé sur l'emballage du produit.",
    },
    codeInterne: {
        terme: "Code article",
        definition: "Code interne de l'article dans FF.",
    },
    codeCentrale: {
        terme: "Code centrale",
        definition: "Code de l'article à la centrale d'achat, commun à tous les magasins du réseau.",
    },
    n1: {
        terme: "N-1",
        definition: "Même période l'année précédente.",
    },
    marge: {
        terme: "Marge",
        definition: "Chiffre d'affaires moins le coût d'achat. Le taux de marge est la marge divisée par le chiffre d'affaires.",
    },
    stockNegatif: {
        terme: "Stock négatif",
        definition: "Le stock calculé est inférieur à zéro : des ventes ont été enregistrées sans l'entrée de marchandise correspondante.",
    },
    tauxSortie: {
        terme: "Taux de sortie",
        definition: "Part du stock de l'opération vendue pendant la publicité.",
    },
    partCaTotal: {
        terme: "Part du CA total",
        definition: "Poids des ventes de l'opération dans le chiffre d'affaires total du magasin sur la même période.",
    },
} satisfies Record<string, EntreeGlossaire>;

export type CleGlossaire = keyof typeof GLOSSAIRE;
