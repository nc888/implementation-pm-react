import type {
  AiDraft,
  AiModelConfig,
  AppState,
  DeliveryWorkflow,
  Project,
  ResourceAssessmentInputs,
  TaskStage,
  TaskStatus,
  WorkflowHandoffContent,
  WorkflowSupplementContent,
} from "../types";
import { createProjectStageConfig, formatProjectMilestoneOption, normalizeProjectMilestones, normalizeTaskStage, stageDefinitionsForProject } from "./contextBuilder";
import { callConfiguredModel, callConfiguredModelStreaming, type ModelStreamDeltaHandler } from "./modelGateway";
import { nextProjectName, normalizeProjectNameForUniqueness } from "./projectImport";

export type DeliveryDraftKind = "personDay" | "hardware" | "wbs" | "implementation";
export type DeliveryDraftKey = "personDayAssessment" | "hardwareAssessment" | "wbsPlan" | "implementationPlan";

export const AI_GENERATION_WORKSPACE_ID = "__ai_generation_workspace__";

const now = () => new Date().toISOString();

const emptyDraft = (): AiDraft => ({
  content: "",
  generatedAt: "",
  model: "",
  status: "empty",
});

const emptyProjectFlow = () => ({
  status: "not_started" as const,
  confirmedAt: "",
  generatedTaskIds: [],
  generatedDeliverableIds: [],
  sourceDraftAt: "",
});

export const emptyHandoff = (): WorkflowHandoffContent => ({
  sow: "",
  personDay: "",
  hardware: "",
  wbs: "",
});

export const emptySupplements = (): WorkflowSupplementContent => ({
  sow: "",
  personDay: "",
  hardware: "",
  wbs: "",
  implementation: "",
});

function normalizeHandoffContent(handoff?: Partial<WorkflowHandoffContent>): WorkflowHandoffContent {
  return {
    ...emptyHandoff(),
    ...(handoff || {}),
  };
}

function normalizeSupplementContent(supplements?: Partial<WorkflowSupplementContent>): WorkflowSupplementContent {
  return {
    ...emptySupplements(),
    ...(supplements || {}),
  };
}

export const emptyResourceInputs = (): ResourceAssessmentInputs => ({
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
});

export function emptyWorkflow(projectId: string): DeliveryWorkflow {
  return {
    projectId,
    sow: {
      projectId,
      content: "",
      fileName: "",
      updatedAt: "",
    },
    resourceInputs: emptyResourceInputs(),
    handoff: emptyHandoff(),
    supplements: emptySupplements(),
    personDayAssessment: emptyDraft(),
    hardwareAssessment: emptyDraft(),
    wbsPlan: emptyDraft(),
    implementationPlan: emptyDraft(),
    projectFlow: emptyProjectFlow(),
  };
}

export function getWorkflow(state: AppState, projectId: string): DeliveryWorkflow {
  const workflow = state.deliveryWorkflows.find((item) => item.projectId === projectId);
  if (!workflow) return emptyWorkflow(projectId);
  const normalizedHandoff = normalizeHandoffContent(workflow.handoff);
  const normalizedSupplements = normalizeSupplementContent(workflow.supplements);
  const baseWorkflow = {
    ...emptyWorkflow(projectId),
    ...workflow,
    resourceInputs: {
      ...emptyResourceInputs(),
      ...(workflow.resourceInputs || {}),
    },
    handoff: normalizedHandoff,
    supplements: normalizedSupplements,
  };
  const normalizedWorkflow = {
    ...baseWorkflow,
    handoff: {
      sow: normalizedHandoff.sow || extractSowHandoffContent(baseWorkflow.sow.content),
      personDay: normalizedHandoff.personDay || extractPersonDayHandoffContent(baseWorkflow.personDayAssessment.content),
      hardware: normalizedHandoff.hardware || extractHardwareHandoffContent(baseWorkflow.hardwareAssessment.content),
      wbs: normalizedHandoff.wbs || extractWbsHandoffContent(baseWorkflow.wbsPlan.content),
    },
  };
  const project = state.projects.find((item) => item.id === projectId);
  return project ? cleanWorkflowInternalPlaceholders(project, normalizedWorkflow) : normalizedWorkflow;
}

export function getAiGenerationWorkflow(state: AppState): DeliveryWorkflow {
  return getWorkflow(state, AI_GENERATION_WORKSPACE_ID);
}

function usableIdentityValue(value: string | undefined, fallback: string) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "待确认" || trimmed === "手工粘贴") return fallback;
  return trimmed;
}

