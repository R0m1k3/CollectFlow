"use client";

/**
 * CollectFlow — Informations de connexion à l'API `/api/v1`.
 *
 * Tout ce qu'il faut pour appeler l'API depuis un script : URL de base, en-tête
 * d'authentification, liste des endpoints et exemples copiables. L'URL de base est
 * déduite de l'origine courante, pour rester juste quel que soit le déploiement.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Copy, Check, ExternalLink, Bot, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/feedback";

function CopyButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);
    const copier = async () => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            toast.erreur("La copie automatique a échoué : sélectionnez le texte et copiez-le à la main.");
        }
    };
    return (
        <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={copier}
            aria-label="Copier"
            title="Copier"
            className="shrink-0"
        >
            {copied ? <Check className="text-[var(--accent-success)]" /> : <Copy />}
        </Button>
    );
}

function CodeLine({ children, copy }: { children: string; copy?: string }) {
    return (
        <div className="flex items-start gap-2">
            <code className="flex-1 whitespace-pre-wrap break-all rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1.5 font-mono text-[13px] text-[var(--text-primary)]">
                {children}
            </code>
            <CopyButton text={copy ?? children} />
        </div>
    );
}

function Bloc({ titre, children }: { titre: ReactNode; children: ReactNode }) {
    return (
        <section className="space-y-2">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">{titre}</h3>
            {children}
        </section>
    );
}

/** Référence technique repliée : utile aux développeurs, superflue pour les autres. */
function Repli({ titre, children }: { titre: ReactNode; children: ReactNode }) {
    return (
        <details className="group rounded-lg border border-[var(--border)]">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] [&::-webkit-details-marker]:hidden">
                <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform group-open:rotate-90" aria-hidden />
                {titre}
            </summary>
            <div className="space-y-2 border-t border-[var(--border)] p-3">{children}</div>
        </details>
    );
}

const ENDPOINTS: Array<{ method: string; path: string; desc: string }> = [
    { method: "GET", path: "/fournisseurs", desc: "Fournisseurs, avec la date de calcul de leur grille" },
    { method: "GET", path: "/grid?fournisseur=CODE", desc: "Lignes de la grille d'un fournisseur" },
    { method: "GET", path: "/nomenclatures?fournisseur=CODE", desc: "Postes de nomenclature d'un fournisseur, avec nombre d'articles et chiffre d'affaires" },
    { method: "GET", path: "/products/search?q=terme", desc: "Recherche de produits, tous fournisseurs confondus" },
    { method: "GET", path: "/products/{codein}", desc: "Fiche complète d'un produit" },
    { method: "PUT", path: "/products/{codein}/gamme", desc: "Affecter ou changer la gamme d'un produit — corps : { \"gamme\": \"A\" }" },
    { method: "POST", path: "/gammes", desc: "Affecter ou changer la gamme de plusieurs produits d'un fournisseur en un appel" },
    { method: "GET", path: "/network/{codeCentrale}", desc: "Ventes du réseau (Qlik) et courbe sur 12 mois" },
    { method: "GET", path: "/openapi.json", desc: "Description de l'API lisible par un programme (format OpenAPI)" },
];

const PARAMS: Array<{ name: string; desc: string }> = [
    { name: "page, limit", desc: "Pagination, sans plafond. Sur /grid, omettre limit renvoie TOUT le fournisseur en un appel ; ailleurs le défaut est 100." },
    { name: "sort, order", desc: "Tri, ex. sort=totalCa&order=desc." },
    { name: "search", desc: "Libellé, codein, GTIN, référence ou code centrale." },
    { name: "nomenclature", desc: "Début du code de nomenclature : 32 (univers), 3202 (famille), 320211 (sous-famille)." },
    { name: "gamme, code1..code3", desc: "Filtres sur la gamme et les codes exacts de nomenclature." },
    { name: "fields", desc: "Champs à conserver, séparés par des virgules : allège fortement la réponse." },
    { name: "enrich", desc: "1 par défaut : ventes du réseau (Qlik) et gamme enregistrée relues à chaque appel. 0 pour s'en dispenser." },
    { name: "compute", desc: "1 par défaut : calcule le fournisseur s'il n'a jamais été ouvert (premier appel plus lent). 0 pour échouer tout de suite." },
];

