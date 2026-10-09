"use client";

import React from "react";

import { useGridStore } from "@/features/grid/store/use-grid-store";
import { SyncQlikButton } from "./sync-qlik-button";
import { useSaveDrafts } from "@/features/grid/hooks/use-save-drafts";
import { ChevronDown, Download, FileSpreadsheet, FileText, History, Loader2, RotateCcw, Save, Table2 } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { saveSnapshot } from "@/features/snapshots/api/save-snapshot";
import { rejeterGammesAValider } from "@/features/grid/api/gammes-a-valider-actions";
import { isStaleServerActionError, STALE_ACTION_MESSAGE } from "@/lib/stale-action";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { confirmer, toast } from "@/components/ui/feedback";
import { fmtDecimal1, fmtEntier, fmtEur2 } from "@/lib/format";
import { couleurMarge } from "@/lib/marge";
import {
    exporterFichierGammes,
    exporterGammeA,
    exporterTousProduits,
    imprimerPdf,
    lignesModifiees,
    synchroniserGammes,
} from "@/features/grid/lib/exports";

type Synchro = Awaited<ReturnType<typeof synchroniserGammes>>;

function Stat({ label, value, sub, subColor }: { label: string; value: string; sub?: string; subColor?: string }) {
    return (
        <div className="flex flex-col leading-tight">
            <span className="text-xs text-[var(--text-muted)]">{label}</span>
            <span className="text-base font-bold tabular-nums text-[var(--text-primary)]">
                {value}
                {sub && <span className="ml-1.5 text-[13px] font-semibold" style={{ color: subColor }}>{sub}</span>}
            </span>
        </div>
    );
}

function messageErreur(err: unknown): string {
    if (isStaleServerActionError(err)) return STALE_ACTION_MESSAGE;
    return err instanceof Error ? err.message : String(err);
}

/**
 * Barre du bas de la Grille : totaux du périmètre affiché et TOUTES les actions
 * sur les gammes (annuler, enregistrer, exporter). Il y avait des doublons dans
 * l'en-tête, avec des droits différents.
 */
