"use client";

import { useState, useCallback } from "react";
import { Save, Eye, EyeOff, CheckCircle, AlertCircle, Loader2, RefreshCw, Sun, Moon, RotateCcw } from "lucide-react";
import { useTheme } from "next-themes";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { useDbSettingsStore } from "@/features/settings/store/use-db-settings-store";
import { testDatabaseConnection, saveDatabaseSettings, getSavedDatabaseConfig } from "@/features/settings/actions";
import { useEffect } from "react";
import { UserManagement } from "@/features/admin/components/user-management";

interface OpenRouterModel { id: string; name: string; free: boolean; }

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
    return (
        <section className="apple-card">
            <div className="apple-card-header">
                <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">{title}</h2>
                {subtitle && <p className="text-[12px] mt-0.5 text-[var(--text-secondary)]">{subtitle}</p>}
            </div>
            <div className="apple-card-content space-y-4">
                {children}
            </div>
        </section>
    );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-[var(--text-secondary)]">{label}</label>
            {children}
            {hint && <p className="text-[11px] text-[var(--text-muted)]">{hint}</p>}
        </div>
    );
}

interface FfSyncTable { nom: string; derniereSync: string; nbLignes?: number; }
interface FfSyncStatus { lastSync: string; tables: FfSyncTable[]; }

