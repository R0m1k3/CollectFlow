export default function SnapshotsLoading() {
    return (
        <div className="flex flex-col gap-6 animate-pulse">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="h-7 w-36 rounded-lg bg-[var(--bg-elevated)]" />
                <div className="h-9 w-36 rounded-lg bg-[var(--bg-elevated)]" />
            </div>

            {/* Cards grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="h-36 rounded-2xl bg-[var(--bg-elevated)] border border-[var(--border)]" />
                ))}
            </div>
        </div>
    );
}
