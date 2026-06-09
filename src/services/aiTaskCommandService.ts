import type { AppState, AssistantScope, Project, Task, TaskStatus } from "../types";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type AiTaskCommandAction = {
  type: "updateTasks";
  target?: {
    scope?: "all" | "open" | "matching";
    query?: string;
    codes?: string[];
    titles?: string[];
  };
  changes?: {
    status?: TaskStatus;
    startDate?: string;
    dueDate?: string;
    startShiftDays?: number;
    dueShiftDays?: number;
    startShiftMonths?: number;
    dueShiftMonths?: number;
    progress?: number;
    owner?: string;
  };
};

export type AiTaskCommandPlan = {
  mode: "execute" | "answer";
  reply?: string;
  actions: AiTaskCommandAction[];
};

export type AiTaskCommandExecution = {
  state: AppState;
  changedTasks: Array<{
    code: string;
    title: string;
    projectName: string;
    fields: string[];
    before: Pick<Task, "status" | "startDate" | "dueDate" | "progress" | "owner">;
    after: Pick<Task, "status" | "startDate" | "dueDate" | "progress" | "owner">;
  }>;
  unmatchedTargets: string[];
};

const statusLabels: Record<TaskStatus, string> = {
  todo: "待处理",
  doing: "进行中",
  customer: "待客户",
  blocked: "已阻塞",
  done: "已完成",
};

const reverseStatusLabels: Array<[RegExp, TaskStatus]> = [
  [/已完成|完成|done/i, "done"],
  [/进行中|处理中|开始处理|doing|in progress/i, "doing"],
  [/待客户|客户待确认|客户确认|customer/i, "customer"],
  [/阻塞|已阻塞|blocked/i, "blocked"],
  [/待处理|待办|未开始|todo/i, "todo"],
];

export function looksLikeTaskCommandRequest(question: string) {
  const text = question.trim();
  if (!text) return false;
  const hasChangeVerb = /改|调整|更新|变更|设置|设为|改为|标记|延期|推迟|提前|顺延|完成|关闭|开始处理/.test(text);
  const hasTaskSignal = /任务|事项|WBS|里程碑|所有|全部|当前项目|进度|状态|开始|截止|完成时间|结束时间|dueDate|startDate/i.test(text);
  return hasChangeVerb && hasTaskSignal;
}

export function buildTaskCommandExtractionMessages(state: AppState, project: Project, question: string, scope: AssistantScope = "project"): ChatMessage[] {
  const projectNameById = new Map(state.projects.map((item) => [item.id, item.name]));
  const tasks = state.tasks
    .filter((task) => scope === "all" || task.projectId === project.id)
    .slice(0, 120)
    .map(
      (task) =>
        `[${projectNameById.get(task.projectId) || task.projectId}] ${task.code} | ${task.title} | status=${task.status} | startDate=${task.startDate || "-"} | dueDate=${task.dueDate || "-"} | progress=${task.progress}% | owner=${task.owner}`,
    )
    .join("\n");

  return [
    {
      role: "system",
      content: [
        "你是项目管理系统的数据变更指令解析器。只输出 JSON，不要输出 Markdown、解释或代码块。",
        "只有当用户明确要求修改任务数据时才返回 mode=execute；普通问答返回 mode=answer 且 actions=[]。",
        "允许动作只有 updateTasks。可修改字段：status、startDate、dueDate、progress、owner；可做日期偏移：startShiftDays、dueShiftDays、startShiftMonths、dueShiftMonths。",
        "状态枚举只能是 todo、doing、customer、blocked、done。",
        "日期必须是 YYYY-MM-DD。用户只写 MM-DD 时使用当前年份。用户说推迟/延期/顺延为正数，提前为负数。",
        "用户说完成时间、截止时间、结束时间、dueDate 时只改 dueDate。用户说开始时间、startDate 时只改 startDate。用户说排期或任务时间且未限定字段时同时改 startDate 和 dueDate。",
        "目标规则：所有任务/全部任务使用 target.scope=all；未完成任务使用 target.scope=open；指定任务时使用 target.scope=matching，并尽量填 codes 或 titles。当前范围为所有项目时，target.scope=all 表示全平台所有项目任务。",
        "返回格式：{\"mode\":\"execute\",\"reply\":\"简短说明\",\"actions\":[{\"type\":\"updateTasks\",\"target\":{\"scope\":\"all\"},\"changes\":{\"dueShiftMonths\":1}}]}",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `当前日期：${localDateKey()}`,
        `当前范围：${scope === "all" ? "所有项目" : "当前项目"}`,
        `当前项目：${project.name}`,
        "任务清单：",
        tasks || "无任务",
        "",
        `用户指令：${question}`,
      ].join("\n"),
    },
  ];
}

