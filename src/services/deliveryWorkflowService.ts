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
} from "../types";
import { normalizeTaskStage, stageDefinitionsForProject } from "./contextBuilder";
import { callConfiguredModel, callConfiguredModelStreaming, type ModelStreamDeltaHandler } from "./modelGateway";

export type DeliveryDraftKind = "personDay" | "hardware" | "wbs" | "implementation";
export type DeliveryDraftKey = "personDayAssessment" | "hardwareAssessment" | "wbsPlan" | "implementationPlan";

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

function normalizeHandoffContent(handoff?: Partial<WorkflowHandoffContent>): WorkflowHandoffContent {
  return {
    ...emptyHandoff(),
    ...(handoff || {}),
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
  const baseWorkflow = {
    ...emptyWorkflow(projectId),
    ...workflow,
    resourceInputs: {
      ...emptyResourceInputs(),
      ...(workflow.resourceInputs || {}),
    },
    handoff: normalizedHandoff,
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

  return dedupePlanItems(items);
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
  const nextMilestone = planItems.find((item) => item.milestone)?.title || "";

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

function workflowSystemPrompt() {
  return `You are a senior software implementation project manager, delivery lead, and solution architect. Use only the structured project facts provided by the user. Do not invent facts that are not present. Output MUST be Simplified Chinese (zh-CN). Do not output Japanese. Do not output English except product names, formulas, and field codes. Return editable Markdown content only, without code fences.`;
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
      .map((cell) => cell.trim())
      .filter(Boolean);
    for (let index = 0; index < cells.length; index += 1) {
      if (isLabelCell(cells[index])) {
        const next = cells[index + 1];
        if (next && !isLabelCell(next) && next !== "待确认") return next;
      }
    }

    const match = line.match(new RegExp(`(?:${labels.join("|")})\\s*[:：]\\s*([^|\\t，,；;]+)`));
    if (match?.[1]) return match[1].trim();
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

function buildSowNormalizationPrompt(project: Project, fileName: string, rawContent: string) {
  const identity = inferSowIdentity(fileName, rawContent);
  return `请把下面的 SOW 文件正文解析为“可继续传入人天&资源评估、WBS、实施方案生成”的标准化 Markdown 输入源。

重要：当前页面选中的项目只是承载这个 SOW 的容器，不代表 SOW 事实。项目名称、客户名称必须优先从 SOW 正文和文件名识别，禁止沿用当前页面项目名称或客户名称。
当前页面项目（仅供定位，不得作为输出事实）：${project.name} / ${project.client}
从 SOW 推断的项目名称：${identity.projectName}
从 SOW 推断的客户名称：${identity.clientName}
识别依据：${identity.source}
文件名：${fileName || "手工粘贴"}

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

function replaceStructuredSummaryRows(content: string, values: Record<string, string>) {
  const index = content.search(/^#{1,4}\s*传递给人天&资源评估的结构化摘要/m);
  if (index < 0) return content;
  const prefix = content.slice(0, index);
  const summary = content.slice(index);
  const lines = summary.split(/\r?\n/).map((line) => {
    const cells = splitMarkdownRow(line);
    if (cells.length < 2 || /^:?-{3,}:?$/.test(cells[0])) return line;
    const normalizedKey = cells[0].replace(/\s+/g, "").toLowerCase();
    const matchedKey = Object.keys(values).find((key) => normalizedKey === key.replace(/\s+/g, "").toLowerCase());
    if (!matchedKey || !values[matchedKey]) return line;
    return buildMarkdownRow([cells[0], values[matchedKey], ...cells.slice(2)]);
  });
  return `${prefix}${lines.join("\n")}`;
}

function reconcileSowStructuredSummary(content: string) {
  const values: Record<string, string> = {
    项目类型: extractProjectType(content),
    Agent数量: confirmedNumberFromSection(content, "Agent 数量"),
    Syslog数量: confirmedNumberFromSection(content, "Syslog 数量"),
    固定人天: extractExpectedPersonDays(content),
    SIEM: extractScopeFlag(content, "SIEM"),
    UEBA: extractScopeFlag(content, "UEBA"),
    大屏: extractScopeFlag(content, "大屏"),
    定制开发: extractScopeFlag(content, "定制开发"),
  };
  return replaceStructuredSummaryRows(content, values);
}

export async function normalizeSowWithAi(project: Project, fileName: string, rawContent: string, config: AiModelConfig) {
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
        { role: "user", content: buildSowNormalizationPrompt(project, fileName, rawContent) },
      ],
      {
        requireProjectDataConsent: true,
        maxTokens: 6200,
        timeoutMs: 240_000,
      },
    );
    const reconciledContent = reconcileSowStructuredSummary(content);
    console.info("[SOW标准化] AI解析完成", {
      model: modelName,
      outputChars: reconciledContent.length,
    });
    return { content: reconciledContent, model: modelName };
  } catch (error) {
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

function numberFromText(value: string) {
  const match = value.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function explicitDailyGb(inputs: ResourceAssessmentInputs) {
  const volume = numberFromText(inputs.dailyDataVolume);
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
  const explicit = numberFromText(inputs.retentionDays);
  if (explicit) return Math.round(explicit);
  const candidate = numbersNear(workflow.sow.content || "", ["天", "day", "days", "保留", "留存"])[0];
  return candidate ? Math.round(Number(candidate)) : 180;
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
  const raw = numberFromText(inputs.singleNodeUsableTb);
  if (!raw) return RIZHIYI_SINGLE_NODE_RAID5_TB;
  return inputs.singleNodeCapacityUnit === "GB" ? raw / 1024 : raw;
}

function nodeCountFromWorkflow(workflow: DeliveryWorkflow) {
  const inputs = normalizedResourceInputs(workflow.resourceInputs);
  const raw = numberFromText(inputs.nodeCount);
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
  const peakFactor = numberFromText(inputs.peakFactor) || 1;
  const projectType = hardwareProjectType(workflow);
  const platformName = projectType === "siem" ? "SIEM 安全平台" : projectType === "ueba" ? "UEBA 用户行为分析平台" : "日志平台";
  const dataTb = (dailyGb * 1.5 * 2 * retentionDays * 1.2) / 1024;
  const kafkaTb = ((dailyGb / 24) * peakFactor * 4.5 * 2 * 6 * 1.2 * (projectType === "log" ? 1 : 1.5)) / 1024;
  const totalTb = dataTb + kafkaTb;
  const eps = dailyGb * 50;
  const level = skillLevel(dailyGb);
  const capacityTb = singleNodeCapacityTb(workflow);
  const userDiskProvided = Boolean(numberFromText(inputs.singleNodeUsableTb));
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
- For SIEM, UEBA, Flink, dashboard, custom development, and data migration: if the facts do not explicitly indicate presence, treat them as not included in current scope instead of pending confirmation.
- Never output a complete total, schedule, WBS execution flow, or implementation chapter based on fake or guessed data.
- For project-eval, skill-export, and project-implementation-program, local fallback and template-only estimation are disabled in this application. Missing prerequisites must produce a missing-parameter list, not a guessed result.
- Keep the result concise enough for project manager review, but include formulas, source basis, and calculation assumptions.
- Do not repeat full upstream drafts. Reuse upstream conclusions and structured summaries, then generate only the current step's necessary draft.
- Completeness has priority over brevity for WBS and implementation program drafts. Do not omit required chapters, tables, acceptance assumptions, schedule basis, or deployment basis merely to shorten the answer.

SOW标准输入源：
${sowSource}`;

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
3. 标准阶段为7个：项目启动、需求调研、数据接入与部署、场景规则交付、成果汇报培训、上线试运行、项目验收。不要单独生成“数据迁移”阶段；涉及迁移、导入、接入、部署的任务归入“数据接入与部署”。
4. 试运行任务必须来自SOW正文或人天评估结果；人天评估参数区不再提供试运行开关，没有明确包含试运行时不得添加试运行任务。
5. 详细计划表必须严格15列且顺序不能错位：编号、类型、任务、里程碑（是/否）、计划开始、计划结束、工期、状态、进度、责任人、执行者、前置任务、输出成果、延迟天数、备注。后续“确认并生成项目执行流”只识别这张15列表，不能只输出WBS骨架。
6. 里程碑列中里程碑任务必须写“里程碑”，非里程碑留空。
7. 责任人只使用“项目经理”和“实施工程师”，除非SOW或人天评估明确给出其他角色。
8. 输出必须直接展示：WBS任务清单、详细计划表、文本甘特图时间轴、里程碑节点列表、传递给实施方案的计划摘要。
9. 如果缺少入场日期，可以用当前日期作为“计划生成默认起点”但必须在假设中标注；如果缺少总人天，日期列写“待确认”，不要编造日期。

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
5. 项目阶段采用：项目启动、需求调研、数据接入与部署、场景规则交付、成果汇报培训、上线试运行、项目验收。不要单独生成“数据迁移”阶段；涉及迁移、导入、接入、部署的任务归入“数据接入与部署”。
6. WBS和计划必须承接人天评估结论，硬件资源评估用于安排资源准备、部署规模确认和客户待确认任务。
7. 输出最后必须给出“传递给实施方案的计划摘要”。`;
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
