import { Sidebar } from "@/components/shared/sidebar";
import { Header } from "@/components/shared/header";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex h-screen w-full overflow-hidden" style={{ background: "var(--bg-base)" }}>
            <Sidebar />
            <main className="flex-1 ml-16 flex flex-col h-full min-w-0 overflow-hidden">
                <Header />
                <div className="flex-1 overflow-auto p-4 md:p-8">
                    {children}
                </div>
            </main>
        </div>
    );
}
