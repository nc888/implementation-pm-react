import { useRef, type ReactNode } from "react";
import { ArrowRight, BriefcaseBusiness, CalendarClock, CircleAlert, MoreHorizontal, PackageCheck, Pencil, Plus, Trash2, Upload, UserCheck } from "lucide-react";
import type { AppState, Project } from "../types";
import {
  calcProjectMetrics,
  calcProjectPersonDays,
  projectRisks,
  projectTasks,
} from "../services/contextBuilder";
import type { AiService } from "../services/aiService";
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
  projectMatchesSearch,
  projectName,
  RichMessage,
  RingChart,
  riskIssueMatchesSearch,
  riskStatusLabel,
  scopeItemMatchesSearch,
  statusColumns,
  statusCssClass,
  stageLabels,
  taskKindLabel,
  taskMatchesSearch,
  taskStatusLabels,
  taskStatusTone,
  TaskTitleCell,
  GanttTaskCell,
  toggleCollapsed,
  toneFor,
} from "./page-shared";

const scoreModeLabel = (mode: string) => (mode === "ai-enhanced" ? "AI增强" : "规则评分");

const scoreDotClass = (level: string) => {
  if (level === "绿灯") return "green";
  if (level === "黄灯") return "yellow";
  return "red";
};

function PortalStat({
  icon,
  title,
  value,
  meta,
  tone = "primary",
  alert = false,
}: {
  icon: ReactNode;
  title: string;
  value: string | number;
  meta: string;
  tone?: string;
  alert?: boolean;
}) {
  return (
    <div className={`portal-stat ${tone}`}>
      <div className="portal-stat-icon" aria-hidden="true">
        {icon}
      </div>
      <div className="portal-stat-copy">
        <strong>
          {value}
          {alert ? <span className="portal-stat-alert" aria-label="需要关注" /> : null}
        </strong>
        <span>{title}</span>
        <small>{meta}</small>
      </div>
    </div>
  );
}

