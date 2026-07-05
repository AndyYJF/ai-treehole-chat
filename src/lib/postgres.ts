import { Pool } from "pg";

let pool: Pool | null = null;

export function getPostgresPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;

  pool ??= new Pool({
    connectionString,
    max: 8,
    idleTimeoutMillis: 30_000,
  });

  return pool;
}
