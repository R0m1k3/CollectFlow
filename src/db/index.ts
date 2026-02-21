import { drizzle } from "drizzle-orm/pg-proxy"; // Or node-postgres if using directly
import { drizzle as nodeDrizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

export const db = nodeDrizzle(pool, { schema });
