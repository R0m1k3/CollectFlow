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
                {/* 1. Équité Territoriale */}
                <DocCard
                    icon={ShieldCheck}
                    title="Normalisation Magasins (x2)"
                    description="Équilibre les chances entre les produits mono-magasin et multi-magasins."
                    accent="teal"
                >
                    <p className="text-[13px] leading-relaxed">
                        Pour éviter qu'un produit présent dans un seul magasin ne soit pénalisé par son volume brut, le système
                        <strong> double automatiquement</strong> toutes ses statistiques (Ventes, CA, Marge).
                        Cela simule sa performance s'il était présent sur les deux points de vente de référence.
                    </p>
                </DocCard>

                {/* 2. Run Rate */}
                <DocCard
                    icon={TrendingUp}
                    title="Potentiel Annuel (Run Rate)"
                    description="Évalue les lancements sur leur dynamique réelle, pas sur leur cumul."
                    accent="indigo"
                >
                    <p className="text-[13px] leading-relaxed">
                        Si un produit a moins de 12 mois de présence, l'IA calcule un <strong>Run Rate 12 mois</strong>.
                        <br /><br />
                        <code className="bg-[var(--bg-muted)] px-2 py-0.5 rounded text-indigo-600 dark:text-indigo-400 font-mono text-[11px]">
                            Projection = Volume_Réel * (12 / Mois_Présence)
                        </code>
                        <br /><br />
                        Cela permet de confirmer un produit <strong>Permanent [A]</strong> dès ses premiers mois s'il a une forte vélocité.
                    </p>
                </DocCard>

                {/* 3. Saisonnalité */}
                <DocCard
                    icon={Calendar}
                    title="Détection Saisonnalité"
                    description="Distingue les ruptures temporaires des fins de vie ou saisons."
                    accent="amber"
                >
                    <p className="text-[13px] leading-relaxed">
                        L'IA analyse la <strong>récence</strong> des ventes. Si aucune vente n'est constatée depuis plus de
                        <strong> 2 mois</strong> :
                    </p>
                    <ul className="mt-2 space-y-1 text-[13px]">
                        <li className="flex items-center gap-2">
                            <Zap className="w-3 h-3 text-emerald-500" />
                            <span>{"< 2 mois : Lancement probable (actif)"}</span>
                        </li>
                        <li className="flex items-center gap-2">
                            <AlertTriangle className="w-3 h-3 text-amber-500" />
                            <span>{"> 2 mois : Alerte Saison [C] ou Sortie [Z]"}</span>
                        </li>
                    </ul>
                </DocCard>

                {/* 4. Score Global */}
                <DocCard
                    icon={Scale}
                    title="Score de Performance"
                    description="La source de vérité mathématique (0 à 100)."
                    accent="rose"
                >
                    <p className="text-[13px] leading-relaxed">
                        Le score affiché dans la grille combine la Quantité, le CA et la Marge.
                        L'IA utilise ce score comme garde-fou :
                    </p>
                    <ul className="mt-2 space-y-1 text-[13px]">
                        <li>• <strong>{"> 70"}</strong> : Candidat naturel au maintien.</li>
                        <li>• <strong>{"< 30"}</strong> : Signal fort de déréférencement.</li>
                    </ul>
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