export function parseTaskCommandPlan(raw: string): AiTaskCommandPlan | null {
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

export function inferRuleBasedTaskCommandPlan(question: string): AiTaskCommandPlan | null {
  if (!looksLikeTaskCommandRequest(question)) return null;
  const text = question.trim();
  const status = parseStatus(text);
  const progress = parseProgress(text);
  const exactDate = parseDateAssignment(text);
  const duration = parseDurationShift(text);
  const target = parseTarget(text);

  const changes: AiTaskCommandAction["changes"] = {};
  if (status) changes.status = status;
  if (typeof progress === "number") changes.progress = progress;
  if (exactDate) {
    if (exactDate.field === "startDate") changes.startDate = exactDate.date;
    if (exactDate.field === "dueDate") changes.dueDate = exactDate.date;
  }
  if (duration) {
    const dateScope = parseDateScope(text);
    if (dateScope === "start" || dateScope === "both") {
      changes.startShiftDays = duration.days;
      changes.startShiftMonths = duration.months;
    }
    if (dateScope === "due" || dateScope === "both") {
      changes.dueShiftDays = duration.days;
      changes.dueShiftMonths = duration.months;
    }
  }

  if (!Object.keys(changes).length) return null;
  return {
    mode: "execute",
    reply: "已识别为任务变更指令。",
    actions: [
      {
        type: "updateTasks",
        target,
        changes,
      },
    ],
  };
}

export function applyTaskCommandPlan(state: AppState, projectId: string | "all", plan: AiTaskCommandPlan): AiTaskCommandExecution {
  const now = new Date().toISOString();
  const projectTasks = state.tasks.filter((task) => projectId === "all" || task.projectId === projectId);
  const projectNameById = new Map(state.projects.map((item) => [item.id, item.name]));
  const changedById = new Map<string, AiTaskCommandExecution["changedTasks"][number]>();
  const unmatchedTargets: string[] = [];
  const normalizedActions = normalizeActions(plan.actions);
  const selectedByAction = normalizedActions.map((action) => {
    const selected = selectTasks(projectTasks, action.target);
    if (!selected.length) unmatchedTargets.push(describeTarget(action.target));
    return { action, ids: new Set(selected.map((task) => task.id)) };
  });

  const tasks = state.tasks.map((task) => {
    if (projectId !== "all" && task.projectId !== projectId) return task;
    let next = task;
    const before = taskSnapshot(task);
    const fields = new Set<string>();
    for (const { action, ids } of selectedByAction) {
      if (!ids.has(task.id)) continue;
      const updated = applyTaskChanges(next, action.changes || {});
      if (updated !== next) {
        next = updated;
        Object.keys(action.changes || {}).forEach((field) => fields.add(field));
      }
    }
    if (next === task) return task;
    next = { ...next, updatedAt: now };
    const after = taskSnapshot(next);
    changedById.set(task.id, {
      code: task.code,
      title: task.title,
      projectName: projectNameById.get(task.projectId) || task.projectId,
      fields: changedFields(before, after, fields),
      before,
      after,
    });
    return next;
  });

  return {
    state: { ...state, tasks },
    changedTasks: [...changedById.values()],
    unmatchedTargets,
  };
}

export function formatTaskCommandResult(plan: AiTaskCommandPlan, execution: AiTaskCommandExecution) {
  if (!execution.changedTasks.length) {
    const targetText = execution.unmatchedTargets.length ? `\n\n未匹配目标：${execution.unmatchedTargets.join("、")}` : "";
    return `${plan.reply || "我识别到了任务变更意图，但没有找到可更新的任务。"}${targetText}`;
  }

  const preview = execution.changedTasks.slice(0, 12).map((item) => {
    const details = item.fields
      .map((field) => `${fieldLabel(field)}：${formatFieldValue(field, item.before)} → ${formatFieldValue(field, item.after)}`)
      .join("；");
    return `- ${item.projectName ? `【${item.projectName}】` : ""}${item.code} ${item.title}：${details}`;
  });
  const hidden = execution.changedTasks.length > preview.length ? `\n- 另有 ${execution.changedTasks.length - preview.length} 个任务已更新。` : "";
  const unmatched = execution.unmatchedTargets.length ? `\n\n未匹配目标：${execution.unmatchedTargets.join("、")}` : "";
  return `${plan.reply || "已按你的指令直接更新任务数据。"}\n\n已更新 ${execution.changedTasks.length} 个任务：\n${preview.join("\n")}${hidden}${unmatched}`;
}

function normalizeActions(actions: unknown): AiTaskCommandAction[] {
  if (!Array.isArray(actions)) return [];
  return actions
    .filter((action): action is AiTaskCommandAction => Boolean(action && typeof action === "object" && (action as AiTaskCommandAction).type === "updateTasks"))
    .map((action) => ({
      type: "updateTasks" as const,
      target: normalizeTarget(action.target),
      changes: normalizeChanges(action.changes),
    }))
    .filter((action) => Object.keys(action.changes || {}).length > 0);
}

function normalizeTarget(target: AiTaskCommandAction["target"]): AiTaskCommandAction["target"] {
  const scope = target?.scope === "all" || target?.scope === "open" || target?.scope === "matching" ? target.scope : "matching";
  return {
    scope,
    query: typeof target?.query === "string" ? target.query.trim() : "",
    codes: Array.isArray(target?.codes) ? target.codes.map(String).map((value) => value.trim()).filter(Boolean) : [],
    titles: Array.isArray(target?.titles) ? target.titles.map(String).map((value) => value.trim()).filter(Boolean) : [],
  };
}

function normalizeChanges(changes: AiTaskCommandAction["changes"]): AiTaskCommandAction["changes"] {
  const next: AiTaskCommandAction["changes"] = {};
  if (!changes) return next;
  if (changes.status && isTaskStatus(changes.status)) next.status = changes.status;
  if (typeof changes.startDate === "string") next.startDate = normalizeDate(changes.startDate) || undefined;
  if (typeof changes.dueDate === "string") next.dueDate = normalizeDate(changes.dueDate) || undefined;
  if (typeof changes.startShiftDays === "number" && Number.isFinite(changes.startShiftDays)) next.startShiftDays = Math.trunc(changes.startShiftDays);
  if (typeof changes.dueShiftDays === "number" && Number.isFinite(changes.dueShiftDays)) next.dueShiftDays = Math.trunc(changes.dueShiftDays);
  if (typeof changes.startShiftMonths === "number" && Number.isFinite(changes.startShiftMonths)) next.startShiftMonths = Math.trunc(changes.startShiftMonths);
  if (typeof changes.dueShiftMonths === "number" && Number.isFinite(changes.dueShiftMonths)) next.dueShiftMonths = Math.trunc(changes.dueShiftMonths);
  if (typeof changes.progress === "number" && Number.isFinite(changes.progress)) next.progress = clampProgress(changes.progress);
  if (typeof changes.owner === "string" && changes.owner.trim()) next.owner = changes.owner.trim();
  return next;
}

function applyTaskChanges(task: Task, changes: AiTaskCommandAction["changes"]) {
  let next = task;
  const patch: Partial<Task> = {};
  if (changes?.status) patch.status = changes.status;
  if (typeof changes?.progress === "number") patch.progress = clampProgress(changes.progress);
  if (changes?.owner) patch.owner = changes.owner;
  if (changes?.startDate) patch.startDate = changes.startDate;
  if (changes?.dueDate) patch.dueDate = changes.dueDate;
  if ((changes?.startShiftDays || changes?.startShiftMonths) && task.startDate) {
    patch.startDate = shiftDate(task.startDate, changes.startShiftDays || 0, changes.startShiftMonths || 0);
  }
  if ((changes?.dueShiftDays || changes?.dueShiftMonths) && task.dueDate) {
    patch.dueDate = shiftDate(task.dueDate, changes.dueShiftDays || 0, changes.dueShiftMonths || 0);
  }
  if (Object.keys(patch).length) next = { ...next, ...patch };
  if (next.status === "done") next = { ...next, progress: 100 };
  return next;
}

function selectTasks(tasks: Task[], target: AiTaskCommandAction["target"]) {
  if (target?.scope === "all") return tasks;
  if (target?.scope === "open") return tasks.filter((task) => task.status !== "done");

  const queries = [...(target?.codes || []), ...(target?.titles || []), target?.query || ""].filter(Boolean);
  if (!queries.length) return [];
  return tasks.filter((task) => queries.some((query) => matchesTask(task, query)));
}

function matchesTask(task: Task, query: string) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return false;
  if (normalizeText(task.code) === normalizedQuery) return true;
  if (normalizeText(task.title).includes(normalizedQuery)) return true;
  if (normalizedQuery.includes(normalizeText(task.title)) && normalizeText(task.title).length >= 4) return true;
  return false;
}

