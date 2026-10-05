"use client";

/**
 * CollectFlow — Carte « tendance réseau », ouverte depuis la colonne Tendance.
 *
 * Trois étages, dans l'ordre où on se pose les questions :
 *   1. la lecture en une phrase (le produit progresse-t-il dans le réseau ?) ;
 *   2. le réseau : verdict, rythme par magasin, diffusion, puis les courbes ;
 *   3. nos magasins : stock, ventes, couverture, comparés au rythme du réseau.
 *
 * Sans le troisième étage, la carte disait comment le produit marche AILLEURS
 * sans dire où on en est CHEZ NOUS — il fallait rouvrir un autre détail pour
 * savoir s'il restait du stock.
 *
 * La couleur de tendance (vert / rouge / gris) ne vit que dans la tuile de
 * verdict et la colonne « vs réseau », toujours accompagnée d'un signe ou d'un
 * libellé : un état ne se signale jamais par la couleur seule.
 */

import type React from "react";
import { TrendingUp, TrendingDown, Minus, Store, Warehouse } from "lucide-react";
import { DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TuileStat } from "@/features/grid/components/stat-tile";
import { NetworkLineChart } from "@/features/grid/components/network-charts";
import {
    computeStoresSeries,
    trendLabel,
    TREND_COLOR,
    TREND_FLAT,
    TREND_WINDOW,
    NB_MAGASINS_RESEAU,
    type NetworkTrend,
} from "@/features/grid/lib/network-trend";
import { formatDate, formatMonthLabel, qlikMonthToFf } from "@/features/grid/lib/months";
import { MAGASINS, LIBELLE_TOUS_MAGASINS } from "@/lib/magasins";
import { fmtEur2 } from "@/lib/format";
import type { ProductRow } from "@/types/grid";

const fmt = (v: number, d = 0) => v.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
/** Une décimale sous 10, aucune au-delà : « 2,4 » mais « 37 ». */
const fmtRythme = (v: number) => fmt(v, Math.abs(v) < 10 ? 1 : 0);
const moyenne = (xs: number[]) => (xs.length ? xs.reduce((t, v) => t + v, 0) / xs.length : 0);
const pctTexte = (p: number) => `${p >= 0 ? "+" : "−"}${fmt(Math.abs(Math.round(p * 100)))} %`;

/** Mois de stock au rythme des ventes ; sans vente, le ratio n'existe pas et on le dit. */
function couvertureTexte(stock: number, parMois: number): string {
    if (parMois <= 0) return stock > 0 ? "sans vente" : "—";
    const c = stock / parMois;
    if (c < 1) return "< 1 mois";
    if (c > 24) return "> 24 mois";
    return `${fmt(c, c < 10 ? 1 : 0)} mois`;
}

interface LigneMagasin {
    cle: string;
    nom: string;
    stock: number;
    ventes: number;
    parMois: number;
    derniereEntree?: string;
    /** Écart à la moyenne réseau par magasin, `null` si non comparable. */
    vsReseau: number | null;
    total?: boolean;
}

/**
 * Nos magasins, un par ligne, puis l'ensemble.
 *
 * « vs réseau » compare nos ventes mensuelles moyennes à celles d'un magasin
 * vendeur moyen du réseau sur la même période : c'est la seule assiette
 * commune (le réseau n'a pas de stock par magasin à nous offrir).
 */
function lignesMagasins(row: ProductRow, mois: string[], moyenneReseau: number | null): LigneMagasin[] {
    const dernier = mois[mois.length - 1];
    const ecart = (parMois: number) =>
        moyenneReseau != null && moyenneReseau > 0 ? parMois / moyenneReseau - 1 : null;

    const lignes: LigneMagasin[] = MAGASINS.map((m) => {
        const ventes = mois.reduce((t, k) => t + (row.sales12mByStore?.[m.code]?.[k] ?? 0), 0);
        const parMois = ventes / mois.length;
        return {
            cle: m.code,
            nom: m.nom,
            stock: row.stock12mByStore?.[m.code]?.[dernier] ?? 0,
            ventes,
            parMois,
            derniereEntree: row.derniereLivraisonByStore?.[m.code],
            vsReseau: ventes > 0 ? ecart(parMois) : null,
        };
    });

    const ventes = mois.reduce((t, k) => t + (row.sales12m?.[k] ?? 0), 0);
    lignes.push({
        cle: "TOTAL",
        nom: LIBELLE_TOUS_MAGASINS,
        stock: row.stock12m?.[dernier] ?? lignes.reduce((t, l) => t + l.stock, 0),
        ventes,
        parMois: ventes / mois.length,
        derniereEntree: row.derniereLivraison,
        // Comparer deux magasins cumulés à UN magasin réseau n'aurait pas de sens.
        vsReseau: null,
        total: true,
    });
    return lignes;
}

