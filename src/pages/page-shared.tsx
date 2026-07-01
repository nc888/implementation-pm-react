import type { CSSProperties, JSX } from "react";
import type { AppState, Deliverable, Project, RiskIssue, ScopeItem, Task, TaskStatus } from "../types";
import {
  buildTaskTree,
  flattenTaskTree,
  isExecutableTask,
  projectDeliverables,
  projectRisks,
  projectScope,
  projectTasks,
  stageLabel,
  stageLabels,
  taskStatusLabels,
} from "../services/contextBuilder";
import type { TaskNode } from "../services/contextBuilder";

export const statusColumns: Array<[TaskStatus, string]> = [
  ["todo", "待处理"],
  ["doing", "进行中"],
  ["done", "已完成"],
  ["customer", "待客户"],
  ["blocked", "已阻塞"],
];

export const toneFor = (value: string) => {
  if (["健康", "低", "完成", "内部确认", "已确认"].includes(value)) return "success";
  if (["关注", "中", "待确认", "待签字", "待评审", "客户验收"].includes(value)) return "warning";
  if (["延期", "高", "阻塞", "未提交"].includes(value)) return "danger";
  return "primary";
};

export const searchQuery = (state: AppState) => state.ui.search.trim().toLowerCase();

export const includesQuery = (query: string, values: Array<string | number | undefined>) =>
  !query || values.some((value) => String(value ?? "").toLowerCase().includes(query));

export const taskMatchesSearch = (state: AppState, task: Task) => {
  const query = searchQuery(state);
  return includesQuery(query, [
    task.code,
    task.title,
    task.type,
    task.dimension,
    task.owner,
    task.priority,
    task.startDate,
    task.dueDate,
    taskStatusLabels[task.status],
    stageLabel(state, task.stage, task.projectId),
  ]);
};

export const deliverableMatchesSearch = (state: AppState, deliverable: Deliverable) => {
  const query = searchQuery(state);
  const linkedTask = deliverable.linkedTaskId ? state.tasks.find((task) => task.id === deliverable.linkedTaskId) : state.tasks.find((task) => task.code === deliverable.code);
  return includesQuery(query, [
    deliverable.name,
    deliverable.code,
    linkedTask?.code,
    linkedTask?.title,
    deliverable.status,
    deliverable.acceptance,
    deliverable.dueDate,
    deliverable.attachmentName,
    deliverable.attachmentPath,
  ]);
};

export const riskIssueMatchesSearch = (state: AppState, item: RiskIssue) => {
  const query = searchQuery(state);
  return includesQuery(query, [
    item.kind === "risk" ? "风险" : "问题",
    item.riskVisibility === "external" ? "外部" : "内部",
    item.title,
    item.severity,
    item.status,
    item.responsePlan,
  ]);
};

export const scopeItemMatchesSearch = (state: AppState, item: ScopeItem) => {
  const query = searchQuery(state);
  return includesQuery(query, [item.category, item.personDayType, item.title, item.description, item.content, item.estimatedPersonDays, item.actualPersonDays, item.progress]);
};

export const projectMatchesSearch = (state: AppState, project: Project) => {
  const query = searchQuery(state);
  if (!query) return true;
  return (
    includesQuery(query, [
      project.name,
      project.client,
      project.phase,
      project.health,
      project.owner,
      project.status === "archived" ? "已归档" : "在管",
      project.archivedAt,
      project.archiveReason,
      project.nextMilestone,
      project.description,
      project.estimatedImplementationPersonDays,
      project.estimatedDevelopmentPersonDays,
    ]) ||
    projectTasks(state, project.id).some((task) => taskMatchesSearch(state, task)) ||
    projectDeliverables(state, project.id).some((deliverable) => deliverableMatchesSearch(state, deliverable)) ||
    projectRisks(state, project.id).some((item) => riskIssueMatchesSearch(state, item)) ||
    projectScope(state, project.id).some((item) => scopeItemMatchesSearch(state, item))
  );
};

export const localDateKey = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const addDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

export const startOfLocalDay = (date = new Date()) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

export const currentWeekRange = () => {
  const today = startOfLocalDay();
  const day = today.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = addDays(today, mondayOffset);
  const end = addDays(start, 6);
  return {
    start: localDateKey(start),
    end: localDateKey(end),
  };
};

