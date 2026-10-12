import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

/**
 * Lint de l'interface (SPA Vite). Seul `src/` est vérifié : `server/` est en
 * Rust, `scripts/` et les fichiers .js de la racine sont des utilitaires Node.
 */
const eslintConfig = defineConfig([
    globalIgnores(["dist/**", "server/**", "scripts/**", "_bmad/**", "_bmad-output/**", "docs/**", "*.js", "*.mjs"]),
    {
        files: ["src/**/*.{ts,tsx}", "vite.config.mts"],
        extends: [js.configs.recommended, tseslint.configs.recommended, reactHooks.configs.flat.recommended],
        plugins: { "react-refresh": reactRefresh },
        languageOptions: {
            ecmaVersion: 2022,
            globals: globals.browser,
        },
        rules: {
            // Exports utilitaires historiques des composants (rechargement à chaud
            // seulement moins fin pour ces fichiers).
            "react-refresh/only-export-components": [
                "warn",
                {
                    allowConstantExport: true,
                    allowExportNames: ["buttonVariants", "toast", "confirmer", "useUrlTab", "PROFONDEUR_MAX"],
                },
            ],
        },
    },
]);

export default eslintConfig;
