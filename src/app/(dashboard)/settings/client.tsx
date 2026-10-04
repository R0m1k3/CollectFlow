"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
    AlertCircle,
    CheckCircle2,
    Eye,
    EyeOff,
    FileText,
    KeyRound,
    Loader2,
    PlugZap,
    RefreshCw,
    RotateCcw,
    Save,
    Settings,
    Users,
} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, useUrlTab, type TabItem } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/form-controls";
import { Terme } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/feedback";
import { fmtEntier } from "@/lib/format";
import { isStaleServerActionError, STALE_ACTION_MESSAGE } from "@/lib/stale-action";
import { useDbSettingsStore } from "@/features/settings/store/use-db-settings-store";
import {
    testDatabaseConnection,
    saveDatabaseSettings,
    getSavedDatabaseConfig,
    saveQlikSettings,
    testQlikConnection,
    saveFfApiSettings,
    testFfApiConnection,
} from "@/features/settings/actions";
import { UserManagement } from "@/features/admin/components/user-management";
import { ApiKeyManagement } from "@/features/admin/components/api-key-management";
import { ApiConnectionInfo } from "@/features/admin/components/api-connection-info";
import { GridWarmup } from "@/features/admin/components/grid-warmup";
import { ServerLogs } from "@/features/settings/components/server-logs";

/**
 * Configuration enregistrée, lue UNE fois pour toute la page : trois sections
 * (connexion, API FF, Qlik) la demandaient chacune au montage, et les actions
 * serveur s'exécutent les unes après les autres.
 */
let savedConfigPromise: ReturnType<typeof getSavedDatabaseConfig> | null = null;
function loadSavedConfig(force = false): ReturnType<typeof getSavedDatabaseConfig> {
    if (force || !savedConfigPromise) {
        savedConfigPromise = getSavedDatabaseConfig().catch((e) => {
            savedConfigPromise = null;
            throw e;
        });
    }
    return savedConfigPromise;
}

/** Message lisible d'une erreur de server action (onglet périmé compris). */
function messageErreur(e: unknown): string {
    if (isStaleServerActionError(e)) return STALE_ACTION_MESSAGE;
    return e instanceof Error ? e.message : String(e);
}

function fmtDateHeure(valeur: string | null | undefined): string {
    if (!valeur) return "—";
    const d = new Date(valeur);
    return isNaN(d.getTime()) ? valeur : d.toLocaleString("fr-FR");
}

// ── Onglets ──────────────────────────────────────────────────────────────────

type Onglet = "connexions" | "utilisateurs" | "api" | "journal";

const ONGLETS: readonly TabItem<Onglet>[] = [
    { value: "connexions", label: "Connexions", icon: PlugZap },
    { value: "utilisateurs", label: "Utilisateurs", icon: Users },
    { value: "api", label: "Accès API", icon: KeyRound },
    { value: "journal", label: "Journal serveur", icon: FileText },
];

function estOnglet(v: string | undefined): v is Onglet {
    return ONGLETS.some((o) => o.value === v);
}

/**
 * Contenu d'un onglet : monté à la première visite puis seulement masqué, pour
 * qu'une saisie non enregistrée survive au changement d'onglet et que rien ne
 * soit rechargé en revenant.
 */
function Panneau({ actif, visite, children }: { actif: boolean; visite: boolean; children: ReactNode }) {
    if (!visite) return null;
    return (
        <div role="tabpanel" hidden={!actif} className="space-y-6">
            {children}
        </div>
    );
}

// ── Éléments de formulaire ───────────────────────────────────────────────────

function Champ({ id, label, aide, children, className }: {
    id: string;
    label: ReactNode;
    aide?: ReactNode;
    children: ReactNode;
    className?: string;
}) {
    return (
        <div className={className}>
            <Label htmlFor={id}>{label}</Label>
            {children}
            {aide && <p className="mt-1 text-xs text-[var(--text-muted)]">{aide}</p>}
        </div>
    );
}

type EtatTest = { etat: "idle" } | { etat: "en-cours" } | { etat: "ok" } | { etat: "erreur"; message: string };

