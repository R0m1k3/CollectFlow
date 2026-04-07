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

async function fetchPublicites(year: number): Promise<Publicite[]> {
    const dateDebut = `${year}-01-01`;
    const dateFin = `${year}-12-31`;
    const url = `https://api.ffnancy.fr/api/publicites?dateDebut=${dateDebut}&dateFin=${dateFin}&limit=500`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Erreur API publicités: ${res.status}`);
    const data = await res.json();
    return (data.publicites ?? []) as Publicite[];
}

export default async function PublicitesPage(props: {
    searchParams: Promise<Record<string, string | string[]>>;
}) {
    const searchParams = await props.searchParams;
    const currentYear = new Date().getFullYear();
    const year = Number(searchParams.year) || currentYear;

    const publicites = await fetchPublicites(year);

    return (
        <div className="min-h-screen bg-gray-50 p-6">
            <div className="mx-auto max-w-screen-xl">
                <h1 className="mb-6 text-3xl font-bold text-gray-900">Publicités</h1>
                <PublicitesClient year={year} publicites={publicites} />
            </div>
        </div>
    );
}
