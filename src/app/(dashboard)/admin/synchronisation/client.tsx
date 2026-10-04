"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    CalendarClock, Play, Square, RefreshCw, Loader2, AlertTriangle,
    CheckCircle2, Database, Network, Clock,
} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, type Ton } from "@/components/ui/badge";
import { Input, Label, SearchInput } from "@/components/ui/form-controls";
import { Segmented, type TabItem } from "@/components/ui/tabs";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import { StatCard } from "@/components/ui/stat-card";
import { ErrorState, Skeleton } from "@/components/ui/states";
import { Tooltip } from "@/components/ui/tooltip";
import { confirmer, toast } from "@/components/ui/feedback";
import { fmtEntier } from "@/lib/format";

interface SyncSettings {
    actif: boolean;
    heureDebut: number;
    heureFin: number;
    qlikParNuit: number;
    sqlParQlik: number;
    qlikMinJours: number;
}

interface SyncState {
    enCours: boolean;
    origine: "auto" | "manuel" | null;
    debutAt: string | null;
    finAt: string | null;
    fournisseurCourant: string | null;
    etape: "sql" | "qlik" | null;
    sqlFaits: number;
    sqlEchecs: number;
    qlikFaits: number;
    qlikEchecs: number;
    tourTermine: boolean;
    derniereErreur: string | null;
}

interface FournisseurRow {
    codeFournisseur: string;
    nomFournisseur: string | null;
    actifSql: boolean;
    actifQlik: boolean;
    desactiveMotif: string | null;
    dernierSqlAt: string | null;
    dernierSqlStatut: string | null;
    dernierSqlLignes: number | null;
    dernierSqlMs: number | null;
    dernierQlikAt: string | null;
    dernierQlikStatut: string | null;
    dernierQlikCodes: number | null;
}

interface Resume {
    total: number; actifsSql: number; actifsQlik: number;
    desactivesAuto: number; enEchecSql: number; enEchecQlik: number; jamaisSql: number;
}

type Filtre = "tous" | "actifs" | "inactifs" | "echecs";

/** Libellés des deux sources, identiques partout dans la page. */
const VENTES = "Ventes (base FF)";
const RESEAU = "Réseau (Qlik)";

const fmtDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "Jamais";