export function PortalPage({
  state,
  onProject,
  onAddProject,
  onImportProject,
  onEditProject,
  onDeleteProject,
  aiService,
}: {
  state: AppState;
  onProject: (id: string) => void;
  onAddProject: () => void;
  onImportProject: (file: File) => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (projectId: string) => void;
  aiService: AiService;
}) {
  const importInputRef = useRef<HTMLInputElement>(null);
  const allTasks = state.tasks;
  const week = currentWeekRange();
  const today = localDateKey();
  const projects = state.projects.filter((project) => projectMatchesSearch(state, project));
  const attentionProjects = state.projects.filter((project) => project.health !== "健康");
  const weekTasks = allTasks.filter((task) => isThisWeekTask(task, week));
  const overdueTasks = allTasks.filter((task) => isOverdueTask(task, today));
  const customerTasks = allTasks.filter((task) => task.status === "customer");
  const blockedTasks = allTasks.filter((task) => task.status === "blocked");
  const pendingDeliverables = state.deliverables.filter(isPendingDeliverable);
  const weekDeliverables = state.deliverables.filter((deliverable) => isThisWeekDeliverable(deliverable, week));
  return (
    <div className="portal-dashboard">
      <section className="portal-stats" aria-label="项目态势">
        <PortalStat icon={<BriefcaseBusiness />} title="在管项目" value={state.projects.length} meta={`${attentionProjects.length} 个需关注`} tone="primary" alert={attentionProjects.length > 0} />
        <PortalStat icon={<CalendarClock />} title="本周到期" value={weekTasks.length} meta={`${overdueTasks.length} 个逾期`} tone={overdueTasks.length ? "danger" : "primary"} alert={overdueTasks.length > 0} />
        <PortalStat icon={<UserCheck />} title="待确认" value={customerTasks.length} meta="跨项目" tone={customerTasks.length ? "warning" : "success"} alert={customerTasks.length > 0} />
        <PortalStat icon={<CircleAlert />} title="已阻塞" value={blockedTasks.length} meta="需处理" tone={blockedTasks.length ? "danger" : "success"} alert={blockedTasks.length > 0} />
        <PortalStat icon={<PackageCheck />} title="待验收" value={pendingDeliverables.length} meta={`${weekDeliverables.length} 个本周到期`} tone="primary" alert={weekDeliverables.length > 0} />
      </section>
      <div className="section-header">
        <div>
          <h3>项目卡片入口</h3>
          <p>点击卡片进入项目详情，适合同时管理多个软件实施项目。</p>
        </div>
        <div className="section-actions">
          <Button tone="ghost" onClick={() => importInputRef.current?.click()}>
            <Upload aria-hidden="true" />
            导入项目
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) onImportProject(file);
            }}
          />
          <Button tone="primary" onClick={onAddProject}>
          <Plus aria-hidden="true" />
          新建项目
          </Button>
        </div>
      </div>
      <section className="grid project-grid">
        {projects.map((project) => {
          const metrics = calcProjectMetrics(state, project);
          const score = aiService.scoreProject(state, project);
          const personDays = calcProjectPersonDays(state, project);
          const visibleIndicators = [
            { label: `阻塞 ${metrics.blocked}`, tone: "danger", value: metrics.blocked },
            { label: `待客户 ${metrics.customer}`, tone: "primary", value: metrics.customer },
            { label: `交付物 ${metrics.pendingDeliverables}`, tone: "purple", value: metrics.pendingDeliverables },
          ].filter((item) => item.value > 0);
          return (
            <article
              key={project.id}
              className={`card project-card ${project.id === state.ui.currentProjectId ? "selected" : ""}`}
              onClick={() => onProject(project.id)}
            >
              <div className="project-card-menu" onClick={(event) => event.stopPropagation()}>
                <button className="project-card-menu-trigger" type="button" aria-label={`${project.name} 更多操作`}>
                  <MoreHorizontal aria-hidden="true" />
                </button>
                <div className="project-card-menu-popover">
                  <button type="button" onClick={() => onEditProject(project)}>
                    <Pencil aria-hidden="true" />
                    编辑
                  </button>
                  <button type="button" className="danger" onClick={() => onDeleteProject(project.id)}>
                    <Trash2 aria-hidden="true" />
                    删除
                  </button>
                </div>
              </div>
              <div className="project-card-head">
                <div className="project-card-title">
                  <h3>{project.name}</h3>
                  <p>{project.client}</p>
                </div>
                <div className="project-health-signal" title={`健康评分: ${score.score}/100, ${scoreModeLabel(score.mode)}, ${score.level}`}>
                  <span className={`project-status-dot ${scoreDotClass(score.level)}`} aria-hidden="true" />
                  <span>{score.score}</span>
                </div>
              </div>
              <div className="project-progress-row">
                <strong>{project.phase}</strong>
                <Progress value={metrics.completionRate} />
                <span>{metrics.completionRate}%</span>
              </div>
              <div className="project-personday-strip">
                <div className="project-personday-metric">
                  <span>实施</span>
                  <strong className={personDays.implementationUsageRate > 100 ? "danger-text" : ""}>{personDays.implementationActual}/{personDays.implementationEstimated || personDays.implementationBudget || 0}</strong>
                  <small>{personDays.implementationUsageRate}%</small>
                </div>
                <div className="project-personday-metric">
                  <span>开发</span>
                  <strong className={personDays.developmentUsageRate > 100 ? "danger-text" : ""}>{personDays.developmentActual}/{personDays.developmentEstimated || personDays.developmentBudget || 0}</strong>
                  <small>{personDays.developmentUsageRate}%</small>
                </div>
              </div>
              <div className="project-card-footer">
                <div className="project-next-line">
                  <span>Next:</span>
                  <strong>{project.nextMilestone}</strong>
                </div>
                {visibleIndicators.length ? (
                  <div className="chip-line project-card-chips">
                    {visibleIndicators.map((item) => (
                      <Badge key={item.label} tone={item.tone}>
                        {item.label}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <button
                  className="button primary"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onProject(project.id);
                  }}
                >
                  进入项目
                  <ArrowRight aria-hidden="true" />
                </button>
              </div>
            </article>
          );
        })}
        {!projects.length ? <div className="empty">没有匹配的项目。</div> : null}
      </section>
    </div>
  );
}

function DashboardPageLegacy({ state, aiService }: { state: AppState; aiService: AiService }) {
  const week = currentWeekRange();
  const today = localDateKey();
  const rows = state.projects
    .filter((project) => projectMatchesSearch(state, project))
    .map((project) => ({ project, score: aiService.scoreProject(state, project), metrics: calcProjectMetrics(state, project) }))
    .sort((a, b) => a.score.score - b.score.score);
  const visibleProjectIds = new Set(rows.map(({ project }) => project.id));
  const dashboardTasks = state.tasks.filter((task) => visibleProjectIds.has(task.projectId));
  const weekFocusTasks = dashboardTasks.filter((task) => isWeekFocusTask(task, week, today)).sort(compareWorkItems);
  const highPriorityWeekTasks = weekFocusTasks.filter((task) => task.priority === "高");
  const overdueTasks = dashboardTasks.filter((task) => isOverdueTask(task, today));
  const customerTasks = dashboardTasks.filter((task) => task.status === "customer").sort(compareWorkItems);
  const openRisks = state.risksIssues
    .filter((item) => visibleProjectIds.has(item.projectId) && item.status !== "closed")
    .sort((a, b) => (a.severity === "高" ? 0 : 1) - (b.severity === "高" ? 0 : 1));
  const highRisks = openRisks.filter((item) => item.severity === "高");
  const pendingDeliverables = state.deliverables
    .filter((deliverable) => visibleProjectIds.has(deliverable.projectId) && isPendingDeliverable(deliverable))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const weekDeliverables = pendingDeliverables.filter((deliverable) => isThisWeekDeliverable(deliverable, week));
  const averageScore = rows.length ? Math.round(rows.reduce((sum, row) => sum + row.score.score, 0) / rows.length) : 0;
  const redProjects = rows.filter((row) => row.score.level === "红灯");
  const yellowProjects = rows.filter((row) => row.score.level === "黄灯");

  return (
    <>
      <section className="grid metrics">
        <Metric
          title="平均健康分"
          value={averageScore}
          delta={`${redProjects.length} 红 / ${yellowProjects.length} 黄`}
          tone={redProjects.length ? "danger" : yellowProjects.length ? "warning" : "success"}
        />
        <Metric
          title="本周高优待办"
          value={highPriorityWeekTasks.length}
          delta={`${overdueTasks.length} 个逾期`}
          tone={highPriorityWeekTasks.length ? "danger" : "success"}
        />
        <Metric title="风险/问题" value={openRisks.length} delta={`${highRisks.length} 个高优`} tone={highRisks.length ? "danger" : "warning"} />
        <Metric title="客户待确认" value={customerTasks.length} delta="需催办" tone={customerTasks.length ? "warning" : "success"} />
        <Metric title="待验收交付物" value={pendingDeliverables.length} delta={`${weekDeliverables.length} 个本周到期`} tone="purple" />
      </section>
      <section className="workbench-grid">
        <Card className="pad workbench-card workbench-card-wide">
          <div className="table-toolbar compact">
            <div>
              <h3>项目健康队列</h3>
              <p className="muted">按规则健康分从低到高排序，优先看红灯、黄灯和本周阻塞。</p>
            </div>
            <Badge tone={rows.length ? "primary" : ""}>{rows.length} 个项目</Badge>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>项目</th>
                <th>健康</th>
                <th>健康分</th>
                <th>本周事项</th>
                <th>逾期</th>
                <th>风险</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ project, score, metrics }) => {
                const projectWeekTasks = projectTasks(state, project.id).filter((task) => isWeekFocusTask(task, week, today));
                const projectOpenRisks = projectRisks(state, project.id).filter((item) => item.status !== "closed");
                return (
                  <tr key={project.id}>
                    <td>
                      <strong>{project.name}</strong>
                      <br />
                      <span className="muted">{project.client}</span>
                    </td>
                    <td>
                      <Badge tone={toneFor(project.health)}>{project.health}</Badge>
                    </td>
                    <td>
                      <strong>{score.score}</strong>
                      <br />
                      <span className="muted">{score.level} · {scoreModeLabel(score.mode)}</span>
                    </td>
                    <td>{projectWeekTasks.length}</td>
                    <td className={metrics.overdue ? "danger-text" : ""}>{metrics.overdue}</td>
                    <td>{projectOpenRisks.length}</td>
                  </tr>
                );
              })}
              {!rows.length ? (
                <tr>
                  <td colSpan={6} className="muted">
                    没有匹配的项目。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </Card>
        <Card className="pad workbench-card">
          <div className="workbench-card-title">
            <h3>本周高优先待办</h3>
            <Badge tone={highPriorityWeekTasks.length ? "danger" : "success"}>{highPriorityWeekTasks.length}</Badge>
          </div>
          <div className="work-list">
            {highPriorityWeekTasks.slice(0, 6).map((task) => (
              <div key={task.id} className="work-item">
                <div className="chip-line">
                  <Badge>{projectName(state, task.projectId)}</Badge>
                  <Badge tone={toneFor(task.priority)}>{task.priority}</Badge>
                  <Badge tone={taskStatusTone(task.status)}>{taskStatusLabels[task.status]}</Badge>
                </div>
                <strong>{task.title}</strong>
                <span className="muted">
                  {task.code} · {task.owner} · 截止 {formatShortDate(task.dueDate)}
                </span>
              </div>
            ))}
            {!highPriorityWeekTasks.length ? <div className="empty compact">本周没有高优先待办。</div> : null}
          </div>
        </Card>
        <Card className="pad workbench-card">
          <div className="workbench-card-title">
            <h3>风险问题雷达</h3>
            <Badge tone={highRisks.length ? "danger" : "warning"}>{highRisks.length} 高</Badge>
          </div>
          <div className="work-list">
            {openRisks.slice(0, 6).map((item) => (
              <div key={item.id} className="work-item">
                <div className="chip-line">
                  <Badge>{projectName(state, item.projectId)}</Badge>
                  <Badge tone={item.kind === "risk" ? "warning" : "danger"}>{item.kind === "risk" ? "风险" : "问题"}</Badge>
                  <Badge tone={toneFor(item.severity)}>{item.severity}</Badge>
                </div>
                <strong>{item.title}</strong>
                <span className="muted">
                  {riskStatusLabel(item.status)} · {item.responsePlan}
                </span>
              </div>
            ))}
            {!openRisks.length ? <div className="empty compact">当前没有打开的风险或问题。</div> : null}
          </div>
        </Card>
        <Card className="pad workbench-card">
          <div className="workbench-card-title">
            <h3>客户确认队列</h3>
            <Badge tone={customerTasks.length ? "warning" : "success"}>{customerTasks.length}</Badge>
          </div>
          <div className="work-list">
            {customerTasks.slice(0, 5).map((task) => (
              <div key={task.id} className="work-item">
                <div className="chip-line">
                  <Badge>{projectName(state, task.projectId)}</Badge>
                  <Badge tone={toneFor(task.priority)}>{task.priority}</Badge>
                </div>
                <strong>{task.title}</strong>
                <span className="muted">
                  {task.code} · {task.dimension} · 截止 {formatShortDate(task.dueDate)}
                </span>
              </div>
            ))}
            {!customerTasks.length ? <div className="empty compact">当前没有客户待确认事项。</div> : null}
          </div>
        </Card>
        <Card className="pad workbench-card">
          <div className="workbench-card-title">
            <h3>交付物验收</h3>
            <Badge tone="purple">{weekDeliverables.length} 本周</Badge>
          </div>
          <div className="work-list">
            {pendingDeliverables.slice(0, 5).map((deliverable) => (
              <div key={deliverable.id} className="work-item">
                <div className="chip-line">
                  <Badge>{projectName(state, deliverable.projectId)}</Badge>
                  <Badge tone={toneFor(deliverable.acceptance)}>{deliverable.acceptance}</Badge>
                </div>
                <strong>{deliverable.name}</strong>
                <span className="muted">
                  {deliverable.code} · {deliverable.status} · 截止 {formatShortDate(deliverable.dueDate)}
                </span>
              </div>
            ))}
            {!pendingDeliverables.length ? <div className="empty compact">待验收交付物已清空。</div> : null}
          </div>
        </Card>
      </section>
    </>
  );
}

