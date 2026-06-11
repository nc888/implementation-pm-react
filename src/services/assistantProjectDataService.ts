import type {
  AppState,
  AssistantScope,
  Deliverable,
  Project,
  ProjectMilestone,
  RiskIssue,
  ScopeItem,
  Task,
  TaskStatus,
} from "../types";
import {
  buildTaskTree,
  calcProjectMetrics,
  calcProjectPersonDays,
  calcStageProgress,
  compareTasksByPlan,
  flattenTaskTree,
  formatProjectMilestoneOption,
  isExecutableTask,
  projectDeliverables,
  projectMilestonesForState,
  projectRisks,
  projectScope,
  projectTasks,
  stageDefinitionsForProject,
  stageLabel,
  taskStatusLabels,
} from "./contextBuilder";
import { getWorkflow } from "./deliveryWorkflowService";
import { ruleBasedAiService } from "./aiService";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type EntityType = "project" | "tasks" | "scopeItems" | "deliverables" | "risksIssues" | "milestones";
type TargetScope = "all" | "open" | "matching";

type CommandTarget = {
  scope?: TargetScope;
  query?: string;
  ids?: string[];
  codes?: string[];
  titles?: string[];
  names?: string[];
  projectIds?: string[];
  projectNames?: string[];
  kinds?: RiskIssue["kind"][];
  entityTypes?: EntityType[];
  fields?: string[];
};

type TaskCreateInput = {
  title?: string;
  code?: string;
  parentId?: string;
  parentCode?: string;
  parentTitle?: string;
  type?: string;
  status?: TaskStatus;
  stage?: string;
  dimension?: string;
  priority?: Task["priority"];
  owner?: string;
  startDate?: string;
  dueDate?: string;
  progress?: number;
};

export type AiProjectDataCommandAction = {
  type:
    | "replaceText"
    | "updateProject"
    | "updateTasks"
    | "createTasks"
    | "updateScopeItems"
    | "updateDeliverables"
    | "updateRisksIssues"
    | "updateMilestones";
  target?: CommandTarget;
  search?: string;
  replacement?: string;
  changes?: Record<string, unknown>;
  tasks?: TaskCreateInput[];
};

export type AiProjectDataCommandPlan = {
  mode: "execute" | "answer";
  reply?: string;
  actions: AiProjectDataCommandAction[];
};

export type AiProjectDataCommandExecution = {
  state: AppState;
  changedRecords: Array<{
    entity: EntityType;
    label: string;
    projectName: string;
    fields: string[];
    before: Record<string, string | number>;
    after: Record<string, string | number>;
  }>;
  unmatchedTargets: string[];
};

const projectFieldLabels: Record<string, string> = {
  name: "项目名称",
  client: "客户",
  phase: "当前阶段",
  health: "健康度",
  owner: "负责人",
  startDate: "开始日期",
  endDate: "结束日期",
  progress: "进度",
  nextMilestone: "下一里程碑",
  description: "项目说明",
  estimatedImplementationPersonDays: "预估实施人天",
  estimatedDevelopmentPersonDays: "预估开发人天",
};

const taskFieldLabels: Record<string, string> = {
  code: "编号",
  title: "任务名称",
  type: "类型",
  status: "状态",
  stage: "阶段",
  dimension: "维度",
  priority: "优先级",
  owner: "负责人",
  startDate: "开始日期",
  dueDate: "截止日期",
  progress: "进度",
};

const scopeFieldLabels: Record<string, string> = {
  category: "范围类别",
  personDayType: "人天类型",
  title: "范围标题",
  description: "说明",
  estimatedPersonDays: "预估人天",
  actualPersonDays: "实际人天",
  progress: "进度",
  content: "范围内容",
};

const deliverableFieldLabels: Record<string, string> = {
  name: "交付物名称",
  code: "编号",
  status: "状态",
  acceptance: "验收",
  dueDate: "截止日期",
  attachmentRequirement: "附件要求",
  attachmentName: "附件名称",
  attachmentPath: "附件路径",
};

const riskFieldLabels: Record<string, string> = {
  kind: "类型",
  title: "标题",
  severity: "等级",
  status: "状态",
  riskVisibility: "可见性",
  responsePlan: "应对措施",
  internalHandling: "内部处理",
  customerAssistance: "需客户协助",
  linkedTaskId: "关联任务",
};

const milestoneFieldLabels: Record<string, string> = {
  title: "里程碑",
  dueDate: "日期",
  status: "状态",
  description: "说明",
};

const textFields: Record<EntityType, string[]> = {
  project: ["name", "client", "phase", "health", "owner", "nextMilestone", "description"],
  tasks: ["title", "type", "stage", "dimension", "priority", "owner"],
  scopeItems: ["category", "personDayType", "title", "description", "content"],
  deliverables: ["name", "status", "acceptance", "attachmentRequirement", "attachmentName"],
  risksIssues: ["kind", "title", "severity", "status", "riskVisibility", "responsePlan", "internalHandling", "customerAssistance"],
  milestones: ["title", "status", "description"],
};

const entityLabels: Record<EntityType, string> = {
  project: "项目",
  tasks: "任务",
  scopeItems: "SOW范围",
  deliverables: "交付物",
  risksIssues: "风险问题",
  milestones: "里程碑",
};

const statusLabels: Record<TaskStatus, string> = {
  todo: "待处理",
  doing: "进行中",
  customer: "待客户",
  blocked: "已阻塞",
  done: "已完成",
};

