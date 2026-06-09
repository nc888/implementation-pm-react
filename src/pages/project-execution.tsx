import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  ArrowLeft,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  ClipboardList,
  Clock,
  FolderOpen,
  Eye,
  History,
  Mail,
  Maximize2,
  Minimize2,
  Paperclip,
  PencilLine,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Upload,
  UserCircle,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type {
  AppState,
  Deliverable,
  PageKey,
  ProjectImplementationMode,
  RiskIssue,
  ScopeItem,
  Task,
  TaskStatus,
  WeeklyProjectStatus,
  WeeklyReportInput,
  WeeklyReportPreferenceInput,
} from "../types";
import {
  buildTaskTree,
  calcProjectMetrics,
  calcProjectPersonDays,
  calcStageProgress,
  calcScopePersonDays,
  compareTasksByPlan,
  flattenTaskTree,
  getProject,
  projectDeliverables,
  projectRisks,
  projectScope,
  projectTasks,
  stageDefinitionsForProject,
  stageLabel,
  stageOrderForState,
} from "../services/contextBuilder";
import {
  chooseDeliverableProjectDirectory,
  getCachedDeliverableDirectory,
  getDeliverableDirectoryPathLabel,
  loadDeliverableDirectoryHandle,
  saveDeliverableAttachmentFile,
} from "../services/deliverableFileStorage";
import type { LocalDirectoryHandle } from "../services/deliverableFileStorage";
import type { TaskNode } from "../services/contextBuilder";
import type { AiService } from "../services/aiService";
import { saveEmailDraft } from "../services/emailDraftService";
import {
  buildWeeklyMailSubject,
  buildWeeklyReportContent,
  defaultNextWeekTaskIds,
  defaultThisWeekUpdatedTaskIds,
  ensureWeeklyReportContentSchema,
  formatDateRange,
  getLeafSubtasks,
  nextWeekRangeFor,
  normalizeWeeklyMailSubject,
  sanitizeWeeklyReportContent,
  tasksByIds,
  weekRangeFor,
  weeklyImplementationModes,
  weeklyProjectStatuses,
} from "../services/weeklyReportService";
import { Badge, Button, Card, Metric, Progress } from "../components/ui";
import {
  allExpandedIds,
  compareWorkItems,
  currentWeekRange,
  deliverableMatchesSearch,
  filterTaskNodes,
  flattenVisibleTaskNodes,
  formatShortDate,
  formatTaskRange,
  isOverdueTask,
  isPendingDeliverable,
  isThisWeekDeliverable,
  isThisWeekTask,
  isWeekFocusTask,
  localDateKey,
  percentOf,
  projectMatchesSearch,
  projectName,
  RingChart,
  riskIssueMatchesSearch,
  riskStatusLabel,
  renderInlineMarkdown,
  isMarkdownTableStart,
  parseMarkdownTableRow,
  tableSeparatorPattern,
  scopeItemMatchesSearch,
  statusColumns,
  statusCssClass,
  taskKindLabel,
  taskStatusLabels,
  taskStatusTone,
  TaskTitleCell,
  GanttTaskCell,
  toggleCollapsed,
  toneFor,
} from "./page-shared";

function clampProgressInput(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
}

function canEditLeafSubtask(node: Pick<TaskNode, "parentId" | "children">) {
  return Boolean(node.parentId && !node.children.length);
}

