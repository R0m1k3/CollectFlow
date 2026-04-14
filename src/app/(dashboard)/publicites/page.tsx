import { PublicitesClient } from "./client";

export interface Publicite {
    tcr_code: string;
    intitule: string;
    date_debut: string;
    date_fin: string;
    site: string;
    ca_pub_periode_pub: number;
    qte_vendue_pub: number;
    ca_total_periode_pub: number;
    pourc_capub_catotal: number;
    client_pub_periode: number;
    client_total_periode: number;
    taux_sortie: number;
    marge: number;
    taux_marge: number;
    nb_articles: number;
}

async function fetchPublicites(year: number): Promise<{ data: Publicite[]; error?: string }> {
    const dateDebut = `${year}-01-01`;
    const dateFin = `${year}-12-31`;
    const url = `https://api.ffnancy.fr/api/publicites?dateDebut=${dateDebut}&dateFin=${dateFin}&limit=500`;
    try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return { data: [], error: `Erreur API: ${res.status} ${res.statusText}` };
        const json = await res.json();
        return { data: (json.publicites ?? []) as Publicite[] };
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { data: [], error: `Impossible de joindre l'API: ${msg}` };
    }
}

export default async function PublicitesPage(props: {
    searchParams: Promise<Record<string, string | string[]>>;
}) {
    const searchParams = await props.searchParams;
    const currentYear = new Date().getFullYear();
    const year = Number(searchParams.year) || currentYear;

    const { data: publicites, error } = await fetchPublicites(year);

    return (
        <div className="min-h-screen bg-gray-50 p-6">
            <div className="mx-auto max-w-screen-xl">
                <h1 className="mb-6 text-3xl font-bold text-gray-900">Publicités</h1>
                {error && (
                    <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
                        {error}
                    </div>
                )}
                <PublicitesClient year={year} publicites={publicites} />
            </div>
        </div>
    );
}
