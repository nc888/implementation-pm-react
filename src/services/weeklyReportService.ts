import type { AppState, Project, ProjectImplementationMode, Task, WeeklyProjectStatus } from "../types";
import {
  calcProjectMetrics,
  calcProjectPersonDays,
  calcStageProgress,
  compareTasksByPlan,
  projectDeliverables,
  projectRisks,
  projectScope,
  projectTasks,
  stageLabel,
  taskStatusLabels,
} from "./contextBuilder";

export const weeklyImplementationModes: ProjectImplementationMode[] = ["本地实施", "出差实施"];
export const weeklyProjectStatuses: WeeklyProjectStatus[] = ["健康", "延期", "暂停", "需关注", "风险"];

export type DateRange = {
  start: string;
  end: string;
};

export type WeeklyReportBuildOptions = {
  reportDate: string;
  projectOwner?: string;
  implementationPersonnel?: string;
  implementationMode: ProjectImplementationMode;
  projectStatus: WeeklyProjectStatus;
  thisWeekTaskIds: string[];
  nextWeekTaskIds: string[];
};

export function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function weekRangeFor(date = new Date()): DateRange {
  const today = startOfLocalDay(date);
  const day = today.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = addDays(today, mondayOffset);
  return {
    start: localDateKey(start),
    end: localDateKey(addDays(start, 6)),
  };
}

export function nextWeekRangeFor(date = new Date()): DateRange {
  const week = weekRangeFor(date);
  const start = new Date(`${week.start}T00:00:00`);
  const nextStart = addDays(start, 7);
  return {
    start: localDateKey(nextStart),
    end: localDateKey(addDays(nextStart, 6)),
  };
}

export function formatDateShort(dateKey: string) {
  return dateKey ? dateKey.slice(5).replace("-", "/") : "未定";
}

export function formatDateRange(range: DateRange) {
  return `${formatDateShort(range.start)}-${formatDateShort(range.end)}`;
}

function isInRange(dateKey: string, range: DateRange) {
  return Boolean(dateKey && dateKey >= range.start && dateKey <= range.end);
}

export function getLeafSubtasks(state: AppState, projectId: string) {
  const tasks = projectTasks(state, projectId);
  const parentIds = new Set(tasks.map((task) => task.parentId).filter(Boolean));
  return tasks.filter((task) => task.parentId && !parentIds.has(task.id)).sort(compareTasksByPlan);
}

export function defaultThisWeekUpdatedTaskIds(state: AppState, projectId: string, week = weekRangeFor()) {
  return getLeafSubtasks(state, projectId)
    .filter((task) => isInRange((task.updatedAt || "").slice(0, 10), week))
    .filter((task) => task.progress > 0 || task.status !== "todo")
    .map((task) => task.id);
}

export function defaultNextWeekTaskIds(state: AppState, projectId: string, nextWeek = nextWeekRangeFor()) {
  return getLeafSubtasks(state, projectId)
    .filter((task) => task.status !== "done")
    .filter((task) => isInRange(task.startDate, nextWeek) || isInRange(task.dueDate, nextWeek))
    .map((task) => task.id);
}

export function tasksByIds(tasks: Task[], taskIds: string[]) {
  const order = new Map(taskIds.map((id, index) => [id, index]));
  return tasks
    .filter((task) => order.has(task.id))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0) || compareTasksByPlan(a, b));
}

function tableCell(value: string | number | undefined) {
  return String(value ?? "未维护")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "/")
    .trim() || "未维护";
}

