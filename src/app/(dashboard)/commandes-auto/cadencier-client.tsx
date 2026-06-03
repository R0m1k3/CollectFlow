"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
    AlertTriangle,
    CalendarClock,
    CheckCircle2,
    HelpCircle,
    Plus,
    Power,
    Trash2,
} from "lucide-react";
import {
    upsertCadence,
    toggleCadence,
    removeCadence,
    type CadenceView,
    type CadenceStatut,
} from "@/features/commandes-auto/actions";

const SITES: { code: string; label: string }[] = [
    { code: "292", label: "292 — Frouard / Nancy" },
    { code: "579", label: "579 — Houdemont" },
];

function fmtDate(iso: string | null): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function tempsRestant(jours: number | null): string {
    if (jours === null) return "Réception inconnue";
    if (jours === 0) return "Aujourd'hui";
    if (jours < 0) return `En retard de ${Math.abs(jours)} j`;
    if (jours === 1) return "Demain";
    return `Dans ${jours} j`;
}

const STATUT_META: Record<CadenceStatut, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
    a_commander: { label: "À commander", cls: "bg-red-100 text-red-700", Icon: AlertTriangle },
    bientot: { label: "Bientôt", cls: "bg-amber-100 text-amber-700", Icon: CalendarClock },
    ok: { label: "OK", cls: "bg-emerald-100 text-emerald-700", Icon: CheckCircle2 },
    inconnu: { label: "Inconnu", cls: "bg-gray-100 text-gray-500", Icon: HelpCircle },
};

function StatutBadge({ statut }: { statut: CadenceStatut }) {
    const { label, cls, Icon } = STATUT_META[statut];
    return (
        <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
            <Icon className="h-3 w-3" /> {label}
        </span>
    );
}

/** Tri : à commander d'abord (plus en retard en tête), puis bientôt, ok, inconnu, et inactifs en dernier. */
function trier(rows: CadenceView[]): CadenceView[] {
    const rank: Record<CadenceStatut, number> = { a_commander: 0, bientot: 1, ok: 2, inconnu: 3 };
    return [...rows].sort((a, b) => {
        if (a.actif !== b.actif) return a.actif ? -1 : 1;
        if (a.statut !== b.statut) return rank[a.statut] - rank[b.statut];
        const ja = a.joursRestants ?? Number.POSITIVE_INFINITY;
        const jb = b.joursRestants ?? Number.POSITIVE_INFINITY;
        return ja - jb;
    });
}

function AddCadenceForm({
    site,
    fournisseurs,
    existingCodes,
    onDone,
    pending,
}: {
    site: string;
    fournisseurs: { code: string; nom: string }[];
    existingCodes: Set<string>;
    onDone: (input: { codefou: string; nomfou: string; semaines: number }) => void;
    pending: boolean;
}) {
    const [value, setValue] = useState("");
    const [semaines, setSemaines] = useState(4);
    const [err, setErr] = useState<string | null>(null);
    const listId = `fou-list-${site}`;

    // label affiché dans le datalist → fournisseur
    const byLabel = useMemo(() => {
        const m = new Map<string, { code: string; nom: string }>();
        for (const f of fournisseurs) m.set(`${f.nom} — ${f.code}`, f);
        return m;
    }, [fournisseurs]);

    function submit() {
        setErr(null);
        const f = byLabel.get(value.trim());
        if (!f) {
            setErr("Sélectionnez un fournisseur dans la liste.");
            return;
        }
        if (existingCodes.has(f.code)) {
            setErr("Ce fournisseur est déjà cadencé sur ce magasin.");
            return;
        }
        if (!Number.isFinite(semaines) || semaines < 1 || semaines > 104) {
            setErr("Intervalle : 1 à 104 semaines.");
            return;
        }
        onDone({ codefou: f.code, nomfou: f.nom, semaines });
        setValue("");
        setSemaines(4);
    }

    return (
        <div className="flex flex-wrap items-end gap-3 rounded-xl border border-dashed border-gray-300 bg-gray-50 p-3">
            <div className="flex flex-col">
                <label className="mb-1 text-xs font-medium text-gray-500">Fournisseur</label>
                <input
                    list={listId}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder="Rechercher…"
                    className="min-w-[260px] rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <datalist id={listId}>
                    {fournisseurs.map((f) => (
                        <option key={f.code} value={`${f.nom} — ${f.code}`} />
                    ))}
                </datalist>
            </div>
            <div className="flex flex-col">
                <label className="mb-1 text-xs font-medium text-gray-500">Toutes les (semaines)</label>
                <input
                    type="number"
                    min={1}
                    max={104}
                    value={semaines}
                    onChange={(e) => setSemaines(parseInt(e.target.value, 10))}
                    className="w-28 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
            </div>
            <button
                type="button"
                onClick={submit}
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
                <Plus className="h-4 w-4" /> Activer l&apos;alerte
            </button>
            {err && <span className="text-xs font-medium text-red-600">{err}</span>}
        </div>
    );
}

