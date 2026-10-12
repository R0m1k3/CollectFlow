import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const src = (chemin: string) => fileURLToPath(new URL(`./src/${chemin}`, import.meta.url));

/**
 * Interface CollectFlow : SPA React compilée dans `dist/`, servie par le
 * serveur Rust (`STATIC_DIR`). Tailwind 4 passe par PostCSS (postcss.config.mjs).
 *
 * Les modules `next/link`, `next/navigation` et `next-auth/react` sont
 * remplacés par de petites adaptations à React Router et à l'authentification
 * du serveur Rust (src/shims) : les composants restent inchangés.
 */
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: [
            { find: /^next\/link$/, replacement: src("shims/next-link.tsx") },
            { find: /^next\/navigation$/, replacement: src("shims/next-navigation.ts") },
            { find: /^next-auth\/react$/, replacement: src("shims/next-auth-react.ts") },
            { find: /^@\//, replacement: src("") },
        ],
    },
    server: {
        port: 3000,
        proxy: {
            "/api": { target: "http://localhost:5643", changeOrigin: false },
        },
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        sourcemap: false,
        // exceljs et jspdf (chargés à la demande) dépassent le seuil par défaut.
        chunkSizeWarningLimit: 1000,
    },
});
