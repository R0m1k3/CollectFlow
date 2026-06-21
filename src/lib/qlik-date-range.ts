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

/**
 * Découpe une fenêtre temporelle en sous-fenêtres mensuelles calendaires
 * **inclusives et continues**.
 *
 * But : éviter qu'un seul hypercube Qlik ne doive charger 365 jours × N
 * codes d'un coup (provoque `code:15 Request aborted`). Avec cette découpe,
 * chaque mois ≈ 28–31 jours × N codes → beaucoup plus léger pour l'Engine.
 *
 * Règles :
 *  - Le 1er mois commence à `filter.dateDebut` (peut être un jour quelconque,
 *    pas forcément le 1er calendaire).
 *  - Chaque mois intermédiaire est un mois calendaire **complet** (du 1er
 *    au dernier jour du mois).
 *  - Le dernier mois se termine à `filter.dateFin` (tronqué si pas fin de mois).
 *  - Les mois sont contigus : fin d'un mois + 1 = début du suivant.
 *  - Si `filter.dateDebut` et `filter.dateFin` tombent dans le même mois,
 *    on renvoie un seul mois (identique à `filter` mais re-calculé).
 *
 * Chaque mois retourné est un `QlikDateFilter` autonome : `qStart`/`qEnd`,
 * `dailySerials` recomptés, `setAnalysis` et `label` au format `YYYY-MM`.
 *
 * Pré-condition : `dateDebut <= dateFin` au sens calendaire (pas vérifié ici,
 * la validation est faite par `buildGridNetworkQlikDateFilter`).
 */
export function getMonthRanges(filter: QlikDateFilter): QlikDateFilter[] {
    const start = filter.dateDebut; // YYYY-MM-DD
    const end = filter.dateFin;     // YYYY-MM-DD

    // [yyyy, mm, dd] depuis YYYY-MM-DD (déjà validé par isoDateToQlikSerial).
    const sy = Number(start.slice(0, 4));
    const sm = Number(start.slice(5, 7));
    // const sd = Number(start.slice(8, 10)); // non utilisé directement
    const ey = Number(end.slice(0, 4));
    const em = Number(end.slice(5, 7));
    const ed = Number(end.slice(8, 10));

    // Dernier jour du mois (0-ième du mois suivant en UTC local Date).
    const lastDayOfMonth = (y: number, m: number): number => {
        // m: 1..12 ; on prend le jour 0 du mois suivant, qui donne le dernier jour du mois courant.
        return new Date(y, m, 0).getDate();
    };

    const pad = (n: number): string => String(n).padStart(2, "0");

    const out: QlikDateFilter[] = [];

    // Itère mois par mois du mois de début au mois de fin (inclus).
    let curY = sy;
    let curM = sm;
    // Sécurité anti-boucle infinie (au cas où).
    const MAX_MONTHS = 1200; // 100 ans, large.
    let safety = 0;
    while (safety++ < MAX_MONTHS) {
        const isFirst = curY === sy && curM === sm;
        const isLast = curY === ey && curM === em;

        // Début du mois courant : si c'est le premier mois, on respecte `dateDebut` ;
        // sinon on prend le 1er calendaire.
        const monthStartDay = isFirst ? Number(start.slice(8, 10)) : 1;
        const monthStartDate = `${curY}-${pad(curM)}-${pad(monthStartDay)}`;

        // Fin du mois courant : si c'est le dernier mois, on respecte `dateFin` ;
        // sinon on prend le dernier jour calendaire du mois.
        const monthEndDay = isLast ? ed : lastDayOfMonth(curY, curM);
        const monthEndDate = `${curY}-${pad(curM)}-${pad(monthEndDay)}`;

        const qStart = isoDateToQlikSerial(monthStartDate);
        const qEnd = isoDateToQlikSerial(monthEndDate);

        const dailySerials: number[] = [];
        for (let s = qStart; s <= qEnd; s++) dailySerials.push(s);

        const label = `${curY}-${pad(curM)}`;
        const setAnalysis = `Date={">=${qStart}<=${qEnd}"}`;

        out.push({ dateDebut: monthStartDate, dateFin: monthEndDate, qStart, qEnd, label, dailySerials, setAnalysis });

        if (isLast) break;

        // Avance d'un mois calendaire (gère le passage décembre → janvier).
        curM += 1;
        if (curM > 12) { curM = 1; curY += 1; }
    }

    if (out.length === 0) {
        // Fenêtre vide : on retourne un seul mois vide aligné sur dateDebut.
        const qStart = filter.qStart;
        const qEnd = filter.qEnd;
        const label = start.slice(0, 7);
        const setAnalysis = `Date={">=${qStart}<=${qEnd}"}`;
        out.push({ dateDebut: start, dateFin: end, qStart, qEnd, label, dailySerials: [], setAnalysis });
    }

    return out;
}
