import type { Metadata } from "next";
import { History } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { HistoriqueTabs } from "./tabs";

export const metadata: Metadata = { title: "Historique" };

/**
 * Historique des sessions de révision et des exports Excel.
 *
 * Remplace les pages « Snapshots » et « Exports », qui affichaient la même liste
 * filtrée différemment (et dont la seconde s'intitulait « Historique d'arbitrage »).
 * Chacun ne voit que ses propres enregistrements.
 */
export default async function HistoriquePage(props: { searchParams: Promise<{ vue?: string }> }) {
    const { vue } = await props.searchParams;
    return (
        <div className="mx-auto w-full max-w-6xl">
            <PageHeader
                icon={History}
                title="Historique"
                description="Vos sessions de révision enregistrées et vos exports Excel. Rouvrez une session pour reprendre les modifications de gammes là où vous les aviez laissées."
            />
            <HistoriqueTabs initial={vue === "exports" ? "exports" : "sessions"} />
        </div>
    );
}
