"use client";

import { useState, useCallback } from "react";
import { Save, Eye, EyeOff, CheckCircle, AlertCircle, Loader2, RefreshCw, Sun, Moon, RotateCcw } from "lucide-react";
import { useTheme } from "next-themes";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { useDbSettingsStore } from "@/features/settings/store/use-db-settings-store";
import { testDatabaseConnection, saveDatabaseSettings, getSavedDatabaseConfig, saveQlikSettings, testQlikConnection, saveFfApiSettings, testFfApiConnection } from "@/features/settings/actions";
import { useEffect } from "react";
import { UserManagement } from "@/features/admin/components/user-management";
import { ApiKeyManagement } from "@/features/admin/components/api-key-management";
import { ApiConnectionInfo } from "@/features/admin/components/api-connection-info";
import { GridWarmup } from "@/features/admin/components/grid-warmup";
import { ServerLogs } from "@/features/settings/components/server-logs";

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

interface FfSyncTable { nom: string; derniereSync: string; nbLignes?: number; statut?: string; erreur?: string | null; }
interface FfSyncStatus { lastSync: string; tables: FfSyncTable[]; }

function FfApiStatusSection() {
    const [status, setStatus] = useState<FfSyncStatus | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [url, setUrl] = useState("");
    const [savedUrl, setSavedUrl] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [testedUrl, setTestedUrl] = useState<string | null>(null);

    // Charge l'URL enregistrée pour la préremplir (vide = valeur par défaut).
    useEffect(() => {
        getSavedDatabaseConfig()
            .then((cfg) => {
                setSavedUrl(cfg?.ffApiBaseUrl ?? null);
                if (cfg?.ffApiBaseUrl) setUrl(cfg.ffApiBaseUrl);
            })
            .catch(() => { /* réglage optionnel : on laisse le champ vide */ });
    }, []);

    const runTest = useCallback((candidate?: string) => {
        setLoading(true);
        setError(null);
        setStatus(null);
        testFfApiConnection(candidate)
            .then((res) => {
                setTestedUrl(res.url);
                if (res.success) setStatus(res.status as FfSyncStatus);
                else setError(res.error ?? "Échec inconnu");
            })
            .catch((e) => setError(e instanceof Error ? e.message : "Erreur inconnue"))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => { runTest(); }, [runTest]);

    const save = async () => {
        setSaving(true);
        setError(null);
        try {
            const res = await saveFfApiSettings(url);
            if (!res.success) { setError(res.error ?? "Enregistrement impossible"); return; }
            setSavedUrl(url.trim() || null);
            runTest(url);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Section title="API FF Nancy" subtitle="Source des données produits — synchronisation nuit depuis SQL Server (données J-1)">
            <Field label="URL de l'API" hint="Laisser vide pour utiliser la valeur par défaut (https://api.ffnancy.fr)">
                <input
                    type="text"
                    placeholder="https://api.ffnancy.fr"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
                    className="apple-input w-full"
                />
            </Field>

            <div className="flex items-center gap-3 flex-wrap">
                <button onClick={save} disabled={saving} className="apple-btn h-9 px-4">
                    {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                    Enregistrer
                </button>
                <button onClick={() => runTest(url)} disabled={loading} className="apple-btn-secondary h-9 px-4">
                    {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    Tester
                </button>
                {status && <span className="text-[12px] text-emerald-400 flex items-center gap-1"><CheckCircle className="w-3.5 h-3.5" /> Connexion OK</span>}
                {error && <span className="text-[12px] text-red-400 flex items-center gap-1"><AlertCircle className="w-3.5 h-3.5" /> {error}</span>}
            </div>

            {/* L'URL réellement appelée : évite de croire qu'on teste celle du champ
                alors que le réglage enregistré ou la variable d'environnement prime. */}
            {testedUrl && (
                <p className="text-[11px] text-[var(--text-muted)]">
                    Adresse testée : <span className="font-mono">{testedUrl}</span>
                    {!savedUrl && <> — valeur par défaut, aucun réglage enregistré</>}
                </p>
            )}

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
                                        <th className="text-right px-3 py-2 font-medium text-[var(--text-secondary)]">État</th>
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
                                            {/* Une table en erreur est précisément ce qu'on vient chercher ici. */}
                                            <td className="px-3 py-2 text-right">
                                                {t.statut === "ok"
                                                    ? <span className="text-emerald-400">ok</span>
                                                    : <span className="text-red-400" title={t.erreur ?? undefined}>{t.statut ?? "—"}</span>}
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

function QlikSettingsSection() {
    const [host, setHost] = useState("");
    const [user, setUser] = useState("");
    const [password, setPassword] = useState("");
    const [showPwd, setShowPwd] = useState(false);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [status, setStatus] = useState<{ type: "ok" | "err"; msg: string } | null>(null);

    useEffect(() => {
        getSavedDatabaseConfig().then((c) => {
            if (!c) return;
            setHost(c.qlikHost ?? "");
            setUser(c.qlikUser ?? "");
            setPassword(c.qlikPassword ?? "");
        });
    }, []);

    const handleSave = async () => {
        setSaving(true);
        setStatus(null);
        const res = await saveQlikSettings(host.trim(), user.trim(), password);
        setSaving(false);
        setStatus(res.success ? { type: "ok", msg: "Réglages Qlik enregistrés" } : { type: "err", msg: res.error || "Erreur" });
    };

    const handleTest = async () => {
        setTesting(true);
        setStatus(null);
        const res = await testQlikConnection(host.trim(), user.trim(), password);
        setTesting(false);
        setStatus(res.success ? { type: "ok", msg: "Connexion Qlik OK" } : { type: "err", msg: res.error || "Échec connexion" });
    };

    return (
        <Section title="Qlik Sense — Données réseau" subtitle="Identifiants pour la synchro des données réseau (~270 magasins). Auth NTLM ; laisser l'hôte vide pour le défaut.">
            <Field label="Hôte" hint="Défaut : reporting-magasins.lafoirfouille.fr (laisser vide pour ce défaut)">
                <input type="text" placeholder="reporting-magasins.lafoirfouille.fr" value={host}
                    onChange={(e) => setHost(e.target.value)} className="apple-input font-mono" />
            </Field>
            <Field label="Utilisateur" hint="Ex : FFSCH (sans domaine)">
                <input type="text" placeholder="FFSCH" value={user}
                    onChange={(e) => setUser(e.target.value)} className="apple-input font-mono" />
            </Field>
            <Field label="Mot de passe">
                <div className="relative">
                    <input type={showPwd ? "text" : "password"} placeholder="••••••••" value={password}
                        onChange={(e) => setPassword(e.target.value)} className="apple-input font-mono pr-10" />
                    <button type="button" onClick={() => setShowPwd((v) => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">
                        {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                </div>
            </Field>
            {status && (
                <div className={`flex items-center gap-1.5 text-[12px] ${status.type === "ok" ? "text-emerald-600" : "text-rose-600"}`}>
                    {status.type === "ok" ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                    {status.msg}
                </div>
            )}
            <div className="flex gap-2">
                <button onClick={handleSave} disabled={saving}
                    className="btn-action btn-action-primary flex items-center gap-1.5 disabled:opacity-60">
                    {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                    Enregistrer
                </button>
                <button onClick={handleTest} disabled={testing || !user || !password}
                    className="btn-action btn-action-secondary flex items-center gap-1.5 disabled:opacity-60">
                    {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    Tester
                </button>
            </div>
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
    const [googleAiModel, setGoogleAiModel] = useState("");

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

            <QlikSettingsSection />

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

            {/* Journaux serveur — diagnostic des extractions Qlik */}
            <Section
                title="Journaux serveur"
                subtitle="Journal complet des synchronisations Qlik, à télécharger pour diagnostic"
            >
                <ServerLogs />
            </Section>

            {/* Gestion des Utilisateurs */}
            <Section
                title="Gestion des Utilisateurs"
                subtitle="Administration des accès et des rôles"
            >
                <UserManagement />
            </Section>

            {/* API publique /api/v1 — connexion puis gestion des clés */}
            <Section
                title="API CollectFlow — Connexion"
                subtitle="Tout ce qu'il faut pour appeler l'API depuis un script ou un outil externe"
            >
                <ApiConnectionInfo />
            </Section>

            <Section
                title="Clés d'API"
                subtitle="Créer et révoquer les clés d'accès à /api/v1"
            >
                <ApiKeyManagement />
            </Section>

            <Section
                title="Données exposées à l'API"
                subtitle="Calculer l'instantané de tous les fournisseurs pour qu'une IA externe y ait accès"
            >
                <GridWarmup />
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
