"use client";

interface HeatmapCellProps {
    value: number | null;
}

function getHeatmapClass(value: number | null): string {
    if (value === null || value === 0) return "heatmap-zero";
    const abs = Math.abs(value);
    if (abs > 100) return "heatmap-high";
    if (abs > 30) return "heatmap-mid";
    if (abs > 10) return "heatmap-low";
    return "heatmap-zero";
}

export function HeatmapCell({ value }: HeatmapCellProps) {
    const heatClass = getHeatmapClass(value);
    const display = value === null || value === 0 ? "—" : Math.round(Math.abs(value)).toString();

    return (
        <div
            className={`rounded text-center text-[12px] tabular-nums px-0.5 py-0.5 font-bold tracking-tighter transition-colors min-h-[24px] flex items-center justify-center font-mono-nums ${heatClass}`}
            title={value !== null ? `${Math.abs(value).toLocaleString("fr-FR")} unités` : "Aucune vente"}
        >
            {display}
        </div>
    );
}
