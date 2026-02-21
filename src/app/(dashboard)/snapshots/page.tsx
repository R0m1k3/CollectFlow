export default function SnapshotsPage() {
    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight text-slate-100">Snapshots</h1>
                <p className="text-sm text-slate-400 mt-1">Historique de vos sessions d&apos;arbitrage sauvegardées.</p>
            </div>
            <div className="border border-dashed border-slate-700 rounded-xl p-12 text-center">
                <p className="text-slate-500 text-sm">Aucun snapshot enregistré.</p>
                <p className="text-slate-600 text-xs mt-1">Utilisez le bouton <strong className="text-slate-500">«&nbsp;Valider&nbsp;»</strong> dans la grille pour créer votre premier snapshot.</p>
            </div>
        </div>
    );
}
