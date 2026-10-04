/**
 * CollectFlow — Diagnostic de l'API FF Nancy.
 *
 * Partagé par le bouton « Tester » des Paramètres (administrateurs) et par la
 * route `/api/ff-status` (tout utilisateur connecté). Module serveur et non
 * fichier d'actions : chaque appelant fait son propre contrôle d'accès.
 */

import "server-only";

import { readConfig } from "./config-file";

/**
 * Teste l'API FF Nancy et renvoie un diagnostic **exploitable**.
 *
 * L'ancien panneau se contentait d'un « HTTP 503 » opaque : impossible de savoir
 * si l'hôte était injoignable, l'URL erronée ou le service en panne. On distingue
 * donc ici l'échec réseau (DNS, refus de connexion, délai dépassé) du code HTTP.
 */
export async function diagnostiquerApiFf(ffApiBaseUrl?: string) {
    const base = (ffApiBaseUrl?.trim() || (await readConfig()).ffApiBaseUrl || process.env.FF_API_BASE_URL || "https://api.ffnancy.fr").replace(/\/+$/, "");
    const url = `${base}/api/sync/status`;
    const started = Date.now();
    try {
        const res = await fetch(url, {
            cache: "no-store",
            signal: AbortSignal.timeout(8000),
        });
        const ms = Date.now() - started;
        if (!res.ok) {
            return { success: false, url, error: `Le serveur a répondu HTTP ${res.status} (${res.statusText || "sans message"}) en ${ms} ms.` };
        }
        const body = await res.json().catch(() => null);
        if (!body) {
            return { success: false, url, error: `Réponse HTTP 200 mais corps illisible (JSON attendu).` };
        }
        // La réponse brute de l'API n'a pas la forme attendue par l'interface :
        // sans cette normalisation, le panneau s'affiche vide malgré un HTTP 200.
        const { normalizeSyncStatus } = await import("@/lib/api-ff-client");
        const status = normalizeSyncStatus(body);
        if (!status) {
            return { success: false, url, error: `Réponse HTTP 200 mais format inattendu (ni « sync » ni « tables »).` };
        }
        return { success: true, url, ms, status };
    } catch (error: unknown) {
        const ms = Date.now() - started;
        const raw = error instanceof Error ? error.message : String(error);
        const name = error instanceof Error ? error.name : "";
        // fetch masque la cause réelle derrière « fetch failed » : on la déplie.
        const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
        let hint = raw;
        if (name === "TimeoutError" || name === "AbortError") {
            hint = `Aucune réponse en ${ms} ms — serveur injoignable ou trop lent.`;
        } else if (cause?.code === "ENOTFOUND") {
            hint = `Nom d'hôte introuvable (DNS) — vérifiez l'URL.`;
        } else if (cause?.code === "ECONNREFUSED") {
            hint = `Connexion refusée — le service n'écoute pas sur cette adresse.`;
        } else if (cause?.code) {
            hint = `${cause.code}${cause.message ? ` — ${cause.message}` : ""}`;
        }
        console.error(`[Settings] FF API test KO (${url}):`, raw);
        return { success: false, url, error: hint };
    }
}