function parseTarget(text: string): AiTaskCommandAction["target"] {
  if (/所有任务|全部任务|当前项目.*任务|所有事项|全部事项/.test(text)) return { scope: "all" };
  if (/未完成任务|未完成事项|打开的任务|未关闭任务/.test(text)) return { scope: "open" };
  const quoted = text.match(/[「“"]([^」”"]{2,80})[」”"]/);
  if (quoted?.[1]) return { scope: "matching", query: quoted[1].trim(), titles: [quoted[1].trim()] };
  const code = text.match(/\b(?:WBS-\d+(?:\.\d+)?|\d+(?:\.\d+)*)\b/i);
  if (code?.[0]) return { scope: "matching", codes: [code[0]] };
  const beforeVerb = text.match(/(?:把|将)(.+?)(?:任务|事项)?(?:的)?(?:状态|进度|开始|截止|完成时间|结束时间|改|调整|设为|标记)/);
  const query = beforeVerb?.[1]?.replace(/当前项目|这个项目/g, "").trim();
  return { scope: "matching", query: query || "" };
}

function parseStatus(text: string): TaskStatus | null {
  const statusIntent =
    /状态|改成|改为|设为|标记|置为|关闭|开始处理|阻塞/.test(text) ||
    (/(?:把|将).+(?:任务|事项)?.*(?:完成|关闭)/.test(text) && !/完成时间|截止时间|结束时间/.test(text));
  if (!statusIntent) return null;
  for (const [pattern, status] of reverseStatusLabels) {
    if (pattern.test(text)) return status;
  }
  return null;
}

function parseProgress(text: string) {
  const match = text.match(/进度(?:改成|改为|调整到|设为|到)?\s*(\d{1,3})\s*%?/);
  if (!match) return null;
  return clampProgress(Number(match[1]));
}

function parseDateAssignment(text: string) {
  const date = text.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2})/)?.[1];
  if (!date || !/(改到|调整到|设为|改为|到|定为)/.test(text)) return null;
  const normalized = normalizeDate(date);
  if (!normalized) return null;
  return { field: /开始|startDate/i.test(text) ? ("startDate" as const) : ("dueDate" as const), date: normalized };
}

