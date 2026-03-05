
import { AnalysisEngine } from "./src/features/ai-copilot/business/analysis-engine";

console.log("--- Testing AI Parser Logic for B/C ---");

function simulateParse(content: string, simulateRuleResponse = false) {
    let reco: "A" | "B" | "C" | "Z" | null = null;
    let ruleApplies = simulateRuleResponse;

    try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        const jsonText = jsonMatch ? jsonMatch[0] : content;
        const parsed = JSON.parse(jsonText);

        reco = parsed.recommendation as "A" | "B" | "C" | "Z";
        ruleApplies = parsed.rule_applies === true;

        if (!ruleApplies && (reco === "B" || reco === "C")) reco = "A";

        if (!reco || !["A", "B", "C", "Z"].includes(reco)) {
            reco = AnalysisEngine.extractRecommendation(parsed.justification || "") || "A";
            if (!ruleApplies && (reco === "B" || reco === "C")) reco = "A";
        }
    } catch (e) {
        reco = AnalysisEngine.extractRecommendation(content);
        if (!ruleApplies && (reco === "B" || reco === "C")) reco = "A";
    }
    return reco;
}

const tests = [
    { name: "Valid Rule B", json: '{"rule_applies": true, "recommendation": "B", "justification": "blabla"}', expected: "B" },
    { name: "Valid Rule C", json: '{"rule_applies": true, "recommendation": "C", "justification": "blabla"}', expected: "C" },
    { name: "Invalid Rule B (hallucinated)", json: '{"rule_applies": false, "recommendation": "B", "justification": "blabla"}', expected: "A" },
    { name: "Invalid Rule C (hallucinated)", json: '{"rule_applies": false, "recommendation": "C", "justification": "blabla"}', expected: "A" },
    { name: "Valid Rule A", json: '{"rule_applies": true, "recommendation": "A", "justification": "blabla"}', expected: "A" },
    { name: "Valid Extraction B", json: '{"rule_applies": true, "recommendation": "INVALID", "justification": "Je choisis B."}', expected: "B" },
    { name: "Invalid Extraction B", json: '{"rule_applies": false, "recommendation": "INVALID", "justification": "Je choisis B."}', expected: "A" }
];

let allPassed = true;
tests.forEach(t => {
    const res = simulateParse(t.json);
    const pass = res === t.expected;
    console.log(`${pass ? "✅" : "❌"} ${t.name}: expected ${t.expected}, got ${res}`);
    if (!pass) allPassed = false;
});

if (allPassed) {
    console.log("All parsing tests passed.");
    process.exit(0);
} else {
    console.log("Some tests failed.");
    process.exit(1);
}