function InlineProgressEditor({
  value,
  label,
  onCommit,
}: {
  value: number;
  label: string;
  onCommit: (progress: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [editing, value]);

  const commit = () => {
    const nextProgress = clampProgressInput(Number(draft));
    setEditing(false);
    setDraft(String(nextProgress));
    if (nextProgress !== value) onCommit(nextProgress);
  };

  if (editing) {
    return (
      <input
        className="task-progress-input"
        type="number"
        min="0"
        max="100"
        value={draft}
        autoFocus
        aria-label={label}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(String(value));
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button type="button" className="progress-value-button" aria-label={label} onClick={() => setEditing(true)}>
      {value}%
    </button>
  );
}

function InlineChoiceEditor({
  value,
  options,
  label,
  tone,
  onChange,
  minWidth = 112,
  openOn = "click",
}: {
  value: string;
  options: Array<string | { value: string; label: string }>;
  label: string;
  tone: string;
  onChange: (value: string) => void;
  minWidth?: number;
  openOn?: "click" | "double";
}) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const normalizedOptions = options.map((option) => (typeof option === "string" ? { value: option, label: option } : option));
  const visibleOptions = normalizedOptions.some((option) => option.value === value) ? normalizedOptions : [{ value, label: value }, ...normalizedOptions];
  const selectedOption = visibleOptions.find((option) => option.value === value) || visibleOptions[0];

  const updateMenuPosition = () => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const menuWidth = Math.max(rect.width, minWidth);
    const estimatedHeight = Math.min(320, visibleOptions.length * 38 + 12);
    const openAbove = window.innerHeight - rect.bottom < estimatedHeight && rect.top > estimatedHeight;
    const availableHeight = openAbove ? rect.top - 18 : window.innerHeight - rect.bottom - 18;
    const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - menuWidth - 12));
    const top = openAbove ? Math.max(12, rect.top - Math.min(estimatedHeight, availableHeight) - 6) : rect.bottom + 6;

    setMenuStyle({
      left,
      top,
      minWidth: menuWidth,
      maxHeight: Math.max(154, Math.min(320, availableHeight)),
    });
  };

  useLayoutEffect(() => {
    if (open) updateMenuPosition();
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, value]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`deliverable-choice-trigger tone-${tone}${open ? " is-open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => {
          if (openOn === "click") setOpen((current) => !current);
        }}
        onDoubleClick={() => {
          if (openOn === "double") setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (openOn !== "double") return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen((current) => !current);
          }
        }}
      >
        <span>{selectedOption.label}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div ref={menuRef} className="deliverable-choice-menu" style={menuStyle} role="listbox" aria-label={label}>
              {visibleOptions.map((option) => {
                const selected = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={selected ? "is-selected" : ""}
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                  >
                    <span>{option.label}</span>
                    {selected ? <Check aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function ProjectOverviewPageLegacy({ state, onPage }: { state: AppState; onPage: (page: PageKey) => void }) {
  const project = getProject(state);
  const tasks = projectTasks(state, project.id);
  const deliverables = projectDeliverables(state, project.id);
  const risks = projectRisks(state, project.id);
  const scopeItems = projectScope(state, project.id);
  const metrics = calcProjectMetrics(state, project);
  const week = currentWeekRange();
  const today = localDateKey();
  const stageStats = calcStageProgress(state, project);
  const personDays = calcProjectPersonDays(state, project);
  const weekFocusTasks = tasks.filter((task) => isWeekFocusTask(task, week, today)).sort(compareTasksByPlan);
  const highPriorityWeekTasks = weekFocusTasks.filter((task) => task.priority === "高");
  const openRisks = risks.filter((item) => item.status !== "closed");
  const highRisks = openRisks.filter((item) => item.severity === "高");
  const acceptedDeliverables = deliverables.filter((item) => !isPendingDeliverable(item));
  const rootTasks = buildTaskTree(tasks);
  const allNodes = flattenTaskTree(rootTasks, allExpandedIds(tasks), { includeCollapsedChildren: true });
  const statusStats = statusColumns.map(([status, label]) => {
    const count = allNodes.filter((node) => node.computedStatus === status).length;
    return { status, label, count, percent: percentOf(count, allNodes.length) };
  });
  const ownerStats = [...new Set(tasks.map((task) => task.owner))]
    .map((owner) => {
      const ownerTasks = tasks.filter((task) => task.owner === owner && task.status !== "done");
      return { owner, count: ownerTasks.length, blocked: ownerTasks.filter((task) => task.status === "blocked").length };
    })
    .filter((item) => item.count)
    .sort((a, b) => b.blocked - a.blocked || b.count - a.count);
  const dashboardActions: Array<[PageKey, string, string]> = [
    ["board", "实施看板", `${statusStats.find((item) => item.status === "blocked")?.count ?? 0} 个阻塞 / ${statusStats.find((item) => item.status === "customer")?.count ?? 0} 个待客户`],
    ["list", "任务跟踪", `${tasks.length} 个任务 / ${rootTasks.length} 个主任务`],
    ["gantt", "WBS计划", `${stageStats.filter((item) => item.total).length} 个阶段有任务`],
    ["deliverables", "交付物", `${acceptedDeliverables.length}/${deliverables.length} 已闭环`],
  ];

  return (
    <>
      <section className="grid metrics">
        <Metric title="自动项目进度" value={`${metrics.completionRate}%`} delta={`${metrics.done}/${tasks.length} 完成`} tone={metrics.completionRate >= 70 ? "success" : "primary"} />
        <Metric title="开放任务" value={metrics.open} delta={`${metrics.overdue} 个逾期`} tone={metrics.overdue ? "danger" : "success"} />
        <Metric title="本周高优待办" value={highPriorityWeekTasks.length} delta={`${weekFocusTasks.length} 个本周焦点`} tone={highPriorityWeekTasks.length ? "danger" : "success"} />
        <Metric title="风险问题" value={openRisks.length} delta={`${highRisks.length} 个高优`} tone={highRisks.length ? "danger" : "warning"} />
        <Metric title="交付验收" value={`${acceptedDeliverables.length}/${deliverables.length}`} delta={`${metrics.pendingDeliverables} 个待闭环`} tone="purple" />
      </section>

      <section className="overview-grid">
        <Card className="pad overview-panel overview-hero">
          <div className="overview-hero-main">
            <RingChart value={metrics.completionRate} label="自动进度" />
            <div>
              <div className="chip-line">
                <Badge tone={toneFor(project.health)}>{project.health}</Badge>
                <Badge>{project.phase}</Badge>
              </div>
              <h3>{project.name}</h3>
              <p className="muted">{project.description}</p>
            </div>
          </div>
          <div className="overview-facts">
            <div>
              <span>下一里程碑</span>
              <strong>{project.nextMilestone}</strong>
            </div>
            <div>
              <span>项目周期</span>
              <strong>
                {formatShortDate(project.startDate)} - {formatShortDate(project.endDate)}
              </strong>
            </div>
            <div>
              <span>范围项</span>
              <strong>{scopeItems.length}</strong>
            </div>
            <div>
              <span>主任务</span>
              <strong>{rootTasks.length}</strong>
            </div>
          </div>
        </Card>

        <Card className="pad overview-panel">
          <div className="workbench-card-title">
            <h3>阶段进度</h3>
            <Badge>{stageStats.filter((item) => item.total).length} 个阶段</Badge>
          </div>
          <div className="stage-bars">
            {stageStats.map((item) => (
              <div key={item.stage} className="bar-row">
                <div>
                  <strong>{item.label}</strong>
                  <span className="muted">{item.total} 项</span>
                </div>
                <Progress value={item.progress} />
                <span>{item.progress}%</span>
              </div>
            ))}
          </div>
        </Card>

        <Card className="pad overview-panel">
          <div className="workbench-card-title">
            <h3>任务状态分布</h3>
            <Badge>{tasks.length} 项</Badge>
          </div>
          <div className="status-bars">
            {statusStats.map((item) => (
              <div key={item.status} className={`status-bar ${statusCssClass(item.status)}`}>
                <div className="status-bar-head">
                  <span>{item.label}</span>
                  <strong>{item.count}</strong>
                </div>
                <div className="status-bar-track">
                  <span style={{ width: `${item.percent}%` }} />
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="pad overview-panel overview-panel-wide overview-focus-panel">
          <div className="workbench-card-title">
            <h3>本周执行焦点</h3>
            <Badge tone={highPriorityWeekTasks.length ? "danger" : "success"}>{weekFocusTasks.length}</Badge>
          </div>
          <div className="work-list">
            {weekFocusTasks.slice(0, 6).map((task) => (
              <div key={task.id} className="work-item compact">
                <div className="chip-line">
                  <Badge tone={toneFor(task.priority)}>{task.priority}</Badge>
                  <Badge tone={taskStatusTone(task.status)}>{taskStatusLabels[task.status]}</Badge>
                  <Badge>{stageLabel(state, task.stage, project.id)}</Badge>
                </div>
                <strong>{task.title}</strong>
                <span className="muted">
                  {task.code} · {task.owner} · 截止 {formatShortDate(task.dueDate)}
                </span>
              </div>
            ))}
            {!weekFocusTasks.length ? <div className="empty compact">本周没有待处理焦点任务。</div> : null}
          </div>
        </Card>

        <Card className="pad overview-panel overview-panel-wide">
          <div className="table-toolbar compact">
            <div>
              <h3>WBS 任务进度</h3>
              <p className="muted">主任务进度由子任务自动汇总，项目进度由主任务继续汇总。</p>
            </div>
            <Badge tone="primary">{allNodes.length} 行</Badge>
          </div>
          <div className="overview-table-scroll">
            <table className="table dashboard-table">
            <thead>
              <tr>
                <th>任务</th>
                <th>状态</th>
                <th>阶段</th>
                <th>负责人</th>
                <th>起止</th>
                <th>自动进度</th>
              </tr>
            </thead>
            <tbody>
              {allNodes.slice(0, 9).map((node) => (
                <tr key={node.id}>
                  <td>
                    <div className="tree-title readonly" style={{ "--depth": node.depth } as CSSProperties}>
                      <span className="tree-spacer" />
                      <div>
                        <strong>{node.title}</strong>
                        <span className="muted">
                          {node.code} · {taskKindLabel(node)}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <Badge tone={taskStatusTone(node.computedStatus)}>{taskStatusLabels[node.computedStatus]}</Badge>
                  </td>
                  <td>{stageLabel(state, node.stage, project.id)}</td>
                  <td>{node.owner}</td>
                  <td>{formatTaskRange(node)}</td>
                  <td>
                    <div className="task-progress-cell">
                      <Progress value={node.computedProgress} />
                      <span>{node.computedProgress}%</span>
                    </div>
                  </td>
                </tr>
              ))}
              {!allNodes.length ? (
                <tr>
                  <td colSpan={6} className="muted">
                    当前项目还没有任务。
                  </td>
                </tr>
              ) : null}
            </tbody>
            </table>
          </div>
        </Card>

        <Card className="pad overview-panel">
          <div className="workbench-card-title">
            <h3>风险与交付闭环</h3>
            <Badge tone={highRisks.length ? "danger" : "warning"}>{openRisks.length} 打开</Badge>
          </div>
          <div className="signal-list">
            <div className="signal-item">
              <span>高优风险</span>
              <strong>{highRisks.length}</strong>
            </div>
            <div className="signal-item">
              <span>打开问题</span>
              <strong>{metrics.issues}</strong>
            </div>
            <div className="signal-item">
              <span>待验收交付物</span>
              <strong>{metrics.pendingDeliverables}</strong>
            </div>
            <div className="signal-item">
              <span>范围变更</span>
              <strong>{scopeItems.filter((item) => item.category === "变更增加范围").length}</strong>
            </div>
          </div>
        </Card>

        <Card className="pad overview-panel">
          <div className="workbench-card-title">
            <h3>责任人负载</h3>
            <Badge>{ownerStats.length} 人</Badge>
          </div>
          <div className="owner-load-list">
            {ownerStats.map((item) => (
              <div key={item.owner} className="owner-load-row">
                <div>
                  <strong>{item.owner}</strong>
                  <span className="muted">{item.blocked} 个阻塞</span>
                </div>
                <Progress value={percentOf(item.count, Math.max(...ownerStats.map((owner) => owner.count), 1))} />
                <span>{item.count}</span>
              </div>
            ))}
            {!ownerStats.length ? <div className="empty compact">当前没有开放任务。</div> : null}
          </div>
        </Card>

        <Card className="pad overview-panel overview-links">
          <div className="workbench-card-title">
            <h3>联动入口</h3>
            <Badge tone="primary">实时数据</Badge>
          </div>
          <div className="overview-action-grid">
            {dashboardActions.map(([page, title, subtitle]) => (
              <button key={page} className="overview-action" onClick={() => onPage(page)}>
                <strong>{title}</strong>
                <span>{subtitle}</span>
              </button>
            ))}
          </div>
        </Card>
      </section>
    </>
  );
}

export function BoardPage({
  state,
  onTaskStatus,
  onEditTask,
  onAddSubtask,
  onDeleteTask,
}: {
  state: AppState;
  onTaskStatus: (taskId: string, status: TaskStatus) => void;
  onEditTask: (task: Task) => void;
  onAddSubtask: (parentId: string) => void;
  onDeleteTask: (taskId: string) => void;
}) {
  const project = getProject(state);
  const tasks = projectTasks(state, project.id);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openStatusMenuId, setOpenStatusMenuId] = useState("");
  const tree = filterTaskNodes(state, buildTaskTree(tasks));
  const allNodes = flattenTaskTree(tree, allExpandedIds(tasks), { includeCollapsedChildren: true });
  const renderStatusControl = (node: TaskNode) =>
    node.children.length ? (
      <span className="status-select readonly">自动汇总</span>
    ) : (
      <div className="status-menu">
        <button
          className={`status-trigger ${statusCssClass(node.status)}`}
          onClick={() => setOpenStatusMenuId((value) => (value === node.id ? "" : node.id))}
          aria-haspopup="menu"
          aria-expanded={openStatusMenuId === node.id}
        >
          <span className="status-dot" />
          {taskStatusLabels[node.status]}
          <ChevronDown aria-hidden="true" />
        </button>
        {openStatusMenuId === node.id ? (
          <div className="status-menu-popover" role="menu">
            {statusColumns.map(([nextStatus, nextLabel]) => (
              <button
                key={nextStatus}
                className={`status-option ${statusCssClass(nextStatus)} ${node.status === nextStatus ? "active" : ""}`}
                onClick={() => {
                  setOpenStatusMenuId("");
                  if (node.status !== nextStatus) onTaskStatus(node.id, nextStatus);
                }}
                role="menuitem"
              >
                <span className="status-dot" />
                <span>{nextLabel}</span>
                {node.status === nextStatus ? <Check aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );

  const renderSubtaskStatusIcon = (node: TaskNode) => {
    if (node.computedStatus === "done") return <CircleCheck aria-hidden="true" />;
    if (node.computedStatus === "doing") return <Clock aria-hidden="true" />;
    if (node.computedStatus === "blocked" || node.computedStatus === "customer") return <AlertCircle aria-hidden="true" />;
    return <Circle aria-hidden="true" />;
  };

  const renderSubtask = (node: TaskNode) => (
    <div key={node.id} className={`board-subtask ${statusCssClass(node.computedStatus)}`} style={{ "--depth": Math.max(0, node.depth - 1) } as CSSProperties}>
      <span className="board-subtask-status-icon" title={taskStatusLabels[node.computedStatus]}>
        {renderSubtaskStatusIcon(node)}
      </span>
      <div className="board-subtask-copy">
        <strong>{node.title}</strong>
        <span className="board-subtask-meta-line">
          <span>
            {node.code} · {node.owner} · {formatTaskRange(node)}
          </span>
          <b>{node.computedProgress}%</b>
        </span>
      </div>
      <div className="board-subtask-actions">
        {renderStatusControl(node)}
        <Button tone="ghost" onClick={() => onEditTask(node)}>
          编辑
        </Button>
        <Button tone="danger" onClick={() => onDeleteTask(node.id)}>
          删除
        </Button>
      </div>
    </div>
  );

  const renderTaskCard = (node: TaskNode) => {
    const subtasks = flattenTaskTree(node.children, allExpandedIds(tasks), { includeCollapsedChildren: true });
    const isCollapsed = !expanded.has(node.id);
    const doneSubtasks = subtasks.filter((subtask) => subtask.computedStatus === "done").length;
    const subtaskProgress = percentOf(doneSubtasks, subtasks.length);
    return (
      <article key={node.id} className={`board-task ${statusCssClass(node.computedStatus)}`}>
        <div className="board-task-head">
          <div className="board-task-eyebrow">
            {node.children.length ? (
              <button
                className="board-expand"
                onClick={() => setExpanded((value) => toggleCollapsed(value, node.id))}
                aria-label={isCollapsed ? "展开子任务" : "收起子任务"}
              >
                {isCollapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              </button>
            ) : null}
            <span className="board-task-code">{node.code}</span>
            {node.children.length ? (
              <Badge tone={taskStatusTone(node.computedStatus)}>{taskStatusLabels[node.computedStatus]}</Badge>
            ) : (
              <span className="board-head-status">{renderStatusControl(node)}</span>
            )}
          </div>
          <span className={`board-task-status-dot ${statusCssClass(node.computedStatus)}`} title={taskStatusLabels[node.computedStatus]} />
        </div>
        <strong className="board-task-title">{node.title}</strong>
        <div className="chip-line">
          <Badge>{taskKindLabel(node)}</Badge>
          <Badge>{stageLabel(state, node.stage, project.id)}</Badge>
        </div>
        <div className="board-task-progress-row">
          <span className="board-owner-mark">
            <UserCircle aria-hidden="true" />
            <span>{node.owner.slice(0, 2)}</span>
          </span>
          <Progress value={node.computedProgress} />
          <strong>{node.computedProgress}%</strong>
        </div>
        <div className="board-task-range">{formatTaskRange(node)}</div>
        <div className="board-task-actions">
          {node.children.length ? renderStatusControl(node) : null}
          <button
            className="button ghost board-add-subtask"
            onClick={() => onAddSubtask(node.id)}
            aria-label="添加子任务"
            title="添加子任务"
            data-tooltip="添加子任务"
          >
            <Plus aria-hidden="true" />
          </button>
          <Button tone="ghost" onClick={() => onEditTask(node)}>
            编辑
          </Button>
          <Button tone="danger" onClick={() => onDeleteTask(node.id)}>
            删除
          </Button>
        </div>
        {subtasks.length ? (
          <div className="board-subtasks">
            <button
              className={`board-subtasks-summary ${isCollapsed ? "" : "expanded"}`}
              onClick={() => setExpanded((value) => toggleCollapsed(value, node.id))}
            >
              <span className="board-subtasks-count">{subtasks.length} 子任务</span>
              <span className="board-subtasks-mini">
                <span style={{ width: `${subtaskProgress}%` }} />
              </span>
              <span className="board-subtasks-done">
                {doneSubtasks}/{subtasks.length}
              </span>
              {isCollapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
            </button>
            {!isCollapsed ? <div className="board-subtask-list">{subtasks.map(renderSubtask)}</div> : null}
          </div>
        ) : null}
      </article>
    );
  };

  return (
    <>
      <section className="board-scroll" aria-label="实施看板">
        <div className="filters board-summary">
          {statusColumns.map(([status, label]) => {
            const rootCount = tree.filter((node) => node.computedStatus === status).length;
            const childCount = allNodes.filter((node) => node.parentId && node.computedStatus === status).length;
            return (
              <span key={status} className={`board-status-pill ${statusCssClass(status)}`}>
                <span className="board-status-dot" />
                <span>
                  {label}
                  <small>
                    {rootCount} 主任务 / {childCount} 子任务
                  </small>
                </span>
                <strong>{rootCount + childCount}</strong>
              </span>
            );
          })}
        </div>
        <div className="board compact-board">
          {statusColumns.map(([status, label]) => {
            const columnTasks = tree.filter((task) => task.computedStatus === status);
            return (
              <div key={status} className={`board-column ${statusCssClass(status)}`} aria-label={`${label}任务`}>
                {columnTasks.map(renderTaskCard)}
                {!columnTasks.length ? <div className="empty compact">无任务</div> : null}
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

function ListPageLegacy({
  state,
  onAddTask,
  onEditTask,
  onDeleteTask,
}: {
  state: AppState;
  onAddTask: () => void;
  onEditTask: (task: Task) => void;
  onDeleteTask: (taskId: string) => void;
}) {
  const project = getProject(state);
  const tasks = projectTasks(state, project.id);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const nodes = flattenVisibleTaskNodes(state, tasks, collapsed);
  return (
    <Card className="pad">
      <div className="table-toolbar">
        <div>
          <h3>任务执行台账</h3>
          <p className="muted">主任务和子任务统一维护，自动同步看板、WBS、甘特、概览、周报和 AI 快照。</p>
        </div>
        <Button tone="primary" onClick={onAddTask}>
          新建任务
        </Button>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>任务</th>
            <th>类型</th>
            <th>状态</th>
            <th>阶段</th>
            <th>负责人</th>
            <th>起止</th>
            <th>自动进度</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => (
            <tr key={node.id} className={node.depth ? "tree-row child" : "tree-row"}>
              <td>
                <TaskTitleCell
                  node={node}
                  collapsed={collapsed}
                  onToggle={(taskId) => setCollapsed((value) => toggleCollapsed(value, taskId))}
                />
              </td>
              <td>
                <Badge>{node.type}</Badge>
              </td>
              <td>
                <Badge tone={taskStatusTone(node.computedStatus)}>{taskStatusLabels[node.computedStatus]}</Badge>
              </td>
              <td>{stageLabel(state, node.stage, project.id)}</td>
              <td>{node.owner}</td>
              <td>{formatTaskRange(node)}</td>
              <td>
                <div className="task-progress-cell">
                  <Progress value={node.computedProgress} />
                  <span>{node.computedProgress}%</span>
                </div>
              </td>
              <td>
                <div className="row-actions">
                  <Button tone="ghost" onClick={() => onEditTask(node)}>
                    编辑
                  </Button>
                  <Button tone="danger" onClick={() => onDeleteTask(node.id)}>
                    删除
                  </Button>
                </div>
              </td>
            </tr>
          ))}
          {!nodes.length ? (
            <tr>
              <td colSpan={8} className="muted">
                没有匹配的任务。
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </Card>
  );
}

function ScopePageLegacy({
  state,
  onAddScopeItem,
  onEditScopeItem,
  onDeleteScopeItem,
}: {
  state: AppState;
  onAddScopeItem: () => void;
  onEditScopeItem: (scopeItem: ScopeItem) => void;
  onDeleteScopeItem: (scopeItemId: string) => void;
}) {
  const scopeItems = projectScope(state).filter((item) => scopeItemMatchesSearch(state, item));
  return (
    <section className="grid">
      <Card className="pad">
        <div className="table-toolbar compact">
          <div>
            <h3>范围边界</h3>
            <p className="muted">范围、变更、不在范围和双方责任要能持续维护，后续 AI 快照也会读取这里。</p>
          </div>
          <Button tone="primary" onClick={onAddScopeItem}>
            新建范围项
          </Button>
        </div>
        {scopeItems.map((item) => (
          <div className="task-card" key={item.id}>
            <Badge tone={toneFor(item.category)}>{item.category}</Badge>
            <strong>{item.content}</strong>
            <div className="actions-row">
              <Button tone="ghost" onClick={() => onEditScopeItem(item)}>
                编辑
              </Button>
              <Button tone="danger" onClick={() => onDeleteScopeItem(item.id)}>
                删除
              </Button>
            </div>
          </div>
        ))}
        {!scopeItems.length ? <div className="empty">没有匹配的范围项。</div> : null}
      </Card>
    </section>
  );
}

function GanttPageLegacy({ state }: { state: AppState }) {
  const project = getProject(state);
  const tasks = projectTasks(state, project.id);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const nodes = flattenVisibleTaskNodes(state, tasks, collapsed);
  const stages = stageOrderForState(state, project.id);
  const stageWidth = 100 / stages.length;
  const ganttStyle = (node: TaskNode) =>
    ({
      "--left": `${Math.max(0, stages.indexOf(node.stage)) * stageWidth + 1}%`,
      "--width": `${stageWidth - 2}%`,
      "--value": node.computedProgress,
    }) as CSSProperties;

  return (
    <Card className="pad gantt-card">
      <div className="table-toolbar compact">
        <div>
          <h3>WBS / 甘特计划</h3>
          <p className="muted">计划视图读取同一套任务树，主任务进度由子任务汇总。</p>
        </div>
        <Badge tone="primary">{nodes.length} 行</Badge>
      </div>
      <div className="gantt-layout">
        <div className="wbs-table">
          <div className="wbs-row wbs-head">
            <span>WBS</span>
            <span>状态</span>
          </div>
          {nodes.map((node) => (
            <div key={node.id} className="wbs-row">
              <GanttTaskCell
                node={node}
                collapsed={collapsed}
                onToggle={(taskId) => setCollapsed((value) => toggleCollapsed(value, taskId))}
              />
              <Badge tone={taskStatusTone(node.computedStatus)}>{taskStatusLabels[node.computedStatus]}</Badge>
            </div>
          ))}
          {!nodes.length ? <div className="empty compact">没有匹配的 WBS 任务。</div> : null}
        </div>
        <div className="gantt-timeline">
          <div className="gantt-axis">
            {stages.map((stage) => (
              <span key={stage}>{stageLabel(state, stage, project.id)}</span>
            ))}
            <span>负责人</span>
            <span>起止</span>
          </div>
          {nodes.map((node) => (
            <div key={node.id} className="gantt-row">
              <div className="gantt-track">
                <span className={`gantt-bar ${statusCssClass(node.computedStatus)}`} style={ganttStyle(node)}>
                  <span>{node.computedProgress}%</span>
                </span>
              </div>
              <span className="gantt-owner">{node.owner}</span>
              <span className="gantt-date">{formatTaskRange(node)}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function DeliverablesPageLegacy({
  state,
  onAddDeliverable,
  onEditDeliverable,
  onDeleteDeliverable,
}: {
  state: AppState;
  onAddDeliverable: () => void;
  onEditDeliverable: (deliverable: Deliverable) => void;
  onDeleteDeliverable: (deliverableId: string) => void;
}) {
  const deliverables = projectDeliverables(state).filter((item) => deliverableMatchesSearch(state, item));
  return (
    <section className="grid split">
      <Card className="pad">
        <div className="table-toolbar">
          <div>
            <h3>交付物验收状态</h3>
            <p className="muted">交付物状态会同步影响项目概览、项目总览、周报和 AI 快照。</p>
          </div>
          <Button tone="primary" onClick={onAddDeliverable}>
            新建交付物
          </Button>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>交付物</th>
              <th>关联任务项</th>
              <th>状态</th>
              <th>验收</th>
              <th>截止</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {deliverables.map((item) => (
              <tr key={item.id}>
                <td>
                  <strong>{item.name}</strong>
                </td>
                <td className="muted">{item.code}</td>
                <td>
                  <Badge>{item.status}</Badge>
                </td>
                <td>
                  <Badge tone={toneFor(item.acceptance)}>{item.acceptance}</Badge>
                </td>
                <td>{item.dueDate}</td>
                <td>
                  <div className="row-actions">
                    <Button tone="ghost" onClick={() => onEditDeliverable(item)}>
                      编辑
                    </Button>
                    <Button tone="danger" onClick={() => onDeleteDeliverable(item.id)}>
                      删除
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {!deliverables.length ? (
              <tr>
                <td colSpan={6} className="muted">
                  没有匹配的交付物。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Card>
      <Card className="pad">
        <h3>交付闭环</h3>
        <p className="muted">MVP 阶段只保存本地路径或 URL，不把文件二进制写入数据库。</p>
        {deliverables.slice(0, 4).map((item) => (
          <div className="task-card" key={item.id}>
            <Badge tone={toneFor(item.acceptance)}>{item.acceptance}</Badge>
            <strong>{item.name}</strong>
            <p className="muted">关联事项：{item.code}</p>
          </div>
        ))}
      </Card>
    </section>
  );
}

function RisksPageLegacy({
  state,
  onAddRiskIssue,
  onEditRiskIssue,
  onDeleteRiskIssue,
}: {
  state: AppState;
  onAddRiskIssue: (riskKind: RiskIssue["kind"]) => void;
  onEditRiskIssue: (riskIssue: RiskIssue) => void;
  onDeleteRiskIssue: (riskIssueId: string) => void;
}) {
  const risks = projectRisks(state)
    .filter((item) => item.kind === "risk")
    .filter((item) => riskIssueMatchesSearch(state, item));
  const issues = projectRisks(state)
    .filter((item) => item.kind === "issue")
    .filter((item) => riskIssueMatchesSearch(state, item));
  const renderItem = (item: (typeof risks)[number]) => (
    <div className="task-card" key={item.id}>
      <Badge tone={toneFor(item.severity)}>{item.severity}</Badge>
      <strong>{item.title}</strong>
      <p className="muted">{item.responsePlan}</p>
      <Badge>{item.status}</Badge>
      <div className="actions-row">
        <Button tone="ghost" onClick={() => onEditRiskIssue(item)}>
          编辑
        </Button>
        <Button tone="danger" onClick={() => onDeleteRiskIssue(item.id)}>
          删除
        </Button>
      </div>
    </div>
  );
  return (
    <section className="grid split">
      <Card className="pad">
        <div className="table-toolbar compact">
          <div>
            <h3>风险：可能发生</h3>
            <p className="muted">风险用于提前预警和预案跟踪。</p>
          </div>
          <Button tone="primary" onClick={() => onAddRiskIssue("risk")}>
            新建风险
          </Button>
        </div>
        {risks.map(renderItem)}
        {!risks.length ? <div className="empty">没有匹配的风险。</div> : null}
      </Card>
      <Card className="pad">
        <div className="table-toolbar compact">
          <div>
            <h3>问题：已经发生</h3>
            <p className="muted">问题用于处理当前已经影响交付的事项。</p>
          </div>
          <Button tone="primary" onClick={() => onAddRiskIssue("issue")}>
            新建问题
          </Button>
        </div>
        {issues.map(renderItem)}
        {!issues.length ? <div className="empty">没有匹配的问题。</div> : null}
      </Card>
    </section>
  );
}

function WeeklyPageLegacy({ state, aiService, onSave }: { state: AppState; aiService: AiService; onSave: (content: string) => void }) {
  const project = getProject(state);
  const content = aiService.draftWeeklyReport(state, project);
  return (
    <section className="grid split">
      <Card className="pad">
        <h3>周报自动汇总来源</h3>
        {["事项自动汇总", "里程碑自动汇总", "风险 / 问题自动汇总", "交付物与客户确认"].map((item) => (
          <div className="task-card" key={item}>
            <Badge>{item}</Badge>
            <strong>{item}</strong>
            <p className="muted">来自当前项目结构化数据，可编辑后保存。</p>
          </div>
        ))}
      </Card>
      <Card className="pad">
        <h3>周报草稿</h3>
        <textarea id="weeklyDraft" defaultValue={content} />
        <div className="actions-row">
          <Button tone="primary" onClick={() => onSave((document.querySelector("#weeklyDraft") as HTMLTextAreaElement).value)}>
            保存周报草稿
          </Button>
        </div>
      </Card>
    </section>
  );
}

export function ProjectOverviewPage({
  state,
  onPage,
  onTaskStatus,
}: {
  state: AppState;
  onPage: (page: PageKey) => void;
  onTaskStatus: (taskId: string, status: TaskStatus) => void;
}) {
  const project = getProject(state);
  const tasks = projectTasks(state, project.id);
  const deliverables = projectDeliverables(state, project.id);
  const risks = projectRisks(state, project.id);
  const metrics = calcProjectMetrics(state, project);
  const week = currentWeekRange();
  const today = localDateKey();
  const stageStats = calcStageProgress(state, project);
  const personDays = calcProjectPersonDays(state, project);
  const weekFocusTasks = tasks.filter((task) => task.parentId && isWeekFocusTask(task, week, today)).sort(compareTasksByPlan);
  const openRisks = risks.filter((item) => item.status !== "closed");
  const highRisks = openRisks.filter((item) => item.severity === "高");
  const followUpTasks = tasks
    .filter((task) => task.status !== "done" && (task.status === "blocked" || task.status === "customer" || isOverdueTask(task, today) || isWeekFocusTask(task, week, today)))
    .sort(compareWorkItems);
  const followUpRisks = openRisks.sort((a, b) => {
    const severityWeight = { 高: 0, 中: 1, 低: 2 } as const;
    return severityWeight[a.severity] - severityWeight[b.severity] || (a.kind === "issue" ? 0 : 1) - (b.kind === "issue" ? 0 : 1);
  });
  const acceptedDeliverables = deliverables.filter((item) => !isPendingDeliverable(item));
  const ownerStats = [...new Set(tasks.map((task) => task.owner))]
    .map((owner) => {
      const ownerTasks = tasks.filter((task) => task.owner === owner && task.status !== "done");
      return { owner, count: ownerTasks.length, blocked: ownerTasks.filter((task) => task.status === "blocked").length };
    })
    .filter((item) => item.count)
    .sort((a, b) => b.blocked - a.blocked || b.count - a.count);
  const maxOwnerLoad = Math.max(...ownerStats.map((item) => item.count), 1);

  return (
    <div className="execution-overview-page">
      <section className="execution-stats-bar">
        <div>
          <span>自动进度</span>
          <strong className="stat-value">{metrics.completionRate}%</strong>
          <small>{metrics.done}/{tasks.length} 完成</small>
        </div>
        <div>
          <span>开放任务</span>
          <strong className="stat-value">{metrics.open}</strong>
          <small className={metrics.overdue ? "danger-text" : ""}>{metrics.overdue} 逾期</small>
        </div>
        <div>
          <span>风险问题</span>
          <strong className={`stat-value ${highRisks.length ? "danger-text" : ""}`}>{openRisks.length}</strong>
          <small>{highRisks.length} 高优</small>
        </div>
        <div>
          <span>交付物</span>
          <strong className="stat-value">{acceptedDeliverables.length}/{deliverables.length}</strong>
          <small>{metrics.pendingDeliverables} 待闭环</small>
        </div>
        <div>
          <span>实施人天</span>
          <strong className={`stat-value ${personDays.implementationUsageRate > 100 ? "danger-text" : ""}`}>{personDays.implementationActual}/{personDays.implementationEstimated || 0}</strong>
          <small>{personDays.implementationUsageRate}% 使用率</small>
        </div>
        <div>
          <span>开发人天</span>
          <strong className={`stat-value ${personDays.developmentUsageRate > 100 ? "danger-text" : ""}`}>{personDays.developmentActual}/{personDays.developmentEstimated || 0}</strong>
          <small>{personDays.developmentUsageRate}% 使用率</small>
        </div>
      </section>

      <section className="execution-overview-grid">
        <Card className="pad execution-health-panel">
          <div className="execution-health-main">
            <RingChart value={metrics.completionRate} label="进度" />
            <div>
              <div className="chip-line">
                <Badge tone={toneFor(project.health)}>{project.health}</Badge>
                <Badge>{project.phase}</Badge>
                <Badge tone={personDays.implementationUsageRate > 100 ? "danger" : "primary"}>实施 {personDays.implementationActual}/{personDays.implementationEstimated || 0}</Badge>
                <Badge tone={personDays.developmentUsageRate > 100 ? "danger" : "primary"}>开发 {personDays.developmentActual}/{personDays.developmentEstimated || 0}</Badge>
              </div>
              <h3>{project.name}</h3>
              <p className="muted">{project.description}</p>
            </div>
          </div>
          <div className="stage-bars compact-stage-bars">
            {stageStats.map((item) => (
              <div key={item.stage} className="bar-row">
                <div>
                  <strong>{item.label}</strong>
                  <span className="muted">{item.total} 项</span>
                </div>
                <Progress value={item.progress} />
                <span>{item.progress}%</span>
              </div>
            ))}
          </div>
        </Card>

        <div className="execution-overview-flow">
          <Card className="pad compact-list-card">
            <div className="compact-card-head">
              <h3>本周执行焦点</h3>
              <Badge tone={weekFocusTasks.length ? "primary" : "success"}>{weekFocusTasks.length}</Badge>
            </div>
            <div className="compact-signal-list">
              {weekFocusTasks.slice(0, 6).map((task) => (
                <div key={task.id} className={`compact-signal-item priority-${task.priority === "高" ? "high" : task.priority === "中" ? "medium" : "low"}`}>
                  <div className="compact-signal-line">
                    <strong>{task.title}</strong>
                    <label className={`overview-focus-status ${statusCssClass(task.status)}`} title="修改子任务状态">
                      <span className="status-dot" />
                      <select
                        value={task.status}
                        aria-label={`修改 ${task.title} 状态`}
                        onChange={(event) => {
                          const nextStatus = event.target.value as TaskStatus;
                          if (task.status !== nextStatus) onTaskStatus(task.id, nextStatus);
                        }}
                      >
                        {statusColumns.map(([status, label]) => (
                          <option key={status} value={status}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <time>{formatShortDate(task.dueDate)}</time>
                  </div>
                  <p>{task.code} · {task.owner} · {stageLabel(state, task.stage, project.id)}</p>
                </div>
              ))}
              {!weekFocusTasks.length ? <div className="empty compact">本周暂无需要跟进的子任务。</div> : null}
            </div>
          </Card>

          <Card className="pad compact-list-card">
            <div className="compact-card-head">
              <div>
                <h3>待跟进事项</h3>
                <p>优先处理阻塞、待客户、逾期任务和开放风险问题。</p>
              </div>
              <Badge tone={followUpTasks.length || followUpRisks.length ? "danger" : "success"}>{followUpTasks.length + followUpRisks.length}</Badge>
            </div>
            <div className="followup-summary">
              <span className="mini-status-dot status-blocked">阻塞 {metrics.blocked}</span>
              <span className="mini-status-dot status-customer">待客户 {metrics.customer}</span>
              <span className={metrics.overdue ? "severity-dot high" : "micro-tag"}>逾期 {metrics.overdue}</span>
              <span className={highRisks.length ? "severity-dot high" : "micro-tag"}>高优风险 {highRisks.length}</span>
            </div>
            <div className="compact-signal-list">
              {followUpTasks.slice(0, 4).map((task) => (
                <div key={task.id} className={`compact-signal-item priority-${task.status === "blocked" ? "high" : task.status === "customer" || isOverdueTask(task, today) ? "medium" : task.priority === "高" ? "high" : task.priority === "中" ? "medium" : "low"}`}>
                  <div className="compact-signal-line">
                    <strong>{task.title}</strong>
                    <span className={`mini-status-dot ${statusCssClass(task.status)}`}>{taskStatusLabels[task.status]}</span>
                    <time>{formatShortDate(task.dueDate)}</time>
                  </div>
                  <p>{task.code} · {task.owner} · {stageLabel(state, task.stage, project.id)}{isOverdueTask(task, today) ? " · 已逾期" : ""}</p>
                </div>
              ))}
              {followUpRisks.slice(0, Math.max(0, 6 - Math.min(followUpTasks.length, 4))).map((item) => (
                <div key={item.id} className={`compact-signal-item priority-${item.severity === "高" ? "high" : item.severity === "中" ? "medium" : "low"}`}>
                  <div className="compact-signal-line">
                    <strong>{item.title}</strong>
                    <span className={`severity-dot ${item.severity === "高" ? "high" : item.severity === "中" ? "medium" : "low"}`}>{item.severity}</span>
                    <span className="micro-tag">{item.kind === "risk" ? "风险" : "问题"}</span>
                  </div>
                  <p>{riskStatusLabel(item.status)} · {item.responsePlan}</p>
                </div>
              ))}
              {!followUpTasks.length && !followUpRisks.length ? <div className="empty compact">当前没有需要紧急跟进的事项。</div> : null}
            </div>
          </Card>

          <Card className="pad owner-load-panel">
            <div className="compact-card-head">
              <h3>责任人负载</h3>
              <Badge>{ownerStats.length} 人</Badge>
            </div>
            <div className="owner-load-list">
              {ownerStats.map((item) => (
                <div key={item.owner} className="owner-load-row">
                  <div>
                    <strong>{item.owner}</strong>
                    <span className="muted">{item.blocked} 阻塞</span>
                  </div>
                  <Progress value={percentOf(item.count, maxOwnerLoad)} />
                  <span>{item.count}</span>
                </div>
              ))}
              {!ownerStats.length ? <div className="empty compact">暂无开放任务。</div> : null}
            </div>
          </Card>

          <Card className="pad overview-links execution-links-panel">
            <div className="overview-action-grid">
              {[
                ["board", "实施看板", `${metrics.blocked} 阻塞 / ${metrics.customer} 待客户`],
                ["list", "任务跟踪", `${tasks.length} 个任务`],
                ["gantt", "WBS计划", `${stageStats.filter((item) => item.total).length} 个阶段`],
                ["deliverables", "交付物", `${acceptedDeliverables.length}/${deliverables.length} 已闭环`],
              ].map(([page, title, subtitle]) => (
                <button key={page} className="overview-action" onClick={() => onPage(page as PageKey)}>
                  <strong>{title}</strong>
                  <span>{subtitle}</span>
                </button>
              ))}
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}

export function ListPage({
  state,
  onAddTask,
  onTaskStatus,
  onTaskProgress,
  onEditTask,
  onDeleteTask,
}: {
  state: AppState;
  onAddTask: () => void;
  onTaskStatus: (taskId: string, status: TaskStatus) => void;
  onTaskProgress: (taskId: string, progress: number) => void;
  onEditTask: (task: Task) => void;
  onDeleteTask: (taskId: string) => void;
}) {
  const project = getProject(state);
  const tasks = projectTasks(state, project.id);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const nodes = flattenVisibleTaskNodes(state, tasks, collapsed);
  const renderStatusCell = (node: TaskNode) => {
    if (!canEditLeafSubtask(node)) {
      return <Badge tone={taskStatusTone(node.computedStatus)}>{taskStatusLabels[node.computedStatus]}</Badge>;
    }
    return (
      <label className={`task-status-control ${statusCssClass(node.status)}`} title="修改子任务状态">
        <span className="status-dot" />
        <select
          value={node.status}
          aria-label={`修改 ${node.title} 状态`}
          onChange={(event) => {
            const nextStatus = event.target.value as TaskStatus;
            if (node.status !== nextStatus) onTaskStatus(node.id, nextStatus);
          }}
        >
          {statusColumns.map(([status, label]) => (
            <option key={status} value={status}>
              {label}
            </option>
          ))}
        </select>
      </label>
    );
  };
  const renderProgressCell = (node: TaskNode) => {
    if (!canEditLeafSubtask(node)) {
      return (
        <div className="task-progress-cell readonly">
          <Progress value={node.computedProgress} />
          <span>{node.computedProgress}%</span>
        </div>
      );
    }
    return (
      <div className="task-progress-cell editable">
        <Progress value={node.computedProgress} />
        <InlineProgressEditor
          value={node.computedProgress}
          label={`修改 ${node.title} 进度百分比`}
          onCommit={(nextProgress) => onTaskProgress(node.id, nextProgress)}
        />
      </div>
    );
  };
  return (
    <Card className="pad compact-ledger-card">
      <div className="table-toolbar compact">
        <div>
          <h3>任务执行台账</h3>
          <p className="muted">压缩行高、合并类型和阶段，任务状态与进度保持同源。</p>
        </div>
        <Button tone="primary" onClick={onAddTask}>新建任务</Button>
      </div>
      <table className="table compact-table task-ledger-table">
        <thead>
          <tr>
            <th>任务</th>
            <th>类型 · 阶段</th>
            <th>负责人</th>
            <th>状态</th>
            <th>进度</th>
            <th>截止</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => (
            <tr key={node.id} className={node.depth ? "tree-row child" : "tree-row"}>
              <td>
                <TaskTitleCell node={node} collapsed={collapsed} onToggle={(taskId) => setCollapsed((value) => toggleCollapsed(value, taskId))} />
              </td>
              <td><span className="muted">{node.type} · {stageLabel(state, node.stage, project.id)}</span></td>
              <td><span className="owner-avatar-mini" title={node.owner}>{node.owner.slice(0, 1)}</span></td>
              <td>{renderStatusCell(node)}</td>
              <td>{renderProgressCell(node)}</td>
              <td>{formatShortDate(node.dueDate)}</td>
              <td>
                <div className="row-actions compact-row-actions">
                  <Button tone="ghost" onClick={() => onEditTask(node)}>编辑</Button>
                  <Button tone="danger" onClick={() => onDeleteTask(node.id)}>删除</Button>
                </div>
              </td>
            </tr>
          ))}
          {!nodes.length ? <tr><td colSpan={7} className="muted">没有匹配的任务。</td></tr> : null}
        </tbody>
      </table>
    </Card>
  );
}

export function ScopePage({
  state,
  onAddScopeItem,
  onEditScopeItem,
  onScopeProgress,
  onDeleteScopeItem,
}: {
  state: AppState;
  onAddScopeItem: () => void;
  onEditScopeItem: (scopeItem: ScopeItem) => void;
  onScopeProgress: (scopeItemId: string, progress: number) => void;
  onDeleteScopeItem: (scopeItemId: string) => void;
}) {
  const scopeItems = projectScope(state).filter((item) => scopeItemMatchesSearch(state, item));
  const project = getProject(state);
  const projectPersonDays = calcProjectPersonDays(state, project);
  const sowItems = scopeItems.filter((item) => item.category === "本期SOW范围");
  const otherItems = scopeItems.filter((item) => item.category !== "本期SOW范围");
  const sowTotals = calcScopePersonDays(sowItems);
  const signedPersonDays = (value: number) => (value > 0 ? `+${value}` : String(value));
  const renderProgressCell = (item: ScopeItem) => (
    <div className="scope-progress-cell">
      <Progress value={item.progress} />
      <InlineProgressEditor
        value={item.progress}
        label={`修改 ${item.title || item.content} 进度百分比`}
        onCommit={(nextProgress) => onScopeProgress(item.id, nextProgress)}
      />
    </div>
  );
  const renderRows = (items: ScopeItem[], options: { showCategory?: boolean; emptyText: string }) => (
    <>
      {items.map((item) => (
        <tr key={item.id}>
          {options.showCategory ? <td><Badge tone={item.category === "变更增加范围" ? "warning" : ""}>{item.category}</Badge></td> : null}
          <td><Badge tone={item.personDayType === "开发" ? "purple" : "primary"}>{item.personDayType}</Badge></td>
          <td><strong>{item.title || item.content}</strong></td>
          <td className="scope-desc-cell">{item.description || item.content}</td>
          <td>{item.estimatedPersonDays}</td>
          <td className={item.actualPersonDays > item.estimatedPersonDays && item.estimatedPersonDays ? "danger-text" : ""}>{item.actualPersonDays}</td>
          <td>{renderProgressCell(item)}</td>
          <td>
            <div className="row-actions compact-row-actions">
              <Button tone="ghost" onClick={() => onEditScopeItem(item)}>编辑</Button>
              <Button tone="danger" onClick={() => onDeleteScopeItem(item.id)}>删除</Button>
            </div>
          </td>
        </tr>
      ))}
      {!items.length ? (
        <tr>
          <td colSpan={options.showCategory ? 8 : 7} className="muted">{options.emptyText}</td>
        </tr>
      ) : null}
    </>
  );
  return (
    <section className="scope-personday-page">
      <Card className="pad scope-personday-summary-card">
        <div>
          <span>项目预估人天</span>
          <div className="scope-summary-pairs">
            <span><b>实施</b><strong>{projectPersonDays.implementationBudget}</strong></span>
            <span><b>开发</b><strong>{projectPersonDays.developmentBudget}</strong></span>
          </div>
          <small>项目入口维护</small>
        </div>
        <div>
          <span>SOW预估人天</span>
          <div className="scope-summary-pairs">
            <span><b>实施</b><strong>{sowTotals.implementationEstimated}</strong></span>
            <span><b>开发</b><strong>{sowTotals.developmentEstimated}</strong></span>
          </div>
          <small>来自本期SOW范围表</small>
        </div>
        <div>
          <span>实际已用人天</span>
          <div className="scope-summary-pairs">
            <span><b>实施</b><strong className={projectPersonDays.implementationUsageRate > 100 ? "danger-text" : ""}>{projectPersonDays.implementationActual}</strong></span>
            <span><b>开发</b><strong className={projectPersonDays.developmentUsageRate > 100 ? "danger-text" : ""}>{projectPersonDays.developmentActual}</strong></span>
          </div>
          <small>实施 {projectPersonDays.implementationUsageRate}% · 开发 {projectPersonDays.developmentUsageRate}%</small>
        </div>
        <div>
          <span>人天偏差</span>
          <div className="scope-summary-pairs">
            <span><b>实施</b><strong className={projectPersonDays.implementationVariance > 0 ? "danger-text" : ""}>{signedPersonDays(projectPersonDays.implementationVariance)}</strong></span>
            <span><b>开发</b><strong className={projectPersonDays.developmentVariance > 0 ? "danger-text" : ""}>{signedPersonDays(projectPersonDays.developmentVariance)}</strong></span>
          </div>
          <small>实际 - 对比基准</small>
        </div>
      </Card>

      <Card className="pad scope-boundary-panel scope-table-panel">
        <div className="table-toolbar compact">
          <div>
            <h3>主要本期 SOW 范围</h3>
            <p className="muted">按范围标题、描述、人天和进度管理本期承诺交付范围。</p>
          </div>
          <Button tone="primary" onClick={onAddScopeItem}>新建范围项</Button>
        </div>
        <table className="table compact-table scope-effort-table">
          <thead>
            <tr>
              <th>人天类型</th>
              <th>范围标题</th>
              <th>范围描述</th>
              <th>预估人天</th>
              <th>实际人天</th>
              <th>进度</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>{renderRows(sowItems, { emptyText: "暂无本期SOW范围。" })}</tbody>
        </table>
      </Card>

      <Card className="pad scope-table-panel">
        <div className="compact-card-head">
          <div>
            <h3>其他范围</h3>
            <p className="muted">只保留变更增加范围和不在本期范围，不再拆客户责任、实施责任。</p>
          </div>
          <Badge>{otherItems.length} 项</Badge>
        </div>
        <table className="table compact-table scope-effort-table other-scope-table">
          <thead>
            <tr>
              <th>类型</th>
              <th>人天类型</th>
              <th>范围标题</th>
              <th>范围描述</th>
              <th>预估人天</th>
              <th>实际人天</th>
              <th>进度</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>{renderRows(otherItems, { showCategory: true, emptyText: "暂无其他范围。" })}</tbody>
        </table>
      </Card>
    </section>
  );
}

export function GanttPage({
  state,
  onTaskStatus,
  onTaskProgress,
}: {
  state: AppState;
  onTaskStatus: (taskId: string, status: TaskStatus) => void;
  onTaskProgress: (taskId: string, progress: number) => void;
}) {
  const project = getProject(state);
  const tasks = projectTasks(state, project.id);
  const defaultCollapsedTaskIds = () => new Set(tasks.filter((task) => tasks.some((child) => child.parentId === task.id)).map((task) => task.id));
  const [collapsed, setCollapsed] = useState<Set<string>>(defaultCollapsedTaskIds);
  const [zoom, setZoom] = useState(100);
  const nodes = flattenVisibleTaskNodes(state, tasks, collapsed);
  const stages = stageOrderForState(state, project.id);
  const ganttGridStyle = {
    "--gantt-stage-count": stages.length,
    "--gantt-stage-width": `${Math.round(120 * (zoom / 100))}px`,
  } as CSSProperties;
  const clampZoom = (nextZoom: number) => Math.min(150, Math.max(75, nextZoom));
  const updateZoom = (nextZoom: number) => setZoom(clampZoom(nextZoom));
  const changeZoom = (delta: number) => setZoom((current) => clampZoom(current + delta));
  const renderProgressControl = (node: TaskNode) => {
    if (!canEditLeafSubtask(node)) {
      return <span className="gantt-progress-readonly">{node.computedProgress}%</span>;
    }
    return (
      <input
        key={`${node.id}:${node.computedProgress}`}
        className="gantt-progress-input"
        type="number"
        min="0"
        max="100"
        defaultValue={node.computedProgress}
        aria-label={`修改 ${node.title} 进度百分比`}
        onBlur={(event) => {
          const nextProgress = clampProgressInput(event.currentTarget.valueAsNumber);
          if (nextProgress !== node.computedProgress) onTaskProgress(node.id, nextProgress);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    );
  };

  useEffect(() => {
    setCollapsed(defaultCollapsedTaskIds());
  }, [project.id, tasks.length]);

  return (
    <Card className="pad gantt-card compact-gantt-card">
      <div className="table-toolbar compact">
        <div>
          <h3>WBS / 甘特计划</h3>
          <p className="muted">WBS、状态、阶段进度、负责人和日期使用同一网格对齐。</p>
        </div>
        <div className="gantt-toolbar-actions">
          <Badge tone="primary">{nodes.length} 行</Badge>
          <div className="gantt-zoom-control" aria-label="甘特图缩放">
            <button type="button" onClick={() => changeZoom(-10)} aria-label="缩小甘特图" title="缩小">
              <ZoomOut aria-hidden="true" />
            </button>
            <input
              type="range"
              min="75"
              max="150"
              step="5"
              value={zoom}
              onChange={(event) => updateZoom(Number(event.target.value))}
              aria-label="甘特图缩放比例"
            />
            <button type="button" onClick={() => changeZoom(10)} aria-label="放大甘特图" title="放大">
              <ZoomIn aria-hidden="true" />
            </button>
            <span>{zoom}%</span>
          </div>
        </div>
      </div>
      <div className="gantt-grid-scroll" aria-label="WBS 甘特计划">
        <div className="gantt-grid" style={ganttGridStyle}>
          <div className="gantt-grid-row gantt-grid-head">
            <div className="gantt-grid-cell gantt-wbs-cell">WBS</div>
            <div className="gantt-grid-cell gantt-status-cell">状态</div>
            <div className="gantt-grid-cell gantt-progress-cell">进度</div>
            {stages.map((stage) => (
              <div key={stage} className="gantt-grid-cell gantt-stage-head">
                {stageLabel(state, stage, project.id)}
              </div>
            ))}
            <div className="gantt-grid-cell">负责人</div>
            <div className="gantt-grid-cell">起止</div>
          </div>
          {nodes.map((node) => {
            const activeStage = stages.includes(node.stage) ? node.stage : stages[0];
            return (
              <div key={node.id} className={`gantt-grid-row ${node.children.length ? "is-parent" : ""}`}>
                <div className="gantt-grid-cell gantt-wbs-cell">
                  <GanttTaskCell node={node} collapsed={collapsed} onToggle={(taskId) => setCollapsed((value) => toggleCollapsed(value, taskId))} />
                </div>
                <div className="gantt-grid-cell gantt-status-cell">
                  {!canEditLeafSubtask(node) ? (
                    <span className={`gantt-status-control readonly ${statusCssClass(node.computedStatus)}`} title="主任务状态由子任务自动汇总">
                      <span className="status-dot" />
                      <span>{taskStatusLabels[node.computedStatus]}</span>
                    </span>
                  ) : (
                    <label className={`gantt-status-control ${statusCssClass(node.status)}`} title="修改任务状态">
                      <span className="status-dot" />
                      <select
                        className="gantt-status-select"
                        value={node.status}
                        aria-label={`修改 ${node.title} 状态`}
                        onChange={(event) => {
                          const nextStatus = event.target.value as TaskStatus;
                          if (node.status !== nextStatus) onTaskStatus(node.id, nextStatus);
                        }}
                      >
                        {statusColumns.map(([status, label]) => (
                          <option key={status} value={status}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <div className="gantt-grid-cell gantt-progress-cell">{renderProgressControl(node)}</div>
                {stages.map((stage) => {
                  const isActiveStage = stage === activeStage;
                  return (
                    <div key={stage} className={`gantt-grid-cell gantt-stage-cell ${isActiveStage ? "active" : ""}`}>
                      {isActiveStage ? (
                        <span
                          className={`gantt-stage-pill ${statusCssClass(node.computedStatus)}`}
                          style={{ "--value": node.computedProgress } as CSSProperties}
                          title={`${stageLabel(state, stage, project.id)} · ${node.computedProgress}% · ${taskStatusLabels[node.computedStatus]}`}
                        >
                          <span>{node.computedProgress}%</span>
                        </span>
                      ) : null}
                    </div>
                  );
                })}
                <div className="gantt-grid-cell gantt-owner-cell">{node.owner}</div>
                <div className="gantt-grid-cell gantt-date-cell">{formatTaskRange(node)}</div>
              </div>
            );
          })}
          {!nodes.length ? <div className="empty compact gantt-empty">没有匹配的 WBS 任务。</div> : null}
        </div>
      </div>
    </Card>
  );
}

export function DeliverablesPage({
  state,
  onAddDeliverable,
  onEditDeliverable,
  onSaveDeliverable,
  onSaveDeliverableStoragePath,
  onDeleteDeliverable,
}: {
  state: AppState;
  onAddDeliverable: () => void;
  onEditDeliverable: (deliverable: Deliverable) => void;
  onSaveDeliverable: (deliverable: Deliverable) => Promise<void>;
  onSaveDeliverableStoragePath: (projectId: string, path: string) => Promise<void>;
  onDeleteDeliverable: (deliverableId: string) => void;
}) {
  const project = getProject(state);
  const tasks = projectTasks(state, project.id);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const taskByCode = new Map(tasks.map((task) => [task.code, task]));
  const deliverables = projectDeliverables(state).filter((item) => deliverableMatchesSearch(state, item));
  const [directoryHandle, setDirectoryHandle] = useState<LocalDirectoryHandle | null>(() => getCachedDeliverableDirectory(project.id)?.handle || null);
  const [storageMessage, setStorageMessage] = useState<{ tone: "success" | "warning" | "danger"; text: string } | null>(null);
  const deliverableAcceptanceOptions = ["待确认", "待验收", "待评审", "客户确认", "客户验收", "内部确认", "已验收", "未提交"];
  const attachmentUploadStateOptions: Array<{ value: NonNullable<Deliverable["attachmentRequirement"]>; label: string }> = [
    { value: "required", label: "未上传" },
    { value: "none", label: "无需上传" },
  ];

  useEffect(() => {
    let cancelled = false;
    const cachedRecord = getCachedDeliverableDirectory(project.id);
    setDirectoryHandle(cachedRecord?.handle || null);
    setStorageMessage(null);
    if (!cachedRecord?.handle) {
      void loadDeliverableDirectoryHandle(project.id).then((record) => {
        if (cancelled || !record?.handle) return;
        setDirectoryHandle(record.handle);
        if (!project.deliverableStoragePath && record.pathLabel) {
          void onSaveDeliverableStoragePath(project.id, record.pathLabel);
        }
      });
    }
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const resolveLinkedTask = (item: Deliverable) => (item.linkedTaskId ? taskById.get(item.linkedTaskId) : undefined) || taskByCode.get(item.code);
  const currentStorageLabel = project.deliverableStoragePath || getDeliverableDirectoryPathLabel(project.id) || directoryHandle?.name || "未配置保存路径";
  const attachmentRequirement = (item: Deliverable): NonNullable<Deliverable["attachmentRequirement"]> => item.attachmentRequirement || "required";
  const acceptanceTone = (value: string) => {
    if (/已验收|内部确认/.test(value)) return "success";
    if (/客户确认|客户验收/.test(value)) return "primary";
    if (/未提交/.test(value)) return "danger";
    if (/待/.test(value)) return "warning";
    return "neutral";
  };

  const saveDeliverableField = async (item: Deliverable, changes: Partial<Deliverable>) => {
    try {
      await onSaveDeliverable({ ...item, ...changes });
    } catch (error) {
      const message = error instanceof Error ? error.message : "交付物保存失败。";
      setStorageMessage({ tone: "danger", text: message });
    }
  };

  const renderInlineChoice = ({
    value,
    options,
    label,
    tone,
    minWidth,
    openOn,
    onChange,
  }: {
    value: string;
    options: Array<string | { value: string; label: string }>;
    label: string;
    tone: string;
    minWidth?: number;
    openOn?: "click" | "double";
    onChange: (value: string) => void;
  }) => <InlineChoiceEditor value={value} options={options} label={label} tone={tone} minWidth={minWidth} openOn={openOn} onChange={onChange} />;

  const chooseDirectory = async () => {
    try {
      const record = await chooseDeliverableProjectDirectory(project);
      setDirectoryHandle(record.handle);
      await onSaveDeliverableStoragePath(project.id, record.pathLabel);
      setStorageMessage({ tone: "success", text: `保存路径已配置：${record.pathLabel}` });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      const message = error instanceof Error ? error.message : "选择保存路径失败。";
      setStorageMessage({ tone: "danger", text: message });
    }
  };

  const uploadAttachment = async (item: Deliverable, file?: File) => {
    if (!file) return;
    const linkedTask = resolveLinkedTask(item);
    if (!linkedTask) {
      setStorageMessage({ tone: "warning", text: "请先为交付物选择关联任务项。" });
      return;
    }
    try {
      const attachment = await saveDeliverableAttachmentFile({
        projectId: project.id,
        storageLabel: currentStorageLabel,
        stageLabel: stageLabel(state, linkedTask.stage, linkedTask.projectId),
        file,
        previousAttachmentName: item.attachmentName,
        previousAttachmentPath: item.attachmentPath,
      });
      await onSaveDeliverable({
        ...item,
        linkedTaskId: item.linkedTaskId || linkedTask.id,
        code: linkedTask.code,
        attachmentRequirement: "required",
        ...attachment,
      });
      setStorageMessage({ tone: "success", text: `附件已保存：${attachment.attachmentPath}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : "附件保存失败，请确认目录写入权限后重试。";
      setStorageMessage({ tone: "danger", text: message });
    }
  };

  const renderLinkedTask = (item: Deliverable) => {
    const linkedTask = resolveLinkedTask(item);
    return linkedTask ? `${linkedTask.code} - ${linkedTask.title}` : item.code || "未关联";
  };

  const renderAttachment = (item: Deliverable) => (
    <div className="deliverable-attachment-cell">
      {attachmentRequirement(item) === "none" ? (
        <button
          type="button"
          className="deliverable-attachment-static"
          aria-label={`双击将 ${item.name} 改为未上传`}
          title="无需上传，双击改为未上传"
          onDoubleClick={() => {
            void saveDeliverableField(item, { attachmentRequirement: "required" });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              void saveDeliverableField(item, { attachmentRequirement: "required" });
            }
          }}
        >
          <CircleCheck aria-hidden="true" />
          无需上传
        </button>
      ) : item.attachmentName ? (
        <span className="deliverable-attachment-name" title={item.attachmentPath || item.attachmentName}>
          <Paperclip aria-hidden="true" />
          {item.attachmentName}
        </span>
      ) : (
        renderInlineChoice({
          value: "required",
          options: attachmentUploadStateOptions,
          label: `修改 ${item.name} 附件状态`,
          tone: "warning",
          minWidth: 96,
          onChange: (value) => {
            void saveDeliverableField(item, { attachmentRequirement: value === "none" ? "none" : "required" });
          },
        })
      )}
      {attachmentRequirement(item) === "required" ? (
        <label className="file-upload-button">
          <Upload aria-hidden="true" />
          上传
          <input
            type="file"
            onChange={(event) => {
              const input = event.currentTarget;
              const file = input.files?.[0];
              void uploadAttachment(item, file).finally(() => {
                input.value = "";
              });
            }}
          />
        </label>
      ) : null}
    </div>
  );

  return (
    <Card className="pad compact-ledger-card">
      <div className="table-toolbar compact">
        <div>
          <h3>交付物管理</h3>
          <p className="muted">交付物关联任务项，并按任务阶段保存附件。</p>
          <div className="deliverable-storage-line">
            <span>保存路径：{currentStorageLabel}</span>
            {storageMessage ? <span className={`deliverable-storage-message ${storageMessage.tone}`}>{storageMessage.text}</span> : null}
          </div>
        </div>
        <div className="deliverable-toolbar-actions">
          <Button tone="ghost" onClick={chooseDirectory}>
            <FolderOpen aria-hidden="true" />
            选择保存路径
          </Button>
          <Button tone="primary" onClick={onAddDeliverable}>新建交付物</Button>
        </div>
      </div>
      <table className="table compact-table deliverable-table">
        <colgroup>
          <col className="deliverable-col-name" />
          <col className="deliverable-col-task" />
          <col className="deliverable-col-acceptance" />
          <col className="deliverable-col-date" />
          <col className="deliverable-col-attachment" />
          <col className="deliverable-col-actions" />
        </colgroup>
        <thead>
          <tr>
            <th>交付物</th>
            <th>关联任务项</th>
            <th>验收</th>
            <th>截止</th>
            <th>附件</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {deliverables.map((item) => (
            <tr key={item.id}>
              <td className="deliverable-name-cell"><strong title={item.name}>{item.name}</strong></td>
              <td className="muted deliverable-linked-task">{renderLinkedTask(item)}</td>
              <td>
                {renderInlineChoice({
                  value: item.acceptance,
                  options: deliverableAcceptanceOptions,
                  label: `修改 ${item.name} 验收状态`,
                  tone: acceptanceTone(item.acceptance),
                  minWidth: 116,
                  onChange: (value) => {
                    void saveDeliverableField(item, { acceptance: value });
                  },
                })}
              </td>
              <td>{formatShortDate(item.dueDate)}</td>
              <td>{renderAttachment(item)}</td>
              <td>
                <div className="row-actions compact-row-actions">
                  <Button tone="ghost" onClick={() => onEditDeliverable(item)}>编辑</Button>
                  <Button tone="danger" onClick={() => onDeleteDeliverable(item.id)}>删除</Button>
                </div>
              </td>
            </tr>
          ))}
          {!deliverables.length ? <tr><td colSpan={6} className="muted">没有匹配的交付物。</td></tr> : null}
        </tbody>
      </table>
    </Card>
  );
}

