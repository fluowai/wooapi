import { Pool } from "pg";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL || "";
const SQLITE_FILENAME = process.env.SQLITE_FILENAME || "database.db";
const DATA_DIR = process.env.DATA_DIR || ".";

let pgPool: Pool | null = null;
let sqliteDb: Database.Database | null = null;

if (DATABASE_URL) {
  // Inicializar PostgreSQL / Supabase
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    max: 20, // max connections
  });
  pgPool.on("error", (error) => {
    console.error("[DB_POOL_ERROR]", error?.message || error);
  });
  console.log("🔥 Banco de Dados configurado para PostgreSQL/Supabase");
} else {
  // Inicializar SQLite local
  const dbPath = path.join(path.resolve(DATA_DIR), SQLITE_FILENAME);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  sqliteDb = new Database(dbPath);
  sqliteDb.pragma("journal_mode = WAL");
  sqliteDb.pragma("busy_timeout = 5000");
  console.log("📦 Banco de Dados configurado para SQLite Local");
}

/**
 * Converte query com "?" do SQLite para "$1, $2" do Postgres.
 */
function toPgQuery(sql: string): string {
  let i = 1;
  return sql
    .replace(/datetime\('now'\)/gi, "current_timestamp")
    .replace(/datetime\('now','-(\d+)\s+(hour|hours|day|days)'\)/gi, (_match, amount, unit) => {
      return `(current_timestamp - interval '${amount} ${unit}')`;
    })
    .replace(/date\('now','start of month'\)/gi, "date_trunc('month', current_timestamp)")
    .replace(/\?/g, () => `$${i++}`);
}

/**
 * Executa uma query que retorna múltiplos resultados.
 */
export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  if (pgPool) {
    const res = await pgPool.query(toPgQuery(sql), params);
    return res.rows as T[];
  }
  if (sqliteDb) {
    return sqliteDb.prepare(sql).all(...params) as T[];
  }
  return [];
}

/**
 * Executa uma query que retorna um único resultado (linha).
 */
export async function get<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
  if (pgPool) {
    const res = await pgPool.query(toPgQuery(sql), params);
    return res.rows[0] as T | undefined;
  }
  if (sqliteDb) {
    return sqliteDb.prepare(sql).get(...params) as T;
  }
  return undefined;
}

/**
 * Executa um comando (INSERT, UPDATE, DELETE).
 * No Postgres, precisamos alterar queries INSERT para incluir RETURNING id
 * para emularmos a propriedade lastInsertRowid do SQLite.
 */
export async function run(sql: string, params: any[] = []): Promise<{ lastInsertRowid?: number | string; changes?: number }> {
  if (pgPool) {
    let pgSql = toPgQuery(sql);

    // Se for um insert sem RETURNING, adicionamos para pegar o ID inserido
    if (pgSql.trim().toUpperCase().startsWith("INSERT") && !pgSql.toUpperCase().includes("RETURNING")) {
      pgSql += " RETURNING id";
    }

    const res = await pgPool.query(pgSql, params);

    return {
      lastInsertRowid: res.rows[0]?.id,
      changes: res.rowCount ?? 0,
    };
  }

  if (sqliteDb) {
    const info = sqliteDb.prepare(sql).run(...params);
    return {
      lastInsertRowid: info.lastInsertRowid,
      changes: info.changes,
    };
  }

  return {};
}

export function isPostgres(): boolean {
  return !!pgPool;
}

export function isSqlite(): boolean {
  return !!sqliteDb;
}

export async function exec(sql: string): Promise<void> {
  if (pgPool) {
    await pgPool.query(sql);
    return;
  }
  if (sqliteDb) {
    sqliteDb.exec(sql);
    return;
  }
}

export async function runMigrations(): Promise<void> {
  if (!pgPool) return;
  const migrationPath = path.resolve(process.cwd(), "migrations", "supabase_wooapi_production.sql");
  if (!fs.existsSync(migrationPath)) {
    console.warn("⚠ Migration file not found at", migrationPath);
    return;
  }
  const sql = fs.readFileSync(migrationPath, "utf-8");
  try {
    await pgPool.query(sql);
    console.log("✅ PostgreSQL migrations applied successfully");
  } catch (err) {
    console.error("❌ PostgreSQL migration failed:", err);
    throw err;
  }
}

export default { query, get, run };