function numberFromText(value: string) {
  const match = value.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function dateRangeFromPlanItems(items: ParsedPlanItem[]) {
  const dates = items
    .flatMap((item) => [item.startDate, item.dueDate])
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  return {
    startDate: dates[0] || now().slice(0, 10),
    endDate: dates[dates.length - 1] || "",
  };
}

export function buildAiGenerationProjectContext(workflow: DeliveryWorkflow, state?: AppState, projectId = AI_GENERATION_WORKSPACE_ID): Project {
  const identity = workflow.sow.content ? inferSowIdentity(workflow.sow.fileName, workflow.sow.content) : null;
  const planItems = planItemsFromDraft(workflow);
  const dateRange = dateRangeFromPlanItems(planItems);
  const stages = stageDefinitionsForProject(state, projectId);
  const firstOpenItem = planItems.find((item) => item.status !== "done") || planItems[0];
  const phaseStage = firstOpenItem ? stages.find((stage) => stage.id === normalizeTaskStage(firstOpenItem.stage, stages)) : stages[0];
  const averageProgress = planItems.length ? Math.round(planItems.reduce((sum, item) => sum + item.progress, 0) / planItems.length) : 0;
  const fileName = workflow.sow.fileName || "";

  return {
    id: projectId,
    name: usableIdentityValue(identity?.projectName, fileName ? `${cleanSowFileBaseName(fileName)}实施项目` : "AI生成项目"),
    client: usableIdentityValue(identity?.clientName, "待确认客户"),
    phase: phaseStage?.label || "项目启动",
    health: "关注",
    owner: "我",
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    progress: averageProgress,
    nextMilestone: "",
    description: [
      "由AI生成中心根据独立草稿新建。",
      fileName ? `SOW来源：${fileName}。` : "",
      workflow.implementationPlan.content ? "已包含实施方案草稿。" : "",
    ]
      .filter(Boolean)
      .join(""),
    estimatedImplementationPersonDays: workflow.resourceInputs.hasFixedPersonDays ? numberFromText(workflow.resourceInputs.fixedPersonDays) : 0,
    estimatedDevelopmentPersonDays: 0,
  };
}

export function upsertWorkflow(state: AppState, workflow: DeliveryWorkflow): AppState {
  const exists = state.deliveryWorkflows.some((item) => item.projectId === workflow.projectId);
  return {
    ...state,
    deliveryWorkflows: exists
      ? state.deliveryWorkflows.map((item) => (item.projectId === workflow.projectId ? workflow : item))
      : [...state.deliveryWorkflows, workflow],
  };
}

type ParsedPlanItem = {
  code: string;
  type: string;
  title: string;
  milestone: boolean;
  startDate: string;
  dueDate: string;
  duration: string;
  status: TaskStatus;
  progress: number;
  owner: string;
  executor: string;
  predecessor: string;
  deliverable: string;
  delay: string;
  notes: string;
  stage: TaskStage;
};

function cleanCell(value: string) {
  return value.replace(/\*\*/g, "").trim();
}

type PlanColumnKey =
  | "code"
  | "type"
  | "title"
  | "milestone"
  | "startDate"
  | "dueDate"
  | "duration"
  | "status"
  | "progress"
  | "owner"
  | "executor"
  | "predecessor"
  | "deliverable"
  | "delay"
  | "notes";

type PlanColumnMap = Record<PlanColumnKey, number>;

const standardPlanColumnMap: PlanColumnMap = {
  code: 0,
  type: 1,
  title: 2,
  milestone: 3,
  startDate: 4,
  dueDate: 5,
  duration: 6,
  status: 7,
  progress: 8,
  owner: 9,
  executor: 10,
  predecessor: 11,
  deliverable: 12,
  delay: 13,
  notes: 14,
};

const planColumnAliases: Record<PlanColumnKey, string[]> = {
  code: ["编号", "WBS ID", "WBSID", "任务ID", "ID"],
  type: ["类型", "任务类型", "工作类型"],
  title: ["任务", "任务名称", "工作项", "事项", "名称"],
  milestone: ["里程碑", "是否里程碑"],
  startDate: ["计划开始", "开始日期", "开始时间", "开始"],
  dueDate: ["计划结束", "结束日期", "完成日期", "截止日期", "结束"],
  duration: ["工期", "持续时间", "工作日"],
  status: ["状态", "任务状态"],
  progress: ["进度", "完成度"],
  owner: ["责任人", "负责人"],
  executor: ["执行者", "执行人", "执行角色"],
  predecessor: ["前置任务", "前置", "依赖"],
  deliverable: ["输出成果", "交付物", "产出", "输出"],
  delay: ["延迟天数", "延期天数", "延期"],
  notes: ["备注", "说明", "补充说明"],
};

function markdownTableCells(line: string) {
  if (!line.includes("|")) return [];
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map(cleanCell);
}

function isSeparatorRow(cells: string[]) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function normalizePlanHeader(value: string) {
  return value.replace(/\s+/g, "").replace(/[（）()：:·.。/\\_-]/g, "").toLowerCase();
}

function planColumnIndex(cells: string[], aliases: string[]) {
  const normalizedAliases = aliases.map(normalizePlanHeader);
  return cells.findIndex((cell) => {
    const normalized = normalizePlanHeader(cell);
    return normalizedAliases.some((alias) => normalized === alias || normalized.includes(alias));
  });
}

function detectPlanColumnMap(cells: string[]): PlanColumnMap | null {
  const code = planColumnIndex(cells, planColumnAliases.code);
  const title = planColumnIndex(cells, planColumnAliases.title);
  if (code < 0 || title < 0) return null;
  return {
    code,
    type: planColumnIndex(cells, planColumnAliases.type),
    title,
    milestone: planColumnIndex(cells, planColumnAliases.milestone),
    startDate: planColumnIndex(cells, planColumnAliases.startDate),
    dueDate: planColumnIndex(cells, planColumnAliases.dueDate),
    duration: planColumnIndex(cells, planColumnAliases.duration),
    status: planColumnIndex(cells, planColumnAliases.status),
    progress: planColumnIndex(cells, planColumnAliases.progress),
    owner: planColumnIndex(cells, planColumnAliases.owner),
    executor: planColumnIndex(cells, planColumnAliases.executor),
    predecessor: planColumnIndex(cells, planColumnAliases.predecessor),
    deliverable: planColumnIndex(cells, planColumnAliases.deliverable),
    delay: planColumnIndex(cells, planColumnAliases.delay),
    notes: planColumnIndex(cells, planColumnAliases.notes),
  };
}

function planCell(cells: string[], columns: PlanColumnMap, key: PlanColumnKey) {
  const index = columns[key];
  return index >= 0 ? cells[index] || "" : "";
}

function isPlanCode(value: string) {
  return /^\d+(?:\.\d+)*$|^[A-Z]+-\d+(?:\.\d+)*$/i.test(value.trim());
}

function isEmptyPlanValue(value: string) {
  const normalized = value.trim();
  return !normalized || ["-", "—", "无", "空", "N/A", "n/a", "待确认"].includes(normalized);
}

function normalizePlanDate(value: string) {
  const match = value.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/);
  if (!match) return "";
  const [year, month, day] = match[0].split(/[-/]/);
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function statusFromPlan(value: string): TaskStatus {
  if (/已完成|完成|done/i.test(value)) return "done";
  if (/阻塞|暂停|延期|blocked/i.test(value)) return "blocked";
  if (/待客户|客户|外部|验收中/i.test(value)) return "customer";
  if (/进行|处理中|doing|in progress/i.test(value)) return "doing";
  return "todo";
}

function progressFromPlan(value: string, status: TaskStatus) {
  const match = value.match(/\d+(?:\.\d+)?/);
  if (match) return Math.max(0, Math.min(100, Math.round(Number(match[0]))));
  if (status === "done") return 100;
  if (status === "doing") return 30;
  if (status === "customer") return 50;
  if (status === "blocked") return 10;
  return 0;
}

function stageFromPlan(code: string, type: string, title: string): TaskStage {
  const text = `${code} ${type} ${title}`;
  if (/验收|结项|acceptance/i.test(text)) return "acceptance";
  if (/上线|试运行|launch|pilot/i.test(text)) return "pilot";
  if (/培训|汇报|成果|测试|UAT|uat|training/i.test(text)) return "training";
  if (/场景|规则|开发|配置|交付|rule|config/i.test(text)) return "rules";
  if (/数据|接入|部署|迁移|导入|migration|deploy/i.test(text)) return "deployment";
  if (/需求|蓝图|规划|入场|调研|blueprint|requirement/i.test(text)) return "requirements";
  if (/启动|立项|交接|kickoff/i.test(text)) return "kickoff";
  if (/^1(?:\.|$)/.test(code)) return "kickoff";
  if (/^2(?:\.|$)/.test(code)) return "requirements";
  if (/^3(?:\.|$)/.test(code)) return "deployment";
  if (/^4(?:\.|$)/.test(code)) return "rules";
  if (/^5(?:\.|$)/.test(code)) return "training";
  if (/^6(?:\.|$)/.test(code)) return "pilot";
  if (/^7(?:\.|$)/.test(code)) return "acceptance";
  return "deployment";
}

function parentCodeOf(code: string) {
  const singleDecimal = code.match(/^(\d+)\.(\d+)$/);
  if (singleDecimal) return singleDecimal[2] === "0" ? "" : `${singleDecimal[1]}.0`;
  const dotIndex = code.lastIndexOf(".");
  return dotIndex > 0 ? code.slice(0, dotIndex) : "";
}

function planItemCompletenessScore(item: ParsedPlanItem) {
  return [
    item.startDate,
    item.dueDate,
    item.duration,
    item.owner,
    item.executor,
    item.predecessor,
    item.deliverable,
    item.delay,
    item.notes,
  ].filter((value) => !isEmptyPlanValue(value)).length + (item.milestone ? 1 : 0);
}

function dedupePlanItems(items: ParsedPlanItem[]) {
  const byCode = new Map<string, ParsedPlanItem>();
  items.forEach((item) => {
    const current = byCode.get(item.code);
    if (!current || planItemCompletenessScore(item) >= planItemCompletenessScore(current)) {
      byCode.set(item.code, item);
    }
  });
  return Array.from(byCode.values());
}

function isNonExecutionPlanItem(item: ParsedPlanItem, decimalMainCodes = new Set<string>()) {
  const title = item.title.trim();
  const text = `${item.code} ${item.type} ${item.title} ${item.deliverable} ${item.notes}`;
  const pureStageTitles = [
    "项目启动",
    "需求调研",
    "需求调研与环境确认",
    "数据接入与部署",
    "平台部署与数据接入",
    "场景规则交付",
    "成果汇报培训",
    "成果汇报与培训",
    "上线试运行",
    "上线试运行/验收",
    "项目验收",
  ];
  if (/阶段|phase/i.test(item.type)) return true;
  if (/^\d+$/.test(item.code) && decimalMainCodes.has(`${item.code}.0`)) return true;
  if (/^\d+$/.test(item.code) && pureStageTitles.includes(title) && !/主任务|main/i.test(item.type)) return true;
  if (/^(本草稿|未提供|显式输入|当前引用|待确认)/.test(title)) return true;
  if (/^(说明|备注|假设|约束)[:：；;，,、\s]/.test(title)) return true;
  if (/成果汇报与深度培训/.test(title)) return true;
  if (
    /缺失参数|待确认问题|待确认项|节假日清单|客户侧负责人|客户侧资源可用性|网络、账号、日志源配合窗口|单节点磁盘容量|节点数量最终确认|前序硬件建议/.test(
      text,
    )
  ) {
    return true;
  }
  return false;
}

function filterExecutablePlanItems(items: ParsedPlanItem[]) {
  const decimalMainCodes = new Set(items.filter((item) => /^\d+\.0$/.test(item.code)).map((item) => item.code));
  return items.filter((item) => !isNonExecutionPlanItem(item, decimalMainCodes));
}

function normalizeExecutablePlanItemCode(item: ParsedPlanItem): ParsedPlanItem {
  if (!/^\d+$/.test(item.code)) return item;
  if (!/主任务|任务|main/i.test(item.type)) return item;
  return {
    ...item,
    code: `${item.code}.0`,
  };
}

function normalizeExecutablePlanItems(items: ParsedPlanItem[]) {
  return dedupePlanItems(filterExecutablePlanItems(items).map(normalizeExecutablePlanItemCode));
}

function parsePlanItemFromCells(cells: string[], columns: PlanColumnMap): ParsedPlanItem | null {
  const code = planCell(cells, columns, "code");
  const title = planCell(cells, columns, "title");
  if (!isPlanCode(code) || isEmptyPlanValue(title)) return null;
  const status = statusFromPlan(planCell(cells, columns, "status"));
  const type = planCell(cells, columns, "type") || "任务";
  const owner = planCell(cells, columns, "owner");
  const executor = planCell(cells, columns, "executor");
  return {
    code,
    type,
    title,
    milestone: /里程碑|是/i.test(planCell(cells, columns, "milestone")),
    startDate: normalizePlanDate(planCell(cells, columns, "startDate")),
    dueDate: normalizePlanDate(planCell(cells, columns, "dueDate")),
    duration: planCell(cells, columns, "duration"),
    status,
    progress: progressFromPlan(planCell(cells, columns, "progress"), status),
    owner: owner || executor || "待确认",
    executor,
    predecessor: planCell(cells, columns, "predecessor"),
    deliverable: planCell(cells, columns, "deliverable"),
    delay: planCell(cells, columns, "delay"),
    notes: planCell(cells, columns, "notes"),
    stage: stageFromPlan(code, type, title),
  };
}

function planRowsFromDraft(content: string): ParsedPlanItem[] {
  const items: ParsedPlanItem[] = [];
  let activeColumns: PlanColumnMap = standardPlanColumnMap;

  content.split(/\r?\n/).forEach((line) => {
    const cells = markdownTableCells(line);
    if (!cells.length || isSeparatorRow(cells)) return;
    const detectedColumns = detectPlanColumnMap(cells);
    if (detectedColumns) {
      activeColumns = detectedColumns;
      return;
    }
    const item = parsePlanItemFromCells(cells, activeColumns);
    if (item) items.push(item);
  });

  return normalizeExecutablePlanItems(items);
}

export function hasValidWbsPlanItems(content: string) {
  return planRowsFromDraft(content).length > 0;
}

export function summarizeWbsPlanDraft(content: string) {
  const planItems = planRowsFromDraft(content);
  const deliverables = new Set(
    planItems
      .filter((item) => !isEmptyPlanValue(item.deliverable))
      .map((item) => `${item.code}:${item.deliverable}`),
  );
  return {
    taskCount: planItems.length,
    deliverableCount: deliverables.size,
  };
}

function planItemsFromDraft(workflow: DeliveryWorkflow) {
  return planRowsFromDraft(workflow.wbsPlan.content);
}

export function confirmProjectFlow(state: AppState, projectId: string): AppState {
  const workflow = getWorkflow(state, projectId);
  const timestamp = now();
  const planItems = planItemsFromDraft(workflow);
  if (!planItems.length) return state;
  const existingGeneratedIds = new Set(workflow.projectFlow.generatedTaskIds);
  const keepTasks = state.tasks.filter((task) => !existingGeneratedIds.has(task.id));
  const generatedTasks = planItems.map((item) => ({
    id: crypto.randomUUID(),
    projectId,
    parentId: "",
    code: item.code,
    title: item.title,
    type: item.type,
    status: item.status,
    stage: normalizeTaskStage(item.stage, stageDefinitionsForProject(state, projectId)),
    dimension: item.milestone ? "WBS里程碑" : "WBS计划",
    priority: item.status === "blocked" || item.milestone ? ("高" as const) : ("中" as const),
    owner: item.owner,
    startDate: item.startDate,
    dueDate: item.dueDate,
    progress: item.progress,
    updatedAt: timestamp,
  }));
  const taskIdByCode = new Map(generatedTasks.map((task) => [task.code, task.id]));
  const generatedTasksWithParents = generatedTasks.map((task) => ({
    ...task,
    parentId: taskIdByCode.get(parentCodeOf(task.code)) || "",
  }));

  const existingDeliverableIds = new Set(workflow.projectFlow.generatedDeliverableIds);
  const keepDeliverables = state.deliverables.filter((item) => !existingDeliverableIds.has(item.id));
  const seenDeliverables = new Set<string>();
  const generatedDeliverables = planItems
    .filter((item) => !isEmptyPlanValue(item.deliverable))
    .filter((item) => {
      const key = `${item.code}:${item.deliverable}`;
      if (seenDeliverables.has(key)) return false;
      seenDeliverables.add(key);
      return true;
    })
    .map((item) => ({
      id: crypto.randomUUID(),
      projectId,
      name: item.deliverable,
      code: item.code,
      linkedTaskId: taskIdByCode.get(item.code) || "",
      status: item.status === "done" ? "已提交" : "待提交",
      acceptance: item.milestone ? "待验收" : "待确认",
      dueDate: item.dueDate,
      attachmentRequirement: "required" as const,
    }));
  const generatedMilestones = normalizeProjectMilestones(
    planItems
      .filter((item) => item.milestone)
      .map((item) => ({
        id: `plan-${projectId}-${item.code}`,
        title: item.title,
        dueDate: item.dueDate,
        status: "",
        description: item.deliverable || item.stage || "",
      })),
  );
  const nextMilestone = generatedMilestones[0] ? formatProjectMilestoneOption(generatedMilestones[0]) : "";
  const projectStageConfigs = state.projectStageConfigs.some((config) => config.projectId === projectId)
    ? state.projectStageConfigs.map((config) =>
        config.projectId === projectId
          ? {
              ...config,
              milestones: normalizeProjectMilestones([...(config.milestones || []), ...generatedMilestones]),
              updatedAt: timestamp,
            }
          : config,
      )
    : [...state.projectStageConfigs, createProjectStageConfig(projectId, stageDefinitionsForProject(state, projectId), timestamp, generatedMilestones)];

  const nextWorkflow: DeliveryWorkflow = {
    ...workflow,
    projectFlow: {
      status: "confirmed",
      confirmedAt: timestamp,
      generatedTaskIds: generatedTasksWithParents.map((task) => task.id),
      generatedDeliverableIds: generatedDeliverables.map((item) => item.id),
      sourceDraftAt: workflow.wbsPlan.generatedAt || timestamp,
    },
  };

  return upsertWorkflow(
    {
      ...state,
      tasks: [...keepTasks, ...generatedTasksWithParents],
      deliverables: [...keepDeliverables, ...generatedDeliverables],
      projectStageConfigs,
      projects: state.projects.map((item) =>
        item.id === projectId
          ? {
              ...item,
              nextMilestone: nextMilestone || item.nextMilestone,
            }
          : item,
      ),
    },
    nextWorkflow,
  );
}

export function confirmAiGenerationWorkflowAsNewProject(state: AppState, sourceWorkflow: DeliveryWorkflow) {
  const projectId = crypto.randomUUID();
  const timestamp = now();
  const projectContext = buildAiGenerationProjectContext(sourceWorkflow, state, projectId);
  const existingNames = new Set(state.projects.map((item) => normalizeProjectNameForUniqueness(item.name)));
  const project: Project = {
    ...projectContext,
    name: nextProjectName(projectContext.name, existingNames, "AI生成"),
  };
  const projectWorkflow: DeliveryWorkflow = {
    ...sourceWorkflow,
    projectId,
    sow: {
      ...sourceWorkflow.sow,
      projectId,
    },
    projectFlow: emptyProjectFlow(),
  };
  const withProject = upsertWorkflow(
    {
      ...state,
      projects: [...state.projects, project],
      projectStageConfigs: state.projectStageConfigs.some((config) => config.projectId === projectId)
        ? state.projectStageConfigs
        : [...state.projectStageConfigs, createProjectStageConfig(projectId, state.taskStages, timestamp, [])],
    },
    projectWorkflow,
  );

  const confirmedState = confirmProjectFlow(withProject, projectId);
  const confirmedWorkflow = getWorkflow(confirmedState, projectId);
  return {
    state: upsertWorkflow(confirmedState, {
      ...sourceWorkflow,
      projectFlow: {
        status: "confirmed",
        confirmedAt: confirmedWorkflow.projectFlow.confirmedAt,
        generatedTaskIds: confirmedWorkflow.projectFlow.generatedTaskIds,
        generatedDeliverableIds: confirmedWorkflow.projectFlow.generatedDeliverableIds,
        sourceDraftAt: confirmedWorkflow.projectFlow.sourceDraftAt,
      },
    }),
    projectId,
  };
}

function workflowSystemPrompt() {
  return `You are a senior software implementation project manager, delivery lead, and solution architect. Use only the structured project facts provided by the user. Do not invent facts that are not present. Output MUST be Simplified Chinese (zh-CN). Do not output Japanese. Do not output English except product names, formulas, and field codes. Return editable Markdown content only, without code fences.`;
}

function supplementFor(kind: DeliveryDraftKind | "sow", workflow?: Pick<DeliveryWorkflow, "supplements">) {
  const supplements = normalizeSupplementContent(workflow?.supplements);
  if (kind === "sow") return supplements.sow.trim();
  if (kind === "wbs") return supplements.wbs.trim();
  return "";
}

function supplementPromptBlock(title: string, content: string) {
  const normalized = content.trim();
  if (!normalized) return "";
  return `\n\n${title}：\n${normalized}`;
}

type SowSourceEntry = {
  row: number;
  category: string;
  source: string;
  countText: string;
  count: number;
  note: string;
};

type SowFactPack = {
  projectName: string;
  clientName: string;
  fillDate: string;
  expectedStartDate: string;
  signingDate: string;
  expectedPersonDays: number;
  licenseCount: number;
  background: string;
  objective: string;
  implementationSuggestion: string;
  customerFocus: string;
  customerProfile: string;
  customerAddress: string;
  pocTime: string;
  pocIssues: string;
  externalRisk: string;
  internalRisk: string;
  developmentDemand: string;
  scenarioDemand: string;
  notificationDemand: string;
  trainingDemand: string;
  customDevelopmentDemand: string;
  maintenanceDemand: string;
  sourceEntries: SowSourceEntry[];
  sourceTotal: number;
  categoryTotals: Array<{ category: string; count: number; itemCount: number }>;
  topSources: SowSourceEntry[];
  hasTraining: boolean;
  hasCustomDevelopment: boolean;
  hasBusinessChangeScenario: boolean;
  hasEnterpriseWechatNotification: boolean;
  hasDataMigration: boolean;
};

function stripCoordinatePrefix(value: string) {
  return value
    .replace(/^[A-Z]{1,3}\d+\s*=\s*/, "")
    .replace(/^\d+\s*=\s*/, "")
    .replace(/\s*[（(][A-Z]{1,3}\d+\s*->\s*[A-Z]{1,3}\d+[）)]\s*$/i, "")
    .trim();
}

function cellsFromRawLine(line: string) {
  if (!line.trim()) return [];
  const withCoordinates = [...line.matchAll(/[A-Z]{1,3}\d+=([^|]+)/g)].map((match) => stripCoordinatePrefix(match[1])).filter(Boolean);
  if (withCoordinates.length) return withCoordinates;
  return line
    .replace(/^R\d+:\s*/, "")
    .split(/\t|\|/)
    .map((cell) => stripCoordinatePrefix(cell).replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function rowsFromRawContent(rawContent: string) {
  return rawContent
    .split(/\r?\n/)
    .map((line) => {
      const rowMatch = line.match(/^R(\d+):\s*(.+)$/);
      const cells = cellsFromRawLine(line);
      return {
        row: rowMatch ? Number(rowMatch[1]) : 0,
        raw: line.trim(),
        cells,
      };
    })
    .filter((row) => row.cells.length);
}

function cellAfterLabel(cells: string[], labels: string[]) {
  const normalizedLabels = labels.map((label) => label.replace(/\s+/g, ""));
  for (let index = 0; index < cells.length; index += 1) {
    const normalized = cells[index].replace(/\s+/g, "");
    if (
      !normalizedLabels.some(
        (label) => normalized === label || normalized.endsWith(label) || normalized.includes(label) || normalized.includes(`${label}：`) || normalized.includes(`${label}:`),
      )
    ) {
      continue;
    }
    const inline = stripCoordinatePrefix(cells[index].match(/[：:]\s*(.+)$/)?.[1] || "");
    if (inline && !normalizedLabels.includes(inline.replace(/\s+/g, ""))) return inline;
    const next = stripCoordinatePrefix(cells[index + 1] || "");
    if (next && !normalizedLabels.includes(next.replace(/\s+/g, ""))) return next;
  }
  return "";
}

function factValue(rawContent: string, labels: string[]) {
  const rows = rowsFromRawContent(rawContent);
  for (const row of rows) {
    const value = cellAfterLabel(row.cells, labels);
    if (value) return value;
  }
  return extractFieldFromRaw(rawContent, labels);
}

function numberFactValue(rawContent: string, labels: string[]) {
  const rows = rowsFromRawContent(rawContent);
  const normalizedLabels = labels.map((label) => label.replace(/\s+/g, ""));
  for (const row of rows) {
    const index = row.cells.findIndex((cell) => {
      const normalized = cell.replace(/\s+/g, "");
      return normalizedLabels.some((label) => normalized === label || normalized.includes(label));
    });
    if (index < 0) continue;
    for (let cursor = index + 1; cursor < Math.min(row.cells.length, index + 5); cursor += 1) {
      const candidate = stripCoordinatePrefix(row.cells[cursor]);
      if (isCountLike(candidate)) return candidate;
    }
  }
  return factValue(rawContent, labels);
}

function isTemplateTitleValue(value: string) {
  return /客户需求表|SOW\s*$|v\d+\.\d+|需求表-v/i.test(value.trim());
}

function usableFactValue(value: string) {
  const trimmed = value.trim();
  return trimmed && !isTemplateTitleValue(trimmed) ? trimmed : "";
}

function parseLooseNumber(value: string) {
  const match = String(value || "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function normalizeDateText(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const ymd = trimmed.match(/(20\d{2})[./-](\d{1,2})[./-](\d{1,2})/);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, "0")}-${ymd[3].padStart(2, "0")}`;
  const mdY = trimmed.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (mdY) {
    const year = mdY[3].length === 2 ? `20${mdY[3]}` : mdY[3];
    return `${year}-${mdY[1].padStart(2, "0")}-${mdY[2].padStart(2, "0")}`;
  }
  return trimmed;
}

function isSourceSequence(value: string) {
  return /^\d{1,3}$/.test(value.trim());
}

function isCountLike(value: string) {
  return /^\d+(?:\.\d+)?\+?$/.test(value.trim());
}

function excelColumnValue(raw: string, column: string) {
  const match = raw.match(new RegExp(`\\b${column}\\d+=([^|]+)`));
  return match?.[1]?.trim() || "";
}

function cleanSourceText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function chooseSourceCategory(cells: string[]) {
  const known = ["操作系统", "中间件", "数据库", "交换机", "防火墙", "负载均衡", "堡垒机", "业务系统", "青藤云", "zabbix"];
  return cells.find((cell) => known.some((item) => cell.includes(item))) || "";
}

function chooseSourceName(cells: string[], category: string, note: string) {
  const ignored = new Set(["数据接入", "日志源", "设备类型", "设备数量", "工时预估（人天）", "沟通", "接入", "分析", category, note]);
  const candidates = cells
    .filter((cell) => !ignored.has(cell))
    .filter((cell) => !isSourceSequence(cell) && !isCountLike(cell))
    .filter((cell) => cell !== "操作系统已包含业务系统");
  const deduped = candidates.filter((cell, index) => candidates.indexOf(cell) === index);
  return deduped[deduped.length - 1] || category || "待确认日志源";
}

function extractSourceEntries(rawContent: string): SowSourceEntry[] {
  const excelEntries = rowsFromRawContent(rawContent)
    .filter((row) => row.row >= 35 && row.row <= 90)
    .map((row) => {
      const sequenceIndex = row.cells.findIndex(isSourceSequence);
      if (sequenceIndex < 0) return null;
      const sequence = row.cells[sequenceIndex];
      const sequenceNumber = Number(sequence);
      if (!Number.isFinite(sequenceNumber) || sequenceNumber < 1 || sequenceNumber > 300) return null;
      const deviceCountText = excelColumnValue(row.raw, "N");
      const countIndex = row.cells.findIndex((cell, index) => index > sequenceIndex && isCountLike(cell));
      const countText = deviceCountText ? (isCountLike(deviceCountText) ? deviceCountText : "") : countIndex >= 0 ? row.cells[countIndex] : "";
      if (!countText || !isCountLike(countText)) return null;
      const note = row.cells[row.cells.length - 1] || "";
      const category = chooseSourceCategory(row.cells.slice(sequenceIndex + 1)) || "其他";
      const source = chooseSourceName(row.cells.slice(sequenceIndex + 1), category, note);
      return {
        row: row.row,
        category: cleanSourceText(category),
        source: cleanSourceText(source),
        countText,
        count: parseLooseNumber(countText),
        note: cleanSourceText(note),
      };
    })
    .filter((entry): entry is SowSourceEntry => Boolean(entry && entry.source && entry.countText));
  if (excelEntries.length) return excelEntries;

  return rawContent
    .split(/\r?\n/)
    .map((line) => {
      const cells = markdownTableCells(line);
      if (cells.length < 4 || isSeparatorRow(cells)) return null;
      const [category, source, countText, note] = cells;
      if (!category || category === "类别" || !source || !isCountLike(countText)) return null;
      const row = Number(line.match(/Excel\s*R(\d+)/i)?.[1] || 0);
      return {
        row,
        category: cleanSourceText(category),
        source: cleanSourceText(source),
        countText,
        count: parseLooseNumber(countText),
        note: cleanSourceText(note || ""),
      };
    })
    .filter((entry): entry is SowSourceEntry => Boolean(entry && entry.category && entry.source));
}

function categoryTotals(entries: SowSourceEntry[]) {
  const totals = new Map<string, { category: string; count: number; itemCount: number }>();
  entries.forEach((entry) => {
    const current = totals.get(entry.category) || { category: entry.category, count: 0, itemCount: 0 };
    current.count += entry.count;
    current.itemCount += 1;
    totals.set(entry.category, current);
  });
  return Array.from(totals.values()).sort((a, b) => b.count - a.count);
}

function buildSowFactPack(fileName: string, rawContent: string): SowFactPack {
  const entries = extractSourceEntries(rawContent);
  const identity = inferSowIdentity(fileName, rawContent);
  const scenarioDemand =
    factValue(rawContent, ["场景需求"]) || rawContent.match(/[^\n。；;]*业务系统[^\n。；;]*变更[^\n。；;]*/)?.[0]?.trim() || "";
  const trainingDemand = factValue(rawContent, ["深度培训", "培训需求", "培训"]) || rawContent.match(/[^\n。；;]*深度培训[^\n。；;]*/)?.[0]?.trim() || "";
  const customDevelopmentDemand = factValue(rawContent, ["开发内容", "定制化开发", "开发需求"]);
  return {
    projectName: factValue(rawContent, ["项目名称", "项目全称", "项目名"]) || identity.projectName,
    clientName:
      usableFactValue(factValue(rawContent, ["客户名称"])) ||
      usableFactValue(factValue(rawContent, ["甲方名称", "最终用户", "用户名称"])) ||
      usableFactValue(identity.clientName),
    fillDate: normalizeDateText(factValue(rawContent, ["填表日期"])),
    expectedStartDate: normalizeDateText(factValue(rawContent, ["预计入场时间", "入场时间"])),
    signingDate: normalizeDateText(factValue(rawContent, ["签单时间", "预计签约时间"])),
    expectedPersonDays: parseLooseNumber(numberFactValue(rawContent, ["预计人天合计", "预计人天", "人天合计"])),
    licenseCount: parseLooseNumber(numberFactValue(rawContent, ["License", "license"])),
    background: factValue(rawContent, ["项目背景"]),
    objective: factValue(rawContent, ["项目目标", "建设目标"]),
    implementationSuggestion: factValue(rawContent, ["实施建议"]),
    customerFocus: factValue(rawContent, ["客户关注点"]),
    customerProfile: factValue(rawContent, ["客户资料"]),
    customerAddress: factValue(rawContent, ["客户办公地址"]),
    pocTime: factValue(rawContent, ["POC测试时间"]),
    pocIssues: factValue(rawContent, ["POC难点和遗留问题说明"]),
    externalRisk: factValue(rawContent, ["外部风险"]),
    internalRisk: factValue(rawContent, ["内部风险"]),
    developmentDemand: factValue(rawContent, ["开发需求"]),
    scenarioDemand,
    notificationDemand: factValue(rawContent, ["企业微信", "通知信息", "告警需要"]),
    trainingDemand,
    customDevelopmentDemand,
    maintenanceDemand: factValue(rawContent, ["维保需求"]),
    sourceEntries: entries,
    sourceTotal: entries.reduce((sum, entry) => sum + entry.count, 0),
    categoryTotals: categoryTotals(entries),
    topSources: [...entries].sort((a, b) => b.count - a.count).slice(0, 10),
    hasTraining: /培训/.test(trainingDemand),
    hasCustomDevelopment: !isOutOfScopeValue(`${customDevelopmentDemand}\n${factValue(rawContent, ["开发需求"])}`),
    hasBusinessChangeScenario: /变更|业务系统|运维/.test(scenarioDemand),
    hasEnterpriseWechatNotification: /企业微信|微信/.test(rawContent),
    hasDataMigration: /迁移|历史数据导入/.test(rawContent),
  };
}

function factPackHasUsefulData(facts: SowFactPack) {
  return Boolean(facts.projectName || facts.clientName || facts.sourceEntries.length || facts.expectedPersonDays || facts.objective || facts.background);
}

function markdownTable(headers: string[], rows: string[][]) {
  return [`| ${headers.join(" |")} |`, `| ${headers.map(() => ":---").join(" |")} |`, ...rows.map((row) => `| ${row.join(" |")} |`)].join("\n");
}

function compactSourceList(entries: SowSourceEntry[], limit = 20) {
  const selected = entries.slice(0, limit);
  if (!selected.length) return "未识别到明细日志源。";
  const lines = selected.map((entry) => `- ${entry.category} / ${entry.source}：${entry.countText}，${entry.note || "未填写说明"}（Excel R${entry.row}）`);
  if (entries.length > limit) lines.push(`- 其余 ${entries.length - limit} 项详见原 SOW 明细。`);
  return lines.join("\n");
}

function renderFactPackBlock(facts: SowFactPack) {
  if (!factPackHasUsefulData(facts)) return "";
  const categoryRows = facts.categoryTotals.map((item) => [item.category, String(item.itemCount), String(item.count)]);
  const topRows = facts.topSources.map((item) => [item.category, item.source, item.countText, item.note || ""]);
  return [
    "## 本地确定性事实包（由AI中心从SOW表格抽取）",
    markdownTable(
      ["字段", "值"],
      [
        ["项目名称", facts.projectName || "待确认"],
        ["客户名称", facts.clientName || "待确认"],
        ["填表日期", facts.fillDate || "待确认"],
        ["预计入场时间", facts.expectedStartDate || "待确认"],
        ["预计人天合计", facts.expectedPersonDays ? `${facts.expectedPersonDays} 人天` : "待确认"],
        ["License", facts.licenseCount ? String(facts.licenseCount) : "待确认"],
        ["日志源明细项", `${facts.sourceEntries.length} 项`],
        ["设备/日志源数量合计", facts.sourceTotal ? `${facts.sourceTotal}+` : "待确认"],
      ],
    ),
    categoryRows.length ? `\n### 日志源分类汇总\n${markdownTable(["类别", "明细项", "数量合计"], categoryRows)}` : "",
    topRows.length ? `\n### Top日志源\n${markdownTable(["类别", "日志源/设备类型", "数量", "说明"], topRows)}` : "",
    facts.scenarioDemand ? `\n### 场景需求\n${facts.scenarioDemand}` : "",
    facts.trainingDemand ? `\n### 培训要求\n${facts.trainingDemand}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function sowHandoffRowsFromFacts(facts: SowFactPack) {
  const dailyVolumeText = facts.licenseCount ? `${facts.licenseCount} GB（按License ${facts.licenseCount}G口径暂代，需客户确认）` : "待确认（SOW未给出日均GB/TB）";
  const pendingItems = [
    facts.licenseCount ? "" : "日均数据量",
    "留存周期",
    "Agent/Syslog授权口径",
    "上线前测试",
    "项目管理工时是否包含",
  ].filter(Boolean);

  return [
    ["项目类型", "日志管理平台 / 安全日志分析平台 / 日志审计合规项目"],
    ["Agent数量", "0（SOW未单独给出Agent授权口径；当前按Syslog/日志源口径评估）"],
    ["Syslog数量", facts.sourceTotal ? `${facts.sourceTotal}+（按数据接入明细设备数量合计，含200+等下限值）` : "待确认"],
    ["分析APP套数", facts.hasBusinessChangeScenario ? "1（业务变更识别场景）" : "待确认"],
    ["分析业务系统套数", facts.hasBusinessChangeScenario ? "1（基于堡垒机与业务系统中间件日志）" : "待确认"],
    ["日均接入量GB", dailyVolumeText],
    ["保留天数", "180（硬件评估默认值，需客户确认）"],
    ["固定人天", facts.expectedPersonDays ? `${facts.expectedPersonDays} 人天（SOW系统预估）` : "待确认"],
    ["SIEM", "否（SOW未明确提及）"],
    ["UEBA", "否（SOW未明确提及）"],
    ["大屏", "否（SOW未明确提及）"],
    ["定制开发", facts.hasCustomDevelopment ? "是（需复核定制化开发表）" : "否（开发需求为无/未明确）"],
    ["培训", facts.hasTraining ? "是（客户希望深度培训）" : "待确认"],
    ["UAT/验收", "待确认（SOW仅出现上线前测试字段，未明确是否需要）"],
    ["项目管理复杂度", "偏高（客户PM技术型，日志源数量大，需代理商/客户协同）"],
    ["特殊行业/涉密", "否（SOW未明确提及）"],
    ["主要待确认项", pendingItems.join("、")],
  ];
}

function sowHandoffValuesFromFacts(facts: SowFactPack) {
  return Object.fromEntries(sowHandoffRowsFromFacts(facts).filter(([, value]) => value && !/^待确认$/.test(value))) as Record<string, string>;
}

function renderSowHandoffSummaryTable(rows: string[][]) {
  return markdownTable(["字段", "值"], rows);
}

function renderLocalSowNormalization(fileName: string, rawContent: string, supplementalInfo = "") {
  const facts = buildSowFactPack(fileName, rawContent);
  const sourceRows = facts.sourceEntries.map((entry) => [entry.category, entry.source, entry.countText, entry.note || ""]);
  const handoffRows = sowHandoffRowsFromFacts(facts);
  const licenseDailyVolumeText = facts.licenseCount ? `日均接入量按 License ${facts.licenseCount}G 口径暂代为 ${facts.licenseCount} GB；` : "SOW未给出日均 GB/TB；";
  const pendingVolumeItems = facts.licenseCount ? "留存周期、授权口径和上线前测试" : "日均数据量、留存周期、授权口径和上线前测试";
  const pendingVolumeBullet = facts.licenseCount
    ? `- 日均接入量按 License ${facts.licenseCount}G 暂代，留存周期需客户确认。\n- Agent/Syslog/License 的商务授权口径与技术接入口径是否一致。`
    : "- 日均数据量（GB/TB）与留存周期。\n- Agent/Syslog/License 的商务授权口径与技术接入口径是否一致。";

  return [
    "## 关键结论",
    `- 客户为${facts.clientName || "待确认"}，项目为${facts.projectName || "待确认"}。`,
    `- 项目目标是建设统一日志管理平台，收集 IT 设备日志数据，满足等保合规，并支持业务系统运维变更识别。`,
    `- SOW 给出 License ${facts.licenseCount || "待确认"}，系统预计人天 ${facts.expectedPersonDays || "待确认"}，预计入场时间 ${facts.expectedStartDate || "待确认"}。`,
    `- 数据接入明细识别到 ${facts.sourceEntries.length} 项，设备/日志源数量下限合计 ${facts.sourceTotal || "待确认"}。`,
    `- 重点场景为基于堡垒机日志和业务系统中间件日志识别业务系统变更，并通过企业微信发送告警通知。`,
    `- 客户明确希望深度培训，要求能自行调整采集规则和分析规则。`,
    `- ${licenseDailyVolumeText}${pendingVolumeItems}仍需确认，硬件规模需结合页面参数继续评估。`,
    supplementalInfo ? `\n### 用户补充信息\n${supplementalInfo}` : "",
    "\n## 项目识别",
    markdownTable(
      ["字段", "识别值", "来源"],
      [
        ["客户名称", facts.clientName || "待确认", "SOW客户名称字段/文件名"],
        ["项目名称", facts.projectName || "待确认", "SOW项目名称字段/文件名"],
        ["填表日期", facts.fillDate || "待确认", "SOW填表日期"],
        ["预计入场时间", facts.expectedStartDate || "待确认", "SOW客户办公时间行"],
        ["预计人天合计", facts.expectedPersonDays ? `${facts.expectedPersonDays} 人天` : "待确认", "SOW合同签订情况行"],
        ["License", facts.licenseCount ? String(facts.licenseCount) : "待确认", "SOW需求收集行"],
      ],
    ),
    "\n## 项目背景与目标",
    facts.background || "待确认",
    facts.objective ? `\n${facts.objective}` : "",
    "\n## 建设范围",
    "- 建设统一日志管理平台，覆盖日志收集、存储、查询、审计合规和业务变更监测相关场景。",
    "- 实施交付包含平台部署、数据接入、场景分析配置、告警通知配置、培训和验收推进。",
    facts.implementationSuggestion ? `- 实施建议：${facts.implementationSuggestion}` : "",
    "\n## 日志接入范围",
    facts.categoryTotals.length ? markdownTable(["类别", "明细项", "数量合计"], facts.categoryTotals.map((item) => [item.category, String(item.itemCount), String(item.count)])) : "待确认",
    "\n### 日志源明细",
    sourceRows.length ? markdownTable(["类别", "日志源/设备类型", "数量", "说明"], sourceRows) : "待确认",
    "\n## Agent 数量",
    "SOW未单独给出 Agent 授权数量；当前数据接入表以操作系统、网络、安全设备、中间件、数据库等日志源数量为主。后续人天评估中 Agent 数量暂按 0/待确认处理，Syslog/日志源数量使用明细合计口径。",
    "\n## Syslog 数量",
    facts.sourceTotal ? `按数据接入明细合计为 ${facts.sourceTotal}+（其中 tomcat 为 200+，合计按下限 200 计）。` : "待确认",
    "\n## 数据量与保留周期",
    `${licenseDailyVolumeText}SOW未给出峰值系数、留存周期和节点容量。硬件资源评估会优先使用该日均量，并结合页面参数或默认值生成可复核方案。`,
    "\n## 功能范围",
    [
      "- 统一日志管理、查询、快速定位、审计合规。",
      facts.hasBusinessChangeScenario ? "- 业务系统运维变更识别：基于堡垒机日志、业务系统中间件日志识别变更系统与时间点。" : "",
      facts.hasEnterpriseWechatNotification ? "- 告警通知：告警信息需要通过企业微信发送。" : "",
      facts.hasTraining ? "- 深度培训：培训客户自行调整采集规则、分析规则。" : "",
    ]
      .filter(Boolean)
      .join("\n"),
    "\n## 实施活动",
    "- 项目启动与实施计划确认。\n- 日志平台部署与基础配置。\n- 日志源接入、解析调试与连通性验证。\n- 业务变更识别场景配置与告警通知联调。\n- 成果汇报、深度培训、试运行支持与项目验收。",
    "\n## 人天、工期与固定工作量",
    facts.expectedPersonDays ? `SOW系统预计人天合计为 ${facts.expectedPersonDays} 人天；数据接入表明细人天小计区域显示 0，存在表单未填或系统汇总冲突，后续应并列展示“SOW原估/规则估算/差异”。` : "待确认。",
    "\n## 试运行与上线验收",
    "SOW出现“系统上线前是否需要测试”字段，但未填写明确结论；试运行、上线测试与验收周期需客户确认。",
    "\n## 约束、前置条件与客户责任",
    `- 客户需提供服务器/网络/账号/防火墙策略等平台部署条件。\n- 客户需协调日志源负责人配合接入、解析验证和样例日志提供。\n- 客户需确认${facts.licenseCount ? "留存周期、授权口径、上线测试和验收标准；日均接入量当前按License口径暂代" : "日均数据量、留存周期、授权口径、上线测试和验收标准"}。\n- 客户希望参与交付并获得深度培训，培训与知识转移需要纳入计划。`,
    "\n## 待确认项",
    `${pendingVolumeBullet}\n- 预计 22 人天是否已包含项目管理、上线测试、深度培训和客户协同成本。\n- 上线前性能/安全测试是否需要项目组执行。\n- tomcat 200+ 的准确数量和业务系统日志是否需要追加接入。`,
    "\n## 传递给人天&资源评估的结构化摘要",
    markdownTable(["字段", "值"], handoffRows),
    "\n## 原始明细追溯",
    compactSourceList(facts.sourceEntries, 40),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function normalizedResourceInputs(inputs?: ResourceAssessmentInputs) {
  return {
    ...emptyResourceInputs(),
    ...(inputs || {}),
  };
}

function normalizeHandoffHeading(value: string) {
  return value.replace(/\s+/g, "").replace(/[^0-9a-zA-Z\u4e00-\u9fa5]/g, "").toLowerCase();
}

function headingMatchesAny(heading: string, keywordGroups: string[][]) {
  const normalized = normalizeHandoffHeading(heading);
  return keywordGroups.some((keywords) => keywords.every((keyword) => normalized.includes(normalizeHandoffHeading(keyword))));
}

function findHandoffSection(content: string, keywordGroups: string[][]) {
  const headingPattern = /^#{1,6}\s+(.+?)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(content))) {
    if (!headingMatchesAny(match[1], keywordGroups)) continue;
    const headingStart = match.index;
    const bodyStart = headingPattern.lastIndex;
    const nextMatch = headingPattern.exec(content);
    const sectionEnd = nextMatch?.index ?? content.length;
    return {
      headingStart,
      bodyStart,
      sectionEnd,
      heading: match[0],
      body: content.slice(bodyStart, sectionEnd).trim(),
    };
  }
  return null;
}

export function extractSowHandoffContent(content: string) {
  return (
    findHandoffSection(content, [
      ["传递给人天", "资源评估"],
      ["传入人天", "资源评估"],
      ["人天", "资源评估", "结构化摘要"],
    ])?.body || ""
  );
}

export function extractPersonDayHandoffContent(content: string) {
  return (
    findHandoffSection(content, [
      ["传递给WBS", "实施计划"],
      ["传递给WBS", "计划"],
      ["WBS", "实施计划", "结构化摘要"],
    ])?.body || ""
  );
}

export function extractHardwareHandoffContent(content: string) {
  return (
    findHandoffSection(content, [
      ["传递给实施方案第八章"],
      ["实施方案第8章", "结构化摘要"],
      ["部署规模", "资源需求"],
    ])?.body || ""
  );
}

export function extractWbsHandoffContent(content: string) {
  return (
    findHandoffSection(content, [
      ["传递给实施方案", "计划摘要"],
      ["实施方案", "计划摘要"],
      ["实施方案", "实施计划"],
    ])?.body || ""
  );
}

export function replaceSowHandoffContent(content: string, nextHandoff: string) {
  const normalizedHandoff = nextHandoff.trim();
  const section = findHandoffSection(content, [
    ["传递给人天", "资源评估"],
    ["传入人天", "资源评估"],
    ["人天", "资源评估", "结构化摘要"],
  ]);
  if (!section) {
    if (!normalizedHandoff) return content;
    return `${content.trim()}\n\n### 传递给人天&资源评估的结构化摘要\n${normalizedHandoff}\n`;
  }
  return `${content.slice(0, section.bodyStart).replace(/\s*$/, "\n")}${normalizedHandoff}\n\n${content.slice(section.sectionEnd).replace(/^\s*/, "")}`.trim();
}

function backfillWorkflowHandoff(workflow: DeliveryWorkflow): WorkflowHandoffContent {
  const handoff = normalizeHandoffContent(workflow.handoff);
  return {
    sow: handoff.sow || extractSowHandoffContent(workflow.sow.content),
    personDay: handoff.personDay || extractPersonDayHandoffContent(workflow.personDayAssessment.content),
    hardware: handoff.hardware || extractHardwareHandoffContent(workflow.hardwareAssessment.content),
    wbs: handoff.wbs || extractWbsHandoffContent(workflow.wbsPlan.content),
  };
}

function normalizeEntryKey(value: string) {
  return value.replace(/\s+/g, "").replace(/[^0-9a-zA-Z\u4e00-\u9fa5]/g, "").toLowerCase();
}

function isPendingValue(value: string) {
  const normalized = value.trim();
  return !normalized || ["-", "/", "N/A", "n/a", "待确认", "未明确", "未知", "待补充"].some((item) => normalized.includes(item));
}

function isOutOfScopeValue(value: string) {
  return /不涉及|不包含|无|否|未包含|无需|不需要|not\s*included|no/i.test(value.trim());
}

function numberTextFromValue(value: string) {
  if (isOutOfScopeValue(value)) return "0";
  if (isPendingValue(value)) return "";
  return value.match(/\d+(?:\.\d+)?/)?.[0] || "";
}

function booleanFromHandoffValue(value: string) {
  const normalized = value.trim();
  if (isOutOfScopeValue(normalized) || /false|不在.*范围/i.test(normalized)) return false;
  if (!normalized || isPendingValue(normalized)) return undefined;
  if (/是|包含|涉及|需要|已包含|有|true|yes/i.test(normalized)) return true;
  return undefined;
}

function extractDailyVolume(value: string, key: string): { volume: string; unit: ResourceAssessmentInputs["dailyDataUnit"] } | null {
  if (isPendingValue(value)) return null;
  const match = value.match(/(\d+(?:\.\d+)?)\s*(TB|T|GB|G)\b/i);
  const fallback = value.match(/\d+(?:\.\d+)?/)?.[0] || "";
  if (!match && !fallback) return null;
  const unitText = match?.[2] || key;
  return {
    volume: match?.[1] || fallback,
    unit: /TB|T/i.test(unitText) ? "TB" : "GB",
  };
}

function handoffEntries(content: string) {
  const entries: Array<{ key: string; value: string }> = [];
  content.split(/\r?\n/).forEach((line) => {
    const cells = markdownTableCells(line);
    if (cells.length >= 2 && !isSeparatorRow(cells)) {
      const key = cells[0].trim();
      const value = cells[1].trim();
      const normalizedKey = normalizeEntryKey(key);
      if (normalizedKey && !["字段", "项目", "参数", "key", "field"].includes(normalizedKey) && value) {
        entries.push({ key, value });
      }
      return;
    }

    const pair = line.match(/^\s*(?:[-*]\s*)?([^:：|]{1,48})\s*[:：]\s*(.+?)\s*$/);
    if (pair?.[1] && pair[2]) entries.push({ key: pair[1].trim(), value: pair[2].trim() });
  });
  return entries;
}

function firstHandoffValue(entries: Array<{ key: string; value: string }>, keywords: string[]) {
  const normalizedKeywords = keywords.map(normalizeEntryKey);
  return entries.find(({ key }) => {
    const normalizedKey = normalizeEntryKey(key);
    return normalizedKeywords.some((keyword) => normalizedKey.includes(keyword));
  })?.value;
}

export function mergeResourceInputsFromSowHandoff(content: string, current?: ResourceAssessmentInputs): ResourceAssessmentInputs {
  const entries = handoffEntries(content);
  if (!entries.length) return normalizedResourceInputs(current);

  const next = normalizedResourceInputs(current);
  const assignNumber = (field: keyof ResourceAssessmentInputs, keywords: string[]) => {
    const value = firstHandoffValue(entries, keywords);
    if (value === undefined) return;
    const numberText = numberTextFromValue(value);
    if (numberText) {
      next[field] = numberText as never;
    }
  };
  const assignBoolean = (field: keyof ResourceAssessmentInputs, keywords: string[]) => {
    const value = firstHandoffValue(entries, keywords);
    if (value === undefined) return;
    const booleanValue = booleanFromHandoffValue(value);
    if (booleanValue !== undefined) {
      next[field] = booleanValue as never;
    }
  };

  const fixedPersonDays = firstHandoffValue(entries, ["固定人天", "预估人天", "SOW原估", "人天"]);
  if (fixedPersonDays !== undefined) {
    if (isOutOfScopeValue(fixedPersonDays)) {
      next.hasFixedPersonDays = false;
      next.fixedPersonDays = "";
    } else {
      const numberText = numberTextFromValue(fixedPersonDays);
      if (numberText) {
        next.hasFixedPersonDays = true;
        next.fixedPersonDays = numberText;
      }
    }
  }

  assignNumber("analysisAppCount", ["分析APP", "APP套数", "分析应用"]);
  assignNumber("analysisBusinessSystemCount", ["分析业务系统", "业务系统套数"]);
  assignNumber("agentCount", ["Agent数量", "Agent数", "探针数量", "代理数量"]);
  assignNumber("syslogCount", ["Syslog数量", "Syslog数", "日志源数量"]);
  assignNumber("retentionDays", ["保留天数", "留存天数", "留存周期", "保留周期"]);

  const dailyVolume = firstHandoffValue(entries, ["日均接入量", "日均数据量", "每日数据量", "每天数据量", "数据量GB", "数据量TB"]);
  if (dailyVolume !== undefined) {
    const parsed = extractDailyVolume(dailyVolume, entries.find((entry) => entry.value === dailyVolume)?.key || "");
    if (parsed) {
      next.dailyDataVolume = parsed.volume;
      next.dailyDataUnit = parsed.unit;
    }
  }

  assignBoolean("needsFlink", ["Flink"]);
  assignBoolean("includesSiem", ["SIEM"]);
  assignBoolean("includesUeba", ["UEBA"]);
  assignBoolean("involvesDataMigration", ["数据迁移", "历史数据", "迁移"]);

  return next;
}

function promptValue(value: string) {
  return value.trim() || "待确认";
}

function resourceInputPromptBlock(inputs?: ResourceAssessmentInputs) {
  const resourceInputs = normalizedResourceInputs(inputs);
  return [
    `人工评估参数优先级：如果本参数区已填写数值，必须优先于SOW标准输入源中的同名或相关数值使用。`,
    `是否有固定人天：${resourceInputs.hasFixedPersonDays ? "是" : "否"}`,
    `固定人天数：${resourceInputs.hasFixedPersonDays ? promptValue(resourceInputs.fixedPersonDays) : "不适用"}`,
    `分析APP套数：${promptValue(resourceInputs.analysisAppCount)}`,
    `分析业务系统套数：${promptValue(resourceInputs.analysisBusinessSystemCount)}`,
    `Agent数量：${promptValue(resourceInputs.agentCount)}`,
    `Syslog数量：${promptValue(resourceInputs.syslogCount)}`,
    `日均数据量：${promptValue(resourceInputs.dailyDataVolume)} ${resourceInputs.dailyDataUnit}`,
    `峰值系数：${promptValue(resourceInputs.peakFactor)}`,
    `单节点磁盘容量：${promptValue(resourceInputs.singleNodeUsableTb)} ${resourceInputs.singleNodeCapacityUnit}`,
    `节点数：${promptValue(resourceInputs.nodeCount)}`,
    `留存天数：${promptValue(resourceInputs.retentionDays)}`,
    `是否需要Flink：${resourceInputs.needsFlink ? "是" : "否"}`,
    `是否包含SIEM：${resourceInputs.includesSiem ? "是" : "否"}`,
    `是否包含UEBA：${resourceInputs.includesUeba ? "是" : "否"}`,
    `是否涉及数据迁移：${resourceInputs.involvesDataMigration ? "是" : "否"}`,
  ].join("\n");
}

function resourceInputFactLines(inputs?: ResourceAssessmentInputs, kind?: DeliveryDraftKind) {
  const resourceInputs = normalizedResourceInputs(inputs);
  const hardwareFacts = [
    `explicitDailyDataVolume=${resourceInputs.dailyDataVolume.trim() || "unknown"}`,
    `explicitDailyDataUnit=${resourceInputs.dailyDataUnit}`,
    `explicitPeakFactor=${resourceInputs.peakFactor.trim() || "1"}`,
    `explicitSingleNodeDiskCapacity=${resourceInputs.singleNodeUsableTb.trim() || "unknown"}`,
    `explicitSingleNodeDiskCapacityUnit=${resourceInputs.singleNodeCapacityUnit}`,
    `explicitNodeCount=${resourceInputs.nodeCount.trim() || "unknown"}`,
    `explicitRetentionDays=${resourceInputs.retentionDays.trim() || "180"}`,
    `explicitNeedsFlink=${resourceInputs.needsFlink}`,
    `explicitIncludesSiem=${resourceInputs.includesSiem}`,
    `explicitIncludesUeba=${resourceInputs.includesUeba}`,
    `explicitInvolvesDataMigration=${resourceInputs.involvesDataMigration}`,
  ];
  if (kind === "hardware") return hardwareFacts;
  return [
    `explicitHasFixedPersonDays=${resourceInputs.hasFixedPersonDays}`,
    `explicitFixedPersonDays=${resourceInputs.hasFixedPersonDays ? resourceInputs.fixedPersonDays.trim() || "unknown" : "not_applicable"}`,
    `explicitAnalysisAppCount=${resourceInputs.analysisAppCount.trim() || "unknown"}`,
    `explicitAnalysisBusinessSystemCount=${resourceInputs.analysisBusinessSystemCount.trim() || "unknown"}`,
    `explicitAgentCount=${resourceInputs.agentCount.trim() || "unknown"}`,
    `explicitSyslogCount=${resourceInputs.syslogCount.trim() || "unknown"}`,
    ...hardwareFacts,
  ];
}

type SowIdentity = {
  projectName: string;
  clientName: string;
  source: string;
};

function cleanSowFileBaseName(fileName: string) {
  return (fileName || "手工粘贴")
    .replace(/\.[^.]+$/, "")
    .replace(/^[\s【\[]*\d+(?:[-_]\d+)*[\]】\s-]*/g, "")
    .replace(/\bSOW\b/gi, "")
    .replace(/[-_ ]+$/g, "")
    .trim();
}

function extractFieldFromRaw(rawContent: string, labels: string[]) {
  const normalizedLabels = labels.map((label) => label.replace(/\s+/g, ""));
  const isLabelCell = (value: string) => {
    const normalized = value.replace(/\s+/g, "");
    return normalizedLabels.some((label) => normalized === label || normalized.endsWith(`:${label}`) || normalized.endsWith(`：${label}`));
  };
  const lines = rawContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const cells = line
      .split(/\t|\|/)
      .map((cell) => stripCoordinatePrefix(cell.trim()))
      .filter(Boolean);
    for (let index = 0; index < cells.length; index += 1) {
      if (isLabelCell(cells[index])) {
        const next = cells[index + 1];
        if (next && !isLabelCell(next) && next !== "待确认") return next;
      }
    }

    const match = line.match(new RegExp(`(?:${labels.join("|")})\\s*[:：]\\s*([^|\\t，,；;]+)`));
    if (match?.[1]) return stripCoordinatePrefix(match[1]);
  }

  return "";
}

function inferSowIdentity(fileName: string, rawContent: string): SowIdentity {
  const baseName = cleanSowFileBaseName(fileName);
  const parts = baseName
    .split(/[-_—–]+/)
    .map((part) => part.trim())
    .filter((part) => part && !/^sow$/i.test(part));

  const rawClient = extractFieldFromRaw(rawContent, ["客户名称", "客户", "甲方", "甲方名称", "最终用户", "用户名称"]);
  const rawProject = extractFieldFromRaw(rawContent, ["项目名称", "项目全称", "项目名", "SOW名称"]);
  const fileClient = parts[0] || "";
  const fileProject = parts.join("-") || baseName;

  return {
    projectName: rawProject || fileProject || baseName || "待确认",
    clientName: rawClient || fileClient || "待确认",
    source: rawProject || rawClient ? "SOW正文字段优先，文件名补充" : "文件名推断",
  };
}

function scopeFlagValue(raw: string, keywords: string[]) {
  return flagFromSow(raw, keywords) ? "是（SOW已提及，需按原文复核具体范围）" : "否（SOW未明确提及）";
}

function buildSowNormalizationPrompt(project: Project, fileName: string, rawContent: string, supplementalInfo = "") {
  const identity = inferSowIdentity(fileName, rawContent);
  const supplementBlock = supplementPromptBlock("用户在生成前补充的信息（优先用于纠正或补齐本次 SOW 解析）", supplementalInfo);
  const factPackBlock = renderFactPackBlock(buildSowFactPack(fileName, rawContent));
  return `请把下面的 SOW 文件正文解析为“可继续传入人天&资源评估、WBS、实施方案生成”的标准化 Markdown 输入源。

重要：当前页面选中的项目只是承载这个 SOW 的容器，不代表 SOW 事实。项目名称、客户名称必须优先从 SOW 正文和文件名识别，禁止沿用当前页面项目名称或客户名称。
当前页面项目（仅供定位，不得作为输出事实）：${project.name} / ${project.client}
从 SOW 推断的项目名称：${identity.projectName}
从 SOW 推断的客户名称：${identity.clientName}
识别依据：${identity.source}
文件名：${fileName || "手工粘贴"}
${supplementBlock}
${factPackBlock ? `\n${factPackBlock}` : ""}

要求：
1. 不要只是转写原文，要识别 SOW 中的项目背景、建设目标、实施范围、功能范围、日志接入规模、交付活动、约束条件和验收信息。
2. 只使用文件正文和文件名中能支持的信息；无法确认的数量、工期、范围边界写“待确认”，不要编造。
3. 输出必须是简体中文 Markdown，不要包裹代码块，不要输出解释性前言。
4. 可读性要求：先输出“关键结论”，用 5-8 条短句说明项目性质、已明确范围、规模口径、主要风险和下一步确认动作；不要让正文开头就是大面积“待确认”。
5. 对已经从 SOW 正文、Excel 坐标行或文件名明确识别的信息，必须直接写出实际值；不要因为模板里有空字段就覆盖为“待确认”。Excel 坐标文本中的同一行后续非空单元格通常就是字段值，例如“填表日期： -> 2026.5.26”。
6. 待确认项集中放到“待确认项”章节；其他章节只在必要字段旁轻量标注，不要反复复制同一批缺口。
7. 不要把模板辅助列、下拉选项、示例项当成项目事实；多个 Excel Sheet 出现同类范围时要合并，并说明主表与明细表的差异。
8. 一致性硬规则：同一字段在不同章节必须一致。只要前文已经识别出 Agent 数量、Syslog 数量、预计人天、项目类型、SIEM/UEBA/大屏/定制开发是否包含等结论，“传递给人天&资源评估的结构化摘要”必须沿用同一结论，不能再写“待确认”或相反结论。若存在冲突，摘要中写“候选值A / 候选值B，需确认冲突来源”，不要直接丢弃已识别值。
9. 结构必须包含以下章节，章节名可保持一致：
   - 项目识别
   - 项目背景与目标
   - 建设范围
   - 日志接入范围
   - Agent 数量
   - Syslog 数量
   - 数据量与保留周期
   - 功能范围
   - 实施活动
   - 人天、工期与固定工作量
   - 试运行与上线验收
   - 约束、前置条件与客户责任
   - 待确认项
   - 传递给人天&资源评估的结构化摘要
10. “传递给人天&资源评估的结构化摘要”必须用 Markdown 表格，至少包含：项目类型、Agent数量、Syslog数量、分析APP套数、分析业务系统套数、日均接入量GB、保留天数、固定人天、SIEM、UEBA、大屏、定制开发、培训、UAT/验收、项目管理复杂度、特殊行业/涉密、主要待确认项。
11. SIEM、UEBA、Flink、数据迁移、大屏、定制开发这类范围项：如果 SOW 没有明确说明包含，就写“否（SOW未明确提及）”，不要写“待确认”。
12. 如果原文里存在多张表或 Excel Sheet，要合并同类信息，并在不确定时标注来源片段或 Sheet 名称。
13. 用户在生成前补充的信息优先级高于文件中的模糊、缺失或互相冲突信息；如果补充信息与文件明确内容冲突，必须在待确认项说明冲突来源。

----- SOW 文件正文开始 -----
${rawContent.trim()}
----- SOW 文件正文结束 -----`;
}

function contentBeforeResourceSummary(content: string) {
  const index = content.search(/^#{1,4}\s*传递给人天&资源评估的结构化摘要/m);
  return index >= 0 ? content.slice(0, index) : content;
}

function extractMarkdownSection(content: string, heading: string) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`^#{1,4}\\s*${escapedHeading}\\s*$`, "mi"));
  if (!match || match.index === undefined) return "";
  const start = match.index + match[0].length;
  const next = content.slice(start).search(/\n#{1,4}\s+/);
  return (next >= 0 ? content.slice(start, start + next) : content.slice(start)).trim();
}

function confirmedNumberFromSection(content: string, heading: string) {
  const section = extractMarkdownSection(contentBeforeResourceSummary(content), heading);
  if (!section || /待确认|未明确|无法确认|候选|参考/i.test(section)) return "";
  const match = section.match(/(\d+(?:\.\d+)?)\s*(台|个|套|条)?/);
  return match ? `${match[1]}${match[2] || ""}` : "";
}

function extractProjectType(content: string) {
  const source = contentBeforeResourceSummary(content);
  const match = source.match(/项目类型[：:\s]+([^|\n。]+)/);
  const value = match?.[1]?.trim() || "";
  return value && !/待确认|未明确/.test(value) ? value : "";
}

function extractExpectedPersonDays(content: string) {
  const source = contentBeforeResourceSummary(content);
  const match =
    source.match(/(?:预计人天合计|系统预估人天|预计人天|人天合计)[^0-9]{0,30}(\d+(?:\.\d+)?)\s*人天/) ||
    source.match(/字段值为\s*(\d+(?:\.\d+)?)\s*人天/);
  if (!match) return "";
  return `${match[1]}人天（SOW预计人天；若明细小计为0，应作为明细未填风险单独说明）`;
}

function extractScopeFlag(content: string, keyword: string) {
  const source = contentBeforeResourceSummary(content);
  const related = source
    .split(/\r?\n/)
    .filter((line) => line.toLowerCase().includes(keyword.toLowerCase()))
    .join("\n");
  if (!related) return "";
  if (/否|未明确|未提及|不包含|不在当前SOW范围|不计入|无/.test(related)) return `否（SOW未明确提及）`;
  if (new RegExp(`(?:是否包含)?${keyword}[：:\\s]+是|包含${keyword}`, "i").test(related)) return "是";
  return "";
}

function splitMarkdownRow(line: string) {
  if (!line.trim().startsWith("|")) return [];
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function buildMarkdownRow(cells: string[]) {
  return `| ${cells.join(" |")} |`;
}

function buildReconciledSowHandoffRows(content: string, facts: SowFactPack) {
  const section = findHandoffSection(content, [
    ["传递给人天", "资源评估"],
    ["传入人天", "资源评估"],
    ["人天", "资源评估", "结构化摘要"],
  ]);
  const existingEntries = handoffEntries(section?.body || "");
  const factRows = sowHandoffRowsFromFacts(facts);

  return factRows.map(([key, factValue]) => {
    const existingValue = firstHandoffValue(existingEntries, [key]) || "";
    if (!isPendingValue(factValue)) return [key, factValue];
    if (existingValue && !isPendingValue(existingValue)) return [key, existingValue];
    return [key, factValue];
  });
}

function reconcileSowStructuredSummary(content: string, fileName: string, rawContent: string) {
  const facts = buildSowFactPack(fileName, rawContent);
  const fallbackValues: Record<string, string> = {
    项目类型: extractProjectType(content),
    Agent数量: confirmedNumberFromSection(content, "Agent 数量"),
    Syslog数量: confirmedNumberFromSection(content, "Syslog 数量"),
    固定人天: extractExpectedPersonDays(content),
    SIEM: extractScopeFlag(content, "SIEM"),
    UEBA: extractScopeFlag(content, "UEBA"),
    大屏: extractScopeFlag(content, "大屏"),
    定制开发: extractScopeFlag(content, "定制开发"),
  };
  const rows = buildReconciledSowHandoffRows(content, facts).map(([key, value]) => [key, !isPendingValue(value) ? value : fallbackValues[key] || value]);
  const normalizedHandoff = renderSowHandoffSummaryTable(rows);
  return replaceSowHandoffContent(content, normalizedHandoff);
}

export async function normalizeSowWithAi(project: Project, fileName: string, rawContent: string, config: AiModelConfig, supplementalInfo = "") {
  const modelName = config.model || "gpt-5.5";
  const identity = inferSowIdentity(fileName, rawContent);
  console.info("[SOW标准化] 组装AI解析请求", {
    fileName,
    rawChars: rawContent.length,
    model: modelName,
    inferredProjectName: identity.projectName,
    inferredClientName: identity.clientName,
    identitySource: identity.source,
  });
  try {
    const content = await callConfiguredModel(
      config,
      [
        { role: "system", content: workflowSystemPrompt() },
        { role: "user", content: buildSowNormalizationPrompt(project, fileName, rawContent, supplementalInfo) },
      ],
      {
        requireProjectDataConsent: true,
        maxTokens: 6200,
        timeoutMs: 240_000,
      },
    );
    const reconciledContent = reconcileSowStructuredSummary(content, fileName, rawContent);
    console.info("[SOW标准化] AI解析完成", {
      model: modelName,
      outputChars: reconciledContent.length,
    });
    return { content: reconciledContent, model: modelName };
  } catch (error) {
    const fallbackContent = renderLocalSowNormalization(fileName, rawContent, supplementalInfo);
    if (fallbackContent.trim()) {
      console.warn("[SOW标准化] AI解析失败，已使用本地确定性事实抽取兜底生成标准输入源", {
        error: error instanceof Error ? error.message : error,
        fileName,
        rawChars: rawContent.length,
        outputChars: fallbackContent.length,
      });
      return { content: fallbackContent, model: "local-sow-fact-parser" };
    }
    console.error("[SOW标准化] AI解析失败，已停止生成，避免输出无效标准输入源", {
      error: error instanceof Error ? error.message : error,
      fileName,
      rawChars: rawContent.length,
    });
    throw error;
  }
}

function sharedContext(project: Project, workflow: DeliveryWorkflow) {
  const identity = workflow.sow.content ? inferSowIdentity(workflow.sow.fileName, workflow.sow.content) : null;
  return `项目名称：${identity?.projectName || project.name}
客户：${identity?.clientName || project.client}
SOW文件：${workflow.sow.fileName || "未导入文件"}
当前SOW：
${workflow.sow.content || "未提供SOW正文。请输出缺失信息清单。"}
人工评估参数：
${resourceInputPromptBlock(workflow.resourceInputs)}
生成前补充信息：
- SOW补充：${supplementFor("sow", workflow) || "无"}
- WBS补充：${supplementFor("wbs", workflow) || "无"}
输出语言：简体中文。
`;
}

function hasAny(content: string, keywords: string[]) {
  const lower = content.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

function numbersNear(content: string, keywords: string[]) {
  const values = new Set<string>();
  content
    .split(/[\r\n。；;、,，]/)
    .forEach((segment) => {
      if (!hasAny(segment, keywords)) return;
      (segment.match(/\d+(?:\.\d+)?/g) || []).forEach((value) => values.add(value));
    });
  return Array.from(values).slice(0, 6);
}

function flagFromSow(content: string, keywords: string[]) {
  const segments = content.split(/[\r\n。；;、,，]/).filter((segment) => hasAny(segment, keywords));
  if (!segments.length) return false;
  const negativeWords = ["不包含", "不涉及", "不需要", "无需", "未包含", "不在范围", "not include", "excluded"];
  const hasPositive = segments.some((segment) => !hasAny(segment, negativeWords));
  if (hasPositive) return true;
  return false;
}

function compactDraftFacts(label: string, content: string) {
  return [
    `${label}.chars=${content.length}`,
    `${label}.personDayNumbers=${numbersNear(content, ["人天", "person-day", "manday", "pd"]).join(",") || "unknown"}`,
    `${label}.hasTotal=${hasAny(content, ["总人天", "total", "合计"])}`,
    `${label}.hasPert=${hasAny(content, ["PERT", "三点估算"])}`,
  ];
}

function compactContextBlock(label: string, content: string, maxChars: number, emptyText: string) {
  const normalized = content.trim().replace(/\n{3,}/g, "\n\n");
  if (!normalized) return emptyText;
  if (normalized.length <= maxChars) return normalized;

  const headChars = Math.max(800, Math.floor(maxChars * 0.62));
  const tailChars = Math.max(500, maxChars - headChars);
  return [
    normalized.slice(0, headChars).trim(),
    `\n\n...（${label} 已压缩：原文 ${normalized.length} 字，仅保留首尾关键上下文以提升模型响应速度）...\n`,
    normalized.slice(-tailChars).trim(),
  ].join("\n");
}

function sowContextLimit(kind: DeliveryDraftKind) {
  if (kind === "implementation") return 12_000;
  if (kind === "wbs") return 10_000;
  if (kind === "personDay") return 10_000;
  return 9_000;
}

function draftContextLimit(kind: DeliveryDraftKind, source: "personDay" | "hardware" | "wbs") {
  if (kind === "implementation") {
    if (source === "wbs") return 12_000;
    return source === "personDay" ? 8_000 : 6_000;
  }
  if (kind === "wbs") return source === "personDay" ? 8_000 : 6_000;
  return 4_000;
}

function identityForWorkflow(project: Project, workflow: DeliveryWorkflow) {
  const sow = workflow.sow.content || "";
  const identity = sow ? inferSowIdentity(workflow.sow.fileName, sow) : null;
  return {
    projectName: identity?.projectName || project.name,
    clientName: identity?.clientName || project.client,
    identitySource: identity?.source || "当前项目",
  };
}

function cleanInternalPlaceholders(content: string, project: Project, workflow: DeliveryWorkflow) {
  if (!content) return content;
  const identity = identityForWorkflow(project, workflow);
  const replacements: Array<[RegExp, string]> = [
    [/\bproject_non_ascii_\d+_chars\b/g, identity.projectName],
    [/\bclient_non_ascii_\d+_chars\b/g, identity.clientName],
    [/\bcontainer_project_non_ascii_\d+_chars\b/g, project.name],
    [/\bcontainer_client_non_ascii_\d+_chars\b/g, project.client],
    [/\bsow_file_non_ascii_\d+_chars\b/g, workflow.sow.fileName || "未导入文件"],
  ];
  return replacements
    .reduce((next, [pattern, value]) => next.replace(pattern, value), content)
    .replace(/^\|\s*(所属项目|所属客户|当前页面承载项目|当前页面承载客户)\s*\|.*\|\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanWorkflowInternalPlaceholders(project: Project, workflow: DeliveryWorkflow): DeliveryWorkflow {
  const handoff = backfillWorkflowHandoff(workflow);
  return {
    ...workflow,
    handoff: {
      sow: cleanInternalPlaceholders(handoff.sow, project, workflow),
      personDay: cleanInternalPlaceholders(handoff.personDay, project, workflow),
      hardware: cleanInternalPlaceholders(handoff.hardware, project, workflow),
      wbs: cleanInternalPlaceholders(handoff.wbs, project, workflow),
    },
    personDayAssessment: {
      ...workflow.personDayAssessment,
      content: cleanInternalPlaceholders(workflow.personDayAssessment.content, project, workflow),
    },
    hardwareAssessment: {
      ...workflow.hardwareAssessment,
      content: cleanInternalPlaceholders(workflow.hardwareAssessment.content, project, workflow),
    },
    wbsPlan: {
      ...workflow.wbsPlan,
      content: cleanInternalPlaceholders(workflow.wbsPlan.content, project, workflow),
    },
    implementationPlan: {
      ...workflow.implementationPlan,
      content: cleanInternalPlaceholders(workflow.implementationPlan.content, project, workflow),
    },
  };
}

type HardwarePlan = {
  label: "最低" | "推荐⭐" | "最优";
  deployment: string;
  nodeConfig: string;
  storageNodes: number;
  systemDisk: string;
  priceLevel: "低" | "中" | "高";
  advice: string;
};

const RIZHIYI_SINGLE_NODE_RAID5_TB = 156;
const RIZHIYI_SYSTEM_DISK = "960GB SSD × 2（RAID1）";

function resourceNumberFromText(value: string) {
  const match = value.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function explicitDailyGb(inputs: ResourceAssessmentInputs) {
  const volume = resourceNumberFromText(inputs.dailyDataVolume);
  if (!volume) return 0;
  return inputs.dailyDataUnit === "TB" ? volume * 1024 : volume;
}

function dailyGbFromWorkflow(workflow: DeliveryWorkflow) {
  const inputs = normalizedResourceInputs(workflow.resourceInputs);
  const explicit = explicitDailyGb(inputs);
  if (explicit) return explicit;
  const sow = workflow.sow.content || "";
  const segments = sow.split(/[\r\n。；;、,，]/).filter((segment) => hasAny(segment, ["GB", "gb", "TB", "tb", "日均", "每日", "每天", "接入量", "数据量"]));
  for (const segment of segments) {
    const match = segment.match(/(\d+(?:\.\d+)?)\s*(TB|T|GB|G)\b/i);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    return /^T/i.test(match[2]) ? value * 1024 : value;
  }
  const candidate = numbersNear(sow, ["GB", "gb", "日均", "每日", "每天", "接入量", "数据量"])[0];
  return candidate ? Number(candidate) : 0;
}

function retentionDaysFromWorkflow(workflow: DeliveryWorkflow) {
  const inputs = normalizedResourceInputs(workflow.resourceInputs);
  const explicit = resourceNumberFromText(inputs.retentionDays);
  if (explicit) return Math.round(explicit);
  const source = workflow.sow.content || "";
  const candidate = numbersNear(source, ["天", "day", "days", "保留", "留存"])[0];
  return candidate ? Math.round(Number(candidate)) : 180;
}

function factPackFromWorkflow(workflow: DeliveryWorkflow) {
  return buildSowFactPack(workflow.sow.fileName, workflow.sow.content);
}

function effectiveSyslogCount(workflow: DeliveryWorkflow, facts = factPackFromWorkflow(workflow)) {
  const inputs = normalizedResourceInputs(workflow.resourceInputs);
  const explicit = resourceNumberFromText(inputs.syslogCount);
  if (explicit) return explicit;
  return facts.sourceTotal || 0;
}

function effectiveAgentCount(workflow: DeliveryWorkflow) {
  const inputs = normalizedResourceInputs(workflow.resourceInputs);
  return resourceNumberFromText(inputs.agentCount);
}

function effectiveFixedPersonDays(workflow: DeliveryWorkflow, facts = factPackFromWorkflow(workflow)) {
  const inputs = normalizedResourceInputs(workflow.resourceInputs);
  if (inputs.hasFixedPersonDays) return resourceNumberFromText(inputs.fixedPersonDays);
  return facts.expectedPersonDays || 0;
}

function effectiveAnalysisAppCount(workflow: DeliveryWorkflow, facts = factPackFromWorkflow(workflow)) {
  const inputs = normalizedResourceInputs(workflow.resourceInputs);
  const explicit = resourceNumberFromText(inputs.analysisAppCount);
  if (explicit) return explicit;
  return facts.hasBusinessChangeScenario ? 1 : 0;
}

function effectiveBusinessSystemCount(workflow: DeliveryWorkflow, facts = factPackFromWorkflow(workflow)) {
  const inputs = normalizedResourceInputs(workflow.resourceInputs);
  const explicit = resourceNumberFromText(inputs.analysisBusinessSystemCount);
  if (explicit) return explicit;
  return facts.hasBusinessChangeScenario ? 1 : 0;
}

function ceilCharge(count: number, unitSize: number, unitDays: number) {
  return count > 0 ? Math.ceil(count / unitSize) * unitDays : 0;
}

function renderLocalPersonDayDraft(project: Project, workflow: DeliveryWorkflow) {
  const facts = factPackFromWorkflow(workflow);
  if (!factPackHasUsefulData(facts)) return "";
  const agentCount = effectiveAgentCount(workflow);
  const syslogCount = effectiveSyslogCount(workflow, facts);
  const appCount = effectiveAnalysisAppCount(workflow, facts);
  const businessSystemCount = effectiveBusinessSystemCount(workflow, facts);
  const fixedPersonDays = effectiveFixedPersonDays(workflow, facts);
  const agentDays = ceilCharge(agentCount, 250, 5);
  const syslogDays = ceilCharge(syslogCount, 50, 5);
  const analysisDays = appCount * 5 + businessSystemCount * 3;
  const trainingDays = facts.hasTraining ? 2 : 0;
  const notificationDays = facts.hasEnterpriseWechatNotification ? 1 : 0;
  const baseDeliveryDays = 5;
  const baseSubtotal = baseDeliveryDays + agentDays + syslogDays + analysisDays + trainingDays + notificationDays;
  const pmSuggestion = Math.max(2, Math.ceil(baseSubtotal * 0.2));
  const ruleTotal = baseSubtotal + pmSuggestion;
  const optimistic = Math.max(1, Math.round(ruleTotal * 0.85));
  const likely = ruleTotal;
  const pessimistic = Math.round(ruleTotal * 1.25);
  const pert = Math.round((optimistic + 4 * likely + pessimistic) / 6);
  const handoffRows = [
    ["总人天口径", fixedPersonDays ? `SOW原估 ${fixedPersonDays} 人天；规则估算 ${ruleTotal} 人天；建议PM确认差异` : `规则估算 ${ruleTotal} 人天；SOW原估待确认`],
    ["阶段工时建议", `启动2、需求调研3、平台部署与数据接入${Math.max(8, syslogDays)}、场景规则${Math.max(3, analysisDays)}、培训${Math.max(1, trainingDays)}、试运行/验收待确认`],
    ["数据接入口径", `${facts.sourceEntries.length}项日志源，设备/日志源数量下限${syslogCount}+`],
    ["待确认项", "日均数据量、留存周期、上线前测试、PM工时是否包含、License与接入口径差异"],
  ];

  return [
    "## 人天评估结果（本地确定性初步，不含未确认加成）",
    "### 一、输入来源与评估条件",
    markdownTable(
      ["字段", "值"],
      [
        ["项目名称", facts.projectName || project.name],
        ["客户名称", facts.clientName || project.client],
        ["SOW预计人天", fixedPersonDays ? `${fixedPersonDays} 人天` : "待确认"],
        ["日志源明细", `${facts.sourceEntries.length} 项，数量下限 ${syslogCount}+`],
        ["分析场景", facts.hasBusinessChangeScenario ? "业务系统变更识别 1 项" : "待确认"],
        ["深度培训", facts.hasTraining ? "包含" : "待确认"],
      ],
    ),
    "### 二、基础服务明细",
    markdownTable(
      ["服务项", "公式/依据", "人天"],
      [
        ["基础交付", "项目启动、计划、基础部署准备", String(baseDeliveryDays)],
        ["Agent接入", `Agent=ceil(${agentCount}/250)×5`, String(agentDays)],
        ["Syslog/日志源接入", `Syslog=ceil(${syslogCount}/50)×5`, String(syslogDays)],
        ["数据分析", `分析APP ${appCount}×5 + 业务系统 ${businessSystemCount}×3`, String(analysisDays)],
        ["企业微信告警联调", facts.hasEnterpriseWechatNotification ? "SOW明确告警通过企业微信发送" : "未明确", String(notificationDays)],
        ["深度培训", facts.hasTraining ? "客户希望自行调整采集和分析规则" : "未明确", String(trainingDays)],
      ],
    ),
    "### 三、基础服务小计",
    `基础服务小计：${baseSubtotal} 人天。`,
    "### 四、未确认加成",
    "- 项目管理：建议按20%暂估，但需PM确认是否已包含在SOW 22人天内。\n- 上线测试/UAT：SOW字段未填写明确结论，暂不计入完整合计。\n- 国网/军工/涉密：SOW未明确提及，按不包含处理。",
    "### 五、传统估算合计",
    markdownTable(
      ["口径", "人天", "说明"],
      [
        ["SOW原估", fixedPersonDays ? String(fixedPersonDays) : "待确认", "来自客户需求表系统预计人天"],
        ["规则估算", String(ruleTotal), "基础服务小计 + 项目管理建议值"],
        ["差异说明", fixedPersonDays ? `${ruleTotal - fixedPersonDays} 人天` : "待确认", "日志源数量大，SOW明细小计为空/为0，需复核22人天是否为商务口径"],
      ],
    ),
    "### 六、PERT三点估算",
    markdownTable(
      ["乐观", "最可能", "悲观", "PERT"],
      [[String(optimistic), String(likely), String(pessimistic), String(pert)]],
    ),
    "### 七、SOW原估对比",
    fixedPersonDays
      ? `SOW原估为 ${fixedPersonDays} 人天；本地规则按 ${syslogCount}+ 日志源下限估算为 ${ruleTotal} 人天。由于原表数据接入小计显示0，建议在排期前确认是否仅以22人天作为合同上限。`
      : "SOW未识别到有效原估。",
    "### 八、缺失参数清单与待确认问题",
    "- 日均数据量GB/TB与留存周期。\n- 上线前测试是否需要项目组执行。\n- 项目管理工时是否已包含。\n- tomcat 200+ 的准确数量。\n- License 50 与设备/日志源数量下限合计之间的口径关系。",
    "### 九、传递给WBS/实施计划的结构化摘要",
    markdownTable(["字段", "值"], handoffRows),
  ]
    .filter(Boolean)
    .join("\n\n");
}

type LocalPlanRow = {
  code: string;
  type: string;
  task: string;
  milestone: string;
  duration: number;
  owner: string;
  executor: string;
  predecessor: string;
  deliverable: string;
  notes: string;
};

function dateAddWorkdays(startDate: string, offset: number) {
  const match = startDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return startDate;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  let remaining = Math.max(0, offset);
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localPlanRow(
  code: string,
  type: string,
  task: string,
  duration: number,
  owner: string,
  executor: string,
  predecessor: string,
  deliverable: string,
  notes = "",
  milestone = "",
): LocalPlanRow {
  return { code, type, task, milestone, duration, owner, executor, predecessor, deliverable, notes };
}

function sourceTaskRows(facts: SowFactPack) {
  const categoryOrder = ["操作系统", "中间件", "数据库", "交换机", "防火墙", "负载均衡", "堡垒机", "青藤云", "zabbix", "业务系统"];
  const rows: LocalPlanRow[] = [];
  let index = 3;
  categoryOrder.forEach((category) => {
    const entries = facts.sourceEntries.filter((entry) => entry.category === category);
    if (!entries.length) return;
    const total = entries.reduce((sum, entry) => sum + entry.count, 0);
    const names = entries
      .slice(0, 4)
      .map((entry) => `${entry.source}×${entry.countText}`)
      .join("、");
    const taskScope = entries.length > 1 ? `（${entries.length}类）` : "";
    const duration = Math.max(1, Math.min(5, Math.ceil(total / (category === "操作系统" ? 450 : 120))));
    rows.push(
      localPlanRow(
        `3.${index}`,
        "实施",
        `${category}日志接入与解析调试${taskScope}`,
        duration,
        "实施工程师",
        "实施工程师",
        index === 3 ? "3.2" : `3.${index - 1}`,
        `${category}日志接入记录、解析规则、连通性验证截图`,
        names,
      ),
    );
    index += 1;
  });
  return rows;
}

function renderPlanTable(rows: LocalPlanRow[], startDate: string) {
  let elapsed = 0;
  const rendered = rows.map((row) => {
    const start = dateAddWorkdays(startDate, elapsed);
    const end = dateAddWorkdays(start, Math.max(0, row.duration - 1));
    elapsed += Math.max(1, row.duration);
    return [
      row.code,
      row.type,
      row.task,
      row.milestone,
      start,
      end,
      `${row.duration}工作日`,
      "未开始",
      "0%",
      row.owner,
      row.executor,
      row.predecessor,
      row.deliverable,
      "0",
      row.notes,
    ];
  });
  return markdownTable(["编号", "类型", "任务", "里程碑（是/否）", "计划开始", "计划结束", "工期", "状态", "进度", "责任人", "执行者", "前置任务", "输出成果", "延迟天数", "备注"], rendered);
}

function renderLocalWbsDraft(project: Project, workflow: DeliveryWorkflow) {
  const facts = factPackFromWorkflow(workflow);
  if (!factPackHasUsefulData(facts)) return "";
  const startDate = facts.expectedStartDate || now().slice(0, 10);
  const fixedPersonDays = effectiveFixedPersonDays(workflow, facts);
  const dataRows = sourceTaskRows(facts);
  const hasPilot = /试运行|上线|验收|测试/.test(`${workflow.personDayAssessment.content}\n${facts.objective}\n${facts.scenarioDemand}`);
  const rows: LocalPlanRow[] = [
    localPlanRow("1.0", "主任务", "项目启动与实施准备", 1, "项目经理", "项目经理", "", "项目启动会议纪要、项目干系人清单"),
    localPlanRow("1.1", "实施", "项目启动会议与实施交底", 1, "项目经理", "项目经理", "1.0", "启动会纪要、实施范围确认记录"),
    localPlanRow("1.2", "实施", "制定详细实施计划", 1, "项目经理", "项目经理", "1.1", "实施计划、沟通计划"),
    localPlanRow("2.0", "主任务", "需求调研与环境确认", 1, "项目经理", "实施工程师", "1.2", "需求调研记录、环境准备清单"),
    localPlanRow("2.1", "实施", "日志源范围与授权口径确认", 1, "项目经理", "实施工程师", "1.2", "日志源范围确认表"),
    localPlanRow("2.2", "实施", "部署资源、网络策略与账号确认", 1, "实施工程师", "实施工程师", "2.1", "资源申请清单、网络策略清单"),
    localPlanRow("3.0", "主任务", "平台部署与数据接入", 1, "项目经理", "实施工程师", "2.2", "平台部署记录、数据接入清单"),
    localPlanRow("3.1", "实施", "日志易平台安装部署", 2, "实施工程师", "实施工程师", "2.2", "部署记录、基础配置截图"),
    localPlanRow("3.2", "实施", "基础配置与连通性验证", 1, "实施工程师", "实施工程师", "3.1", "连通性验证记录"),
    ...dataRows,
    localPlanRow("3.99", "里程碑", "M1 平台部署与数据接入完成", 1, "项目经理", "实施工程师", dataRows.at(-1)?.code || "3.2", "M1阶段验收记录", "", "里程碑"),
    localPlanRow("4.0", "主任务", "场景规则交付", 1, "项目经理", "实施工程师", "3.99", "场景规则配置清单"),
    localPlanRow("4.1", "实施", "业务系统变更识别场景配置", 2, "实施工程师", "实施工程师", "3.99", "业务变更识别规则、样例查询结果", "基于堡垒机日志与业务系统中间件日志"),
    localPlanRow("4.2", "实施", "企业微信告警通知联调", facts.hasEnterpriseWechatNotification ? 1 : 0, "实施工程师", "实施工程师", "4.1", "告警通知联调记录", facts.hasEnterpriseWechatNotification ? "SOW明确需要企业微信通知" : "如客户不需要可删除"),
    localPlanRow("4.99", "里程碑", "M2 场景规则交付完成", 1, "项目经理", "实施工程师", "4.2", "M2阶段验收记录", "", "里程碑"),
    localPlanRow("5.0", "主任务", "项目成果汇报与培训", 1, "项目经理", "项目经理", "4.99", "成果汇报材料、培训记录"),
    localPlanRow("5.1", "实施", "项目成果汇报与基础操作培训", 1, "项目经理", "实施工程师", "4.99", "成果汇报材料、培训记录"),
    ...(facts.hasTraining
      ? [
          localPlanRow(
            "5.2",
            "实施",
            "采集规则与分析规则专项培训",
            2,
            "实施工程师",
            "实施工程师",
            "5.1",
            "专项培训材料、演练记录",
            "客户希望自行调整规则",
          ),
        ]
      : []),
    ...(hasPilot
      ? [
          localPlanRow("6.0", "主任务", "上线试运行", 1, "项目经理", "实施工程师", facts.hasTraining ? "5.2" : "5.1", "试运行记录"),
          localPlanRow("6.1", "实施", "上线试运行支持与问题闭环", 3, "实施工程师", "实施工程师", facts.hasTraining ? "5.2" : "5.1", "试运行问题清单、闭环记录"),
        ]
      : []),
    localPlanRow("7.0", "主任务", "项目验收", 1, "项目经理", "项目经理", hasPilot ? "6.1" : facts.hasTraining ? "5.2" : "5.1", "验收材料"),
    localPlanRow("7.1", "里程碑", "M3 项目验收", 1, "项目经理", "项目经理", hasPilot ? "6.1" : facts.hasTraining ? "5.2" : "5.1", "验收报告、交付物归档清单", "", "里程碑"),
  ].filter((row) => row.duration > 0);

  const taskRows = rows.map((row) => [row.code, row.type, row.task, row.owner, row.deliverable]);
  const supplement = supplementFor("wbs", workflow);
  return [
    "## WBS分解与实施计划表（本地确定性草稿）",
    supplement ? `### 本次生成前补充信息\n${supplement}` : "",
    "### 一、输入来源与生成条件",
    markdownTable(
      ["字段", "值"],
      [
        ["项目名称", facts.projectName || project.name],
        ["客户名称", facts.clientName || project.client],
        ["计划起点", `${startDate}${facts.expectedStartDate ? "（SOW预计入场时间）" : "（生成日期默认）"}`],
        ["SOW预计人天", fixedPersonDays ? `${fixedPersonDays} 人天` : "待确认"],
        ["日志源规模", `${facts.sourceEntries.length}项，数量下限${facts.sourceTotal}+`],
      ],
    ),
    "### 二、WBS任务清单",
    markdownTable(["编号", "类型", "任务", "责任人", "输出成果"], taskRows),
    "### 三、详细计划表",
    renderPlanTable(rows, startDate),
    "### 四、文本甘特图时间轴",
    rows
      .filter((row) => /^\d+\.0$/.test(row.code) || row.milestone)
      .map((row) => `- ${row.code} ${row.task}：${row.duration}工作日`)
      .join("\n"),
    "### 五、里程碑节点列表",
    markdownTable(
      ["里程碑", "触发任务", "验收物"],
      rows.filter((row) => row.milestone).map((row) => [row.task, row.predecessor, row.deliverable]),
    ),
    "### 六、缺失参数清单与待确认问题",
    "- 当前排期按SOW预计入场时间和工作日连续排布，未扣除客户不可用窗口。\n- 22人天是否作为排期上限需PM确认。\n- 日均数据量与硬件资源准备周期未确认，可能影响平台部署起点。\n- 上线试运行是否纳入合同范围需确认。",
    "### 七、传递给实施方案的计划摘要",
    markdownTable(
      ["字段", "值"],
      [
        ["阶段", "项目启动、需求调研与环境确认、平台部署与数据接入、场景规则交付、成果汇报与培训、上线试运行/验收"],
        ["计划起点", startDate],
        ["任务数量", String(rows.length)],
        ["里程碑", rows.filter((row) => row.milestone).map((row) => row.task).join("；")],
        ["主要交付物", "启动会纪要、实施计划、部署记录、日志接入清单、场景规则、培训材料、验收报告"],
      ],
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderLocalHardwareMissingDraft(project: Project, workflow: DeliveryWorkflow) {
  const facts = factPackFromWorkflow(workflow);
  if (!factPackHasUsefulData(facts)) return "";
  const inputs = normalizedResourceInputs(workflow.resourceInputs);
  return [
    "## 硬件资源评估结果（缺少容量参数，暂不能正式测算）",
    "### 一、输入来源与当前结论",
    markdownTable(
      ["字段", "值"],
      [
        ["项目名称", facts.projectName || project.name],
        ["客户名称", facts.clientName || project.client],
        ["日志源规模", `${facts.sourceEntries.length}项，设备/日志源数量下限${facts.sourceTotal || "待确认"}+`],
        ["日均数据量", inputs.dailyDataVolume ? `${inputs.dailyDataVolume} ${inputs.dailyDataUnit}` : "缺失"],
        ["留存天数", inputs.retentionDays || "180（默认，待确认）"],
        ["峰值系数", inputs.peakFactor || "1"],
        ["单节点容量", inputs.singleNodeUsableTb ? `${inputs.singleNodeUsableTb} ${inputs.singleNodeCapacityUnit}` : "缺失"],
        ["节点数", inputs.nodeCount || "缺失"],
      ],
    ),
    "### 二、缺失参数清单",
    markdownTable(
      ["参数", "状态", "为什么需要"],
      [
        ["日均数据量GB/TB", inputs.dailyDataVolume ? "已填写" : "缺失", "决定数据存储、Kafka缓存和EPS估算"],
        ["留存周期", inputs.retentionDays ? "已填写/默认180" : "缺失", "决定总存储容量"],
        ["单节点可用容量", inputs.singleNodeUsableTb ? "已填写" : "缺失", "决定节点数与N-1校验"],
        ["节点数/高可用要求", inputs.nodeCount ? "已填写" : "缺失", "决定集群总容量和容灾能力"],
      ],
    ),
    "### 三、可先确认的部署约束",
    "- 当前SOW已明确日志源数量很大，硬件测算不能只按License 50推导。\n- SOW未明确SIEM/UEBA/Flink，默认不纳入本期硬件增量。\n- 业务变更识别场景需要保证堡垒机日志与业务系统中间件日志的解析和查询性能。",
    "### 四、三档方案对比",
    markdownTable(
      ["方案", "部署方式", "单节点配置", "系统盘", "数据盘", "单节点存储", "集群总存储", "N-1容灾", "预估价格等级", "适用建议"],
      [
        ["最低", "待确认", "缺少日均数据量，暂不推荐落地", "待确认", "待确认", "待确认", "待确认", "待确认", "待确认", "补齐容量参数后再测算"],
        ["推荐★", "待确认", "缺少日均数据量，暂不推荐落地", "待确认", "待确认", "待确认", "待确认", "待确认", "待确认", "补齐容量参数后再测算"],
        ["最优", "待确认", "缺少日均数据量，暂不推荐落地", "待确认", "待确认", "待确认", "待确认", "待确认", "待确认", "补齐容量参数后再测算"],
      ],
    ),
    "### 实施方案第八章结构化摘要",
    markdownTable(
      ["字段", "建议"],
      [
        ["部署模式", "【待确认】缺少日均数据量和节点容量，无法形成有效部署规模"],
        ["推荐方案", "【待确认】"],
        ["数据存储", "【待确认】"],
        ["Kafka缓存", "【待确认】"],
        ["容量校验", "【待确认】需要补充日均数据量、留存周期、单节点容量和节点数"],
      ],
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderLocalImplementationDraft(project: Project, workflow: DeliveryWorkflow) {
  const facts = factPackFromWorkflow(workflow);
  if (!factPackHasUsefulData(facts)) return "";
  const hardwareSummary = backfillWorkflowHandoff(workflow).hardware || "硬件评估缺失：日均数据量、留存周期和节点容量未确认，暂不能形成有效部署规模。";
  const wbsSummary = backfillWorkflowHandoff(workflow).wbs || "WBS计划缺失：请先生成WBS与实施计划。";
  return [
    "# 项目实施方案",
    "## 文档信息",
    markdownTable(
      ["字段", "值"],
      [
        ["项目名称", facts.projectName || project.name],
        ["客户名称", facts.clientName || project.client],
        ["文档版本", "V1.0"],
        ["文档日期", now().slice(0, 10)],
        ["编制角色", "项目经理/实施工程师"],
        ["适用范围", "日志管理平台实施、日志源接入、业务变更识别场景、培训与验收"],
      ],
    ),
    "## 修订记录",
    markdownTable(["版本", "日期", "修订说明", "修订人"], [["V1.0", now().slice(0, 10), "AI生成中心本地事实草稿", "项目经理"]]),
    "### 第一章 前言",
    `本文档面向${facts.clientName || project.client}的${facts.projectName || project.name}，用于说明日志管理平台实施范围、日志接入计划、场景交付方向、资源需求、实施计划和项目管理机制。方案内容以客户需求表SOW和前序AI中心评估草稿为依据，待确认项均以【待确认】标识。`,
    "### 第二章 日志易产品概述",
    "日志易平台用于统一采集、存储、检索和分析IT基础设施、网络安全设备、中间件、数据库和应用相关日志，支持审计合规、运维排障、告警通知和场景化分析。项目交付过程中将优先保证日志接入、查询检索、审计合规和客户可持续维护能力。",
    "### 第三章 项目背景及目标",
    facts.background || "【待确认】项目背景未明确。",
    facts.objective || "【待确认】项目目标未明确。",
    markdownTable(
      ["目标", "说明"],
      [
        ["合规审计", "满足等保合规层面的日志数据审计需求。"],
        ["统一日志管理", "集中收集IT设备日志，支持统一查询和快速定位。"],
        ["业务变更识别", facts.hasBusinessChangeScenario ? "基于堡垒机日志和业务系统中间件日志识别业务系统变更。" : "【待确认】"],
      ],
    ),
    "### 第四章 日志接入范围",
    markdownTable(["类别", "明细项", "数量合计"], facts.categoryTotals.map((item) => [item.category, String(item.itemCount), String(item.count)])),
    "\n日志源明细将按客户现场可达性和样例日志完整度分批接入。对 tomcat 200+ 等非精确数量，实施前需客户确认准确数量。",
    "### 第五章 建议交付场景方向",
    markdownTable(
      ["场景", "依据", "交付方式"],
      [
        ["日志审计合规", "SOW明确满足等保合规", "完成日志源接入、审计查询验证和留存策略确认"],
        ["统一查询与快速定位", "客户关注点明确", "配置基础检索、字段解析和常用查询视图"],
        ["业务系统变更识别", facts.scenarioDemand || "SOW场景需求", "基于堡垒机日志和中间件日志配置识别规则"],
      ],
    ),
    "### 第六章 告警配置重点场景",
    markdownTable(
      ["告警/通知", "触发依据", "通知方式", "备注"],
      [
        ["业务系统变更事件", "堡垒机日志、业务系统中间件日志", facts.hasEnterpriseWechatNotification ? "企业微信" : "【待确认】", "需客户确认通知群、接收人和频率"],
        ["日志接入异常", "采集链路中断或解析失败", "平台告警/企业微信【待确认】", "建议纳入运维监控"],
      ],
    ),
    "### 第七章 日志易系统架构",
    "系统架构建议包含采集层、传输/缓存层、存储检索层、分析规则层和展示/告警层。最终节点数量、存储容量、Kafka缓存和高可用策略必须以硬件资源评估为准。",
    "### 第八章 部署规模与资源需求",
    hardwareSummary,
    "### 第九章 实施计划",
    wbsSummary,
    "### 第十章 沟通管理计划与风险管理",
    markdownTable(
      ["机制", "建议"],
      [
        ["沟通机制", "建立项目微信群/会议机制，每周同步进度、风险和客户待办事项。"],
        ["变更管理", "新增日志源、追加业务日志或新增场景需形成变更记录并评估人天/排期影响。"],
        ["客户配合", "客户需协调设备负责人、网络策略、账号权限、样例日志和验收人员。"],
        ["风险管理", "重点关注日志源数量大、日均数据量缺失、License口径差异、深度培训范围和上线测试范围。"],
      ],
    ),
    "### 缺失参数清单与待确认问题",
    "- 日均数据量GB/TB、留存周期、峰值系数。\n- 硬件节点数量、单节点容量和高可用要求。\n- 22人天是否包含项目管理、上线测试和深度培训。\n- License 50 与日志源数量下限合计之间的商务/技术口径。\n- 业务日志是否在当前阶段追加接入。",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderLocalDeliveryDraft(kind: DeliveryDraftKind, project: Project, workflow: DeliveryWorkflow) {
  if (kind === "personDay") return renderLocalPersonDayDraft(project, workflow);
  if (kind === "hardware") return renderLocalHardwareMissingDraft(project, workflow);
  if (kind === "wbs") return renderLocalWbsDraft(project, workflow);
  if (kind === "implementation") return renderLocalImplementationDraft(project, workflow);
  return "";
}

function hardwareProjectType(workflow: DeliveryWorkflow) {
  const inputs = normalizedResourceInputs(workflow.resourceInputs);
  const sow = workflow.sow.content || "";
  if (inputs.includesUeba || flagFromSow(sow, ["UEBA", "ueba"])) return "ueba";
  if (inputs.includesSiem || flagFromSow(sow, ["SIEM", "siem"])) return "siem";
  return "log";
}

function skillLevel(dailyGb: number) {
  if (dailyGb <= 5) return "L1";
  if (dailyGb <= 10) return "L2";
  if (dailyGb <= 30) return "L3";
  if (dailyGb <= 50) return "L4";
  if (dailyGb <= 100) return "L5";
  if (dailyGb <= 200) return "L6";
  if (dailyGb <= 300) return "L7";
  if (dailyGb <= 500) return "L8";
  if (dailyGb <= 1000) return "L9";
  if (dailyGb <= 2000) return "L10";
  return "超大规模";
}

function skillMode(dailyGb: number) {
  if (dailyGb <= 30) return "单机/轻量集群";
  if (dailyGb < 500) return "集群混合部署";
  return "分离部署";
}

function formatCapacityTb(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 TB";
  if (value >= 1024) return `${(value / 1024).toFixed(value >= 10240 ? 1 : 2)} PB`;
  return `${value.toFixed(value >= 100 ? 0 : 2)} TB`;
}

function singleNodeCapacityTb(workflow: DeliveryWorkflow) {
  const inputs = normalizedResourceInputs(workflow.resourceInputs);
  const raw = resourceNumberFromText(inputs.singleNodeUsableTb);
  if (!raw) return RIZHIYI_SINGLE_NODE_RAID5_TB;
  return inputs.singleNodeCapacityUnit === "GB" ? raw / 1024 : raw;
}

function nodeCountFromWorkflow(workflow: DeliveryWorkflow) {
  const inputs = normalizedResourceInputs(workflow.resourceInputs);
  const raw = resourceNumberFromText(inputs.nodeCount);
  return raw ? Math.max(1, Math.round(raw)) : 0;
}

function storageDiskText(capacityTb: number, userProvided: boolean) {
  if (userProvided) return `按输入单节点磁盘容量校验：${formatCapacityTb(capacityTb)} / 节点`;
  return "12TB 数据盘 × 14（RAID5，可用约 156TB / 节点）";
}

function n1Text(storageNodes: number, dataTb: number, capacityTb: number, target: "min" | "rec" | "opt") {
  if (storageNodes <= 1) return "❌ 单机无 N-1";
  const n1Capacity = (storageNodes - 1) * capacityTb;
  if (n1Capacity >= dataTb) return target === "opt" ? `✅ 充裕（N-1 后 ${formatCapacityTb(n1Capacity)}）` : `✅ 安全（N-1 后 ${formatCapacityTb(n1Capacity)}）`;
  return `⚠️ 容量不足（N-1 后 ${formatCapacityTb(n1Capacity)}）`;
}

function ensureStorageNodes(plan: HardwarePlan, dataTb: number, capacityTb: number, requireN1: boolean): HardwarePlan {
  if (plan.storageNodes <= 1) return plan;
  const required = Math.max(3, Math.ceil(dataTb / capacityTb) + (requireN1 ? 1 : 0));
  if (required <= plan.storageNodes) return plan;
  return {
    ...plan,
    storageNodes: required,
    nodeConfig: plan.nodeConfig.replace(/\d+×计算存储/, `${required}×计算存储`).replace(/\d+台统一节点/, `${required}台统一节点`),
  };
}

function baseHardwarePlans(dailyGb: number): HardwarePlan[] {
  if (dailyGb <= 30) {
    return [
      { label: "最低", deployment: "单机模式", nodeConfig: "1×VM_16C_32GB", storageNodes: 1, systemDisk: RIZHIYI_SYSTEM_DISK, priceLevel: "低", advice: "测试、POC 或预算受限场景" },
      { label: "推荐⭐", deployment: "轻量集群", nodeConfig: "3台统一节点：3×VM_16C_32GB", storageNodes: 3, systemDisk: RIZHIYI_SYSTEM_DISK, priceLevel: "中", advice: "生产建议，具备基础高可用" },
      { label: "最优", deployment: "轻量高配集群", nodeConfig: "3台统一节点：3×PM_24C_64GB", storageNodes: 3, systemDisk: RIZHIYI_SYSTEM_DISK, priceLevel: "高", advice: "保留性能余量，适合后续扩容" },
    ];
  }
  if (dailyGb <= 100) {
    return [
      { label: "最低", deployment: "单机/集群可选", nodeConfig: "1×PM_24C_64GB", storageNodes: 1, systemDisk: RIZHIYI_SYSTEM_DISK, priceLevel: "低", advice: "预算受限或非关键生产" },
      { label: "推荐⭐", deployment: "集群混合部署", nodeConfig: "3台统一节点：3×PM_24C_64GB", storageNodes: 3, systemDisk: RIZHIYI_SYSTEM_DISK, priceLevel: "中", advice: "常规生产首选，性能/成本均衡" },
      { label: "最优", deployment: "集群混合部署", nodeConfig: "3台统一节点：3×PM_32C_128GB", storageNodes: 3, systemDisk: RIZHIYI_SYSTEM_DISK, priceLevel: "高", advice: "更高查询并发和缓存余量" },
    ];
  }
  if (dailyGb <= 200) {
    return [
      { label: "最低", deployment: "集群混合部署", nodeConfig: "3台统一节点：3×PM_24C_64GB", storageNodes: 3, systemDisk: RIZHIYI_SYSTEM_DISK, priceLevel: "低", advice: "成本优先，容量与峰值需关注" },
      { label: "推荐⭐", deployment: "集群混合部署", nodeConfig: "3台统一节点：3×PM_32C_128GB", storageNodes: 3, systemDisk: RIZHIYI_SYSTEM_DISK, priceLevel: "中", advice: "常规首选，N-1安全" },
      { label: "最优", deployment: "集群混合部署", nodeConfig: "3台统一节点：3×PM_64C_512GB", storageNodes: 3, systemDisk: RIZHIYI_SYSTEM_DISK, priceLevel: "高", advice: "高并发检索和较大增长空间" },
    ];
  }
  if (dailyGb <= 300) {
    return [
      { label: "最低", deployment: "集群混合部署", nodeConfig: "3台统一节点：3×PM_32C_128GB", storageNodes: 3, systemDisk: RIZHIYI_SYSTEM_DISK, priceLevel: "低", advice: "满足基础生产，后续可Scale-Up" },
      { label: "推荐⭐", deployment: "集群混合部署", nodeConfig: "3台统一节点：3×PM_32C_128GB", storageNodes: 3, systemDisk: RIZHIYI_SYSTEM_DISK, priceLevel: "中", advice: "该档位标准推荐" },
      { label: "最优", deployment: "集群混合部署", nodeConfig: "3台统一节点：3×PM_64C_512GB", storageNodes: 3, systemDisk: RIZHIYI_SYSTEM_DISK, priceLevel: "高", advice: "充裕余量与更强查询性能" },
    ];
  }
  if (dailyGb <= 500) {
    return [
      { label: "最低", deployment: "分离部署", nodeConfig: "3×资源协调 PM_24C_64GB；3×计算存储 PM_24C_64GB", storageNodes: 3, systemDisk: RIZHIYI_SYSTEM_DISK, priceLevel: "低", advice: "成本优先，适合初期预算受限" },
      { label: "推荐⭐", deployment: "分离部署", nodeConfig: "3×资源协调 PM_32C_64GB；3×计算存储 PM_32C_128GB", storageNodes: 3, systemDisk: RIZHIYI_SYSTEM_DISK, priceLevel: "中", advice: "500GB/日标准推荐方案" },
      { label: "最优", deployment: "分离部署", nodeConfig: "3×资源协调 PM_64C_256GB；3×计算存储 PM_64C_512GB", storageNodes: 3, systemDisk: RIZHIYI_SYSTEM_DISK, priceLevel: "高", advice: "预留更大峰值和查询并发" },
    ];
  }
  if (dailyGb <= 1000) {
    return [
      { label: "最低", deployment: "分离部署", nodeConfig: "3×资源协调 PM_32C_64GB；3×计算存储 PM_32C_128GB", storageNodes: 3, systemDisk: RIZHIYI_SYSTEM_DISK, priceLevel: "低", advice: "容量按约束自动补足节点" },
      { label: "推荐⭐", deployment: "分离部署", nodeConfig: "3×资源协调 PM_32C_128GB；3×计算存储 PM_32C_256GB", storageNodes: 3, systemDisk: RIZHIYI_SYSTEM_DISK, priceLevel: "中", advice: "1TB/日标准推荐，满足N-1" },
      { label: "最优", deployment: "分离部署", nodeConfig: "3×资源协调 PM_64C_256GB；3×计算存储 PM_64C_256GB", storageNodes: 3, systemDisk: RIZHIYI_SYSTEM_DISK, priceLevel: "高", advice: "性能与扩展性更优" },
    ];
  }
  return [
    { label: "最低", deployment: "分离部署", nodeConfig: "3×资源协调 PM_32C_256GB；3×计算存储 PM_32C_256GB", storageNodes: 3, systemDisk: RIZHIYI_SYSTEM_DISK, priceLevel: "低", advice: "按容量约束补足计算存储节点" },
    { label: "推荐⭐", deployment: "分离部署", nodeConfig: "3×资源协调 PM_64C_512GB；3×计算存储 PM_32C_512GB", storageNodes: 3, systemDisk: RIZHIYI_SYSTEM_DISK, priceLevel: "中", advice: "大规模日志平台常规推荐" },
    { label: "最优", deployment: "分离部署", nodeConfig: "3×资源协调 PM_64C_512GB；3×计算存储 PM_64C_512GB", storageNodes: 3, systemDisk: RIZHIYI_SYSTEM_DISK, priceLevel: "高", advice: "高可用、高性能与增长余量优先" },
  ];
}

function renderHardwareSkillDraft(project: Project, workflow: DeliveryWorkflow) {
  const dailyGb = dailyGbFromWorkflow(workflow);
  if (!dailyGb) return "";
  const retentionDays = retentionDaysFromWorkflow(workflow);
  const inputs = normalizedResourceInputs(workflow.resourceInputs);
  const peakFactor = resourceNumberFromText(inputs.peakFactor) || 1;
  const projectType = hardwareProjectType(workflow);
  const platformName = projectType === "siem" ? "SIEM 安全平台" : projectType === "ueba" ? "UEBA 用户行为分析平台" : "日志平台";
  const dataTb = (dailyGb * 1.5 * 2 * retentionDays * 1.2) / 1024;
  const kafkaTb = ((dailyGb / 24) * peakFactor * 4.5 * 2 * 6 * 1.2 * (projectType === "log" ? 1 : 1.5)) / 1024;
  const totalTb = dataTb + kafkaTb;
  const eps = dailyGb * 50;
  const level = skillLevel(dailyGb);
  const capacityTb = singleNodeCapacityTb(workflow);
  const userDiskProvided = Boolean(resourceNumberFromText(inputs.singleNodeUsableTb));
  const explicitNodeCount = nodeCountFromWorkflow(workflow);
  const explicitTotalCapacity = explicitNodeCount ? explicitNodeCount * capacityTb : 0;
  const explicitN1Capacity = explicitNodeCount > 1 ? (explicitNodeCount - 1) * capacityTb : 0;
  const explicitCapacityStatus = !explicitNodeCount
    ? "未输入节点数，按三档推荐方案校验。"
    : explicitN1Capacity >= dataTb
      ? `通过：N-1 后 ${formatCapacityTb(explicitN1Capacity)} 覆盖数据存储需求。`
      : `不足：N-1 后 ${formatCapacityTb(explicitN1Capacity)}，低于数据存储需求 ${formatCapacityTb(dataTb)}。`;
  const plans = baseHardwarePlans(dailyGb).map((plan) => ensureStorageNodes(plan, dataTb, capacityTb, plan.label !== "最低"));
  const dataDisk = storageDiskText(capacityTb, userDiskProvided);
  const planRows = plans
    .map(
      (plan, index) =>
        `| ${plan.label} | ${plan.deployment} | ${plan.nodeConfig} | ${plan.systemDisk} | ${dataDisk} | ${formatCapacityTb(dataTb / Math.max(plan.storageNodes, 1))} | ${formatCapacityTb(plan.storageNodes * capacityTb)} | ${n1Text(plan.storageNodes, dataTb, capacityTb, index === 0 ? "min" : index === 1 ? "rec" : "opt")} | ${plan.priceLevel} | ${plan.advice} |`,
    )
    .join("\n");
  return `## 📊 ${platformName}硬件资源评估

**日均 ${dailyGb.toLocaleString("zh-CN")} GB，保留 ${retentionDays} 天（${level}）→ 推荐 ${plans[1].nodeConfig}。**

### 存储容量估算
| 项目 | 数值 |
|:---|:---|
| 项目名称 | ${identityForWorkflow(project, workflow).projectName} |
| 每日新增 | ${dailyGb.toLocaleString("zh-CN")} GB/天 |
| 保留天数 | ${retentionDays} 天 |
| 估算 EPS | ${Math.round(eps).toLocaleString("zh-CN")} |
| 峰值系数 | ${peakFactor}x |
| 数据存储 | ${formatCapacityTb(dataTb)} |
| Kafka 缓存 | ${formatCapacityTb(kafkaTb)}${projectType === "log" ? "" : "（SIEM/UEBA 已按 +50%）"} |
| 合计容量 | ${formatCapacityTb(totalTb)} |
| 当前输入节点数 | ${explicitNodeCount ? `${explicitNodeCount} 台` : "未输入"} |
| 当前输入总容量 | ${explicitNodeCount ? formatCapacityTb(explicitTotalCapacity) : "未输入"} |
| 当前输入 N-1 容量 | ${explicitNodeCount > 1 ? formatCapacityTb(explicitN1Capacity) : explicitNodeCount === 1 ? "单机无 N-1" : "未输入"} |
| 当前输入容量校验 | ${explicitCapacityStatus} |

### 三档方案对比
| 方案 | 部署方式 | 单节点配置 | 系统盘 | 数据盘 | 单节点存储 | 集群总存储 | N-1容灾 | 预估价格等级 | 适用建议 |
|:---|:---|:---|:---|:---|---:|---:|:---|:---:|:---|
${planRows}

### SIEM/UEBA补充
${projectType === "log" ? "- 当前按日志平台评估；SOW 未明确包含 SIEM/UEBA 时，不额外加入 Flink 资源。" : `- 当前按 ${platformName} 评估：Kafka 缓存已按 +50% 计算；Flink 建议${dailyGb < 1000 ? "混合部署，3节点起步并预留 25% CPU" : "独立部署，按 3-5 台 Flink 节点规划"}。`}

### 存储建议
- 单节点磁盘容量校验基准：${dataDisk}。
- 推荐/最优方案需满足任意 1 台计算存储节点故障后，剩余节点容量仍覆盖数据存储需求。
- 数据存储按需配置，优先保证单节点盘位上限、RAID 可用容量和 N-1 后容量。

### 实施方案第8章结构化摘要
| 字段 | 建议 |
|:---|:---|
| 部署模式 | ${skillMode(dailyGb)} |
| 推荐方案 | ${plans[1].nodeConfig} |
| 数据存储 | ${formatCapacityTb(dataTb)} |
| Kafka 缓存 | ${formatCapacityTb(kafkaTb)} |
| 容量校验 | ${n1Text(plans[1].storageNodes, dataTb, capacityTb, "rec")} |
`;
}

export function canRunHardwareSkillKernel(workflow: DeliveryWorkflow) {
  return dailyGbFromWorkflow(workflow) > 0;
}

function buildGatewaySafeContext(project: Project, workflow: DeliveryWorkflow, kind?: DeliveryDraftKind) {
  const sow = workflow.sow.content || "";
  const handoff = backfillWorkflowHandoff(workflow);
  const identity = identityForWorkflow(project, workflow);
  const supplement = kind ? supplementFor(kind, workflow) : "";
  const sowScaleFacts =
    kind === "hardware"
      ? [
          `dailyGbCandidates=${numbersNear(sow, ["GB", "gb", "日均", "每日", "每天", "接入量", "数据量"]).join(",") || "unknown"}`,
          `retentionDayCandidates=${numbersNear(sow, ["天", "day", "days", "保留", "留存"]).join(",") || "unknown"}`,
        ]
      : [
          `agentCountCandidates=${numbersNear(sow, ["agent", "Agent", "AGENT", "探针", "代理", "终端", "主机", "服务器"]).join(",") || "unknown"}`,
          `syslogCountCandidates=${numbersNear(sow, ["syslog", "Syslog", "SYSLOG", "日志源"]).join(",") || "unknown"}`,
          `dailyGbCandidates=${numbersNear(sow, ["GB", "gb", "日均", "每日", "每天", "接入量", "数据量"]).join(",") || "unknown"}`,
          `retentionDayCandidates=${numbersNear(sow, ["天", "day", "days", "保留", "留存"]).join(",") || "unknown"}`,
        ];
  const facts = [
    "Project facts extracted locally from SOW and page inputs. Use these values directly in the visible draft. Non-unknown explicit page inputs override SOW candidates for the same or related fields.",
    `项目名称=${identity.projectName}`,
    `客户=${identity.clientName}`,
    `识别依据=${identity.identitySource}`,
    `生成日期=${now().slice(0, 10)}`,
    `SOW文件=${workflow.sow.fileName || "未导入文件"}`,
    `sowChars=${sow.length}`,
    `sowHandoffChars=${handoff.sow.length}`,
    `personDayHandoffChars=${handoff.personDay.length}`,
    `hardwareHandoffChars=${handoff.hardware.length}`,
    `wbsHandoffChars=${handoff.wbs.length}`,
    `currentStepSupplementChars=${supplement.length}`,
    ...resourceInputFactLines(workflow.resourceInputs, kind),
    ...sowScaleFacts,
    `hasUat=${flagFromSow(sow, ["UAT", "uat", "上线测试", "用户验收测试"])}`,
    `hasProjectManagement=${flagFromSow(sow, ["项目管理", "PM", "pm", "project management"])}`,
    `hasSiem=${flagFromSow(sow, ["SIEM", "siem"])}`,
    `hasUeba=${flagFromSow(sow, ["UEBA", "ueba"])}`,
    `hasFlink=${flagFromSow(sow, ["Flink", "flink"])}`,
    `hasDashboard=${flagFromSow(sow, ["大屏", "dashboard"])}`,
    `hasCustomDevelopment=${flagFromSow(sow, ["定制开发", "二开", "custom development"])}`,
    `hasStateGridOrMilitary=${flagFromSow(sow, ["国网", "军工", "涉密", "state grid", "military"])}`,
    `hasDataMigration=${flagFromSow(sow, ["迁移", "导入", "migration"])}`,
    `hasTraining=${flagFromSow(sow, ["培训", "training"])}`,
    ...compactDraftFacts("personDayDraft", handoff.personDay || workflow.personDayAssessment.content),
    ...compactDraftFacts("hardwareDraft", handoff.hardware || workflow.hardwareAssessment.content),
    ...compactDraftFacts("wbsDraft", handoff.wbs || workflow.wbsPlan.content),
  ];
  return facts.join("\n");
}

function buildGatewaySafePrompt(kind: DeliveryDraftKind, project: Project, workflow: DeliveryWorkflow) {
  const facts = buildGatewaySafeContext(project, workflow, kind);
  const handoff = backfillWorkflowHandoff(workflow);
  const supplement = supplementFor(kind, workflow);
  const sowSourceContent = [workflow.sow.content, handoff.sow ? `\n\n### SOW已确认传递给人天&资源评估的信息\n${handoff.sow}` : ""]
    .filter(Boolean)
    .join("\n");
  const personDaySource = handoff.personDay || workflow.personDayAssessment.content;
  const hardwareSource = handoff.hardware || workflow.hardwareAssessment.content;
  const wbsSource = handoff.wbs || workflow.wbsPlan.content;
  const sowSource = compactContextBlock("SOW标准输入源", sowSourceContent, sowContextLimit(kind), "未提供SOW正文。");
  const personDayDraft = compactContextBlock(
    handoff.personDay ? "人天评估传递摘要" : "人天评估草稿",
    personDaySource,
    draftContextLimit(kind, "personDay"),
    "未生成人天评估。",
  );
  const hardwareDraft = compactContextBlock(
    handoff.hardware ? "硬件资源评估传递摘要" : "硬件资源评估草稿",
    hardwareSource,
    draftContextLimit(kind, "hardware"),
    "未生成硬件资源评估。",
  );
  const wbsDraft = compactContextBlock(
    handoff.wbs ? "WBS与实施计划传递摘要" : "WBS与实施计划草稿",
    wbsSource,
    draftContextLimit(kind, "wbs"),
    "未生成WBS与实施计划。",
  );
  const common = `${facts}

Global output requirements:
- Output MUST be Simplified Chinese (zh-CN), not Japanese.
- Use Markdown headings and tables.
- Visible output MUST use the Chinese values after 项目名称, 客户, and SOW文件. Never output any token containing "_non_ascii_" or any internal container field.
- Do not invent project facts, quantities, dates, totals, roles, scope, acceptance criteria, scenarios, or deliverables.
- If a required fact is unknown, mark it as pending confirmation in Chinese and explain which exact input is missing.
- Explicit page inputs have the highest priority for the same or related fields. If explicitFixedPersonDays, explicitAnalysisAppCount, explicitAnalysisBusinessSystemCount, explicitAgentCount, explicitSyslogCount, explicitDailyDataVolume, or explicitRetentionDays is not unknown/not_applicable, use it instead of values inferred from the SOW summary.
- If 当前步骤用户补充信息 is provided, treat it as explicit user input for this generation step. It can correct ambiguous or missing SOW/upstream facts; if it conflicts with a clearly stated source, keep both in the pending-confirmation list and explain the conflict.
- For SIEM, UEBA, Flink, dashboard, custom development, and data migration: if the facts do not explicitly indicate presence, treat them as not included in current scope instead of pending confirmation.
- Never output a complete total, schedule, WBS execution flow, or implementation chapter based on fake or guessed data.
- For project-eval, skill-export, and project-implementation-program, local fallback and template-only estimation are disabled in this application. Missing prerequisites must produce a missing-parameter list, not a guessed result.
- Keep the result concise enough for project manager review, but include formulas, source basis, and calculation assumptions.
- Do not repeat full upstream drafts. Reuse upstream conclusions and structured summaries, then generate only the current step's necessary draft.
- Completeness has priority over brevity for WBS and implementation program drafts. Do not omit required chapters, tables, acceptance assumptions, schedule basis, or deployment basis merely to shorten the answer.

SOW标准输入源：
${sowSource}${supplementPromptBlock("当前步骤用户补充信息", supplement)}`;

  if (kind === "personDay") {
    return `${common}

Task: Generate a project-eval person-day estimate draft. Do not generate hardware resource sizing.

project-eval标准流程：
1. 先判断输入模式：SOW文件/标准输入源模式或对话补参模式。
2. 提取或收集：项目类型、Agent数量、Syslog数量、分析APP套数、分析业务系统套数、特殊数据接入数量、分析服务简单/深度/复杂套数、大屏数量及定制与否、定制开发数量及类型、SIEM各项数量、观察易场景范围。页面显式填写的分析APP套数、分析业务系统套数优先于SOW标准输入源。
3. 基础服务小计只包含：基础交付、数据接入、数据分析、大屏、SIEM、观察易、定制开发、定制实施验证。
4. 国网/军工、上线测试、项目管理是三项门禁，未确认前不得进入完整合计。
5. PM 未确认前不得计入总计，必须原文输出确认话术：请问项目管理工时（进度汇报、跨部门沟通、需求协调等）是否已包含？如果没有，请确认项目管理流程复杂度：流程规范/配合度高按10%，流程较复杂/需多方协调按20%，流程复杂/配合度不高按30%。
6. 缺少 Agent/Syslog/分析APP套数/分析业务系统套数/分析服务等核心数量时，不能编造数量，输出“缺失参数清单”和“待确认问题”，不要输出伪精确完整合计。
7. 可选项未提及时按0处理并写明“不在当前SOW范围”；不能写“待确认”。
8. 必须展示包计费公式，例如 Agent=ceil(N/250)×5、Syslog=ceil(N/50)×5。
9. 如SOW已有工时预估，必须并列展示“SOW原估 / 规则估算 / 差异说明”，不得覆盖。
10. 每次都必须输出传统估算与 PERT 三点估算；PERT需说明是否包含上线测试、PM、国网/军工加成。
11. 当前页面不会进行多轮追问；缺少完整评估最低条件时，必须输出缺失参数清单和待确认问题，不能输出完整合计或把待确认项按默认值补齐。

输出结构：
## 人天评估结果（初步，不含未确认加成）或 ## 人天评估结果
### 一、输入来源与评估条件
### 二、基础服务明细
### 三、基础服务小计
### 四、未确认加成 或 加成与管理
### 五、传统估算合计
### 六、PERT三点估算
### 七、SOW原估对比
### 八、缺失参数清单与待确认问题
### 九、传递给WBS/实施计划的结构化摘要`;
  }

  if (kind === "hardware") {
    return `${common}

Task: Generate a hardware resource assessment draft. Do not output person-day estimation.

Rules:
1. Extract or use explicit page inputs: daily data volume with unit, retention days, peak factor, single-node disk capacity with unit, node count, project type, Flink need, SIEM, UEBA, and data migration. If SIEM/UEBA/Flink/data migration are not explicitly present, mark them as not included.
2. Convert daily data volume to dailyGB first. If the unit is TB, dailyGB=dailyTB*1024.
3. Data storage TB = dailyGB*1.5*2*retentionDays*1.2/1024.
4. Kafka cache TB = (dailyGB/24)*peakFactor*4.5*2*6*1.2/1024; multiply by 1.5 for SIEM/UEBA.
5. Convert single-node disk capacity to TB first. If the unit is GB, singleNodeCapacityTb=singleNodeGB/1024. Use singleNodeCapacityTb and node count to check total disk capacity, N-1 capacity, and whether the calculated storage fits.
6. Output one-sentence conclusion, storage estimate, SIEM/UEBA notes, and N-1 check.
7. Explicit page inputs override ambiguous SOW extraction. Retention days defaults to 180 and peak factor defaults to 1 if no stronger evidence is present.
8. If Flink, SIEM, UEBA, or data migration is enabled by explicit inputs, include the impact on compute/storage/network/resource preparation.
9. MUST include a dedicated section titled "三档方案对比". In this section, output a Markdown table with exactly three option rows: 最低, 推荐, 最优. The table columns MUST include: 方案, 部署方式, 单节点配置, 系统盘, 数据盘, 单节点存储, 集群总存储, N-1容灾, 预估价格等级, 适用建议. Mark 推荐 with a star in the 方案 cell.
10. End with a structured summary for implementation program chapter 8.`;
  }

  if (kind === "wbs") {
    return `${common}

Task: Generate WBS decomposition and implementation schedule draft. Do not generate implementation program prose.

前序 project-eval 人天评估草稿：
${personDayDraft}

前序 rizhiyi-hardware-assessment 硬件评估草稿：
${hardwareDraft}

skill-export标准流程：
1. 必须承接人天评估，不得自己编造总工期；缺少总人天/总人月时，只输出“无法生成正式排期”的缺失参数清单和可生成的WBS骨架。
2. 1人月=22个工作日；按工作日计算，排除周末和中国法定节假日。
3. 标准阶段为7个：项目启动、需求调研、数据接入与部署、场景规则交付、成果汇报与培训、上线试运行、项目验收。不要单独生成“数据迁移”阶段；涉及迁移、导入、接入、部署的任务归入“数据接入与部署”。
4. 试运行任务必须来自SOW正文或人天评估结果；人天评估参数区不再提供试运行开关，没有明确包含试运行时不得添加试运行任务。
5. 详细计划表必须严格15列且顺序不能错位：编号、类型、任务、里程碑（是/否）、计划开始、计划结束、工期、状态、进度、责任人、执行者、前置任务、输出成果、延迟天数、备注。后续“确认并生成项目执行流”只识别这张15列表，不能只输出WBS骨架。
6. 里程碑列中里程碑任务必须写“里程碑”，非里程碑留空。
7. 责任人只使用“项目经理”和“实施工程师”，除非SOW或人天评估明确给出其他角色。
8. 编号规则：主任务必须使用 x.0 编号（1.0、2.0、3.0...），子任务从 x.1 开始；不要生成只有整数编号的阶段行。阶段只写入阶段/归属字段，不作为任务标题。
9. 待确认项、缺失参数、假设约束只能放在“缺失参数清单与待确认问题”章节，严禁放入 WBS任务清单或详细计划表。
10. “成果汇报与培训”阶段只生成主任务“项目成果汇报与培训”和子任务“项目成果汇报与基础操作培训”；只有 SOW 明确要求深度培训时，才增加“采集规则与分析规则专项培训”，不要生成“成果汇报与深度培训”这种合并任务。
11. 输出必须直接展示：WBS任务清单、详细计划表、文本甘特图时间轴、里程碑节点列表、传递给实施方案的计划摘要。
12. 如果缺少入场日期，可以用当前日期作为“计划生成默认起点”但必须在假设中标注；如果缺少总人天，日期列写“待确认”，不要编造日期。

输出结构：
## WBS分解与实施计划表
### 一、输入来源与生成条件
### 二、WBS任务清单
### 三、详细计划表
### 四、文本甘特图时间轴
### 五、里程碑节点列表
### 六、缺失参数清单与待确认问题
### 七、传递给实施方案的计划摘要`;
  }

  return `${common}

Task: Generate a customer-reviewable project implementation program. It must read like a deliverable document, not loose notes or an internal draft.

前序 project-eval 人天评估草稿：
${personDayDraft}

前序 rizhiyi-hardware-assessment 硬件评估草稿：
${hardwareDraft}

前序 skill-export WBS与实施计划草稿：
${wbsDraft}

project-implementation-program交付稿要求：
1. 输出客户可评审的实施方案正文，不要称为“草稿”，不要写内部提示、生成说明、模型说明或“以下是”。
2. 开头必须包含文档标题、文档信息表和修订记录表。文档信息表至少包含：项目名称、客户名称、文档版本、文档日期、编制角色、适用范围；未知项用“【待确认】”，文档日期使用生成日期。
3. 正文保持10章：前言、日志易产品概述、项目背景及目标、日志接入范围、建议交付场景方向、告警配置重点场景、日志易系统架构、部署规模与资源需求、实施计划、沟通管理计划与风险管理。
4. 每章必须是客户可读叙述，不得只有清单标题；关键表格必须包含：实施范围表、日志接入范围表、场景/告警配置建议表、部署资源表、实施计划里程碑表、角色职责表、交付物与验收标准表、风险与应对表。
5. SOW忠实性最高优先级：方案中的项目背景、建设目标、场景、交付范围、数量、日期和验收标准都必须能追溯到SOW或前序评估/计划。不得把模板示例写成本期范围。
6. SOW未提及 UEBA/SIEM/观察易/大屏/定制开发时，不得作为本期目标；若仅提“后期规划”，必须标注“不在本期交付范围”。
7. 第八章只能引用硬件评估结论；没有硬件评估时，第八章输出“缺失硬件评估，无法形成有效部署规模”，不得查表编造。
8. 第九章只能引用人天评估和 skill-export WBS/计划；没有前序计划时，第九章输出缺失项，不得编造排期。
9. 第十章必须包含项目沟通机制、会议机制、变更管理、风险管理、客户配合事项和验收推进机制。
10. 所有待确认项用“【待确认】”标识，并集中到“缺失参数清单与待确认问题”；不要因为存在待确认项就降低其余章节完整性。
11. 只输出可编辑Markdown，不生成Word/Excel文件，不输出下载链接。

输出结构：
# 项目实施方案
## 文档信息
## 修订记录
### 第一章 前言
### 第二章 日志易产品概述
### 第三章 项目背景及目标
### 第四章 日志接入范围
### 第五章 建议交付场景方向
### 第六章 告警配置重点场景
### 第七章 日志易系统架构
### 第八章 部署规模与资源需求
### 第九章 实施计划
### 第十章 沟通管理计划与风险管理
### 缺失参数清单与待确认问题`;
}

function buildPrompt(kind: DeliveryDraftKind, project: Project, workflow: DeliveryWorkflow) {
  const shared = sharedContext(project, workflow);

  if (kind === "personDay") {
    return `${shared}

请严格按 project-eval 技能生成人天评估草稿。不要输出硬件资源方案。

规则要求：
1. 先解析SOW关键信息：项目类型、Agent数量、Syslog数量、分析APP套数、分析业务系统套数、特殊数据接入、分析服务复杂度、大屏、SIEM、观察易、定制开发、上线测试、项目管理、是否国网/军工。页面显式填写的分析APP套数、分析业务系统套数优先于SOW标准输入源。
2. 基础服务小计只包含：基础交付、数据接入、数据分析、大屏、SIEM、观察易、定制开发、定制实施验证；不得把国网/军工、上线测试、项目管理计入基础服务小计。
3. 三项加成必须逐项确认：是否国网/军工、上线测试类型、项目管理是否已包含及复杂度。未确认时只能输出“初步评估（不含未确认加成）”。
4. 包计费必须展示ceil计算过程，例如 Agent=ceil(N/250)×5，Syslog=ceil(N/50)×5。
5. 如果SOW已有工时预估，必须并列表达SOW原估、规则估算和差异说明，不得直接覆盖。
6. 每次都必须输出传统估算和PERT三点估算，PERT需说明口径。
7. 最后输出“传递给WBS/实施计划的结构化摘要”，包含总人天口径、阶段工时建议、待确认项。`;
  }

  if (kind === "hardware") {
    return `${shared}

请严格按 rizhiyi-hardware-assessment 技能生成硬件资源评估草稿。不要输出人天评估。

规则要求：
1. 从SOW或页面参数提取：日均数据量及单位、保留天数、峰值系数、单节点磁盘容量及单位、节点数、项目类型(log/siem/ueba)、是否需要Flink。
2. 先统一换算日均GB；如果单位为TB，则日均GB=日均TB×1024。
3. 按公式输出数据存储(TB)=日均GB×1.5×2×保留天数×1.2÷1024。
4. 按公式输出Kafka缓存(TB)=(日均GB/24)×峰值系数×4.5×2×6小时×1.2÷1024；SIEM/UEBA时Kafka缓存×1.5。
5. 输出一句话结论、存储容量估算、SIEM/UEBA补充、N-1校验。
6. 必须先把单节点磁盘容量换算成TB，再基于节点数校验总磁盘容量、N-1容量和是否满足测算存储；不确定项标为“待确认”。
7. 必须包含“### 三档方案对比”章节，并输出 Markdown 表格；表格必须有且只有三行方案：最低、推荐⭐、最优；表头必须包含：方案、部署方式、单节点配置、系统盘、数据盘、单节点存储、集群总存储、N-1容灾、预估价格等级、适用建议。
8. 最后输出“传递给实施方案第八章的结构化摘要”。`;
  }

  if (kind === "wbs") {
    return `${shared}

project-eval 人天评估草稿（可能经过人工修改）：
${workflow.personDayAssessment.content || "未生成人天评估。"}

rizhiyi-hardware-assessment 硬件资源评估草稿（可能经过人工修改）：
${workflow.hardwareAssessment.content || "未生成硬件资源评估。"}

请严格按 skill-export 生成WBS分解与实施计划表草稿。不要生成实施方案正文。

规则要求：
1. 输出可人工修改的WBS任务清单、详细计划表、文本甘特图时间轴、里程碑列表。
2. 计划表列结构必须包含：编号、类型、任务、里程碑（是/否）、计划开始、计划结束、工期、状态、进度、责任人、执行者、前置任务、输出成果、延迟天数、备注。
3. 里程碑列中里程碑任务标注为“里程碑”，非里程碑留空。
4. 按工作日推算工期，1人月=22个工作日；如SOW或人天评估缺少总工期，必须标注“待确认”。
5. 项目阶段采用：项目启动、需求调研、数据接入与部署、场景规则交付、成果汇报与培训、上线试运行、项目验收。不要单独生成“数据迁移”阶段；涉及迁移、导入、接入、部署的任务归入“数据接入与部署”。
6. 编号规则：主任务必须使用 x.0 编号（1.0、2.0、3.0...），子任务从 x.1 开始；不要生成只有整数编号的阶段行。阶段只写入阶段/归属字段，不作为任务标题。
7. 待确认项、缺失参数、假设约束只能放在独立章节，不能作为任务写入 WBS 表或计划表。
8. “成果汇报与培训”阶段不要生成“成果汇报与深度培训”合并任务；深度培训只有输入明确要求时才作为专项培训子任务。
9. WBS和计划必须承接人天评估结论，硬件资源评估用于安排资源准备和部署规模确认，不要把硬件缺失参数转成项目任务。
10. 输出最后必须给出“传递给实施方案的计划摘要”。`;
  }

  return `${shared}

project-eval 人天评估草稿（可能经过人工修改）：
${workflow.personDayAssessment.content || "未生成人天评估。"}

rizhiyi-hardware-assessment 硬件资源评估草稿（可能经过人工修改）：
${workflow.hardwareAssessment.content || "未生成硬件资源评估。"}

skill-export WBS与实施计划草稿（可能经过人工修改）：
${workflow.wbsPlan.content || "未生成WBS与实施计划。"}

请严格按 project-implementation-program 技能生成项目实施方案Markdown草稿。

规则要求：
1. 输出10章结构：前言、产品概述、项目背景及目标、日志接入范围、建议交付场景方向、告警配置重点场景、系统架构、部署规模与资源需求、实施计划、沟通与风险管理。
2. 必须遵守SOW忠实性规则：SOW未提及UEBA/SIEM/观察易时不得写成本期目标；后期规划必须标注“不在本期交付范围”。
3. 第八章引用硬件资源评估结论，第九章引用人天评估和skill-export计划结论。
4. 所有待确认项用“【待确认】”标识。
5. 输出为可编辑Markdown草稿，不生成正式文件。`;
}

export async function generateDeliveryDraft(
  kind: DeliveryDraftKind,
  project: Project,
  workflow: DeliveryWorkflow,
  config?: AiModelConfig,
  options: { onDelta?: ModelStreamDeltaHandler } = {},
) {
  if (kind === "hardware") {
    const skillDraft = renderHardwareSkillDraft(project, workflow);
    if (skillDraft) {
      console.info("[硬件评估] 使用 rizhiyi-hardware-assessment 本地技能内核", {
        dailyGb: dailyGbFromWorkflow(workflow),
        retentionDays: retentionDaysFromWorkflow(workflow),
        projectType: hardwareProjectType(workflow),
      });
      return {
        content: cleanInternalPlaceholders(skillDraft, project, workflow),
        model: "rizhiyi-hardware-assessment / skill-kernel",
      };
    }
  }

  const localDraft = renderLocalDeliveryDraft(kind, project, workflow);
  if (!config && localDraft) {
    console.info("[AI生成] 未配置模型，已使用本地确定性草稿生成", {
      kind,
      outputChars: localDraft.length,
    });
    return {
      content: cleanInternalPlaceholders(localDraft, project, workflow),
      model: `local-${kind}-draft-kernel`,
    };
  }

  const modelName = config?.model || "未配置模型";
  try {
    if (!config) {
      throw new Error("未配置默认模型，且当前草稿无法仅靠本地技能内核生成。");
    }
    const messages: Parameters<typeof callConfiguredModel>[1] = [
      { role: "system", content: workflowSystemPrompt() },
      { role: "user", content: buildGatewaySafePrompt(kind, project, workflow) },
    ];
    const callOptions = {
      requireProjectDataConsent: true,
      maxTokens: kind === "personDay" ? 5200 : kind === "wbs" ? 6200 : kind === "implementation" ? 7800 : 3200,
      timeoutMs: 300_000,
    };
    const content = options.onDelta
      ? await callConfiguredModelStreaming(config, messages, callOptions, options.onDelta)
      : await callConfiguredModel(config, messages, callOptions);
    return { content: cleanInternalPlaceholders(content, project, workflow), model: modelName };
  } catch (error) {
    if (localDraft) {
      console.warn("[AI生成] 远程生成失败，已使用本地确定性草稿兜底", {
        kind,
        model: modelName,
        error: error instanceof Error ? error.message : error,
        outputChars: localDraft.length,
      });
      return {
        content: cleanInternalPlaceholders(localDraft, project, workflow),
        model: `local-${kind}-draft-kernel`,
      };
    }
    console.error("[AI生成] 远程生成失败，已停止生成，避免输出无效草稿", {
      kind,
      model: modelName,
      error: error instanceof Error ? error.message : error,
    });
    throw error;
  }
}

export function draftKeyFor(kind: DeliveryDraftKind): DeliveryDraftKey {
  if (kind === "personDay") return "personDayAssessment";
  if (kind === "hardware") return "hardwareAssessment";
  if (kind === "wbs") return "wbsPlan";
  return "implementationPlan";
}

export function updateDraft(workflow: DeliveryWorkflow, key: DeliveryDraftKey, content: string, model: string): DeliveryWorkflow {
  const nextFlow =
    key === "wbsPlan"
      ? {
          ...workflow.projectFlow,
          status: "draft_ready" as const,
          sourceDraftAt: now(),
        }
      : workflow.projectFlow;
  const nextHandoff = normalizeHandoffContent(workflow.handoff);
  const extractedHandoff =
    key === "personDayAssessment"
      ? extractPersonDayHandoffContent(content)
      : key === "hardwareAssessment"
        ? extractHardwareHandoffContent(content)
        : key === "wbsPlan"
          ? extractWbsHandoffContent(content)
          : "";
  if (key === "personDayAssessment" && extractedHandoff) nextHandoff.personDay = extractedHandoff;
  if (key === "hardwareAssessment" && extractedHandoff) nextHandoff.hardware = extractedHandoff;
  if (key === "wbsPlan" && extractedHandoff) nextHandoff.wbs = extractedHandoff;
  return {
    ...workflow,
    projectFlow: nextFlow,
    handoff: nextHandoff,
    [key]: {
      content,
      generatedAt: now(),
      model,
      status: "draft",
    },
  };
}
