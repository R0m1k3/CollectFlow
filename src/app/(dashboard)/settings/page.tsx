"use client";

import { useState, useCallback } from "react";
import { Save, Eye, EyeOff, CheckCircle, AlertCircle, Loader2, RefreshCw, Sun, Moon, BarChart3, RotateCcw } from "lucide-react";
import { useTheme } from "next-themes";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { useScoreSettingsStore } from "@/features/score/store/use-score-settings-store";
import { useDbSettingsStore } from "@/features/settings/store/use-db-settings-store";
import { testDatabaseConnection, saveDatabaseSettings, getSavedDatabaseConfig } from "@/features/settings/actions";
import { useEffect } from "react";

interface OpenRouterModel { id: string; name: string; free: boolean; }

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
    return (
        <section
            className="rounded-[14px] overflow-hidden"
            style={{ border: "1px solid var(--border)", boxShadow: "var(--shadow-sm)" }}
        >
            <div className="px-5 py-4" style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-elevated)" }}>
                <h2 className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>{title}</h2>
                {subtitle && <p className="text-[12px] mt-0.5" style={{ color: "var(--text-secondary)" }}>{subtitle}</p>}
            </div>
            <div className="px-5 py-5 space-y-4" style={{ background: "var(--bg-surface)" }}>
                {children}
            </div>
        </section>
    );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <div className="space-y-1.5">
            <label className="text-[12px] font-medium" style={{ color: "var(--text-secondary)" }}>{label}</label>
            {children}
            {hint && <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>{hint}</p>}
        </div>
    );
}

