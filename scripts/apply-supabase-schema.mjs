import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl || databaseUrl.includes("user:password@host")) {
  console.error("DATABASE_URL ausente ou placeholder. Configure a connection string do Supabase antes de aplicar.");
  process.exit(1);
}

const migrationPath = path.resolve(
  process.cwd(),
  process.env.MIGRATION_FILE || "migrations/supabase_wooapi_production.sql"
);

if (!fs.existsSync(migrationPath)) {
  console.error(`Migration nao encontrada: ${migrationPath}`);
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: /sslmode=require|supabase\.com/i.test(databaseUrl)
    ? { rejectUnauthorized: false }
    : undefined
});

const requiredTables = [
  "plans",
  "accounts",
  "users",
  "instances",
  "conversations",
  "messages",
  "webhook_events",
  "instance_webhooks",
  "webhook_delivery_logs",
  "api_request_logs",
  "connection_logs",
  "audit_logs",
  "integration_settings",
  "usage_events"
];

try {
  console.log("Conectando ao Supabase/PostgreSQL...");
  const connection = await pool.query("select current_database() as database, current_user as user");
  console.log(`Conectado em database=${connection.rows[0].database}, user=${connection.rows[0].user}`);

  console.log(`Aplicando ${path.relative(process.cwd(), migrationPath)}...`);
  const sql = fs.readFileSync(migrationPath, "utf8");
  await pool.query(sql);

  const validation = await pool.query(
    `
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name = any($1::text[])
      order by table_name
    `,
    [requiredTables]
  );

  const found = new Set(validation.rows.map((row) => row.table_name));
  const missing = requiredTables.filter((table) => !found.has(table));

  if (missing.length) {
    console.error(`Schema aplicado parcialmente. Tabelas ausentes: ${missing.join(", ")}`);
    process.exit(1);
  }

  const planCount = await pool.query("select count(*)::int as count from plans");
  console.log(`Schema WooAPI pronto. Tabelas validadas: ${requiredTables.length}. Planos cadastrados: ${planCount.rows[0].count}.`);
} catch (error) {
  console.error("Falha ao aplicar schema no Supabase:", {
    code: error.code,
    message: error.message
  });
  process.exit(1);
} finally {
  await pool.end().catch(() => undefined);
}
