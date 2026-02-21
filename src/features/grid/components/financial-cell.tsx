"use client";

interface FinancialCellProps {
    totalCa: number;
    totalMarge: number;
    tauxMarge: number;
}


export function FinancialCell({ totalCa, totalMarge, tauxMarge }: FinancialCellProps) {
    const isHighMargin = tauxMarge >= 45;
    const isMedMargin = tauxMarge >= 20 && tauxMarge < 45;

    let textAccent = "var(--accent-error)";
    let bgAccent = "var(--accent-error-bg)";

    if (isHighMargin) {
        textAccent = "var(--accent-success)";
        bgAccent = "var(--accent-success-bg)";
    } else if (isMedMargin) {
        textAccent = "var(--accent-warning)";
        bgAccent = "var(--accent-warning-bg)";
    }

    return (
        <div
            className="flex flex-col items-center justify-center rounded-lg py-1 shadow-sm w-full max-w-[130px] mx-auto transition-colors border-apple"
            style={{
                background: bgAccent,
                borderColor: "transparent"
            }}
        >
            <span
                className="font-mono-nums text-[13px] font-bold whitespace-nowrap"
                style={{ color: textAccent }}
            >
                {totalCa.toLocaleString("fr-FR", { maximumFractionDigits: 0 })}&nbsp;€
            </span>
            <div className="flex items-center gap-1.5 mt-0.5 opacity-80">
                <span
                    className="font-mono-nums text-[10px] px-1 py-0.5 rounded font-bold whitespace-nowrap bg-white/20 dark:bg-black/20"
                    style={{ color: textAccent }}
                >
                    {tauxMarge.toFixed(1)}%
                </span>
                <span className="font-mono-nums text-[10px] font-semibold text-slate-500 dark:text-slate-400 whitespace-nowrap">
                    {totalMarge.toLocaleString("fr-FR", { maximumFractionDigits: 0 })}&nbsp;€
                </span>
            </div>
        </div>
    );
}
