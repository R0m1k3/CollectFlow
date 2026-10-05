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
const nfDecimal2 = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

/**
 * Montant au centime, sans symbole (colonnes déjà libellées « (€) ») : `12 345,67`.
 * Les montants ne sont jamais arrondis à l'euro dans l'application.
 */
export const fmtDecimal2 = (v: number): string => nfDecimal2.format(v);

/** Montant en euros au centime (prix, CA, marge) : `12 345,67 €`. */
export const fmtEur2 = (v: number): string => nfEur2.format(v);