export function buildFullProjectAssistantSnapshot(state: AppState, project: Project) {
  const tasks = projectTasks(state, project.id).sort(compareTasksByPlan);
  const risksIssues = projectRisks(state, project.id);
  const deliverables = projectDeliverables(state, project.id);
  const scopeItems = projectScope(state, project.id);
  const metrics = calcProjectMetrics(state, project);
  const personDays = calcProjectPersonDays(state, project);
  const score = ruleBasedAiService.scoreProject(state, project);
  const nodes = flattenTaskTree(buildTaskTree(tasks), new Set(tasks.map((task) => task.id)), { includeCollapsedChildren: true });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const workflow = getWorkflow(state, project.id);
  const weeklyReports = state.weeklyReports
    .filter((report) => report.projectId === project.id)
    .sort((left, right) => right.reportDate.localeCompare(left.reportDate) || right.updatedAt.localeCompare(left.updatedAt));

  return {
    schemaVersion: "2.0",
    scope: "project",
    generatedAt: new Date().toISOString(),
    project: {
      ...project,
      computedProgress: metrics.completionRate,
      healthScore: score.score,
      healthLevel: score.level,
      healthSummary: score.summary,
      healthActions: score.actions,
    },
    metrics,
    personDays,
    stageConfig: {
      stages: stageDefinitionsForProject(state, project.id),
      progress: calcStageProgress(state, project),
      milestones: projectMilestonesForState(state, project.id),
    },
    tasks: tasks.map((task) => {
      const node = nodeById.get(task.id);
      return {
        ...task,
        stageLabel: stageLabel(state, task.stage, task.projectId),
        statusLabel: taskStatusLabels[task.status],
        computedStatus: node?.computedStatus || task.status,
        computedStatusLabel: taskStatusLabels[node?.computedStatus || task.status],
        computedProgress: node?.computedProgress ?? task.progress,
        isExecutable: isExecutableTask(task),
      };
    }),
    scopeItems,
    deliverables,
    risksIssues,
    weeklyReports: weeklyReports.map((report) => ({
      id: report.id,
      reportDate: report.reportDate,
      title: report.title,
      projectOwner: report.projectOwner,
      implementationMode: report.implementationMode,
      projectStatus: report.projectStatus,
      thisWeekTaskIds: report.thisWeekTaskIds,
      nextWeekTaskIds: report.nextWeekTaskIds,
      mailSubject: report.mailSubject,
      content: report.content,
      updatedAt: report.updatedAt,
    })),
    workflow: {
      sow: workflow.sow,
      resourceInputs: workflow.resourceInputs,
      handoff: workflow.handoff,
      personDayAssessment: workflow.personDayAssessment,
      hardwareAssessment: workflow.hardwareAssessment,
      wbsPlan: workflow.wbsPlan,
      implementationPlan: workflow.implementationPlan,
      projectFlow: workflow.projectFlow,
    },
  };
}

export function buildAllProjectsFullAssistantSnapshot(state: AppState) {
  const projects = state.projects.map((project) => buildFullProjectAssistantSnapshot(state, project));
  return {
    schemaVersion: "2.0",
    scope: "all-projects",
    generatedAt: new Date().toISOString(),
    totals: {
      projects: projects.length,
      totalTasks: projects.reduce((sum, item) => sum + item.tasks.length, 0),
      openTasks: projects.reduce((sum, item) => sum + item.metrics.open, 0),
      doneTasks: projects.reduce((sum, item) => sum + item.metrics.done, 0),
      blockedTasks: projects.reduce((sum, item) => sum + item.metrics.blocked, 0),
      customerTasks: projects.reduce((sum, item) => sum + item.metrics.customer, 0),
      overdueTasks: projects.reduce((sum, item) => sum + item.metrics.overdue, 0),
      openHighRisks: projects.reduce((sum, item) => sum + item.metrics.openHighRisks, 0),
      openIssues: projects.reduce((sum, item) => sum + item.metrics.issues, 0),
      pendingDeliverables: projects.reduce((sum, item) => sum + item.metrics.pendingDeliverables, 0),
      averageHealthScore: projects.length ? Math.round(projects.reduce((sum, item) => sum + item.project.healthScore, 0) / projects.length) : 0,
    },
    projects,
  };
}

export function buildAssistantDataSnapshot(state: AppState, project: Project, scope: AssistantScope) {
  return scope === "all" ? buildAllProjectsFullAssistantSnapshot(state) : buildFullProjectAssistantSnapshot(state, project);
}

export function looksLikeProjectDataCommandRequest(question: string) {
  const text = question.trim();
  if (!text) return false;
  if (/(?:把|将)\s*.+?\s*(?:全部|都)?\s*(?:改成|改为|替换成|替换为)\s*.+/.test(text)) return true;
  const hasChangeVerb = /改|调整|更新|变更|设置|设为|改为|替换|标记|延期|推迟|提前|顺延|完成|关闭|新增|删除/.test(text);
  const hasDataSignal = /项目|任务|事项|WBS|交付物|风险|问题|范围|SOW|阶段|里程碑|负责人|工程师|状态|进度|健康|客户|名称|人天|日期|验收|所有|全部|都/.test(text);
  return hasChangeVerb && hasDataSignal;
}

export function buildProjectDataCommandExtractionMessages(state: AppState, project: Project, question: string, scope: AssistantScope = "project"): ChatMessage[] {
  const snapshot = buildAssistantDataSnapshot(state, project, scope);
  return [
    {
      role: "system",
      content: [
        "你是项目管理系统的数据变更指令解析器。只输出 JSON，不要输出 Markdown、解释或代码块。",
        "只有用户明确要求修改项目数据时才返回 mode=execute；询问、分析、解释、生成草稿时返回 mode=answer 且 actions=[]。",
        "允许动作：replaceText、updateProject、updateTasks、updateScopeItems、updateDeliverables、updateRisksIssues、updateMilestones。",
        "replaceText 用于“把 X 都改成 Y / 替换 X 为 Y”，会在当前范围内按字段白名单替换文本。",
        "updateProject 可改 name、client、phase、health、owner、startDate、endDate、progress、nextMilestone、description、estimatedImplementationPersonDays、estimatedDevelopmentPersonDays。",
        "updateTasks 可改 code、title、type、status、stage、dimension、priority、owner、startDate、dueDate、progress，并支持 startShiftDays、dueShiftDays、startShiftMonths、dueShiftMonths。排序/调整顺序时优先修改 code；当前界面按计划日期、code、截止日期排序。",
        "createTasks 用于新建任务。每个 task 至少包含 title；可带 code、parentId、parentCode、parentTitle、type、status、stage、dimension、priority、owner、startDate、dueDate、progress。未给 code 时本地自动生成。",
        "updateScopeItems 可改 category、personDayType、title、description、estimatedPersonDays、actualPersonDays、progress、content。",
        "updateDeliverables 可改 name、status、acceptance、dueDate、attachmentRequirement、attachmentName、attachmentPath。",
        "updateRisksIssues 可改 kind、title、severity、status、riskVisibility、responsePlan、internalHandling、customerAssistance、linkedTaskId。kind 只能 risk/issue，severity 只能 高/中/低，status 只能 open/tracking/closed，riskVisibility 只能 internal/external；只有 external 风险可进入客户周报。",
        "updateMilestones 可改 title、dueDate、status、description。",
        "target.scope 可为 all/open/matching；指定记录时尽量用 id、code、title、name 或 query。当前项目范围下不要修改其他项目。",
        "日期必须是 YYYY-MM-DD。用户只写 MM-DD 时使用当前年份。状态枚举：任务 todo/doing/customer/blocked/done。",
        "返回格式示例1：{\"mode\":\"execute\",\"reply\":\"准备更新负责人\",\"actions\":[{\"type\":\"replaceText\",\"search\":\"接入工程师\",\"replacement\":\"刘悦好\",\"target\":{\"scope\":\"all\",\"entityTypes\":[\"project\",\"tasks\",\"scopeItems\",\"deliverables\",\"risksIssues\",\"milestones\"]}}]}",
        "返回格式示例2：{\"mode\":\"execute\",\"reply\":\"准备新建任务\",\"actions\":[{\"type\":\"createTasks\",\"tasks\":[{\"title\":\"完成日志采集联调\",\"owner\":\"刘悦好\",\"dueDate\":\"2026-06-20\",\"status\":\"todo\"}]}]}",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `当前日期：${localDateKey()}`,
        `当前范围：${scope === "all" ? "所有项目" : "当前项目"}`,
        `当前项目：${project.name}`,
        "完整项目数据快照：",
        JSON.stringify(snapshot, null, 2),
        "",
        `用户指令：${question}`,
      ].join("\n"),
    },
  ];
}