export function DashboardPage({ state, aiService }: { state: AppState; aiService: AiService }) {
  const week = currentWeekRange();
  const today = localDateKey();
  const rows = state.projects
    .filter((project) => projectMatchesSearch(state, project))
    .map((project) => ({ project, score: aiService.scoreProject(state, project), metrics: calcProjectMetrics(state, project) }))
    .sort((a, b) => a.score.score - b.score.score);
  const visibleProjectIds = new Set(rows.map(({ project }) => project.id));
  const dashboardTasks = state.tasks.filter((task) => visibleProjectIds.has(task.projectId));
  const weekFocusTasks = dashboardTasks.filter((task) => isWeekFocusTask(task, week, today)).sort(compareWorkItems);
  const highPriorityWeekTasks = weekFocusTasks.filter((task) => task.priority === "高");
  const overdueTasks = dashboardTasks.filter((task) => isOverdueTask(task, today));
  const customerTasks = dashboardTasks.filter((task) => task.status === "customer").sort(compareWorkItems);
  const openRisks = state.risksIssues
    .filter((item) => visibleProjectIds.has(item.projectId) && item.status !== "closed")
    .sort((a, b) => (a.severity === "高" ? 0 : 1) - (b.severity === "高" ? 0 : 1));
  const highRisks = openRisks.filter((item) => item.severity === "高");
  const deliverables = state.deliverables
    .filter((deliverable) => visibleProjectIds.has(deliverable.projectId))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const pendingDeliverables = deliverables.filter(isPendingDeliverable);
  const weekDeliverables = pendingDeliverables.filter((deliverable) => isThisWeekDeliverable(deliverable, week));
  const averageScore = rows.length ? Math.round(rows.reduce((sum, row) => sum + row.score.score, 0) / rows.length) : 0;
  const redProjects = rows.filter((row) => row.score.level === "红灯");
  const yellowProjects = rows.filter((row) => row.score.level === "黄灯");
  const greenProjects = rows.filter((row) => row.score.level === "绿灯");
  const deliverableStatusCounts = ["客户确认", "待评审", "客户验收", "未提交", "已验收"].map((label) => ({
    label,
    count: deliverables.filter((item) => item.acceptance === label || item.status === label).length,
  }));
  return (
    <div className="overview-all-page">
      <section className="overview-all-stats" aria-label="所有项目统计">
        <div className="overview-stat-section primary">
          <span>平均健康分</span>
          <strong>{averageScore}<small>分</small></strong>
          <div className="health-dot-row">
            <span className="health-dot-label red">红 {redProjects.length}</span>
            <span className="health-dot-label yellow">黄 {yellowProjects.length}</span>
            <span className="health-dot-label green">绿 {greenProjects.length}</span>
          </div>
        </div>
        <div className="overview-stat-section">
          <span>本周高优待办</span>
          <strong className={overdueTasks.length ? "danger-text" : ""}>{highPriorityWeekTasks.length}</strong>
          <small className={overdueTasks.length ? "danger-text" : ""}>逾期 {overdueTasks.length}</small>
        </div>
        <div className="overview-stat-section">
          <span>风险 / 问题</span>
          <strong className={highRisks.length ? "danger-text" : ""}>{openRisks.length}</strong>
          <small className={highRisks.length ? "danger-text" : ""}>高优 {highRisks.length}</small>
        </div>
        <div className="overview-stat-section">
          <span>客户待确认</span>
          <strong>{customerTasks.length}</strong>
          <small>需催办</small>
        </div>
        <div className="overview-stat-section">
          <span>待验收交付物</span>
          <strong>{pendingDeliverables.length}</strong>
          <small>{weekDeliverables.length} 本周到期</small>
        </div>
      </section>

      <section className="overview-all-layout">
        <div className="overview-all-main">
          <Card className="pad overview-all-health">
          <div className="compact-card-head">
            <div>
              <h3>项目健康队列</h3>
              <p className="muted">按健康分从低到高排序，优先定位红灯、黄灯和本周异常项目。</p>
            </div>
            <Badge tone="primary">{rows.length} 个项目</Badge>
          </div>
          <table className="table compact-table health-table">
            <thead>
              <tr>
                <th className="health-signal-col" aria-label="健康信号"></th>
                <th>项目</th>
                <th>健康</th>
                <th>人天</th>
                <th>待办</th>
                <th>风险</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ project, score, metrics }) => {
                const projectWeekTasks = projectTasks(state, project.id).filter((task) => isWeekFocusTask(task, week, today));
                const projectOpenRisks = projectRisks(state, project.id).filter((item) => item.status !== "closed");
                const dot = scoreDotClass(score.level);
                return (
                  <tr key={project.id} className={`health-row health-${dot}`}>
                    <td className="health-signal-col">
                      <span className={`health-signal-bar ${dot}`} aria-hidden="true" />
                    </td>
                    <td>
                      <strong>{project.name}</strong>
                      <span className="muted">{project.client}</span>
                    </td>
                    <td>
                      <span className={`health-score-mini ${dot}`}>
                        <span />{score.score}
                      </span>
                    </td>
                    <td>
                      <div className="personday-table-stack">
                        <span>
                          实施
                          <strong className={metrics.implementationPersonDayUsageRate > 100 ? "danger-text" : ""}>
                            {metrics.implementationActualPersonDays}/{metrics.implementationEstimatedPersonDays || 0}
                          </strong>
                        </span>
                        <span>
                          开发
                          <strong className={metrics.developmentPersonDayUsageRate > 100 ? "danger-text" : ""}>
                            {metrics.developmentActualPersonDays}/{metrics.developmentEstimatedPersonDays || 0}
                          </strong>
                        </span>
                      </div>
                    </td>
                    <td>{projectWeekTasks.length}</td>
                    <td className={projectOpenRisks.some((item) => item.severity === "高") ? "danger-text" : ""}>{projectOpenRisks.length}</td>
                  </tr>
                );
              })}
              {!rows.length ? (
                <tr>
                  <td colSpan={6} className="muted">
                    没有匹配的项目。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          </Card>

          <Card className="pad deliverable-tracker-card">
            <div className="compact-card-head">
              <div>
                <h3>交付物追踪</h3>
                <p className="muted">合并客户确认和交付验收状态，按交付闭环统一查看。</p>
              </div>
              <Badge tone="purple">{deliverables.length} 项</Badge>
            </div>
            <div className="deliverable-tabs">
              {deliverableStatusCounts.map((item) => (
                <span key={item.label}>{item.label} {item.count}</span>
              ))}
            </div>
            <div className="deliverable-track-list">
              {deliverables.slice(0, 8).map((deliverable) => (
                <div key={deliverable.id} className="deliverable-track-item">
                  <span className="file-type-mark">{deliverable.name.split(".").pop()?.slice(0, 3).toUpperCase() || "DOC"}</span>
                  <div>
                    <strong>{deliverable.name}</strong>
                    <p>{projectName(state, deliverable.projectId)} · {deliverable.code}</p>
                  </div>
                  <Badge tone={toneFor(deliverable.acceptance)}>{deliverable.acceptance}</Badge>
                  <time className={isThisWeekDeliverable(deliverable, week) ? "warning-text" : ""}>{formatShortDate(deliverable.dueDate)}</time>
                </div>
              ))}
              {!deliverables.length ? <div className="empty compact">暂无交付物。</div> : null}
            </div>
          </Card>
        </div>

        <div className="overview-all-side">
          <Card className="pad compact-list-card">
            <div className="compact-card-head">
              <h3>本周高优先待办</h3>
              <Badge tone={highPriorityWeekTasks.length ? "danger" : "success"}>{highPriorityWeekTasks.length}</Badge>
            </div>
            <div className="compact-signal-list">
              {highPriorityWeekTasks.slice(0, 6).map((task) => (
                <div key={task.id} className={`compact-signal-item priority-${task.priority === "高" ? "high" : task.priority === "中" ? "medium" : "low"}`}>
                  <div className="compact-signal-line">
                    <strong>{task.title}</strong>
                    <span className={`mini-status-dot ${statusCssClass(task.status)}`}>{taskStatusLabels[task.status]}</span>
                    <time className={isOverdueTask(task, today) ? "danger-text" : ""}>{formatShortDate(task.dueDate)}</time>
                  </div>
                  <p>
                    {projectName(state, task.projectId)} · {task.code} · {task.owner}
                  </p>
                </div>
              ))}
              {!highPriorityWeekTasks.length ? <div className="empty compact">本周没有高优先待办。</div> : null}
            </div>
          </Card>

          <Card className="pad compact-list-card">
            <div className="compact-card-head">
              <h3>风险问题雷达</h3>
              <Badge tone={highRisks.length ? "danger" : "warning"}>{highRisks.length} 高</Badge>
            </div>
            <div className="compact-signal-list">
              {openRisks.slice(0, 6).map((item) => (
                <div key={item.id} className={`compact-signal-item priority-${item.severity === "高" ? "high" : item.severity === "中" ? "medium" : "low"}`}>
                  <div className="compact-signal-line">
                    <strong>{item.title}</strong>
                    <span className="micro-tag">{item.kind === "risk" ? "风险" : "问题"}</span>
                    <span className={`severity-dot ${item.severity === "高" ? "high" : item.severity === "中" ? "medium" : "low"}`}>{item.severity}</span>
                  </div>
                  <p>
                    {projectName(state, item.projectId)} · {riskStatusLabel(item.status)}：{item.responsePlan}
                  </p>
                </div>
              ))}
              {!openRisks.length ? <div className="empty compact">当前没有打开的风险或问题。</div> : null}
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}
