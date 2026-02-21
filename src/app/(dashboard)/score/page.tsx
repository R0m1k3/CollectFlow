"use client";

import { BarChart3, ArrowRight, TrendingUp, Award, Layers } from "lucide-react";
import Link from "next/link";

function InfoCard({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) {
    return (
        <div
            className="rounded-[14px] overflow-hidden"
            style={{ border: "1px solid var(--border)", boxShadow: "var(--shadow-sm)" }}
        >
            <div className="px-5 py-4 flex items-center gap-2.5" style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-elevated)" }}>
                <Icon className="w-4 h-4" style={{ color: "var(--accent)" }} strokeWidth={2} />
                <h2 className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>{title}</h2>
            </div>
            <div className="px-5 py-5" style={{ background: "var(--bg-surface)" }}>
                {children}
            </div>
        </div>
    );
}

function FormulaStep({ step, title, formula }: { step: number; title: string; formula: string }) {
    return (
        <div className="flex items-start gap-3">
            <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0 mt-0.5"
                style={{ background: "var(--accent-bg)", color: "var(--accent)", border: "1px solid var(--accent-border)" }}
            >
                {step}
            </div>
            <div>
                <p className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>{title}</p>
                <code className="text-[12px] mt-1 block px-3 py-2 rounded-[8px] font-mono" style={{ background: "var(--bg-elevated)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}>
                    {formula}
                </code>
            </div>
        </div>
    );
}

function ScoreBadge({ value, label }: { value: string; label: string }) {
    const num = parseFloat(value);
    const color = num >= 80 ? "text-emerald-500" : num >= 50 ? "text-amber-500" : "text-rose-500";
    const bg = num >= 80 ? "rgba(16, 185, 129, 0.1)" : num >= 50 ? "rgba(245, 158, 11, 0.1)" : "rgba(244, 63, 94, 0.1)";
    const borderColor = num >= 80 ? "rgba(16, 185, 129, 0.2)" : num >= 50 ? "rgba(245, 158, 11, 0.2)" : "rgba(244, 63, 94, 0.2)";

    return (
        <div className="text-center">
            <div
                className={`text-[18px] font-black ${color} inline-flex items-center justify-center w-12 h-12 rounded-[10px]`}
                style={{ background: bg, border: `1px solid ${borderColor}` }}
            >
                {value}
            </div>
            <p className="text-[11px] mt-1.5 font-medium" style={{ color: "var(--text-muted)" }}>{label}</p>
        </div>
    );
}

export default function ScorePage() {
    return (
        <div className="p-6 space-y-6 max-w-2xl overflow-y-auto h-full">
            <div>
                <h1 className="text-[22px] font-bold tracking-[-0.4px]" style={{ color: "var(--text-primary)" }}>
                    Score Produit
                </h1>
                <p className="text-[13px] mt-1" style={{ color: "var(--text-secondary)" }}>
                    Comprenez comment chaque produit est évalué pour le référencement.
                </p>
            </div>

            {/* Principe fondamental */}
            <InfoCard icon={Award} title="Principe fondamental">
                <div
                    className="rounded-[10px] px-4 py-3"
                    style={{ background: "var(--accent-bg)", border: "1px solid var(--accent-border)" }}
                >
                    <p className="text-[13px] font-medium" style={{ color: "var(--accent)" }}>
                        Un produit excellent sur <strong>une seule dimension</strong> suffit à en faire un bon produit.
                    </p>
                    <p className="text-[12px] mt-1" style={{ color: "var(--text-secondary)" }}>
                        Un produit qui fait 30% du volume du fournisseur est un bon produit même si sa marge est faible.
                    </p>
                </div>
            </InfoCard>

            {/* Les 3 axes */}
            <InfoCard icon={Layers} title="Les 3 axes d'évaluation">
                <div className="space-y-3">
                    <p className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
                        Chaque produit est évalué sur son <strong>poids relatif par rapport au meilleur produit</strong> :
                    </p>
                    <div className="grid grid-cols-3 gap-3">
                        {[
                            { label: "Quantité", desc: "Volume vendu", icon: "📦" },
                            { label: "Chiffre d'Affaires", desc: "Montant total", icon: "💰" },
                            { label: "Marge", desc: "Profit généré", icon: "📈" },
                        ].map(({ label, desc, icon }) => (
                            <div
                                key={label}
                                className="px-3 py-3 rounded-[10px] text-center"
                                style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}
                            >
                                <div className="text-lg">{icon}</div>
                                <p className="text-[12px] font-semibold mt-1" style={{ color: "var(--text-primary)" }}>{label}</p>
                                <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>{desc}</p>
                            </div>
                        ))}
                    </div>
                    <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                        Poids = (métrique du produit ÷ métrique du Produit N°1) × 100
                    </p>
                </div>
            </InfoCard>

            {/* Formule */}
            <InfoCard icon={TrendingUp} title="Formule de calcul">
                <div className="space-y-4">
                    <FormulaStep
                        step={1}
                        title="Calculer les 3 scores de base (indexés sur le TOP 100)"
                        formula="score_axe = produit.métrique / top1_fournisseur × 100"
                    />
                    <FormulaStep
                        step={2}
                        title="Prendre le meilleur axe (MAX)"
                        formula="base = MAX(poids_qty, poids_ca, poids_marge)"
                    />
                    <FormulaStep
                        step={3}
                        title="Ajouter le bonus polyvalence"
                        formula="bonus = nb_axes_forts × bonus_par_axe"
                    />
                    <FormulaStep
                        step={4}
                        title="Score final"
                        formula="score = MIN(base + bonus, 100)"
                    />
                    <div
                        className="rounded-[10px] px-4 py-3 mt-2"
                        style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}
                    >
                        <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                            <strong>Axe fort</strong> = un axe dont le poids dépasse le seuil (configurable dans Paramètres).
                            Un produit peut obtenir un bonus s&apos;il excelle sur 2 ou 3 axes à la fois.
                        </p>
                    </div>
                </div>
            </InfoCard>

            {/* Signification des couleurs */}
            <InfoCard icon={BarChart3} title="Lecture du score">
                <div className="flex items-center justify-center gap-6 py-2">
                    <ScoreBadge value="85" label="Excellent" />
                    <ScoreBadge value="55" label="Correct" />
                    <ScoreBadge value="12" label="Faible" />
                </div>
                <div className="space-y-2 mt-4">
                    <div className="flex items-center gap-2">
                        <div className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                        <p className="text-[12px]" style={{ color: "var(--text-secondary)" }}><strong>≥ 80</strong> — Produit stratégique, très forte contribution</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                        <p className="text-[12px]" style={{ color: "var(--text-secondary)" }}><strong>50 – 79</strong> — Contribution significative, à conserver</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="w-2.5 h-2.5 rounded-full bg-rose-500" />
                        <p className="text-[12px]" style={{ color: "var(--text-secondary)" }}><strong>&lt; 50</strong> — Contribution faible, à réévaluer</p>
                    </div>
                </div>
            </InfoCard>

            {/* Lien vers les paramètres */}
            <Link
                href="/settings"
                className="flex items-center gap-2 px-4 py-3 rounded-[10px] transition-all hover:gap-3"
                style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--accent)" }}
            >
                <span className="text-[13px] font-medium">Ajuster les paramètres du score</span>
                <ArrowRight className="w-4 h-4 ml-auto" />
            </Link>
        </div>
    );
}