export function parseProjectDataCommandPlan(raw: string): AiProjectDataCommandPlan | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  try {
    const data = JSON.parse(json);
    const mode = data?.mode === "execute" ? "execute" : "answer";
    const actions = normalizeActions(data?.actions);
    return {
      mode,
      reply: typeof data?.reply === "string" ? data.reply.trim() : "",
      actions: mode === "execute" ? actions : [],
    };
  } catch {
    return null;
  }
}

export function inferRuleBasedProjectDataCommandPlan(question: string): AiProjectDataCommandPlan | null {
  const text = question.trim();
  if (!looksLikeProjectDataCommandRequest(text)) return null;
  const projectHealth = text.match(/(?:项目)?(?:健康度?|状态).*(健康|关注|延期)/);
  if (projectHealth?.[1]) {
    return {
      mode: "execute",
      reply: "已识别为项目健康度更新。",
      actions: [{ type: "updateProject", changes: { health: projectHealth[1] } }],
    };
  }
  const projectOwner = text.match(/(?:项目)?负责人(?:改成|改为|设为|设置为)\s*([^\s，。；;]+)/);
  if (projectOwner?.[1]) {
    return {
      mode: "execute",
      reply: "已识别为项目负责人更新。",
      actions: [{ type: "updateProject", changes: { owner: projectOwner[1].trim() } }],
    };
  }
  const nextMilestone = text.match(/(?:当前|下一)?里程碑(?:改成|改为|设为|设置为)\s*(.+)$/);
  if (nextMilestone?.[1]) {
    return {
      mode: "execute",
      reply: "已识别为下一里程碑更新。",
      actions: [{ type: "updateProject", changes: { nextMilestone: cleanTail(nextMilestone[1]) } }],
    };
  }
  const createTask = text.match(/(?:新增|新建|创建|添加|加一个)\s*(?:一个)?(?:任务|事项)\s*[「“"]?(.+?)[」”"]?(?:[，,。；;]|$)/);
  if (createTask?.[1]) {
    const owner = text.match(/负责人(?:是|为|设为|设置为)?\s*([^\s，,。；;]+)/)?.[1] || "";
    const dueDate = normalizeDate(text.match(/(?:截止|完成时间|结束时间|到)\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2})/)?.[1] || "");
    return {
      mode: "execute",
      reply: "已识别为新建任务指令。",
      actions: [
        {
          type: "createTasks",
          tasks: [
            {
              title: cleanTail(createTask[1]),
              owner,
              dueDate,
              status: "todo",
            },
          ],
        },
      ],
    };
  }
  const replace = text.match(/(?:把|将)\s*(.+?)\s*(?:全部|都)?\s*(?:改成|改为|替换成|替换为)\s*(.+)$/);
  if (replace?.[1] && replace[2]) {
    return {
      mode: "execute",
      reply: "已识别为项目数据文本替换。",
      actions: [
        {
          type: "replaceText",
          search: cleanTail(replace[1]),
          replacement: cleanTail(replace[2]),
          target: { scope: "all" },
        },
      ],
    };
  }
  return null;
}

export function applyProjectDataCommandPlan(state: AppState, projectId: string | "all", plan: AiProjectDataCommandPlan): AiProjectDataCommandExecution {
  let next = clone(state);
  const changedRecords: AiProjectDataCommandExecution["changedRecords"] = [];
  const unmatchedTargets: string[] = [];
  const actions = normalizeActions(plan.actions);

  actions.forEach((action) => {
    const beforeCount = changedRecords.length;
    if (action.type === "replaceText") {
      next = applyReplaceText(next, projectId, action, changedRecords);
    } else if (action.type === "updateProject") {
      next = applyProjectUpdate(next, projectId, action, changedRecords);
    } else if (action.type === "updateTasks") {
      next = applyCollectionUpdate(next, projectId, action, "tasks", selectTasks, applyTaskChanges, changedRecords);
    } else if (action.type === "createTasks") {
      next = applyTaskCreate(next, projectId, action, changedRecords);
    } else if (action.type === "updateScopeItems") {
      next = applyCollectionUpdate(next, projectId, action, "scopeItems", selectScopeItems, applyScopeChanges, changedRecords);
    } else if (action.type === "updateDeliverables") {
      next = applyCollectionUpdate(next, projectId, action, "deliverables", selectDeliverables, applyDeliverableChanges, changedRecords);
    } else if (action.type === "updateRisksIssues") {
      next = applyCollectionUpdate(next, projectId, action, "risksIssues", selectRisksIssues, applyRiskChanges, changedRecords);
    } else if (action.type === "updateMilestones") {
      next = applyMilestoneUpdate(next, projectId, action, changedRecords);
    }
    if (changedRecords.length === beforeCount) unmatchedTargets.push(describeActionTarget(action));
  });

  return { state: next, changedRecords, unmatchedTargets };
}

