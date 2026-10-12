import { Component, type ErrorInfo, type ReactNode } from "react";
import { refreshPage } from "@/lib/page-data";

interface Props {
    /** Rendu à la place de la page en erreur ; `reset` relance son chargement. */
    fallback: (error: Error, reset: () => void) => ReactNode;
    children: ReactNode;
}

interface State {
    error: Error | null;
}

/**
 * Frontière d'erreur d'une page (équivalent de `error.tsx`) : le menu et
 * l'en-tête restent utilisables. Elle est remontée à chaque changement de page
 * (clé posée par le routeur), comme celle de Next.js.
 */
export class RouteErrorBoundary extends Component<Props, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: unknown): State {
        return { error: error instanceof Error ? error : new Error(String(error)) };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        void error;
        void info;
    }

    private reset = () => {
        // Nouvelle clé de données (sans transition : la silhouette s'affiche),
        // puis nouvel essai de rendu de la page.
        refreshPage({ transition: false });
        this.setState({ error: null });
    };

    render(): ReactNode {
        if (this.state.error) return this.props.fallback(this.state.error, this.reset);
        return this.props.children;
    }
}
