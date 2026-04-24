import { PublicitesClient } from "./client";

export interface Publicite {
    tcr_code: string;
    intitule: string;
    date_debut: string;
    date_fin: string;
    datecalcul?: string;
    site: string;
    statut?: string;
    ca_pub_periode_pub: number;
    qte_vendue_pub: number;
    ca_total_periode_pub: number;
    pourc_capub_catotal: number;
    client_pub_periode: number;
    client_total_periode: number;
    stock_datedebut?: number;
    stock_datefin?: number;
    ca_pub_30_jours?: number;
    ca_pub_60_jours?: number;
    ca_pub_90_jours?: number;
    ca_pub_180_jours?: number;
    ca_depuis_finpub?: number;
    taux_sortie: number;
    marge: number;
    taux_marge: number;
    nb_articles: number;
}

export interface PubliciteHistorique {
    tcr_code: string;
    intitule: string;
    date_debut: string;
    date_fin: string;
    statut: string;
    nb_sites: number;
    ca_total: number;
    qte_totale: number;
}

const FF_API_BASE = process.env.FF_API_BASE_URL ?? "https://api.ffnancy.fr";
const PAGE_SIZE = 50;

async function fetchPublicites(statut: string, page: number): Promise<{
    data: Publicite[];
    total: number;
    pages: number;
    error?: string;
}> {
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (statut && statut !== "toutes") params.set("statut", statut);
    try {
        const res = await fetch(`${FF_API_BASE}/api/publicites?${params}`, { cache: "no-store" });
        if (!res.ok) return { data: [], total: 0, pages: 0, error: `Erreur API: ${res.status} ${res.statusText}` };
        const json = await res.json();
        return {
            data: (json.publicites ?? []) as Publicite[],
            total: Number(json.total ?? 0),
            pages: Number(json.pages ?? 0),
        };
    } catch (e: unknown) {
        return { data: [], total: 0, pages: 0, error: `Impossible de joindre l'API: ${e instanceof Error ? e.message : String(e)}` };
    }
}

async function fetchHistorique(): Promise<{ data: PubliciteHistorique[]; error?: string }> {
    try {
        const res = await fetch(`${FF_API_BASE}/api/publicites/historique`, { cache: "no-store" });
        if (!res.ok) return { data: [], error: `Erreur historique: ${res.status}` };
        const json = await res.json();
        return { data: (json.publicites ?? []) as PubliciteHistorique[] };
    } catch (e: unknown) {
        return { data: [], error: `Impossible de joindre l'API: ${e instanceof Error ? e.message : String(e)}` };
    }
}

export default async function PublicitesPage(props: {
    searchParams: Promise<Record<string, string | string[]>>;
}) {
    const searchParams = await props.searchParams;
    const vue    = String(searchParams.vue    ?? "publicites");
    const statut = String(searchParams.statut ?? "toutes");
    const page   = Math.max(1, Number(searchParams.page) || 1);

    const [pubResult, histoResult] = await Promise.all([
        fetchPublicites(statut, page),
        fetchHistorique(),
    ]);

    const error = pubResult.error ?? histoResult.error;

    return (
        <div className="min-h-screen bg-gray-50 p-6">
            <div className="mx-auto max-w-screen-xl">
                <h1 className="mb-6 text-3xl font-bold text-gray-900">Publicités</h1>
                {error && (
                    <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
                        {error}
                    </div>
                )}
                <PublicitesClient
                    vue={vue}
                    statut={statut}
                    page={page}
                    publicites={pubResult.data}
                    total={pubResult.total}
                    pages={pubResult.pages}
                    historique={histoResult.data}
                />
            </div>
        </div>
    );
}
