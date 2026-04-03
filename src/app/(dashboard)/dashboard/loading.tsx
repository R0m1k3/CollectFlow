export default function DashboardLoading() {
    return (
        <div className="flex flex-col gap-6 animate-pulse">
            {/* Header skeleton */}
            <div className="flex items-center justify-between">
                <div className="h-7 w-48 rounded-lg bg-[var(--bg-elevated)]" />
                <div className="h-5 w-32 rounded-lg bg-[var(--bg-elevated)]" />
            </div>

            {/* KPI cards row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-28 rounded-2xl bg-[var(--bg-elevated)] border border-[var(--border)]" />
                ))}
            </div>

            {/* Main content area */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="h-64 rounded-2xl bg-[var(--bg-elevated)] border border-[var(--border)]" />
                <div className="h-64 rounded-2xl bg-[var(--bg-elevated)] border border-[var(--border)]" />
            </div>

            {/* Bottom tables */}
            <div className="h-80 rounded-2xl bg-[var(--bg-elevated)] border border-[var(--border)]" />
        </div>
    );
}
