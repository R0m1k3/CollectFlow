"use client";

import { useMemo, useState, useTransition, type FormEvent } from "react";
import { AlertTriangle, CalendarClock, Plus, Power, Trash2 } from "lucide-react";
import {
    upsertCadence,
    toggleCadence,
    removeCadence,
    type CadenceView,
    type CadenceStatut,
} from "@/features/commandes-auto/actions";
import { Badge, type Ton } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirmer, toast } from "@/components/ui/feedback";
import { Input, Label } from "@/components/ui/form-controls";
import { EmptyState } from "@/components/ui/states";
import { Terme, Tooltip, InfoBulle } from "@/components/ui/tooltip";
import { MAGASINS, nomMagasin } from "@/lib/magasins";
import { cn } from "@/lib/utils";

type Fournisseur = { code: string; nom: string };
type Resultat = { ok: boolean; error?: string };

const SEMAINES_MIN = 1;
const SEMAINES_MAX = 104;

function fmtDate(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

const pluriel = (n: number, mot: string) => `${n} ${mot}${Math.abs(n) > 1 ? "s" : ""}`;

function tempsRestant(jours: number | null): string {
    if (jours === null) return "Réception inconnue";
    if (jours === 0) return "Aujourd'hui";
    if (jours < 0) return `En retard de ${pluriel(Math.abs(jours), "jour")}`;
    if (jours === 1) return "Demain";
    return `Dans ${pluriel(jours, "jour")}`;
}

const STATUT_META: Record<CadenceStatut, { libelle: string; ton: Ton; explication: string }> = {
    a_commander: {
        libelle: "À commander",
        ton: "erreur",
        explication: "L'échéance est atteinte ou dépassée : passez commande.",
    },
    bientot: {
        libelle: "Bientôt",
        ton: "alerte",
        explication: "L'échéance tombe dans les 7 prochains jours.",
    },
    ok: {
        libelle: "À jour",
        ton: "succes",
        explication: "L'échéance est dans plus de 7 jours.",
    },
    inconnu: {
        libelle: "Inconnu",
        ton: "neutre",
        explication: "Aucune réception connue pour ce fournisseur dans ce magasin : l'échéance ne peut pas être calculée.",
    },
};

function StatutBadge({ cadence }: { cadence: CadenceView }) {
    if (!cadence.actif) {
        return <Badge title="Rappel en pause : aucune alerte pour ce fournisseur.">Désactivé</Badge>;
    }
    const { libelle, ton, explication } = STATUT_META[cadence.statut];
    return (
        <Badge ton={ton} title={explication}>
            {cadence.statut === "a_commander" && <AlertTriangle className="h-3.5 w-3.5" aria-hidden />}
            {libelle}
        </Badge>
    );
}

/** Libellé suivi d'un « i » : explication libre au survol (hors glossaire). */

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

function FormulaireAjout({
    site,
    fournisseurs,
    codesExistants,
    onAjouter,
    pending,
}: {
    site: string;
    fournisseurs: Fournisseur[];
    codesExistants: Set<string>;
    onAjouter: (input: { codefou: string; nomfou: string; semaines: number }) => Promise<boolean>;
    pending: boolean;
}) {
    const [saisie, setSaisie] = useState("");
    const [semaines, setSemaines] = useState("4");
    const [erreur, setErreur] = useState<string | null>(null);
    const idFournisseur = `cadence-fournisseur-${site}`;
    const idSemaines = `cadence-semaines-${site}`;
    const idListe = `cadence-liste-${site}`;
    const idErreur = `cadence-erreur-${site}`;

    // Libellé affiché dans la liste de suggestions → fournisseur
    const parLibelle = useMemo(() => {
        const m = new Map<string, Fournisseur>();
        for (const f of fournisseurs) m.set(`${f.nom} — ${f.code}`, f);
        return m;
    }, [fournisseurs]);

    async function ajouter(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setErreur(null);
        const f = parLibelle.get(saisie.trim());
        if (!f) {
            setErreur("Choisissez un fournisseur dans la liste proposée pendant la saisie.");
            return;
        }
        if (codesExistants.has(f.code)) {
            setErreur("Ce fournisseur a déjà un rappel dans ce magasin : modifiez son rythme dans le tableau ci-dessous.");
            return;
        }
        const n = Number(semaines);
        if (!Number.isInteger(n) || n < SEMAINES_MIN || n > SEMAINES_MAX) {
            setErreur(`Indiquez un nombre entier de semaines, entre ${SEMAINES_MIN} et ${SEMAINES_MAX}.`);
            return;
        }
        // Le formulaire n'est vidé qu'une fois le rappel réellement enregistré.
        if (await onAjouter({ codefou: f.code, nomfou: f.nom, semaines: n })) {
            setSaisie("");
            setSemaines("4");
        }
    }

    return (
        <form
            onSubmit={ajouter}
            className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--bg-surface)] p-4"
        >
            <p className="mb-3 text-sm font-medium text-[var(--text-primary)]">Ajouter un rappel pour ce magasin</p>
            <div className="flex flex-wrap items-end gap-3">
                <div>
                    <Label htmlFor={idFournisseur}>Fournisseur</Label>
                    <Input
                        id={idFournisseur}
                        list={idListe}
                        value={saisie}
                        onChange={(e) => setSaisie(e.target.value)}
                        placeholder="Tapez le nom ou le code…"
                        autoComplete="off"
                        aria-invalid={erreur !== null || undefined}
                        aria-describedby={erreur ? idErreur : undefined}
                        className="w-[300px] max-w-full"
                    />
                    <datalist id={idListe}>
                        {fournisseurs.map((f) => (
                            <option key={f.code} value={`${f.nom} — ${f.code}`} />
                        ))}
                    </datalist>
                </div>
                <div>
                    <Label htmlFor={idSemaines}>Toutes les … semaines</Label>
                    <Input
                        id={idSemaines}
                        type="number"
                        inputMode="numeric"
                        min={SEMAINES_MIN}
                        max={SEMAINES_MAX}
                        step={1}
                        value={semaines}
                        onChange={(e) => setSemaines(e.target.value)}
                        className="w-32"
                    />
                </div>
                <Button type="submit" disabled={pending}>
                    <Plus /> Ajouter le rappel
                </Button>
            </div>
            {erreur && (
                <p id={idErreur} role="alert" className="mt-2 text-[13px] font-medium text-[var(--accent-error)]">
                    {erreur}
                </p>
            )}
        </form>
    );
}

