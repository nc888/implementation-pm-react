import type { AppState, Project } from "../types";

export function isArchivedProject(project?: Pick<Project, "status"> | null) {
  return project?.status === "archived";
}

export function isActiveProject(project?: Pick<Project, "status"> | null) {
  return !isArchivedProject(project);
}

export function activeProjects(state: Pick<AppState, "projects">) {
  return state.projects.filter(isActiveProject);
}

export function archivedProjects(state: Pick<AppState, "projects">) {
  return state.projects.filter(isArchivedProject);
}

export function activeProjectIds(state: Pick<AppState, "projects">) {
  return new Set(activeProjects(state).map((project) => project.id));
}

export function fallbackProjectIdAfterArchive(state: Pick<AppState, "projects">, archivedProjectId: string) {
  return activeProjects(state).find((project) => project.id !== archivedProjectId)?.id || state.projects.find((project) => project.id !== archivedProjectId)?.id || "";
}
