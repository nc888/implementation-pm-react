import type {
  AppState,
  Deliverable,
  Project,
  ProjectMetrics,
  ProjectMilestone,
  ProjectSnapshot,
  ProjectStageConfig,
  ScopeItem,
  Task,
  TaskStage,
  TaskStageDefinition,
  TaskStatus,
} from "../types";

export const taskStatusLabels = {
  todo: "待处理",
  doing: "进行中",
  customer: "待客户",
  blocked: "已阻塞",
  done: "已完成",
} as const;

export const defaultTaskStages: TaskStageDefinition[] = [
  { id: "kickoff", label: "项目启动", coefficient: 0.6 },
  { id: "requirements", label: "需求调研", coefficient: 1.4 },
  { id: "deployment", label: "数据接入与部署", coefficient: 1.35 },
  { id: "rules", label: "场景规则交付", coefficient: 1.25 },
  { id: "training", label: "成果汇报培训", coefficient: 0.75 },
  { id: "pilot", label: "上线试运行", coefficient: 0.75 },
  { id: "acceptance", label: "项目验收", coefficient: 0.9 },
];

const legacyStageMap: Record<string, TaskStage> = {
  kickoff: "kickoff",
  blueprint: "requirements",
  config: "deployment",
  migration: "deployment",
  uat: "training",
  launch: "pilot",
};

const legacyPhaseMap: Record<string, string> = {
  启动准备: "项目启动",
  蓝图确认: "需求调研",
  配置实施: "数据接入与部署",
  数据迁移: "数据接入与部署",
  培训UAT: "成果汇报培训",
  上线验收: "上线试运行",
};

export const stageLabels: Record<string, string> = {
  ...Object.fromEntries(defaultTaskStages.map((stage) => [stage.id, stage.label])),
  blueprint: "需求调研",
  config: "数据接入与部署",
  migration: "数据接入与部署",
  uat: "成果汇报培训",
  launch: "上线试运行",
};

export const stageOrder: TaskStage[] = defaultTaskStages.map((stage) => stage.id);

const recommendedStageCoefficientById: Record<string, number> = {
  kickoff: 0.6,
  requirements: 1.4,
  deployment: 1.35,
  rules: 1.25,
  training: 0.75,
  pilot: 0.75,
  acceptance: 0.9,
};

function roundCoefficient(value: number) {
  return Math.round(value * 100) / 100;
}

export function recommendedStageCoefficient(stage: Pick<TaskStageDefinition, "id" | "label">, fallback = 1) {
  if (recommendedStageCoefficientById[stage.id] !== undefined) return recommendedStageCoefficientById[stage.id];
  const matchedDefault = defaultTaskStages.find((item) => item.label === stage.label);
  return matchedDefault?.coefficient ?? fallback;
}

export function stageCoefficientTotal(stages: TaskStageDefinition[]) {
  return roundCoefficient(stages.reduce((sum, stage) => sum + Math.max(0, Number(stage.coefficient ?? 1) || 0), 0));
}

function normalizeStageCoefficient(stage: TaskStageDefinition, index: number) {
  const fallback = recommendedStageCoefficient(stage, 1);
  const coefficient = Number(stage.coefficient ?? fallback);
  return roundCoefficient(Number.isFinite(coefficient) ? Math.max(0, coefficient) : fallback || index * 0 + 1);
}

function fitStageCoefficientTarget(stages: TaskStageDefinition[]) {
  const total = stageCoefficientTotal(stages);
  if (!stages.length || total === stages.length) return stages;
  if (total === 0) return stages.map((stage) => ({ ...stage, coefficient: 1 }));
  const ratio = stages.length / total;
  const fitted = stages.map((stage) => ({ ...stage, coefficient: roundCoefficient((stage.coefficient ?? 1) * ratio) }));
  const delta = roundCoefficient(stages.length - stageCoefficientTotal(fitted));
  if (delta === 0) return fitted;
  const lastIndex = fitted.length - 1;
  return fitted.map((stage, index) => (index === lastIndex ? { ...stage, coefficient: roundCoefficient(Math.max(0, (stage.coefficient ?? 1) + delta)) } : stage));
}