function markdownTable(headers: string[], rows: Array<Array<string | number | undefined>>, emptyRow: Array<string | number | undefined>) {
  const normalizedRows = rows.length ? rows : [emptyRow];
  return [
    `| ${headers.map(tableCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...normalizedRows.map((row) => `| ${headers.map((_, index) => tableCell(row[index])).join(" | ")} |`),
  ].join("\n");
}

function taskRow(state: AppState, task: Task) {
  return [
    task.title,
    stageLabel(state, task.stage, task.projectId),
    task.owner || "未指派",
    taskStatusLabels[task.status],
    `${task.progress}%`,
  ];
}

function unfinishedTasks(tasks: Task[]) {
  return tasks.filter((task) => task.status !== "done");
}

function weeklyThisWeekTaskSection(state: AppState, tasks: Task[]) {
  return `## 六、本周工作内容
${markdownTable(
    ["任务名称", "阶段", "负责人", "状态", "进度"],
    tasks.map((task) => taskRow(state, task)),
    ["本周暂无工作内容", "-", "-", "-", "-"],
  )}`;
}

function weeklyNextWeekTaskSection(state: AppState, tasks: Task[]) {
  return `## 七、下周工作项
${markdownTable(
    ["任务名称", "阶段", "负责人", "状态", "进度"],
    unfinishedTasks(tasks).map((task) => taskRow(state, task)),
    ["下周暂无已计划的未完成子任务", "-", "-", "-", "-"],
  )}`;
}

function scopeRow(item: ReturnType<typeof projectScope>[number]) {
  return [
    item.category,
    item.title || item.content || "未命名范围",
    item.personDayType,
    `${item.progress}%`,
    item.estimatedPersonDays,
    item.actualPersonDays,
  ];
}

function riskStatusText(status: ReturnType<typeof projectRisks>[number]["status"]) {
  if (status === "open") return "打开";
  if (status === "tracking") return "跟踪";
  return "关闭";
}

export function isCustomerVisibleRiskIssue(item: ReturnType<typeof projectRisks>[number]) {
  return item.riskVisibility === "external" && item.status !== "closed";
}

function riskRow(item: ReturnType<typeof projectRisks>[number]) {
  const kind = item.kind === "risk" ? "风险" : "问题";
  const visibility = item.riskVisibility === "external" ? "外部" : "内部";
  const strike = (value: string) => (item.status === "closed" ? `~~${value}~~` : value);
  return [
    strike(kind),
    strike(visibility),
    strike(item.title),
    item.severity,
    riskStatusText(item.status),
    strike(item.responsePlan || "未维护"),
  ];
}

export function buildWeeklyMailSubject(project: Pick<Project, "name">, reportDate = localDateKey()) {
  return `【 项目周报 】${project.name}_${reportDate.replace(/-/g, "")}`;
}

export function buildWeeklyCustomerMailSubject(project: Pick<Project, "name">, reportDate = localDateKey()) {
  return `【 项目进展周报 】${project.name}_${reportDate.replace(/-/g, "")}`;
}

function isLegacyDefaultWeeklySubject(subject: string, project: Pick<Project, "name">, reportDate: string) {
  const compactDate = reportDate.replace(/-/g, "");
  return (
    subject === `${project.name} 周报 ${reportDate}` ||
    subject === `${project.name} 项目周报 ${reportDate}` ||
    subject === `${project.name} 周报 ${compactDate}` ||
    subject === `${project.name} 项目周报 ${compactDate}`
  );
}

export function normalizeWeeklyMailSubject(project: Pick<Project, "name">, reportDate: string, subject?: string) {
  const trimmed = (subject || "").trim();
  if (!trimmed || isLegacyDefaultWeeklySubject(trimmed, project, reportDate)) {
    return buildWeeklyMailSubject(project, reportDate);
  }
  return trimmed;
}

export function normalizeWeeklyCustomerMailSubject(project: Pick<Project, "name">, reportDate: string, subject?: string) {
  const trimmed = (subject || "").trim();
  if (!trimmed || isLegacyDefaultWeeklySubject(trimmed, project, reportDate)) {
    return buildWeeklyCustomerMailSubject(project, reportDate);
  }
  return trimmed;
}

const dueDateColumnLabels = new Set(["截止", "截止时间", "截止日期", "完成时间", "结束时间"]);
const taskCodeColumnLabels = new Set(["编号", "序号", "任务编号", "任务ID", "任务Id", "WBSID", "WBS ID", "ID", "id"]);

function parseMarkdownTableLine(line: string) {
  const trimmed = line.trim();
  const withoutLeadingPipe = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutOuterPipes = withoutLeadingPipe.endsWith("|") ? withoutLeadingPipe.slice(0, -1) : withoutLeadingPipe;
  return withoutOuterPipes.split("|").map((cell) => cell.trim());
}

function isMarkdownSeparatorLine(line: string) {
  const cells = parseMarkdownTableLine(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function isMarkdownTableAt(lines: string[], index: number) {
  return Boolean(lines[index]?.includes("|") && lines[index + 1]?.includes("|") && isMarkdownSeparatorLine(lines[index + 1]));
}

function renderMarkdownTableLine(cells: string[]) {
  return `| ${cells.join(" | ")} |`;
}

function stripTopLevelSectionByKeyword(content: string, keyword: string) {
  const lines = content.split(/\r?\n/);
  const nextLines: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const heading = lines[index].trim().match(/^##\s+(.+)$/);
    if (heading && heading[1].includes(keyword)) {
      index += 1;
      while (index < lines.length && !/^##\s+/.test(lines[index].trim())) index += 1;
      while (nextLines.length && !nextLines[nextLines.length - 1].trim()) nextLines.pop();
      nextLines.push("");
      continue;
    }
    nextLines.push(lines[index]);
    index += 1;
  }
  return nextLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function replaceTopLevelSectionByKeyword(content: string, keyword: string, replacement: string) {
  const lines = content.split(/\r?\n/);
  const nextLines: string[] = [];
  let replaced = false;
  let index = 0;
  while (index < lines.length) {
    const heading = lines[index].trim().match(/^##\s+(.+)$/);
    if (!replaced && heading && heading[1].includes(keyword)) {
      if (nextLines.length && nextLines[nextLines.length - 1].trim()) nextLines.push("");
      nextLines.push(replacement.trim());
      replaced = true;
      index += 1;
      while (index < lines.length && !/^##\s+/.test(lines[index].trim())) index += 1;
      while (index < lines.length && !lines[index].trim()) index += 1;
      continue;
    }
    nextLines.push(lines[index]);
    index += 1;
  }
  return nextLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function weeklyPersonDaySection(personDays: ReturnType<typeof calcProjectPersonDays>) {
  const implementationTotal = personDays.implementationEstimated || personDays.implementationBudget || 0;
  const developmentTotal = personDays.developmentEstimated || personDays.developmentBudget || 0;
  const projectTotal = personDays.estimated || personDays.projectBudget || 0;
  return `## 三、人天情况
${markdownTable(
    ["指标", "实施", "开发", "合计"],
    [
      ["人天消耗", `${personDays.implementationActual}/${implementationTotal} 人天`, `${personDays.developmentActual}/${developmentTotal} 人天`, `${personDays.actual}/${projectTotal} 人天`],
      ["使用率", `${personDays.implementationUsageRate}%`, `${personDays.developmentUsageRate}%`, `${personDays.usageRate}%`],
    ],
    ["暂无", "-", "-", "-"],
  )}`;
}

function weeklyProjectBasicInfoSection(project: Project, options: WeeklyReportBuildOptions) {
  const projectOwner = options.projectOwner || project.owner || "未维护";
  const implementationPersonnel = options.implementationPersonnel || project.owner || "未维护";
  return `## 二、项目基本信息
${markdownTable(
    ["项目名称", "实施人员", "实施方式", "项目经理", "当前阶段", "当前里程碑"],
    [[project.name, implementationPersonnel, options.implementationMode, projectOwner, project.phase || "未维护", project.nextMilestone || "未维护"]],
    ["未维护", "未维护", options.implementationMode, "未维护", "未维护", "未维护"],
  )}`;
}

function stripWeeklyReportTableColumns(lines: string[], startIndex: number, options: { removeTaskCodeColumns?: boolean } = {}) {
  const tableLines = [lines[startIndex], lines[startIndex + 1]];
  let index = startIndex + 2;
  while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
    tableLines.push(lines[index]);
    index += 1;
  }

  const headers = parseMarkdownTableLine(tableLines[0]);
  const removeIndexes = new Set(
    headers
      .map((header, columnIndex) => ({ header: header.replace(/\s|\*/g, ""), columnIndex }))
      .filter(({ header }) => dueDateColumnLabels.has(header) || Boolean(options.removeTaskCodeColumns && taskCodeColumnLabels.has(header)))
      .map(({ columnIndex }) => columnIndex),
  );
  if (!removeIndexes.size) return { nextIndex: index, tableLines };

  const keepIndexes = headers.map((_, columnIndex) => columnIndex).filter((columnIndex) => !removeIndexes.has(columnIndex));
  return {
    nextIndex: index,
    tableLines: tableLines.map((line, rowIndex) => {
      if (rowIndex === 1) return renderMarkdownTableLine(keepIndexes.map(() => "---"));
      const cells = parseMarkdownTableLine(line);
      return renderMarkdownTableLine(keepIndexes.map((columnIndex) => cells[columnIndex] || ""));
    }),
  };
}

function isWeeklyTaskSectionHeading(heading: string) {
  return /本周(?:更新了进度的子任务|工作内容|工作项)|下周(?:工作项|工作内容|计划)/.test(heading);
}

export function sanitizeWeeklyReportContent(content: string) {
  const lines = content.split(/\r?\n/);
  const nextLines: string[] = [];
  let index = 0;
  let hasSeenBody = false;
  let currentHeading = "";

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!hasSeenBody && !trimmed) {
      index += 1;
      continue;
    }

    const topTitle = trimmed.match(/^#\s+(.+)$/);
    if (!hasSeenBody && topTitle && /周报/.test(topTitle[1])) {
      index += 1;
      while (index < lines.length && !lines[index].trim()) index += 1;
      continue;
    }

    if (/^(报告日期|统计周期)：/.test(trimmed)) {
      index += 1;
      continue;
    }

    const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (heading) currentHeading = heading[1].trim();
    if (heading && /项目专家补充反馈/.test(heading[1])) {
      index += 1;
      while (index < lines.length && !/^#{1,6}\s+/.test(lines[index])) index += 1;
      while (index < lines.length && !lines[index].trim()) index += 1;
      continue;
    }

    if (heading?.[1].trim() === "阶段进度") {
      index += 1;
      while (index < lines.length && !lines[index].trim()) index += 1;
      if (isMarkdownTableAt(lines, index)) {
        index = stripWeeklyReportTableColumns(lines, index).nextIndex;
      }
      while (index < lines.length && !lines[index].trim()) index += 1;
      continue;
    }

    if (isMarkdownTableAt(lines, index)) {
      const table = stripWeeklyReportTableColumns(lines, index, { removeTaskCodeColumns: isWeeklyTaskSectionHeading(currentHeading) });
      nextLines.push(...table.tableLines);
      hasSeenBody = true;
      index = table.nextIndex;
      continue;
    }

    nextLines.push(line);
    if (trimmed) hasSeenBody = true;
    index += 1;
  }

  return nextLines
    .join("\n")
    .replace(/��发/g, "开发")
    .replace(/整体进度\s+(?!\*\*)(\d+(?:\.\d+)?)%/g, "整体进度 **$1%**")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function ensureWeeklyReportContentSchema(state: AppState, project: Project, options: WeeklyReportBuildOptions, content: string) {
  let nextContent = sanitizeWeeklyReportContent(content);
  if (!nextContent) return buildWeeklyReportContent(state, project, options);
  const leafSubtasks = getLeafSubtasks(state, project.id);
  const selectedNextWeek = unfinishedTasks(tasksByIds(leafSubtasks, options.nextWeekTaskIds));
  const metrics = calcProjectMetrics(state, project);

  const personDays = calcProjectPersonDays(state, project);
  if (/^##\s+三、人天、进度与状态总览/m.test(nextContent)) {
    nextContent = replaceTopLevelSectionByKeyword(
      nextContent,
      "人天、进度与状态总览",
      weeklyPersonDaySection(personDays),
    );
  }

  nextContent = stripTopLevelSectionByKeyword(nextContent, "进度与状态");
  nextContent = stripTopLevelSectionByKeyword(nextContent, "本周交付物更新情况");
  nextContent = replaceTopLevelSectionByKeyword(nextContent, "项目基本信息", weeklyProjectBasicInfoSection(project, options));

  nextContent = nextContent
    .replace(/^##\s+(?:四|五|六|七|八|九)、SOW 范围/gm, "## 四、SOW 范围")
    .replace(/^##\s+(?:五|六|七|八|九)、风险 \/ 问题项跟踪/gm, "## 五、风险 / 问题项跟踪")
    .replace(/^##\s+(?:六|七|八|九)、(?:本周更新了进度的子任务|本周工作内容)/gm, "## 六、本周工作内容")
    .replace(/^##\s+(?:七|八|九)、下周工作项/gm, "## 七、下周工作项");
  nextContent = replaceTopLevelSectionByKeyword(nextContent, "下周工作项", weeklyNextWeekTaskSection(state, selectedNextWeek));

  return nextContent
    .replace(/任务完成情况：已完成\s+\d+\/\d+\s+项，开放\s+\d+\s+项。/g, `任务完成情况：已完成 ${metrics.done}/${projectTasks(state, project.id).length} 项，${metrics.pendingDeliverables} 个交付物未更新状态。`)
    .replace(/下周计划推进\s+\d+\s+个子任务/g, `下周计划推进 ${selectedNextWeek.length} 个子任务`)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function customerStatusText(status: WeeklyProjectStatus) {
  if (status === "延期") return "存在延期风险";
  if (status === "暂停") return "暂停中";
  if (status === "需关注") return "需重点关注";
  if (status === "风险") return "存在风险";
  return "正常推进";
}

function customerProgressState(progress: number) {
  if (progress >= 100) return "已完成";
  if (progress > 0) return "推进中";
  return "待启动";
}

function shortList(items: string[], max = 4) {
  const normalized = items.map((item) => item.trim()).filter(Boolean);
  const visible = normalized.slice(0, max);
  if (!visible.length) return "";
  const hidden = normalized.length - visible.length;
  return hidden > 0 ? `${visible.join("、")}等 ${normalized.length} 项` : visible.join("、");
}

function customerTaskLabel(state: AppState, task: Task) {
  return `${task.title}（${stageLabel(state, task.stage, task.projectId)}）`;
}

function customerTaskSummary(state: AppState, tasks: Task[], max = 4) {
  return shortList(tasks.map((task) => customerTaskLabel(state, task)), max);
}

function customerStageSummary(state: AppState, tasks: Task[]) {
  const grouped = new Map<string, number>();
  tasks.forEach((task) => {
    const label = stageLabel(state, task.stage, task.projectId);
    grouped.set(label, (grouped.get(label) || 0) + 1);
  });
  return shortList([...grouped.entries()].map(([label, count]) => `${label} ${count} 项`), 3);
}

function isClosedDeliverable(item: ReturnType<typeof projectDeliverables>[number]) {
  return ["已归档", "已提交"].includes(item.status) || ["已验收", "内部确认"].includes(item.acceptance);
}

export function isCustomerConfirmationDeliverable(item: ReturnType<typeof projectDeliverables>[number]) {
  const customerState = /客户/.test(`${item.status} ${item.acceptance}`);
  const completed = ["已归档"].includes(item.status) || ["已验收", "内部确认"].includes(item.acceptance);
  return customerState && !completed;
}

function deliverableDate(item: ReturnType<typeof projectDeliverables>[number]) {
  return (item.attachmentUploadedAt || item.dueDate || "").slice(0, 10);
}

function customerDeliverableSummary(deliverables: ReturnType<typeof projectDeliverables>) {
  if (!deliverables.length) return "当前未维护交付物清单。";
  const closed = deliverables.filter(isClosedDeliverable);
  const pending = deliverables.filter((item) => !isClosedDeliverable(item));
  const pendingNames = shortList(pending.sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999")).map((item) => item.name), 4);
  return [
    `当前交付物共 ${deliverables.length} 项，已闭环 ${closed.length} 项，待确认 / 待验收 ${pending.length} 项。`,
    pendingNames ? `近期需关注 ${pendingNames}。` : "",
  ].filter(Boolean).join(" ");
}

function customerTaskPlanTarget(task: Task) {
  if (task.status === "customer") return "等待客户侧确认后继续推进";
  if (task.status === "blocked") return "解除阻塞后恢复推进";
  return "按计划推进并形成阶段结果";
}

function customerScopeRows(scopeItems: ReturnType<typeof projectScope>) {
  return scopeItems.map((item) => [
    item.title || item.content || "未命名范围",
    customerProgressState(item.progress),
    item.description || "按本期 SOW 范围推进",
  ]);
}

function customerAttentionRows(state: AppState, project: Project, nextWeek: DateRange) {
  const taskMap = new Map(projectTasks(state, project.id).map((task) => [task.id, task]));
  const customerBlockedTasks = getLeafSubtasks(state, project.id)
    .filter((task) => task.status === "customer" || task.status === "blocked")
    .sort(compareTasksByPlan)
    .slice(0, 4)
    .map((task) => [
      task.title,
      task.status === "customer" ? "请客户侧确认所需条件或反馈结果" : "请协助确认阻塞原因和恢复路径",
      "影响相关工作继续推进",
    ]);
  const pendingDeliverables = projectDeliverables(state, project.id)
    .filter(isCustomerConfirmationDeliverable)
    .sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"))
    .slice(0, 4);
  const riskRows = projectRisks(state, project.id)
    .filter(isCustomerVisibleRiskIssue)
    .slice(0, 3)
    .map((item) => [
      `${item.kind === "risk" ? "风险" : "问题"}：${item.title}`,
      item.responsePlan || "请客户侧协助确认相关条件",
      item.severity === "高" ? "可能影响关键节点，需优先处理" : "需持续关注，避免影响后续推进",
    ]);
  const deliverableRows = pendingDeliverables.map((item) => [
    item.name,
    `请协助确认${item.dueDate ? `（计划 ${formatDateShort(item.dueDate)} 前）` : ""}`,
    item.linkedTaskId && taskMap.get(item.linkedTaskId) ? "用于支撑关联工作闭环" : "用于支撑后续确认与验收闭环",
  ]);
  return [...riskRows, ...customerBlockedTasks, ...deliverableRows].slice(0, 8);
}

function customerPlanRows(state: AppState, project: Project, options: WeeklyReportBuildOptions) {
  const leafSubtasks = getLeafSubtasks(state, project.id);
  const explicitTasks = unfinishedTasks(tasksByIds(leafSubtasks, options.nextWeekTaskIds));
  const plannedTasks = explicitTasks;
  if (plannedTasks.length) {
    return plannedTasks.map((task) => [
      task.title,
      stageLabel(state, task.stage, task.projectId),
      customerTaskPlanTarget(task),
    ]);
  }
  return [];
}

function customerWorkRows(state: AppState, project: Project, options: WeeklyReportBuildOptions) {
  const leafSubtasks = getLeafSubtasks(state, project.id);
  const selectedTasks = tasksByIds(leafSubtasks, options.thisWeekTaskIds);
  return selectedTasks.map((task) => {
    const note =
      task.status === "done"
        ? "已完成阶段处理，并进入后续确认或衔接"
        : task.status === "customer"
          ? "已推进至客户侧确认环节，待反馈后继续闭环"
          : task.status === "blocked"
            ? "推进中存在待协同事项，项目组将持续跟进"
            : "本周已推进，后续按计划继续同步";
    return [task.title, stageLabel(state, task.stage, task.projectId), note];
  });
}

function customerAttentionSection(state: AppState, project: Project, nextWeek: DateRange) {
  return `## 二、需客户关注 / 配合事项
${markdownTable(
    ["事项", "期望配合", "影响说明"],
    customerAttentionRows(state, project, nextWeek),
    ["暂无", "暂无需客户配合事项", "-"],
  )}`;
}

function customerNextPlanSection(state: AppState, project: Project, options: WeeklyReportBuildOptions) {
  return `## 三、下周计划
${markdownTable(
    ["计划事项", "所属阶段", "计划目标"],
    customerPlanRows(state, project, options),
    ["暂无", "待确认", "下周计划待进一步确认"],
  )}`;
}

export function ensureCustomerWeeklyReportContentSchema(state: AppState, project: Project, options: WeeklyReportBuildOptions, content: string) {
  let nextContent = sanitizeWeeklyReportContent(content);
  if (!nextContent) return buildCustomerWeeklyReportContent(state, project, options);
  const reportDateObject = new Date(`${options.reportDate}T00:00:00`);
  const nextWeek = nextWeekRangeFor(reportDateObject);
  nextContent = stripTopLevelSectionByKeyword(nextContent, "风险");
  nextContent = replaceTopLevelSectionByKeyword(nextContent, "需客户关注", customerAttentionSection(state, project, nextWeek));
  nextContent = replaceTopLevelSectionByKeyword(nextContent, "下周计划", customerNextPlanSection(state, project, options));
  return nextContent.replace(/^##\s+四、下周计划/gm, "## 三、下周计划").trim();
}

export function buildCustomerWeeklyReportContent(state: AppState, project: Project, options: WeeklyReportBuildOptions) {
  const reportDateObject = new Date(`${options.reportDate}T00:00:00`);
  const nextWeek = nextWeekRangeFor(reportDateObject);
  const workRows = customerWorkRows(state, project, options);

  return `## 一、本周工作内容
${markdownTable(
    ["工作内容", "所属阶段", "本周说明"],
    workRows,
    ["暂无", "待确认", "本周工作内容待进一步确认"],
  )}

${customerAttentionSection(state, project, nextWeek)}

${customerNextPlanSection(state, project, options)}`;
}

export function buildWeeklyReportContent(state: AppState, project: Project, options: WeeklyReportBuildOptions) {
  const leafSubtasks = getLeafSubtasks(state, project.id);
  const selectedThisWeek = tasksByIds(leafSubtasks, options.thisWeekTaskIds);
  const selectedNextWeek = unfinishedTasks(tasksByIds(leafSubtasks, options.nextWeekTaskIds));
  const metrics = calcProjectMetrics(state, project);
  const personDays = calcProjectPersonDays(state, project);
  const stageStats = calcStageProgress(state, project).filter((stage) => stage.total > 0);
  const currentStage = stageStats.length
    ? [...stageStats].sort((a, b) => b.progress - a.progress || b.total - a.total)[0]
    : null;
  const scopeItems = projectScope(state, project.id);
  const allRisks = projectRisks(state, project.id);
  const statusSummary = [
    `本周项目状态为 **${options.projectStatus}**，整体进度 **${metrics.completionRate}%**。`,
    `任务完成情况：已完成 ${metrics.done}/${projectTasks(state, project.id).length} 项，${metrics.pendingDeliverables} 个交付物未更新状态。`,
    `当前阶段为 **${project.phase || currentStage?.label || "未维护"}**，当前里程碑为 **${project.nextMilestone || "未维护"}**。`,
    `本周已纳入 ${selectedThisWeek.length} 个进度更新子任务，下周计划推进 ${selectedNextWeek.length} 个子任务。`,
  ].join(" ");

  return `## 一、执行摘要
${statusSummary}

${weeklyProjectBasicInfoSection(project, options)}

## 三、人天情况
${weeklyPersonDaySection(personDays).replace(/^##\s+三、人天情况\n/, "")}

## 四、SOW 范围
${markdownTable(
    ["范围类别", "范围内容", "人天类型", "进度", "预估人天", "实际人天"],
    scopeItems.map(scopeRow),
    ["暂无", "暂无 SOW 范围记录", "-", "-", "-", "-"],
  )}

## 五、风险 / 问题项跟踪
${markdownTable(
    ["类型", "可见性", "标题", "等级", "状态", "应对 / 下一步"],
    allRisks.map(riskRow),
    ["暂无", "-", "暂无风险 / 问题记录", "-", "-", "-"],
  )}

${weeklyThisWeekTaskSection(state, selectedThisWeek)}

${weeklyNextWeekTaskSection(state, selectedNextWeek)}`;
}