export default function SettingsPage() {
    const { resolvedTheme, setTheme } = useTheme();
    const isDark = resolvedTheme === "dark";
    const displayDensity = useGridStore((s) => s.displayDensity);
    const setDisplayDensity = useGridStore((s) => s.setDisplayDensity);

    const seuilAxeFort = useScoreSettingsStore((s) => s.seuilAxeFort);
    const bonusParAxe = useScoreSettingsStore((s) => s.bonusParAxe);
    const setSeuilAxeFort = useScoreSettingsStore((s) => s.setSeuilAxeFort);
    const setBonusParAxe = useScoreSettingsStore((s) => s.setBonusParAxe);
    const resetScoreDefaults = useScoreSettingsStore((s) => s.resetDefaults);

    const [showKey, setShowKey] = useState(false);
    const [apiKey, setApiKey] = useState("");
    const [dbStatus, setDbStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
    const [dbError, setDbError] = useState<string | null>(null);
    const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
    const [models, setModels] = useState<OpenRouterModel[]>([]);
    const [selectedModel, setSelectedModel] = useState("google/gemini-flash-1.5");
    const [modelsStatus, setModelsStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");

    const {
        host, setHost,
        port, setPort,
        database, setDatabase,
        user, setUser,
        password, setPassword,
        ssl, setSsl,
        getDatabaseUrl
    } = useDbSettingsStore();

    useEffect(() => {
        // Optionnel : On pourrait charger la config serveur au montage si on veut écraser le localStorage
        // Pour l'instant on laisse le localStorage faire son travail, mais on offre une fonction de reset
    }, []);

    const reloadFromServer = async () => {
        const config = await getSavedDatabaseConfig();
        if (config && config.url) {
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
    };

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
        const res = await saveDatabaseSettings(url);
        if (res.success) {
            setSaveStatus("saved");
            setTimeout(() => setSaveStatus("idle"), 2500);
        } else {
            setSaveStatus("idle");
            alert("Erreur lors de la sauvegarde : " + res.error);
        }
    };

    return (
        <div className="space-y-6 max-w-xl">
            <div>
                <h1 className="text-[22px] font-bold tracking-[-0.4px]" style={{ color: "var(--text-primary)" }}>Paramètres</h1>
                <p className="text-[13px] mt-1" style={{ color: "var(--text-secondary)" }}>Configuration de la connexion et des services.</p>
            </div>

            {/* PostgreSQL */}
            <Section title="PostgreSQL" subtitle="Connexion à votre instance Docker ou distante">
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
                    <label htmlFor="ssl" className="text-[12px] cursor-pointer" style={{ color: "var(--text-secondary)" }}>Connexion SSL</label>
                </div>
                <div className="flex items-center gap-3">
                    <button onClick={testDb} disabled={dbStatus === "testing"} className="apple-btn-secondary">
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
                        className="flex items-center gap-2 text-[12px] font-medium transition-colors hover:text-emerald-500"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Recharger la configuration enregistrée sur le serveur
                    </button>
                </div>
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
                            className="apple-btn-secondary whitespace-nowrap"
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
                    <select
                        value={selectedModel}
                        onChange={(e) => setSelectedModel(e.target.value)}
                        disabled={models.length === 0}
                        className="apple-input"
                    >
                        {models.length === 0
                            ? <option>— Modèles non chargés —</option>
                            : models.map((m) => (
                                <option key={m.id} value={m.id}>
                                    {m.free ? "🆓 " : ""}{m.name}
                                </option>
                            ))
                        }
                    </select>
                </Field>
            </Section>

            {/* Apparence */}
            <Section title="Apparence">
                <div className="flex items-center justify-between">
                    <div>
                        <p className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>Thème</p>
                        <p className="text-[12px]" style={{ color: "var(--text-secondary)" }}>Interface claire ou sombre</p>
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
                        <p className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>Densité de la grille</p>
                        <p className="text-[12px]" style={{ color: "var(--text-secondary)" }}>Hauteur de ligne par défaut</p>
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
            <Section title="Score Produit" subtitle="Paramètres de l'algorithme d'évaluation des performances">
                <Field
                    label={`Seuil d'axe fort : ${seuilAxeFort.toFixed(1)}%`}
                    hint="Pourcentage minimum du poids fournisseur pour qu'une dimension (Quantité, CA, Marge) soit considérée comme un point fort du produit."
                >
                    <div className="flex items-center gap-4">
                        <input
                            type="range"
                            min="5"
                            max="100"
                            step="5"
                            value={seuilAxeFort}
                            onChange={(e) => setSeuilAxeFort(parseFloat(e.target.value))}
                            className="flex-1 accent-emerald-500 cursor-pointer"
                        />
                        <div className="relative w-20">
                            <input
                                type="number"
                                min="5"
                                max="100"
                                step="5"
                                value={seuilAxeFort}
                                onChange={(e) => setSeuilAxeFort(parseFloat(e.target.value) || 30.0)}
                                className="apple-input font-mono-nums text-right pr-6"
                            />
                            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[12px]" style={{ color: "var(--text-muted)" }}>%</span>
                        </div>
                    </div>
                </Field>

                <Field
                    label={`Bonus par axe : +${bonusParAxe} pts`}
                    hint="Points supplémentaires accordés au score final pour chaque axe dépassant le seuil."
                >
                    <div className="flex items-center gap-4">
                        <input
                            type="range"
                            min="0"
                            max="20"
                            step="1"
                            value={bonusParAxe}
                            onChange={(e) => setBonusParAxe(parseInt(e.target.value, 10))}
                            className="flex-1 accent-emerald-500 cursor-pointer"
                        />
                        <div className="w-20">
                            <input
                                type="number"
                                min="0"
                                max="20"
                                step="1"
                                value={bonusParAxe}
                                onChange={(e) => setBonusParAxe(parseInt(e.target.value, 10) || 0)}
                                className="apple-input font-mono-nums text-right"
                            />
                        </div>
                    </div>
                </Field>

                <div className="pt-2">
                    <button
                        onClick={resetScoreDefaults}
                        className="flex items-center gap-2 text-[12px] font-medium transition-colors hover:text-emerald-500"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Rétablir les valeurs par défaut
                    </button>
                </div>
            </Section>

            {/* Save */}
            <div className="flex items-center gap-3">
                <button
                    onClick={handleSave}
                    disabled={saveStatus === "saving"}
                    className="apple-btn-primary"
                    style={{ background: "var(--accent)" }}
                >
                    {saveStatus === "saving" ? <Loader2 className="w-4 h-4 animate-spin" /> : saveStatus === "saved" ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                    {saveStatus === "saving" ? "Enregistrement..." : saveStatus === "saved" ? "Sauvegardé !" : "Sauvegarder la configuration"}
                </button>
            </div>
        </div>
    );
}
