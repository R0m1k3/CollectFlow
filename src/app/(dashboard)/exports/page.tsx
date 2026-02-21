export default function ExportsPage() {
    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight text-slate-100">Exports</h1>
                <p className="text-sm text-slate-400 mt-1">Génération des fichiers Excel différentiels pour l&apos;ERP.</p>
            </div>
            <div className="border border-dashed border-slate-700 rounded-xl p-12 text-center">
                <p className="text-slate-500 text-sm">Sélectionnez un fournisseur dans la grille, puis cliquez sur <strong className="text-slate-400">«&nbsp;Exporter&nbsp;»</strong>.</p>
                <p className="text-slate-600 text-xs mt-1">L&apos;export génère un fichier <code className="text-slate-500">.xlsx</code> avec le delta avant/après des gammes révisées.</p>
            </div>
        </div>
    );
}