function SiteSection({
    site,
    label,
    rows,
    fournisseurs,
}: {
    site: string;
    label: string;
    rows: CadenceView[];
    fournisseurs: { code: string; nom: string }[];
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();

    const sorted = useMemo(() => trier(rows), [rows]);
    const existingCodes = useMemo(() => new Set(rows.map((r) => r.codefou)), [rows]);
    const nbACommander = rows.filter((r) => r.actif && r.statut === "a_commander").length;

    function run(fn: () => Promise<unknown>) {
        startTransition(async () => {
            await fn();
            router.refresh();
        });
    }

    const add = (input: { codefou: string; nomfou: string; semaines: number }) =>
        run(() =>
            upsertCadence({
                codefou: input.codefou,
                nomfou: input.nomfou,
                site,
                intervalleSemaines: input.semaines,
                actif: true,
            }),
        );

    const changeSemaines = (r: CadenceView, semaines: number) =>
        run(() =>
            upsertCadence({
                codefou: r.codefou,
                nomfou: r.nomfou,
                site,
                intervalleSemaines: semaines,
                actif: r.actif,
            }),
        );

    return (
        <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-bold text-gray-900">{label}</h2>
                <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-700">
                    {rows.length} cadencé{rows.length !== 1 ? "s" : ""}
                </span>
                {nbACommander > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-700">
                        <AlertTriangle className="h-3 w-3" /> {nbACommander} à commander
                    </span>
                )}
            </div>

            <AddCadenceForm
                site={site}
                fournisseurs={fournisseurs}
                existingCodes={existingCodes}
                onDone={add}
                pending={pending}
            />

            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                <table className="min-w-full text-sm">
                    <thead className="border-b border-gray-200 bg-gray-50">
                        <tr>
                            <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-600">Code</th>
                            <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-600">Fournisseur</th>
                            <th className="px-3 py-2.5 text-center text-xs font-semibold uppercase tracking-wide text-gray-600">Toutes les</th>
                            <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-600">Dernière réception</th>
                            <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-600">Prochaine commande</th>
                            <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-600">Temps restant</th>
                            <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-600">Statut</th>
                            <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-gray-600">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {sorted.length === 0 && (
                            <tr>
                                <td colSpan={8} className="px-3 py-8 text-center text-gray-400">
                                    Aucun fournisseur cadencé sur ce magasin. Ajoutez-en un ci-dessus.
                                </td>
                            </tr>
                        )}
                        {sorted.map((r) => {
                            const urgent = r.actif && r.statut === "a_commander";
                            return (
                                <tr
                                    key={`${r.site}-${r.codefou}`}
                                    className={[
                                        "transition-colors",
                                        !r.actif ? "opacity-50" : "",
                                        urgent ? "bg-red-50/60 hover:bg-red-50" : "hover:bg-gray-50",
                                    ].join(" ")}
                                >
                                    <td className="px-3 py-2.5 font-mono text-xs text-gray-500">{r.codefou}</td>
                                    <td className="px-3 py-2.5 font-medium text-gray-900">{r.nomfou}</td>
                                    <td className="px-3 py-2.5 text-center">
                                        <span className="inline-flex items-center gap-1">
                                            <input
                                                type="number"
                                                min={1}
                                                max={104}
                                                defaultValue={r.intervalleSemaines}
                                                onBlur={(e) => {
                                                    const v = parseInt(e.target.value, 10);
                                                    if (v && v !== r.intervalleSemaines && v >= 1 && v <= 104) changeSemaines(r, v);
                                                }}
                                                className="w-16 rounded-md border border-gray-200 px-2 py-1 text-center text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                            />
                                            <span className="text-xs text-gray-400">sem.</span>
                                        </span>
                                    </td>
                                    <td className="px-3 py-2.5 text-gray-600">{fmtDate(r.derniereReception)}</td>
                                    <td className="px-3 py-2.5 font-medium text-gray-800">{fmtDate(r.echeance)}</td>
                                    <td className={["px-3 py-2.5 font-semibold", urgent ? "text-red-700" : "text-gray-700"].join(" ")}>
                                        {tempsRestant(r.joursRestants)}
                                    </td>
                                    <td className="px-3 py-2.5">
                                        <StatutBadge statut={r.actif ? r.statut : "inconnu"} />
                                    </td>
                                    <td className="px-3 py-2.5">
                                        <div className="flex items-center justify-end gap-1">
                                            <button
                                                type="button"
                                                title={r.actif ? "Désactiver" : "Réactiver"}
                                                onClick={() => run(() => toggleCadence(r.codefou, r.site, !r.actif))}
                                                disabled={pending}
                                                className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800 disabled:opacity-50"
                                            >
                                                <Power className="h-4 w-4" />
                                            </button>
                                            <button
                                                type="button"
                                                title="Supprimer"
                                                onClick={() => run(() => removeCadence(r.codefou, r.site))}
                                                disabled={pending}
                                                className="rounded-md p-1.5 text-gray-500 hover:bg-red-100 hover:text-red-700 disabled:opacity-50"
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

export function CadencierClient({
    cadences,
    fournisseurs,
}: {
    cadences: CadenceView[];
    fournisseurs: { code: string; nom: string }[];
}) {
    const bySite = useMemo(() => {
        const m = new Map<string, CadenceView[]>();
        for (const c of cadences) {
            if (!m.has(c.site)) m.set(c.site, []);
            m.get(c.site)!.push(c);
        }
        return m;
    }, [cadences]);

    return (
        <div className="space-y-10">
            <p className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
                Activez un fournisseur en alerte de commande sur un magasin et définissez sa fréquence
                (toutes les X semaines). L&apos;échéance est calculée à partir de la{" "}
                <strong>dernière réception</strong> du fournisseur sur le magasin.
            </p>
            {SITES.map(({ code, label }) => (
                <SiteSection
                    key={code}
                    site={code}
                    label={label}
                    rows={bySite.get(code) ?? []}
                    fournisseurs={fournisseurs}
                />
            ))}
        </div>
    );
}