export function formatProjectDataCommandResult(plan: AiProjectDataCommandPlan, execution: AiProjectDataCommandExecution) {
  if (!execution.changedRecords.length) {
    const targetText = execution.unmatchedTargets.length ? `\n\n未匹配目标：${execution.unmatchedTargets.join("、")}` : "";
    return `${plan.reply || "我识别到了项目数据变更意图，但没有找到可更新的数据。"}${targetText}`;
  }

  const preview = execution.changedRecords.slice(0, 16).map((item) => {
    const details = item.fields
      .map((field) => `${fieldLabel(item.entity, field)}：${stringifyValue(item.before[field])} → ${stringifyValue(item.after[field])}`)
      .join("；");
    return `- 【${item.projectName}】${entityLabels[item.entity]} ${item.label}：${details}`;
  });
  const hidden = execution.changedRecords.length > preview.length ? `\n- 另有 ${execution.changedRecords.length - preview.length} 条数据已更新。` : "";
  const unmatched = execution.unmatchedTargets.length ? `\n\n未匹配目标：${execution.unmatchedTargets.join("、")}` : "";
  return `${plan.reply || "已按你的指令更新项目数据。"}\n\n已更新 ${execution.changedRecords.length} 条数据：\n${preview.join("\n")}${hidden}${unmatched}`;
}

function normalizeActions(actions: unknown): AiProjectDataCommandAction[] {
  if (!Array.isArray(actions)) return [];
  const allowed = new Set<AiProjectDataCommandAction["type"]>([
    "replaceText",
    "updateProject",
    "updateTasks",
    "createTasks",
    "updateScopeItems",
    "updateDeliverables",
    "updateRisksIssues",
    "updateMilestones",
  ]);
  return actions
    .filter((action): action is AiProjectDataCommandAction => Boolean(action && typeof action === "object" && allowed.has((action as AiProjectDataCommandAction).type)))
    .map((action) => ({
      type: action.type,
      target: normalizeTarget(action.target),
      search: typeof action.search === "string" ? action.search.trim() : "",
      replacement: typeof action.replacement === "string" ? action.replacement.trim() : "",
      changes: isRecord(action.changes) ? action.changes : {},
      tasks: normalizeTaskCreateInputs(action.tasks),
    }))
    .filter((action) => {
      if (action.type === "replaceText") return Boolean(action.search && action.replacement);
      if (action.type === "createTasks") return Boolean(action.tasks?.length);
      return Object.keys(action.changes || {}).length > 0;
    });
}

function normalizeTarget(target?: CommandTarget): CommandTarget {
  return {
    scope: target?.scope === "all" || target?.scope === "open" || target?.scope === "matching" ? target.scope : "matching",
    query: typeof target?.query === "string" ? target.query.trim() : "",
    ids: stringArray(target?.ids),
    codes: stringArray(target?.codes),
    titles: stringArray(target?.titles),
    names: stringArray(target?.names),
    projectIds: stringArray(target?.projectIds),
    projectNames: stringArray(target?.projectNames),
    kinds: Array.isArray(target?.kinds) ? target.kinds.filter((kind): kind is RiskIssue["kind"] => kind === "risk" || kind === "issue") : [],
    entityTypes: Array.isArray(target?.entityTypes) ? target.entityTypes.filter(isEntityType) : [],
    fields: stringArray(target?.fields),
  };
}

function applyReplaceText(
  state: AppState,
  projectId: string | "all",
  action: AiProjectDataCommandAction,
  changedRecords: AiProjectDataCommandExecution["changedRecords"],
) {
  const search = action.search || "";
  const replacement = action.replacement || "";
  if (!search || search === replacement) return state;
  const projectIds = projectIdsForAction(state, projectId, action.target);
  const entityTypes = action.target?.entityTypes?.length ? action.target.entityTypes : (Object.keys(entityLabels) as EntityType[]);
  let next = state;

  if (entityTypes.includes("project")) {
    next = {
      ...next,
      projects: next.projects.map((project) => {
        if (!projectIds.has(project.id)) return project;
        return replaceTextInRecord(project, "project", project.name, project.name, action, search, replacement, changedRecords) as Project;
      }),
    };
  }
  if (entityTypes.includes("tasks")) {
    next = {
      ...next,
      tasks: next.tasks.map((task) => {
        if (!projectIds.has(task.projectId)) return task;
        return replaceTextInRecord(task, "tasks", taskLabel(task), projectName(next, task.projectId), action, search, replacement, changedRecords) as Task;
      }),
    };
  }
  if (entityTypes.includes("scopeItems")) {
    next = {
      ...next,
      scopeItems: next.scopeItems.map((item) => {
        if (!projectIds.has(item.projectId)) return item;
        return replaceTextInRecord(item, "scopeItems", item.title || item.content, projectName(next, item.projectId), action, search, replacement, changedRecords) as ScopeItem;
      }),
    };
  }
  if (entityTypes.includes("deliverables")) {
    next = {
      ...next,
      deliverables: next.deliverables.map((item) => {
        if (!projectIds.has(item.projectId)) return item;
        return replaceTextInRecord(item, "deliverables", item.name || item.code, projectName(next, item.projectId), action, search, replacement, changedRecords) as Deliverable;
      }),
    };
  }
  if (entityTypes.includes("risksIssues")) {
    next = {
      ...next,
      risksIssues: next.risksIssues.map((item) => {
        if (!projectIds.has(item.projectId)) return item;
        return replaceTextInRecord(item, "risksIssues", item.title, projectName(next, item.projectId), action, search, replacement, changedRecords) as RiskIssue;
      }),
    };
  }
  if (entityTypes.includes("milestones")) {
    next = replaceTextInMilestones(next, projectIds, action, search, replacement, changedRecords);
  }
  return next;
}

