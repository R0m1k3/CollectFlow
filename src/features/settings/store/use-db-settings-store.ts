"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface DatabaseSettings {
    host: string;
    port: string;
    database: string;
    user: string;
    password?: string;
    ssl: boolean;
}

interface DatabaseSettingsState extends DatabaseSettings {
    setHost: (host: string) => void;
    setPort: (port: string) => void;
    setDatabase: (database: string) => void;
    setUser: (user: string) => void;
    setPassword: (password: string) => void;
    setSsl: (ssl: boolean) => void;
    getDatabaseUrl: () => string;
}

export const useDbSettingsStore = create<DatabaseSettingsState>()(
    persist(
        (set, get) => ({
            host: "localhost",
            port: "5432",
            database: "collectflow",
            user: "postgres",
            password: "",
            ssl: false,

            setHost: (host) => set({ host }),
            setPort: (port) => set({ port }),
            setDatabase: (database) => set({ database }),
            setUser: (user) => set({ user }),
            setPassword: (password) => set({ password }),
            setSsl: (ssl) => set({ ssl }),

            getDatabaseUrl: () => {
                const { user, password, host, port, database, ssl } = get();
                const auth = password ? `${user}:${password}` : user;
                const url = `postgres://${auth}@${host}:${port}/${database}${ssl ? "?sslmode=require" : ""}`;
                return url;
            },
        }),
        {
            name: "collectflow-db-settings",
        }
    )
);
