"use client";

/**
 * CollectFlow — Informations de connexion à l'API `/api/v1`.
 *
 * Tout ce qu'il faut pour appeler l'API depuis un script : URL de base, en-tête
 * d'authentification, liste des endpoints et exemples copiables. L'URL de base est
 * déduite de l'origine courante, pour rester juste quel que soit le déploiement.
 */

import { useEffect, useState } from "react";
import { Copy, Check, ExternalLink, Bot } from "lucide-react";

function CopyButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <button
            type="button"
            onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
            className="shrink-0 rounded-lg px-2 py-1.5"
            style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
            title="Copier"
        >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
    );
}

function CodeLine({ children, copy }: { children: string; copy?: string }) {
    return (
        <div className="flex items-start gap-2">
            <code
                className="flex-1 rounded-lg px-2.5 py-1.5 text-[11px] font-mono break-all whitespace-pre-wrap"
                style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
            >
                {children}
            </code>
            <CopyButton text={copy ?? children} />
        </div>
    );
}

const ENDPOINTS: Array<{ method: string; path: string; desc: string }> = [
    { method: "GET", path: "/fournisseurs", desc: "Fournisseurs, avec la fraîcheur de leur instantané" },
    { method: "GET", path: "/grid?fournisseur=CODE", desc: "Lignes de grille d'un fournisseur" },
    { method: "GET", path: "/products/search?q=terme", desc: "Recherche transversale, tous fournisseurs" },
    { method: "GET", path: "/products/{codein}", desc: "Fiche complète d'un produit" },
    { method: "GET", path: "/network/{codeCentrale}", desc: "Métriques réseau Qlik + courbe 12 mois" },
    { method: "GET", path: "/openapi.json", desc: "Spécification lisible par machine" },
];

const PARAMS: Array<{ name: string; desc: string }> = [
    { name: "page, limit", desc: "Pagination (limit ≤ 500, défaut 100)" },
    { name: "sort, order", desc: "Tri, ex. sort=totalCa&order=desc" },
    { name: "search", desc: "Libellé, codein, GTIN, référence ou code centrale" },
    { name: "gamme, code1..code3", desc: "Filtres sur la gamme et la nomenclature" },
    { name: "fields", desc: "Champs à conserver, séparés par des virgules — allège fortement la réponse" },
    { name: "enrich", desc: "1 par défaut : métriques Qlik + gamme serveur relues à l'appel. 0 pour s'en dispenser" },
];

