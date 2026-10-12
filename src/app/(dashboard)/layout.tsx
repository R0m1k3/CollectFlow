import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { Sidebar } from "@/components/shared/sidebar";
import { Header } from "@/components/shared/header";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
    const { pathname } = useLocation();
    const contenu = useRef<HTMLDivElement>(null);

    // Changement de page : on repart du haut, comme une navigation Next.js.
    useEffect(() => {
        contenu.current?.scrollTo({ top: 0 });
    }, [pathname]);

    return (
        <div className="flex h-screen w-full overflow-hidden" style={{ background: "var(--bg-base)" }}>
            <Sidebar />
            <main className="flex-1 flex flex-col h-full min-w-0 overflow-hidden">
                <Header />
                <div ref={contenu} className="flex-1 overflow-y-auto flex flex-col p-4 md:p-6">
                    {children}
                </div>
            </main>
        </div>
    );
}