function parseDateScope(text: string): "start" | "due" | "both" {
  if (/开始|startDate/i.test(text) && !/截止|完成|结束|dueDate/i.test(text)) return "start";
  if (/截止|完成时间|结束时间|dueDate/i.test(text)) return "due";
  return "both";
}

function parseDurationShift(text: string) {
  const sign = /提前/.test(text) ? -1 : 1;
  if (!/(延期|推迟|顺延|提前)/.test(text)) return null;
  const monthMatch = text.match(/(\d+|一|两|二|三|四|五|六|七|八|九|十)\s*个?月/);
  if (monthMatch) return { days: 0, months: sign * chineseNumber(monthMatch[1]) };
  const dayMatch = text.match(/(\d+|一|两|二|三|四|五|六|七|八|九|十)\s*天/);
  if (dayMatch) return { days: sign * chineseNumber(dayMatch[1]), months: 0 };
  return null;
}

function changedFields(
  before: Pick<Task, "status" | "startDate" | "dueDate" | "progress" | "owner">,
  after: Pick<Task, "status" | "startDate" | "dueDate" | "progress" | "owner">,
  requested: Set<string>,
) {
  const fields = ["status", "startDate", "dueDate", "progress", "owner"].filter((field) => before[field as keyof typeof before] !== after[field as keyof typeof after]);
  if (fields.length) return fields;
  return [...requested];
}

function taskSnapshot(task: Task) {
  return {
    status: task.status,
    startDate: task.startDate,
    dueDate: task.dueDate,
    progress: task.progress,
    owner: task.owner,
  };
}

function fieldLabel(field: string) {
  if (field === "status") return "状态";
  if (field === "startDate" || field === "startShiftDays" || field === "startShiftMonths") return "开始日期";
  if (field === "dueDate" || field === "dueShiftDays" || field === "dueShiftMonths") return "截止日期";
  if (field === "progress") return "进度";
  if (field === "owner") return "负责人";
  return field;
}

function formatFieldValue(field: string, value: Pick<Task, "status" | "startDate" | "dueDate" | "progress" | "owner">) {
  if (field === "status") return statusLabels[value.status];
  if (field === "progress") return `${value.progress}%`;
  if (field === "owner") return value.owner || "未定";
  if (field === "startDate" || field === "startShiftDays" || field === "startShiftMonths") return value.startDate || "未定";
  if (field === "dueDate" || field === "dueShiftDays" || field === "dueShiftMonths") return value.dueDate || "未定";
  return "";
}

function describeTarget(target: AiTaskCommandAction["target"]) {
  if (target?.scope === "all") return "所有任务";
  if (target?.scope === "open") return "未完成任务";
  return [...(target?.codes || []), ...(target?.titles || []), target?.query || ""].filter(Boolean).join("、") || "未指定任务";
}

function extractJsonObject(raw: string) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const text = fenced || raw;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return "";
  return text.slice(start, end + 1);
}

function isTaskStatus(value: string): value is TaskStatus {
  return ["todo", "doing", "customer", "blocked", "done"].includes(value);
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/\s+/g, "").replace(/[：:，,。.\-_/]/g, "");
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

function clampProgress(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function chineseNumber(value: string) {
  if (/^\d+$/.test(value)) return Number(value);
  const map: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  return map[value] || 1;
}