export function ApiConnectionInfo() {
    const [origin, setOrigin] = useState("");
    // `window` n'existe pas au rendu serveur : lire l'origine après montage est le
    // seul moyen d'afficher l'URL réelle sans provoquer d'écart d'hydratation.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { setOrigin(window.location.origin); }, []);
    const base = `${origin || "https://votre-domaine"}/api/v1`;

    return (
        <div className="space-y-5">
            {/* Connexion */}
            <div className="space-y-2">
                <p className="text-[12px] font-semibold" style={{ color: "var(--text-primary)" }}>URL de base</p>
                <CodeLine>{base}</CodeLine>
                <p className="text-[12px] font-semibold pt-1" style={{ color: "var(--text-primary)" }}>Authentification</p>
                <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    Une clé créée ci-dessous, dans l&apos;un ou l&apos;autre de ces en-têtes. Depuis un navigateur
                    connecté, la session suffit — aucune clé n&apos;est nécessaire.
                </p>
                <CodeLine>X-API-Key: VOTRE_CLE</CodeLine>
                <CodeLine>Authorization: Bearer VOTRE_CLE</CodeLine>
            </div>

            {/* Endpoints */}
            <div className="space-y-2">
                <p className="text-[12px] font-semibold" style={{ color: "var(--text-primary)" }}>Endpoints</p>
                <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
                    <table className="w-full text-[11px]">
                        <tbody>
                            {ENDPOINTS.map((e, i) => (
                                <tr key={e.path} style={{ borderTop: i === 0 ? undefined : "1px solid var(--border)" }}>
                                    <td className="px-2.5 py-1.5 font-mono font-bold align-top" style={{ color: "var(--accent)", width: 40 }}>{e.method}</td>
                                    <td className="px-2.5 py-1.5 font-mono align-top" style={{ color: "var(--text-primary)" }}>{e.path}</td>
                                    <td className="px-2.5 py-1.5 align-top" style={{ color: "var(--text-muted)" }}>{e.desc}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Paramètres */}
            <div className="space-y-2">
                <p className="text-[12px] font-semibold" style={{ color: "var(--text-primary)" }}>Paramètres communs</p>
                <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
                    <table className="w-full text-[11px]">
                        <tbody>
                            {PARAMS.map((p, i) => (
                                <tr key={p.name} style={{ borderTop: i === 0 ? undefined : "1px solid var(--border)" }}>
                                    <td className="px-2.5 py-1.5 font-mono align-top whitespace-nowrap" style={{ color: "var(--text-primary)" }}>{p.name}</td>
                                    <td className="px-2.5 py-1.5 align-top" style={{ color: "var(--text-muted)" }}>{p.desc}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Exemples */}
            <div className="space-y-2">
                <p className="text-[12px] font-semibold" style={{ color: "var(--text-primary)" }}>Exemples</p>
                <CodeLine>{`curl -H "X-API-Key: VOTRE_CLE" \\\n  "${base}/products/search?q=tapis&limit=20"`}</CodeLine>
                <CodeLine>{`curl -H "X-API-Key: VOTRE_CLE" \\\n  "${base}/grid?fournisseur=FOU001&fields=codein,libelle1,totalCa,codeGammeServeur"`}</CodeLine>
            </div>

            {/* Branchement d'une IA externe (ChatGPT) */}
            <div className="space-y-2">
                <p className="text-[12px] font-semibold flex items-center gap-1.5" style={{ color: "var(--text-primary)" }}>
                    <Bot className="w-4 h-4" style={{ color: "var(--accent)" }} />
                    Connecter une IA externe (ChatGPT)
                </p>
                <ol className="text-[11px] space-y-1.5 list-decimal pl-4" style={{ color: "var(--text-secondary)" }}>
                    <li>Créez une clé d&apos;API dans la section ci-dessous et copiez-la.</li>
                    <li>Dans ChatGPT : <strong>Créer un GPT</strong> → onglet <strong>Configurer</strong> → <strong>Créer une action</strong>.</li>
                    <li>
                        Cliquez sur <strong>Importer depuis une URL</strong> et collez l&apos;adresse du schéma :
                        <div className="mt-1"><CodeLine>{`${base}/openapi.json`}</CodeLine></div>
                        <span style={{ color: "var(--text-muted)" }}>
                            Ce schéma est public (il ne contient aucune donnée) pour que ChatGPT puisse l&apos;importer.
                            Votre application doit être joignable depuis Internet.
                        </span>
                    </li>
                    <li>
                        Dans <strong>Authentification</strong>, choisissez <strong>Clé d&apos;API</strong>, type{" "}
                        <strong>Personnalisé</strong>, nom d&apos;en-tête <code className="font-mono">X-API-Key</code>,
                        et collez votre clé.
                    </li>
                    <li>Testez avec une question du type « cherche les produits tapis » — le GPT appellera <code className="font-mono">rechercherProduits</code>.</li>
                </ol>
                <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    Si votre domaine public diffère de celui affiché ici, renseignez la variable
                    d&apos;environnement <code className="font-mono">COLLECTFLOW_PUBLIC_URL</code> : elle fixe l&apos;URL
                    déclarée dans le schéma.
                </p>
            </div>

            {/* Comportement à connaître */}
            <div className="rounded-xl p-3 text-[11px] space-y-1.5"
                style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
                <p><strong>Aucun recalcul.</strong> L&apos;API lit l&apos;instantané de la grille, écrit quand la Grille
                    est ouverte dans l&apos;application. Un fournisseur jamais consulté renvoie <code className="font-mono">202</code>{" "}
                    <code className="font-mono">not_ready</code> plutôt que de faire attendre.</p>
                <p><strong>Métriques Qlik</strong> (<code className="font-mono">network</code>) et{" "}
                    <strong>gamme serveur non modifiée</strong> (<code className="font-mono">codeGammeServeur</code>) sont
                    relues à chaque appel. <code className="font-mono">network</code> vaut{" "}
                    <code className="font-mono">null</code> quand le produit n&apos;a pas de données réseau.</p>
                <p>Erreurs : <code className="font-mono">{`{ "error": { "code", "message" } }`}</code> avec{" "}
                    <code className="font-mono">401</code> (clé absente/invalide/révoquée),{" "}
                    <code className="font-mono">400</code>, <code className="font-mono">404</code>.</p>
            </div>

            <a
                href="/api/v1/openapi.json"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-[12px] font-medium"
                style={{ color: "var(--accent)" }}
            >
                Ouvrir la spécification OpenAPI <ExternalLink className="w-3.5 h-3.5" />
            </a>
        </div>
    );
}