export function RisksPage({
  state,
  onAddRiskIssue,
  onEditRiskIssue,
  onDeleteRiskIssue,
}: {
  state: AppState;
  onAddRiskIssue: (riskKind: RiskIssue["kind"]) => void;
  onEditRiskIssue: (riskIssue: RiskIssue) => void;
  onDeleteRiskIssue: (riskIssueId: string) => void;
}) {
  const risks = projectRisks(state).filter((item) => item.kind === "risk").filter((item) => riskIssueMatchesSearch(state, item));
  const issues = projectRisks(state).filter((item) => item.kind === "issue").filter((item) => riskIssueMatchesSearch(state, item));
  const renderGroup = (title: string, items: RiskIssue[], kind: RiskIssue["kind"]) => (
    <Card className="pad risk-list-panel">
      <div className="table-toolbar compact">
        <div>
          <h3>{title}</h3>
          <p className="muted">{items.length} 个 · 高 {items.filter((item) => item.severity === "高").length} · 中 {items.filter((item) => item.severity === "中").length}</p>
        </div>
        <Button tone="primary" onClick={() => onAddRiskIssue(kind)}>新建{kind === "risk" ? "风险" : "问题"}</Button>
      </div>
      <div className="compact-signal-list">
        {items.map((item) => (
          <div key={item.id} className={`compact-signal-item priority-${item.severity === "高" ? "high" : item.severity === "中" ? "medium" : "low"}`}>
            <div className="compact-signal-line">
              <strong>{item.title}</strong>
              <span className={`severity-dot ${item.severity === "高" ? "high" : item.severity === "中" ? "medium" : "low"}`}>{item.severity}</span>
              <Badge>{riskStatusLabel(item.status)}</Badge>
            </div>
            <p>{item.responsePlan}</p>
            <div className="compact-item-actions">
              <Button tone="ghost" onClick={() => onEditRiskIssue(item)}>编辑</Button>
              <Button tone="danger" onClick={() => onDeleteRiskIssue(item.id)}>删除</Button>
            </div>
          </div>
        ))}
        {!items.length ? <div className="empty compact">没有匹配的{kind === "risk" ? "风险" : "问题"}。</div> : null}
      </div>
    </Card>
  );
  return <section className="risk-stack-layout">{renderGroup("风险：可能发生", risks, "risk")}{renderGroup("问题：已经发生", issues, "issue")}</section>;
}

