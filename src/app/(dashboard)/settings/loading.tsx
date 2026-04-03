export default function SettingsLoading() {
    return (
        <div className="flex flex-col gap-6 animate-pulse max-w-2xl">
            {/* Header */}
            <div className="h-7 w-40 rounded-lg bg-[var(--bg-elevated)]" />

            {/* Settings sections */}
            {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="rounded-2xl border border-[var(--border)] overflow-hidden bg-[var(--bg-elevated)] p-6 flex flex-col gap-4">
                    <div className="h-5 w-36 rounded bg-[var(--border)]" />
                    <div className="h-10 rounded-lg bg-[var(--bg-base)]" />
                    <div className="h-10 rounded-lg bg-[var(--bg-base)]" />
                </div>
            ))}
        </div>
    );
}
