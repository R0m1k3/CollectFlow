const fs = require('fs');

function extractRecommendation(content) {
    const match = content.match(/\b([ABCDZ])\b/i);
    if (match) return match[1].toUpperCase();
    return null;
}

function simulateParse(content) {
    let reco = null;
    let ruleApplies = false;

    try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        const jsonText = jsonMatch ? jsonMatch[0] : content;
        const parsed = JSON.parse(jsonText);

        reco = parsed.recommendation;
        ruleApplies = parsed.rule_applies === true;

        if (!ruleApplies && (reco === "B" || reco === "C" || reco === "D")) reco = "A";

        if (!reco || !["A", "B", "C", "D", "Z"].includes(reco)) {
            reco = extractRecommendation(parsed.justification || "") || "A";
            if (!ruleApplies && (reco === "B" || reco === "C" || reco === "D")) reco = "A";
        }
    } catch (e) {
        reco = extractRecommendation(content) || "A";
        if (!ruleApplies && (reco === "B" || reco === "C" || reco === "D")) reco = "A";
    }
    return reco;
}

const tests = [
    { name: "Valid Rule B", json: '{"rule_applies": true, "recommendation": "B", "justification": "blabla"}', expected: "B" },
    { name: "Valid Rule C", json: '{"rule_applies": true, "recommendation": "C", "justification": "blabla"}', expected: "C" },
    { name: "Valid Rule D", json: '{"rule_applies": true, "recommendation": "D", "justification": "blabla"}', expected: "D" },
    { name: "Invalid Rule B (hallucinated)", json: '{"rule_applies": false, "recommendation": "B", "justification": "blabla"}', expected: "A" },
    { name: "Invalid Rule D (hallucinated)", json: '{"rule_applies": false, "recommendation": "D", "justification": "blabla"}', expected: "A" },
    { name: "Valid Rule A", json: '{"rule_applies": true, "recommendation": "A", "justification": "blabla"}', expected: "A" },
    { name: "Valid Extraction D", json: '{"rule_applies": true, "recommendation": "INVALID", "justification": "Je choisis D."}', expected: "D" },
    { name: "Invalid Extraction D", json: '{"rule_applies": false, "recommendation": "INVALID", "justification": "Je choisis D."}', expected: "A" }
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
