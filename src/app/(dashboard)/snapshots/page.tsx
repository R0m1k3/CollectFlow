import { SnapshotList } from "@/features/snapshots/components/snapshot-list";
import { Camera } from "lucide-react";

export default function SnapshotsPage() {
    return (
        <div className="space-y-8 max-w-6xl mx-auto px-4 py-6">
            <div className="flex items-start justify-between">
                <div>
                    <div className="flex items-center gap-3 mb-2">
                        <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
                            <Camera className="w-5 h-5 text-indigo-400" />
                        </div>
                        <h1 className="text-3xl font-black tracking-tight text-slate-100 italic uppercase">Snapshots</h1>
                    </div>
                    <p className="text-sm text-slate-400 max-w-xl">
                        Historique de vos sessions d&apos;arbitrage. Restaurez une sauvegarde pour retrouver vos modifications en cours sur une gamme spécifique.
                    </p>
                </div>
            </div>

            <SnapshotList />
        </div>
    );
}
