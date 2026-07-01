import type {
  AiMessage,
  AiScore,
  AppState,
  Deliverable,
  DeliveryWorkflow,
  Project,
  ProjectMetrics,
  ProjectStageConfig,
  RiskIssue,
  ScopeItem,
  Task,
  WeeklyReport,
  WeeklyReportPreference,
} from "../types";
import { createProjectStageConfig, projectMilestonesForState, stageDefinitionsForProject } from "./contextBuilder";
import { migrateAppState } from "./repository";

type ImportableProjectRecord =
  | Task
  | ScopeItem
  | Deliverable
  | RiskIssue
  | WeeklyReport
  | WeeklyReportPreference
  | ProjectStageConfig
  | DeliveryWorkflow
  | AiScore
  | AiMessage;

type ImportSource = {
  projects: Project[];
  tasks: Task[];
  scopeItems: ScopeItem[];
  deliverables: Deliverable[];
  risksIssues: RiskIssue[];
  weeklyReports: WeeklyReport[];
  weeklyReportPreferences: WeeklyReportPreference[];
  projectStageConfigs: ProjectStageConfig[];
  deliveryWorkflows: DeliveryWorkflow[];
  aiScores: AiScore[];
  aiMessages: AiMessage[];
};

export type ProjectBackupScope = "all" | "project";

export type ProjectImportResult = {
  state: AppState;
  projectCount: number;
  taskCount: number;
  scopeItemCount: number;
  deliverableCount: number;
  riskIssueCount: number;
  weeklyReportCount: number;
  workflowCount: number;
  projectNames: string[];
};

export type ProjectImportPreview = {
  schemaVersion: string;
  exportScope: string;
  exportedAt: string;
  projectCount: number;
  taskCount: number;
  scopeItemCount: number;
  deliverableCount: number;
  riskIssueCount: number;
  weeklyReportCount: number;
  workflowCount: number;
  aiMessageCount: number;
  projectNames: string[];
  plannedProjectNames: string[];
  duplicateNames: Array<{ sourceName: string; importName: string }>;
  warnings: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isPresent = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;

function buildProjectStageConfigBackup(state: AppState, project: Project): ProjectStageConfig {
  const existing = state.projectStageConfigs.find((config) => config.projectId === project.id);
  const milestones = projectMilestonesForState(state, project.id);
  return existing
    ? {
        ...existing,
        milestones,
      }
    : createProjectStageConfig(project.id, stageDefinitionsForProject(state, project.id), new Date().toISOString(), milestones);
}

export function buildSingleProjectBackup(state: AppState, projectId: string) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error("未找到要导出的项目。");
  return {
    schemaVersion: state.schemaVersion,
    exportScope: "project" as const,
    exportedAt: new Date().toISOString(),
    ui: {
      ...state.ui,
      currentProjectId: project.id,
      currentPage: "overview",
      search: "",
    },
    taskStages: state.taskStages,
    projects: [project],
    tasks: state.tasks.filter((item) => item.projectId === project.id),
    scopeItems: state.scopeItems.filter((item) => item.projectId === project.id),
    deliverables: state.deliverables.filter((item) => item.projectId === project.id),
    risksIssues: state.risksIssues.filter((item) => item.projectId === project.id),
    weeklyReports: state.weeklyReports.filter((item) => item.projectId === project.id),
    weeklyReportPreferences: state.weeklyReportPreferences.filter((item) => item.projectId === project.id),
    projectStageConfigs: [buildProjectStageConfigBackup(state, project)],
    deliveryWorkflows: state.deliveryWorkflows.filter((item) => item.projectId === project.id),
    aiScores: state.aiScores.filter((item) => item.projectId === project.id),
    aiMessages: state.aiMessages.filter((item) => item.scope === "project" && item.projectId === project.id),
  };
}

export function exportSingleProjectBackupJson(state: AppState, projectId: string) {
  return JSON.stringify(buildSingleProjectBackup(state, projectId), null, 2);
}

function projectIdsFrom(projects: unknown) {
  return new Set(
    asArray<Project>(projects)
      .filter((project) => isRecord(project) && isString(project.id))
      .map((project) => project.id),
  );
}

function filterProjectRecords<T extends ImportableProjectRecord>(
  sourceIds: Set<string>,
  rawItems: unknown,
  migratedItems: T[],
  projectIdOf: (item: T) => string | undefined = (item) => item.projectId,
) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return [];
  return migratedItems.filter((item) => {
    const projectId = projectIdOf(item);
    return Boolean(projectId && sourceIds.has(projectId));
  });
}

