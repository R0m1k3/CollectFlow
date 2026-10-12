/**
 * CollectFlow — Appels du navigateur vers le serveur Rust.
 *
 * - `callAction` remplace les anciennes « server actions » Next.js : chaque
 *   fonction garde son nom et sa signature, son corps devient
 *   `POST /api/actions/{nom}` avec le tableau des arguments.
 * - `fetchPage` lit les données qu'une ancienne page serveur calculait avant
 *   rendu : `GET /api/pages/{nom}?…`.
 *
 * Une réponse en erreur (`{ error }`, statut 4xx/5xx) est relevée en `Error`,
 * comme l'exception de l'action serveur l'était. Une session expirée (401)
 * renvoie à la page de connexion, comme le faisait le middleware.
 */

export type ParamsPage = Record<string, string | number | boolean | null | undefined> | URLSearchParams;

/** Redirige vers la connexion (session absente ou expirée). */
function versConnexion(): void {
    if (typeof window !== "undefined" && window.location.pathname !== "/login") {
        window.location.assign("/login");
    }
}

async function lireReponse<T>(res: Response): Promise<T> {
    let body: unknown = null;
    const texte = await res.text();
    if (texte) {
        try {
            body = JSON.parse(texte);
        } catch {
            body = null;
        }
    }
    if (!res.ok) {
        if (res.status === 401) versConnexion();
        const message = (body as { error?: unknown } | null)?.error;
        throw new Error(typeof message === "string" && message ? message : res.statusText || `Erreur HTTP ${res.status}`);
    }
    return body as T;
}

/** Appelle l'action serveur `name` avec ses arguments positionnels. */
export async function callAction<T>(name: string, args: unknown[] = []): Promise<T> {
    // JSON.stringify remplace `undefined` par `null` dans un tableau : on retire
    // les arguments absents en fin de liste pour que le serveur voie « absent ».
    const liste = [...args];
    while (liste.length > 0 && liste[liste.length - 1] === undefined) liste.pop();
    const res = await fetch(`/api/actions/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(liste),
    });
    return lireReponse<T>(res);
}

/** Construit la chaîne de requête d'une page (valeurs vides omises). */
export function queryString(params?: ParamsPage): string {
    if (!params) return "";
    const sp = new URLSearchParams();
    const entrees = params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params);
    for (const [k, v] of entrees) {
        if (v === undefined || v === null || v === "") continue;
        sp.append(k, String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : "";
}

/** Données de la page serveur `name` (cf. `server/PORTING.md`, section Pages). */
export async function fetchPage<T>(name: string, params?: ParamsPage): Promise<T> {
    const res = await fetch(`/api/pages/${encodeURIComponent(name)}${queryString(params)}`, {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
    });
    return lireReponse<T>(res);
}
