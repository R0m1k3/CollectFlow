/**
 * Formateurs de nombres partagés (fr-FR).
 *
 * `Number.prototype.toLocaleString` appelé avec des options construit un nouvel
 * `Intl.NumberFormat` à chaque appel : dans la Grille, plusieurs milliers de
 * cellules le payaient à chaque défilement et à chaque tri. Ces instances sont
 * créées une seule fois et donnent exactement le même texte.
 */

const nfEntier = new Intl.NumberFormat("fr-FR");
const nfDecimal1 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const nfEur0 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const nfEur2 = new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

/** Entier arrondi avec séparateur de milliers : `12 345`. */
export const fmtEntier = (v: number): string => nfEntier.format(Math.round(v));

/** Nombre avec au plus une décimale : `12,5`. */
export const fmtDecimal1 = (v: number): string => nfDecimal1.format(v);

/** Montant en euros sans centimes : `12 345 €`. */
export const fmtEur0 = (v: number): string => nfEur0.format(v);

/** Montant en euros au centime (prix unitaires) : `3,49 €`. */
export const fmtEur2 = (v: number): string => nfEur2.format(v);
