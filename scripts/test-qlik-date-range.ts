/**
 * Test CLI pour `src/lib/qlik-date-range.ts` (aucune dépendance Next.js).
 * Usage :  npx tsx scripts/test-qlik-date-range.ts
 *
 * Vérifie :
 *  - les repères Qlik (2025-01-01→45658, etc.)
 *  - la fenêtre 12 mois complets pour `now=2026-06-21` (doit donner
 *    dateDebut=2025-06-01, dateFin=2026-05-31, qStart=45809, qEnd=46173,
 *    label=2025-06_2026-05, 365 serials)
 *  - exemples supplémentaires (1er du mois, fin d'année, année bissextile)
 *  - erreurs attendues sur entrée mal formée
 *
 * Aucun framework : assertions manuelles, exit code 0/1.
 */

import {
    isoDateToQlikSerial,
    qlikSerialToIsoDate,
    buildGridNetworkQlikDateFilter,
    chunkSerials,
    QLIK_DATE_ANCHORS,
} from "../src/lib/qlik-date-range";

let pass = 0;
let fail = 0;

function eq(label: string, got: unknown, want: unknown): void {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) {
        pass++;
        console.log(`  \u2713 ${label}`);
    } else {
        fail++;
        console.log(`  \u2717 ${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
    }
}

function truthy(label: string, got: unknown): void {
    if (got) {
        pass++;
        console.log(`  \u2713 ${label}`);
    } else {
        fail++;
        console.log(`  \u2717 ${label} \u2014 falsy: ${JSON.stringify(got)}`);
    }
}

function throws(label: string, fn: () => unknown, re?: RegExp): void {
    try {
        fn();
        fail++;
        console.log(`  \u2717 ${label} \u2014 n'a pas lanc\u00e9 d'exception`);
    } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (!re || re.test(msg)) {
            pass++;
            console.log(`  \u2713 ${label}`);
        } else {
            fail++;
            console.log(`  \u2717 ${label} \u2014 exception inattendue: ${msg}`);
        }
    }
}

console.log("\n[1] Rep\u00e8res Qlik (skill qlik)");
for (const a of QLIK_DATE_ANCHORS) {
    eq(`isoDateToQlikSerial(${a.iso}) = ${a.serial}`, isoDateToQlikSerial(a.iso), a.serial);
}

console.log("\n[2] Round-trip s\u00e9rial \u2194 ISO");
for (const a of QLIK_DATE_ANCHORS) {
    eq(`qlikSerialToIsoDate(${a.serial}) = ${a.iso}`, qlikSerialToIsoDate(a.serial), a.iso);
}

console.log("\n[3] Fen\u00eatre grille (now=2026-06-21) \u2192 2025-06-01 .. 2026-05-31");
const f = buildGridNetworkQlikDateFilter(new Date("2026-06-21T12:00:00Z"));
eq("dateDebut", f.dateDebut, "2025-06-01");
eq("dateFin",   f.dateFin,   "2026-05-31");
eq("qStart", f.qStart, 45809);
eq("qEnd",   f.qEnd,   46173);
eq("label",  f.label,  "2025-06_2026-05");
eq("setAnalysis", f.setAnalysis, `Date={">=45809<=46173"}`);
eq("dailySerials.length = 365", f.dailySerials.length, 365);
eq("dailySerials[0]", f.dailySerials[0], 45809);
eq("dailySerials[364]", f.dailySerials[364], 46173);

console.log("\n[4] Fen\u00eatre grille (now=2026-03-15) \u2192 2025-03-01 .. 2026-02-28");
const f2 = buildGridNetworkQlikDateFilter(new Date("2026-03-15T08:00:00Z"));
eq("dateDebut", f2.dateDebut, "2025-03-01");
eq("dateFin",   f2.dateFin,   "2026-02-28");
eq("qStart", f2.qStart, 45717);
eq("qEnd", f2.qEnd, 46081);

console.log("\n[5] Fen\u00eatre grille (now=2025-01-05) \u2192 2024-01-01 .. 2024-12-31 (ann\u00e9e bissextile, 366 j)");
const f3 = buildGridNetworkQlikDateFilter(new Date("2025-01-05T08:00:00Z"));
eq("dateDebut", f3.dateDebut, "2024-01-01");
eq("dateFin",   f3.dateFin,   "2024-12-31");
eq("dailySerials.length = 366", f3.dailySerials.length, 366);

console.log("\n[6] chunkSerials");
const chunks = chunkSerials(f.dailySerials, 100);
eq("chunks.length pour 365/100", chunks.length, 4);
eq("chunks[3].length = 65", chunks[3].length, 65);
eq("chunks[0][0]", chunks[0][0], 45809);
eq("chunks[3][64]", chunks[3][64], 46173);

console.log("\n[7] Robustesse");
throws("format invalide '2025/01/01'", () => isoDateToQlikSerial("2025/01/01"), /YYYY-MM-DD/);
throws("format vide", () => isoDateToQlikSerial(""), /YYYY-MM-DD/);
truthy("label non vide pour fen\u00eatre valide", f.label && f.label.length > 0);
truthy("setAnalysis commence par 'Date='", f.setAnalysis.startsWith("Date="));

console.log(`\n=== ${pass} pass\u00e9s, ${fail} \u00e9chou\u00e9s ===`);
if (fail > 0) process.exit(1);
