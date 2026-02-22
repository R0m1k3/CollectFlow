"use client";

import { useState, useEffect } from "react";
import { getUsers, createUser, deleteUser, updatePassword } from "../api/user-actions";
import {
    UserPlus,
    Trash2,
    Shield,
    User,
    Loader2,
    Check,
    Key,
} from "lucide-react";
import { SuccessModal } from "@/components/shared/success-modal";
import { ChangePasswordModal } from "@/components/shared/change-password-modal";

export function UserManagement() {
    const [users, setUsers] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [isCreating, setIsCreating] = useState(false);
    const [newUsername, setNewUsername] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [newRole, setNewRole] = useState<"admin" | "user">("user");
    const [modal, setModal] = useState({ isOpen: false, title: "", message: "" });
    const [pwdModal, setPwdModal] = useState<{ isOpen: boolean; userId: number; username: string }>({
        isOpen: false, userId: 0, username: ""
    });

    const fetchUsers = async () => {
        setLoading(true);
        try {
            const data = await getUsers();
            setUsers(data);
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchUsers();
    }, []);

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsCreating(true);
        const res = await createUser(newUsername, newPassword, newRole);
        if (res.success) {
            setModal({
                isOpen: true,
                title: "Utilisateur Créé",
                message: `L'utilisateur ${newUsername} a été ajouté avec succès.`
            });
            setNewUsername("");
            setNewPassword("");
            fetchUsers();
        } else {
            alert(res.error);
        }
        setIsCreating(false);
    };

    const handleUpdatePassword = (id: number, username: string) => {
        setPwdModal({ isOpen: true, userId: id, username });
    };

    const handleConfirmPassword = async (newPassword: string) => {
        const res = await updatePassword(pwdModal.userId, newPassword);
        if (res.success) {
            setModal({
                isOpen: true,
                title: "Mot de passe mis à jour",
                message: `Le mot de passe de ${pwdModal.username} a été modifié avec succès.`
            });
        } else {
            throw new Error(res.error ?? "Erreur lors de la mise à jour.");
        }
    };

    const handleDelete = async (id: number, username: string) => {
        if (!window.confirm(`Supprimer l'utilisateur ${username} ?`)) return;
        const res = await deleteUser(id);
        if (res.success) {
            setUsers(users.filter(u => u.id !== id));
        } else {
            alert(res.error);
        }
    };

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center p-12 space-y-4">
                <Loader2 className="w-8 h-8 text-[var(--accent)] animate-spin" />
                <p className="text-[var(--text-muted)] text-sm">Chargement des utilisateurs...</p>
            </div>
        );
    }

    return (
        <div className="space-y-8">
            {/* Formulaire de création */}
            <div className="bg-[var(--bg-elevated)] border border-[var(--border)] rounded-2xl p-6">
                <div className="flex items-center gap-4 mb-8">
                    <div className="w-12 h-12 rounded-2xl bg-[var(--accent-bg)] border border-[var(--accent-border)] flex items-center justify-center">
                        <UserPlus className="w-6 h-6 text-[var(--accent)]" />
                    </div>
                    <div>
                        <h2 className="text-lg font-bold text-[var(--text-primary)]">Nouvel Utilisateur</h2>
                        <p className="text-[var(--text-secondary)] text-xs">Ajoutez un collaborateur à la plateforme.</p>
                    </div>
                </div>

                <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-4 gap-6 items-end">
                    <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase tracking-widest text-[var(--text-muted)] ml-1">Utilisateur</label>
                        <input
                            required
                            value={newUsername}
                            onChange={(e) => setNewUsername(e.target.value)}
                            className="apple-input"
                            placeholder="ex: jean.dupont"
                        />
                    </div>
                    <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase tracking-widest text-[var(--text-muted)] ml-1">Mot de passe</label>
                        <input
                            required
                            type="password"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            className="apple-input"
                            placeholder="••••••••"
                        />
                    </div>
                    <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase tracking-widest text-[var(--text-muted)] ml-1">Rôle</label>
                        <select
                            value={newRole}
                            onChange={(e) => setNewRole(e.target.value as any)}
                            className="apple-input"
                        >
                            <option value="user">Utilisateur</option>
                            <option value="admin">Administrateur</option>
                        </select>
                    </div>
                    <button
                        type="submit"
                        disabled={isCreating}
                        className="apple-btn-primary w-full justify-center"
                    >
                        {isCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                        Créer le compte
                    </button>
                </form>
            </div>

            {/* Liste des utilisateurs */}
            <div className="grid gap-3">
                <h3 className="text-[10px] font-black uppercase tracking-widest text-[var(--text-muted)] ml-1 mb-1">Liste des comptes</h3>
                {users.map((u) => (
                    <div key={u.id} className="flex items-center gap-5 p-4 rounded-xl bg-[var(--bg-surface)] border border-[var(--border)] hover:border-[var(--text-muted)] transition-all group">
                        <div className="w-10 h-10 rounded-xl bg-[var(--bg-elevated)] flex items-center justify-center shrink-0 border border-[var(--border)]">
                            {u.role === "admin" ? <Shield className="w-5 h-5 text-amber-500" /> : <User className="w-5 h-5 text-[var(--text-muted)]" />}
                        </div>
                        <div className="flex-1">
                            <h4 className="text-sm font-bold text-[var(--text-primary)]">{u.username}</h4>
                            <span className="text-[10px] uppercase font-black text-[var(--text-muted)] tracking-wider">
                                {u.role === "admin" ? "Administrateur" : "Utilisateur Standard"}
                            </span>
                        </div>
                        <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                                onClick={() => handleUpdatePassword(u.id, u.username)}
                                className="p-2.5 rounded-lg hover:bg-[var(--accent-bg)] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
                                title="Changer le mot de passe"
                            >
                                <Key className="w-4 h-4" />
                            </button>
                            <button
                                onClick={() => handleDelete(u.id, u.username)}
                                className="p-2.5 rounded-lg hover:bg-[var(--accent-error-bg)] text-[var(--text-muted)] hover:text-[var(--accent-error)] transition-colors"
                                title="Supprimer"
                            >
                                <Trash2 className="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                ))}
            </div>

            <SuccessModal
                isOpen={modal.isOpen}
                onClose={() => setModal({ ...modal, isOpen: false })}
                title={modal.title}
                message={modal.message}
            />

            <ChangePasswordModal
                isOpen={pwdModal.isOpen}
                onClose={() => setPwdModal({ ...pwdModal, isOpen: false })}
                onConfirm={handleConfirmPassword}
                username={pwdModal.username}
            />
        </div>
    );
}
