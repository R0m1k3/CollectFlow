"use client";

import { useState } from "react";
import { ShoppingCart, CalendarClock } from "lucide-react";
import { CommandesAutoClient } from "./client";
import { CadencierClient } from "./cadencier-client";
import type { PgCommandeAutoRow } from "./page";
import type { CadenceView } from "@/features/commandes-auto/actions";

type TabKey = "propositions" | "cadencier";

export function CommandesAutoTabs({
    rows,
    cadences,
    fournisseurs,
}: {
    rows: PgCommandeAutoRow[];
    cadences: CadenceView[];
    fournisseurs: { code: string; nom: string }[];
}) {
    const [tab, setTab] = useState<TabKey>("propositions");

    const nbACommander = cadences.filter((c) => c.actif && c.statut === "a_commander").length;

    const tabBtn = (key: TabKey, label: string, Icon: typeof ShoppingCart, badge?: number) => (
        <button
            type="button"
            onClick={() => setTab(key)}
            className={[
                "inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors",
                tab === key
                    ? "border-blue-600 text-blue-700"
                    : "border-transparent text-gray-500 hover:text-gray-800",
            ].join(" ")}
        >
            <Icon className="h-4 w-4" />
            {label}
            {badge != null && badge > 0 && (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">
                    {badge}
                </span>
            )}
        </button>
    );

    return (
        <div className="space-y-6">
            <div className="flex gap-2 border-b border-gray-200">
                {tabBtn("propositions", "Propositions", ShoppingCart)}
                {tabBtn("cadencier", "Cadencier / Alertes", CalendarClock, nbACommander)}
            </div>

            {tab === "propositions" ? (
                <CommandesAutoClient rows={rows} />
            ) : (
                <CadencierClient cadences={cadences} fournisseurs={fournisseurs} />
            )}
        </div>
    );
}
