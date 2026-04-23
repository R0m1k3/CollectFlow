const fs = require('fs');
async function test() {
    const res = await fetch("https://api.ffnancy.fr/api/performance/dashboard?date=2024-04-20");
    const data = await res.json();
    console.log(JSON.stringify(data.top10_ca?.[0] || {}, null, 2));
}
test();