function toggleTaskId(taskIds: string[], taskId: string) {
  return taskIds.includes(taskId) ? taskIds.filter((id) => id !== taskId) : [...taskIds, taskId];
}

function taskNodeOptionMeta(state: AppState, node: TaskNode) {
  return `${node.code} · ${stageLabel(state, node.stage, node.projectId)} · ${taskStatusLabels[node.computedStatus]} · ${node.computedProgress}%`;
}

function taskSearchText(state: AppState, node: TaskNode) {
  return [
    node.code,
    node.title,
    node.owner,
    stageLabel(state, node.stage, node.projectId),
    taskStatusLabels[node.status],
    taskStatusLabels[node.computedStatus],
    `${node.progress}%`,
    `${node.computedProgress}%`,
  ]
    .join(" ")
    .toLowerCase();
}

function selectableTaskDescendants(root: TaskNode, allowTask: (node: TaskNode) => boolean) {
  const tasks: TaskNode[] = [];
  const visit = (node: TaskNode) => {
    if (canEditLeafSubtask(node) && allowTask(node)) tasks.push(node);
    node.children.forEach(visit);
  };
  root.children.forEach(visit);
  return tasks;
}

function filteredTaskGroups({
  taskTree,
  search,
  state,
  allowTask,
}: {
  taskTree: TaskNode[];
  search: string;
  state: AppState;
  allowTask: (node: TaskNode) => boolean;
}) {
  const query = search.trim().toLowerCase();
  return taskTree
    .map((root) => {
      const allChildren = selectableTaskDescendants(root, allowTask);
      const rootMatches = !query || taskSearchText(state, root).includes(query);
      const children = rootMatches ? allChildren : allChildren.filter((node) => taskSearchText(state, node).includes(query));
      return { root, children };
    })
    .filter((group) => group.children.length > 0);
}