function FloatingSummaryBarInner({ isAdmin, nomFournisseur }: { isAdmin: boolean; nomFournisseur: string }) {
    const summary = useGridStore((s) => s.summary);
    const resetDrafts = useGridStore((s) => s.resetDrafts);
    const rows = useGridStore((s) => s.rows);
    const filterFournisseur = useGridStore((s) => s.filters.codeFournisseur);
    // Magasin affiché (bascule de la Grille). `filters.magasin` n'est jamais
    // renseigné : les sessions et validations étaient toutes notées « TOTAL ».
    const activeMagasin = useGridStore((s) => s.activeMagasin);
    const [isPending, startTransition] = useTransition();
    const [enCours, setEnCours] = useState<string | null>(null);

    const { save, hasDrafts, count, nbAValider } = useSaveDrafts(activeMagasin || "TOTAL");

    const supplierCode = filterFournisseur || rows[0]?.codeFournisseur;
    const lastQlikUpdate = useMemo(() => {
        let max: string | null = null;
        for (const r of rows) {
            if (r.networkFetchedAt && (!max || r.networkFetchedAt > max)) max = r.networkFetchedAt;
        }
        return max;
    }, [rows]);

    const handleSave = () => {
        startTransition(async () => {
            try {
                const result = await save();
                if (result.success && result.saved === 0) {
                    toast.info("Propositions de l'API écartées.");
                } else if (result.success) {
                    toast.succes(`${result.saved} gamme${result.saved > 1 ? "s" : ""} enregistrée${result.saved > 1 ? "s" : ""}.`);
                } else {
                    toast.erreur(`Enregistrement impossible : ${result.error ?? "erreur inconnue"}`);
                }
            } catch (err) {
                toast.erreur(`Enregistrement impossible : ${messageErreur(err)}`);
            }
        });
    };

    const handleReset = async () => {
        const pluriel = count > 1 ? "s" : "";
        const message = count > 0
            ? `Les ${count} gamme${pluriel} modifiée${pluriel} et non enregistrée${pluriel} reviendront à leur valeur précédente.`
            : "";
        const ok = await confirmer({
            titre: "Annuler les modifications ?",
            message: nbAValider > 0
                ? `${message} ${nbAValider > 1 ? `Les ${nbAValider} gammes proposées` : "La gamme proposée"} par l'API ${nbAValider > 1 ? "seront rejetées" : "sera rejetée"}.`.trim()
                : message,
            libelleConfirmer: "Annuler les modifications",
            danger: true,
        });
        if (!ok) return;
        if (nbAValider > 0) {
            const { gammesAValider, rowsByCodein, retirerGammesAValider } = useGridStore.getState();
            const codeins = Object.keys(gammesAValider).filter((c) => rowsByCodein[c]);
            const codeFournisseur = filterFournisseur || rows[0]?.codeFournisseur;
            try {
                const res = codeFournisseur
                    ? await rejeterGammesAValider({ codeFournisseur, codeins })
                    : { success: false, error: "fournisseur inconnu" };
                if (!res.success) throw new Error(res.error);
                retirerGammesAValider(codeins);
            } catch (err) {
                toast.erreur(`Les propositions de l'API n'ont pas pu être rejetées : ${messageErreur(err)}`);
                return;
            }
        }
        resetDrafts();
        toast.info("Modifications annulées.");
    };

    /**
     * Gammes enregistrées depuis le chargement (API /api/v1, autre onglet) : l'écran
     * les reprend avant tout export, sinon le fichier et l'Historique partaient de
     * gammes périmées — et la copie dans l'Historique les effaçait.
     */
    const alignerSurServeur = async (): Promise<Synchro> => {
        if (!supplierCode) return { snapshotId: null, misesAJour: 0 };
        const synchro = await synchroniserGammes(supplierCode);
        if (synchro.misesAJour > 0) {
            const n = synchro.misesAJour;
            toast.info(`${n} gamme${n > 1 ? "s ont" : " a"} été modifiée${n > 1 ? "s" : ""} entre-temps côté serveur (API) : l'écran a été mis à jour.`);
        }
        return synchro;
    };

    /**
     * Enregistre une copie de la session dans l'Historique.
     * Renvoie l'identifiant créé, ou `null` en cas d'échec (déjà signalé).
     * `synchro` : alignement déjà fait par l'appelant, sinon il est fait ici.
     */
    const handleSnapshot = async (labelOverride?: string, type: "snapshot" | "export" = "snapshot", synchro?: Synchro) => {
        if (rows.length === 0) return null;
        try {
            const { snapshotId: baseSnapshotId } = synchro ?? await alignerSurServeur();
            // Relu après l'alignement : les lignes et les totaux ont pu changer.
            const { draftChanges, rows: lignes, summary: totaux } = useGridStore.getState();
            if (lignes.length === 0) return null;
            // Tous les changements : brouillons + gammes déjà enregistrées (≠ FF)
            const changes = Object.fromEntries(
                lignesModifiees().map(r => [
                    r.codein,
                    { before: r.codeGammeInit, after: (draftChanges[r.codein] ?? r.codeGamme) as string },
                ])
            );
            const res = await saveSnapshot({
                codeFournisseur: filterFournisseur || lignes[0].codeFournisseur,
                nomFournisseur: lignes[0].nomFournisseur,
                magasin: activeMagasin || "TOTAL",
                label: labelOverride || `Session ${lignes[0].nomFournisseur} — ${new Date().toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}`,
                changes,
                type,
                baseSnapshotId,
                summary: {
                    totalRows: totaux.totalRows,
                    totalCa: totaux.totalCa,
                    totalMarge: totaux.totalMarge,
                    tauxMargeGlobal: totaux.tauxMargeGlobal,
                },
            });
            if (!res.success) throw new Error(res.error);
            if (!labelOverride) toast.succes("Session enregistrée dans l'Historique.");
            return res.snapshotId;
        } catch (err) {
            if (!labelOverride) toast.erreur(`La session n'a pas pu être enregistrée : ${messageErreur(err)}`);
            return null;
        }
    };

    /** Lance un export (écran aligné sur le serveur) avec indicateur et messages d'erreur communs. */
    const lancer = async (cle: string, action: (synchro: Synchro) => Promise<boolean>, vide: string) => {
        if (enCours) return;
        setEnCours(cle);
        try {
            const ok = await action(await alignerSurServeur());
            if (!ok) toast.info(vide);
        } catch (err) {
            toast.erreur(`L'export a échoué : ${messageErreur(err)}`);
        } finally {
            setEnCours(null);
        }
    };

    return (
        <div
            /*
             * Dans le flux, plus en `fixed` : la grille cède exactement la hauteur
             * nécessaire, sans recouvrir la dernière ligne ni l'ascenseur horizontal.
             */
            className="shrink-0 px-4 py-2.5 flex flex-wrap justify-between items-center gap-x-6 gap-y-2 rounded-xl border bg-[var(--bg-surface)] shadow-[var(--shadow-sm)]"
            style={{ borderColor: hasDrafts ? "var(--accent-warning)" : "var(--border-strong)" }}
        >
            <div className="flex flex-wrap items-center gap-x-8 gap-y-1">
                <Stat label="Produits actifs" value={fmtEntier(summary.totalRows)} sub={summary.totalProducts !== summary.totalRows ? `sur ${fmtEntier(summary.totalProducts)}` : undefined} subColor="var(--text-muted)" />
                <Stat label="Quantités vendues (12 mois)" value={fmtEntier(summary.totalQuantite)} />
                <Stat label="Chiffre d'affaires" value={fmtEur2(summary.totalCa)} />
                <Stat
                    label="Marge"
                    value={fmtEur2(summary.totalMarge)}
                    sub={`${fmtDecimal1(summary.tauxMargeGlobal)} %`}
                    subColor={couleurMarge(summary.tauxMargeGlobal)}
                />
            </div>

            <div className="flex flex-wrap items-center gap-2">
                {isAdmin && <SyncQlikButton codeFournisseur={supplierCode} lastUpdate={lastQlikUpdate} />}

                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" disabled={rows.length === 0 || enCours !== null}>
                            {enCours ? <Loader2 className="animate-spin" /> : <Download />}
                            Exporter
                            <ChevronDown className="opacity-60" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-80">
                        <DropdownMenuLabel className="text-xs font-medium text-[var(--text-secondary)]">Fichier d&apos;import des gammes</DropdownMenuLabel>
                        <DropdownMenuItem
                            className="cursor-pointer"
                            onSelect={() => lancer("modifs", async (synchro) => {
                                if (lignesModifiees().length === 0) return false;
                                const nom = lignesModifiees()[0].nomFournisseur;
                                // Copie dans l'Historique, onglet « Exports »
                                await handleSnapshot(`Export ${nom} — ${new Date().toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}`, "export", synchro);
                                return exporterFichierGammes(true);
                            }, "Aucune gamme n'a été modifiée par rapport à FF.")}
                        >
                            <FileSpreadsheet />
                            <div className="flex flex-col">
                                <span className="font-medium">Gammes modifiées seulement</span>
                                <span className="text-xs text-[var(--text-muted)]">Les produits dont la gamme a changé</span>
                            </div>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            className="cursor-pointer"
                            onSelect={() => lancer("complet", () => exporterFichierGammes(false), "Aucun produit à exporter.")}
                        >
                            <FileSpreadsheet />
                            <div className="flex flex-col">
                                <span className="font-medium">Toutes les gammes</span>
                                <span className="text-xs text-[var(--text-muted)]">Tous les produits du fournisseur</span>
                            </div>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel className="text-xs font-medium text-[var(--text-secondary)]">Documents de travail</DropdownMenuLabel>
                        <DropdownMenuItem
                            className="cursor-pointer"
                            onSelect={() => lancer("tous", () => exporterTousProduits(nomFournisseur), "Aucun produit à exporter.")}
                        >
                            <Table2 />
                            <div className="flex flex-col">
                                <span className="font-medium">Tableau complet (Excel)</span>
                                <span className="text-xs text-[var(--text-muted)]">Gamme avant / après et chiffres sur 12 mois</span>
                            </div>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            className="cursor-pointer"
                            onSelect={() => lancer("gammeA", exporterGammeA, "Aucun produit en gamme A.")}
                        >
                            <FileSpreadsheet />
                            <div className="flex flex-col">
                                <span className="font-medium">Liste des produits en gamme A (Excel)</span>
                                <span className="text-xs text-[var(--text-muted)]">Code-barres, référence, libellé, magasins</span>
                            </div>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            className="cursor-pointer"
                            onSelect={() => lancer("pdf", () => imprimerPdf(nomFournisseur), "Aucun produit à imprimer.")}
                        >
                            <FileText />
                            <div className="flex flex-col">
                                <span className="font-medium">Tableau imprimable (PDF)</span>
                                <span className="text-xs text-[var(--text-muted)]">Mise en page paysage</span>
                            </div>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="cursor-pointer" onSelect={() => { void handleSnapshot(); }}>
                            <History />
                            <div className="flex flex-col">
                                <span className="font-medium">Garder une copie dans l&apos;Historique</span>
                                <span className="text-xs text-[var(--text-muted)]">Pour reprendre cette session plus tard</span>
                            </div>
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>

                {nbAValider > 0 && (
                    <span
                        className="rounded-lg border px-2.5 py-1 text-[13px] font-medium border-[var(--accent-warning)] text-[var(--accent-warning)]"
                        title="Gammes proposées par l'API : elles apparaissent comme des modifications non enregistrées. « Enregistrer » les valide, « Annuler » les rejette."
                    >
                        {nbAValider} gamme{nbAValider > 1 ? "s" : ""} proposée{nbAValider > 1 ? "s" : ""} par l&apos;API à valider
                    </span>
                )}
                {hasDrafts && (
                    <Button variant="ghost" onClick={handleReset} disabled={isPending}>
                        <RotateCcw /> Annuler
                    </Button>
                )}
                <Button onClick={handleSave} disabled={!hasDrafts || isPending}>
                    {isPending ? <Loader2 className="animate-spin" /> : <Save />}
                    {isPending
                        ? "Enregistrement…"
                        : count > 0
                            ? `Enregistrer ${count} modification${count > 1 ? "s" : ""}`
                            : hasDrafts
                                ? `Écarter ${nbAValider > 1 ? "les propositions" : "la proposition"} de l'API`
                                : "Aucune modification"}
                </Button>
            </div>
        </div>
    );
}

/**
 * Mémoïsé : ses props sont stables, il n'a donc pas à se redessiner quand le
 * parent change d'état (sélection, progression du chargement…).
 */
export const FloatingSummaryBar = React.memo(FloatingSummaryBarInner);
