interface LoadingModalProps {
    message?: string;
    subMessage?: string;
}

export default function LoadingModal({
    message = "Chargement des données",
    subMessage = "Veuillez patienter...",
}: LoadingModalProps) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
            <div
                className="flex flex-col items-center gap-5 px-10 py-8 rounded-2xl shadow-2xl border"
                style={{
                    background: "var(--bg-elevated)",
                    borderColor: "var(--border)",
                }}
            >
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
                        {message}
                    </span>
                    <span
                        className="text-xs"
                        style={{ color: "var(--text-muted)" }}
                    >
                        {subMessage}
                    </span>
                </div>
            </div>
        </div>
    );
}