function buildImportSource(payload: unknown): ImportSource {
  if (!isRecord(payload)) {
    throw new Error("导入文件必须是项目备份 JSON 对象。");
  }

  const partialState = Array.isArray(payload.projects)
    ? payload
    : isRecord(payload.project)
      ? {
          schemaVersion: payload.schemaVersion,
          ui: payload.ui,
          projects: [payload.project],
          tasks: payload.tasks,
          scopeItems: payload.scopeItems,
          deliverables: payload.deliverables,
          risksIssues: payload.risksIssues,
          weeklyReports: payload.weeklyReports,
          weeklyReportPreferences: payload.weeklyReportPreferences,
          projectStageConfigs: payload.projectStageConfigs,
          deliveryWorkflows: payload.deliveryWorkflows,
          aiScores: payload.aiScores,
          aiMessages: payload.aiMessages,
        }
      : null;

  if (!partialState) {
    throw new Error("未找到 projects 数组或 project 对象，无法识别项目备份。");
  }

  const sourceProjectIds = projectIdsFrom(partialState.projects);
  if (!sourceProjectIds.size) {
    throw new Error("备份文件中没有可导入的项目。");
  }

  const migrated = migrateAppState(partialState as Partial<AppState>);
  const projects = migrated.projects.filter((project) => sourceProjectIds.has(project.id));
  if (!projects.length) {
    throw new Error("备份文件中的项目数据无法迁移到当前版本。");
  }

  return {
    projects,
    tasks: filterProjectRecords(sourceProjectIds, partialState.tasks, migrated.tasks),
    scopeItems: filterProjectRecords(sourceProjectIds, partialState.scopeItems, migrated.scopeItems),
    deliverables: filterProjectRecords(sourceProjectIds, partialState.deliverables, migrated.deliverables),
    risksIssues: filterProjectRecords(sourceProjectIds, partialState.risksIssues, migrated.risksIssues),
    weeklyReports: filterProjectRecords(sourceProjectIds, partialState.weeklyReports, migrated.weeklyReports),
    weeklyReportPreferences: filterProjectRecords(sourceProjectIds, partialState.weeklyReportPreferences, migrated.weeklyReportPreferences),
    projectStageConfigs: migrated.projectStageConfigs.filter((config) => sourceProjectIds.has(config.projectId)),
    deliveryWorkflows: filterProjectRecords(sourceProjectIds, partialState.deliveryWorkflows, migrated.deliveryWorkflows),
    aiScores: filterProjectRecords(sourceProjectIds, partialState.aiScores, migrated.aiScores),
    aiMessages: filterProjectRecords(sourceProjectIds, partialState.aiMessages, migrated.aiMessages, (message) => message.projectId),
  };
}