export const isOpenTask = (task: Task) => isExecutableTask(task) && task.status !== "done";
export const isOverdueTask = (task: Task, today = localDateKey()) => isOpenTask(task) && Boolean(task.dueDate) && task.dueDate < today;
export const isThisWeekTask = (task: Task, week = currentWeekRange()) =>
  isOpenTask(task) && Boolean(task.dueDate) && task.dueDate >= week.start && task.dueDate <= week.end;
export const isWeekFocusTask = (task: Task, week = currentWeekRange(), today = localDateKey()) => isOverdueTask(task, today) || isThisWeekTask(task, week);

export const isPendingDeliverable = (deliverable: Deliverable) => !["已验收", "内部确认"].includes(deliverable.acceptance);
export const isThisWeekDeliverable = (deliverable: Deliverable, week = currentWeekRange()) =>
  isPendingDeliverable(deliverable) && Boolean(deliverable.dueDate) && deliverable.dueDate >= week.start && deliverable.dueDate <= week.end;

export const formatShortDate = (dateKey: string) => (dateKey ? dateKey.slice(5).replace("-", "/") : "未定");

export const formatTaskRange = (task: Pick<Task, "startDate" | "dueDate">) => {
  if (!task.startDate && !task.dueDate) return "未定";
  return `${formatShortDate(task.startDate)} - ${formatShortDate(task.dueDate)}`;
};

export const taskStatusTone = (status: TaskStatus) => {
  if (status === "blocked") return "danger";
  if (status === "customer") return "warning";
  if (status === "done") return "success";
  return "primary";
};

export const riskStatusLabel = (status: RiskIssue["status"]) => {
  if (status === "open") return "打开";
  if (status === "tracking") return "跟踪";
  return "关闭";
};

export const riskVisibilityLabel = (visibility: RiskIssue["riskVisibility"]) => (visibility === "external" ? "外部" : "内部");

export const compareWorkItems = (a: Task, b: Task) => {
  const priorityWeight = { 高: 0, 中: 1, 低: 2 } as const;
  const statusWeight: Record<TaskStatus, number> = { blocked: 0, customer: 1, doing: 2, todo: 3, done: 4 };
  return (
    priorityWeight[a.priority] - priorityWeight[b.priority] ||
    statusWeight[a.status] - statusWeight[b.status] ||
    a.dueDate.localeCompare(b.dueDate)
  );
};

export const projectName = (state: AppState, projectId: string) => state.projects.find((project) => project.id === projectId)?.name || "未关联项目";

export const statusCssClass = (status: TaskStatus) => `status-${status}`;

export const taskKindLabel = (node: TaskNode) => (node.children.length ? `主任务 · ${node.children.length} 子任务` : node.parentId ? "子任务" : "主任务");

export const percentOf = (part: number, total: number) => (total ? Math.round((part / total) * 100) : 0);

export const allExpandedIds = (tasks: Task[]) => new Set(tasks.map((task) => task.id));

export function filterTaskNodes(state: AppState, nodes: TaskNode[]): TaskNode[] {
  if (!searchQuery(state)) return nodes;
  return nodes.flatMap((node) => {
    const children = filterTaskNodes(state, node.children);
    if (taskMatchesSearch(state, node) || children.length) {
      return [{ ...node, children }];
    }
    return [];
  });
}

export function flattenVisibleTaskNodes(state: AppState, tasks: Task[], collapsed: Set<string>) {
  const tree = filterTaskNodes(state, buildTaskTree(tasks));
  return flattenTaskTree(tree, expandedIdsFrom(tasks, collapsed));
}

export function toggleCollapsed(collapsed: Set<string>, taskId: string) {
  const next = new Set(collapsed);
  if (next.has(taskId)) {
    next.delete(taskId);
  } else {
    next.add(taskId);
  }
  return next;
}

export function expandedIdsFrom(tasks: Task[], collapsed: Set<string>) {
  return new Set(tasks.filter((task) => !collapsed.has(task.id)).map((task) => task.id));
}

