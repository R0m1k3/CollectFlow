import { SnapshotList } from "@/features/snapshots/components/snapshot-list";
import { Camera } from "lucide-react";

export default function SnapshotsPage() {
    return (
        <div className="space-y-8 max-w-6xl mx-auto px-4 py-6">
            <div className="flex items-start justify-between">
                <div>
                    <div className="flex items-center gap-3 mb-2">
                        <div className="w-10 h-10 rounded-xl bg-[var(--accent-bg)] border border-[var(--accent-border)] flex items-center justify-center">
                            <Camera className="w-5 h-5 text-[var(--accent)]" />
                        </div>
                        <h1 className="text-2xl font-black tracking-tight text-[var(--text-primary)] uppercase">Snapshots</h1>
                    </div>
                    <p className="text-sm text-[var(--text-secondary)] max-w-xl">
                        Historique de vos sessions d&apos;arbitrage. Restaurez une sauvegarde pour retrouver vos modifications en cours sur une gamme spécifique.
                    </p>
                </div>
            </div>

            <SnapshotList type="snapshot" />
        </div>
    );
}