function replaceTextInRecord<T extends object>(
  record: T,
  entity: EntityType,
  label: string,
  recordProjectName: string,
  action: AiProjectDataCommandAction,
  search: string,
  replacement: string,
  changedRecords: AiProjectDataCommandExecution["changedRecords"],
): T {
  const fields = action.target?.fields?.length ? action.target.fields : textFields[entity];
  const recordMap = record as Record<string, unknown>;
  const before: Record<string, string | number> = {};
  const after: Record<string, string | number> = {};
  let next = record;
  fields.forEach((field) => {
    const value = recordMap[field];
    if (typeof value !== "string" || !value.includes(search)) return;
    const replaced = value.split(search).join(replacement);
    if (replaced === value) return;
    before[field] = value;
    after[field] = replaced;
    next = { ...next, [field]: replaced };
  });
  if (Object.keys(after).length) {
    changedRecords.push({
      entity,
      label,
      projectName: recordProjectName,
      fields: Object.keys(after),
      before,
      after,
    });
  }
  return next;
}

function replaceTextInMilestones(
  state: AppState,
  projectIds: Set<string>,
  action: AiProjectDataCommandAction,
  search: string,
  replacement: string,
  changedRecords: AiProjectDataCommandExecution["changedRecords"],
) {
  return {
    ...state,
    projectStageConfigs: state.projectStageConfigs.map((config) => {
      if (!projectIds.has(config.projectId)) return config;
      return {
        ...config,
        milestones: config.milestones.map((milestone) =>
          replaceTextInRecord(milestone as unknown as Record<string, unknown>, "milestones", formatProjectMilestoneOption(milestone), projectName(state, config.projectId), action, search, replacement, changedRecords) as unknown as ProjectMilestone,
        ),
        updatedAt: new Date().toISOString(),
      };
    }),
  };
}

function applyProjectUpdate(
  state: AppState,
  projectId: string | "all",
  action: AiProjectDataCommandAction,
  changedRecords: AiProjectDataCommandExecution["changedRecords"],
) {
  const projectIds = projectIdsForAction(state, projectId, action.target);
  const changes = normalizeProjectChanges(action.changes || {});
  if (!Object.keys(changes).length) return state;
  return {
    ...state,
    projects: state.projects.map((project) => {
      if (!projectIds.has(project.id) || !matchesProjectTarget(project, action.target)) return project;
      const next = { ...project, ...changes };
      recordObjectChange(
        "project",
        project.name,
        project.name,
        project as unknown as Record<string, unknown>,
        next as unknown as Record<string, unknown>,
        Object.keys(changes),
        changedRecords,
      );
      return next;
    }),
  };
}

function applyCollectionUpdate<T extends { id: string; projectId: string }>(
  state: AppState,
  projectId: string | "all",
  action: AiProjectDataCommandAction,
  collection: "tasks" | "scopeItems" | "deliverables" | "risksIssues",
  selector: (items: T[], target?: CommandTarget) => T[],
  applyChanges: (item: T, changes: Record<string, unknown>) => T,
  changedRecords: AiProjectDataCommandExecution["changedRecords"],
) {
  const projectIds = projectIdsForAction(state, projectId, action.target);
  const source = state[collection] as unknown as T[];
  const candidate = source.filter((item) => projectIds.has(item.projectId));
  const selectedIds = new Set(selector(candidate, action.target).map((item) => item.id));
  if (!selectedIds.size) return state;
  const entity = collection === "risksIssues" ? "risksIssues" : collection;
  return {
    ...state,
    [collection]: source.map((item) => {
      if (!selectedIds.has(item.id)) return item;
      const next = applyChanges(item, action.changes || {});
      recordObjectChange(
        entity,
        itemLabel(entity, item),
        projectName(state, item.projectId),
        item as unknown as Record<string, unknown>,
        next as unknown as Record<string, unknown>,
        Object.keys(action.changes || {}),
        changedRecords,
      );
      return next;
    }),
  } as AppState;
}

function applyTaskCreate(
  state: AppState,
  projectId: string | "all",
  action: AiProjectDataCommandAction,
  changedRecords: AiProjectDataCommandExecution["changedRecords"],
) {
  const projectIds = projectIdsForAction(state, projectId, action.target);
  const specs = action.tasks || [];
  if (!projectIds.size || !specs.length) return state;
  const now = new Date().toISOString();
  const nextTasks = [...state.tasks];
  projectIds.forEach((targetProjectId) => {
    specs.forEach((spec) => {
      const projectTaskList = nextTasks.filter((task) => task.projectId === targetProjectId);
      const parent = findTaskParent(projectTaskList, spec);
      const stages = stageDefinitionsForProject(state, targetProjectId);
      const defaultStage = parent?.stage || stages[0]?.id || "deployment";
      const code = spec.code?.trim() || nextTaskCode(projectTaskList, parent?.id || "");
      const task: Task = {
        id: crypto.randomUUID(),
        projectId: targetProjectId,
        parentId: parent?.id || "",
        code,
        title: spec.title?.trim() || "未命名任务",
        type: spec.type?.trim() || (parent ? "子任务" : "任务"),
        status: spec.status && isTaskStatus(spec.status) ? spec.status : "todo",
        stage: spec.stage?.trim() || defaultStage,
        dimension: spec.dimension?.trim() || parent?.dimension || "实施",
        priority: spec.priority === "高" || spec.priority === "低" || spec.priority === "中" ? spec.priority : "中",
        owner: spec.owner?.trim() || parent?.owner || "",
        startDate: normalizeDate(spec.startDate || "") || "",
        dueDate: normalizeDate(spec.dueDate || "") || "",
        progress: typeof spec.progress === "number" && Number.isFinite(spec.progress) ? Math.max(0, Math.min(100, Math.round(spec.progress))) : 0,
        updatedAt: now,
      };
      nextTasks.push(task);
      changedRecords.push({
        entity: "tasks",
        label: taskLabel(task),
        projectName: projectName(state, targetProjectId),
        fields: ["created"],
        before: { created: "无" },
        after: { created: `${task.code} ${task.title}` },
      });
    });
  });
  return { ...state, tasks: nextTasks };
}

