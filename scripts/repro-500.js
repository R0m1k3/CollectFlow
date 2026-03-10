const { computeProductScores } = require('./src/lib/score-engine');

// Simulate 50,000 rows
const largeDataset = Array.from({ length: 50000 }, (_, i) => ({
    codein: `item-${i}`,
    codeFournisseur: 'A032',
    nomFournisseur: 'ACCESS DECO',
    libelle1: `Product ${i}`,
    gtin: '123456789',
    reference: 'REF',
    code1: '20',
    libelleNiveau1: 'LIQUIDES',
    code2: '2001',
    libelleNiveau2: 'EAUX',
    code3: '200101',
    libelle3: 'EAU SOURCE',
    codeGamme: 'A',
    codeGammeInit: 'A',
    codeGammeDraft: null,
    sales12m: {},
    totalQuantite: Math.random() * 1000,
    totalCa: Math.random() * 5000,
    totalMarge: Math.random() * 1000,
    tauxMarge: 20,
    score: 0,
    workingStores: ['MAG1', 'MAG2']
}));

console.log(`Starting test with ${largeDataset.length} rows...`);

try {
    const start = Date.now();
    const result = computeProductScores(largeDataset);
    const end = Date.now();
    console.log(`Success! Processed ${result.length} rows in ${end - start}ms.`);
} catch (error) {
    console.error('Failed!', error);
    process.exit(1);
}
