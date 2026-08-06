"use server";

import { Pool } from "pg";
import fs from "fs/promises";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const CONFIG_FILE = path.join(DATA_DIR, ".db-config.json");

export interface DbConfig {
    url: string;
    openRouterKey?: string;
    openRouterModel?: string;
    aiProvider?: "openrouter" | "google";
    googleAiKey?: string;
    googleAiModel?: string;
    /** Qlik Sense — données réseau */
    qlikHost?: string;
    qlikUser?: string;
    qlikPassword?: string;
    /**
     * API REST FF Nancy (ex. https://api.ffnancy.fr). Sert au panneau de statut et
     * au rattrapage des ventes par magasin dans la Grille. Configurable ici pour
     * ne pas dépendre d'une variable d'environnement qu'on ne peut pas changer
     * sans redéployer.
     */
    ffApiBaseUrl?: string;
}

/** Lit la config existante (ou {} si absente). */
async function readConfig(): Promise<Partial<DbConfig>> {
    try {
        const data = await fs.readFile(CONFIG_FILE, "utf-8");
        return JSON.parse(data);
    } catch {
        return {};
    }
}

export async function testDatabaseConnection(url: string) {
    console.log("Testing connection to:", url.replace(/:([^@]+)@/, ":****@"));
    const pool = new Pool({
        connectionString: url,
        connectionTimeoutMillis: 5000,
    });

    try {
        const client = await pool.connect();
        await client.query("SELECT 1");
        client.release();
        return { success: true };
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Database connection test failed:", errorMessage);
        return { success: false, error: errorMessage };
    } finally {
        await pool.end();
    }
}

export async function saveDatabaseSettings(
    url: string,
    openRouterKey?: string,
    openRouterModel?: string,
    aiProvider?: "openrouter" | "google",
    googleAiKey?: string,
    googleAiModel?: string,
) {
    try {
        // Merge avec l'existant pour préserver les autres réglages (ex: Qlik)
        const existing = await readConfig();
        const config: DbConfig = { ...existing, url, openRouterKey, openRouterModel, aiProvider, googleAiKey, googleAiModel };

        // S'assurer que le dossier data existe
        await fs.mkdir(DATA_DIR, { recursive: true });

        console.log(`[Settings] Saving config to ${CONFIG_FILE}`);
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log("[Settings] Database configuration saved successfully.");

        // Refresh the shared DB instance immediately
        const { refreshDb } = await import("@/db");
        refreshDb();

        return { success: true };
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Failed to save database configuration:", errorMessage);
        return { success: false, error: errorMessage };
    }
}

export async function saveQlikSettings(qlikHost: string, qlikUser: string, qlikPassword: string) {
    try {
        const existing = await readConfig();
        const config = { ...existing, qlikHost, qlikUser, qlikPassword } as DbConfig;
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log("[Settings] Qlik configuration saved.");
        return { success: true };
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("[Settings] Failed to save Qlik config:", msg);
        return { success: false, error: msg };
    }
}

export async function testQlikConnection(qlikHost: string, qlikUser: string, qlikPassword: string) {
    try {
        const { getQlikConfig, qlikNtlmSession } = await import("@/lib/qlik-client");
        const cfg = { ...getQlikConfig(), user: qlikUser, password: qlikPassword };
        if (qlikHost) cfg.host = qlikHost;
        await qlikNtlmSession(cfg);
        return { success: true };
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, error: msg };
    }
}

/** Enregistre l'URL de l'API FF Nancy. Chaîne vide = revenir au défaut. */
export async function saveFfApiSettings(ffApiBaseUrl: string) {
    try {
        const cleaned = ffApiBaseUrl.trim().replace(/\/+$/, "");
        if (cleaned && !/^https?:\/\//i.test(cleaned)) {
            return { success: false, error: "L'URL doit commencer par http:// ou https://" };
        }
        const existing = await readConfig();
        const config = { ...existing, ffApiBaseUrl: cleaned || undefined } as DbConfig;
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
        // Sans cela, l'ancienne URL resterait servie jusqu'à 30 s après la sauvegarde.
        const { resetFfApiBaseCache } = await import("@/lib/api-ff-client");
        resetFfApiBaseCache();
        console.log(`[Settings] FF API base URL saved: ${cleaned || "(défaut)"}`);
        return { success: true };
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("[Settings] Failed to save FF API config:", msg);
        return { success: false, error: msg };
    }
}

/**
 * Teste l'API FF Nancy et renvoie un diagnostic **exploitable**.
 *
 * L'ancien panneau se contentait d'un « HTTP 503 » opaque : impossible de savoir
 * si l'hôte était injoignable, l'URL erronée ou le service en panne. On distingue
 * donc ici l'échec réseau (DNS, refus de connexion, délai dépassé) du code HTTP.
 */
export async function testFfApiConnection(ffApiBaseUrl?: string) {
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

export async function getSavedDatabaseConfig(): Promise<DbConfig | null> {
    try {
        if (!(await fs.stat(CONFIG_FILE).catch(() => null))) {
            console.log(`[Settings] Config file not found at ${CONFIG_FILE}`);
            return null;
        }
        const data = await fs.readFile(CONFIG_FILE, "utf-8");
        const config = JSON.parse(data);
        console.log(`[Settings] Config read from ${CONFIG_FILE}. Key present: ${!!config.openRouterKey}, Model: ${config.openRouterModel || "default"}`);
        return config;
    } catch (error) {
        console.error(`[Settings] Error reading config from ${CONFIG_FILE}:`, error);
        return null;
    }
}
