/**
 * CollectFlow — Capture des logs serveur d'un job, pour téléchargement.
 *
 * POURQUOI. Les extractions Qlik produisent plusieurs milliers de lignes
 * (`[qlik-pw][page] …`, timings, diagnostics du modèle). Or ces lignes ne
 * vivent que dans la sortie standard du conteneur : un terminal les tronque,
 * et un copier-coller ne rapporte que la fin — c'est-à-dire jamais l'entête,
 * là où se trouvent la carte du modèle Qlik et le choix des champs. Sans elle,
 * un diagnostic se fait à l'aveugle.
 *
 * COMMENT. `console.log/warn/error` est instrumenté UNE fois au chargement du
 * module. Tant qu'au moins une capture est ouverte, chaque ligne est recopiée
 * dans les captures ouvertes, puis transmise telle quelle à la console
 * d'origine (rien n'est retenu, rien ne change dans les logs du conteneur).
 *
 * ⚠️ Deux jobs simultanés partagent la sortie standard du process : leurs
 * lignes ne portent pas d'identifiant permettant de les démêler. Chaque
 * capture ouverte reçoit donc TOUTES les lignes de la période — mieux vaut un
 * peu de bruit qu'une ligne manquante dans un journal de diagnostic.
 *
 * Les captures sont écrites sur disque (répertoire temporaire) au fil de l'eau :
 * un job qui fait tomber le process laisse quand même son journal.
 */

import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Répertoire des journaux. Volontairement hors du projet : ce sont des temporaires. */
const LOG_DIR = join(tmpdir(), "collectflow-logs");

/** Au-delà, on arrête d'accumuler : un job en boucle ne doit pas manger la RAM. */
const MAX_LIGNES = 200_000;
/** Une ligne pathologique (dump d'hypercube) est tronquée plutôt que gardée entière. */
const MAX_LONGUEUR_LIGNE = 8_000;
/** Nombre de journaux conservés sur disque. */
const MAX_FICHIERS = 20;
/** Écriture disque au plus toutes les N ms (le journal complet est réécrit). */
const FLUSH_MS = 2_000;

interface Capture {
    id: string;
    lignes: string[];
    tronque: boolean;
    debut: number;
    flushEnCours: boolean;
    flushDemande: boolean;
    dernierFlush: number;
}

const captures = new Map<string, Capture>();

/** Nom de fichier sûr : l'id vient d'un job interne, on le verrouille quand même. */
function fichierPour(id: string): string {
    return join(LOG_DIR, `${id.replace(/[^A-Za-z0-9_.-]/g, "_")}.log`);
}

function horodatage(): string {
    return new Date().toISOString();
}

/** Rend une ligne à partir des arguments variadiques de `console.*`. */
function formater(args: unknown[]): string {
    return args
        .map((a) => {
            if (typeof a === "string") return a;
            if (a instanceof Error) return `${a.message}\n${a.stack ?? ""}`;
            try {
                return JSON.stringify(a);
            } catch {
                return String(a);
            }
        })
        .join(" ");
}

async function flush(capture: Capture): Promise<void> {
    if (capture.flushEnCours) {
        capture.flushDemande = true;
        return;
    }
    capture.flushEnCours = true;
    try {
        await mkdir(LOG_DIR, { recursive: true });
        await writeFile(fichierPour(capture.id), capture.lignes.join("\n") + "\n", "utf8");
        capture.dernierFlush = Date.now();
    } catch {
        // Un journal de diagnostic ne doit jamais faire échouer le job qu'il observe.
    } finally {
        capture.flushEnCours = false;
        if (capture.flushDemande) {
            capture.flushDemande = false;
            void flush(capture);
        }
    }
}

function ajouter(ligne: string): void {
    if (captures.size === 0) return;
    const texte = ligne.length > MAX_LONGUEUR_LIGNE
        ? ligne.slice(0, MAX_LONGUEUR_LIGNE) + " …[ligne tronquée]"
        : ligne;
    const prefixe = `[${horodatage()}] `;
    for (const capture of captures.values()) {
        if (capture.lignes.length >= MAX_LIGNES) {
            if (!capture.tronque) {
                capture.tronque = true;
                capture.lignes.push(`${prefixe}[log-capture] limite de ${MAX_LIGNES} lignes atteinte — suite non enregistrée`);
            }
            continue;
        }
        capture.lignes.push(prefixe + texte);
        if (Date.now() - capture.dernierFlush >= FLUSH_MS) void flush(capture);
    }
}

