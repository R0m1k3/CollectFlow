import { SnapshotList } from "@/features/snapshots/components/snapshot-list";
import { FileDown } from "lucide-react";

export default function ExportsPage() {
    return (
        <div className="space-y-8 max-w-6xl mx-auto px-4 py-6">
            <div className="flex items-start justify-between">
                <div>
                    <div className="flex items-center gap-3 mb-2">
                        <div className="w-10 h-10 rounded-xl bg-[var(--accent-bg)] border border-[var(--accent-border)] flex items-center justify-center">
                            <FileDown className="w-5 h-5 text-[var(--accent)]" />
                        </div>
                        <h1 className="text-2xl font-black tracking-tight text-[var(--text-primary)] uppercase">Historique d&apos;Arbitrage</h1>
                    </div>
                    <p className="text-sm text-[var(--text-secondary)] max-w-xl">
                        Retrouvez ici toutes vos sessions sauvegardées et exports réalisés. Vous pouvez restaurer une session pour reprendre votre travail ou supprimer les anciens enregistrements.
                    </p>
                </div>
            </div>

            <SnapshotList type="export" />
        </div>
    );
}
