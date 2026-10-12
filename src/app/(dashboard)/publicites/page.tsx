import { Megaphone } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { fetchPage } from "@/lib/rpc";
import { usePageData, usePageSearchParams } from "@/lib/page-data";
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

/**
 * Données de la page, lues par le serveur sur l'API FF (réponses gardées
 * 10 minutes, jamais les erreurs) : une API en panne est signalée dans
 * `erreurPublicites` / `erreurHistorique`, pas par une exception.
 */
interface DonneesPublicites {
    publicites: Publicite[];
    total: number;
    pages: number;
    erreurPublicites?: string;
    historique: PubliciteHistorique[];
    erreurHistorique?: string;
    pageSize: number;
}

export default function PublicitesPage() {
    const searchParams = usePageSearchParams();
    const vue    = String(searchParams.vue    ?? "publicites");
    const statut = String(searchParams.statut ?? "toutes");
    const page   = Math.max(1, Number(searchParams.page) || 1);

    const donnees = usePageData(`publicites?${statut}:${page}`, () =>
        fetchPage<DonneesPublicites>("publicites", { statut, page }),
    );

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
                pageSize={donnees.pageSize}
                publicites={donnees.publicites}
                total={donnees.total}
                pages={donnees.pages}
                erreurPublicites={donnees.erreurPublicites}
                historique={donnees.historique}
                erreurHistorique={donnees.erreurHistorique}
            />
        </div>
    );
}