function applyMilestoneUpdate(
  state: AppState,
  projectId: string | "all",
  action: AiProjectDataCommandAction,
  changedRecords: AiProjectDataCommandExecution["changedRecords"],
) {
  const projectIds = projectIdsForAction(state, projectId, action.target);
  const changes = normalizeMilestoneChanges(action.changes || {});
  if (!Object.keys(changes).length) return state;
  return {
    ...state,
    projectStageConfigs: state.projectStageConfigs.map((config) => {
      if (!projectIds.has(config.projectId)) return config;
      const sourceMilestones = config.milestones.length ? config.milestones : projectMilestonesForState(state, config.projectId);
      const selectedIds = new Set(selectMilestones(sourceMilestones, action.target).map((item) => item.id));
      if (!selectedIds.size) return config;
      return {
        ...config,
        milestones: sourceMilestones.map((milestone) => {
          if (!selectedIds.has(milestone.id)) return milestone;
          const next = { ...milestone, ...changes };
          recordObjectChange(
            "milestones",
            formatProjectMilestoneOption(milestone),
            projectName(state, config.projectId),
            milestone as unknown as Record<string, unknown>,
            next as unknown as Record<string, unknown>,
            Object.keys(changes),
            changedRecords,
          );
          return next;
        }),
        updatedAt: new Date().toISOString(),
      };
    }),
  };
}

function selectTasks(items: Task[], target?: CommandTarget) {
  if (target?.scope === "all") return items;
  if (target?.scope === "open") return items.filter((task) => task.status !== "done");
  return selectByQueries(items, target, (task) => [task.id, task.code, task.title, task.owner, task.dimension, task.type]);
}

function selectScopeItems(items: ScopeItem[], target?: CommandTarget) {
  if (target?.scope === "all") return items;
  return selectByQueries(items, target, (item) => [item.id, item.title, item.description, item.content, item.category, item.personDayType]);
}

function selectDeliverables(items: Deliverable[], target?: CommandTarget) {
  if (target?.scope === "all") return items;
  if (target?.scope === "open") return items.filter((item) => !["已验收", "内部确认"].includes(item.acceptance));
  return selectByQueries(items, target, (item) => [item.id, item.code, item.name, item.status, item.acceptance]);
}

function selectRisksIssues(items: RiskIssue[], target?: CommandTarget) {
  const byKind = target?.kinds?.length ? items.filter((item) => target.kinds?.includes(item.kind)) : items;
  if (target?.scope === "all") return byKind;
  if (target?.scope === "open") return byKind.filter((item) => item.status !== "closed");
  return selectByQueries(byKind, target, (item) => [
    item.id,
    item.title,
    item.kind,
    item.severity,
    item.status,
    item.riskVisibility,
    item.responsePlan,
    item.internalHandling,
    item.customerAssistance,
  ]);
}

function selectMilestones(items: ProjectMilestone[], target?: CommandTarget) {
  if (target?.scope === "all") return items;
  return selectByQueries(items, target, (item) => [item.id, item.title, item.dueDate, item.status, item.description]);
}

function selectByQueries<T>(items: T[], target: CommandTarget | undefined, valuesOf: (item: T) => Array<string | undefined>) {
  const queries = [...(target?.ids || []), ...(target?.codes || []), ...(target?.titles || []), ...(target?.names || []), target?.query || ""].filter(Boolean);
  if (!queries.length) return [];
  return items.filter((item) => queries.some((query) => valuesOf(item).some((value) => textMatches(value || "", query))));
}

function applyTaskChanges(item: Task, rawChanges: Record<string, unknown>): Task {
  const changes = normalizeTaskChanges(rawChanges);
  let next = { ...item, ...changes.direct };
  if (changes.startShiftDays || changes.startShiftMonths) next.startDate = item.startDate ? shiftDate(item.startDate, changes.startShiftDays, changes.startShiftMonths) : item.startDate;
  if (changes.dueShiftDays || changes.dueShiftMonths) next.dueDate = item.dueDate ? shiftDate(item.dueDate, changes.dueShiftDays, changes.dueShiftMonths) : item.dueDate;
  if (next.status === "done") next.progress = 100;
  if (next.progress === 100 && item.status !== "done" && rawChanges.status === undefined) next.status = "done";
  return { ...next, updatedAt: new Date().toISOString() };
}

function applyScopeChanges(item: ScopeItem, rawChanges: Record<string, unknown>): ScopeItem {
  return { ...item, ...normalizeScopeChanges(rawChanges) };
}

function applyDeliverableChanges(item: Deliverable, rawChanges: Record<string, unknown>): Deliverable {
  return { ...item, ...normalizeDeliverableChanges(rawChanges) };
}

function applyRiskChanges(item: RiskIssue, rawChanges: Record<string, unknown>): RiskIssue {
  return { ...item, ...normalizeRiskChanges(rawChanges) };
}

function normalizeProjectChanges(changes: Record<string, unknown>): Partial<Project> {
  const next: Partial<Project> = {};
  assignString(next, changes, "name");
  assignString(next, changes, "client");
  assignString(next, changes, "phase");
  assignString(next, changes, "owner");
  assignString(next, changes, "nextMilestone");
  assignString(next, changes, "description");
  const health = stringValue(changes.health);
  if (health === "健康" || health === "关注" || health === "延期") next.health = health;
  const startDate = normalizeDate(stringValue(changes.startDate));
  const endDate = normalizeDate(stringValue(changes.endDate));
  if (startDate) next.startDate = startDate;
  if (endDate) next.endDate = endDate;
  assignNumber(next, changes, "progress", 0, 100);
  assignNumber(next, changes, "estimatedImplementationPersonDays", 0);
  assignNumber(next, changes, "estimatedDevelopmentPersonDays", 0);
  return next;
}

function normalizeTaskChanges(changes: Record<string, unknown>) {
  const direct: Partial<Task> = {};
  assignString(direct, changes, "code");
  assignString(direct, changes, "title");
  assignString(direct, changes, "type");
  assignString(direct, changes, "stage");
  assignString(direct, changes, "dimension");
  assignString(direct, changes, "owner");
  const status = stringValue(changes.status);
  if (isTaskStatus(status)) direct.status = status;
  const priority = stringValue(changes.priority);
  if (priority === "高" || priority === "中" || priority === "低") direct.priority = priority;
  const startDate = normalizeDate(stringValue(changes.startDate));
  const dueDate = normalizeDate(stringValue(changes.dueDate));
  if (startDate) direct.startDate = startDate;
  if (dueDate) direct.dueDate = dueDate;
  assignNumber(direct, changes, "progress", 0, 100);
  return {
    direct,
    startShiftDays: integerValue(changes.startShiftDays),
    dueShiftDays: integerValue(changes.dueShiftDays),
    startShiftMonths: integerValue(changes.startShiftMonths),
    dueShiftMonths: integerValue(changes.dueShiftMonths),
  };
}

