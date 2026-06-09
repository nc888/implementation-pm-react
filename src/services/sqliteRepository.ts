import { defaultData } from "../seed";
import type { AppState } from "../types";
import { cloneAppState, createStateRepository, migrateAppState, type ProjectRepository } from "./repository";

const DB_PATH = "sqlite:implementation-pm.db";
const STATE_KEY = "app-state";

type SqlDatabase = {
  execute(query: string, bindValues?: unknown[]): Promise<unknown>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
};

type AppStateRow = {
  value: string;
};

async function connect() {
  const Database = (await import("@tauri-apps/plugin-sql")).default;
  return Database.load(DB_PATH) as Promise<SqlDatabase>;
}

async function ensureSchema(db: SqlDatabase) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

async function saveState(db: SqlDatabase, state: AppState): Promise<void> {
  await db.execute(
    `
      INSERT INTO app_state (key, value, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `,
    [STATE_KEY, JSON.stringify(state), new Date().toISOString()],
  );
}

export async function createSqliteRepository(): Promise<ProjectRepository> {
  const db = await connect();
  await ensureSchema(db);

  return createStateRepository("Tauri SQLite", {
    async load(): Promise<AppState> {
      const rows = await db.select<AppStateRow[]>("SELECT value FROM app_state WHERE key = $1 LIMIT 1", [STATE_KEY]);
      if (!rows.length) {
        const fresh = cloneAppState(defaultData);
        await saveState(db, fresh);
        return fresh;
      }

      try {
        return migrateAppState(JSON.parse(rows[0].value) as Partial<AppState>);
      } catch {
        await db.execute("UPDATE app_state SET key = $1 WHERE key = $2", [`${STATE_KEY}:corrupt:${Date.now()}`, STATE_KEY]);
        const fresh = cloneAppState(defaultData);
        await saveState(db, fresh);
        return fresh;
      }
    },
    async save(state: AppState): Promise<void> {
      await saveState(db, state);
    },
  });
}