export function RingChart({ value, label }: { value: number; label: string }) {
  return (
    <div className="ring-chart" style={{ "--value": value } as CSSProperties}>
      <div>
        <strong>{value}%</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

export function TaskTitleCell({
  node,
  collapsed,
  onToggle,
}: {
  node: TaskNode;
  collapsed: Set<string>;
  onToggle: (taskId: string) => void;
}) {
  return (
    <div className="tree-title" style={{ "--depth": node.depth } as CSSProperties}>
      <button className="tree-toggle" onClick={() => onToggle(node.id)} disabled={!node.children.length} aria-label={collapsed.has(node.id) ? "展开子任务" : "收起子任务"}>
        {node.children.length ? (collapsed.has(node.id) ? "+" : "-") : ""}
      </button>
      <div>
        <strong>{node.title}</strong>
        <span className="muted">
          {node.code} · {taskKindLabel(node)}
        </span>
      </div>
    </div>
  );
}

export function GanttTaskCell({
  node,
  collapsed,
  onToggle,
}: {
  node: TaskNode;
  collapsed: Set<string>;
  onToggle: (taskId: string) => void;
}) {
  return (
    <div className="gantt-task-cell" style={{ "--depth": node.depth } as CSSProperties}>
      <button className="tree-toggle" onClick={() => onToggle(node.id)} disabled={!node.children.length} aria-label={collapsed.has(node.id) ? "展开子任务" : "收起子任务"}>
        {node.children.length ? (collapsed.has(node.id) ? "+" : "-") : ""}
      </button>
      <div className="gantt-task-copy">
        <strong title={node.title}>{node.title}</strong>
        <span className="muted">
          {node.code} · {node.children.length ? `主任务 · ${node.children.length} 子任务` : node.parentId ? "子任务" : "主任务"}
        </span>
      </div>
    </div>
  );
}

export const tableSeparatorPattern = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

export function renderInlineMarkdown(text: string) {
  const nodes: Array<string | JSX.Element> = [];
  const pattern = /(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("**")) {
      nodes.push(<strong key={`b-${match.index}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("~~")) {
      nodes.push(<s key={`s-${match.index}`}>{token.slice(2, -2)}</s>);
    } else {
      nodes.push(<code key={`c-${match.index}`}>{token.slice(1, -1)}</code>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

export function parseMarkdownTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function isMarkdownTableStart(lines: string[], index: number) {
  return lines[index]?.includes("|") && tableSeparatorPattern.test(lines[index + 1] || "");
}

export function isRichBlockStart(lines: string[], index: number) {
  const line = lines[index] || "";
  return (
    !line.trim() ||
    /^#{1,4}\s+/.test(line) ||
    /^\d+[.)]\s+/.test(line) ||
    /^[-*]\s+/.test(line) ||
    isMarkdownTableStart(lines, index)
  );
}

export function RichMessage({ content, openTables = false }: { content: string; openTables?: boolean }) {
  const lines = content.split(/\r?\n/);
  const blocks: JSX.Element[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const header = parseMarkdownTableRow(lines[index]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|") && !tableSeparatorPattern.test(lines[index])) {
        rows.push(parseMarkdownTableRow(lines[index]));
        index += 1;
      }
      blocks.push(
        <details className="rich-table-card" key={`table-${blocks.length}`} open={openTables || rows.length <= 3}>
          <summary contentEditable={false}>
            <span>表格结果</span>
            <strong>{rows.length} 行</strong>
          </summary>
          <div className="rich-table-wrap">
            <table className="rich-table">
              <thead>
                <tr>
                  {header.map((cell, cellIndex) => (
                    <th key={`h-${cellIndex}`}>{renderInlineMarkdown(cell)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={`r-${rowIndex}`}>
                    {header.map((_, cellIndex) => (
                      <td key={`c-${rowIndex}-${cellIndex}`}>{renderInlineMarkdown(row[cellIndex] || "")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>,
      );
      continue;
    }

    const heading = trimmed.match(/^#{1,4}\s+(.+)$/);
    if (heading) {
      blocks.push(
        <h4 className="rich-heading" key={`heading-${blocks.length}`}>
          {renderInlineMarkdown(heading[1])}
        </h4>,
      );
      index += 1;
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = lines[index].trim().match(/^\d+[.)]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push(
        <ol className="rich-list" key={`ol-${blocks.length}`}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = lines[index].trim().match(/^[-*]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push(
        <ul className="rich-list" key={`ul-${blocks.length}`}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    const paragraph: string[] = [trimmed];
    index += 1;
    while (index < lines.length && !isRichBlockStart(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(
      <p key={`p-${blocks.length}`}>
        {renderInlineMarkdown(paragraph.join(" "))}
      </p>,
    );
  }

  return <div className="rich-message">{blocks}</div>;
}

export { stageLabels, taskStatusLabels } from "../services/contextBuilder";
