"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
    CalendarClock, Play, Square, RefreshCw, Loader2, AlertTriangle,
    CheckCircle, Database, Network, Search,
} from "lucide-react";
import { cn } from "@/lib/utils";

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

const fmtDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "jamais";
const fmtDuree = (ms: number | null) =>
    ms == null ? "" : ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;

function Pastille({ statut }: { statut: string | null }) {
    if (!statut) return <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>—</span>;
    const couleurs: Record<string, string> = {
        succes: "text-emerald-500", echec: "text-red-500", vide: "text-amber-500",
    };
    const libelles: Record<string, string> = { succes: "ok", echec: "échec", vide: "vide" };
    return <span className={cn("text-[11px] font-semibold", couleurs[statut] ?? "")}>{libelles[statut] ?? statut}</span>;
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
    const [filtre, setFiltre] = useState<"tous" | "actifs" | "inactifs" | "echecs">("tous");

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

    // Suivi rapproché pendant un round : l'état change à chaque fournisseur.
    useEffect(() => {
        if (!state?.enCours) return;
        const id = setInterval(rafraichirEtat, 3000);
        return () => clearInterval(id);
    }, [state?.enCours, rafraichirEtat]);

    const majSettings = async (patch: Partial<SyncSettings>) => {
        setErreur(null);
        try {
            const res = await fetch("/api/admin/sync", {
                method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
            });
            const d = await res.json();
            if (!res.ok) throw new Error(d.error ?? `Erreur ${res.status}`);
            setSettings(d.settings);
        } catch (e) { setErreur(e instanceof Error ? e.message : String(e)); }
    };

    const action = async (act: "start" | "stop" | "seed", forcer = false) => {
        setErreur(null);
        try {
            const res = await fetch("/api/admin/sync", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: act, forcer }),
            });
            const d = await res.json();
            if (!res.ok) throw new Error(d.error ?? `Erreur ${res.status}`);
            rafraichirTout();
        } catch (e) { setErreur(e instanceof Error ? e.message : String(e)); }
    };

    const basculer = async (codes: string[], champ: "actifSql" | "actifQlik", valeur: boolean) => {
        setErreur(null);
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
            setErreur(e instanceof Error ? e.message : String(e));
            rafraichirTout(); // l'optimisme était infondé : on resynchronise
        }
    };

    const visibles = useMemo(() => {
        const q = recherche.trim().toLowerCase();
        return rows.filter((r) => {
            if (q && !`${r.codeFournisseur} ${r.nomFournisseur ?? ""}`.toLowerCase().includes(q)) return false;
            if (filtre === "actifs") return r.actifSql || r.actifQlik;
            if (filtre === "inactifs") return !r.actifSql && !r.actifQlik;
            if (filtre === "echecs") return r.dernierSqlStatut === "echec" || r.dernierQlikStatut === "echec";
            return true;
        });
    }, [rows, recherche, filtre]);

    const codesVisibles = useMemo(() => visibles.map((r) => r.codeFournisseur), [visibles]);

    return (
        <div className="min-h-screen p-6" style={{ background: "var(--bg-base)" }}>
            <div className="mx-auto max-w-screen-xl">
                <h1 className="text-2xl font-bold flex items-center gap-2" style={{ color: "var(--text-primary)" }}>
                    <CalendarClock className="w-6 h-6" style={{ color: "var(--accent)" }} />
                    Synchronisation nocturne
                </h1>
                <p className="text-[13px] mt-1 mb-5" style={{ color: "var(--text-muted)" }}>
                    Les fournisseurs sont traités du plus anciennement synchronisé au plus récent. Si la fenêtre
                    se referme avant la fin, la nuit suivante reprend là où on s&apos;est arrêté ; quand tout le
                    monde est passé, un nouveau tour recommence.
                </p>

                {erreur && (
                    <div className="rounded-xl p-3.5 mb-4 flex items-start gap-2.5 text-[13px]"
                        style={{ background: "var(--accent-error-bg)", border: "1px solid var(--accent-error)", color: "var(--accent-error)" }}>
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                        <span>{erreur}</span>
                    </div>
                )}

                {/* ── Réglages ── */}
                {settings && (
                    <div className="rounded-2xl p-4 mb-4" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
                        <div className="flex flex-wrap items-end gap-4">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" checked={settings.actif}
                                    onChange={(e) => majSettings({ actif: e.target.checked })} className="w-4 h-4" />
                                <span className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
                                    Synchronisation nocturne active
                                </span>
                            </label>

                            <div className="flex items-end gap-2">
                                <div>
                                    <label className="block text-[11px] mb-1" style={{ color: "var(--text-muted)" }}>De</label>
                                    <input type="number" min={0} max={23} value={settings.heureDebut}
                                        onChange={(e) => majSettings({ heureDebut: Number(e.target.value) })}
                                        className="w-16 rounded-lg px-2 py-1.5 text-[13px]"
                                        style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }} />
                                </div>
                                <span className="pb-2 text-[13px]" style={{ color: "var(--text-muted)" }}>h à</span>
                                <div>
                                    <label className="block text-[11px] mb-1" style={{ color: "var(--text-muted)" }}>À</label>
                                    <input type="number" min={0} max={23} value={settings.heureFin}
                                        onChange={(e) => majSettings({ heureFin: Number(e.target.value) })}
                                        className="w-16 rounded-lg px-2 py-1.5 text-[13px]"
                                        style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }} />
                                </div>
                                <span className="pb-2 text-[13px]" style={{ color: "var(--text-muted)" }}>h</span>
                            </div>

                            <div>
                                <label className="block text-[11px] mb-1" style={{ color: "var(--text-muted)" }}>Qlik / nuit</label>
                                <input type="number" min={0} max={200} value={settings.qlikParNuit}
                                    onChange={(e) => majSettings({ qlikParNuit: Number(e.target.value) })}
                                    className="w-20 rounded-lg px-2 py-1.5 text-[13px]"
                                    style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }} />
                            </div>
                            <div>
                                <label className="block text-[11px] mb-1" style={{ color: "var(--text-muted)" }}>Qlik si + vieux que</label>
                                <input type="number" min={0} max={365} value={settings.qlikMinJours}
                                    onChange={(e) => majSettings({ qlikMinJours: Number(e.target.value) })}
                                    className="w-20 rounded-lg px-2 py-1.5 text-[13px]"
                                    style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }} />
                            </div>

                            <div className="flex-1" />

                            {state?.enCours ? (
                                <button onClick={() => action("stop")} className="rounded-xl px-4 py-2 text-[13px] font-semibold flex items-center gap-2"
                                    style={{ background: "var(--accent-error-bg)", color: "var(--accent-error)", border: "1px solid var(--accent-error)" }}>
                                    <Square className="w-3.5 h-3.5" /> Arrêter
                                </button>
                            ) : (
                                <button onClick={() => action("start", !dansLaFenetre)} className="rounded-xl px-4 py-2 text-[13px] font-semibold text-white flex items-center gap-2"
                                    style={{ background: "var(--accent)" }}>
                                    <Play className="w-3.5 h-3.5" /> Lancer maintenant
                                </button>
                            )}
                        </div>

                        <p className="text-[11px] mt-3" style={{ color: "var(--text-muted)" }}>
                            {dansLaFenetre
                                ? "Nous sommes actuellement dans la fenêtre."
                                : "Hors fenêtre — « Lancer maintenant » forcera un round immédiat."}
                            {" "}Une extraction Qlik peut durer 8 minutes : le plafond par nuit évite qu&apos;elle
                            monopolise la fenêtre. Un fournisseur déjà démarré n&apos;est jamais interrompu à l&apos;heure de fin.
                        </p>
                    </div>
                )}

                {/* ── Round en cours ── */}
                {state && (state.enCours || state.finAt) && (
                    <div className="rounded-2xl p-4 mb-4 text-[13px]"
                        style={{ background: state.enCours ? "var(--accent-bg)" : "var(--bg-surface)", border: `1px solid ${state.enCours ? "var(--accent-border)" : "var(--border)"}` }}>
                        <div className="flex items-center gap-2 flex-wrap">
                            {state.enCours
                                ? <Loader2 className="w-4 h-4 animate-spin" style={{ color: "var(--accent)" }} />
                                : <CheckCircle className="w-4 h-4 text-emerald-500" />}
                            <span className="font-semibold" style={{ color: "var(--text-primary)" }}>
                                {state.enCours ? `Round ${state.origine} en cours` : "Dernier round terminé"}
                            </span>
                            {state.enCours && state.fournisseurCourant && (
                                <span style={{ color: "var(--text-secondary)" }}>
                                    — {state.etape === "qlik" ? "Qlik" : "SQL"} : {state.fournisseurCourant}
                                </span>
                            )}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px]" style={{ color: "var(--text-secondary)" }}>
                            <span><Database className="w-3 h-3 inline mr-1" />SQL : {state.sqlFaits} ok{state.sqlEchecs > 0 && `, ${state.sqlEchecs} en échec`}</span>
                            <span><Network className="w-3 h-3 inline mr-1" />Qlik : {state.qlikFaits} ok{state.qlikEchecs > 0 && `, ${state.qlikEchecs} en échec`}</span>
                            {state.debutAt && <span>Début {fmtDate(state.debutAt)}</span>}
                            {state.tourTermine && <span className="text-emerald-500 font-semibold">Tour bouclé — tout le monde est à jour</span>}
                        </div>
                        {state.derniereErreur && (
                            <p className="mt-2 text-[11px] text-red-400">Dernière erreur : {state.derniereErreur}</p>
                        )}
                    </div>
                )}

                {/* ── Résumé ── */}
                {resume && (
                    <div className="flex flex-wrap gap-2 mb-3 text-[12px]">
                        {[
                            { l: "Fournisseurs", v: resume.total },
                            { l: "Actifs SQL", v: resume.actifsSql },
                            { l: "Actifs Qlik", v: resume.actifsQlik },
                            { l: "Jamais synchronisés", v: resume.jamaisSql },
                            { l: "Désactivés auto", v: resume.desactivesAuto },
                            { l: "En échec", v: resume.enEchecSql + resume.enEchecQlik },
                        ].map((s) => (
                            <span key={s.l} className="rounded-lg px-2.5 py-1"
                                style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
                                {s.l} <strong style={{ color: "var(--text-primary)" }}>{s.v}</strong>
                            </span>
                        ))}
                    </div>
                )}

                {/* ── Filtres et actions de masse ── */}
                <div className="flex flex-wrap items-center gap-2 mb-3">
                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: "var(--text-muted)" }} />
                        <input value={recherche} onChange={(e) => setRecherche(e.target.value)} placeholder="Code ou nom"
                            className="rounded-lg pl-8 pr-3 py-1.5 text-[12px] w-56"
                            style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }} />
                    </div>
                    {(["tous", "actifs", "inactifs", "echecs"] as const).map((f) => (
                        <button key={f} onClick={() => setFiltre(f)}
                            className="rounded-full px-3 py-1 text-[12px] font-semibold"
                            style={{
                                background: filtre === f ? "var(--accent)" : "var(--bg-elevated)",
                                color: filtre === f ? "#fff" : "var(--text-secondary)",
                                border: "1px solid var(--border)",
                            }}>
                            {f === "echecs" ? "en échec" : f}
                        </button>
                    ))}
                    <div className="flex-1" />
                    <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>{visibles.length} affichés :</span>
                    <button onClick={() => basculer(codesVisibles, "actifSql", true)} className="rounded-lg px-2.5 py-1 text-[11px]"
                        style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
                        Activer SQL
                    </button>
                    <button onClick={() => basculer(codesVisibles, "actifSql", false)} className="rounded-lg px-2.5 py-1 text-[11px]"
                        style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
                        Désactiver SQL
                    </button>
                    <button onClick={() => basculer(codesVisibles, "actifQlik", false)} className="rounded-lg px-2.5 py-1 text-[11px]"
                        style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
                        Désactiver Qlik
                    </button>
                    <button onClick={() => action("seed")} title="Récupérer les nouveaux fournisseurs du référentiel"
                        className="rounded-lg px-2.5 py-1 text-[11px] flex items-center gap-1"
                        style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
                        <RefreshCw className="w-3 h-3" /> Actualiser la liste
                    </button>
                </div>

                {/* ── Tableau ── */}
                <div className="rounded-2xl overflow-hidden" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
                    {chargement ? (
                        <div className="p-6 text-center text-[13px]" style={{ color: "var(--text-muted)" }}>
                            <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Chargement…
                        </div>
                    ) : visibles.length === 0 ? (
                        <div className="p-6 text-center text-[13px]" style={{ color: "var(--text-muted)" }}>
                            Aucun fournisseur. Utilisez « Actualiser la liste » pour importer le référentiel.
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-[12px] border-collapse">
                                <thead>
                                    <tr style={{ background: "var(--bg-elevated)" }}>
                                        {["Fournisseur", "SQL", "Dernier SQL", "Qlik", "Dernier Qlik", ""].map((h) => (
                                            <th key={h} className="px-3 py-2.5 text-left font-semibold whitespace-nowrap"
                                                style={{ color: "var(--text-secondary)", borderBottom: "1px solid var(--border)" }}>{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {visibles.map((r) => (
                                        <tr key={r.codeFournisseur} style={{ borderBottom: "1px solid var(--border)" }}>
                                            <td className="px-3 py-2">
                                                <div className="font-medium" style={{ color: "var(--text-primary)" }}>
                                                    {r.nomFournisseur ?? r.codeFournisseur}
                                                </div>
                                                <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>{r.codeFournisseur}</div>
                                            </td>
                                            <td className="px-3 py-2">
                                                <input type="checkbox" checked={r.actifSql} className="w-4 h-4"
                                                    onChange={(e) => basculer([r.codeFournisseur], "actifSql", e.target.checked)} />
                                            </td>
                                            <td className="px-3 py-2 whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
                                                <Pastille statut={r.dernierSqlStatut} />{" "}
                                                {fmtDate(r.dernierSqlAt)}
                                                {r.dernierSqlLignes != null && <span style={{ color: "var(--text-muted)" }}> · {r.dernierSqlLignes.toLocaleString("fr-FR")} lignes {fmtDuree(r.dernierSqlMs)}</span>}
                                            </td>
                                            <td className="px-3 py-2">
                                                <input type="checkbox" checked={r.actifQlik} className="w-4 h-4"
                                                    onChange={(e) => basculer([r.codeFournisseur], "actifQlik", e.target.checked)} />
                                            </td>
                                            <td className="px-3 py-2 whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
                                                <Pastille statut={r.dernierQlikStatut} />{" "}
                                                {fmtDate(r.dernierQlikAt)}
                                                {r.dernierQlikCodes != null && <span style={{ color: "var(--text-muted)" }}> · {r.dernierQlikCodes.toLocaleString("fr-FR")} codes</span>}
                                            </td>
                                            <td className="px-3 py-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
                                                {r.desactiveMotif}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