/** Résultat d'un test de connexion, affiché à côté des boutons. */
function ResultatTest({ test }: { test: EtatTest }) {
    if (test.etat === "ok") {
        return (
            <Badge ton="succes">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Connexion réussie
            </Badge>
        );
    }
    if (test.etat === "erreur") {
        return (
            <p role="alert" className="flex items-start gap-1.5 text-[13px] text-[var(--accent-error)]">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>
                    <span className="font-semibold">Connexion impossible.</span>{" "}
                    <span className="text-[var(--text-secondary)]">{test.message}</span>
                </span>
            </p>
        );
    }
    return null;
}

// ── PostgreSQL ───────────────────────────────────────────────────────────────

/**
 * `motDePasseEnregistre` : le serveur ne renvoie jamais le mot de passe, seulement
 * qu'il en existe un. Le champ reste alors vide et « vide » veut dire « inchangé ».
 */
function SectionPostgres({ recharger, motDePasseEnregistre }: { recharger: () => Promise<void>; motDePasseEnregistre: boolean }) {
    const {
        host, setHost,
        port, setPort,
        database, setDatabase,
        user, setUser,
        password, setPassword,
        ssl, setSsl,
        getDatabaseUrl,
    } = useDbSettingsStore();

    const [test, setTest] = useState<EtatTest>({ etat: "idle" });
    const [enregistrement, setEnregistrement] = useState(false);
    const [rechargement, setRechargement] = useState(false);

    const tester = async () => {
        setTest({ etat: "en-cours" });
        try {
            const res = await testDatabaseConnection(getDatabaseUrl());
            setTest(res.success ? { etat: "ok" } : { etat: "erreur", message: res.error || "Erreur de connexion inconnue." });
        } catch (e) {
            setTest({ etat: "erreur", message: messageErreur(e) });
        }
    };

    const enregistrer = async () => {
        setEnregistrement(true);
        try {
            const res = await saveDatabaseSettings(getDatabaseUrl());
            if (res.success) {
                toast.succes("Connexion à la base PostgreSQL enregistrée.");
                // Un mot de passe vient d'être saisi : on relit la config pour vider
                // le champ et afficher qu'il est désormais enregistré.
                if (password) await recharger().catch(() => { /* simple rafraîchissement */ });
            } else toast.erreur(`Enregistrement impossible : ${res.error ?? "erreur inconnue"}`);
        } catch (e) {
            toast.erreur(`Enregistrement impossible : ${messageErreur(e)}`);
        } finally {
            setEnregistrement(false);
        }
    };

    const rechargerConfig = async () => {
        setRechargement(true);
        try {
            await recharger();
            toast.info("Les valeurs enregistrées sur le serveur ont été rechargées.");
        } catch (e) {
            toast.erreur(`La configuration n'a pas pu être relue : ${messageErreur(e)}`);
        } finally {
            setRechargement(false);
        }
    };

    return (
        <Card>
            <CardHeader
                title="Base de données de l'application (PostgreSQL)"
                description="Contient les comptes utilisateurs, l'historique des sessions et les réglages. Les produits et les ventes, eux, viennent de l'API FF Nancy."
            />
            <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                    <Champ
                        id="pg-hote"
                        label="Serveur"
                        aide="Adresse du serveur : localhost, une adresse IP (192.168.1.10) ou le nom du service Docker (postgres, db)."
                        className="sm:col-span-2"
                    >
                        <Input id="pg-hote" className="w-full font-mono" placeholder="localhost" value={host}
                            onChange={(e) => setHost(e.target.value)} />
                    </Champ>
                    <Champ id="pg-port" label="Port" aide="5432 dans la plupart des installations.">
                        <Input id="pg-port" className="w-full font-mono" placeholder="5432" value={port}
                            onChange={(e) => setPort(e.target.value)} />
                    </Champ>
                    <Champ id="pg-base" label="Nom de la base">
                        <Input id="pg-base" className="w-full font-mono" placeholder="collectflow" value={database}
                            onChange={(e) => setDatabase(e.target.value)} />
                    </Champ>
                    <Champ id="pg-utilisateur" label="Utilisateur">
                        <Input id="pg-utilisateur" className="w-full font-mono" placeholder="postgres" value={user}
                            onChange={(e) => setUser(e.target.value)} autoComplete="off" />
                    </Champ>
                    <Champ
                        id="pg-mdp"
                        label="Mot de passe"
                        aide={motDePasseEnregistre ? "Laissez vide pour garder le mot de passe enregistré (même serveur et même utilisateur)." : undefined}
                    >
                        <Input id="pg-mdp" type="password" className="w-full font-mono"
                            placeholder={motDePasseEnregistre ? "Enregistré — inchangé si vide" : "••••••••"}
                            value={password || ""} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                    </Champ>
                </div>

                <div>
                    <label htmlFor="pg-ssl" className="inline-flex cursor-pointer items-center gap-2 text-sm text-[var(--text-primary)]">
                        <input
                            type="checkbox"
                            id="pg-ssl"
                            checked={ssl}
                            onChange={(e) => setSsl(e.target.checked)}
                            className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
                        />
                        Connexion chiffrée (SSL)
                    </label>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">
                        À cocher si le serveur de base de données l&apos;exige, en général quand il est hébergé à distance.
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-4">
                    <Button onClick={enregistrer} disabled={enregistrement}>
                        {enregistrement ? <Loader2 className="animate-spin" /> : <Save />}
                        Enregistrer
                    </Button>
                    <Button variant="outline" onClick={tester} disabled={test.etat === "en-cours"}>
                        {test.etat === "en-cours" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                        Tester la connexion
                    </Button>
                    <Button variant="ghost" onClick={rechargerConfig} disabled={rechargement}>
                        {rechargement ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                        Recharger les valeurs enregistrées
                    </Button>
                    <ResultatTest test={test} />
                </div>
            </CardContent>
        </Card>
    );
}

// ── API FF Nancy ─────────────────────────────────────────────────────────────

interface FfSyncTable { nom: string; derniereSync: string; nbLignes?: number; statut?: string; erreur?: string | null; }
interface FfSyncStatus { lastSync: string; tables: FfSyncTable[]; }

function SectionFfApi() {
    const [status, setStatus] = useState<FfSyncStatus | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [url, setUrl] = useState("");
    const [savedUrl, setSavedUrl] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [testedUrl, setTestedUrl] = useState<string | null>(null);

    // Charge l'URL enregistrée pour la préremplir (vide = valeur par défaut).
    useEffect(() => {
        loadSavedConfig()
            .then((cfg) => {
                setSavedUrl(cfg?.ffApiBaseUrl ?? null);
                if (cfg?.ffApiBaseUrl) setUrl(cfg.ffApiBaseUrl);
            })
            .catch(() => { /* réglage optionnel ; l'échec de lecture est signalé par la page */ });
    }, []);

    const runTest = useCallback((candidate?: string) => {
        setLoading(true);
        setError(null);
        setStatus(null);
        testFfApiConnection(candidate)
            .then((res) => {
                setTestedUrl(res.url);
                if (res.success) setStatus(res.status as FfSyncStatus);
                else setError(res.error ?? "Échec inconnu.");
            })
            .catch((e) => setError(messageErreur(e)))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => { runTest(); }, [runTest]);

    const save = async () => {
        setSaving(true);
        try {
            const res = await saveFfApiSettings(url);
            if (!res.success) {
                toast.erreur(res.error ?? "Enregistrement impossible.");
                return;
            }
            setSavedUrl(url.trim() || null);
            toast.succes(url.trim() ? "Adresse de l'API FF enregistrée." : "L'adresse par défaut de l'API FF sera utilisée.");
            runTest(url);
        } catch (e) {
            toast.erreur(`Enregistrement impossible : ${messageErreur(e)}`);
        } finally {
            setSaving(false);
        }
    };

    const test: EtatTest = loading ? { etat: "en-cours" } : status ? { etat: "ok" } : error ? { etat: "erreur", message: error } : { etat: "idle" };

    return (
        <Card>
            <CardHeader
                title="API FF Nancy"
                description="Source des produits et des ventes de nos magasins. Ses données sont mises à jour chaque nuit depuis la base FF : elles s'arrêtent donc à la veille."
            />
            <CardContent className="space-y-4">
                <Champ
                    id="ff-url"
                    label="Adresse de l'API"
                    aide="Laissez vide pour utiliser l'adresse par défaut (https://api.ffnancy.fr)."
                >
                    <Input
                        id="ff-url"
                        type="text"
                        placeholder="https://api.ffnancy.fr"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
                        className="w-full font-mono"
                    />
                </Champ>

                <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-4">
                    <Button onClick={save} disabled={saving}>
                        {saving ? <Loader2 className="animate-spin" /> : <Save />}
                        Enregistrer
                    </Button>
                    <Button variant="outline" onClick={() => runTest(url)} disabled={loading}>
                        {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                        Tester la connexion
                    </Button>
                    <ResultatTest test={test} />
                </div>

                {/* L'URL réellement appelée : évite de croire qu'on teste celle du champ
                    alors que le réglage enregistré ou la variable d'environnement prime. */}
                {testedUrl && (
                    <p className="text-xs text-[var(--text-muted)]">
                        Adresse testée : <span className="font-mono">{testedUrl}</span>
                        {!savedUrl && <> (adresse par défaut, aucun réglage enregistré)</>}
                    </p>
                )}

                {status && (
                    <div className="space-y-2">
                        <p className="text-[13px] text-[var(--text-secondary)]">
                            Dernière mise à jour complète des données :{" "}
                            <span className="font-medium text-[var(--text-primary)]">{fmtDateHeure(status.lastSync)}</span>
                        </p>
                        {status.tables?.length > 0 && (
                            <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
                                <table className="w-full">
                                    <thead className="bg-[var(--bg-elevated)] text-[13px] font-semibold text-[var(--text-secondary)]">
                                        <tr>
                                            <th scope="col" className="px-3 py-2 text-left">Table de données</th>
                                            <th scope="col" className="px-3 py-2 text-right">Mise à jour</th>
                                            <th scope="col" className="px-3 py-2 text-right">Lignes</th>
                                            <th scope="col" className="px-3 py-2 text-right">État</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {status.tables.map((t) => (
                                            <tr key={t.nom} className="border-t border-[var(--border)]">
                                                <td className="px-3 py-2 text-sm font-mono text-[var(--text-primary)]">{t.nom}</td>
                                                <td className="px-3 py-2 text-sm text-right text-[var(--text-secondary)]">{fmtDateHeure(t.derniereSync)}</td>
                                                <td className="px-3 py-2 text-sm text-right tabular-nums text-[var(--text-secondary)]">
                                                    {t.nbLignes != null ? fmtEntier(t.nbLignes) : "—"}
                                                </td>
                                                {/* Une table en erreur est précisément ce qu'on vient chercher ici. */}
                                                <td className="px-3 py-2 text-sm text-right">
                                                    {t.statut === "ok"
                                                        ? <Badge ton="succes">OK</Badge>
                                                        : <Badge ton="erreur" title={t.erreur ?? undefined}>{t.statut ?? "—"}</Badge>}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

// ── Qlik Sense ───────────────────────────────────────────────────────────────

function SectionQlik() {
    const [host, setHost] = useState("");
    const [user, setUser] = useState("");
    const [password, setPassword] = useState("");
    // Le mot de passe enregistré n'est jamais renvoyé : on sait seulement qu'il existe.
    const [motDePasseEnregistre, setMotDePasseEnregistre] = useState(false);
    const [showPwd, setShowPwd] = useState(false);
    const [saving, setSaving] = useState(false);
    const [test, setTest] = useState<EtatTest>({ etat: "idle" });

    useEffect(() => {
        loadSavedConfig()
            .then((c) => {
                if (!c) return;
                setHost(c.qlikHost ?? "");
                setUser(c.qlikUser ?? "");
                setMotDePasseEnregistre(c.hasQlikPassword);
            })
            .catch(() => { /* l'échec de lecture est signalé par la page */ });
    }, []);

    const handleSave = async () => {
        setSaving(true);
        try {
            const res = await saveQlikSettings(host.trim(), user.trim(), password);
            if (res.success) {
                toast.succes("Identifiants Qlik enregistrés.");
                if (password) {
                    setMotDePasseEnregistre(true);
                    setPassword("");
                }
            } else toast.erreur(`Enregistrement impossible : ${res.error || "erreur inconnue"}`);
        } catch (e) {
            toast.erreur(`Enregistrement impossible : ${messageErreur(e)}`);
        } finally {
            setSaving(false);
        }
    };

    const handleTest = async () => {
        setTest({ etat: "en-cours" });
        try {
            const res = await testQlikConnection(host.trim(), user.trim(), password);
            setTest(res.success ? { etat: "ok" } : { etat: "erreur", message: res.error || "Échec de la connexion." });
        } catch (e) {
            setTest({ etat: "erreur", message: messageErreur(e) });
        }
    };

    const testImpossible = !user || (!password && !motDePasseEnregistre);

    return (
        <Card>
            <CardHeader
                title="Qlik Sense (données du réseau)"
                description={
                    <>
                        Identifiants utilisés pour récupérer les ventes des magasins du{" "}
                        <Terme id="reseau">réseau</Terme> dans l&apos;outil de reporting Qlik Sense de La Foir&apos;Fouille.
                    </>
                }
            />
            <CardContent className="space-y-4">
                <Champ
                    id="qlik-hote"
                    label="Serveur Qlik"
                    aide="Laissez vide pour utiliser le serveur habituel : reporting-magasins.lafoirfouille.fr."
                >
                    <Input id="qlik-hote" type="text" placeholder="reporting-magasins.lafoirfouille.fr" value={host}
                        onChange={(e) => setHost(e.target.value)} className="w-full font-mono" />
                </Champ>
                <div className="grid gap-4 sm:grid-cols-2">
                    <Champ
                        id="qlik-utilisateur"
                        label="Identifiant"
                        aide="Identifiant Windows sans le domaine, par exemple FFSCH (connexion par authentification Windows, dite NTLM)."
                    >
                        <Input id="qlik-utilisateur" type="text" placeholder="FFSCH" value={user}
                            onChange={(e) => setUser(e.target.value)} className="w-full font-mono" autoComplete="off" />
                    </Champ>
                    <Champ
                        id="qlik-mdp"
                        label="Mot de passe"
                        aide={motDePasseEnregistre ? "Laissez vide pour garder le mot de passe enregistré (même serveur et même identifiant)." : undefined}
                    >
                        <div className="relative">
                            <Input id="qlik-mdp" type={showPwd ? "text" : "password"}
                                placeholder={motDePasseEnregistre ? "Enregistré — inchangé si vide" : "••••••••"} value={password}
                                onChange={(e) => setPassword(e.target.value)} className="w-full pr-10 font-mono" autoComplete="new-password" />
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => setShowPwd((v) => !v)}
                                aria-label={showPwd ? "Masquer le mot de passe" : "Afficher le mot de passe"}
                                title={showPwd ? "Masquer le mot de passe" : "Afficher le mot de passe"}
                                className="absolute right-0.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
                            >
                                {showPwd ? <EyeOff /> : <Eye />}
                            </Button>
                        </div>
                    </Champ>
                </div>

                <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-4">
                    <Button onClick={handleSave} disabled={saving}>
                        {saving ? <Loader2 className="animate-spin" /> : <Save />}
                        Enregistrer
                    </Button>
                    <Button
                        variant="outline"
                        onClick={handleTest}
                        disabled={test.etat === "en-cours" || testImpossible}
                        title={testImpossible ? "Renseignez l'identifiant et le mot de passe pour tester" : undefined}
                    >
                        {test.etat === "en-cours" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                        Tester la connexion
                    </Button>
                    <ResultatTest test={test} />
                </div>
            </CardContent>
        </Card>
    );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function ParametresClient({ onglet: ongletDemande }: { onglet?: string }) {
    const initial: Onglet = estOnglet(ongletDemande) ? ongletDemande : "connexions";
    const [onglet, setOnglet] = useUrlTab<Onglet>("onglet", initial);
    const [visites, setVisites] = useState<ReadonlySet<Onglet>>(() => new Set([initial]));
    const [isMounted, setIsMounted] = useState(false);
    const [pgMotDePasseEnregistre, setPgMotDePasseEnregistre] = useState(false);

    const setHost = useDbSettingsStore((s) => s.setHost);
    const setPort = useDbSettingsStore((s) => s.setPort);
    const setDatabase = useDbSettingsStore((s) => s.setDatabase);
    const setUser = useDbSettingsStore((s) => s.setUser);
    const setPassword = useDbSettingsStore((s) => s.setPassword);
    const setSsl = useDbSettingsStore((s) => s.setSsl);

    const reloadFromServer = useCallback(async (force = false) => {
        const config = await loadSavedConfig(force);
        if (config?.url) {
            // Parser l'URL pour remettre dans le store
            try {
                const url = new URL(config.url.replace("postgres://", "http://")); // URL parser helper
                setHost(url.hostname);
                setPort(url.port || "5432");
                setDatabase(url.pathname.slice(1).split("?")[0]);
                setUser(url.username);
                // Le serveur ne renvoie plus le mot de passe : champ vide = garder
                // l'enregistré. On efface aussi celui qu'une ancienne version a pu
                // laisser dans le localStorage.
                setPassword("");
                setPgMotDePasseEnregistre(config.hasDbPassword);
                setSsl(config.url.includes("sslmode=require"));
            } catch (e) {
                console.error("Failed to parse saved URL", e);
            }
        }
    }, [setDatabase, setHost, setPassword, setPort, setSsl, setUser]);

    useEffect(() => {
        // `isMounted` sert à éviter un écart d'hydratation (réglages PostgreSQL
        // lus dans le localStorage) : il doit donc être posé au montage, ce que
        // la règle déconseille en général mais qui est ici le but.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setIsMounted(true);
        // Lecture fraîche à chaque ouverture de la page ; les sections, montées
        // juste après (cf. `isMounted`), réutilisent cette même requête.
        reloadFromServer(true).catch((e) => {
            toast.erreur(`La configuration enregistrée n'a pas pu être lue : ${messageErreur(e)}`);
        });
    }, [reloadFromServer]);

    const changerOnglet = (suivant: Onglet) => {
        setOnglet(suivant);
        setVisites((prev) => (prev.has(suivant) ? prev : new Set([...prev, suivant])));
    };

    const recharger = useCallback(() => reloadFromServer(true), [reloadFromServer]);

    return (
        <div className="mx-auto w-full max-w-5xl">
            <PageHeader
                icon={Settings}
                title="Paramètres"
                description="Connexions aux sources de données, comptes des utilisateurs et clés d'accès à l'API (réservé aux administrateurs)."
            />

            <Tabs items={ONGLETS} value={onglet} onChange={changerOnglet} className="mb-6" />

            {isMounted && (
                <>
                    <Panneau actif={onglet === "connexions"} visite={visites.has("connexions")}>
                        <SectionPostgres recharger={recharger} motDePasseEnregistre={pgMotDePasseEnregistre} />
                        <SectionFfApi />
                        <SectionQlik />
                    </Panneau>

                    <Panneau actif={onglet === "utilisateurs"} visite={visites.has("utilisateurs")}>
                        <UserManagement />
                    </Panneau>

                    <Panneau actif={onglet === "api"} visite={visites.has("api")}>
                        <ApiConnectionInfo />
                        <ApiKeyManagement />
                        <GridWarmup />
                    </Panneau>

                    <Panneau actif={onglet === "journal"} visite={visites.has("journal")}>
                        <ServerLogs />
                    </Panneau>
                </>
            )}
        </div>
    );
}
