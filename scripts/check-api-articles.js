const fs = require('fs');
async function test() {
    try {
        const res = await fetch("https://api.ffnancy.fr/api/articles?search=334152");
        const data = await res.json();
        console.log("ARTICLES SEARCH:", JSON.stringify(data, null, 2));

        const res2 = await fetch("https://api.ffnancy.fr/api/articles/334152/referentiel");
        const data2 = await res2.json();
        console.log("ARTICLES REFERENTIEL BY CODEIN:", JSON.stringify(data2, null, 2));
    } catch(e) {
        console.log(e.message);
    }
}
test();
