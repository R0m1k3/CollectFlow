require('dotenv').config({ path: 'c:/GIT/CollectFlow/.env.local' });
const { Pool } = require('pg');

async function test() {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL
    });

    try {
        const res = await pool.query("SELECT * FROM cube_stock WHERE cs.site = '292' LIMIT 5");
        console.log("CUBE_STOCK:", res.rows);
    } catch(e) {
        console.log("ERROR cube_stock:", e.message);
    }

    try {
        const res2 = await pool.query("SELECT a.codein, a.no_id FROM articles a LIMIT 5");
        console.log("ARTICLES:", res2.rows);
    } catch(e) {
        console.log("ERROR articles:", e.message);
    }

    pool.end();
}
test();