function normalizeScopeChanges(changes: Record<string, unknown>): Partial<ScopeItem> {
  const next: Partial<ScopeItem> = {};
  const category = stringValue(changes.category);
  if (category === "本期SOW范围" || category === "变更增加范围" || category === "不在本期范围") next.category = category;
  const personDayType = stringValue(changes.personDayType);
  if (personDayType === "实施" || personDayType === "开发") next.personDayType = personDayType;
  assignString(next, changes, "title");
  assignString(next, changes, "description");
  assignString(next, changes, "content");
  assignNumber(next, changes, "estimatedPersonDays", 0);
  assignNumber(next, changes, "actualPersonDays", 0);
  assignNumber(next, changes, "progress", 0, 100);
  return next;
}

function normalizeDeliverableChanges(changes: Record<string, unknown>): Partial<Deliverable> {
  const next: Partial<Deliverable> = {};
  assignString(next, changes, "name");
  assignString(next, changes, "status");
  assignString(next, changes, "acceptance");
  assignString(next, changes, "attachmentName");
  assignString(next, changes, "attachmentPath");
  const dueDate = normalizeDate(stringValue(changes.dueDate));
  if (dueDate) next.dueDate = dueDate;
  const attachmentRequirement = stringValue(changes.attachmentRequirement);
  if (attachmentRequirement === "required" || attachmentRequirement === "none") next.attachmentRequirement = attachmentRequirement;
  return next;
}

function normalizeRiskChanges(changes: Record<string, unknown>): Partial<RiskIssue> {
  const next: Partial<RiskIssue> = {};
  const kind = stringValue(changes.kind);
  if (kind === "risk" || kind === "issue") next.kind = kind;
  assignString(next, changes, "title");
  assignString(next, changes, "responsePlan");
  assignString(next, changes, "internalHandling");
  assignString(next, changes, "customerAssistance");
  assignString(next, changes, "linkedTaskId");
  const riskVisibility = stringValue(changes.riskVisibility);
  if (riskVisibility === "internal" || riskVisibility === "external") next.riskVisibility = riskVisibility;
  const severity = stringValue(changes.severity);
  if (severity === "高" || severity === "中" || severity === "低") next.severity = severity;
  const status = stringValue(changes.status);
  if (status === "open" || status === "tracking" || status === "closed") next.status = status;
  return next;
}

function normalizeMilestoneChanges(changes: Record<string, unknown>): Partial<ProjectMilestone> {
  const next: Partial<ProjectMilestone> = {};
  assignString(next, changes, "title");
  assignString(next, changes, "status");
  assignString(next, changes, "description");
  const dueDate = normalizeDate(stringValue(changes.dueDate));
  if (dueDate) next.dueDate = dueDate;
  return next;
}

function normalizeTaskCreateInputs(value: unknown): TaskCreateInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item): TaskCreateInput | null => {
      const title = stringValue(item.title);
      if (!title) return null;
      const status = stringValue(item.status);
      const priority = stringValue(item.priority);
      return {
        title,
        code: stringValue(item.code),
        parentId: stringValue(item.parentId),
        parentCode: stringValue(item.parentCode),
        parentTitle: stringValue(item.parentTitle),
        type: stringValue(item.type),
        status: isTaskStatus(status) ? status : undefined,
        stage: stringValue(item.stage),
        dimension: stringValue(item.dimension),
        priority: priority === "高" || priority === "中" || priority === "低" ? priority : undefined,
        owner: stringValue(item.owner),
        startDate: normalizeDate(stringValue(item.startDate)),
        dueDate: normalizeDate(stringValue(item.dueDate)),
        progress: numberValue(item.progress) ?? undefined,
      } satisfies TaskCreateInput;
    })
    .filter((item): item is TaskCreateInput => item !== null);
}

function recordObjectChange(
  entity: EntityType,
  label: string,
  recordProjectName: string,
  beforeRecord: Record<string, unknown>,
  afterRecord: Record<string, unknown>,
  requestedFields: string[],
  changedRecords: AiProjectDataCommandExecution["changedRecords"],
) {
  const fields = requestedFields.filter((field) => stringifyValue(beforeRecord[field]) !== stringifyValue(afterRecord[field]));
  if (!fields.length) return;
  const before: Record<string, string | number> = {};
  const after: Record<string, string | number> = {};
  fields.forEach((field) => {
    before[field] = primitiveValue(beforeRecord[field]);
    after[field] = primitiveValue(afterRecord[field]);
  });
  changedRecords.push({ entity, label, projectName: recordProjectName, fields, before, after });
}

function projectIdsForAction(state: AppState, projectId: string | "all", target?: CommandTarget) {
  const base = projectId === "all" ? state.projects : state.projects.filter((project) => project.id === projectId);
  const projectQueries = [...(target?.projectIds || []), ...(target?.projectNames || [])].filter(Boolean);
  return new Set(
    base
      .filter((project) => !projectQueries.length || projectQueries.some((query) => textMatches(project.id, query) || textMatches(project.name, query) || textMatches(project.client, query)))
      .map((project) => project.id),
  );
}

function matchesProjectTarget(project: Project, target?: CommandTarget) {
  if (!target || target.scope === "all") return true;
  return selectByQueries([project], target, (item) => [item.id, item.name, item.client, item.owner, item.phase, item.nextMilestone]).length > 0;
}

function projectName(state: AppState, projectId: string) {
  return state.projects.find((project) => project.id === projectId)?.name || projectId;
}

function taskLabel(task: Task) {
  return `${task.code} ${task.title}`.trim();
}

