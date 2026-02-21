"use client";

interface HeatmapCellProps {
    value: number | null;
}

function getHeatmapStyle(value: number | null): { background: string; color: string } {
    if (value === null || value === 0) {
        return { background: "var(--bg-elevated)", color: "var(--text-muted)" };
    }
    const abs = Math.abs(value);
    if (abs > 100) return { background: "rgba(45,212,191,0.22)", color: "var(--accent)" };
    if (abs > 30) return { background: "rgba(45,212,191,0.14)", color: "var(--accent)" };
    if (abs > 10) return { background: "rgba(45,212,191,0.08)", color: "var(--accent)" };
    return { background: "var(--bg-elevated)", color: "var(--text-secondary)" };
}

export function HeatmapCell({ value }: HeatmapCellProps) {
    const style = getHeatmapStyle(value);
    const display = value === null || value === 0 ? "—" : Math.round(Math.abs(value)).toString();

    return (
        <div
            className="rounded text-center text-[12px] tabular-nums px-0.5 py-0.5 font-bold tracking-tighter transition-colors min-h-[24px] flex items-center justify-center font-mono-nums"
            style={style}
            title={value !== null ? `${Math.abs(value).toLocaleString("fr-FR")} unités` : "Aucune vente"}
        >
            {display}
        </div>
    );
}
