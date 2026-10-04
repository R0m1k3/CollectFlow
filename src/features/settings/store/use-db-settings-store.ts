"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface DatabaseSettings {
    host: string;
    port: string;
    database: string;
    user: string;
    /** Saisie en cours uniquement : jamais enregistré dans le navigateur. */
    password?: string;
    ssl: boolean;
}

interface DatabaseSettingsState extends DatabaseSettings {
    /** Un mot de passe est enregistré sur le serveur (lu au chargement de la page, jamais mémorisé). */
    motDePasseEnregistre: boolean;
    setHost: (host: string) => void;
    setPort: (port: string) => void;
    setDatabase: (database: string) => void;
    setUser: (user: string) => void;
    setPassword: (password: string) => void;
    setSsl: (ssl: boolean) => void;
    setMotDePasseEnregistre: (motDePasseEnregistre: boolean) => void;
}

export const useDbSettingsStore = create<DatabaseSettingsState>()(
    persist(
        (set) => ({
            host: "localhost",
            port: "5432",
            database: "collectflow",
            user: "postgres",
            password: "",
            ssl: false,
            motDePasseEnregistre: false,

            setHost: (host) => set({ host }),
            setPort: (port) => set({ port }),
            setDatabase: (database) => set({ database }),
            setUser: (user) => set({ user }),
            setPassword: (password) => set({ password }),
            setSsl: (ssl) => set({ ssl }),
            setMotDePasseEnregistre: (motDePasseEnregistre) => set({ motDePasseEnregistre }),
        }),
        {
            name: "collectflow-db-settings",
            // Le mot de passe reste sur le serveur : seuls les autres champs sont mémorisés.
            partialize: ({ host, port, database, user, ssl }) => ({ host, port, database, user, ssl }),
            // Version 1 : les versions précédentes enregistraient le mot de passe en clair.
            version: 1,
            migrate: (persisted) => {
                const reste = { ...(persisted as Partial<DatabaseSettings> | undefined) };
                delete reste.password;
                return reste as DatabaseSettingsState;
            },
        }
    )
);
