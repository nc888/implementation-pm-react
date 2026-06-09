import { defaultData } from "../seed";
import { buildProjectSnapshot, createProjectStageConfig, normalizeProjectPhase, normalizeStageDefinitions, normalizeTaskStage } from "./contextBuilder";
import { normalizeWeeklyMailSubject, sanitizeWeeklyReportContent } from "./weeklyReportService";
import type {
  AiDraft,
  AiModelConfig,
  AppState,
  DeliveryWorkflow,
  Deliverable,
  EmailConfig,
  Project,
  ProjectStageConfig,
  ResourceAssessmentInputs,
  ScopeItem,
  Task,
  TaskStageDefinition,
  TaskStatus,
  WeeklyMarkdownArchiveStatus,
  WeeklyProjectStatus,
  WeeklyReport,
  WeeklyReportInput,
  WeeklyReportPreference,
  WeeklyReportPreferenceInput,
  WorkflowHandoffContent,
} from "../types";

const AICODEMIRROR_GPT55_URL = "https://api.aicodemirror.com/api/codex/v1/chat/completions";

const clone = <T>(value: T): T => structuredClone(value);
const taskCodeCollator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

function clampProgress(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function migrateAppState(data: Partial<AppState>): AppState {
  const sourceSchemaVersion = Number(data.schemaVersion || 0);
  const deliveryWorkflows = (data.deliveryWorkflows || []).map((workflow) => migrateWorkflow(workflow as DeliveryWorkflow & { resourceAssessment?: AiDraft }));
  const taskStages = normalizeStageDefinitions(sourceSchemaVersion >= 9 ? data.taskStages : undefined);
  const rawProjects = data.projects?.length ? data.projects : defaultData.projects;
  const migratedProjects = rawProjects.map((project) => migrateProject(project as Project, sourceSchemaVersion, taskStages));
  const projectStageConfigs = normalizeProjectStageConfigs(data.projectStageConfigs, migratedProjects, taskStages);
  const projects = migratedProjects.map((project) => ({
    ...project,
    phase: normalizeProjectPhase(project.phase, stagesForProject(projectStageConfigs, taskStages, project.id)),
  }));
  const migratedTasks = (data.tasks?.length ? data.tasks : defaultData.tasks).map((task) =>
    migrateTask(task as Task & { parentId?: string; startDate?: string }, stagesForProject(projectStageConfigs, taskStages, task.projectId), sourceSchemaVersion),
  );
  const tasks = !data.schemaVersion || data.schemaVersion < 4 ? normalizeTaskCodes(migratedTasks) : migratedTasks;
  const scopeItems = (data.scopeItems?.length ? data.scopeItems : defaultData.scopeItems).map((scopeItem) =>
    migrateScopeItem(scopeItem as ScopeItem & { category?: string; personDayType?: string; title?: string; description?: string; content?: string }, sourceSchemaVersion),
  );
  const deliverables = (data.deliverables ?? defaultData.deliverables).map((deliverable) =>
    migrateDeliverable(deliverable as Deliverable & { attachmentRequirement?: string }),
  );
  const aiModelConfigs = normalizeAiModelConfigs(data.aiModelConfigs?.length ? data.aiModelConfigs : clone(defaultData.aiModelConfigs));
  const weeklyReports = (data.weeklyReports || defaultData.weeklyReports).map((report) => migrateWeeklyReport(report as Partial<WeeklyReport>));
  const weeklyReportPreferences =
    sourceSchemaVersion >= 14
      ? normalizeWeeklyReportPreferences(data.weeklyReportPreferences || defaultData.weeklyReportPreferences)
      : deriveWeeklyReportPreferences(weeklyReports);
  const emailConfig = migrateEmailConfig(data.emailConfig);
  const ui = { ...defaultData.ui, ...(data.ui || {}) };
  ui.assistantScope = ui.assistantScope === "all" ? "all" : "project";
  return {
    ...clone(defaultData),
    ...data,
    ui,
    taskStages,
    projectStageConfigs,
    projects,
    tasks,
    scopeItems,
    deliverables,
    aiModelConfigs,
    weeklyReports,
    weeklyReportPreferences,
    emailConfig,
    deliveryWorkflows,
    schemaVersion: 15,
  };
}

function stagesForProject(projectStageConfigs: ProjectStageConfig[], fallbackStages: TaskStageDefinition[], projectId: string) {
  return projectStageConfigs.find((config) => config.projectId === projectId)?.stages || fallbackStages;
}

function normalizeProjectStageConfigs(configs: unknown, projects: Project[], fallbackStages: TaskStageDefinition[]): ProjectStageConfig[] {
  const source = Array.isArray(configs) ? (configs as Array<Partial<ProjectStageConfig>>) : [];
  const sourceByProjectId = new Map(source.filter((config) => config?.projectId).map((config) => [String(config.projectId), config]));
  return projects.map((project) => {
    const existing = sourceByProjectId.get(project.id);
    return createProjectStageConfig(project.id, existing?.stages || fallbackStages, existing?.updatedAt || "");
  });
}

function migrateProject(project: Project, sourceSchemaVersion: number, taskStages: TaskStageDefinition[]): Project {
  const fallback = defaultData.projects.find((item) => item.id === project.id);
  const shouldBackfillPersonDays = sourceSchemaVersion < 6;
  return {
    ...project,
    phase: normalizeProjectPhase(project.phase || fallback?.phase, taskStages),
    estimatedImplementationPersonDays: Number(
      shouldBackfillPersonDays && !project.estimatedImplementationPersonDays
        ? fallback?.estimatedImplementationPersonDays ?? 0
        : project.estimatedImplementationPersonDays ?? fallback?.estimatedImplementationPersonDays ?? 0,
    ),
    estimatedDevelopmentPersonDays: Number(
      shouldBackfillPersonDays && !project.estimatedDevelopmentPersonDays
        ? fallback?.estimatedDevelopmentPersonDays ?? 0
        : project.estimatedDevelopmentPersonDays ?? fallback?.estimatedDevelopmentPersonDays ?? 0,
    ),
    deliverableStoragePath: project.deliverableStoragePath || "",
  };
}

function normalizeScopeCategory(category?: string): ScopeItem["category"] {
  if (category === "变更增加范围" || category === "变更请求") return "变更增加范围";
  if (category === "不在本期范围" || category === "不在范围") return "不在本期范围";
  if (category === "客户责任" || category === "实施责任") return "不在本期范围";
  return "本期SOW范围";
}

function normalizePersonDayType(personDayType?: string): ScopeItem["personDayType"] {
  return personDayType === "开发" ? "开发" : "实施";
}

function migrateScopeItem(scopeItem: ScopeItem & { category?: string; personDayType?: string; title?: string; description?: string; content?: string }, sourceSchemaVersion: number): ScopeItem {
  const fallback = defaultData.scopeItems.find((item) => item.id === scopeItem.id);
  const content = scopeItem.content || scopeItem.title || fallback?.content || fallback?.title || "";
  const shouldBackfillPersonDays = sourceSchemaVersion < 6;
  const category = sourceSchemaVersion < 7 && fallback ? fallback.category : normalizeScopeCategory(scopeItem.category);
  const personDayType = sourceSchemaVersion < 8 && fallback ? fallback.personDayType : normalizePersonDayType(scopeItem.personDayType);
  return {
    ...scopeItem,
    category,
    personDayType,
    title: scopeItem.title || fallback?.title || content,
    description: scopeItem.description || fallback?.description || content,
    estimatedPersonDays: Number(
      shouldBackfillPersonDays && !scopeItem.estimatedPersonDays ? fallback?.estimatedPersonDays ?? 0 : scopeItem.estimatedPersonDays ?? fallback?.estimatedPersonDays ?? 0,
    ),
    actualPersonDays: Number(
      shouldBackfillPersonDays && !scopeItem.actualPersonDays ? fallback?.actualPersonDays ?? 0 : scopeItem.actualPersonDays ?? fallback?.actualPersonDays ?? 0,
    ),
    progress: Number(shouldBackfillPersonDays && !scopeItem.progress ? fallback?.progress ?? 0 : scopeItem.progress ?? fallback?.progress ?? 0),
    content,
  };
}

function migrateTask(task: Task & { parentId?: string; startDate?: string }, taskStages: TaskStageDefinition[], sourceSchemaVersion: number): Task {
  const legacyLaunchText = `${task.title || ""} ${task.type || ""} ${task.dimension || ""}`;
  const stage =
    sourceSchemaVersion < 10 && (task.stage === "launch" || task.stage === "pilot") && /验收|结项/.test(legacyLaunchText)
      ? "acceptance"
      : task.stage;
  return {
    ...task,
    parentId: task.parentId || "",
    startDate: task.startDate || task.dueDate || "",
    stage: normalizeTaskStage(stage, taskStages),
  };
}

function migrateDeliverable(deliverable: Deliverable & { attachmentRequirement?: string }): Deliverable {
  return {
    ...deliverable,
    attachmentRequirement: deliverable.attachmentRequirement === "none" ? "none" : "required",
  };
}

function normalizeWeeklyProjectStatus(value?: string): WeeklyProjectStatus {
  if (value === "延期" || value === "暂停" || value === "需关注" || value === "风险") return value;
  return "健康";
}

function normalizeProjectImplementationMode(value?: string) {
  return value === "出差实施" ? "出差实施" : "本地实施";
}

function normalizeWeeklyMarkdownArchiveStatus(value?: string): WeeklyMarkdownArchiveStatus {
  if (value === "archived" || value === "failed") return value;
  return "not-archived";
}

function migrateWeeklyReport(report: Partial<WeeklyReport>): WeeklyReport {
  const project = defaultData.projects.find((item) => item.id === report.projectId) || defaultData.projects[0];
  const createdAt = report.createdAt || new Date().toISOString();
  const reportDate = report.reportDate || createdAt.slice(0, 10) || localDateKey();
  const subject = normalizeWeeklyMailSubject(project, reportDate, report.mailSubject || report.title);
  const fallbackSnapshot = buildProjectSnapshot(defaultData, project, "weekly-report");
  return {
    id: report.id || crypto.randomUUID(),
    projectId: report.projectId || project.id,
    reportDate,
    title: normalizeWeeklyMailSubject(project, reportDate, report.title || subject),
    content: sanitizeWeeklyReportContent(report.content || ""),
    generatedBy: report.generatedBy === "manual" ? "manual" : "ai",
    projectOwner: report.projectOwner || project.owner || "",
    implementationMode: normalizeProjectImplementationMode(report.implementationMode),
    projectStatus: normalizeWeeklyProjectStatus(report.projectStatus),
    thisWeekTaskIds: Array.isArray(report.thisWeekTaskIds) ? report.thisWeekTaskIds : [],
    nextWeekTaskIds: Array.isArray(report.nextWeekTaskIds) ? report.nextWeekTaskIds : [],
    recipientsTo: report.recipientsTo || "",
    recipientsCc: report.recipientsCc || "",
    mailSubject: subject,
    mailDraftStatus: report.mailDraftStatus || "not-created",
    mailDraftMessage: report.mailDraftMessage || "",
    mailDraftedAt: report.mailDraftedAt || "",
    markdownArchiveStatus: normalizeWeeklyMarkdownArchiveStatus(report.markdownArchiveStatus),
    markdownArchiveMessage: report.markdownArchiveMessage || "",
    markdownArchiveFileName: report.markdownArchiveFileName || "",
    markdownArchivePath: report.markdownArchivePath || "",
    markdownArchivedAt: report.markdownArchivedAt || "",
    snapshot: report.snapshot || fallbackSnapshot,
    createdAt,
    updatedAt: report.updatedAt || createdAt,
  };
}

function weeklyMailSubjectToTemplate(subject?: string, reportDate?: string) {
  const trimmed = (subject || "").trim();
  if (!trimmed || !reportDate) return trimmed;
  return trimmed.split(reportDate.replace(/-/g, "")).join("{{dateCompact}}").split(reportDate).join("{{date}}");
}

function normalizeWeeklyMailSubjectTemplate(template: string | undefined, project: Pick<Project, "name">) {
  const trimmed = (template || "").trim();
  if (!trimmed) return "";
  if (trimmed === `${project.name} 项目周报 {{date}}` || trimmed === `${project.name} 周报 {{date}}`) return "";
  return trimmed;
}

function migrateWeeklyReportPreference(preference: Partial<WeeklyReportPreference>): WeeklyReportPreference {
  const project = defaultData.projects.find((item) => item.id === preference.projectId) || defaultData.projects[0];
  return {
    projectId: preference.projectId || project.id,
    projectOwner: preference.projectOwner || project.owner || "",
    implementationMode: normalizeProjectImplementationMode(preference.implementationMode),
    projectStatus: normalizeWeeklyProjectStatus(preference.projectStatus),
    recipientsTo: preference.recipientsTo || "",
    recipientsCc: preference.recipientsCc || "",
    mailSubjectTemplate: normalizeWeeklyMailSubjectTemplate(preference.mailSubjectTemplate, project),
    updatedAt: preference.updatedAt || new Date().toISOString(),
  };
}

function normalizeWeeklyReportPreferences(preferences: Array<Partial<WeeklyReportPreference>>): WeeklyReportPreference[] {
  const byProject = new Map<string, WeeklyReportPreference>();
  preferences.forEach((preference) => {
    const next = migrateWeeklyReportPreference(preference);
    const existing = byProject.get(next.projectId);
    if (!existing || next.updatedAt.localeCompare(existing.updatedAt) >= 0) {
      byProject.set(next.projectId, next);
    }
  });
  return [...byProject.values()].sort((a, b) => a.projectId.localeCompare(b.projectId));
}

function deriveWeeklyReportPreferences(reports: WeeklyReport[]): WeeklyReportPreference[] {
  const latestByProject = new Map<string, WeeklyReport>();
  reports.forEach((report) => {
    const existing = latestByProject.get(report.projectId);
    if (!existing || report.reportDate.localeCompare(existing.reportDate) > 0 || (report.reportDate === existing.reportDate && report.updatedAt.localeCompare(existing.updatedAt) > 0)) {
      latestByProject.set(report.projectId, report);
    }
  });
  return [...latestByProject.values()].map((report) =>
    migrateWeeklyReportPreference({
      projectId: report.projectId,
      implementationMode: report.implementationMode,
      projectStatus: report.projectStatus,
      projectOwner: report.projectOwner,
      recipientsTo: report.recipientsTo,
      recipientsCc: report.recipientsCc,
      mailSubjectTemplate: weeklyMailSubjectToTemplate(report.mailSubject, report.reportDate),
      updatedAt: report.updatedAt,
    }),
  );
}

function migrateEmailConfig(config?: Partial<EmailConfig>): EmailConfig {
  const base = defaultData.emailConfig;
  return {
    ...base,
    ...(config || {}),
    provider: config?.provider === "custom" ? "custom" : "tencent-exmail",
    smtpPort: Number(config?.smtpPort || base.smtpPort),
    smtpSecure: config?.smtpSecure ?? base.smtpSecure,
    imapPort: Number(config?.imapPort || base.imapPort),
    imapSecure: config?.imapSecure ?? base.imapSecure,
    updatedAt: config?.updatedAt || "",
  };
}

type LegacyAiModelConfig = Omit<AiModelConfig, "provider"> & {
  provider?: AiModelConfig["provider"] | "local-simulated" | string;
};

function normalizeAiModelConfigs(configs: unknown): AiModelConfig[] {
  const source = Array.isArray(configs) ? (configs as LegacyAiModelConfig[]) : [];
  const migrated = source
    .filter((config) => config.provider !== "local-simulated")
    .map((config) =>
      migrateAiModelConfig({
        ...config,
        provider: config.provider === "ollama" ? "ollama" : "openai-compatible",
      } as AiModelConfig),
    );
  const defaults = clone(defaultData.aiModelConfigs);
  const defaultIds = new Set(defaults.map((config) => config.id));
  const migratedById = new Map(migrated.map((config) => [config.id, config]));
  const next = [
    ...defaults.map((base) => {
      const existing = migratedById.get(base.id);
      if (!existing) return base;
      return {
        ...base,
        ...existing,
        id: base.id,
        name: base.name,
        provider: base.provider,
        baseUrl: existing.baseUrl || base.baseUrl,
        model: existing.model || base.model,
        apiKey: existing.apiKey || base.apiKey,
        temperature: typeof existing.temperature === "number" ? existing.temperature : base.temperature,
        allowRemoteRequest: Boolean(existing.allowRemoteRequest),
        lastHealth: existing.lastHealth || base.lastHealth,
      };
    }),
    ...migrated.filter((config) => !defaultIds.has(config.id)),
  ];
  const defaultId = migrated.find((config) => config.isDefault)?.id || next.find((config) => config.isDefault)?.id || next[0]?.id;
  return next.map((config) => ({ ...config, isDefault: config.id === defaultId }));
}

function migrateAiModelConfig(config: AiModelConfig): AiModelConfig {
  const model = config.model || "";
  if (/^kimi-k2\.6(?:[.-]|$)/i.test(model)) {
    return { ...config, temperature: 1 };
  }
  const isGpt5 = /^gpt-5(?:[.-]|$)/i.test(model);
  const isAicodemirrorCodex =
    config.provider === "openai-compatible" &&
    (config.baseUrl.includes("api.aicodemirror.com/api/codex/backend-api/codex") || config.baseUrl === "https://your-proxy.example.com/v1");
  if (!isGpt5 || !isAicodemirrorCodex) return config;
  return {
    ...config,
    baseUrl: AICODEMIRROR_GPT55_URL,
  };
}

function normalizeTaskCodes(tasks: Task[]): Task[] {
  const nextCodes = new Map<string, string>();
  const tasksByProject = new Map<string, Task[]>();
  tasks.forEach((task) => {
    const items = tasksByProject.get(task.projectId) || [];
    items.push(task);
    tasksByProject.set(task.projectId, items);
  });

  const sortByPlan = (a: Task, b: Task) =>
    (a.startDate || "9999-12-31").localeCompare(b.startDate || "9999-12-31") ||
    taskCodeCollator.compare(a.code, b.code) ||
    (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31") ||
    a.title.localeCompare(b.title);

  tasksByProject.forEach((projectTasks) => {
    const ids = new Set(projectTasks.map((task) => task.id));
    const childMap = new Map<string, Task[]>();

    projectTasks.forEach((task) => {
      if (!task.parentId || !ids.has(task.parentId)) return;
      const children = childMap.get(task.parentId) || [];
      children.push(task);
      childMap.set(task.parentId, children);
    });

    const assignChildren = (parent: Task, parentCode: string) => {
      (childMap.get(parent.id) || []).sort(sortByPlan).forEach((child, childIndex) => {
        const childCode = `${parentCode}.${String(childIndex + 1).padStart(2, "0")}`;
        nextCodes.set(child.id, childCode);
        assignChildren(child, childCode);
      });
    };

    projectTasks
      .filter((task) => !task.parentId || !ids.has(task.parentId))
      .sort(sortByPlan)
      .forEach((task, index) => {
        const code = `WBS-${String(index + 1).padStart(2, "0")}`;
        nextCodes.set(task.id, code);
        assignChildren(task, code);
      });
  });

  return tasks.map((task) => ({
    ...task,
    code: nextCodes.get(task.id) || task.code,
  }));
}

function emptyDraft(): AiDraft {
  return {
    content: "",
    generatedAt: "",
    model: "",
    status: "empty",
  };
}

function emptyResourceInputs(): ResourceAssessmentInputs {
  return {
    hasFixedPersonDays: false,
    fixedPersonDays: "",
    analysisAppCount: "",
    analysisBusinessSystemCount: "",
    agentCount: "",
    syslogCount: "",
    dailyDataVolume: "",
    dailyDataUnit: "GB",
    peakFactor: "1",
    singleNodeUsableTb: "",
    singleNodeCapacityUnit: "TB",
    nodeCount: "",
    retentionDays: "180",
    needsFlink: false,
    includesSiem: false,
    includesUeba: false,
    involvesDataMigration: false,
  };
}

function emptyHandoff(): WorkflowHandoffContent {
  return {
    sow: "",
    personDay: "",
    hardware: "",
    wbs: "",
  };
}

function migrateWorkflow(workflow: DeliveryWorkflow & { resourceAssessment?: AiDraft }): DeliveryWorkflow {
  return {
    ...workflow,
    resourceInputs: {
      ...emptyResourceInputs(),
      ...(workflow.resourceInputs || {}),
    },
    handoff: {
      ...emptyHandoff(),
      ...(workflow.handoff || {}),
    },
    personDayAssessment: workflow.personDayAssessment || workflow.resourceAssessment || emptyDraft(),
    hardwareAssessment: workflow.hardwareAssessment || emptyDraft(),
    wbsPlan: workflow.wbsPlan || emptyDraft(),
    implementationPlan: workflow.implementationPlan || emptyDraft(),
    projectFlow: workflow.projectFlow || {
      status: "not_started",
      confirmedAt: "",
      generatedTaskIds: [],
      generatedDeliverableIds: [],
      sourceDraftAt: "",
    },
  };
}

export const cloneAppState = clone;

export interface ProjectRepository {
  storageLabel: string;
  load(): Promise<AppState>;
  save(state: AppState): Promise<void>;
  exportJson(state: AppState): string;
  updateTaskStatus(state: AppState, taskId: string, status: TaskStatus): AppState;
  updateTaskProgress(state: AppState, taskId: string, progress: number): AppState;
  addTask(state: AppState, task: Omit<Task, "id" | "updatedAt">): AppState;
  addWeeklyReport(state: AppState, report: WeeklyReportInput): AppState;
  upsertWeeklyReportPreference(state: AppState, preference: WeeklyReportPreferenceInput): AppState;
}

function applyWeeklyReportPreference(next: AppState, preference: WeeklyReportPreferenceInput, updatedAt = new Date().toISOString()) {
  const project = next.projects.find((item) => item.id === preference.projectId) || next.projects[0];
  next.weeklyReportPreferences = next.weeklyReportPreferences || [];
  const existingIndex = next.weeklyReportPreferences.findIndex((item) => item.projectId === project.id);
  const existing = existingIndex >= 0 ? next.weeklyReportPreferences[existingIndex] : null;
  const weeklyPreference = migrateWeeklyReportPreference({
    ...(existing || {}),
    ...preference,
    projectId: project.id,
    updatedAt,
  });
  if (existingIndex >= 0) {
    next.weeklyReportPreferences[existingIndex] = weeklyPreference;
  } else {
    next.weeklyReportPreferences.push(weeklyPreference);
  }
  next.weeklyReportPreferences.sort((a, b) => a.projectId.localeCompare(b.projectId));
}

function createBaseRepository(storageLabel: string, persistence: Pick<ProjectRepository, "load" | "save">): ProjectRepository {
  return {
    storageLabel,
    ...persistence,
    exportJson(state) {
      return JSON.stringify(state, null, 2);
    },
    updateTaskStatus(state, taskId, status) {
      const next = clone(state);
      const task = next.tasks.find((item) => item.id === taskId);
      if (task) {
        task.status = status;
        task.progress = status === "done" ? 100 : task.progress;
        task.updatedAt = new Date().toISOString();
      }
      return next;
    },
    updateTaskProgress(state, taskId, progress) {
      const next = clone(state);
      const task = next.tasks.find((item) => item.id === taskId);
      const hasChildren = next.tasks.some((item) => item.parentId === taskId);
      if (task && task.parentId && !hasChildren) {
        const nextProgress = clampProgress(progress);
        task.progress = nextProgress;
        if (nextProgress === 100) {
          task.status = "done";
        } else if (task.status === "done") {
          task.status = nextProgress > 0 ? "doing" : "todo";
        }
        task.updatedAt = new Date().toISOString();
      }
      return next;
    },
    addTask(state, task) {
      const next = clone(state);
      next.tasks.push({
        ...task,
        id: crypto.randomUUID(),
        updatedAt: new Date().toISOString(),
      });
      return next;
    },
    addWeeklyReport(state, report) {
      const next = clone(state);
      const now = new Date().toISOString();
      const project = next.projects.find((item) => item.id === report.projectId) || next.projects[0];
      const reportDate = report.reportDate || localDateKey();
      const existingIndex = next.weeklyReports.findIndex((item) =>
        report.id ? item.id === report.id : item.projectId === report.projectId && item.reportDate === reportDate,
      );
      const existing = existingIndex >= 0 ? next.weeklyReports[existingIndex] : null;
      const subject = normalizeWeeklyMailSubject(project, reportDate, report.mailSubject || report.title);
      const weeklyReport: WeeklyReport = {
        ...(existing || {}),
        ...report,
        id: existing?.id || report.id || crypto.randomUUID(),
        projectId: report.projectId,
        reportDate,
        title: normalizeWeeklyMailSubject(project, reportDate, report.title || subject),
        content: sanitizeWeeklyReportContent(report.content),
        generatedBy: report.generatedBy || "manual",
        projectOwner: report.projectOwner ?? existing?.projectOwner ?? project.owner ?? "",
        implementationMode: normalizeProjectImplementationMode(report.implementationMode),
        projectStatus: normalizeWeeklyProjectStatus(report.projectStatus),
        thisWeekTaskIds: report.thisWeekTaskIds || [],
        nextWeekTaskIds: report.nextWeekTaskIds || [],
        recipientsTo: report.recipientsTo || "",
        recipientsCc: report.recipientsCc || "",
        mailSubject: subject,
        mailDraftStatus: report.mailDraftStatus || "not-created",
        mailDraftMessage: report.mailDraftMessage || "",
        mailDraftedAt: report.mailDraftedAt || "",
        markdownArchiveStatus: normalizeWeeklyMarkdownArchiveStatus(report.markdownArchiveStatus || existing?.markdownArchiveStatus),
        markdownArchiveMessage: report.markdownArchiveMessage ?? existing?.markdownArchiveMessage ?? "",
        markdownArchiveFileName: report.markdownArchiveFileName ?? existing?.markdownArchiveFileName ?? "",
        markdownArchivePath: report.markdownArchivePath ?? existing?.markdownArchivePath ?? "",
        markdownArchivedAt: report.markdownArchivedAt ?? existing?.markdownArchivedAt ?? "",
        snapshot: buildProjectSnapshot(next, project, "weekly-report"),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      if (existingIndex >= 0) {
        next.weeklyReports[existingIndex] = weeklyReport;
      } else {
        next.weeklyReports.push(weeklyReport);
      }
      next.weeklyReports.sort((a, b) => b.reportDate.localeCompare(a.reportDate) || b.updatedAt.localeCompare(a.updatedAt));
      applyWeeklyReportPreference(
        next,
        {
          projectId: weeklyReport.projectId,
          projectOwner: weeklyReport.projectOwner,
          implementationMode: weeklyReport.implementationMode,
          projectStatus: weeklyReport.projectStatus,
          recipientsTo: weeklyReport.recipientsTo,
          recipientsCc: weeklyReport.recipientsCc,
          mailSubjectTemplate: weeklyMailSubjectToTemplate(weeklyReport.mailSubject, weeklyReport.reportDate),
        },
        now,
      );
      return next;
    },
    upsertWeeklyReportPreference(state, preference) {
      const next = clone(state);
      applyWeeklyReportPreference(next, preference);
      return next;
    },
  };
}

export function createStateRepository(storageLabel: string, persistence: Pick<ProjectRepository, "load" | "save">): ProjectRepository {
  return createBaseRepository(storageLabel, persistence);
}
