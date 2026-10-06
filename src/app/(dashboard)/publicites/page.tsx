import type { Metadata } from "next";
import { Megaphone } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { PublicitesClient } from "./client";
import { cachedFF } from "@/lib/ff-cache";

export const metadata: Metadata = { title: "Publicités" };

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
/** Délai maximal d'un appel à l'API FF : sans lui, une API muette figeait la page. */
const FF_API_TIMEOUT_MS = 15_000;
/**
 * Réponses de l'API gardées 10 minutes (les erreurs ne le sont jamais) : la liste
 * et l'historique étaient re-téléchargés à chaque clic sur un filtre ou une page.
 */
const PUB_CACHE_TTL_MS = 10 * 60 * 1000;

type PublicitesResult = { data: Publicite[]; total: number; pages: number; error?: string };

function fetchPublicites(statut: string, page: number): Promise<PublicitesResult> {
    return cachedFF(`publicites:${statut}:${page}`, () => fetchPublicitesApi(statut, page), {
        ttlMs: PUB_CACHE_TTL_MS,
        cacheIf: (r) => !r.error,
    });
}

async function fetchPublicitesApi(statut: string, page: number): Promise<PublicitesResult> {
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (statut && statut !== "toutes") params.set("statut", statut);
    try {
        const res = await fetch(`${FF_API_BASE}/api/publicites?${params}`, {
            cache: "no-store",
            signal: AbortSignal.timeout(FF_API_TIMEOUT_MS),
        });
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

type HistoriqueResult = { data: PubliciteHistorique[]; error?: string };

function fetchHistorique(): Promise<HistoriqueResult> {
    return cachedFF("publicites-historique", fetchHistoriqueApi, {
        ttlMs: PUB_CACHE_TTL_MS,
        cacheIf: (r) => !r.error,
    });
}

async function fetchHistoriqueApi(): Promise<HistoriqueResult> {
    try {
        const res = await fetch(`${FF_API_BASE}/api/publicites/historique`, {
            cache: "no-store",
            signal: AbortSignal.timeout(FF_API_TIMEOUT_MS),
        });
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

    return (
        <div className="w-full min-w-0">
            <PageHeader
                icon={Megaphone}
                title="Publicités"
                description="Résultats des opérations publicitaires (en cours, passées, à venir) et leur poids dans les ventes de vos magasins."
            />
            <PublicitesClient
                vueInitiale={vue === "historique" ? "historique" : "publicites"}
                statut={statut}
                page={page}
                pageSize={PAGE_SIZE}
                publicites={pubResult.data}
                total={pubResult.total}
                pages={pubResult.pages}
                erreurPublicites={pubResult.error}
                historique={histoResult.data}
                erreurHistorique={histoResult.error}
            />
        </div>
    );
}
