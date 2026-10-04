"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { KeyRound, Loader2, Shield, Trash2, User, UserPlus } from "lucide-react";
import { getUsers, createUser, deleteUser, updatePassword } from "../api/user-actions";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Select } from "@/components/ui/form-controls";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/states";
import { confirmer, toast } from "@/components/ui/feedback";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { isStaleServerActionError, STALE_ACTION_MESSAGE } from "@/lib/stale-action";

type Utilisateur = Awaited<ReturnType<typeof getUsers>>[number];
type Role = "admin" | "user";

const ROLES = [
    { value: "user", label: "Utilisateur" },
    { value: "admin", label: "Administrateur" },
] as const;

function messageErreur(e: unknown): string {
    if (isStaleServerActionError(e)) return STALE_ACTION_MESSAGE;
    return e instanceof Error ? e.message : String(e);
}

function fmtJour(valeur: Date | string | null | undefined): string {
    if (!valeur) return "—";
    const d = new Date(valeur);
    return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("fr-FR");
}

/**
 * Changement du mot de passe d'un compte. Monté à l'ouverture (clé = compte) :
 * les champs repartent vides à chaque fois.
 */
function DialogueMotDePasse({ cible, onFermer }: { cible: Utilisateur; onFermer: () => void }) {
    const [motDePasse, setMotDePasse] = useState("");
    const [confirmation, setConfirmation] = useState("");
    const [erreur, setErreur] = useState<string | null>(null);
    const [envoi, setEnvoi] = useState(false);

    const valider = async (e: FormEvent) => {
        e.preventDefault();
        setErreur(null);
        if (motDePasse.length < 4) {
            setErreur("Le mot de passe doit faire au moins 4 caractères.");
            return;
        }
        if (motDePasse !== confirmation) {
            setErreur("Les deux mots de passe ne sont pas identiques.");
            return;
        }
        setEnvoi(true);
        try {
            const res = await updatePassword(cible.id, motDePasse);
            if (!res.success) {
                setErreur(res.error ?? "Erreur lors de la mise à jour.");
                return;
            }
            toast.succes(`Le mot de passe de « ${cible.username} » a été modifié.`);
            onFermer();
        } catch (err) {
            setErreur(messageErreur(err));
        } finally {
            setEnvoi(false);
        }
    };

    return (
        <Dialog open onOpenChange={(open) => { if (!open && !envoi) onFermer(); }}>
            <DialogContent className="sm:max-w-md">
                <form onSubmit={valider} className="grid gap-4">
                    <DialogHeader>
                        <DialogTitle>Changer le mot de passe</DialogTitle>
                        <DialogDescription className="text-[var(--text-secondary)]">
                            Compte « {cible.username} ». Le nouveau mot de passe sera demandé dès la prochaine connexion.
                        </DialogDescription>
                    </DialogHeader>
                    <div>
                        <Label htmlFor="mdp-nouveau">Nouveau mot de passe</Label>
                        <Input id="mdp-nouveau" type="password" className="w-full" autoFocus autoComplete="new-password"
                            value={motDePasse} onChange={(e) => setMotDePasse(e.target.value)} />
                        <p className="mt-1 text-xs text-[var(--text-muted)]">Au moins 4 caractères.</p>
                    </div>
                    <div>
                        <Label htmlFor="mdp-confirmation">Confirmer le mot de passe</Label>
                        <Input id="mdp-confirmation" type="password" className="w-full" autoComplete="new-password"
                            value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
                    </div>
                    {erreur && (
                        <p role="alert" className="text-[13px] text-[var(--accent-error)]">{erreur}</p>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onFermer} disabled={envoi}>Annuler</Button>
                        <Button type="submit" disabled={envoi}>
                            {envoi && <Loader2 className="animate-spin" />}
                            Enregistrer le mot de passe
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function UserManagement() {
    const [users, setUsers] = useState<Utilisateur[]>([]);
    const [chargement, setChargement] = useState(true);
    const [erreurChargement, setErreurChargement] = useState<string | null>(null);
    const [creation, setCreation] = useState(false);
    const [newUsername, setNewUsername] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [newRole, setNewRole] = useState<Role>("user");
    const [suppression, setSuppression] = useState<number | null>(null);
    const [cibleMotDePasse, setCibleMotDePasse] = useState<Utilisateur | null>(null);

    // Aucun setState avant le premier await : appelable depuis l'effet de montage.
    const charger = useCallback(async () => {
        try {
            setUsers(await getUsers());
            setErreurChargement(null);
        } catch (e) {
            setErreurChargement(messageErreur(e));
        } finally {
            setChargement(false);
        }
    }, []);

    useEffect(() => { void charger(); }, [charger]);

    const reessayer = () => {
        setChargement(true);
        void charger();
    };

    const handleCreate = async (e: FormEvent) => {
        e.preventDefault();
        setCreation(true);
        try {
            const res = await createUser(newUsername, newPassword, newRole);
            if (res.success) {
                toast.succes(`Le compte « ${newUsername} » a été créé : il peut se connecter dès maintenant.`);
                setNewUsername("");
                setNewPassword("");
                void charger();
            } else {
                toast.erreur(res.error ?? "Le compte n'a pas pu être créé.");
            }
        } catch (err) {
            toast.erreur(`Le compte n'a pas pu être créé : ${messageErreur(err)}`);
        } finally {
            setCreation(false);
        }
    };

    const handleDelete = async (u: Utilisateur) => {
        const ok = await confirmer({
            titre: `Supprimer le compte « ${u.username} » ?`,
            message: "Cette personne ne pourra plus se connecter à CollectFlow. La suppression est définitive.",
            libelleConfirmer: "Supprimer",
            danger: true,
        });
        if (!ok) return;
        setSuppression(u.id);
        try {
            const res = await deleteUser(u.id);
            if (res.success) {
                setUsers((prev) => prev.filter((x) => x.id !== u.id));
                toast.succes(`Le compte « ${u.username} » a été supprimé.`);
            } else {
                toast.erreur(res.error ?? "Le compte n'a pas pu être supprimé.");
            }
        } catch (err) {
            toast.erreur(`Le compte n'a pas pu être supprimé : ${messageErreur(err)}`);
        } finally {
            setSuppression(null);
        }
    };

    return (
        <>
            {/* Création */}
            <Card>
                <CardHeader
                    title="Ajouter un utilisateur"
                    description="Le compte peut se connecter dès sa création, avec cet identifiant et ce mot de passe."
                />
                <CardContent>
                    <form onSubmit={handleCreate} className="space-y-4">
                        <div className="grid gap-4 md:grid-cols-3">
                            <div>
                                <Label htmlFor="nouvel-identifiant">Identifiant</Label>
                                <Input
                                    id="nouvel-identifiant"
                                    required
                                    value={newUsername}
                                    onChange={(e) => setNewUsername(e.target.value)}
                                    className="w-full"
                                    placeholder="ex. jean.dupont"
                                    autoComplete="off"
                                />
                            </div>
                            <div>
                                <Label htmlFor="nouveau-mdp">Mot de passe</Label>
                                <Input
                                    id="nouveau-mdp"
                                    required
                                    type="password"
                                    value={newPassword}
                                    onChange={(e) => setNewPassword(e.target.value)}
                                    className="w-full"
                                    placeholder="••••••••"
                                    autoComplete="new-password"
                                />
                            </div>
                            <div>
                                <Select
                                    id="nouveau-role"
                                    label="Rôle"
                                    value={newRole}
                                    onChange={(v) => setNewRole(v as Role)}
                                    options={ROLES}
                                    className="w-full"
                                />
                                <p className="mt-1 text-xs text-[var(--text-muted)]">
                                    Un administrateur accède en plus à la synchronisation et aux paramètres.
                                </p>
                            </div>
                        </div>
                        <Button type="submit" disabled={creation}>
                            {creation ? <Loader2 className="animate-spin" /> : <UserPlus />}
                            Créer le compte
                        </Button>
                    </form>
                </CardContent>
            </Card>

            {/* Liste */}
            <Card>
                <CardHeader
                    title="Comptes"
                    description="Les personnes autorisées à se connecter à CollectFlow."
                    actions={!chargement && !erreurChargement ? <Badge>{users.length} compte{users.length > 1 ? "s" : ""}</Badge> : undefined}
                />
                <CardContent>
                    {chargement ? (
                        <div className="space-y-2" aria-busy="true" aria-label="Chargement des comptes">
                            {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}
                        </div>
                    ) : erreurChargement ? (
                        <ErrorState
                            title="La liste des comptes n'a pas pu être chargée"
                            detail={erreurChargement}
                            action={<Button variant="outline" onClick={reessayer}>Réessayer</Button>}
                        />
                    ) : users.length === 0 ? (
                        <EmptyState
                            icon={User}
                            title="Aucun compte"
                            description="Créez le premier compte avec le formulaire ci-dessus."
                        />
                    ) : (
                        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
                            <table className="w-full">
                                <thead className="bg-[var(--bg-elevated)] text-[13px] font-semibold text-[var(--text-secondary)]">
                                    <tr>
                                        <th scope="col" className="px-3 py-2 text-left">Identifiant</th>
                                        <th scope="col" className="px-3 py-2 text-left">Rôle</th>
                                        <th scope="col" className="px-3 py-2 text-left">Créé le</th>
                                        <th scope="col" className="px-3 py-2 text-right"><span className="sr-only">Actions</span></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {users.map((u) => (
                                        <tr key={u.id} className="border-t border-[var(--border)] hover:bg-[var(--bg-elevated)]">
                                            <td className="px-3 py-2 text-sm font-medium text-[var(--text-primary)]">
                                                <span className="inline-flex items-center gap-2">
                                                    {u.role === "admin"
                                                        ? <Shield className="h-4 w-4 text-[var(--accent)]" aria-hidden />
                                                        : <User className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />}
                                                    {u.username}
                                                </span>
                                            </td>
                                            <td className="px-3 py-2 text-sm">
                                                {u.role === "admin"
                                                    ? <Badge ton="accent">Administrateur</Badge>
                                                    : <Badge>Utilisateur</Badge>}
                                            </td>
                                            <td className="px-3 py-2 text-sm text-[var(--text-secondary)]">{fmtJour(u.createdAt)}</td>
                                            <td className="px-3 py-2 text-right">
                                                <div className="inline-flex items-center gap-1">
                                                    <Button variant="outline" size="sm" onClick={() => setCibleMotDePasse(u)}>
                                                        <KeyRound /> Mot de passe
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={() => handleDelete(u)}
                                                        disabled={suppression === u.id}
                                                        className="text-[var(--accent-error)] hover:bg-[var(--accent-error-bg)] hover:text-[var(--accent-error)]"
                                                    >
                                                        {suppression === u.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                                                        Supprimer
                                                    </Button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </CardContent>
            </Card>

            {cibleMotDePasse && (
                <DialogueMotDePasse
                    key={cibleMotDePasse.id}
                    cible={cibleMotDePasse}
                    onFermer={() => setCibleMotDePasse(null)}
                />
            )}
        </>
    );
}
