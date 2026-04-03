export default function ExportsLoading() {
    return (
        <div className="flex flex-col gap-6 animate-pulse">
            {/* Header */}
            <div className="h-7 w-56 rounded-lg bg-[var(--bg-elevated)]" />

            {/* Table */}
            <div className="rounded-2xl border border-[var(--border)] overflow-hidden bg-[var(--bg-elevated)]">
                <div className="h-10 bg-[var(--bg-base)] border-b border-[var(--border)]" />
                {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="h-10 border-b border-[var(--border)] flex items-center px-4 gap-4">
                        <div className="h-3 w-24 rounded bg-[var(--border)]" />
                        <div className="h-3 w-32 rounded bg-[var(--border)]" />
                        <div className="h-3 w-20 rounded bg-[var(--border)]" />
                        <div className="h-3 w-16 rounded bg-[var(--border)]" />
                    </div>
                ))}
            </div>
        </div>
    );
}