/**
 * Instrumente `console` une seule fois, même en développement où le module peut
 * être réévalué à chaud (le drapeau est porté par `globalThis`).
 */
function instrumenterConsole(): void {
    const g = globalThis as typeof globalThis & { __cfLogCaptureInstalle?: boolean };
    if (g.__cfLogCaptureInstalle) return;
    g.__cfLogCaptureInstalle = true;

    const methodes = ["log", "warn", "error", "info"] as const;
    for (const methode of methodes) {
        const origine = console[methode].bind(console);
        console[methode] = (...args: unknown[]) => {
            try {
                ajouter(formater(args));
            } catch {
                // idem : jamais au détriment du log réel
            }
            origine(...args);
        };
    }
}

instrumenterConsole();

/** Supprime les journaux les plus anciens au-delà de `MAX_FICHIERS`. */
async function purger(): Promise<void> {
    try {
        const noms = (await readdir(LOG_DIR)).filter((n) => n.endsWith(".log"));
        if (noms.length <= MAX_FICHIERS) return;
        const avecDate = await Promise.all(
            noms.map(async (nom) => {
                const s = await stat(join(LOG_DIR, nom)).catch(() => null);
                return { nom, mtime: s?.mtimeMs ?? 0 };
            }),
        );
        avecDate.sort((a, b) => b.mtime - a.mtime);
        for (const { nom } of avecDate.slice(MAX_FICHIERS)) {
            await unlink(join(LOG_DIR, nom)).catch(() => undefined);
        }
    } catch {
        // purge best-effort
    }
}

/**
 * Ouvre une capture. Toutes les lignes écrites sur la console à partir de
 * maintenant (par n'importe quel code du process, cf. avertissement en tête)
 * y sont recopiées jusqu'à `stopCapture`.
 */
export function startCapture(id: string, entete?: string): void {
    const capture: Capture = {
        id,
        lignes: [],
        tronque: false,
        debut: Date.now(),
        flushEnCours: false,
        flushDemande: false,
        dernierFlush: 0,
    };
    captures.set(id, capture);
    capture.lignes.push(`[${horodatage()}] [log-capture] début de capture ${id}`);
    if (entete) capture.lignes.push(`[${horodatage()}] [log-capture] ${entete}`);
    void flush(capture);
    void purger();
}

/** Ferme la capture et écrit son état final sur disque. */
export async function stopCapture(id: string, pied?: string): Promise<void> {
    const capture = captures.get(id);
    if (!capture) return;
    const duree = Math.round((Date.now() - capture.debut) / 1000);
    capture.lignes.push(`[${horodatage()}] [log-capture] fin de capture ${id} — ${capture.lignes.length} lignes, ${duree} s`);
    if (pied) capture.lignes.push(`[${horodatage()}] [log-capture] ${pied}`);
    captures.delete(id);
    await flush(capture);
}

/**
 * Contenu d'un journal : la capture en cours si elle est ouverte, sinon le
 * fichier laissé sur disque. `null` si aucun des deux n'existe.
 */
export async function readCapture(id: string): Promise<string | null> {
    const capture = captures.get(id);
    if (capture) return capture.lignes.join("\n") + "\n";
    try {
        return await readFile(fichierPour(id), "utf8");
    } catch {
        return null;
    }
}

/** Journaux disponibles, du plus récent au plus ancien. */
export async function listCaptures(): Promise<Array<{ id: string; octets: number; modifieLe: string; enCours: boolean }>> {
    const resultats: Array<{ id: string; octets: number; modifieLe: string; enCours: boolean }> = [];
    try {
        for (const nom of await readdir(LOG_DIR)) {
            if (!nom.endsWith(".log")) continue;
            const s = await stat(join(LOG_DIR, nom)).catch(() => null);
            if (!s) continue;
            const id = nom.slice(0, -4);
            resultats.push({
                id,
                octets: s.size,
                modifieLe: new Date(s.mtimeMs).toISOString(),
                enCours: captures.has(id),
            });
        }
    } catch {
        // répertoire pas encore créé
    }
    return resultats.sort((a, b) => b.modifieLe.localeCompare(a.modifieLe));
}
