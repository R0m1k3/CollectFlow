
import { ScoringEngine } from "../src/features/ai-copilot/business/scoring-engine";
import { ProductAnalysisInput } from "../src/features/ai-copilot/models/ai-analysis.types";

const mockProducts: ProductAnalysisInput[] = [
    { codein: "PROD1", libelle1: "Nouveau Récent", regularityScore: 1, inactivityMonths: 0, totalCa: 100, totalQuantite: 10, tauxMarge: 30, score: 50, storeCount: 1, sales12m: {} },
    { codein: "PROD2", libelle1: "Nouveau Ancien", regularityScore: 1, inactivityMonths: 6, totalCa: 100, totalQuantite: 10, tauxMarge: 30, score: 50, storeCount: 1, sales12m: {} },
    { codein: "PROD3", libelle1: "Ancien Actif", regularityScore: 12, inactivityMonths: 0, totalCa: 1000, totalQuantite: 100, tauxMarge: 30, score: 50, storeCount: 1, sales12m: {} },
    { codein: "PROD4", libelle1: "Nouveau Limite", regularityScore: 2, inactivityMonths: 1, totalCa: 100, totalQuantite: 10, tauxMarge: 30, score: 50, storeCount: 1, sales12m: {} },
    { codein: "PROD5", libelle1: "Nouveau Hors Limite", regularityScore: 2, inactivityMonths: 2, totalCa: 100, totalQuantite: 10, tauxMarge: 30, score: 50, storeCount: 1, sales12m: {} },
];

console.log("--- Testing isRecent Logic ---");

mockProducts.forEach(p => {
    const result = ScoringEngine.analyzeRayon(p, mockProducts);
    console.log(`Product: ${p.libelle1} (reg: ${p.regularityScore}, inact: ${p.inactivityMonths})`);
    console.log(`  isRecent: ${result.decision.isRecent}`);
    console.log(`  Recommendation: ${result.decision.recommendation}`);
});

// Expectations:
// PROD1: true (1 < 3 && 0 <= 1)
// PROD2: false (1 < 3 && 6 > 1) -> Recommendation should NOT be protected (unless score high)
// PROD3: false (12 >= 3)
// PROD4: true (2 < 3 && 1 <= 1)
// PROD5: false (2 < 3 && 2 > 1)