const TH = "whitespace-nowrap border-b border-[var(--border-strong)] px-3 py-2.5 text-left text-[13px] font-semibold text-[var(--text-secondary)]";

function SectionMagasin({
    site,
    rows,
    fournisseurs,
}: {
    site: string;
    rows: CadenceView[];
    fournisseurs: Fournisseur[];
}) {
    const [pending, startTransition] = useTransition();
    const nom = nomMagasin(site);

    const triees = useMemo(() => trier(rows), [rows]);
    const codesExistants = useMemo(() => new Set(rows.map((r) => r.codefou)), [rows]);
    const nbACommander = rows.filter((r) => r.actif && r.statut === "a_commander").length;

    /**
     * Exécute une action serveur et en rend compte : message de réussite, ou
     * message d'erreur (refus de l'action ou exception) — jamais d'échec muet.
     * Pas de router.refresh() : les actions appellent déjà revalidatePath, dont
     * la réponse rafraîchit la page. Les deux ensemble rechargeaient tout deux fois.
     */
    function executer(action: () => Promise<Resultat>, messages: { succes: string; echec: string }): Promise<boolean> {
        return new Promise((resolve) => {
            startTransition(async () => {
                try {
                    const resultat = await action();
                    if (resultat.ok) toast.succes(messages.succes);
                    else toast.erreur(resultat.error ?? messages.echec);
                    resolve(resultat.ok);
                } catch (e) {
                    console.error("[cadencier]", e);
                    toast.erreur(`${messages.echec} Vérifiez votre connexion puis réessayez.`);
                    resolve(false);
                }
            });
        });
    }

    const ajouter = (input: { codefou: string; nomfou: string; semaines: number }) =>
        executer(
            () =>
                upsertCadence({
                    codefou: input.codefou,
                    nomfou: input.nomfou,
                    site,
                    intervalleSemaines: input.semaines,
                    actif: true,
                }),
            {
                succes: `Rappel ajouté : ${input.nomfou}, toutes les ${pluriel(input.semaines, "semaine")}.`,
                echec: "Le rappel n'a pas pu être ajouté.",
            },
        );

    const changerSemaines = (r: CadenceView, semaines: number) =>
        executer(
            () =>
                upsertCadence({
                    codefou: r.codefou,
                    nomfou: r.nomfou,
                    site,
                    intervalleSemaines: semaines,
                    actif: r.actif,
                }),
            {
                succes: `Rythme enregistré : ${r.nomfou}, toutes les ${pluriel(semaines, "semaine")}.`,
                echec: "Le rythme n'a pas pu être enregistré.",
            },
        );

    const basculer = (r: CadenceView) =>
        executer(() => toggleCadence(r.codefou, r.site, !r.actif), {
            succes: r.actif ? `Rappel désactivé : ${r.nomfou}.` : `Rappel réactivé : ${r.nomfou}.`,
            echec: r.actif ? "Le rappel n'a pas pu être désactivé." : "Le rappel n'a pas pu être réactivé.",
        });

    async function supprimer(r: CadenceView) {
        const ok = await confirmer({
            titre: "Supprimer ce rappel ?",
            message: `Le rythme de commande de ${r.nomfou} pour ${nom} sera supprimé. Pour simplement suspendre les alertes, utilisez plutôt « Désactiver ».`,
            libelleConfirmer: "Supprimer",
            danger: true,
        });
        if (!ok) return;
        await executer(() => removeCadence(r.codefou, r.site), {
            succes: `Rappel supprimé : ${r.nomfou}.`,
            echec: "Le rappel n'a pas pu être supprimé.",
        });
    }

    return (
        <section className="space-y-3" aria-label={`Rythme de commande — ${nom}`}>
            <div className="flex flex-wrap items-center gap-2">
                <h2 className="mr-1 text-lg font-semibold text-[var(--text-primary)]">{nom}</h2>
                <Badge>
                    {pluriel(rows.length, "fournisseur")} suivi{rows.length > 1 ? "s" : ""}
                </Badge>
                {nbACommander > 0 && (
                    <Badge ton="erreur">
                        <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {nbACommander} à commander
                    </Badge>
                )}
            </div>

            <FormulaireAjout
                site={site}
                fournisseurs={fournisseurs}
                codesExistants={codesExistants}
                onAjouter={ajouter}
                pending={pending}
            />

            {triees.length === 0 ? (
                <EmptyState
                    icon={CalendarClock}
                    className="py-8"
                    title="Aucun rappel pour ce magasin"
                    description="Ajoutez un fournisseur avec le formulaire ci-dessus pour être prévenu quand il faut lui passer commande."
                />
            ) : (
                <div
                    aria-busy={pending}
                    className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] shadow-[var(--shadow-sm)]"
                >
                    <table className="min-w-full text-sm">
                        <thead className="bg-[var(--bg-elevated)]">
                            <tr>
                                <th scope="col" className={TH}>Fournisseur</th>
                                <th scope="col" className={TH}>Rythme</th>
                                <th scope="col" className={TH}>Dernière réception</th>
                                <th scope="col" className={TH}>
                                    <InfoBulle explication="Date de la dernière réception du fournisseur dans ce magasin, plus le rythme choisi.">
                                        Prochaine commande
                                    </InfoBulle>
                                </th>
                                <th scope="col" className={TH}>Temps restant</th>
                                <th scope="col" className={TH}>Statut</th>
                                <th scope="col" className={cn(TH, "text-right")}>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {triees.map((r) => {
                                const urgent = r.actif && r.statut === "a_commander";
                                const texte = r.actif ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]";
                                return (
                                    <tr
                                        key={`${r.site}-${r.codefou}`}
                                        className={cn(
                                            "border-b border-[var(--border)] last:border-b-0",
                                            urgent ? "bg-[var(--accent-error-bg)]" : "hover:bg-[var(--bg-elevated)]",
                                        )}
                                    >
                                        <td className={cn("px-3 py-2", texte)}>
                                            <div className="font-medium">{r.nomfou}</div>
                                            <div className="text-xs text-[var(--text-muted)]">Code {r.codefou}</div>
                                        </td>
                                        <td className={cn("whitespace-nowrap px-3 py-2", texte)}>
                                            <span className="inline-flex items-center gap-2">
                                                Toutes les
                                                <Input
                                                    // Remonté quand la valeur enregistrée change (après revalidation).
                                                    key={r.intervalleSemaines}
                                                    type="number"
                                                    inputMode="numeric"
                                                    min={SEMAINES_MIN}
                                                    max={SEMAINES_MAX}
                                                    step={1}
                                                    defaultValue={r.intervalleSemaines}
                                                    aria-label={`Rythme de commande de ${r.nomfou}, en semaines`}
                                                    title="Modifiez le nombre puis quittez le champ (ou appuyez sur Entrée) pour l'enregistrer."
                                                    onKeyDown={(e) => {
                                                        if (e.key === "Enter") e.currentTarget.blur();
                                                    }}
                                                    onBlur={(e) => {
                                                        const champ = e.currentTarget;
                                                        const brut = champ.value.trim();
                                                        const v = Number(brut);
                                                        if (brut !== "" && v === r.intervalleSemaines) return;
                                                        if (brut === "" || !Number.isInteger(v) || v < SEMAINES_MIN || v > SEMAINES_MAX) {
                                                            champ.value = String(r.intervalleSemaines);
                                                            toast.erreur(
                                                                `Rythme non enregistré : indiquez un nombre entier de semaines, entre ${SEMAINES_MIN} et ${SEMAINES_MAX}.`,
                                                            );
                                                            return;
                                                        }
                                                        void changerSemaines(r, v).then((ok) => {
                                                            if (!ok) champ.value = String(r.intervalleSemaines);
                                                        });
                                                    }}
                                                    className="h-8 w-20 px-2 text-center"
                                                />
                                                semaines
                                            </span>
                                        </td>
                                        <td className={cn("whitespace-nowrap px-3 py-2 tabular-nums", r.actif ? "text-[var(--text-secondary)]" : texte)}>
                                            {fmtDate(r.derniereReception)}
                                        </td>
                                        <td className={cn("whitespace-nowrap px-3 py-2 font-medium tabular-nums", texte)}>
                                            {fmtDate(r.echeance)}
                                        </td>
                                        <td
                                            className={cn(
                                                "whitespace-nowrap px-3 py-2 font-semibold",
                                                urgent ? "text-[var(--accent-error)]" : texte,
                                            )}
                                        >
                                            {tempsRestant(r.joursRestants)}
                                        </td>
                                        <td className="px-3 py-2">
                                            <StatutBadge cadence={r} />
                                        </td>
                                        <td className="px-3 py-2">
                                            <div className="flex items-center justify-end gap-1.5">
                                                <Tooltip
                                                    content={
                                                        r.actif
                                                            ? "Mettre les alertes en pause, sans perdre le rythme choisi."
                                                            : "Reprendre les alertes pour ce fournisseur."
                                                    }
                                                >
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => void basculer(r)}
                                                        disabled={pending}
                                                        aria-label={`${r.actif ? "Désactiver" : "Réactiver"} le rappel de ${r.nomfou}`}
                                                    >
                                                        <Power /> {r.actif ? "Désactiver" : "Réactiver"}
                                                    </Button>
                                                </Tooltip>
                                                <Tooltip content="Supprimer définitivement ce rappel.">
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={() => void supprimer(r)}
                                                        disabled={pending}
                                                        aria-label={`Supprimer le rappel de ${r.nomfou}`}
                                                        className="text-[var(--accent-error)] hover:bg-[var(--accent-error-bg)] hover:text-[var(--accent-error)]"
                                                    >
                                                        <Trash2 /> Supprimer
                                                    </Button>
                                                </Tooltip>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}

export function CadencierClient({
    cadences,
    fournisseurs,
}: {
    cadences: CadenceView[];
    fournisseurs: Fournisseur[];
}) {
    const parMagasin = useMemo(() => {
        const m = new Map<string, CadenceView[]>();
        for (const c of cadences) {
            if (!m.has(c.site)) m.set(c.site, []);
            m.get(c.site)!.push(c);
        }
        return m;
    }, [cadences]);

    return (
        <div className="space-y-10">
            <div className="flex items-start gap-3 rounded-xl border border-[var(--accent-border)] bg-[var(--accent-bg)] px-4 py-3 text-sm text-[var(--text-primary)]">
                <CalendarClock className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent)]" aria-hidden />
                <p>
                    Le <Terme id="cadencier">cadencier</Terme> vous rappelle quand commander : pour chaque fournisseur suivi,
                    choisissez un rythme (toutes les X semaines). La prochaine commande est calculée à partir de la{" "}
                    <strong>dernière réception</strong> du fournisseur dans le magasin. Le statut passe à « Bientôt » dans les
                    7 jours qui précèdent, puis à « À commander » le jour venu.
                </p>
            </div>
            {MAGASINS.map((m) => (
                <SectionMagasin key={m.code} site={m.code} rows={parMagasin.get(m.code) ?? []} fournisseurs={fournisseurs} />
            ))}
        </div>
    );
}