export function normalizeStageDefinitions(stages?: TaskStageDefinition[] | null): TaskStageDefinition[] {
  const source = Array.isArray(stages) && stages.length ? stages : defaultTaskStages;
  const seen = new Set<string>();
  const normalized = source
    .map((stage, index): TaskStageDefinition | null => {
      const label = String(stage?.label || "").trim();
      const fallbackId = label ? label.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-").replace(/^-|-$/g, "") : `stage-${index + 1}`;
      const id = String(stage?.id || fallbackId || `stage-${index + 1}`).trim();
      const sourceStage = stage || ({ id, label } as TaskStageDefinition);
      return label ? { id, label, coefficient: normalizeStageCoefficient({ ...sourceStage, id, label }, index) } : null;
    })
    .filter((stage): stage is TaskStageDefinition => Boolean(stage && stage.id && stage.label))
    .filter((stage) => {
      if (seen.has(stage.id)) return false;
      seen.add(stage.id);
      return true;
    });
  return normalized.length ? fitStageCoefficientTarget(normalized) : defaultTaskStages.map((stage) => ({ ...stage }));
}

type StageConfigState = Pick<AppState, "taskStages"> & Partial<Pick<AppState, "projectStageConfigs" | "ui">>;

function normalizeMilestoneDate(value?: string) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$|^(\d{1,2})[-/](\d{1,2})$/);
  if (!match) return "";
  const year = match[1] || String(new Date().getFullYear());
  const month = match[2] || match[4];
  const day = match[3] || match[5];
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function milestoneId(title: string, dueDate: string, index: number) {
  const base = `${title}-${dueDate || index + 1}`
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return base || `milestone-${index + 1}`;
}

function parseMilestoneText(value?: string): Partial<ProjectMilestone> | null {
  const text = String(value || "").trim();
  if (!text) return null;
  const dateText = text.match(/[（(]\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2})\s*[）)]/)?.[1] || "";
  const dueDate = normalizeMilestoneDate(dateText);
  const title = text.replace(/[（(]\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2})\s*[）)]/g, "").trim();
  return title ? { title, dueDate, status: "未开始", description: "" } : null;
}

