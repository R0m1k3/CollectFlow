"use client";

import { FileDown, Save } from "lucide-react";
import { Tabs, useUrlTab } from "@/components/ui/tabs";
import { SnapshotList } from "@/features/snapshots/components/snapshot-list";

type Vue = "sessions" | "exports";

const ONGLETS = [
    { value: "sessions", label: "Sessions enregistrées", icon: Save },
    { value: "exports", label: "Exports Excel", icon: FileDown },
] as const;

export function HistoriqueTabs({ initial }: { initial: Vue }) {
    const [vue, setVue] = useUrlTab<Vue>("vue", initial);
    return (
        <div className="space-y-5">
            <Tabs items={ONGLETS} value={vue} onChange={setVue} />
            {/* `key` : chaque onglet recharge sa propre liste. */}
            <SnapshotList key={vue} type={vue === "exports" ? "export" : "snapshot"} />
        </div>
    );
}