function FfApiStatusSection() {
    const [status, setStatus] = useState<FfSyncStatus | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchStatus = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch("/api/ff-status");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setStatus(await res.json());
        } catch (e) {
            setError(e instanceof Error ? e.message : "Erreur inconnue");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchStatus(); }, [fetchStatus]);

    return (
        <Section title="API FF Nancy" subtitle="Source des données produits — synchronisation nuit depuis SQL Server (données J-1)">
            <div className="flex items-center gap-3">
                <button onClick={fetchStatus} disabled={loading} className="apple-btn-secondary h-9 px-4">
                    {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    Vérifier le statut
                </button>
                {error && <span className="text-[12px] text-red-400">{error}</span>}
            </div>

            {status && (
                <div className="space-y-2 mt-2">
                    <p className="text-[12px] text-[var(--text-secondary)]">
                        Dernière sync globale : <span className="font-mono font-medium">{(() => { const d = new Date(status.lastSync); return isNaN(d.getTime()) ? (status.lastSync ?? "—") : d.toLocaleString("fr-FR"); })()}</span>
                    </p>
                    {status.tables?.length > 0 && (
                        <div className="rounded-lg overflow-hidden border border-[var(--border-subtle)]">
                            <table className="w-full text-[11px]">
                                <thead>
                                    <tr className="bg-[var(--surface-tertiary)]">
                                        <th className="text-left px-3 py-2 font-medium text-[var(--text-secondary)]">Table</th>
                                        <th className="text-right px-3 py-2 font-medium text-[var(--text-secondary)]">Sync</th>
                                        <th className="text-right px-3 py-2 font-medium text-[var(--text-secondary)]">Lignes</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {status.tables.map((t) => (
                                        <tr key={t.nom} className="border-t border-[var(--border-subtle)]">
                                            <td className="px-3 py-2 font-mono text-[var(--text-primary)]">{t.nom}</td>
                                            <td className="px-3 py-2 text-right text-[var(--text-secondary)]">
                                                {(() => { const d = new Date(t.derniereSync); return isNaN(d.getTime()) ? (t.derniereSync ?? "—") : d.toLocaleString("fr-FR"); })()}
                                            </td>
                                            <td className="px-3 py-2 text-right text-[var(--text-muted)]">
                                                {t.nbLignes?.toLocaleString("fr-FR") ?? "—"}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}
        </Section>
    );
}

export default function SettingsPage() {
    const { resolvedTheme, setTheme } = useTheme();
    const isDark = resolvedTheme === "dark";
    const displayDensity = useGridStore((s) => s.displayDensity);
    const setDisplayDensity = useGridStore((s) => s.setDisplayDensity);

    const [showKey, setShowKey] = useState(false);
    const [apiKey, setApiKey] = useState("");
    const [dbStatus, setDbStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
    const [dbError, setDbError] = useState<string | null>(null);
    const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
    const [models, setModels] = useState<OpenRouterModel[]>([]);
    const [selectedModel, setSelectedModel] = useState("google/gemini-2.0-flash-001");
    const [modelsStatus, setModelsStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");

    // AI Provider
    const [aiProvider, setAiProvider] = useState<"openrouter" | "google">("openrouter");
    const [googleAiKey, setGoogleAiKey] = useState("");
    const [showGoogleKey, setShowGoogleKey] = useState(false);
    const [googleAiModel, setGoogleAiModel] = useState("gemini-2.5-pro-preview-05-06");

    const [isMounted, setIsMounted] = useState(false);

    const {
        host, setHost,
        port, setPort,
        database, setDatabase,
        user, setUser,
        password, setPassword,
        ssl, setSsl,
        getDatabaseUrl
    } = useDbSettingsStore();

    const fetchModels = useCallback(async (key: string) => {
        if (!key.trim()) return;
        setModelsStatus("loading");
        try {
            const res = await fetch("/api/openrouter/models", { headers: { "x-openrouter-key": key } });
            if (!res.ok) throw new Error();
            const data = await res.json();
            setModels(data.models ?? []);
            setModelsStatus("ok");
        } catch {
            setModelsStatus("error");
        }
    }, []);

    const reloadFromServer = useCallback(async () => {
        const config = await getSavedDatabaseConfig();
        if (config) {
            if (config.url) {
                // Parser l'URL pour remettre dans le store
                try {
                    const url = new URL(config.url.replace("postgres://", "http://")); // URL parser helper
                    setHost(url.hostname);
                    setPort(url.port || "5432");
                    setDatabase(url.pathname.slice(1).split("?")[0]);
                    setUser(url.username);
                    setPassword(decodeURIComponent(url.password));
                    setSsl(config.url.includes("sslmode=require"));
                } catch (e) {
                    console.error("Failed to parse saved URL", e);
                }
            }
            if (config.openRouterKey) {
                setApiKey(config.openRouterKey);
                fetchModels(config.openRouterKey);
            }
            if (config.openRouterModel) {
                setSelectedModel(config.openRouterModel);
            }
            if (config.aiProvider) setAiProvider(config.aiProvider);
            if (config.googleAiKey) setGoogleAiKey(config.googleAiKey);
            if (config.googleAiModel) setGoogleAiModel(config.googleAiModel);
        }
    }, [fetchModels, setApiKey, setDatabase, setHost, setPassword, setPort, setSelectedModel, setSsl, setUser]);

    useEffect(() => {
        setIsMounted(true);
        reloadFromServer();
    }, [reloadFromServer]);

    const testDb = async () => {
        setDbStatus("testing");
        setDbError(null);
        const url = getDatabaseUrl();
        const res = await testDatabaseConnection(url);
        if (res.success) {
            setDbStatus("ok");
        } else {
            setDbStatus("error");
            setDbError(res.error || "Erreur de connexion inconnue");
        }
    };

    const handleSave = async () => {
        setSaveStatus("saving");
        const url = getDatabaseUrl();
        const res = await saveDatabaseSettings(url, apiKey, selectedModel, aiProvider, googleAiKey, googleAiModel);
        if (res.success) {
            setSaveStatus("saved");
            setTimeout(() => setSaveStatus("idle"), 2500);
        } else {
            setSaveStatus("idle");
            alert("Erreur lors de la sauvegarde : " + res.error);
        }
    };

    if (!isMounted) {
        return null;
    }

    return (
        <div className="space-y-6 max-w-xl">
            <div>
                <h1 className="text-[22px] font-bold tracking-[-0.4px] text-[var(--text-primary)]">Paramètres</h1>
                <p className="text-[13px] mt-1 text-[var(--text-secondary)]">Configuration de la connexion et des services.</p>
            </div>

            {/* PostgreSQL */}
            <Section title="PostgreSQL — Auth & Historique" subtitle="Connexion pour les comptes utilisateurs, snapshots et contexte IA. Les données produits proviennent de l'API FF Nancy.">
                <Field label="Hôte / Nom du container" hint="Ex: localhost, 192.168.1.10, ou nom du service Docker (ex: postgres, db)">
                    <input
                        type="text"
                        placeholder="localhost"
                        value={host}
                        onChange={(e) => setHost(e.target.value)}
                        className="apple-input font-mono"
                    />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                    <Field label="Port">
                        <input
                            type="text"
                            placeholder="5432"
                            value={port}
                            onChange={(e) => setPort(e.target.value)}
                            className="apple-input font-mono"
                        />
                    </Field>
                    <Field label="Base de données">
                        <input
                            type="text"
                            placeholder="collectflow"
                            value={database}
                            onChange={(e) => setDatabase(e.target.value)}
                            className="apple-input font-mono"
                        />
                    </Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <Field label="Utilisateur">
                        <input
                            type="text"
                            placeholder="postgres"
                            value={user}
                            onChange={(e) => setUser(e.target.value)}
                            className="apple-input font-mono"
                        />
                    </Field>
                    <Field label="Mot de passe">
                        <input
                            type="password"
                            placeholder="••••••••"
                            value={password || ""}
                            onChange={(e) => setPassword(e.target.value)}
                            className="apple-input font-mono"
                        />
                    </Field>
                </div>
                <div className="flex items-center gap-2.5">
                    <input
                        type="checkbox"
                        id="ssl"
                        checked={ssl}
                        onChange={(e) => setSsl(e.target.checked)}
                        className="w-3.5 h-3.5 rounded accent-teal-500 cursor-pointer"
                    />
                    <label htmlFor="ssl" className="text-[12px] cursor-pointer text-[var(--text-secondary)]">Connexion SSL</label>
                </div>
                <div className="flex items-center gap-3">
                    <button onClick={testDb} disabled={dbStatus === "testing"} className="apple-btn-secondary h-9 px-4">
                        {dbStatus === "testing" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        {dbStatus === "ok" && <CheckCircle className="w-3.5 h-3.5 text-teal-500" />}
                        {dbStatus === "error" && <AlertCircle className="w-3.5 h-3.5 text-red-400" />}
                        Tester la connexion
                    </button>
                    {dbStatus === "error" && (
                        <div className="flex flex-col">
                            <span className="text-[12px] text-red-400 font-medium">Connexion refusée</span>
                            {dbError && <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>{dbError}</span>}
                        </div>
                    )}
                    {dbStatus === "ok" && (
                        <span className="text-[12px] text-teal-500 font-medium">Connexion réussie !</span>
                    )}
                </div>
                <div className="pt-2">
                    <button
                        onClick={reloadFromServer}
                        className="apple-btn-secondary h-8 px-3 text-[11px] opacity-80 hover:opacity-100"
                    >
                        <RotateCcw className="w-3 h-3" />
                        Recharger la configuration enregistrée sur le serveur
                    </button>
                </div>
            </Section>

            {/* API FF Nancy */}
            <FfApiStatusSection />

            {/* AI Provider selector */}
            <Section title="Admin AI Chat — Fournisseur" subtitle="Choisissez le fournisseur IA utilisé dans l'onglet Admin AI Chat">
                <div className="flex gap-2">
                    <button
                        onClick={() => setAiProvider("openrouter")}
                        className={`flex-1 py-2.5 px-4 rounded-lg border text-[13px] font-medium transition-colors ${aiProvider === "openrouter" ? "border-[var(--accent)] bg-[var(--accent-bg)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]"}`}
                    >
                        OpenRouter
                    </button>
                    <button
                        onClick={() => setAiProvider("google")}
                        className={`flex-1 py-2.5 px-4 rounded-lg border text-[13px] font-medium transition-colors ${aiProvider === "google" ? "border-[var(--accent)] bg-[var(--accent-bg)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]"}`}
                    >
                        Google AI Studio
                    </button>
                </div>

                {aiProvider === "google" && (
                    <>
                        <Field label="Clé API Google AI Studio" hint="Disponible sur aistudio.google.com/apikey — commence par AIza...">
                            <div className="relative">
                                <input
                                    type={showGoogleKey ? "text" : "password"}
                                    placeholder="AIzaSy..."
                                    value={googleAiKey}
                                    onChange={(e) => setGoogleAiKey(e.target.value)}
                                    className="apple-input font-mono pr-10"
                                />
                                <button
                                    onClick={() => setShowGoogleKey((v) => !v)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 opacity-50 hover:opacity-100 transition-opacity"
                                >
                                    {showGoogleKey ? <EyeOff className="w-4 h-4" style={{ color: "var(--text-primary)" }} /> : <Eye className="w-4 h-4" style={{ color: "var(--text-primary)" }} />}
                                </button>
                            </div>
                        </Field>
                        <Field label="Modèle Google" hint="ex: gemini-2.5-pro-preview-05-06, gemini-2.0-flash, gemini-1.5-pro">
                            <select
                                value={googleAiModel}
                                onChange={(e) => setGoogleAiModel(e.target.value)}
                                className="apple-input"
                            >
                                <option value="gemini-2.5-pro-preview-05-06">Gemini 2.5 Pro Preview</option>
                                <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                                <option value="gemini-2.0-flash-thinking-exp">Gemini 2.0 Flash Thinking</option>
                                <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
                                <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
                            </select>
                        </Field>
                    </>
                )}

                {aiProvider === "openrouter" && (
                    <p className="text-[12px] text-[var(--text-muted)]">
                        Utilise la clé OpenRouter configurée ci-dessous et le modèle sélectionné.
                    </p>
                )}
            </Section>

            {/* OpenRouter */}
            <Section title="IA Copilot — OpenRouter" subtitle="Clé API pour les analyses de gammes par intelligence artificielle">
                <Field label="Clé API" hint="Disponible sur openrouter.ai/keys — commence par sk-or-...">
                    <div className="flex gap-2">
                        <div className="relative flex-1">
                            <input
                                type={showKey ? "text" : "password"}
                                placeholder="sk-or-v1-..."
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                className="apple-input font-mono pr-10"
                            />
                            <button
                                onClick={() => setShowKey((v) => !v)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 transition-opacity hover:opacity-100 opacity-50"
                            >
                                {showKey ? <EyeOff className="w-4 h-4" style={{ color: "var(--text-primary)" }} /> : <Eye className="w-4 h-4" style={{ color: "var(--text-primary)" }} />}
                            </button>
                        </div>
                        <button
                            onClick={() => fetchModels(apiKey)}
                            disabled={!apiKey || modelsStatus === "loading"}
                            className="apple-btn-secondary h-9 px-4 whitespace-nowrap"
                        >
                            {modelsStatus === "loading" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                            Charger les modèles
                        </button>
                    </div>
                </Field>

                <Field
                    label={`Modèle IA${models.length > 0 ? ` (${models.length} disponibles)` : ""}`}
                    hint={modelsStatus === "error" ? "⚠ Erreur — vérifiez votre clé puis rechargez" : modelsStatus === "idle" ? "Entrez votre clé et cliquez « Charger les modèles »" : undefined}
                >
                    {models.length > 0 ? (
                        <select
                            value={selectedModel}
                            onChange={(e) => setSelectedModel(e.target.value)}
                            className="apple-input"
                        >
                            {models.map((m) => (
                                <option key={m.id} value={m.id}>
                                    {m.free ? "🆓 " : ""}{m.name}
                                </option>
                            ))}
                        </select>
                    ) : (
                        <input
                            type="text"
                            value={selectedModel}
                            onChange={(e) => setSelectedModel(e.target.value)}
                            placeholder="ex: google/gemini-2.0-flash-001"
                            className="apple-input"
                        />
                    )}
                </Field>
            </Section>

            {/* Apparence */}
            <Section title="Apparence">
                <div className="flex items-center justify-between">
                    <div>
                        <p className="text-[13px] font-medium text-[var(--text-primary)]">Thème</p>
                        <p className="text-[12px] text-[var(--text-secondary)]">Interface claire ou sombre</p>
                    </div>
                    {/* Segment control */}
                    <div className="segment-control">
                        <button onClick={() => setTheme("light")} className={`segment-btn ${!isDark ? "active" : ""}`}>
                            <Sun className="w-3.5 h-3.5" /> Clair
                        </button>
                        <button onClick={() => setTheme("dark")} className={`segment-btn ${isDark ? "active" : ""}`}>
                            <Moon className="w-3.5 h-3.5" /> Sombre
                        </button>
                    </div>
                </div>

                <div className="flex items-center justify-between">
                    <div>
                        <p className="text-[13px] font-medium text-[var(--text-primary)]">Densité de la grille</p>
                        <p className="text-[12px] text-[var(--text-secondary)]">Hauteur de ligne par défaut</p>
                    </div>
                    <select
                        className="apple-input w-auto"
                        value={displayDensity}
                        onChange={(e) => setDisplayDensity(e.target.value as "compact" | "normal" | "comfortable")}
                    >
                        <option value="compact">Compact (32px)</option>
                        <option value="normal">Normal (40px)</option>
                        <option value="comfortable">Spacieux (48px)</option>
                    </select>
                </div>
            </Section>

            {/* Score Produit */}
            <Section title="Score Produit" subtitle="Formule hybride absolue + relative (v4)">
                <div className="bg-[var(--surface-tertiary)] rounded-lg p-3 space-y-2">
                    <p className="text-[11px] text-[var(--text-secondary)]">
                        <strong>Formule :</strong> Volume (50pts) + CA (30pts) + Marge (20pts) + Bonus relatif (±10pts)
                    </p>
                    <p className="text-[11px] text-[var(--text-muted)]">
                        Le score est basé sur des paliers absolus sensibles au prix unitaire, avec un ajustement relatif selon la position dans le lot fournisseur.
                    </p>
                    <div className="border-t border-[var(--border-subtle)] pt-2 mt-2 space-y-1">
                        <p className="text-[11px] text-[var(--text-secondary)]"><strong>Volume</strong> (0-50 pts) — unités / magasin / mois</p>
                        <p className="text-[11px] text-[var(--text-secondary)]"><strong>CA</strong> (0-30 pts) — € / magasin / an</p>
                        <p className="text-[11px] text-[var(--text-secondary)]"><strong>Marge</strong> (0-20 pts) — taux de marge %</p>
                        <p className="text-[11px] text-[var(--text-secondary)]"><strong>Bonus relatif</strong> (±10 pts) — percentile composite dans le lot</p>
                    </div>
                    <p className="text-[11px] text-[var(--text-muted)] mt-2">
                        Pénalité de régularité appliquée si inactivité prolongée. Score final borné 0-100.
                    </p>
                </div>
            </Section>

            {/* Gestion des Utilisateurs */}
            <Section
                title="Gestion des Utilisateurs"
                subtitle="Administration des accès et des rôles"
            >
                <UserManagement />
            </Section>

            {/* Save Button — Floating/Sticky style at bottom */}
            <div className="sticky bottom-6 flex justify-end pt-4 pb-2">
                <button
                    onClick={handleSave}
                    disabled={saveStatus === "saving"}
                    className={`apple-btn-primary min-w-[240px] shadow-lg ${saveStatus === "saving" ? "animate-pulse" : saveStatus === "saved" ? "animate-apple-save" : ""}`}
                    style={{ background: saveStatus === "saved" ? "var(--accent-success)" : "var(--brand-solid)" }}
                >
                    {saveStatus === "saving" ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                    ) : saveStatus === "saved" ? (
                        <CheckCircle className="w-4 h-4" />
                    ) : (
                        <Save className="w-4 h-4" />
                    )}
                    <span className="ml-1">
                        {saveStatus === "saving"
                            ? "Enregistrement en cours..."
                            : saveStatus === "saved"
                                ? "Configuration enregistrée !"
                                : "Sauvegarder la configuration"}
                    </span>
                </button>
            </div>
        </div>
    );
}