function WeeklyTaskSelector({
  title,
  description,
  taskTree,
  search,
  allowTask = () => true,
  selectedIds,
  state,
  onChange,
}: {
  title: string;
  description: string;
  taskTree: TaskNode[];
  search: string;
  allowTask?: (node: TaskNode) => boolean;
  selectedIds: string[];
  state: AppState;
  onChange: (taskIds: string[]) => void;
}) {
  const groups = filteredTaskGroups({ taskTree, search, state, allowTask });
  const allSelectableCount = taskTree.reduce((sum, root) => sum + selectableTaskDescendants(root, allowTask).length, 0);
  const [expandedRootIds, setExpandedRootIds] = useState<Set<string>>(new Set());
  const query = search.trim();
  const toggleRoot = (rootId: string) => {
    setExpandedRootIds((current) => {
      const next = new Set(current);
      if (next.has(rootId)) {
        next.delete(rootId);
      } else {
        next.add(rootId);
      }
      return next;
    });
  };

  return (
    <div className="weekly-task-selector">
      <div className="weekly-block-title">
        <div>
          <strong>{title}</strong>
          <span>{description}</span>
        </div>
        <Badge tone={selectedIds.length ? "primary" : "warning"}>{selectedIds.length}/{allSelectableCount}</Badge>
      </div>
      <div className="weekly-task-groups">
        {groups.map(({ root, children }) => {
          const selectedCount = children.filter((task) => selectedIds.includes(task.id)).length;
          const expanded = Boolean(query) || expandedRootIds.has(root.id);
          return (
            <section className={`weekly-task-group ${expanded ? "expanded" : "collapsed"}`} key={root.id}>
              <button type="button" className="weekly-task-parent" onClick={() => toggleRoot(root.id)} aria-expanded={expanded}>
                {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                <FolderOpen aria-hidden="true" />
                <span>
                  <strong title={root.title}>{root.title}</strong>
                  <small>{root.code} · 主任务 · {selectedCount}/{children.length} 个子任务已选</small>
                </span>
              </button>
              {expanded ? (
                <div className="weekly-task-children">
                  {children.map((task) => (
                    <label key={task.id} className={`weekly-task-option ${selectedIds.includes(task.id) ? "selected" : ""}`}>
                      <input type="checkbox" checked={selectedIds.includes(task.id)} onChange={() => onChange(toggleTaskId(selectedIds, task.id))} />
                      <span>
                        <strong title={task.title}>{task.title}</strong>
                        <small>{taskNodeOptionMeta(state, task)}</small>
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}
            </section>
          );
        })}
        {!groups.length ? <div className="empty compact">{search.trim() ? "没有匹配的可选子任务。" : "当前项目暂无可选择的子任务。"}</div> : null}
      </div>
    </div>
  );
}

function stripInlineMarkdownText(value: string) {
  return value.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim();
}

function extractPercent(value: string) {
  const normalized = stripInlineMarkdownText(value);
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!match) return null;
  const percent = Number(match[1]);
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
}

function weeklyStatusClass(value: string) {
  const status = stripInlineMarkdownText(value);
  if (/健康|已完成|已验收|内部确认|完成|关闭|低/.test(status)) return "status-healthy";
  if (/需关注|客户待确认|待确认|跟踪|中|待验收|待上传|进行|开发|实施/.test(status)) return "status-attention";
  if (/延期|逾期|阻塞|高/.test(status)) return "status-delay";
  if (/暂停|未开始|待办|未上传|未维护/.test(status)) return "status-paused";
  if (/风险|打开|问题/.test(status)) return "status-risk";
  return "status-neutral";
}

function WeeklyStatusPill({ value }: { value: string }) {
  return <span className={`weekly-status-pill ${weeklyStatusClass(value)}`}>{stripInlineMarkdownText(value)}</span>;
}

function WeeklyProgressBar({ value, label }: { value: number; label?: string }) {
  return (
    <span className="weekly-progress-cell" aria-label={label || `进度 ${value}%`}>
      <span className="weekly-progress-track">
        <span className="weekly-progress-fill" style={{ width: `${value}%` }} />
      </span>
      <strong>{value}%</strong>
    </span>
  );
}

function shouldRenderProgressCell(header: string, cell: string, rowLabel = "") {
  const normalizedHeader = stripInlineMarkdownText(header).replace(/\s/g, "");
  const normalizedRowLabel = stripInlineMarkdownText(rowLabel).replace(/\s/g, "");
  if (normalizedHeader === "指标") return false;
  if (!extractPercent(cell) && extractPercent(cell) !== 0) return false;
  return (
    normalizedHeader.includes("进度") ||
    normalizedHeader.includes("使用率") ||
    normalizedHeader.includes("占比") ||
    normalizedRowLabel.includes("进度") ||
    normalizedRowLabel.includes("使用率") ||
    normalizedRowLabel.includes("阶段")
  );
}

function shouldRenderStatusCell(header: string, rowLabel = "") {
  const normalizedHeader = stripInlineMarkdownText(header).replace(/\s/g, "");
  const normalizedRowLabel = stripInlineMarkdownText(rowLabel).replace(/\s/g, "");
  if (normalizedHeader === "指标") return false;
  return normalizedHeader.includes("状态") || normalizedHeader === "验收" || normalizedHeader === "等级" || normalizedRowLabel.includes("状态");
}

function renderWeeklyPreviewCell(header: string, cell: string, rowLabel = "") {
  const percent = extractPercent(cell);
  if (percent !== null && shouldRenderProgressCell(header, cell, rowLabel)) return <WeeklyProgressBar value={percent} label={stripInlineMarkdownText(cell)} />;
  if (cell && shouldRenderStatusCell(header, rowLabel)) return <WeeklyStatusPill value={cell} />;
  return renderInlineMarkdown(cell);
}

function countRowsInSection(content: string, sectionKeyword: string) {
  const lines = content.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^#{1,4}\s+/.test(line.trim()) && line.includes(sectionKeyword));
  if (headingIndex < 0) return 0;
  const tableIndex = lines.findIndex((line, index) => index > headingIndex && isMarkdownTableStart(lines, index));
  if (tableIndex < 0) {
    let index = headingIndex + 1;
    let count = 0;
    while (index < lines.length && !/^#{1,4}\s+/.test(lines[index].trim())) {
      if (/^[-*]\s+/.test(lines[index].trim()) && !/暂无/.test(lines[index])) count += 1;
      index += 1;
    }
    return count;
  }
  let index = tableIndex + 2;
  let count = 0;
  while (index < lines.length && lines[index].includes("|") && !tableSeparatorPattern.test(lines[index])) {
    const row = parseMarkdownTableRow(lines[index]);
    if (!/^暂无$/.test(stripInlineMarkdownText(row[0] || ""))) count += 1;
    index += 1;
  }
  return count;
}

function extractWeeklyVisualStats(content: string) {
  const progressMatch = content.match(/整体进度\s+\*\*(\d+(?:\.\d+)?)%\*\*/);
  const fallbackProgressMatch = content.match(/整体进度\s*(\d+(?:\.\d+)?)%/);
  const statusMatch = content.match(/项目状态为\s+\*\*([^*]+)\*\*/);
  const taskCompletionMatch = content.match(/任务完成情况：已完成\s+(\d+)\/(\d+)\s+项，开放\s+(\d+)\s+项/);
  const thisWeekMatch = content.match(/本周已纳入\s+(\d+)\s+个/);
  const nextWeekMatch = content.match(/下周计划推进\s+(\d+)\s+个/);
  const progress = Number(progressMatch?.[1] || fallbackProgressMatch?.[1] || 0);
  return {
    progress: Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : 0,
    status: statusMatch?.[1] || "未维护",
    doneCount: Number(taskCompletionMatch?.[1] || 0),
    totalCount: Number(taskCompletionMatch?.[2] || 0),
    openCount: Number(taskCompletionMatch?.[3] || 0),
    thisWeekCount: Number(thisWeekMatch?.[1] || 0),
    nextWeekCount: Number(nextWeekMatch?.[1] || 0),
    riskCount: countRowsInSection(content, "风险 / 问题"),
  };
}

function WeeklyVisualSummary({ content }: { content: string }) {
  const stats = extractWeeklyVisualStats(content);
  const bars = [
    ["本周任务", stats.thisWeekCount],
    ["下周任务", stats.nextWeekCount],
    ["风险问题", stats.riskCount],
  ] as const;
  const maxValue = Math.max(1, ...bars.map(([, value]) => value));

  return (
    <div className="weekly-visual-summary">
      <div className="weekly-visual-card progress">
        <div className="weekly-ring-chart" style={{ "--value": `${stats.progress}%` } as CSSProperties}>
          <strong>{stats.progress}%</strong>
          <span>整体进度</span>
        </div>
        <small className="weekly-progress-summary">已完成 {stats.doneCount}/{stats.totalCount} 项，开放 {stats.openCount} 项</small>
      </div>
      <div className="weekly-visual-card status">
        <span>项目状态</span>
        <WeeklyStatusPill value={stats.status} />
        <small>打开风险 / 问题 {stats.riskCount} 项。</small>
      </div>
      <div className="weekly-visual-card analysis">
        <span>本周分析</span>
        <div className="weekly-mini-bars">
          {bars.map(([label, value]) => (
            <div className="weekly-mini-bar" key={label}>
              <span>{label}</span>
              <div><i style={{ width: `${Math.max(6, Math.round((value / maxValue) * 100))}%` }} /></div>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function isWeeklyPreviewBlockStart(lines: string[], index: number) {
  const line = lines[index] || "";
  return !line.trim() || /^报告日期：|^统计周期：/.test(line.trim()) || /^#{1,4}\s+/.test(line) || /^\d+[.)]\s+/.test(line) || /^[-*]\s+/.test(line) || isMarkdownTableStart(lines, index);
}

function WeeklyDraftPreview({ content }: { content: string }) {
  const lines = content.split(/\r?\n/);
  const blocks: JSX.Element[] = [];
  let index = 0;
  let currentHeading = "";
  let visualSummaryInserted = false;

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
        <div className="weekly-preview-table-wrap" key={`table-${blocks.length}`}>
          <table className="weekly-preview-table">
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
                    <td key={`c-${rowIndex}-${cellIndex}`}>{renderWeeklyPreviewCell(header[cellIndex] || "", row[cellIndex] || "", row[0] || "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      currentHeading = heading[2];
      if (level === 1) {
        blocks.push(
          <header className="weekly-preview-cover" key={`heading-${blocks.length}`}>
            <span>项目周报</span>
            <h1>{renderInlineMarkdown(heading[2])}</h1>
          </header>,
        );
      } else {
        const Tag = level === 2 ? "h2" : "h3";
        blocks.push(
          <Tag className={level === 2 ? "weekly-preview-heading" : "weekly-preview-subheading"} key={`heading-${blocks.length}`}>
            {renderInlineMarkdown(heading[2])}
          </Tag>,
        );
      }
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
        <ol className="weekly-preview-list" key={`ol-${blocks.length}`}>
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
        <ul className="weekly-preview-list" key={`ul-${blocks.length}`}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    const paragraph: string[] = [trimmed];
    index += 1;
    while (index < lines.length && !isWeeklyPreviewBlockStart(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    const text = paragraph.join(" ").trim();
    const meta = /^报告日期：|^统计周期：/.test(text);
    blocks.push(
      <p className={meta ? "weekly-preview-meta" : "weekly-preview-paragraph"} key={`p-${blocks.length}`}>
        {renderInlineMarkdown(text)}
      </p>,
    );
    if (!meta && !visualSummaryInserted && /执行摘要/.test(currentHeading)) {
      blocks.push(<WeeklyVisualSummary content={content} key={`visual-${blocks.length}`} />);
      visualSummaryInserted = true;
    }
  }

  return <article className="weekly-preview-document">{blocks}</article>;
}

function WeeklyDraftFullscreen({
  content,
  mode,
  onModeChange,
  onChange,
  onClose,
}: {
  content: string;
  mode: "preview" | "edit";
  onModeChange: (mode: "preview" | "edit") => void;
  onChange: (content: string) => void;
  onClose: () => void;
}) {
  return createPortal(
    <div className="weekly-fullscreen-backdrop" role="presentation">
      <section className="weekly-fullscreen-panel" role="dialog" aria-modal={true} aria-label="周报草稿全屏编辑预览">
        <div className="weekly-fullscreen-head">
          <div>
            <h3>周报草稿</h3>
            <p className="muted">全屏模式下可切换编辑和邮件预览。</p>
          </div>
          <div className="weekly-editor-tools">
            <div className="weekly-mode-switch" role="group" aria-label="周报草稿模式">
              <button type="button" className={mode === "preview" ? "active" : ""} onClick={() => onModeChange("preview")}>
                <Eye aria-hidden="true" />
                预览
              </button>
              <button type="button" className={mode === "edit" ? "active" : ""} onClick={() => onModeChange("edit")}>
                <PencilLine aria-hidden="true" />
                编辑
              </button>
            </div>
            <Button tone="ghost" onClick={onClose}>
              <Minimize2 aria-hidden="true" />
              退出全屏
            </Button>
          </div>
        </div>
        <div className={`weekly-fullscreen-body ${mode}`}>
          {mode === "edit" ? (
            <textarea className="weekly-draft-textarea fullscreen" value={content} onChange={(event) => onChange(event.target.value)} />
          ) : (
            <div className="weekly-preview-shell fullscreen">
              <WeeklyDraftPreview content={content} />
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function WeeklyDraftComposer({
  content,
  onChange,
}: {
  content: string;
  onChange: (content: string) => void;
}) {
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [fullscreen, setFullscreen] = useState(false);

  return (
    <div className="weekly-draft-composer">
      <div className="weekly-draft-toolbar">
        <div className="weekly-mode-switch" role="group" aria-label="周报草稿模式">
          <button type="button" className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>
            <Eye aria-hidden="true" />
            预览
          </button>
          <button type="button" className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")}>
            <PencilLine aria-hidden="true" />
            编辑
          </button>
        </div>
        <button type="button" className="weekly-fullscreen-button" onClick={() => setFullscreen(true)}>
          <Maximize2 aria-hidden="true" />
          全屏
        </button>
      </div>
      {mode === "edit" ? (
        <textarea className="weekly-draft-textarea" value={content} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <div className="weekly-preview-shell">
          <WeeklyDraftPreview content={content} />
        </div>
      )}
      {fullscreen ? (
        <WeeklyDraftFullscreen
          content={content}
          mode={mode}
          onModeChange={setMode}
          onChange={onChange}
          onClose={() => setFullscreen(false)}
        />
      ) : null}
    </div>
  );
}

function weeklyMailSubjectToTemplate(subject: string, reportDate: string) {
  const trimmed = subject.trim();
  if (!trimmed || !reportDate) return trimmed;
  return trimmed.split(reportDate.replace(/-/g, "")).join("{{dateCompact}}").split(reportDate).join("{{date}}");
}

function buildWeeklyMailSubjectFromTemplate(template: string | undefined, project: { name: string; client: string }, reportDate: string) {
  const trimmed = (template || "").trim();
  if (!trimmed) return "";
  if (trimmed === `${project.name} 项目周报 {{date}}` || trimmed === `${project.name} 周报 {{date}}`) return "";
  return trimmed
    .replace(/\{\{\s*dateCompact\s*\}\}/gi, reportDate.replace(/-/g, ""))
    .replace(/\{\{\s*date\s*\}\}/gi, reportDate)
    .replace(/\{\{\s*projectName\s*\}\}/gi, project.name)
    .replace(/\{\{\s*clientName\s*\}\}/gi, project.client || "");
}

type WeeklyConfigDraft = {
  projectOwner: string;
  implementationMode: ProjectImplementationMode;
  projectStatus: WeeklyProjectStatus;
  recipientsTo: string;
  recipientsCc: string;
  mailSubject: string;
};

function WeeklyConfigModal({
  draft,
  onChange,
  onSave,
  onClose,
}: {
  draft: WeeklyConfigDraft;
  onChange: (draft: WeeklyConfigDraft) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const updateDraft = (patch: Partial<WeeklyConfigDraft>) => onChange({ ...draft, ...patch });

  return createPortal(
    <div className="weekly-config-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="weekly-config-modal" role="dialog" aria-modal={true} aria-label="周报配置" onMouseDown={(event) => event.stopPropagation()}>
        <div className="weekly-config-modal-head">
          <div>
            <h3>周报配置</h3>
            <p className="muted">配置会长期保存到当前项目，直到下次修改。</p>
          </div>
          <button type="button" className="weekly-config-close" onClick={onClose} aria-label="关闭周报配置">
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="weekly-config-form">
          <label className="field">
            <span>项目负责人</span>
            <input value={draft.projectOwner} onChange={(event) => updateDraft({ projectOwner: event.currentTarget.value })} placeholder="填写周报负责人" />
          </label>
          <label className="field">
            <span>项目实施方式</span>
            <select value={draft.implementationMode} onChange={(event) => updateDraft({ implementationMode: event.currentTarget.value as ProjectImplementationMode })}>
              {weeklyImplementationModes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
            </select>
          </label>
          <label className="field">
            <span>项目状态</span>
            <select value={draft.projectStatus} onChange={(event) => updateDraft({ projectStatus: event.currentTarget.value as WeeklyProjectStatus })}>
              {weeklyProjectStatuses.map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </label>
          <label className="field wide">
            <span>发送给</span>
            <textarea value={draft.recipientsTo} onChange={(event) => updateDraft({ recipientsTo: event.currentTarget.value })} placeholder="name@example.com，多个收件人可用逗号、分号或换行分隔" />
          </label>
          <label className="field wide">
            <span>抄送给</span>
            <textarea value={draft.recipientsCc} onChange={(event) => updateDraft({ recipientsCc: event.currentTarget.value })} placeholder="可选，多个抄送人可用逗号、分号或换行分隔" />
          </label>
          <label className="field wide">
            <span>邮件主题</span>
            <input value={draft.mailSubject} onChange={(event) => updateDraft({ mailSubject: event.currentTarget.value })} />
          </label>
        </div>
        <div className="weekly-config-modal-actions">
          <Button tone="ghost" onClick={onClose}>取消</Button>
          <Button tone="primary" onClick={onSave}>
            <Save aria-hidden="true" />
            保存配置
          </Button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

export function WeeklyPage({
  state,
  onPage,
  onSave,
  onSavePreference,
}: {
  state: AppState;
  aiService: AiService;
  onPage: (page: PageKey) => void;
  onSave: (report: WeeklyReportInput) => void;
  onSavePreference: (preference: WeeklyReportPreferenceInput) => void;
}) {
  const project = getProject(state);
  const today = localDateKey();
  const projectReports = useMemo(
    () => state.weeklyReports.filter((report) => report.projectId === project.id).sort((a, b) => b.reportDate.localeCompare(a.reportDate)),
    [project.id, state.weeklyReports],
  );
  const projectReportsKey = projectReports.map((report) => `${report.id}:${report.updatedAt}`).join("|");
  const projectProfileKey = `${project.id}:${project.name}:${project.client}:${project.owner}:${project.phase}:${project.nextMilestone}:${project.progress}`;
  const weeklySourceKey = useMemo(() => {
    const taskKey = state.tasks
      .filter((task) => task.projectId === project.id)
      .map((task) => `${task.id}:${task.parentId}:${task.title}:${task.status}:${task.stage}:${task.owner}:${task.startDate}:${task.dueDate}:${task.progress}:${task.updatedAt}`)
      .join("|");
    const scopeKey = state.scopeItems
      .filter((item) => item.projectId === project.id)
      .map((item) => `${item.id}:${item.category}:${item.personDayType}:${item.title}:${item.actualPersonDays}:${item.estimatedPersonDays}:${item.progress}`)
      .join("|");
    const riskKey = state.risksIssues
      .filter((item) => item.projectId === project.id)
      .map((item) => `${item.id}:${item.kind}:${item.title}:${item.severity}:${item.status}:${item.responsePlan}:${item.linkedTaskId}`)
      .join("|");
    const deliverableKey = state.deliverables
      .filter((item) => item.projectId === project.id)
      .map((item) => `${item.id}:${item.name}:${item.code}:${item.status}:${item.acceptance}:${item.dueDate}:${item.linkedTaskId}`)
      .join("|");
    const stageKey = stageDefinitionsForProject(state, project.id).map((stage) => `${stage.id}:${stage.label}:${stage.coefficient ?? 1}`).join("|");
    return `${taskKey}||${scopeKey}||${riskKey}||${deliverableKey}||${stageKey}`;
  }, [project.id, state.deliverables, state.projectStageConfigs, state.risksIssues, state.scopeItems, state.taskStages, state.tasks]);
  const latestTodayReport = useMemo(() => projectReports.find((report) => report.reportDate === today), [projectReports, today]);
  const [selectedReportId, setSelectedReportId] = useState(latestTodayReport?.id || "");
  const selectedReport = selectedReportId ? projectReports.find((report) => report.id === selectedReportId) : latestTodayReport;
  const latestProjectReport = projectReports[0];
  const projectPreference = state.weeklyReportPreferences.find((preference) => preference.projectId === project.id);
  const projectPreferenceKey = projectPreference
    ? `${projectPreference.projectId}:${projectPreference.projectOwner}:${projectPreference.implementationMode}:${projectPreference.projectStatus}:${projectPreference.recipientsTo}:${projectPreference.recipientsCc}:${projectPreference.mailSubjectTemplate}:${projectPreference.updatedAt}`
    : "";
  const reportDate = selectedReport?.reportDate || today;
  const reportDateObject = new Date(`${reportDate}T00:00:00`);
  const week = weekRangeFor(reportDateObject);
  const nextWeek = nextWeekRangeFor(reportDateObject);
  const allLeafSubtasks = getLeafSubtasks(state, project.id);
  const weeklyTaskTree = useMemo(() => buildTaskTree(projectTasks(state, project.id)), [project.id, state.tasks]);
  const preferredProjectOwner = projectPreference ? projectPreference.projectOwner : selectedReport?.projectOwner || latestProjectReport?.projectOwner || project.owner || "";
  const preferredImplementationMode = projectPreference?.implementationMode || selectedReport?.implementationMode || latestProjectReport?.implementationMode || "本地实施";
  const preferredProjectStatus = projectPreference?.projectStatus || selectedReport?.projectStatus || latestProjectReport?.projectStatus || "健康";
  const preferredRecipientsTo = projectPreference ? projectPreference.recipientsTo : selectedReport?.recipientsTo ?? latestProjectReport?.recipientsTo ?? "";
  const preferredRecipientsCc = projectPreference ? projectPreference.recipientsCc : selectedReport?.recipientsCc ?? latestProjectReport?.recipientsCc ?? "";
  const preferredMailSubject = projectPreference
    ? buildWeeklyMailSubjectFromTemplate(projectPreference.mailSubjectTemplate, project, reportDate) || buildWeeklyMailSubject(project, reportDate)
    : selectedReport
      ? normalizeWeeklyMailSubject(project, reportDate, selectedReport.mailSubject || selectedReport.title)
      : buildWeeklyMailSubjectFromTemplate(
          latestProjectReport ? weeklyMailSubjectToTemplate(latestProjectReport.mailSubject, latestProjectReport.reportDate) : "",
          project,
          reportDate,
        ) || buildWeeklyMailSubject(project, reportDate);
  const shouldUsePreferenceContent = Boolean(projectPreference && (!selectedReport?.updatedAt || projectPreference.updatedAt.localeCompare(selectedReport.updatedAt) >= 0));
  const [projectOwner, setProjectOwner] = useState(preferredProjectOwner);
  const [implementationMode, setImplementationMode] = useState<ProjectImplementationMode>(preferredImplementationMode);
  const [projectStatus, setProjectStatus] = useState<WeeklyProjectStatus>(preferredProjectStatus);
  const [thisWeekTaskIds, setThisWeekTaskIds] = useState<string[]>(
    selectedReport?.thisWeekTaskIds?.length ? selectedReport.thisWeekTaskIds : defaultThisWeekUpdatedTaskIds(state, project.id, week),
  );
  const [nextWeekTaskIds, setNextWeekTaskIds] = useState<string[]>(
    selectedReport?.nextWeekTaskIds?.length ? selectedReport.nextWeekTaskIds : defaultNextWeekTaskIds(state, project.id, nextWeek),
  );
  const [recipientsTo, setRecipientsTo] = useState(preferredRecipientsTo);
  const [recipientsCc, setRecipientsCc] = useState(preferredRecipientsCc);
  const [mailSubject, setMailSubject] = useState(preferredMailSubject);
  const [content, setContent] = useState(
    (!shouldUsePreferenceContent && selectedReport?.content
      ? ensureWeeklyReportContentSchema(state, project, {
          reportDate,
          projectOwner: preferredProjectOwner,
          implementationMode: preferredImplementationMode,
          projectStatus: preferredProjectStatus,
          thisWeekTaskIds: selectedReport?.thisWeekTaskIds?.length ? selectedReport.thisWeekTaskIds : defaultThisWeekUpdatedTaskIds(state, project.id, week),
          nextWeekTaskIds: selectedReport?.nextWeekTaskIds?.length ? selectedReport.nextWeekTaskIds : defaultNextWeekTaskIds(state, project.id, nextWeek),
        }, selectedReport.content)
      : "") ||
      buildWeeklyReportContent(state, project, {
        reportDate,
        projectOwner: preferredProjectOwner,
        implementationMode: preferredImplementationMode,
        projectStatus: preferredProjectStatus,
        thisWeekTaskIds: selectedReport?.thisWeekTaskIds?.length ? selectedReport.thisWeekTaskIds : defaultThisWeekUpdatedTaskIds(state, project.id, week),
        nextWeekTaskIds: selectedReport?.nextWeekTaskIds?.length ? selectedReport.nextWeekTaskIds : defaultNextWeekTaskIds(state, project.id, nextWeek),
      }),
  );
  const [sending, setSending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [configDraft, setConfigDraft] = useState<WeeklyConfigDraft>({
    projectOwner: preferredProjectOwner,
    implementationMode: preferredImplementationMode,
    projectStatus: preferredProjectStatus,
    recipientsTo: preferredRecipientsTo,
    recipientsCc: preferredRecipientsCc,
    mailSubject: preferredMailSubject,
  });
  const [taskSourceOpen, setTaskSourceOpen] = useState(false);
  const [activeTaskSource, setActiveTaskSource] = useState<"thisWeek" | "nextWeek">("thisWeek");
  const [taskSearch, setTaskSearch] = useState("");
  const metrics = calcProjectMetrics(state, project);
  const personDays = calcProjectPersonDays(state, project);
  const openRisks = projectRisks(state, project.id).filter((item) => item.status !== "closed");
  const selectedThisWeekTasks = tasksByIds(allLeafSubtasks, thisWeekTaskIds);
  const unfinishedLeafSubtaskIds = new Set(allLeafSubtasks.filter((task) => task.status !== "done").map((task) => task.id));
  const effectiveNextWeekTaskIds = nextWeekTaskIds.filter((taskId) => unfinishedLeafSubtaskIds.has(taskId));
  const selectedNextWeekTasks = tasksByIds(allLeafSubtasks, effectiveNextWeekTaskIds);
  const recipientCount = recipientsTo ? recipientsTo.split(/[;,，；\s]+/).filter(Boolean).length : 0;
  const personDayBudget = personDays.estimated || personDays.projectBudget || 0;
  const activeTaskSourceTitle = activeTaskSource === "thisWeek" ? "本周任务来源" : "下周计划来源";
  const activeTaskSourceDescription =
    activeTaskSource === "thisWeek" ? `默认识别 ${formatDateRange(week)} 内更新进度的子任务` : `默认识别 ${formatDateRange(nextWeek)} 内计划实施的未完成子任务`;
  const activeTaskSourceCount = activeTaskSource === "thisWeek" ? selectedThisWeekTasks.length : selectedNextWeekTasks.length;
  const openTaskSource = (source: "thisWeek" | "nextWeek") => {
    setActiveTaskSource(source);
    setTaskSourceOpen(true);
  };

  useEffect(() => {
    const nextReport = selectedReportId ? projectReports.find((report) => report.id === selectedReportId) : latestTodayReport;
    const nextReportDate = nextReport?.reportDate || today;
    const nextReportDateObject = new Date(`${nextReportDate}T00:00:00`);
    const nextWeekRange = weekRangeFor(nextReportDateObject);
    const nextNextWeekRange = nextWeekRangeFor(nextReportDateObject);
    const defaultThisWeek = defaultThisWeekUpdatedTaskIds(state, project.id, nextWeekRange);
    const defaultNextWeek = defaultNextWeekTaskIds(state, project.id, nextNextWeekRange);
    const latestReport = projectReports[0];
    const latestSubjectTemplate = latestReport ? weeklyMailSubjectToTemplate(latestReport.mailSubject, latestReport.reportDate) : "";
    const owner = projectPreference ? projectPreference.projectOwner : nextReport?.projectOwner || latestReport?.projectOwner || project.owner || "";
    const mode = projectPreference?.implementationMode || nextReport?.implementationMode || latestReport?.implementationMode || "本地实施";
    const status = projectPreference?.projectStatus || nextReport?.projectStatus || latestReport?.projectStatus || "健康";
    const thisWeekIds = nextReport?.thisWeekTaskIds?.length ? nextReport.thisWeekTaskIds : defaultThisWeek;
    const nextWeekIds = nextReport?.nextWeekTaskIds?.length ? nextReport.nextWeekTaskIds : defaultNextWeek;
    const to = projectPreference ? projectPreference.recipientsTo : nextReport?.recipientsTo ?? latestReport?.recipientsTo ?? "";
    const cc = projectPreference ? projectPreference.recipientsCc : nextReport?.recipientsCc ?? latestReport?.recipientsCc ?? "";
    const subject = projectPreference
      ? buildWeeklyMailSubjectFromTemplate(projectPreference.mailSubjectTemplate, project, nextReportDate) || buildWeeklyMailSubject(project, nextReportDate)
      : nextReport
        ? normalizeWeeklyMailSubject(project, nextReportDate, nextReport.mailSubject || nextReport.title)
        : buildWeeklyMailSubjectFromTemplate(latestSubjectTemplate, project, nextReportDate) || buildWeeklyMailSubject(project, nextReportDate);
    const shouldUseLatestPreferenceContent = Boolean(projectPreference && (!nextReport?.updatedAt || projectPreference.updatedAt.localeCompare(nextReport.updatedAt) >= 0));
    setProjectOwner(owner);
    setImplementationMode(mode);
    setProjectStatus(status);
    setThisWeekTaskIds(thisWeekIds);
    setNextWeekTaskIds(nextWeekIds);
    setRecipientsTo(to);
    setRecipientsCc(cc);
    setMailSubject(subject);
    setConfigDraft({ projectOwner: owner, implementationMode: mode, projectStatus: status, recipientsTo: to, recipientsCc: cc, mailSubject: subject });
    setContent(
      (!shouldUseLatestPreferenceContent && nextReport?.content
        ? ensureWeeklyReportContentSchema(state, project, {
            reportDate: nextReportDate,
            projectOwner: owner,
            implementationMode: mode,
            projectStatus: status,
            thisWeekTaskIds: thisWeekIds,
            nextWeekTaskIds: nextWeekIds,
          }, nextReport.content)
        : "") ||
        buildWeeklyReportContent(state, project, {
          reportDate: nextReportDate,
          projectOwner: owner,
          implementationMode: mode,
          projectStatus: status,
          thisWeekTaskIds: thisWeekIds,
          nextWeekTaskIds: nextWeekIds,
        }),
    );
  }, [latestTodayReport?.id, projectPreferenceKey, projectProfileKey, projectReportsKey, selectedReportId, today, weeklySourceKey]);

  const openWeeklyConfig = () => {
    setConfigDraft({ projectOwner, implementationMode, projectStatus, recipientsTo, recipientsCc, mailSubject });
    setSettingsOpen(true);
  };

  const saveWeeklyConfig = () => {
    const normalizedMailSubject = normalizeWeeklyMailSubject(project, reportDate, configDraft.mailSubject);
    setProjectOwner(configDraft.projectOwner);
    setImplementationMode(configDraft.implementationMode);
    setProjectStatus(configDraft.projectStatus);
    setRecipientsTo(configDraft.recipientsTo);
    setRecipientsCc(configDraft.recipientsCc);
    setMailSubject(normalizedMailSubject);
    onSavePreference({
      projectId: project.id,
      projectOwner: configDraft.projectOwner,
      implementationMode: configDraft.implementationMode,
      projectStatus: configDraft.projectStatus,
      recipientsTo: configDraft.recipientsTo,
      recipientsCc: configDraft.recipientsCc,
      mailSubjectTemplate: weeklyMailSubjectToTemplate(normalizedMailSubject, reportDate),
    });
    setContent(
      buildWeeklyReportContent(state, project, {
        reportDate,
        projectOwner: configDraft.projectOwner,
        implementationMode: configDraft.implementationMode,
        projectStatus: configDraft.projectStatus,
        thisWeekTaskIds,
        nextWeekTaskIds: effectiveNextWeekTaskIds,
      }),
    );
    setSettingsOpen(false);
  };

  const buildReportInput = (patch: Partial<WeeklyReportInput> = {}): WeeklyReportInput => {
    const normalizedMailSubject = normalizeWeeklyMailSubject(project, reportDate, mailSubject);
    return {
      id: selectedReport?.id,
      projectId: project.id,
      reportDate,
      title: normalizedMailSubject,
      content: ensureWeeklyReportContentSchema(state, project, {
        reportDate,
        projectOwner,
        implementationMode,
        projectStatus,
        thisWeekTaskIds,
        nextWeekTaskIds: effectiveNextWeekTaskIds,
      }, content),
      generatedBy: "manual",
      projectOwner,
      implementationMode,
      projectStatus,
      thisWeekTaskIds,
      nextWeekTaskIds: effectiveNextWeekTaskIds,
      recipientsTo,
      recipientsCc,
      mailSubject: normalizedMailSubject,
      mailDraftStatus: selectedReport?.mailDraftStatus || "not-created",
      mailDraftMessage: selectedReport?.mailDraftMessage || "",
      mailDraftedAt: selectedReport?.mailDraftedAt || "",
      ...patch,
    };
  };

  const regenerateContent = () => {
    setContent(
      buildWeeklyReportContent(state, project, {
        reportDate,
        projectOwner,
        implementationMode,
        projectStatus,
        thisWeekTaskIds,
        nextWeekTaskIds: effectiveNextWeekTaskIds,
      }),
    );
  };

  const saveReport = (patch?: Partial<WeeklyReportInput>) => {
    onSave(buildReportInput(patch));
    if (!selectedReportId) setSelectedReportId("");
  };

  const sendDraft = async () => {
    setSending(true);
    const reportInput = buildReportInput({ mailDraftStatus: "local-draft", mailDraftMessage: "正在保存到邮箱草稿箱" });
    onSave(reportInput);
    try {
      const draftSubject = reportInput.mailSubject || normalizeWeeklyMailSubject(project, reportDate, mailSubject);
      const message = await saveEmailDraft(state.emailConfig, {
        to: recipientsTo,
        cc: recipientsCc,
        subject: draftSubject,
        content: reportInput.content,
      });
      onSave(buildReportInput({ mailDraftStatus: "mailbox-draft", mailDraftMessage: message, mailDraftedAt: new Date().toISOString() }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存邮箱草稿失败";
      onSave(buildReportInput({ mailDraftStatus: "failed", mailDraftMessage: message, mailDraftedAt: new Date().toISOString() }));
    } finally {
      setSending(false);
    }
  };

  return (
    <section className={`weekly-workspace ${taskSourceOpen ? "task-source-open" : "task-source-closed"}`}>
      <Card className="pad weekly-summary-panel">
        <div className="weekly-summary-card">
          <div className="weekly-summary-identity">
            <span className="weekly-summary-eyebrow">项目周报</span>
            <h3>{project.name}</h3>
            <p>{project.client}</p>
          </div>

          <div className="weekly-summary-chips">
            <span>
              <CalendarDays aria-hidden="true" />
              {formatDateRange(week)}
            </span>
            <WeeklyStatusPill value={projectStatus} />
          </div>

          <div className="weekly-summary-progress">
            <div>
              <span>项目进度</span>
              <strong>{metrics.completionRate}%</strong>
            </div>
            <div className="weekly-summary-progress-track" aria-label={`项目进度 ${metrics.completionRate}%`}>
              <i style={{ width: `${metrics.completionRate}%` }} />
            </div>
          </div>

          <div className="weekly-metric-grid">
            <div className="weekly-metric-card">
              <span>总人天</span>
              <strong>{personDays.actual}/{personDayBudget}</strong>
            </div>
            <div className="weekly-metric-card">
              <span>子任务</span>
              <strong>{allLeafSubtasks.length}</strong>
            </div>
            <div className="weekly-metric-card risk">
              <span>风险问题</span>
              <strong>{openRisks.length}</strong>
            </div>
            <div className="weekly-metric-card">
              <span>本周更新</span>
              <strong>{selectedThisWeekTasks.length}</strong>
            </div>
          </div>

          <div className="weekly-summary-actions">
            <button type="button" className="weekly-config-toggle" onClick={openWeeklyConfig}>
              <span>
                <PencilLine aria-hidden="true" />
                配置周报
              </span>
              <ChevronRight aria-hidden="true" />
            </button>

            <div className={`weekly-recipient-state ${recipientCount ? "ready" : "missing"}`}>
              {recipientCount ? <CircleCheck aria-hidden="true" /> : <AlertCircle aria-hidden="true" />}
              <span>{recipientCount ? `已配置 ${recipientCount} 位收件人` : "请先配置收件人"}</span>
            </div>
          </div>

          {selectedReport?.mailDraftMessage ? (
            <div className={`weekly-mail-status ${selectedReport.mailDraftStatus}`}>
              <Mail aria-hidden="true" />
              <span>{selectedReport.mailDraftMessage}</span>
            </div>
          ) : null}

          {settingsOpen ? (
            <WeeklyConfigModal draft={configDraft} onChange={setConfigDraft} onSave={saveWeeklyConfig} onClose={() => setSettingsOpen(false)} />
          ) : null}
          </div>
      </Card>

      <Card className="pad weekly-editor-panel">
        <div className="weekly-document-head">
          <div>
            <div className="weekly-document-type">
              <span aria-hidden="true" />
              项目周报草稿
            </div>
            <h3>{mailSubject || buildWeeklyMailSubject(project, reportDate)}</h3>
            <p>{reportDate} · {formatDateRange(week)} · 可编辑预览</p>
          </div>
          <div className="weekly-selected-strip">
            <button type="button" className="weekly-history-button" onClick={() => onPage("weeklyHistory")}>
              <History aria-hidden="true" />
              历史周报
            </button>
            <span><Mail aria-hidden="true" /> 收件 {recipientsTo ? recipientsTo.split(/[;,，；\s]+/).filter(Boolean).length : 0}</span>
            <span>本周 {selectedThisWeekTasks.length}</span>
            <span>下周 {selectedNextWeekTasks.length}</span>
            <span>{projectStatus}</span>
          </div>
        </div>
        <WeeklyDraftComposer content={content} onChange={setContent} />
        <div className="weekly-draft-actions">
          <Button tone="ghost" onClick={regenerateContent}>
            <ClipboardList aria-hidden="true" />
            重新生成
          </Button>
          <Button tone="primary" onClick={() => saveReport()}>
            <Save aria-hidden="true" />
            确认保存
          </Button>
          <Button tone="ghost" onClick={sendDraft} disabled={sending}>
            {sending ? <RefreshCw aria-hidden="true" /> : <Send aria-hidden="true" />}
            {sending ? "保存中" : "保存邮箱草稿"}
          </Button>
        </div>
      </Card>

      <Card className={`pad weekly-task-card ${taskSourceOpen ? "" : "collapsed"}`}>
        <div className="weekly-panel-heading compact">
          {taskSourceOpen ? (
            <>
              <div className="weekly-task-source-tabs" role="tablist" aria-label="任务来源类型">
                <button
                  type="button"
                  className={`weekly-task-source-tab ${activeTaskSource === "thisWeek" ? "active" : ""}`}
                  role="tab"
                  aria-selected={activeTaskSource === "thisWeek"}
                  onClick={() => setActiveTaskSource("thisWeek")}
                >
                  <span>本周任务来源</span>
                  <strong>{selectedThisWeekTasks.length}</strong>
                </button>
                <button
                  type="button"
                  className={`weekly-task-source-tab ${activeTaskSource === "nextWeek" ? "active" : ""}`}
                  role="tab"
                  aria-selected={activeTaskSource === "nextWeek"}
                  onClick={() => setActiveTaskSource("nextWeek")}
                >
                  <span>下周计划来源</span>
                  <strong>{selectedNextWeekTasks.length}</strong>
                </button>
              </div>
              <button type="button" className="weekly-task-reset" onClick={() => {
                setThisWeekTaskIds(defaultThisWeekUpdatedTaskIds(state, project.id, week));
                setNextWeekTaskIds(defaultNextWeekTaskIds(state, project.id, nextWeek));
              }}>
                恢复默认
              </button>
              <button type="button" className="weekly-task-close" onClick={() => setTaskSourceOpen(false)} aria-label="收起任务来源">
                <ChevronRight aria-hidden="true" />
              </button>
            </>
          ) : (
            <div className="weekly-task-source-buttons" aria-label="任务来源">
              <button type="button" className="weekly-task-source-button" onClick={() => openTaskSource("thisWeek")}>
                <ChevronRight aria-hidden="true" />
                <span>本周任务来源</span>
                <strong>{selectedThisWeekTasks.length}</strong>
              </button>
              <button type="button" className="weekly-task-source-button next" onClick={() => openTaskSource("nextWeek")}>
                <ChevronRight aria-hidden="true" />
                <span>下周计划来源</span>
                <strong>{selectedNextWeekTasks.length}</strong>
              </button>
            </div>
          )}
        </div>
        {taskSourceOpen ? (
          <div className="weekly-task-drawer">
            <div className="weekly-task-active-summary">
              <span>{activeTaskSourceTitle}</span>
              <strong>已选 {activeTaskSourceCount} 项</strong>
            </div>
            <label className="weekly-task-search">
              <Search aria-hidden="true" />
              <input value={taskSearch} onChange={(event) => setTaskSearch(event.currentTarget.value)} placeholder="搜索任务编号、名称、阶段、负责人" />
            </label>
            <div className="weekly-task-grid">
              {activeTaskSource === "thisWeek" ? (
                <WeeklyTaskSelector
                  title="本周任务来源"
                  description={activeTaskSourceDescription}
                  taskTree={weeklyTaskTree}
                  search={taskSearch}
                  selectedIds={thisWeekTaskIds}
                  state={state}
                  onChange={setThisWeekTaskIds}
                />
              ) : (
                <WeeklyTaskSelector
                  title="下周计划来源"
                  description={activeTaskSourceDescription}
                  taskTree={weeklyTaskTree}
                  search={taskSearch}
                  allowTask={(task) => task.status !== "done"}
                  selectedIds={effectiveNextWeekTaskIds}
                  state={state}
                  onChange={setNextWeekTaskIds}
                />
              )}
            </div>
          </div>
        ) : null}
      </Card>
    </section>
  );
}

function weeklyArchiveLabel(status: string) {
  if (status === "archived") return "已归档";
  if (status === "failed") return "归档失败";
  return "未归档";
}

function weeklyArchiveTone(status: string) {
  if (status === "archived") return "success";
  if (status === "failed") return "danger";
  return "warning";
}

function weeklyMailDraftLabel(status: string) {
  if (status === "mailbox-draft") return "邮箱草稿";
  if (status === "local-draft") return "本地草稿";
  if (status === "failed") return "邮箱失败";
  return "未发送";
}

export function WeeklyHistoryPage({ state, onPage }: { state: AppState; onPage: (page: PageKey) => void }) {
  const project = getProject(state);
  const projectReports = useMemo(
    () =>
      state.weeklyReports
        .filter((report) => report.projectId === project.id)
        .sort((a, b) => b.reportDate.localeCompare(a.reportDate) || b.updatedAt.localeCompare(a.updatedAt)),
    [project.id, state.weeklyReports],
  );
  const [selectedReportId, setSelectedReportId] = useState(projectReports[0]?.id || "");
  const selectedReport = projectReports.find((report) => report.id === selectedReportId) || projectReports[0];

  useEffect(() => {
    if (!projectReports.length) {
      setSelectedReportId("");
      return;
    }
    if (!selectedReportId || !projectReports.some((report) => report.id === selectedReportId)) {
      setSelectedReportId(projectReports[0].id);
    }
  }, [projectReports, selectedReportId]);

  const previewContent = useMemo(() => {
    if (!selectedReport) return "";
    return ensureWeeklyReportContentSchema(
      state,
      project,
      {
        reportDate: selectedReport.reportDate,
        projectOwner: selectedReport.projectOwner || project.owner,
        implementationMode: selectedReport.implementationMode,
        projectStatus: selectedReport.projectStatus,
        thisWeekTaskIds: selectedReport.thisWeekTaskIds || [],
        nextWeekTaskIds: selectedReport.nextWeekTaskIds || [],
      },
      selectedReport.content,
    );
  }, [project, selectedReport, state]);

  return (
    <section className="weekly-history-page">
      <Card className="pad weekly-history-sidebar">
        <div className="weekly-history-head">
          <button type="button" className="weekly-history-back" onClick={() => onPage("weekly")}>
            <ArrowLeft aria-hidden="true" />
            返回周报
          </button>
          <div>
            <h3>历史周报</h3>
            <p className="muted">{project.name} · {projectReports.length} 份记录</p>
          </div>
        </div>

        <div className="weekly-history-list">
          {projectReports.map((report) => (
            <button
              key={report.id}
              type="button"
              className={selectedReport?.id === report.id ? "active" : ""}
              onClick={() => setSelectedReportId(report.id)}
            >
              <CalendarDays aria-hidden="true" />
              <span>
                <strong>{report.reportDate}</strong>
                <small>{report.mailSubject || report.title}</small>
              </span>
              <Badge tone={weeklyArchiveTone(report.markdownArchiveStatus)}>{weeklyArchiveLabel(report.markdownArchiveStatus)}</Badge>
            </button>
          ))}
          {!projectReports.length ? <div className="empty compact">当前项目暂无历史周报。</div> : null}
        </div>
      </Card>

      <Card className="pad weekly-history-document-card">
        {selectedReport ? (
          <>
            <div className="weekly-document-head weekly-history-document-head">
              <div>
                <div className="weekly-document-type">
                  <span aria-hidden="true" />
                  历史周报
                </div>
                <h3>{selectedReport.mailSubject || selectedReport.title}</h3>
                <p>{selectedReport.reportDate} · {weeklyMailDraftLabel(selectedReport.mailDraftStatus)}</p>
              </div>
              <div className="weekly-selected-strip">
                <span>{selectedReport.projectStatus}</span>
                <span>{selectedReport.implementationMode}</span>
                <span>{weeklyArchiveLabel(selectedReport.markdownArchiveStatus)}</span>
              </div>
            </div>

            <div className="weekly-history-meta-grid">
              <div>
                <span>收件人</span>
                <strong>{selectedReport.recipientsTo || "未维护"}</strong>
              </div>
              <div>
                <span>抄送</span>
                <strong>{selectedReport.recipientsCc || "未维护"}</strong>
              </div>
              <div>
                <span>Markdown 文件</span>
                <strong>{selectedReport.markdownArchiveFileName || "未生成"}</strong>
              </div>
              <div className="wide">
                <span>归档路径</span>
                <strong>{selectedReport.markdownArchivePath || selectedReport.markdownArchiveMessage || "请先在交付物管理选择项目目录后重新保存周报。"}</strong>
              </div>
            </div>

            <div className="weekly-history-preview">
              <WeeklyDraftPreview content={previewContent} />
            </div>
          </>
        ) : (
          <div className="empty">暂无可查看的历史周报。</div>
        )}
      </Card>
    </section>
  );
}
