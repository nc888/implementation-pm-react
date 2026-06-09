import { isTauri } from "@tauri-apps/api/core";
import type { ProjectRepository } from "./repository";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function createRepository(): Promise<ProjectRepository> {
  if (isTauri()) {
    try {
      const { createSqliteRepository } = await import("./sqliteRepository");
      return await createSqliteRepository();
    } catch (error) {
      throw new Error(`Tauri SQLite storage is unavailable: ${errorMessage(error)}`);
    }
  }

  try {
    const { createHttpRepository } = await import("./httpRepository");
    return await createHttpRepository();
  } catch (error) {
    throw new Error(`Local SQLite backend is unavailable. Start the app with npm run dev on port 5174. ${errorMessage(error)}`);
  }
}