function findTaskParent(tasks: Task[], spec: TaskCreateInput) {
  if (spec.parentId) {
    const byId = tasks.find((task) => task.id === spec.parentId);
    if (byId) return byId;
  }
  if (spec.parentCode) {
    const byCode = tasks.find((task) => normalizeText(task.code) === normalizeText(spec.parentCode || ""));
    if (byCode) return byCode;
  }
  if (spec.parentTitle) {
    const byTitle = tasks.find((task) => textMatches(task.title, spec.parentTitle || ""));
    if (byTitle) return byTitle;
  }
  return null;
}

function nextTaskCode(tasks: Task[], parentId = "") {
  if (parentId) {
    const parent = tasks.find((task) => task.id === parentId);
    const prefix = parent?.code || "WBS";
    const children = tasks.filter((task) => task.parentId === parentId);
    const suffixes = children
      .map((task) => task.code.match(new RegExp(`^${escapeRegExp(prefix)}\\.(\\d+)$`))?.[1])
      .filter((value): value is string => Boolean(value));
    const next = Math.max(0, ...suffixes.map((value) => Number(value)).filter(Number.isFinite)) + 1;
    const width = Math.max(2, ...suffixes.map((value) => value.length));
    return `${prefix}.${String(next).padStart(width, "0")}`;
  }

  const roots = tasks.filter((task) => !task.parentId);
  const wbsNumbers = roots
    .map((task) => task.code.match(/^WBS-(\d+)$/i)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number)
    .filter(Number.isFinite);
  if (wbsNumbers.length) {
    const next = Math.max(...wbsNumbers) + 1;
    const width = Math.max(2, ...roots.map((task) => task.code.match(/^WBS-(\d+)$/i)?.[1]?.length || 0));
    return `WBS-${String(next).padStart(width, "0")}`;
  }

  const numeric = roots
    .map((task) => task.code.match(/^(\d+)$/)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number)
    .filter(Number.isFinite);
  if (numeric.length) return String(Math.max(...numeric) + 1);
  return `WBS-${String(roots.length + 1).padStart(2, "0")}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function itemLabel(entity: EntityType, item: { id: string } & Record<string, unknown>) {
  if (entity === "tasks") return taskLabel(item as unknown as Task);
  if (entity === "scopeItems") return String((item as unknown as ScopeItem).title || (item as unknown as ScopeItem).content || item.id);
  if (entity === "deliverables") return String((item as unknown as Deliverable).name || (item as unknown as Deliverable).code || item.id);
  if (entity === "risksIssues") return String((item as unknown as RiskIssue).title || item.id);
  if (entity === "milestones") return formatProjectMilestoneOption(item as unknown as ProjectMilestone);
  return String((item as unknown as Project).name || item.id);
}

function fieldLabel(entity: EntityType, field: string) {
  const maps: Record<EntityType, Record<string, string>> = {
    project: projectFieldLabels,
    tasks: taskFieldLabels,
    scopeItems: scopeFieldLabels,
    deliverables: deliverableFieldLabels,
    risksIssues: riskFieldLabels,
    milestones: milestoneFieldLabels,
  };
  if (field === "status" && entity === "tasks") return "状态";
  return maps[entity][field] || field;
}

function describeActionTarget(action: AiProjectDataCommandAction) {
  if (action.type === "replaceText") return `替换「${action.search}」`;
  const target = action.target;
  if (target?.scope === "all") return `${entityLabels[actionTypeEntity(action.type)]}全部记录`;
  if (target?.scope === "open") return `${entityLabels[actionTypeEntity(action.type)]}未关闭记录`;
  return [...(target?.codes || []), ...(target?.titles || []), ...(target?.names || []), target?.query || ""].filter(Boolean).join("、") || entityLabels[actionTypeEntity(action.type)];
}

function actionTypeEntity(type: AiProjectDataCommandAction["type"]): EntityType {
  if (type === "updateTasks") return "tasks";
  if (type === "createTasks") return "tasks";
  if (type === "updateScopeItems") return "scopeItems";
  if (type === "updateDeliverables") return "deliverables";
  if (type === "updateRisksIssues") return "risksIssues";
  if (type === "updateMilestones") return "milestones";
  return "project";
}

function textMatches(value: string, query: string) {
  const normalizedValue = normalizeText(value);
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return false;
  return normalizedValue === normalizedQuery || normalizedValue.includes(normalizedQuery) || (normalizedQuery.includes(normalizedValue) && normalizedValue.length >= 4);
}

function normalizeText(value: string) {
  return String(value || "").toLowerCase().replace(/\s+/g, "").replace(/[：:，,。.\-_/（）()]/g, "");
}

function extractJsonObject(raw: string) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const text = fenced || raw;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return "";
  return text.slice(start, end + 1);
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEntityType(value: unknown): value is EntityType {
  return value === "project" || value === "tasks" || value === "scopeItems" || value === "deliverables" || value === "risksIssues" || value === "milestones";
}

function isTaskStatus(value: string): value is TaskStatus {
  return value === "todo" || value === "doing" || value === "customer" || value === "blocked" || value === "done";
}

function assignString<T extends object>(target: T, source: Record<string, unknown>, field: string) {
  const value = stringValue(source[field]);
  if (value) (target as Record<string, unknown>)[field] = value;
}

function assignNumber<T extends object>(target: T, source: Record<string, unknown>, field: string, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  const parsed = numberValue(source[field]);
  if (parsed === null) return;
  (target as Record<string, unknown>)[field] = Math.max(min, Math.min(max, parsed));
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function primitiveValue(value: unknown): string | number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    if (isTaskStatus(value)) return statusLabels[value];
    return value;
  }
  return value === undefined || value === null ? "未设置" : String(value);
}

function stringifyValue(value: unknown) {
  return String(primitiveValue(value));
}

function normalizeDate(value: string) {
  const match = value.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$|^(\d{1,2})[-/](\d{1,2})$/);
  if (!match) return "";
  const year = match[1] || String(new Date().getFullYear());
  const month = match[2] || match[4];
  const day = match[3] || match[5];
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function shiftDate(value: string, days: number, months: number) {
  const normalized = normalizeDate(value);
  if (!normalized) return value;
  const [year, month, day] = normalized.split("-").map(Number);
  const date = new Date(year, month - 1 + months, day + days);
  return localDateKey(date);
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function cleanTail(value: string) {
  return value.replace(/[。；;，,]\s*$/, "").trim();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
