"use client";

import { ShoppingCart, CalendarClock } from "lucide-react";
import { Tabs, useUrlTab } from "@/components/ui/tabs";
import { CommandesAutoClient } from "./client";
import { CadencierClient } from "./cadencier-client";
import type { PgCommandeAutoRow } from "./page";
import type { CadenceView } from "@/features/commandes-auto/actions";

export type Onglet = "propositions" | "cadencier";

export function CommandesAutoTabs({
    initial,
    rows,
    cadences,
    fournisseurs,
}: {
    initial: Onglet;
    rows: PgCommandeAutoRow[];
    cadences: CadenceView[];
    fournisseurs: { code: string; nom: string }[];
}) {
    const [onglet, setOnglet] = useUrlTab<Onglet>("onglet", initial);

    const nbACommander = cadences.filter((c) => c.actif && c.statut === "a_commander").length;

    const onglets = [
        { value: "propositions", label: "Propositions de commande", icon: ShoppingCart },
        {
            value: "cadencier",
            label: (
                <>
                    Rythme de commande
                    {nbACommander > 0 && <span className="sr-only"> (commandes à passer)</span>}
                </>
            ),
            icon: CalendarClock,
            // Pastille rouge : nombre de commandes à passer (masquée s'il n'y en a aucune).
            count: nbACommander > 0 ? nbACommander : undefined,
            alert: true,
        },
    ] as const;

    return (
        <div className="space-y-6">
            <Tabs items={onglets} value={onglet} onChange={setOnglet} />

            {onglet === "propositions" ? (
                <CommandesAutoClient rows={rows} />
            ) : (
                <CadencierClient cadences={cadences} fournisseurs={fournisseurs} />
            )}
        </div>
    );
}
