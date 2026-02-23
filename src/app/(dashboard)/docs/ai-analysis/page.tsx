"use client";

import { Bot, TrendingUp, Calendar, Zap, AlertTriangle, ShieldCheck, Scale, Info } from "lucide-react";
import { cn } from "@/lib/utils";

export default function AiAnalysisDocPage() {
    return (
        <div className="max-w-5xl mx-auto py-10 px-6 space-y-12">
            {/* Header */}
            <header className="space-y-4">
                <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-[var(--accent)] flex items-center justify-center shadow-lg shadow-brand-500/20">
                        <Bot className="w-7 h-7 text-white" />
                    </div>
                    <div>
                        <h1 className="text-3xl font-black tracking-tight text-[var(--text-primary)]">
                            Intelligence Artificielle Copilot
                        </h1>
                        <p className="text-[var(--text-secondary)] font-medium">
                            Comprendre les algorithmes et règles métiers de notre assistant d'achat.
                        </p>
                    </div>
                </div>
            </header>

            {/* Grid of Rules */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* 1. Loi de Pareto */}
                <DocCard
                    icon={ShieldCheck}
                    title="Loi de Pareto (Poids %)"
                    description="Priorité n°1 : Le poids du produit chez le fournisseur."
                    accent="teal"
                >
                    <p className="text-[13px] leading-relaxed">
                        L'IA identifie les produits <strong>Indiscutables</strong>. Si un produit pèse
                        <strong> {"> 10%"}</strong> du CA total de son fournisseur, il est jugé stratégique.
                        Mary refusera de suggérer sa sortie [Z] pour protéger la relation fournisseur et
                        garantir la stabilité de l'assortiment.
                    </p>
                </DocCard>

                {/* 2. Équité & Normalisation */}
                <DocCard
                    icon={Scale}
                    title="Normalisation & Équité"
                    description="Égalité de traitement entre mono et multi-magasins."
                    accent="rose"
                >
                    <p className="text-[13px] leading-relaxed">
                        Pour une comparaison juste, les statistiques des produits présents sur un seul magasin sont
                        <strong> doublées (x2)</strong>. L'IA compare ensuite ces données pondérées aux
                        <strong> Benchmarks du Rayon</strong> (Moyenne du Niveau 2) pour détecter les sur-performances.
                    </p>
                </DocCard>

                {/* 3. Cycle de Vie */}
                <DocCard
                    icon={TrendingUp}
                    title="Potentiel & Cycle de Vie"
                    description="Détection des lancements et des fins de vie."
                    accent="indigo"
                >
                    <p className="text-[13px] leading-relaxed">
                        Mary distingue les produits récents des produits établis :
                    </p>
                    <ul className="mt-2 space-y-1 text-[13px]">
                        <li>• <strong>Run Rate</strong> : Projection sur 12 mois pour les produits de moins d'un an.</li>
                        <li>• <strong>Inactivité</strong> : Une alerte est levée après <strong>2 mois sans vente</strong>,
                            orientant le verdict vers le [C] (Saisonnier) ou [Z] (Sortie).</li>
                    </ul>
                </DocCard>

                {/* 4. PMV & Trafic */}
                <DocCard
                    icon={Zap}
                    title="Volumes vs Valeur (PMV)"
                    description="Identifier les générateurs de trafic."
                    accent="amber"
                >
                    <p className="text-[13px] leading-relaxed">
                        Un produit peut être maintenu même avec un faible CA s'il génère du <strong>Trafic</strong> (Volumes {">"} Moyenne Rayon).
                        À l'inverse, un produit à faible volume peut être un <strong>Contributeur de Marge</strong> précieux s'il possède un Prix Moyen de Vente (PMV) élevé.
                    </p>
                </DocCard>
            </div>

            {/* Footer / Tip */}
            <div className="p-6 rounded-2xl bg-[var(--accent-bg)] border border-[var(--accent-border)] flex gap-4">
                <Info className="w-6 h-6 text-[var(--accent)] shrink-0" />
                <div className="space-y-1">
                    <p className="text-sm font-bold text-[var(--accent)]">Conseil d'expert</p>
                    <p className="text-[13px] text-[var(--text-secondary)]">
                        L'IA est un outil d'aide à la décision. Elle combine ces règles pour vous proposer une recommandation
                        brute, mais votre expertise terrain reste essentielle pour valider les cas particuliers (ruptures fournisseurs prolongées, promotions, etc.).
                    </p>
                </div>
            </div>
        </div>
    );
}

function DocCard({
    icon: Icon,
    title,
    description,
    children,
    accent
}: {
    icon: any,
    title: string,
    description: string,
    children: React.ReactNode,
    accent: "teal" | "indigo" | "amber" | "rose"
}) {
    const colors = {
        teal: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 shadow-emerald-500/5",
        indigo: "bg-indigo-500/10 text-indigo-600 border-indigo-500/20 shadow-indigo-500/5",
        amber: "bg-amber-500/10 text-amber-600 border-amber-500/20 shadow-amber-500/5",
        rose: "bg-rose-500/10 text-rose-600 border-rose-500/20 shadow-rose-500/5",
    };

    return (
        <div className="group p-6 rounded-2xl bg-white dark:bg-slate-900 border border-[var(--border)] shadow-sm hover:shadow-md transition-all">
            <div className="flex items-start gap-4 mb-4">
                <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center shadow-sm border", colors[accent])}>
                    <Icon className="w-5 h-5" />
                </div>
                <div>
                    <h3 className="text-[15px] font-bold text-[var(--text-primary)]">{title}</h3>
                    <p className="text-[12px] text-[var(--text-muted)] font-medium leading-tight">{description}</p>
                </div>
            </div>
            <div className="text-[var(--text-secondary)] leading-relaxed">
                {children}
            </div>
        </div>
    );
}
