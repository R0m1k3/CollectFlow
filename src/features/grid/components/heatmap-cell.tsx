import React from "react";

interface HeatmapCellProps {
    value: number | null;
    tooltipStock?: number | null;
}

function getHeatmapClass(value: number | null): string {
    if (value === null || value === 0) return "heatmap-zero";
    const abs = Math.abs(value);
    if (abs > 100) return "heatmap-high";
    if (abs > 30) return "heatmap-mid";
    if (abs > 10) return "heatmap-low";
    return "heatmap-zero";
}

export const HeatmapCell = React.memo(({ value, tooltipStock }: HeatmapCellProps) => {
    const heatClass = getHeatmapClass(value);
    const display = value === null || value === 0 ? "0" : Math.round(Math.abs(value)).toString();

    const titleParts: string[] = [];
    if (value !== null && value !== 0) titleParts.push(`${Math.abs(value).toLocaleString("fr-FR")} unités`);
    else titleParts.push("Aucune vente");
    if (tooltipStock != null) titleParts.push(`Stock fin de mois : ${tooltipStock.toLocaleString("fr-FR")}`);
    const title = titleParts.join(" · ");

    return (
        <div
            className={`rounded text-center text-[12px] tabular-nums px-0.5 py-0.5 font-bold tracking-tighter transition-colors min-h-[24px] flex items-center justify-center font-mono-nums ${heatClass}`}
            title={title}
        >
            {display}
        </div>
    );
});

HeatmapCell.displayName = "HeatmapCell";