function TableauNosMagasins({ lignes, finPeriode }: { lignes: LigneMagasin[]; finPeriode: string }) {
    const entete = "px-2.5 py-2 font-semibold whitespace-nowrap";
    return (
        <div className="rounded-xl overflow-x-auto min-w-0" style={{ border: "1px solid var(--border)" }}>
            <table className="w-full text-[13px] tabular-nums" style={{ minWidth: 560 }} aria-label="Stock et ventes de nos magasins">
                <thead>
                    <tr style={{ background: "var(--bg-elevated)", color: "var(--text-secondary)" }}>
                        <th className={`${entete} text-left`}>Magasin</th>
                        <th className={`${entete} text-right`} title="Stock de fin de mois du dernier mois complet">Stock fin {finPeriode}</th>
                        <th className={`${entete} text-right`}>Ventes 12 m</th>
                        <th className={`${entete} text-right`}>Par mois</th>
                        <th className={`${entete} text-right`} title="Combien de mois le stock tient au rythme des 12 derniers mois">Couverture</th>
                        <th className={`${entete} text-right`} title="Nos ventes par mois comparées à celles d'un magasin vendeur moyen du réseau">vs réseau</th>
                    </tr>
                </thead>
                <tbody>
                    {lignes.map((l) => {
                        const couleurEcart = l.vsReseau == null || Math.abs(l.vsReseau) <= TREND_FLAT
                            ? "var(--text-secondary)"
                            : TREND_COLOR[l.vsReseau > 0 ? "up" : "down"];
                        return (
                            <tr
                                key={l.cle}
                                style={{
                                    borderTop: `1px solid ${l.total ? "var(--border-strong)" : "var(--border)"}`,
                                    background: l.total ? "var(--bg-elevated)" : undefined,
                                }}
                            >
                                <td className="px-2.5 py-2 whitespace-nowrap" style={{ color: "var(--text-primary)" }}>
                                    <div className={l.total ? "font-bold" : "font-semibold"}>{l.nom}</div>
                                    <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                                        {l.derniereEntree ? `dernière entrée ${formatDate(l.derniereEntree)}` : "aucune entrée enregistrée"}
                                    </div>
                                </td>
                                <td className="px-2.5 py-2 text-right font-bold" style={{ color: l.stock > 0 ? "var(--text-primary)" : "var(--text-muted)" }}>
                                    {fmt(l.stock)}
                                </td>
                                <td className="px-2.5 py-2 text-right" style={{ color: l.ventes !== 0 ? "var(--text-primary)" : "var(--text-muted)" }}>
                                    {fmt(l.ventes)}
                                </td>
                                <td className="px-2.5 py-2 text-right" style={{ color: "var(--text-secondary)" }}>
                                    {l.ventes !== 0 ? fmtRythme(l.parMois) : "—"}
                                </td>
                                <td className="px-2.5 py-2 text-right" style={{ color: "var(--text-secondary)" }}>
                                    {couvertureTexte(l.stock, l.parMois)}
                                </td>
                                <td className="px-2.5 py-2 text-right font-semibold" style={{ color: couleurEcart }}>
                                    {l.vsReseau != null ? pctTexte(l.vsReseau) : "—"}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

/** Titre de section : icône + intitulé + précision en clair. */
function TitreSection({ icone: Icone, titre, detail }: {
    icone: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
    titre: string;
    detail?: string;
}) {
    return (
        <div className="flex items-baseline gap-2 flex-wrap">
            <Icone className="w-4 h-4 shrink-0 self-center" style={{ color: "var(--text-muted)" }} />
            <h3 className="text-[14px] font-bold" style={{ color: "var(--text-primary)" }}>{titre}</h3>
            {detail && <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>{detail}</span>}
        </div>
    );
}

/**
 * La tendance dite en une phrase, avec ses deux chiffres : on la lit avant
 * d'avoir à interpréter les tuiles et les courbes.
 */
function phraseReseau(trend: NetworkTrend): string {
    if (trend.nouveau) {
        return `Dans le réseau, le produit est nouveau : aucune vente sur les ${TREND_WINDOW} premiers mois, des ventes sur les ${TREND_WINDOW} derniers.`;
    }
    const serie = trend.perStore ?? trend.values;
    const n = serie.length;
    const debut = moyenne(serie.slice(0, TREND_WINDOW));
    const fin = moyenne(serie.slice(n - TREND_WINDOW));
    const unite = trend.perStore ? "par magasin vendeur et par mois" : "par mois dans tout le réseau";
    const sens = trend.direction === "up" ? "progresse" : trend.direction === "down" ? "recule" : "est stable";
    return `Dans le réseau, le produit ${sens} : ${fmtRythme(fin)} unités ${unite} sur les ${TREND_WINDOW} derniers mois, contre ${fmtRythme(debut)} sur les ${TREND_WINDOW} premiers.`;
}

export function NetworkMonthlyModal({ row, trend, mois, onClose }: {
    row: ProductRow;
    trend: NetworkTrend;
    /** Fenêtre des ventes FF de la Grille (clés « YYYYMM »). */
    mois: string[];
    onClose: () => void;
}) {
    const { values, labels, direction, pct } = trend;
    const couleur = TREND_COLOR[direction];
    const magasins = computeStoresSeries(row.nbMagReseauByMonth, labels);
    const Fleche = direction === "up" ? TrendingUp : direction === "down" ? TrendingDown : Minus;
    const dernier = values.length - 1;

    const verdict = trend.nouveau ? "Nouveau" : pct != null ? pctTexte(pct) : "—";
    const moyenneReseau = trend.perStore ? moyenne(trend.perStore) : null;
    const magasinsDernierMois = magasins ? magasins.values[dernier] : (row.nbMagasinsReseau ?? 0);

    const lignes = lignesMagasins(row, mois, moyenneReseau);
    const finPeriode = mois.length ? formatMonthLabel(mois[mois.length - 1]) : "";
    const nous = lignes[lignes.length - 1];

    const periodeReseau = labels.length
        ? `${formatMonthLabel(qlikMonthToFf(labels[0]))} → ${formatMonthLabel(qlikMonthToFf(labels[labels.length - 1]))}`
        : "12 mois glissants";

    return (
        <DialogContent
            // Même gabarit que le détail 12 mois : grille à une colonne, sinon le
            // tableau le plus large dimensionne la fenêtre et déborde.
            className="max-w-[calc(100%-2rem)] sm:max-w-3xl grid-cols-1 max-h-[88vh] overflow-y-auto"
            style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}
            onInteractOutside={onClose}
        >
            <DialogHeader>
                <DialogTitle className="text-lg leading-snug pr-6" style={{ color: "var(--text-primary)" }}>
                    {row.libelle1}
                </DialogTitle>
                <p className="text-[13px] mt-1" style={{ color: "var(--text-muted)" }}>
                    {row.codein}
                    {row.reference ? ` · réf. ${row.reference}` : ""}
                    {row.codeCentrale ? ` · centrale ${row.codeCentrale}` : ""}
                </p>
            </DialogHeader>

            {/* Lecture en clair : réseau, puis nous. */}
            <div className="rounded-xl px-4 py-3 space-y-1 text-[14px] leading-relaxed" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }}>
                {trend.hasData
                    ? <p>{phraseReseau(trend)}</p>
                    : <p style={{ color: "var(--text-muted)" }}>Pas encore de détail mensuel réseau pour ce produit : relancez une synchronisation Qlik.</p>}
                <p style={{ color: "var(--text-secondary)" }}>
                    Chez nous : {fmt(nous.ventes)} unités vendues en 12 mois, {fmt(nous.stock)} en stock fin {finPeriode}
                    {nous.ventes > 0 ? ` (${couvertureTexte(nous.stock, nous.parMois)} de couverture)` : ""}
                    {row.commandesEnCours ? `, ${fmt(row.commandesEnCours)} en commande` : ""}.
                </p>
            </div>

            {trend.hasData && (
                <section className="space-y-2">
                    <TitreSection
                        icone={TrendingUp}
                        titre="Réseau"
                        detail={`${NB_MAGASINS_RESEAU} magasins · ${periodeReseau}, mois en cours exclu`}
                    />
                    {trend.enRetard && (
                        <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                            Le dernier mois n&apos;est pas encore synchronisé depuis Qlik : la période s&apos;arrête un mois plus tôt.
                        </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                        <TuileStat
                            label="Tendance"
                            valeur={verdict}
                            indice={`${trendLabel(pct, trend.nouveau)} · ${trend.surQteParMagasin ? "sur la qté par magasin" : "sur les volumes"}`}
                            couleur={couleur}
                            icone={Fleche}
                        />
                        {trend.perStore && moyenneReseau != null && (
                            <TuileStat
                                label="Qté / magasin / mois"
                                valeur={fmtRythme(trend.perStore[dernier])}
                                indice={`dernier mois · ${fmtRythme(moyenneReseau)} en moyenne`}
                            />
                        )}
                        <TuileStat
                            label="Magasins vendeurs"
                            valeur={fmt(magasinsDernierMois)}
                            indice={`dernier mois · ${fmt((magasinsDernierMois / NB_MAGASINS_RESEAU) * 100)} % du réseau`}
                        />
                        {row.caReseau != null && row.caReseau > 0 && (
                            <TuileStat
                                label="CA réseau 12 m"
                                valeur={fmtEur2(row.caReseau)}
                                indice={row.margePctReseau ? `marge ${fmt(row.margePctReseau * 100, 1)} %` : undefined}
                            />
                        )}
                    </div>
                    <NetworkLineChart labels={labels} values={values} stores={magasins?.values} perStore={trend.perStore} />
                </section>
            )}

            <section className="space-y-2">
                <TitreSection
                    icone={Store}
                    titre="Nos magasins"
                    detail={`stock et ventes sur nos 12 derniers mois${moyenneReseau != null ? ` · réseau : ${fmtRythme(moyenneReseau)} / magasin / mois` : ""}`}
                />
                <TableauNosMagasins lignes={lignes} finPeriode={finPeriode} />
                {row.stockActuel != null && (
                    <p className="text-[12px] flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
                        <Warehouse className="w-3.5 h-3.5 shrink-0" />
                        Stock disponible aujourd&apos;hui, tous magasins : <span className="font-semibold" style={{ color: "var(--text-secondary)" }}>{fmt(row.stockActuel)}</span>
                    </p>
                )}
            </section>
        </DialogContent>
    );
}