export function normalizeProjectMilestones(milestones?: Array<Partial<ProjectMilestone> | string | null | undefined> | null): ProjectMilestone[] {
  const source = Array.isArray(milestones) ? milestones : [];
  const seen = new Set<string>();
  return source
    .map((item, index): ProjectMilestone | null => {
      const partial = typeof item === "string" ? parseMilestoneText(item) : item;
      const title = String(partial?.title || "").trim();
      if (!title) return null;
      const dueDate = normalizeMilestoneDate(partial?.dueDate || "");
      const key = `${title}|${dueDate}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        id: String(partial?.id || milestoneId(title, dueDate, index)).trim() || milestoneId(title, dueDate, index),
        title,
        dueDate,
        status: String(partial?.status || "").trim() || "未开始",
        description: String(partial?.description || "").trim(),
      };
    })
    .filter((milestone): milestone is ProjectMilestone => Boolean(milestone))
    .sort((left, right) => (left.dueDate || "9999-12-31").localeCompare(right.dueDate || "9999-12-31") || left.title.localeCompare(right.title));
}

export function milestonesFromDeliverables(deliverables: Deliverable[], projectId: string): ProjectMilestone[] {
  return normalizeProjectMilestones(
    deliverables
      .filter((deliverable) => deliverable.projectId === projectId && /^M\d+(?:[-_ ]?ACCEPT)?$/i.test(deliverable.code || ""))
      .map((deliverable) => ({
        id: `deliverable-${deliverable.id}`,
        title: `${deliverable.code.replace(/[-_ ]?ACCEPT$/i, "")} ${deliverable.name.replace(/验收标准$/, "")}`.trim(),
        dueDate: deliverable.dueDate,
        status: deliverable.acceptance || deliverable.status || "未开始",
        description: deliverable.status || "",
      })),
  );
}

export function formatProjectMilestoneOption(milestone: Pick<ProjectMilestone, "title" | "dueDate">) {
  const date = milestone.dueDate ? milestone.dueDate.slice(5).replace("-", "-") : "";
  return `${milestone.title}${date ? ` (${date})` : ""}`;
}

export function createProjectStageConfig(
  projectId: string,
  stages?: TaskStageDefinition[] | null,
  updatedAt = "",
  milestones?: Array<Partial<ProjectMilestone> | string | null | undefined> | null,
): ProjectStageConfig {
  return {
    projectId,
    stages: normalizeStageDefinitions(stages),
    milestones: normalizeProjectMilestones(milestones),
    updatedAt,
  };
}

export function stageDefinitionsForProject(state?: StageConfigState | null, projectId?: string) {
  const targetProjectId = projectId || state?.ui?.currentProjectId || "";
  const projectConfig = targetProjectId ? state?.projectStageConfigs?.find((config) => config.projectId === targetProjectId) : null;
  return normalizeStageDefinitions(projectConfig?.stages || state?.taskStages);
}

export function stageDefinitionsForState(state?: StageConfigState | null, projectId?: string) {
  return stageDefinitionsForProject(state, projectId);
}

export function stageOrderForState(state?: StageConfigState | null, projectId?: string): TaskStage[] {
  return stageDefinitionsForProject(state, projectId).map((stage) => stage.id);
}

export function stageLabel(state: StageConfigState | null | undefined, stage: TaskStage, projectId?: string) {
  const matched = stageDefinitionsForProject(state, projectId).find((item) => item.id === stage || item.label === stage);
  return matched?.label || stageLabels[stage] || stage;
}

export function normalizeTaskStage(stage: string | undefined, stages?: TaskStageDefinition[] | null): TaskStage {
  const definitions = normalizeStageDefinitions(stages);
  const ids = new Set(definitions.map((item) => item.id));
  const labels = new Map(definitions.map((item) => [item.label, item.id]));
  const value = String(stage || "").trim();
  const mapped = legacyStageMap[value] || labels.get(legacyPhaseMap[value] || value) || value;
  return ids.has(mapped) ? mapped : definitions[0].id;
}

export function normalizeProjectPhase(phase: string | undefined, stages?: TaskStageDefinition[] | null) {
  const definitions = normalizeStageDefinitions(stages);
  const labels = new Set(definitions.map((stage) => stage.label));
  const value = String(phase || "").trim();
  const mapped = legacyPhaseMap[value] || stageLabels[value] || value;
  if (labels.has(mapped)) return mapped;
  const stageById = definitions.find((stage) => stage.id === value);
  return stageById?.label || mapped || definitions[0].label;
}

export type TaskNode = Task & {
  children: TaskNode[];
  depth: number;
  computedProgress: number;
  computedStatus: TaskStatus;
};

const taskCodeCollator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

export function getProject(state: AppState): Project {
  return state.projects.find((item) => item.id === state.ui.currentProjectId) || state.projects[0];
}

export function projectTasks(state: AppState, projectId = getProject(state).id) {
  return state.tasks.filter((item) => item.projectId === projectId);
}

export function projectRisks(state: AppState, projectId = getProject(state).id) {
  return state.risksIssues.filter((item) => item.projectId === projectId);
}

export function projectDeliverables(state: AppState, projectId = getProject(state).id) {
  return state.deliverables.filter((item) => item.projectId === projectId);
}

export function projectMilestonesForState(state?: AppState | null, projectId?: string) {
  if (!state) return [];
  const targetProjectId = projectId || state.ui.currentProjectId || "";
  if (!targetProjectId) return [];
  const project = state.projects.find((item) => item.id === targetProjectId);
  const config = state.projectStageConfigs.find((item) => item.projectId === targetProjectId);
  return normalizeProjectMilestones([
    ...(config?.milestones || []),
    ...milestonesFromDeliverables(projectDeliverables(state, targetProjectId), targetProjectId),
    ...(project?.nextMilestone ? [project.nextMilestone] : []),
  ]);
}

export function projectScope(state: AppState, projectId = getProject(state).id) {
  return state.scopeItems.filter((item) => item.projectId === projectId);
}

export function isExecutableTask(task: Pick<Task, "parentId" | "type"> & Partial<Pick<Task, "code">>) {
  if (task.parentId) return true;
  if (/^\d+(?:\.\d+)*$/.test(String(task.code || ""))) return false;
  return task.type !== "主任务";
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function statusFromChildren(children: TaskNode[], fallback: TaskStatus): TaskStatus {
  if (!children.length) return fallback;
  if (children.every((child) => child.computedStatus === "done")) return "done";
  if (children.filter((child) => child.computedStatus === "blocked").length / children.length > 0.6) return "blocked";
  if (children.some((child) => child.computedStatus === "customer")) return "customer";
  if (children.some((child) => ["doing", "done", "blocked"].includes(child.computedStatus))) return "doing";
  return "todo";
}

function progressFromStatus(task: Task) {
  const progress = Number(task.progress || 0);
  if (task.status === "done") return 100;
  return Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0;
}

function enrichTaskNode(task: Task, childMap: Map<string, Task[]>, depth: number): TaskNode {
  const children = (childMap.get(task.id) || [])
    .sort(compareTasksByPlan)
    .map((child) => enrichTaskNode(child, childMap, depth + 1));
  const computedProgress =
    children.length
      ? Math.round(children.reduce((sum, child) => sum + child.computedProgress, 0) / children.length)
      : progressFromStatus(task);

  return {
    ...task,
    children,
    depth,
    computedProgress,
    computedStatus: statusFromChildren(children, task.status),
  };
}

export function compareTasksByPlan(a: Task, b: Task) {
  return (
    (a.startDate || "9999-12-31").localeCompare(b.startDate || "9999-12-31") ||
    taskCodeCollator.compare(a.code, b.code) ||
    (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31")
  );
}

export function buildTaskTree(tasks: Task[]): TaskNode[] {
  const ids = new Set(tasks.map((task) => task.id));
  const childMap = new Map<string, Task[]>();

  tasks.forEach((task) => {
    if (!task.parentId || !ids.has(task.parentId)) return;
    const children = childMap.get(task.parentId) || [];
    children.push(task);
    childMap.set(task.parentId, children);
  });

  return tasks
    .filter((task) => !task.parentId || !ids.has(task.parentId))
    .sort(compareTasksByPlan)
    .map((task) => enrichTaskNode(task, childMap, 0));
}

export function flattenTaskTree(nodes: TaskNode[], expanded: Set<string>, options: { includeCollapsedChildren?: boolean } = {}): TaskNode[] {
  return nodes.flatMap((node) => {
    const children = options.includeCollapsedChildren || expanded.has(node.id) ? flattenTaskTree(node.children, expanded, options) : [];
    return [node, ...children];
  });
}

export function computedTaskProgress(task: Task, allTasks: Task[]) {
  const tree = buildTaskTree(allTasks);
  const nodes = flattenTaskTree(tree, new Set(allTasks.map((item) => item.id)), { includeCollapsedChildren: true });
  return nodes.find((node) => node.id === task.id)?.computedProgress ?? progressFromStatus(task);
}

export function calcProjectProgress(state: AppState, project: Project) {
  const stages = stageDefinitionsForProject(state, project.id);
  if (!stages.length) return 0;
  const coefficientTotal = stageCoefficientTotal(stages) || stages.length;
  const weightedProgress = calcStageProgress(state, project).reduce((sum, stage) => sum + stage.progress * Math.max(0, stage.coefficient), 0);
  return Math.max(0, Math.min(100, Math.round(weightedProgress / coefficientTotal)));
}

export function calcStageProgress(state: AppState, project: Project) {
  const tasks = projectTasks(state, project.id);
  return stageDefinitionsForProject(state, project.id).map(({ id: stage, label, coefficient = 1 }) => {
    const stageTasks = tasks.filter((task) => task.stage === stage);
    const progress = stageTasks.length
      ? Math.round(stageTasks.reduce((sum, task) => sum + computedTaskProgress(task, tasks), 0) / stageTasks.length)
      : 0;
    return {
      stage,
      label,
      coefficient,
      total: stageTasks.length,
      progress,
    };
  });
}

const numericPersonDays = (value: unknown) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};

const usageRate = (actual: number, estimated: number) => (estimated ? Math.round((actual / estimated) * 100) : 0);

export function projectPersonDayBudget(project: Project) {
  const implementation = numericPersonDays(project.estimatedImplementationPersonDays);
  const development = numericPersonDays(project.estimatedDevelopmentPersonDays);
  return {
    implementation,
    development,
    total: implementation + development,
  };
}

export function calcScopePersonDays(scopeItems: ScopeItem[]) {
  const totals = scopeItems.reduce(
    (next, item) => {
      if (item.personDayType === "开发") {
        next.developmentEstimated += numericPersonDays(item.estimatedPersonDays);
        next.developmentActual += numericPersonDays(item.actualPersonDays);
      } else {
        next.implementationEstimated += numericPersonDays(item.estimatedPersonDays);
        next.implementationActual += numericPersonDays(item.actualPersonDays);
      }
      return next;
    },
    {
      implementationEstimated: 0,
      implementationActual: 0,
      developmentEstimated: 0,
      developmentActual: 0,
    },
  );
  const estimated = totals.implementationEstimated + totals.developmentEstimated;
  const actual = totals.implementationActual + totals.developmentActual;
  return {
    ...totals,
    implementationUsageRate: usageRate(totals.implementationActual, totals.implementationEstimated),
    developmentUsageRate: usageRate(totals.developmentActual, totals.developmentEstimated),
    estimated,
    actual,
    usageRate: usageRate(actual, estimated),
  };
}

export function calcProjectPersonDays(state: AppState, project: Project) {
  const budget = projectPersonDayBudget(project);
  const scopeTotals = calcScopePersonDays(projectScope(state, project.id).filter((item) => item.category === "本期SOW范围"));
  const implementationEstimated = budget.implementation || scopeTotals.implementationEstimated;
  const developmentEstimated = budget.development || scopeTotals.developmentEstimated;
  const estimated = implementationEstimated + developmentEstimated;
  const actual = scopeTotals.actual;
  return {
    implementationBudget: budget.implementation,
    developmentBudget: budget.development,
    projectBudget: budget.total,
    scopeEstimated: scopeTotals.estimated,
    implementationScopeEstimated: scopeTotals.implementationEstimated,
    developmentScopeEstimated: scopeTotals.developmentEstimated,
    implementationEstimated,
    developmentEstimated,
    implementationActual: scopeTotals.implementationActual,
    developmentActual: scopeTotals.developmentActual,
    implementationUsageRate: usageRate(scopeTotals.implementationActual, implementationEstimated),
    developmentUsageRate: usageRate(scopeTotals.developmentActual, developmentEstimated),
    implementationVariance: scopeTotals.implementationActual - implementationEstimated,
    developmentVariance: scopeTotals.developmentActual - developmentEstimated,
    estimated,
    actual,
    usageRate: usageRate(actual, estimated),
    variance: actual - estimated,
  };
}

export function calcProjectMetrics(state: AppState, project: Project): ProjectMetrics {
  const tasks = projectTasks(state, project.id);
  const executableTasks = tasks.filter(isExecutableTask);
  const risks = projectRisks(state, project.id);
  const deliverables = projectDeliverables(state, project.id);
  const done = executableTasks.filter((task) => task.status === "done").length;
  const blocked = executableTasks.filter((task) => task.status === "blocked").length;
  const customer = executableTasks.filter((task) => task.status === "customer").length;
  const open = executableTasks.filter((task) => task.status !== "done").length;
  const openHighRisks = risks.filter((item) => item.kind === "risk" && item.severity === "高" && item.status !== "closed").length;
  const issues = risks.filter((item) => item.kind === "issue" && item.status !== "closed").length;
  const pendingDeliverables = deliverables.filter((item) => !["已验收", "内部确认"].includes(item.acceptance)).length;
  const today = localDateKey();
  const overdue = executableTasks.filter((task) => task.status !== "done" && task.dueDate && task.dueDate < today).length;
  const completionRate = calcProjectProgress(state, project);
  const personDays = calcProjectPersonDays(state, project);
  return {
    done,
    blocked,
    customer,
    open,
    openHighRisks,
    issues,
    pendingDeliverables,
    overdue,
    completionRate,
    estimatedPersonDays: personDays.estimated,
    actualPersonDays: personDays.actual,
    personDayUsageRate: personDays.usageRate,
    implementationEstimatedPersonDays: personDays.implementationEstimated,
    implementationActualPersonDays: personDays.implementationActual,
    implementationPersonDayUsageRate: personDays.implementationUsageRate,
    developmentEstimatedPersonDays: personDays.developmentEstimated,
    developmentActualPersonDays: personDays.developmentActual,
    developmentPersonDayUsageRate: personDays.developmentUsageRate,
  };
}

export function buildProjectSnapshot(state: AppState, project = getProject(state), purpose: ProjectSnapshot["purpose"] = "chat"): ProjectSnapshot {
  const tasks = projectTasks(state, project.id);
  const risks = projectRisks(state, project.id);
  const deliverables = projectDeliverables(state, project.id);
  const metrics = calcProjectMetrics(state, project);
  return {
    schemaVersion: "1.0",
    projectId: project.id,
    generatedAt: new Date().toISOString(),
    purpose,
    project: {
      id: project.id,
      name: project.name,
      client: project.client,
      phase: project.phase,
      health: project.health,
      progress: metrics.completionRate,
      nextMilestone: project.nextMilestone,
    },
    metrics: {
      ...metrics,
      totalTasks: tasks.length,
      pendingDeliverables: metrics.pendingDeliverables,
    },
    tasks: tasks.map(({ code, title, status, priority, startDate, dueDate, dimension, parentId }) => ({
      code,
      title,
      status,
      priority,
      startDate,
      dueDate,
      dimension,
      parentId,
    })),
    risks: risks.map(({ kind, title, severity, status, riskVisibility, responsePlan }) => ({
      kind,
      title,
      severity,
      status,
      riskVisibility,
      responsePlan,
    })),
    deliverables: deliverables.map(({ code, name, status, acceptance, dueDate }) => ({
      code,
      name,
      status,
      acceptance,
      dueDate,
    })),
  };
}
