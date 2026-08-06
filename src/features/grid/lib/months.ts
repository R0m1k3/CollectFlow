/**
 * CollectFlow — Helpers de fenêtre mensuelle et de libellés magasin.
 *
 * Extraits de `heatmap-grid.tsx` pour être partagés entre la Grille et la
 * fiche produit (`/produits`). Aucun changement de comportement.
 *
 * ⚠️ Deux conventions de clé de mois cohabitent dans l'application :
 *   - séries FF Nancy (ventes / stock / réceptions) : `"YYYYMM"` (sans tiret)
 *   - séries réseau Qlik (`qteByMonth`, `metricsByMonth`)  : `"YYYY-MM"` (avec tiret)
 * Utiliser `ffMonthToQlik` / `qlikMonthToFf` pour passer de l'une à l'autre.
 */

/**
 * Les 12 mois complets glissants, du plus ancien au plus récent, au format
 * `"YYYYMM"`. Le mois en cours est **exclu** (on part de i=12 jusqu'à i=1).
 *
 * ⚠️ À n'appeler qu'à l'intérieur d'un `useMemo` / d'un rendu, jamais au niveau
 * module : `new Date()` évalué à l'import provoque un mismatch d'hydratation
 * entre le rendu serveur et le rendu client.
 */
export function getLast12Months(): string[] {
    const months: string[] = [];
    const now = new Date();
    // On commence à i=12 (il y a 12 mois) et on finit à i=1 (le mois dernier)
    // pour exclure le mois en cours (i=0)
    for (let i = 12; i >= 1; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    return months;
}

/** `"202601"` → `"Jan 26"`. */
export function formatMonthLabel(key: string): string {
    const m = parseInt(key.slice(4, 6), 10);
    const names = ["Jan", "Fév", "Mar", "Avr", "Mai", "Jun", "Jul", "Aoû", "Sep", "Oct", "Nov", "Déc"];
    return `${names[m - 1]} ${key.slice(2, 4)}`;
}

/** `"2026-01"` → `"01/26"` — axe compact des graphiques. */
export function fmtMonthShort(lab: string): string {
    const [y, m] = lab.split("-");
    return `${m ?? lab}/${(y ?? "").slice(2)}`;
}

/** Date ISO → `jj/mm/aaaa`, `"—"` si absente ou invalide. */
export function formatDate(iso?: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Clé de mois FF `"202601"` → clé Qlik `"2026-01"`. */
export function ffMonthToQlik(key: string): string {
    return `${key.slice(0, 4)}-${key.slice(4, 6)}`;
}

/** Clé de mois Qlik `"2026-01"` → clé FF `"202601"`. */
export function qlikMonthToFf(key: string): string {
    return key.replace("-", "");
}

/** Les deux magasins FF Nancy suivis par l'application. */
export const SITE_LABELS: Record<string, { label: string; nom: string }> = {
    "292": { label: "F", nom: "Frouard (Nancy)" },
    "579": { label: "H", nom: "Houdemont" },
};

/**
 * Style de badge stable pour un magasin : la couleur est dérivée d'un hash du
 * nom, donc identique quel que soit l'ordre d'affichage.
 */
export function getStoreConfig(name: string) {
    const known = SITE_LABELS[name];
    const words = (known?.nom ?? name).trim().split(/\s+/);
    let label = known?.label ?? words[0].charAt(0).toUpperCase();
    if (!known && words.length > 1) {
        label += words[1].charAt(0).toUpperCase();
    }

    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const colorInt = Math.abs(hash) % 5;

    switch (colorInt) {
        case 0: return { bg: "rgba(99, 102, 241, 0.1)", text: "#818cf8", border: "rgba(99, 102, 241, 0.2)", label }; // Indigo
        case 1: return { bg: "rgba(245, 158, 11, 0.1)", text: "#fbbf24", border: "rgba(245, 158, 11, 0.2)", label }; // Amber
        case 2: return { bg: "rgba(16, 185, 129, 0.1)", text: "#10b981", border: "rgba(16, 185, 129, 0.2)", label }; // Emerald
        case 3: return { bg: "rgba(236, 72, 153, 0.1)", text: "#ec4899", border: "rgba(236, 72, 153, 0.2)", label }; // Pink
        case 4: return { bg: "rgba(14, 165, 233, 0.1)", text: "#0ea5e9", border: "rgba(14, 165, 233, 0.2)", label }; // Sky
        default: return { bg: "var(--bg-elevated)", text: "var(--text-muted)", border: "var(--border)", label };
    }
}
