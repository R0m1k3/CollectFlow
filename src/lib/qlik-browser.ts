/**
 * CollectFlow — Chromium et file d'attente partagés par tous les accès Qlik
 * (extraction réseau `qlik-playwright.ts`, recherche produit `qlik-search.ts`).
 */

import "server-only";
import { chromium, type Browser } from "playwright-core";

let browserPromise: Promise<Browser> | null = null;

/**
 * Chromium partagé entre les extractions.
 *
 * Un navigateur tombé (plantage, mémoire, arrêt du processus enfant) restait
 * mémorisé : toutes les extractions suivantes échouaient sur « Target closed »
 * jusqu'au redémarrage du serveur. On le relance donc dès qu'il est déconnecté.
 */
export async function getQlikBrowser(): Promise<Browser> {
    if (browserPromise) {
        const existant = await browserPromise.catch(() => null);
        if (existant?.isConnected()) return existant;
        browserPromise = null;
    }
    const execPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
    const lancement = chromium.launch({
        headless: true,
        executablePath: execPath || undefined,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"],
    });
    browserPromise = lancement;
    lancement
        .then((b) => b.on("disconnected", () => {
            console.warn("[qlik] Chromium déconnecté — il sera relancé à la prochaine extraction");
            if (browserPromise === lancement) browserPromise = null;
        }))
        .catch(() => { if (browserPromise === lancement) browserPromise = null; });
    return lancement;
}

/**
 * File unique des extractions.
 *
 * Le serveur Qlik abandonne les requêtes dès qu'il est trop sollicité. Une
 * synchro manuelle lancée pendant la synchro de nuit, ou deux recherches
 * produit simultanées, ouvraient deux sessions Engine en parallèle — et les
 * deux échouaient. Les extractions passent désormais l'une après l'autre.
 */
let fileExtractions: Promise<unknown> = Promise.resolve();
let extractionsEnAttente = 0;

export function dansLaFileQlik<T>(libelle: string, tache: () => Promise<T>): Promise<T> {
    if (extractionsEnAttente > 0) {
        console.log(`[qlik] ${libelle} : en attente de ${extractionsEnAttente} extraction(s) en cours`);
    }
    extractionsEnAttente++;
    const resultat = fileExtractions.then(tache, tache);
    fileExtractions = resultat.then(() => undefined, () => undefined).finally(() => { extractionsEnAttente--; });
    return resultat;
}
