/**
 * CollectFlow — Helper de fenêtre temporelle pour Qlik réseau.
 *
 * Aligne la timeline d'extraction Qlik réseau sur la timeline de la grille :
 *   - 12 mois complets glissants
 *   - exclut systématiquement le mois courant
 *
 * Référence utilisée : `buildLast12MonthsRange()` de `api-ff-client.ts`
 * (même source que la grille). On duplique la logique ici (sans dépendance
 * Next.js) pour rester testable en CLI pur Node.
 *
 * Qlik référence les dates par un sérial numérique (jours écoulés depuis
 * l'epoch Qlik 1899-12-30). Repères validés :
 *   2025-01-01 → 45658
 *   2025-06-19 → 45827
 *   2026-01-01 → 46023
 *   2026-06-19 → 46192
 *
 * Le filtre côté Qlik s'applique via une sélection de champ `Date` (skill qlik) :
 *   - valeurs numériques = serials Qlik
 *   - la sélection par défaut (`{<Date={...}>}`) est héritée par toutes
 *     les master measures qui référencent le champ `Date` (cas de l'app
 *     "Magasins Vision Consolidée").
 *
 * Pourquoi `SelectValues` sur le champ plutôt que set analysis dans `qDef` ?
 *   - les master items sont référencés par `qLibraryId` (réutilisation sans
 *     devoir dupliquer l'expression)
 *   - `qLibraryId` + `qDef` ensemble n'est pas supporté par le moteur QIX
 *   - sélectionner toutes les dates de la fenêtre via `SelectValues` revient
 *     fonctionnellement à `{<Date={">=…<=…"}>}` pour les mesures qui touchent
 *     ce champ, sans dépendre de l'expression interne des master items
 *
 * Pas de secrets ici. Pure fonction utilitaire testable en CLI Node.
 */

/** Epoch Qlik = 1899-12-30 (équivalent Excel/Lotus 1-2-3). */
const QLIK_EPOCH_MS = Date.UTC(1899, 11, 30); // 1899-12-30T00:00:00Z

/** Repères de validation (cf. skill qlik). */
export const QLIK_DATE_ANCHORS: ReadonlyArray<{ iso: string; serial: number }> = [
    { iso: "2025-01-01", serial: 45658 },
    { iso: "2025-06-19", serial: 45827 },
    { iso: "2026-01-01", serial: 46023 },
    { iso: "2026-06-19", serial: 46192 },
];

/**
 * Convertit une date ISO `YYYY-MM-DD` en sérial Qlik numérique.
 * Inverse documenté : Qlik epoch = 1899-12-30 (jour 0).
 *
 * @throws si l'entrée n'est pas au format `YYYY-MM-DD`.
 */
export function isoDateToQlikSerial(isoDate: string): number {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
    if (!m) throw new Error(`isoDateToQlikSerial: format attendu YYYY-MM-DD, reçu "${isoDate}"`);
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const ms = Date.UTC(y, mo - 1, d);
    const serial = Math.round((ms - QLIK_EPOCH_MS) / 86_400_000);
    return serial;
}

/**
 * Convertit un sérial Qlik en date ISO `YYYY-MM-DD` (utile pour tests/diagnostics).
 */
export function qlikSerialToIsoDate(serial: number): string {
    const ms = QLIK_EPOCH_MS + serial * 86_400_000;
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const da = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${mo}-${da}`;
}

export interface QlikDateFilter {
    /** Date ISO du 1er jour de la fenêtre (inclus). */
    dateDebut: string;
    /** Date ISO du dernier jour de la fenêtre (inclus). */
    dateFin: string;
    /** Sérial Qlik du 1er jour (= `Date >= …`). */
    qStart: number;
    /** Sérial Qlik du dernier jour (= `Date <= …`). */
    qEnd: number;
    /** Libellé humain `YYYY-MM_YYYY-MM` pour logs / cache. */
    label: string;
    /** Liste exhaustive des serials journaliers `[qStart..qEnd]` pour SelectValues. */
    dailySerials: number[];
    /** Expression set analysis prête à intégrer dans un `qDef` de mesure. */
    setAnalysis: string;
}

/**
 * Calcule la fenêtre 12 mois complets (excluant mois courant).
 * Par défaut, utilise `now = new Date()`. Testable via injection de `now`.
 *
 * Logique alignée sur `buildLast12MonthsRange()` de `src/lib/api-ff-client.ts`.
 * Si la source officielle change, mettre à jour ici aussi (garder en sync).
 */
export function buildGridNetworkQlikDateFilter(now: Date = new Date()): QlikDateFilter {
    // Fin : dernier jour du mois précédent le mois courant
    const endMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    // Début : 12 mois avant le mois courant (1er du mois)
    const startMonth = new Date(now.getFullYear(), now.getMonth() - 12, 1);

    const dateDebut = startMonth.toISOString().slice(0, 10);
    const dateFin = endMonth.toISOString().slice(0, 10);

    const qStart = isoDateToQlikSerial(dateDebut);
    const qEnd = isoDateToQlikSerial(dateFin);

    if (qEnd < qStart) {
        throw new Error(
            `buildGridNetworkQlikDateFilter: fenêtre inversée qEnd=${qEnd} < qStart=${qStart} (dateDebut=${dateDebut} dateFin=${dateFin})`,
        );
    }

    const dailySerials: number[] = [];
    for (let s = qStart; s <= qEnd; s++) dailySerials.push(s);

    const label = `${dateDebut.slice(0, 7)}_${dateFin.slice(0, 7)}`;
    const setAnalysis = `Date={">=${qStart}<=${qEnd}"}`;

    return { dateDebut, dateFin, qStart, qEnd, label, dailySerials, setAnalysis };
}

/**
 * Découpe les serials en lots pour appels `SelectValues` paginés.
 * Par défaut 500 valeurs/appel (largement < limite Qlik ~10k par requête).
 */
export function chunkSerials(serials: number[], batchSize = 500): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < serials.length; i += batchSize) {
        out.push(serials.slice(i, i + batchSize));
    }
    return out;
}
