import { defaultData } from "../seed";
import type { AppState } from "../types";
import { cloneAppState, createStateRepository, migrateAppState, type ProjectRepository } from "./repository";

const LEGACY_STORAGE_KEY = "implementation_pm:data:v2";

type StateResponse = {
  ok?: boolean;
  state?: Partial<AppState> | null;
  error?: string;
  path?: string;
};

async function requestState(): Promise<StateResponse> {
  const response = await fetch("/api/state", {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`SQLite backend unavailable: ${response.status}`);
  const data = (await response.json()) as StateResponse;
  if (data.ok === false) throw new Error(data.error || "SQLite backend state read failed.");
  return data;
}

async function persistState(state: AppState) {
  const response = await fetch("/api/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  });
  if (!response.ok) throw new Error(`SQLite backend save failed: ${response.status}`);
  const data = (await response.json()) as StateResponse;
  if (data.ok === false) throw new Error(data.error || "SQLite backend save failed.");
}

function loadLegacyLocalStorageState() {
  try {
    const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? migrateAppState(JSON.parse(raw) as Partial<AppState>) : null;
  } catch {
    return null;
  }
}

function clearLegacyLocalStorageState() {
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // SQLite already saved successfully; localStorage cleanup is best effort.
  }
}

export async function createHttpRepository(): Promise<ProjectRepository> {
  const initial = await requestState();
  let initialState: AppState | null = initial.state ? migrateAppState(initial.state) : null;

  if (!initialState) {
    const legacyState = loadLegacyLocalStorageState();
    initialState = legacyState || cloneAppState(defaultData);
    await persistState(initialState);
    if (legacyState) clearLegacyLocalStorageState();
  }

  return createStateRepository("SQLite local DB", {
    async load(): Promise<AppState> {
      if (initialState) {
        const state = initialState;
        initialState = null;
        return state;
      }

      const data = await requestState();
      if (data.state) return migrateAppState(data.state);

      const fresh = cloneAppState(defaultData);
      await persistState(fresh);
      return fresh;
    },
    async save(state: AppState): Promise<void> {
      await persistState(state);
    },
  });
}