export function ApiConnectionInfo() {
    const [origin, setOrigin] = useState("");
    // `window` n'existe pas au rendu serveur : lire l'origine après montage est le
    // seul moyen d'afficher l'URL réelle sans provoquer d'écart d'hydratation.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { setOrigin(window.location.origin); }, []);
    const base = `${origin || "https://votre-domaine"}/api/v1`;

    return (
        <Card>
            <CardHeader
                title="Se connecter à l'API"
                description="L'API permet à un script ou à un outil externe de lire les données de CollectFlow : grilles des fournisseurs, recherche de produits, ventes du réseau. Elle ne permet aucune modification."
            />
            <CardContent className="space-y-6">
                <Bloc titre="Adresse de base">
                    <CodeLine>{base}</CodeLine>
                </Bloc>

                <Bloc titre="Identification">
                    <p className="text-[13px] text-[var(--text-secondary)]">
                        Chaque appel doit porter une clé (à créer dans le cadre « Clés d&apos;accès à l&apos;API » ci-dessous),
                        dans l&apos;un ou l&apos;autre de ces en-têtes. Depuis un navigateur déjà connecté à CollectFlow,
                        aucune clé n&apos;est nécessaire.
                    </p>
                    <CodeLine>X-API-Key: VOTRE_CLE</CodeLine>
                    <CodeLine>Authorization: Bearer VOTRE_CLE</CodeLine>
                </Bloc>

                {/* Branchement d'une IA externe (ChatGPT) */}
                <Bloc
                    titre={
                        <span className="inline-flex items-center gap-2">
                            <Bot className="h-4 w-4 text-[var(--accent)]" aria-hidden />
                            Connecter une IA externe (ChatGPT)
                        </span>
                    }
                >
                    <ol className="list-decimal space-y-2 pl-5 text-[13px] text-[var(--text-secondary)]">
                        <li>Créez une clé dans le cadre « Clés d&apos;accès à l&apos;API » ci-dessous et copiez-la.</li>
                        <li>Dans ChatGPT : <strong>Créer un GPT</strong> → onglet <strong>Configurer</strong> → <strong>Créer une action</strong>.</li>
                        <li>
                            Cliquez sur <strong>Importer depuis une URL</strong> et collez l&apos;adresse de la description de l&apos;API :
                            <div className="mt-1.5"><CodeLine>{`${base}/openapi.json`}</CodeLine></div>
                            <span className="mt-1 block text-[var(--text-muted)]">
                                Cette description est publique (elle ne contient aucune donnée) pour que ChatGPT puisse la lire.
                                L&apos;application doit être joignable depuis Internet.
                            </span>
                        </li>
                        <li>
                            Dans <strong>Authentification</strong>, choisissez <strong>Clé d&apos;API</strong>, type{" "}
                            <strong>Personnalisé</strong>, nom d&apos;en-tête <code className="font-mono">X-API-Key</code>,
                            et collez votre clé.
                        </li>
                        <li>Testez avec une question du type « cherche les produits tapis » : le GPT appellera <code className="font-mono">rechercherProduits</code>.</li>
                    </ol>
                    <p className="text-xs text-[var(--text-muted)]">
                        Si l&apos;adresse publique de l&apos;application diffère de celle affichée ici, renseignez la variable
                        d&apos;environnement <code className="font-mono">COLLECTFLOW_PUBLIC_URL</code> : elle fixe l&apos;adresse
                        annoncée dans la description.
                    </p>
                </Bloc>

                <div className="space-y-2">
                    <Repli titre="Adresses disponibles (endpoints)">
                        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
                            <table className="w-full">
                                <thead className="bg-[var(--bg-elevated)] text-[13px] font-semibold text-[var(--text-secondary)]">
                                    <tr>
                                        <th scope="col" className="px-3 py-2 text-left">Méthode</th>
                                        <th scope="col" className="px-3 py-2 text-left">Adresse</th>
                                        <th scope="col" className="px-3 py-2 text-left">Contenu</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {ENDPOINTS.map((e) => (
                                        <tr key={e.path} className="border-t border-[var(--border)] align-top">
                                            <td className="px-3 py-2 font-mono text-sm font-semibold text-[var(--accent)]">{e.method}</td>
                                            <td className="px-3 py-2 font-mono text-sm text-[var(--text-primary)]">{e.path}</td>
                                            <td className="px-3 py-2 text-sm text-[var(--text-secondary)]">{e.desc}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </Repli>

                    <Repli titre="Paramètres communs">
                        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
                            <table className="w-full">
                                <thead className="bg-[var(--bg-elevated)] text-[13px] font-semibold text-[var(--text-secondary)]">
                                    <tr>
                                        <th scope="col" className="px-3 py-2 text-left">Paramètre</th>
                                        <th scope="col" className="px-3 py-2 text-left">Effet</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {PARAMS.map((p) => (
                                        <tr key={p.name} className="border-t border-[var(--border)] align-top">
                                            <td className="whitespace-nowrap px-3 py-2 font-mono text-sm text-[var(--text-primary)]">{p.name}</td>
                                            <td className="px-3 py-2 text-sm text-[var(--text-secondary)]">{p.desc}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </Repli>

                    <Repli titre="Exemples d'appels">
                        <CodeLine>{`curl -X PUT -H "X-API-Key: VOTRE_CLE" -H "Content-Type: application/json" \\\n  -d '{"gamme":"B"}' "${base}/products/123456/gamme"`}</CodeLine>
                        <CodeLine>{`curl -H "X-API-Key: VOTRE_CLE" \\\n  "${base}/products/search?q=tapis&limit=20"`}</CodeLine>
                        <CodeLine>{`curl -H "X-API-Key: VOTRE_CLE" \\\n  "${base}/grid?fournisseur=FOU001&fields=codein,libelle1,totalCa,codeGammeServeur"`}</CodeLine>
                        <p className="pt-1 text-[13px] text-[var(--text-secondary)]">
                            Tout un fournisseur en un seul appel : il suffit d&apos;omettre <code className="font-mono">limit</code>,
                            et <code className="font-mono">meta.complet</code> confirme qu&apos;il ne reste rien à lire.
                        </p>
                        <CodeLine>{`curl -H "X-API-Key: VOTRE_CLE" \\\n  "${base}/grid?fournisseur=FOU001"`}</CodeLine>
                        <p className="pt-1 text-[13px] text-[var(--text-secondary)]">
                            Gros fournisseur (plusieurs dizaines de milliers d&apos;articles) : lister d&apos;abord les
                            postes de nomenclature, puis les traiter un par un.
                        </p>
                        <CodeLine>{`curl -H "X-API-Key: VOTRE_CLE" \\\n  "${base}/nomenclatures?fournisseur=D005&niveau=1"`}</CodeLine>
                        <CodeLine>{`curl -H "X-API-Key: VOTRE_CLE" \\\n  "${base}/grid?fournisseur=D005&nomenclature=32"`}</CodeLine>
                    </Repli>
                </div>

                {/* Comportement à connaître */}
                <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-4 text-[13px] text-[var(--text-secondary)]">
                    <p className="font-semibold text-[var(--text-primary)]">Bon à savoir</p>
                    <p>
                        <strong>L&apos;API lit des grilles déjà calculées</strong>, enregistrées quand la Grille est ouverte dans
                        l&apos;application ou par le préchauffage ci-dessous. Un fournisseur jamais calculé l&apos;est au premier
                        appel, qui est alors plus lent ; avec <code className="font-mono">compute=0</code>, l&apos;API répond
                        aussitôt <code className="font-mono">202 not_ready</code>.
                    </p>
                    <p>
                        <strong>Les ventes du réseau</strong> (<code className="font-mono">network</code>) et <strong>la gamme
                        enregistrée</strong> (<code className="font-mono">codeGammeServeur</code>) sont relues à chaque appel.{" "}
                        <code className="font-mono">network</code> vaut <code className="font-mono">null</code> quand le produit
                        n&apos;a pas de données réseau.
                    </p>
                    <p>
                        En cas d&apos;erreur, la réponse a la forme <code className="font-mono">{`{ "error": { "code", "message" } }`}</code> avec
                        le code <code className="font-mono">401</code> (clé absente, invalide ou révoquée), <code className="font-mono">400</code>{" "}
                        (paramètre incorrect) ou <code className="font-mono">404</code> (introuvable).
                    </p>
                </div>

                <Button asChild variant="outline">
                    <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
                        Ouvrir la description complète de l&apos;API (OpenAPI) <ExternalLink />
                    </a>
                </Button>
            </CardContent>
        </Card>
    );
}
