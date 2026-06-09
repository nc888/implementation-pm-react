import type { AppState, Project, ProjectImplementationMode, Task, WeeklyProjectStatus } from "../types";
import {
  calcProjectMetrics,
  calcProjectPersonDays,
  calcStageProgress,
  compareTasksByPlan,
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
    `${item.actualPersonDays}/${item.estimatedPersonDays}`,
  ];
}

function riskStatusText(status: ReturnType<typeof projectRisks>[number]["status"]) {
  if (status === "open") return "打开";
  if (status === "tracking") return "跟踪";
  return "关闭";
}

function riskRow(item: ReturnType<typeof projectRisks>[number]) {
  const kind = item.kind === "risk" ? "风险" : "问题";
  return [kind, item.title, item.severity, riskStatusText(item.status), item.responsePlan || "未维护"];
}

export function buildWeeklyMailSubject(project: Project, reportDate = localDateKey()) {
  return `【 项目周报 】${project.name}_${reportDate.replace(/-/g, "")}`;
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

export function normalizeWeeklyMailSubject(project: Project, reportDate: string, subject?: string) {
  const trimmed = (subject || "").trim();
  if (!trimmed || isLegacyDefaultWeeklySubject(trimmed, project, reportDate)) {
    return buildWeeklyMailSubject(project, reportDate);
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

  nextContent = nextContent
    .replace(/^##\s+(?:四|五|六|七|八|九)、SOW 范围/gm, "## 四、SOW 范围")
    .replace(/^##\s+(?:五|六|七|八|九)、风险 \/ 问题项跟踪/gm, "## 五、风险 / 问题项跟踪")
    .replace(/^##\s+(?:六|七|八|九)、(?:本周更新了进度的子任务|本周工作内容)/gm, "## 六、本周工作内容")
    .replace(/^##\s+(?:七|八|九)、下周工作项/gm, "## 七、下周工作项");
  nextContent = replaceTopLevelSectionByKeyword(nextContent, "下周工作项", weeklyNextWeekTaskSection(state, selectedNextWeek));

  return nextContent
    .replace(/下周计划推进\s+\d+\s+个子任务/g, `下周计划推进 ${selectedNextWeek.length} 个子任务`)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  const openRisks = projectRisks(state, project.id).filter((item) => item.status !== "closed");
  const projectOwner = options.projectOwner || project.owner || "未维护";
  const statusSummary = [
    `本周项目状态为 **${options.projectStatus}**，整体进度 **${metrics.completionRate}%**。`,
    `任务完成情况：已完成 ${metrics.done}/${projectTasks(state, project.id).length} 项，开放 ${metrics.open} 项。`,
    `当前阶段为 **${project.phase || currentStage?.label || "未维护"}**，当前里程碑为 **${project.nextMilestone || "未维护"}**。`,
    `本周已纳入 ${selectedThisWeek.length} 个进度更新子任务，下周计划推进 ${selectedNextWeek.length} 个子任务。`,
  ].join("\n");

  return `## 一、执行摘要
${statusSummary}

## 二、项目基本信息
${markdownTable(
    ["项目名称", "客户名称", "实施方式", "负责人", "当前阶段", "当前里程碑", "项目状态"],
    [[project.name, project.client, options.implementationMode, projectOwner, project.phase || "未维护", project.nextMilestone || "未维护", options.projectStatus]],
    ["未维护", "未维护", options.implementationMode, "未维护", "未维护", "未维护", options.projectStatus],
  )}

## 三、人天情况
${weeklyPersonDaySection(personDays).replace(/^##\s+三、人天情况\n/, "")}

## 四、SOW 范围
${markdownTable(
    ["范围类别", "范围项", "人天类型", "进度", "人天消耗"],
    scopeItems.map(scopeRow),
    ["暂无", "暂无 SOW 范围记录", "-", "-", "-"],
  )}

## 五、风险 / 问题项跟踪
${markdownTable(
    ["类型", "标题", "等级", "状态", "应对 / 下一步"],
    openRisks.map(riskRow),
    ["暂无", "暂无打开或跟踪中的风险 / 问题", "-", "-", "-"],
  )}

${weeklyThisWeekTaskSection(state, selectedThisWeek)}

${weeklyNextWeekTaskSection(state, selectedNextWeek)}`;
}
