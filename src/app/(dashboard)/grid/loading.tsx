export default function GridLoading() {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
            <div
                className="flex flex-col items-center gap-5 px-10 py-8 rounded-2xl shadow-2xl border"
                style={{
                    background: "var(--bg-elevated)",
                    borderColor: "var(--border)",
                }}
            >
                {/* Spinner */}
                <div className="relative w-12 h-12">
                    <div
                        className="absolute inset-0 rounded-full border-[3px] animate-spin"
                        style={{
                            borderColor: "var(--border)",
                            borderTopColor: "var(--accent)",
                        }}
                    />
                </div>

                <div className="flex flex-col items-center gap-1.5">
                    <span
                        className="text-sm font-semibold tracking-wide"
                        style={{ color: "var(--text-primary)" }}
                    >
                        Chargement des données
                    </span>
                    <span
                        className="text-xs"
                        style={{ color: "var(--text-muted)" }}
                    >
                        Récupération des articles et calcul des scores...
                    </span>
                </div>
            </div>
        </div>
    );
}