export function normalizeProjectNameForUniqueness(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function projectNameExists(projects: Pick<Project, "id" | "name">[], name: string, exceptProjectId = "") {
  const normalized = normalizeProjectNameForUniqueness(name);
  return Boolean(normalized && projects.some((project) => project.id !== exceptProjectId && normalizeProjectNameForUniqueness(project.name) === normalized));
}

export function nextProjectName(baseName: string, existingNames: Set<string>, suffix = "导入") {
  const normalizedBaseName = normalizeProjectNameForUniqueness(baseName) || "project";
  if (!existingNames.has(normalizedBaseName)) return baseName.trim() || "未命名项目";
  let index = 1;
  const displayBaseName = baseName.trim() || "未命名项目";
  let candidate = `${displayBaseName} (${suffix})`;
  while (existingNames.has(normalizeProjectNameForUniqueness(candidate))) {
    index += 1;
    candidate = `${displayBaseName} (${suffix} ${index})`;
  }
  return candidate;
}

export function previewProjectsFromBackup(current: AppState, payload: unknown): ProjectImportPreview {
  const source = buildImportSource(payload);
  const payloadRecord = isRecord(payload) ? payload : {};
  const existingProjectNames = new Set(current.projects.map((project) => normalizeProjectNameForUniqueness(project.name)));
  const duplicateNames: ProjectImportPreview["duplicateNames"] = [];
  const plannedProjectNames = source.projects.map((project) => {
    const importName = nextProjectName(project.name, existingProjectNames);
    existingProjectNames.add(normalizeProjectNameForUniqueness(importName));
    if (importName !== project.name) duplicateNames.push({ sourceName: project.name, importName });
    return importName;
  });
  const warnings = [
    "Import creates copied projects with new IDs. Existing projects are not overwritten.",
    source.tasks.length ? "" : "No tasks were found in this JSON.",
    source.deliverables.length ? "" : "No deliverables were found in this JSON.",
    source.risksIssues.length ? "" : "No risks or issues were found in this JSON.",
    duplicateNames.length ? "Duplicate project names will be renamed during import." : "",
    source.deliveryWorkflows.length || source.aiMessages.length ? "AI draft/history records are included; the AI generation center entry is currently hidden." : "",
  ].filter(isString);

  return {
    schemaVersion: String(payloadRecord.schemaVersion ?? "unknown"),
    exportScope: String(payloadRecord.exportScope ?? (source.projects.length === 1 ? "project" : "all")),
    exportedAt: String(payloadRecord.exportedAt ?? ""),
    projectCount: source.projects.length,
    taskCount: source.tasks.length,
    scopeItemCount: source.scopeItems.length,
    deliverableCount: source.deliverables.length,
    riskIssueCount: source.risksIssues.length,
    weeklyReportCount: source.weeklyReports.length,
    workflowCount: source.deliveryWorkflows.length,
    aiMessageCount: source.aiMessages.length,
    projectNames: source.projects.map((project) => project.name),
    plannedProjectNames,
    duplicateNames,
    warnings,
  };
}

function zeroMetrics(): ProjectMetrics & { totalTasks: number; pendingDeliverables: number } {
  return {
    done: 0,
    blocked: 0,
    customer: 0,
    open: 0,
    openHighRisks: 0,
    issues: 0,
    pendingDeliverables: 0,
    overdue: 0,
    completionRate: 0,
    estimatedPersonDays: 0,
    actualPersonDays: 0,
    personDayUsageRate: 0,
    implementationEstimatedPersonDays: 0,
    implementationActualPersonDays: 0,
    implementationPersonDayUsageRate: 0,
    developmentEstimatedPersonDays: 0,
    developmentActualPersonDays: 0,
    developmentPersonDayUsageRate: 0,
    totalTasks: 0,
  };
}

function snapshotProject(project: Project) {
  return {
    id: project.id,
    name: project.name,
    client: project.client,
    phase: project.phase,
    health: project.health,
    progress: project.progress,
    nextMilestone: project.nextMilestone,
  };
}

function remapWeeklySnapshot(report: WeeklyReport, project: Project): WeeklyReport["snapshot"] {
  const snapshot = report.snapshot;
  if (!snapshot) {
    return {
      schemaVersion: "1.0",
      projectId: project.id,
      generatedAt: report.createdAt || new Date().toISOString(),
      purpose: "weekly-report",
      project: snapshotProject(project),
      metrics: zeroMetrics(),
      tasks: [],
      risks: [],
      deliverables: [],
    };
  }
  return {
    ...snapshot,
    projectId: project.id,
    project: {
      ...snapshot.project,
      ...snapshotProject(project),
    },
  };
}

function mappedIds(ids: string[], idMap: Map<string, string>) {
  return ids.map((id) => idMap.get(id)).filter(isString);
}

export function importProjectsFromBackup(current: AppState, payload: unknown): ProjectImportResult {
  const source = buildImportSource(payload);
  const existingProjectNames = new Set(current.projects.map((project) => normalizeProjectNameForUniqueness(project.name)));
  const projectIdMap = new Map(source.projects.map((project) => [project.id, crypto.randomUUID()]));
  const taskIdMap = new Map(source.tasks.map((task) => [task.id, crypto.randomUUID()]));
  const deliverableIdMap = new Map(source.deliverables.map((deliverable) => [deliverable.id, crypto.randomUUID()]));
  const newProjectsByOldId = new Map<string, Project>();

  const importedProjects = source.projects.map((project) => {
    const id = projectIdMap.get(project.id) || crypto.randomUUID();
    const name = nextProjectName(project.name, existingProjectNames);
    existingProjectNames.add(normalizeProjectNameForUniqueness(name));
    const importedProject = { ...project, id, name };
    newProjectsByOldId.set(project.id, importedProject);
    return importedProject;
  });

  const importedTasks = source.tasks
    .map((task): Task | null => {
      const projectId = projectIdMap.get(task.projectId);
      const id = taskIdMap.get(task.id);
      if (!projectId || !id) return null;
      return {
        ...task,
        id,
        projectId,
        parentId: task.parentId ? taskIdMap.get(task.parentId) || "" : "",
        updatedAt: task.updatedAt || new Date().toISOString(),
      };
    })
    .filter(isPresent);

  const importedScopeItems = source.scopeItems
    .map((scopeItem): ScopeItem | null => {
      const projectId = projectIdMap.get(scopeItem.projectId);
      if (!projectId) return null;
      return { ...scopeItem, id: crypto.randomUUID(), projectId };
    })
    .filter(isPresent);

  const sourceTaskIdByProjectAndCode = new Map(source.tasks.map((task) => [`${task.projectId}:${task.code}`, task.id]));
  const importedDeliverables = source.deliverables
    .map((deliverable): Deliverable | null => {
      const projectId = projectIdMap.get(deliverable.projectId);
      const id = deliverableIdMap.get(deliverable.id);
      if (!projectId || !id) return null;
      const linkedTaskId = deliverable.linkedTaskId
        ? taskIdMap.get(deliverable.linkedTaskId) || ""
        : taskIdMap.get(sourceTaskIdByProjectAndCode.get(`${deliverable.projectId}:${deliverable.code}`) || "") || "";
      return { ...deliverable, id, projectId, linkedTaskId };
    })
    .filter(isPresent);

  const importedRiskIssues = source.risksIssues
    .map((item): RiskIssue | null => {
      const projectId = projectIdMap.get(item.projectId);
      if (!projectId) return null;
      return {
        ...item,
        id: crypto.randomUUID(),
        projectId,
        riskVisibility: item.riskVisibility === "external" ? "external" : "internal",
        internalHandling: item.internalHandling || item.responsePlan || "",
        customerAssistance: item.customerAssistance || "",
        linkedTaskId: item.linkedTaskId ? taskIdMap.get(item.linkedTaskId) || "" : "",
      };
    })
    .filter(isPresent);

  const importedWeeklyReports = source.weeklyReports
    .map((report): WeeklyReport | null => {
      const projectId = projectIdMap.get(report.projectId);
      const project = newProjectsByOldId.get(report.projectId);
      if (!projectId || !project) return null;
      return {
        ...report,
        id: crypto.randomUUID(),
        projectId,
        thisWeekTaskIds: mappedIds(report.thisWeekTaskIds || [], taskIdMap),
        nextWeekTaskIds: mappedIds(report.nextWeekTaskIds || [], taskIdMap),
        snapshot: remapWeeklySnapshot(report, project),
      };
    })
    .filter(isPresent);

  const importedWeeklyReportPreferences = source.weeklyReportPreferences
    .map((preference): WeeklyReportPreference | null => {
      const projectId = projectIdMap.get(preference.projectId);
      if (!projectId) return null;
      return {
        ...preference,
        projectId,
        updatedAt: new Date().toISOString(),
      };
    })
    .filter(isPresent);

  const importedProjectStageConfigs = source.projectStageConfigs
    .map((config): ProjectStageConfig | null => {
      const projectId = projectIdMap.get(config.projectId);
      if (!projectId) return null;
      return {
        ...config,
        projectId,
        updatedAt: new Date().toISOString(),
      };
    })
    .filter(isPresent);

  const importedWorkflows = source.deliveryWorkflows
    .map((workflow): DeliveryWorkflow | null => {
      const projectId = projectIdMap.get(workflow.projectId);
      if (!projectId) return null;
      return {
        ...workflow,
        projectId,
        sow: {
          ...workflow.sow,
          projectId,
        },
        projectFlow: {
          ...workflow.projectFlow,
          generatedTaskIds: mappedIds(workflow.projectFlow.generatedTaskIds, taskIdMap),
          generatedDeliverableIds: mappedIds(workflow.projectFlow.generatedDeliverableIds, deliverableIdMap),
        },
      };
    })
    .filter(isPresent);

  const importedAiScores = source.aiScores
    .map((score): AiScore | null => {
      const projectId = projectIdMap.get(score.projectId);
      if (!projectId) return null;
      return { ...score, id: crypto.randomUUID(), projectId };
    })
    .filter(isPresent);

  const importedAiMessages = source.aiMessages
    .map((message): AiMessage | null => {
      const projectId = message.projectId ? projectIdMap.get(message.projectId) : "";
      if (!projectId) return null;
      return { ...message, id: crypto.randomUUID(), projectId };
    })
    .filter(isPresent);

  return {
    state: {
      ...current,
      projects: [...current.projects, ...importedProjects],
      tasks: [...current.tasks, ...importedTasks],
      scopeItems: [...current.scopeItems, ...importedScopeItems],
      deliverables: [...current.deliverables, ...importedDeliverables],
      risksIssues: [...current.risksIssues, ...importedRiskIssues],
      weeklyReports: [...current.weeklyReports, ...importedWeeklyReports],
      weeklyReportPreferences: [...current.weeklyReportPreferences, ...importedWeeklyReportPreferences],
      projectStageConfigs: [...current.projectStageConfigs, ...importedProjectStageConfigs],
      deliveryWorkflows: [...current.deliveryWorkflows, ...importedWorkflows],
      aiScores: [...current.aiScores, ...importedAiScores],
      aiMessages: [...current.aiMessages, ...importedAiMessages],
      ui: {
        ...current.ui,
        currentProjectId: importedProjects[0].id,
        currentPage: "overview",
        search: "",
      },
    },
    projectCount: importedProjects.length,
    taskCount: importedTasks.length,
    scopeItemCount: importedScopeItems.length,
    deliverableCount: importedDeliverables.length,
    riskIssueCount: importedRiskIssues.length,
    weeklyReportCount: importedWeeklyReports.length,
    workflowCount: importedWorkflows.length,
    projectNames: importedProjects.map((project) => project.name),
  };
}