function fmtDuree(ms: number | null): string {
    if (ms == null) return "";
    if (ms < 1000) return `${ms} ms`;
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

const STATUTS: Record<string, { ton: Ton; libelle: string; aide: string }> = {
    succes: { ton: "succes", libelle: "OK", aide: "Dernière mise à jour réussie" },
    echec: { ton: "erreur", libelle: "Échec", aide: "La dernière mise à jour a échoué" },
    vide: { ton: "alerte", libelle: "Vide", aide: "Aucune donnée reçue lors de la dernière mise à jour" },
};

function StatutBadge({ statut }: { statut: string | null }) {
    if (!statut) return null;
    const s = STATUTS[statut];
    return s ? <Badge ton={s.ton} title={s.aide}>{s.libelle}</Badge> : <Badge>{statut}</Badge>;
}

const CASE = "h-4 w-4 cursor-pointer accent-[var(--accent)]";

function correspond(r: FournisseurRow, f: Filtre): boolean {
    if (f === "actifs") return r.actifSql || r.actifQlik;
    if (f === "inactifs") return !r.actifSql && !r.actifQlik;
    if (f === "echecs") return r.dernierSqlStatut === "echec" || r.dernierQlikStatut === "echec";
    return true;
}

/** « Lancement automatique » (planifié la nuit) ou « manuel » (bouton). */
function libelleOrigine(origine: SyncState["origine"]): string {
    return origine === "auto" ? " automatique" : origine === "manuel" ? " manuel" : "";
}

export function SynchronisationClient() {
    const [settings, setSettings] = useState<SyncSettings | null>(null);
    const [state, setState] = useState<SyncState | null>(null);
    const [dansLaFenetre, setDansLaFenetre] = useState(false);
    const [rows, setRows] = useState<FournisseurRow[]>([]);
    const [resume, setResume] = useState<Resume | null>(null);
    const [erreur, setErreur] = useState<string | null>(null);
    const [chargement, setChargement] = useState(true);
    const [recherche, setRecherche] = useState("");
    const [filtre, setFiltre] = useState<Filtre>("tous");
    const [actionEnCours, setActionEnCours] = useState<"start" | "stop" | "seed" | null>(null);

    // ── Lectures pures : aucun setState, pour rester appelables depuis un effet ──
    const lireEtat = useCallback(async () => {
        const res = await fetch("/api/admin/sync");
        if (!res.ok) throw new Error((await res.json()).error ?? `Erreur ${res.status}`);
        return res.json();
    }, []);

    const lireFournisseurs = useCallback(async () => {
        const res = await fetch("/api/admin/sync/fournisseurs");
        if (!res.ok) throw new Error((await res.json()).error ?? `Erreur ${res.status}`);
        return res.json();
    }, []);

    const rafraichirEtat = useCallback(() => {
        lireEtat()
            .then((d) => { setSettings(d.settings); setState(d.state); setDansLaFenetre(d.dansLaFenetre); setErreur(null); })
            .catch((e) => setErreur(e instanceof Error ? e.message : String(e)));
    }, [lireEtat]);

    const rafraichirTout = useCallback(() => {
        Promise.all([lireEtat(), lireFournisseurs()])
            .then(([e, f]) => {
                setSettings(e.settings); setState(e.state); setDansLaFenetre(e.dansLaFenetre);
                setRows(f.fournisseurs ?? []); setResume(f.resume ?? null); setErreur(null);
            })
            .catch((e) => setErreur(e instanceof Error ? e.message : String(e)))
            .finally(() => setChargement(false));
    }, [lireEtat, lireFournisseurs]);

    useEffect(() => { rafraichirTout(); }, [rafraichirTout]);

    const reessayer = () => {
        setChargement(true);
        rafraichirTout();
    };

    // Suivi rapproché pendant un lancement : l'état change à chaque fournisseur.
    useEffect(() => {
        if (!state?.enCours) return;
        const id = setInterval(rafraichirEtat, 3000);
        return () => clearInterval(id);
    }, [state?.enCours, rafraichirEtat]);

    // Saisie numérique pas encore envoyée (cf. majSettingsDifferee).
    const patchEnAttente = useRef<Partial<SyncSettings>>({});
    const minuteurPatch = useRef<ReturnType<typeof setTimeout> | null>(null);

    const majSettings = async (patch: Partial<SyncSettings>) => {
        try {
            const res = await fetch("/api/admin/sync", {
                method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
            });
            const d = await res.json();
            if (!res.ok) throw new Error(d.error ?? `Erreur ${res.status}`);
            // Une saisie faite pendant l'envoi ne doit pas être écrasée par la réponse.
            setSettings({ ...d.settings, ...patchEnAttente.current });
        } catch (e) {
            toast.erreur(`Le réglage n'a pas pu être enregistré : ${e instanceof Error ? e.message : String(e)}`);
        }
    };

    // Champs numériques : la valeur s'affiche tout de suite et l'envoi au serveur
    // est regroupé 600 ms après la dernière frappe. Avant, chaque chiffre tapé
    // partait en PATCH, et une réponse tardive pouvait écraser la saisie en cours.
    const majSettingsDifferee = (patch: Partial<SyncSettings>) => {
        setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
        patchEnAttente.current = { ...patchEnAttente.current, ...patch };
        if (minuteurPatch.current) clearTimeout(minuteurPatch.current);
        minuteurPatch.current = setTimeout(() => {
            const aEnvoyer = patchEnAttente.current;
            patchEnAttente.current = {};
            minuteurPatch.current = null;
            void majSettings(aEnvoyer);
        }, 600);
    };

    const action = async (act: "start" | "stop" | "seed", forcer = false) => {
        setActionEnCours(act);
        try {
            const res = await fetch("/api/admin/sync", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: act, forcer }),
            });
            const d = await res.json();
            if (!res.ok) throw new Error(d.error ?? `Erreur ${res.status}`);
            if (act === "seed") {
                toast.succes(`Liste des fournisseurs actualisée (${fmtEntier(Number(d.fournisseurs) || 0)} dans le référentiel FF).`);
            } else if (act === "stop") {
                toast.info("Arrêt demandé : la mise à jour s'arrête après le fournisseur en cours.");
            }
            rafraichirTout();
        } catch (e) {
            const libelles = { start: "Le lancement a échoué", stop: "L'arrêt a échoué", seed: "La liste n'a pas pu être actualisée" };
            toast.erreur(`${libelles[act]} : ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setActionEnCours(null);
        }
    };

    const lancer = async () => {
        if (!dansLaFenetre) {
            const ok = await confirmer({
                titre: "Lancer la mise à jour maintenant ?",
                message: "Nous sommes en dehors de la plage horaire nocturne : la mise à jour va solliciter la base FF et Qlik en pleine journée, ce qui peut ralentir l'application pour les magasins.",
                libelleConfirmer: "Lancer maintenant",
            });
            if (!ok) return;
        }
        void action("start", !dansLaFenetre);
    };

    const basculer = async (codes: string[], champ: "actifSql" | "actifQlik", valeur: boolean) => {
        if (codes.length === 0) return;
        // Mise à jour optimiste : la liste peut compter des centaines de lignes,
        // un rechargement complet à chaque case cochée serait pénible.
        setRows((prev) => prev.map((r) => (codes.includes(r.codeFournisseur)
            ? { ...r, [champ]: valeur, ...(valeur ? { desactiveMotif: null } : {}) }
            : r)));
        try {
            const res = await fetch("/api/admin/sync/fournisseurs", {
                method: "PATCH", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ codes, [champ]: valeur }),
            });
            if (!res.ok) throw new Error((await res.json()).error ?? `Erreur ${res.status}`);
        } catch (e) {
            toast.erreur(`La modification n'a pas pu être enregistrée : ${e instanceof Error ? e.message : String(e)}`);
            rafraichirTout(); // l'optimisme était infondé : on resynchronise
        }
    };

    const visibles = useMemo(() => {
        const q = recherche.trim().toLowerCase();
        return rows.filter((r) => {
            if (q && !`${r.codeFournisseur} ${r.nomFournisseur ?? ""}`.toLowerCase().includes(q)) return false;
            return correspond(r, filtre);
        });
    }, [rows, recherche, filtre]);

    const codesVisibles = useMemo(() => visibles.map((r) => r.codeFournisseur), [visibles]);

    const basculerEnMasse = async (champ: "actifSql" | "actifQlik", valeur: boolean) => {
        const n = codesVisibles.length;
        if (n === 0) return;
        if (!valeur) {
            const quoi = champ === "actifSql" ? "des ventes (base FF)" : "des données du réseau (Qlik)";
            const ok = await confirmer({
                titre: `Désactiver la mise à jour ${quoi} ?`,
                message: `${fmtEntier(n)} fournisseur${n > 1 ? "s" : ""} de la liste affichée ne ser${n > 1 ? "ont" : "a"} plus mis à jour la nuit pour cette source. Vous pourrez les réactiver à tout moment.`,
                libelleConfirmer: "Désactiver",
                danger: true,
            });
            if (!ok) return;
        }
        void basculer(codesVisibles, champ, valeur);
    };

    const filtres: readonly TabItem<Filtre>[] = useMemo(() => [
        { value: "tous", label: "Tous", count: rows.length },
        { value: "actifs", label: "Actifs", count: rows.filter((r) => correspond(r, "actifs")).length },
        { value: "inactifs", label: "Inactifs", count: rows.filter((r) => correspond(r, "inactifs")).length },
        { value: "echecs", label: "En échec", count: rows.filter((r) => correspond(r, "echecs")).length },
    ], [rows]);

    const colonnes: DataColumn<FournisseurRow>[] = [
        {
            id: "fournisseur",
            header: "Fournisseur",
            sortValue: (r) => r.nomFournisseur ?? r.codeFournisseur,
            cell: (r) => (
                <div className="min-w-[180px]">
                    <div className="font-medium text-[var(--text-primary)]">{r.nomFournisseur ?? r.codeFournisseur}</div>
                    <div className="text-xs text-[var(--text-muted)]">{r.codeFournisseur}</div>
                </div>
            ),
        },
        {
            id: "actifSql",
            header: VENTES,
            hint: "Cochez pour mettre à jour chaque nuit les ventes de ce fournisseur dans nos magasins.",
            align: "center",
            sortValue: (r) => (r.actifSql ? 1 : 0),
            cell: (r) => (
                <input
                    type="checkbox"
                    checked={r.actifSql}
                    className={CASE}
                    aria-label={`Mettre à jour les ventes de ${r.nomFournisseur ?? r.codeFournisseur}`}
                    onChange={(e) => basculer([r.codeFournisseur], "actifSql", e.target.checked)}
                />
            ),
        },
        {
            id: "dernierSql",
            header: "Dernière mise à jour des ventes",
            sortValue: (r) => r.dernierSqlAt,
            cell: (r) => (
                <div className="whitespace-nowrap">
                    <div className="flex items-center gap-2 text-[var(--text-secondary)]">
                        <StatutBadge statut={r.dernierSqlStatut} />
                        {fmtDate(r.dernierSqlAt)}
                    </div>
                    {r.dernierSqlLignes != null && (
                        <div className="text-xs text-[var(--text-muted)]">
                            {fmtEntier(r.dernierSqlLignes)} lignes{r.dernierSqlMs != null && <> en {fmtDuree(r.dernierSqlMs)}</>}
                        </div>
                    )}
                </div>
            ),
        },
        {
            id: "actifQlik",
            header: RESEAU,
            hint: "Cochez pour mettre à jour les ventes de ce fournisseur dans les magasins du réseau. Ces extractions sont longues : leur nombre par nuit est plafonné.",
            align: "center",
            sortValue: (r) => (r.actifQlik ? 1 : 0),
            cell: (r) => (
                <input
                    type="checkbox"
                    checked={r.actifQlik}
                    className={CASE}
                    aria-label={`Mettre à jour les données réseau de ${r.nomFournisseur ?? r.codeFournisseur}`}
                    onChange={(e) => basculer([r.codeFournisseur], "actifQlik", e.target.checked)}
                />
            ),
        },
        {
            id: "dernierQlik",
            header: "Dernière mise à jour réseau",
            sortValue: (r) => r.dernierQlikAt,
            cell: (r) => (
                <div className="whitespace-nowrap">
                    <div className="flex items-center gap-2 text-[var(--text-secondary)]">
                        <StatutBadge statut={r.dernierQlikStatut} />
                        {fmtDate(r.dernierQlikAt)}
                    </div>
                    {r.dernierQlikCodes != null && (
                        <div className="text-xs text-[var(--text-muted)]">{fmtEntier(r.dernierQlikCodes)} produits</div>
                    )}
                </div>
            ),
        },
        {
            id: "remarque",
            header: "Remarque",
            cell: (r) => (r.desactiveMotif
                ? <span className="text-[13px] text-[var(--text-secondary)]">{r.desactiveMotif}</span>
                : null),
        },
    ];

    if (chargement) {
        return (
            <div className="mx-auto w-full max-w-screen-xl">
                <PageHeader icon={CalendarClock} title="Synchronisation" description={DESCRIPTION} />
                <div className="space-y-4" aria-busy="true" aria-label="Chargement">
                    <Skeleton className="h-40 w-full rounded-xl" />
                    <Skeleton className="h-28 w-full rounded-xl" />
                    <Skeleton className="h-96 w-full rounded-xl" />
                </div>
            </div>
        );
    }

    if (!settings && erreur) {
        return (
            <div className="mx-auto w-full max-w-screen-xl">
                <PageHeader icon={CalendarClock} title="Synchronisation" description={DESCRIPTION} />
                <ErrorState
                    title="Les réglages de la synchronisation n'ont pas pu être chargés"
                    detail={erreur}
                    action={<Button variant="outline" onClick={reessayer}>Réessayer</Button>}
                />
            </div>
        );
    }

    return (
        <div className="mx-auto w-full max-w-screen-xl space-y-6">
            <PageHeader
                icon={CalendarClock}
                title="Synchronisation"
                description={DESCRIPTION}
                actions={state?.enCours ? (
                    <Button variant="outline" onClick={() => action("stop")} disabled={actionEnCours === "stop"}
                        className="border-[var(--accent-error)] text-[var(--accent-error)] hover:bg-[var(--accent-error-bg)] hover:text-[var(--accent-error)]">
                        {actionEnCours === "stop" ? <Loader2 className="animate-spin" /> : <Square />}
                        Arrêter
                    </Button>
                ) : (
                    <Button onClick={lancer} disabled={actionEnCours === "start" || !settings}>
                        {actionEnCours === "start" ? <Loader2 className="animate-spin" /> : <Play />}
                        Lancer maintenant
                    </Button>
                )}
            />

            {erreur && (
                <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--accent-error)]/40 bg-[var(--accent-error-bg)] px-4 py-3 text-sm">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--accent-error)]" aria-hidden />
                    <span className="flex-1 text-[var(--text-primary)]">
                        Les informations n&apos;ont pas pu être actualisées : <span className="text-[var(--text-secondary)]">{erreur}</span>
                    </span>
                    <Button variant="outline" size="sm" onClick={rafraichirTout}>Réessayer</Button>
                </div>
            )}

            {/* ── Réglages ── */}
            {settings && (
                <Card>
                    <CardHeader
                        title="Réglages"
                        description="Chaque nuit, dans la plage horaire choisie, les fournisseurs sont mis à jour un par un, en commençant par ceux dont les données sont les plus anciennes. Si la nuit ne suffit pas, la suivante reprend là où la précédente s'est arrêtée."
                    />
                    <CardContent className="space-y-5">
                        <label htmlFor="sync-actif" className="inline-flex cursor-pointer items-center gap-2.5">
                            <input id="sync-actif" type="checkbox" checked={settings.actif}
                                onChange={(e) => majSettings({ actif: e.target.checked })} className={CASE} />
                            <span className="text-sm font-semibold text-[var(--text-primary)]">
                                Synchronisation nocturne activée
                            </span>
                            <Badge ton={settings.actif ? "succes" : "neutre"}>{settings.actif ? "Activée" : "Désactivée"}</Badge>
                        </label>

                        <div className="grid gap-5 md:grid-cols-3">
                            <div>
                                <Label htmlFor="sync-debut">Plage horaire</Label>
                                <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                                    <span>de</span>
                                    <Input id="sync-debut" type="number" min={0} max={23} value={settings.heureDebut}
                                        aria-label="Heure de début"
                                        onChange={(e) => majSettingsDifferee({ heureDebut: Number(e.target.value) })}
                                        className="w-16 text-center tabular-nums" />
                                    <span>h à</span>
                                    <Input id="sync-fin" type="number" min={0} max={23} value={settings.heureFin}
                                        aria-label="Heure de fin"
                                        onChange={(e) => majSettingsDifferee({ heureFin: Number(e.target.value) })}
                                        className="w-16 text-center tabular-nums" />
                                    <span>h</span>
                                </div>
                                <p className="mt-1 text-xs text-[var(--text-muted)]">
                                    Aucun fournisseur n&apos;est commencé après l&apos;heure de fin ; celui en cours va jusqu&apos;au bout.
                                </p>
                            </div>

                            <div>
                                <Label htmlFor="sync-qlik-nuit">Extractions réseau par nuit</Label>
                                <Input id="sync-qlik-nuit" type="number" min={0} max={200} value={settings.qlikParNuit}
                                    onChange={(e) => majSettingsDifferee({ qlikParNuit: Number(e.target.value) })}
                                    className="w-20 text-center tabular-nums" />
                                <p className="mt-1 text-xs text-[var(--text-muted)]">
                                    Une extraction des données du réseau (Qlik) peut durer 8 minutes : ce plafond évite qu&apos;elles occupent toute la nuit.
                                </p>
                            </div>

                            <div>
                                <Label htmlFor="sync-qlik-jours">Fraîcheur des données réseau</Label>
                                <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-secondary)]">
                                    <span>Actualiser les données réseau de plus de</span>
                                    <Input id="sync-qlik-jours" type="number" min={0} max={365} value={settings.qlikMinJours}
                                        onChange={(e) => majSettingsDifferee({ qlikMinJours: Number(e.target.value) })}
                                        className="w-20 text-center tabular-nums" />
                                    <span>jours</span>
                                </div>
                                <p className="mt-1 text-xs text-[var(--text-muted)]">
                                    Ce sont des chiffres mensuels : les refaire chaque nuit coûterait du temps pour rien.
                                    Sont aussi refaits, sans attendre ce délai : les données d&apos;avant le mois en cours
                                    (le dernier mois leur manque) et une extraction en échec, retentée la nuit suivante.
                                </p>
                            </div>
                        </div>
                        <p className="text-xs text-[var(--text-muted)]">Les modifications sont enregistrées automatiquement.</p>
                    </CardContent>
                </Card>
            )}

            {/* ── Lancement en cours ou dernier lancement ── */}
            {state && (
                <Card className={state.enCours ? "border-[var(--accent-border)] bg-[var(--accent-bg)]" : undefined}>
                    <CardContent className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                            {state.enCours
                                ? <Loader2 className="h-5 w-5 animate-spin text-[var(--accent)]" aria-hidden />
                                : state.finAt
                                    ? <CheckCircle2 className="h-5 w-5 text-[var(--accent-success)]" aria-hidden />
                                    : <Clock className="h-5 w-5 text-[var(--text-muted)]" aria-hidden />}
                            <span className="text-base font-semibold text-[var(--text-primary)]">
                                {state.enCours
                                    ? `Lancement${libelleOrigine(state.origine)} en cours`
                                    : state.finAt
                                        ? `Dernier lancement${libelleOrigine(state.origine)} terminé`
                                        : "Aucun lancement depuis le démarrage du serveur"}
                            </span>
                            {state.enCours && state.fournisseurCourant && (
                                <span className="text-sm text-[var(--text-secondary)]">
                                    : {state.etape === "qlik" ? RESEAU : VENTES}, {state.fournisseurCourant}
                                </span>
                            )}
                            {state.tourTermine && (
                                <Badge ton="succes">Tous les fournisseurs ont été traités</Badge>
                            )}
                        </div>

                        {(state.enCours || state.finAt) && (
                            <div className="flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-[var(--text-secondary)]">
                                <span className="inline-flex items-center gap-1.5">
                                    <Database className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />
                                    {VENTES} : {fmtEntier(state.sqlFaits)} à jour
                                    {state.sqlEchecs > 0 && <span className="text-[var(--accent-error)]">, {fmtEntier(state.sqlEchecs)} en échec</span>}
                                </span>
                                <span className="inline-flex items-center gap-1.5">
                                    <Network className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />
                                    {RESEAU} : {fmtEntier(state.qlikFaits)} à jour
                                    {state.qlikEchecs > 0 && <span className="text-[var(--accent-error)]">, {fmtEntier(state.qlikEchecs)} en échec</span>}
                                </span>
                                {state.debutAt && <span>Commencé le {fmtDate(state.debutAt)}</span>}
                                {!state.enCours && state.finAt && <span>Terminé le {fmtDate(state.finAt)}</span>}
                            </div>
                        )}

                        {state.derniereErreur && (
                            <p className="text-[13px] text-[var(--accent-error)]">Dernière erreur : {state.derniereErreur}</p>
                        )}

                        <p className="text-xs text-[var(--text-muted)]">
                            {dansLaFenetre
                                ? "Nous sommes actuellement dans la plage horaire nocturne."
                                : "Hors de la plage horaire : « Lancer maintenant » démarre quand même une mise à jour immédiate."}
                        </p>
                    </CardContent>
                </Card>
            )}

            {/* ── Résumé ── */}
            {resume && (
                <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
                    <StatCard label="Fournisseurs" value={fmtEntier(resume.total)} />
                    <StatCard label={`${VENTES} activées`} value={fmtEntier(resume.actifsSql)} />
                    <StatCard label={`${RESEAU} activé`} value={fmtEntier(resume.actifsQlik)} />
                    <StatCard label="Ventes jamais mises à jour" value={fmtEntier(resume.jamaisSql)} />
                    <StatCard
                        label={
                            <Tooltip content="Fournisseurs sans aucun article dans la base FF : ils ont été retirés de la mise à jour nocturne. Cochez-les à nouveau pour les réintégrer.">
                                <span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-2">Retirés automatiquement</span>
                            </Tooltip>
                        }
                        value={fmtEntier(resume.desactivesAuto)}
                        hint="aucun article dans la base FF"
                    />
                    <StatCard
                        label="En échec"
                        value={fmtEntier(resume.enEchecSql + resume.enEchecQlik)}
                        hint={`${fmtEntier(resume.enEchecSql)} ventes, ${fmtEntier(resume.enEchecQlik)} réseau`}
                    />
                </div>
            )}

            {/* ── Fournisseurs ── */}
            <Card>
                <CardHeader
                    title="Fournisseurs"
                    description="Cochez, pour chaque fournisseur, les données à mettre à jour chaque nuit."
                    actions={
                        <Button variant="outline" size="sm" onClick={() => action("seed")} disabled={actionEnCours === "seed"}
                            title="Ajoute les nouveaux fournisseurs du référentiel FF et met à jour leurs noms">
                            {actionEnCours === "seed" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                            Actualiser la liste des fournisseurs
                        </Button>
                    }
                />
                <CardContent className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2">
                        <span className="text-[13px] text-[var(--text-secondary)]">
                            Pour les <strong className="text-[var(--text-primary)]">{fmtEntier(visibles.length)}</strong> fournisseur{visibles.length > 1 ? "s" : ""} de la liste ci-dessous :
                        </span>
                        <Button variant="outline" size="sm" disabled={visibles.length === 0}
                            onClick={() => basculerEnMasse("actifSql", true)}>
                            Activer les ventes
                        </Button>
                        <Button variant="outline" size="sm" disabled={visibles.length === 0}
                            onClick={() => basculerEnMasse("actifSql", false)}>
                            Désactiver les ventes
                        </Button>
                        <Button variant="outline" size="sm" disabled={visibles.length === 0}
                            onClick={() => basculerEnMasse("actifQlik", false)}>
                            Désactiver le réseau
                        </Button>
                    </div>

                    <DataTable
                        rows={visibles}
                        columns={colonnes}
                        rowKey={(r) => r.codeFournisseur}
                        pageSize={0}
                        unite="fournisseurs"
                        toolbar={
                            <>
                                <Segmented items={filtres} value={filtre} onChange={setFiltre} />
                                <SearchInput
                                    value={recherche}
                                    onChange={setRecherche}
                                    placeholder="Code ou nom du fournisseur"
                                    aria-label="Rechercher un fournisseur"
                                />
                            </>
                        }
                        emptyTitle={rows.length === 0 ? "Aucun fournisseur" : "Aucun fournisseur ne correspond"}
                        emptyDescription={rows.length === 0
                            ? "Utilisez « Actualiser la liste des fournisseurs » pour importer le référentiel FF."
                            : "Modifiez la recherche ou choisissez « Tous »."}
                    />
                </CardContent>
            </Card>
        </div>
    );
}

const DESCRIPTION =
    "Mise à jour nocturne des données des fournisseurs : leurs ventes dans nos magasins (base FF) et dans le réseau (Qlik).";
