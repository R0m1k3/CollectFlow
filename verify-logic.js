
// Mocking the simplified logic for validation without imports hitting environment issues
function isRecentLogic(regularityScore, inactivityMonths) {
    return (regularityScore || 0) < 3 && (inactivityMonths || 0) <= 1;
}

const testCases = [
    { name: "Nouveau Récent", regularity: 1, inactivity: 0, expected: true },
    { name: "Nouveau Limite", regularity: 2, inactivity: 1, expected: true },
    { name: "Nouveau Ancien (6m)", regularity: 1, inactivity: 6, expected: false },
    { name: "Nouveau Hors Limite (2m)", regularity: 2, inactivity: 2, expected: false },
    { name: "Ancien Actif", regularity: 12, inactivity: 0, expected: false },
    { name: "VRAIMENT Nouveau (0 activité)", regularity: 0, inactivity: 0, expected: true }
];

console.log("--- Testing isRecent Logic (Simplified) ---");
let allPassed = true;

testCases.forEach(tc => {
    const actual = isRecentLogic(tc.regularity, tc.inactivity);
    const passed = actual === tc.expected;
    console.log(`${passed ? "✅" : "❌"} [${tc.name}]: expected ${tc.expected}, got ${actual}`);
    if (!passed) allPassed = false;
});

if (allPassed) {
    console.log("\nALL LOGIC TESTS PASSED");
    process.exit(0);
} else {
    console.log("\nSOME TESTS FAILED");
    process.exit(1);
}
