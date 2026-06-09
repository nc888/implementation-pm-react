import type { AppState, PageKey, Project } from "../../types";
import { AiConfigSidebarBlock, aiConfigSection } from "./AiConfigNavigation";
import { AiGenerationSidebarBlock, aiGenerationSection } from "./AiGenerationNavigation";
import { ProjectSwitchSidebarBlock, projectSwitchSection } from "./ProjectSwitchNavigation";
import { WorkspaceSidebarBlock, projectWorkspaceSection } from "./ProjectWorkspaceNavigation";
import type { PrimarySection } from "./types";

export const primarySections: PrimarySection[] = [
  projectWorkspaceSection,
  projectSwitchSection,
  aiGenerationSection,
];

export function getPrimarySection(page: PageKey) {
  if (page === "assistant" || page === "settings" || aiConfigSection.pages.some(([itemPage]) => itemPage === page)) return aiConfigSection;
  return primarySections.find((section) => section.pages.some(([itemPage]) => itemPage === page)) ?? projectWorkspaceSection;
}

export function LevelTwoNavigation({
  section,
  state,
  project,
  currentPage,
  onPage,
  onProject,
}: {
  section: PrimarySection;
  state: AppState;
  project: Project;
  currentPage: PageKey;
  onPage: (page: PageKey) => void;
  onProject: (projectId: string) => void;
}) {
  if (section.key === "workspace") {
    return <WorkspaceSidebarBlock currentPage={currentPage} onPage={onPage} />;
  }

  if (section.key === "projectExecution") {
    return <ProjectSwitchSidebarBlock state={state} project={project} currentPage={currentPage} onPage={onPage} onProject={onProject} />;
  }

  if (section.key === "aiGeneration") {
    return <AiGenerationSidebarBlock currentPage={currentPage} onPage={onPage} />;
  }

  return <AiConfigSidebarBlock currentPage={currentPage} onPage={onPage} />;
}

export type { PrimarySection };
