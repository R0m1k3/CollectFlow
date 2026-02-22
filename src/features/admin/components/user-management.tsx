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

export function UserManagement() {
    const [users, setUsers] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [isCreating, setIsCreating] = useState(false);
    const [newUsername, setNewUsername] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [newRole, setNewRole] = useState<"admin" | "user">("user");
    const [modal, setModal] = useState({ isOpen: false, title: "", message: "" });

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

    const handleUpdatePassword = async (id: number, username: string) => {
        const pass = window.prompt(`Nouveau mot de passe pour ${username} :`);
        if (!pass) return;

        if (pass.length < 4) {
            alert("Le mot de passe doit faire au moins 4 caractères.");
            return;
        }

        const res = await updatePassword(id, pass);
        if (res.success) {
            setModal({
                isOpen: true,
                title: "Mot de passe mis à jour",
                message: `Le mot de passe de ${username} a été modifié avec succès.`
            });
        } else {
            alert(res.error);
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
                <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
                <p className="text-slate-400 text-sm">Chargement des utilisateurs...</p>
            </div>
        );
    }

    return (
        <div className="space-y-8">
            {/* Formulaire de création */}
            <div className="bg-slate-800/30 border border-slate-700/50 rounded-3xl p-8">
                <div className="flex items-center gap-4 mb-8">
                    <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
                        <UserPlus className="w-6 h-6 text-indigo-400" />
                    </div>
                    <div>
                        <h2 className="text-xl font-black text-slate-100 italic">Nouvel Utilisateur</h2>
                        <p className="text-slate-500 text-sm">Ajoutez un collaborateur à la plateforme.</p>
                    </div>
                </div>

                <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-4 gap-6 items-end">
                    <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase tracking-widest text-slate-500 ml-1">Utilisateur</label>
                        <input
                            required
                            value={newUsername}
                            onChange={(e) => setNewUsername(e.target.value)}
                            className="w-full bg-slate-900/50 border border-slate-700/50 rounded-xl px-4 py-3 text-sm text-slate-100 outline-none focus:border-indigo-500 transition-colors"
                            placeholder="ex: jean.dupont"
                        />
                    </div>
                    <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase tracking-widest text-slate-500 ml-1">Mot de passe</label>
                        <input
                            required
                            type="password"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            className="w-full bg-slate-900/50 border border-slate-700/50 rounded-xl px-4 py-3 text-sm text-slate-100 outline-none focus:border-indigo-500 transition-colors"
                            placeholder="••••••••"
                        />
                    </div>
                    <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase tracking-widest text-slate-500 ml-1">Rôle</label>
                        <select
                            value={newRole}
                            onChange={(e) => setNewRole(e.target.value as any)}
                            className="w-full bg-slate-900/50 border border-slate-700/50 rounded-xl px-4 py-3 text-sm text-slate-100 outline-none focus:border-indigo-500 transition-colors appearance-none"
                        >
                            <option value="user">Utilisateur</option>
                            <option value="admin">Administrateur</option>
                        </select>
                    </div>
                    <button
                        type="submit"
                        disabled={isCreating}
                        className="h-12 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-black rounded-xl transition-all active:scale-95 flex items-center justify-center gap-2 shadow-lg shadow-indigo-900/20"
                    >
                        {isCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                        Créer le compte
                    </button>
                </form>
            </div>

            {/* Liste des utilisateurs */}
            <div className="grid gap-4">
                <h3 className="text-xs font-black uppercase tracking-widest text-slate-500 ml-1 mb-2 italic">Liste des comptes</h3>
                {users.map((u) => (
                    <div key={u.id} className="flex items-center gap-6 p-4 rounded-2xl bg-slate-800/40 border border-slate-700/50 hover:border-slate-600 transition-all group">
                        <div className="w-10 h-10 rounded-xl bg-slate-700/50 flex items-center justify-center shrink-0">
                            {u.role === "admin" ? <Shield className="w-5 h-5 text-amber-400" /> : <User className="w-5 h-5 text-slate-400" />}
                        </div>
                        <div className="flex-1">
                            <h4 className="text-sm font-bold text-slate-100">{u.username}</h4>
                            <span className="text-[10px] uppercase font-black text-slate-500 tracking-wider">
                                {u.role === "admin" ? "Administrateur" : "Utilisateur Standard"}
                            </span>
                        </div>
                        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                                onClick={() => handleUpdatePassword(u.id, u.username)}
                                className="p-2.5 rounded-xl hover:bg-indigo-500/10 text-slate-500 hover:text-indigo-400 transition-colors"
                                title="Changer le mot de passe"
                            >
                                <Key className="w-4 h-4" />
                            </button>
                            <button
                                onClick={() => handleDelete(u.id, u.username)}
                                className="p-2.5 rounded-xl hover:bg-rose-500/10 text-slate-500 hover:text-rose-500 transition-colors"
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
        </div>
    );
}
