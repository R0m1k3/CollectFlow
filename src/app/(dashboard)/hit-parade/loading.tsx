export default function HitParadeLoading() {
    return (
        <div className="flex flex-col gap-6 animate-pulse">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="h-7 w-44 rounded-lg bg-[var(--bg-elevated)]" />
                <div className="flex gap-2">
                    <div className="h-9 w-28 rounded-lg bg-[var(--bg-elevated)]" />
                    <div className="h-9 w-28 rounded-lg bg-[var(--bg-elevated)]" />
                </div>
            </div>

            {/* Podium / top cards */}
            <div className="grid grid-cols-3 gap-4">
                {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-32 rounded-2xl bg-[var(--bg-elevated)] border border-[var(--border)]" />
                ))}
            </div>

            {/* Rankings table */}
            <div className="rounded-2xl border border-[var(--border)] overflow-hidden bg-[var(--bg-elevated)]">
                <div className="h-10 bg-[var(--bg-base)] border-b border-[var(--border)]" />
                {Array.from({ length: 10 }).map((_, i) => (
                    <div key={i} className="h-10 border-b border-[var(--border)] flex items-center px-4 gap-4">
                        <div className="h-3 w-6 rounded bg-[var(--border)]" />
                        <div className="h-3 w-40 rounded bg-[var(--border)]" />
                        <div className="h-3 w-24 rounded bg-[var(--border)]" />
                        <div className="h-3 w-16 rounded bg-[var(--border)]" />
                    </div>
                ))}
            </div>
        </div>
    );
}
