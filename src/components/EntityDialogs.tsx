import { useState } from "react";
import type { AppState, Deliverable, Project, RiskIssue, ScopeItem, Task, TaskStage, TaskStatus } from "../types";
import { getProject, projectTasks, stageDefinitionsForState, taskStatusLabels } from "../services/contextBuilder";
import { Button } from "./ui";

const taskStatuses: TaskStatus[] = ["todo", "doing", "customer", "blocked", "done"];
const priorities: Task["priority"][] = ["高", "中", "低"];
const healthValues: Project["health"][] = ["健康", "关注", "延期"];
const scopeCategories: ScopeItem["category"][] = ["本期SOW范围", "变更增加范围", "不在本期范围"];
const personDayTypes: ScopeItem["personDayType"][] = ["实施", "开发"];
const riskKinds: RiskIssue["kind"][] = ["risk", "issue"];
const riskStatuses: RiskIssue["status"][] = ["open", "tracking", "closed"];
const severities: RiskIssue["severity"][] = ["高", "中", "低"];

function today() {
  return new Date().toISOString().slice(0, 10);
}

function nextCode(prefix: string, count: number) {
  return `${prefix}-${String(count + 1).padStart(3, "0")}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatTaskCodeNumber(value: number, width: number) {
  const text = String(value);
  return width > text.length ? text.padStart(width, "0") : text;
}

function parseDottedTaskCode(code: string) {
  const value = code.trim();
  if (!/^\d+(?:\.\d+)*$/.test(value)) return null;
  const segments = value.split(".").map((segment) => ({
    value: Number(segment),
    width: segment.length,
  }));
  return segments.every((segment) => Number.isFinite(segment.value)) ? segments : null;
}

function compareDottedTaskCode(left: ReturnType<typeof parseDottedTaskCode>, right: ReturnType<typeof parseDottedTaskCode>) {
  if (!left || !right) return 0;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index]?.value ?? -1;
    const rightValue = right[index]?.value ?? -1;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return left.length - right.length;
}

function nextRootTaskCode(tasks: Task[], excludeTaskId = "") {
  const roots = tasks.filter((task) => !task.parentId && task.id !== excludeTaskId);
  const dottedCodes = roots.map((task) => parseDottedTaskCode(task.code)).filter((code): code is NonNullable<typeof code> => Boolean(code));
  if (dottedCodes.length) {
    const latest = dottedCodes.sort(compareDottedTaskCode).at(-1);
    if (latest?.length) {
      const nextSegments = latest.map((segment) => ({ ...segment }));
      const last = nextSegments[nextSegments.length - 1];
      last.value += 1;
      return nextSegments.map((segment) => formatTaskCodeNumber(segment.value, segment.width)).join(".");
    }
  }

  const suffixGroups = new Map<string, { prefix: string; max: number; width: number; count: number }>();
  roots.forEach((task) => {
    const match = task.code.match(/^(.*?)(\d+)$/);
    if (!match) return;
    const [, prefix, rawNumber] = match;
    const value = Number(rawNumber);
    if (!Number.isFinite(value)) return;
    const group = suffixGroups.get(prefix) || { prefix, max: 0, width: rawNumber.length, count: 0 };
    group.max = Math.max(group.max, value);
    group.width = Math.max(group.width, rawNumber.length);
    group.count += 1;
    suffixGroups.set(prefix, group);
  });
  const suffixGroup = Array.from(suffixGroups.values()).sort((left, right) => right.count - left.count || right.max - left.max)[0];
  if (suffixGroup) return `${suffixGroup.prefix}${formatTaskCodeNumber(suffixGroup.max + 1, suffixGroup.width)}`;

  return `WBS-${String(roots.length + 1).padStart(2, "0")}`;
}

function nextTaskCode(tasks: Task[], parentId = "", excludeTaskId = "") {
  if (parentId) {
    const parent = tasks.find((task) => task.id === parentId);
    const prefix = parent?.code || "WBS";
    const childPattern = new RegExp(`^${escapeRegExp(prefix)}\\.(\\d+)$`);
    const used = tasks
      .filter((task) => task.id !== excludeTaskId && task.parentId === parentId)
      .map((task) => task.code.match(childPattern)?.[1])
      .filter((segment): segment is string => Boolean(segment));
    const next = Math.max(0, ...used.map((segment) => Number(segment))) + 1;
    const width = Math.max(/^\d+(?:\.\d+)*$/.test(prefix) ? 1 : 2, ...used.map((segment) => segment.length));
    return `${prefix}.${formatTaskCodeNumber(next, width)}`;
  }
  return nextRootTaskCode(tasks, excludeTaskId);
}

function clampProgress(value: FormDataEntryValue | null) {
  const parsed = Number(value || 0);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, Math.min(100, parsed));
}

function personDayValue(value: FormDataEntryValue | null) {
  const parsed = Number(value || 0);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, parsed);
}

function descendantIds(tasks: Task[], taskId: string) {
  const childrenByParent = new Map<string, Task[]>();
  tasks.forEach((task) => {
    const children = childrenByParent.get(task.parentId) || [];
    children.push(task);
    childrenByParent.set(task.parentId, children);
  });

  const ids = new Set<string>();
  const collect = (id: string) => {
    (childrenByParent.get(id) || []).forEach((child) => {
      ids.add(child.id);
      collect(child.id);
    });
  };
  collect(taskId);
  return ids;
}

function projectMilestoneOptions(state: AppState, projectId: string, currentValue: string) {
  const options = state.deliverables
    .filter((deliverable) => deliverable.projectId === projectId && /^M\d+-ACCEPT$/i.test(deliverable.code))
    .sort((left, right) => left.dueDate.localeCompare(right.dueDate) || left.code.localeCompare(right.code))
    .map((deliverable) => {
      const milestoneCode = deliverable.code.replace(/-ACCEPT$/i, "");
      const milestoneName = deliverable.name.replace(/验收标准$/, "");
      const dueDate = deliverable.dueDate ? deliverable.dueDate.slice(5).replace("-", "-") : "";
      return `${milestoneCode} ${milestoneName}${dueDate ? ` (${dueDate})` : ""}`;
    });
  const uniqueOptions = Array.from(new Set(options));
  return currentValue && !uniqueOptions.includes(currentValue) ? [currentValue, ...uniqueOptions] : uniqueOptions;
}

export function ProjectDialog({
  state,
  item,
  onSave,
  onClose,
}: {
  state: AppState;
  item?: Project;
  onSave: (project: Project) => void;
  onClose: () => void;
}) {
  const stageOptions = stageDefinitionsForState(state, item?.id);
  const defaults: Project = item || {
    id: crypto.randomUUID(),
    name: "",
    client: "",
    phase: stageOptions[0]?.label || "项目启动",
    health: "健康",
    owner: "我",
    startDate: today(),
    endDate: today(),
    progress: 0,
    nextMilestone: "",
    description: "",
    estimatedImplementationPersonDays: 0,
    estimatedDevelopmentPersonDays: 0,
  };
  const milestoneOptions = projectMilestoneOptions(state, defaults.id, defaults.nextMilestone);

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="projectDialogTitle">
        <header className="modal-header">
          <div>
            <span className="page-kicker">Project</span>
            <h3 id="projectDialogTitle">{item ? "编辑项目" : "新建项目"}</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <form
          className="modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const name = String(form.get("name") || "").trim();
            const client = String(form.get("client") || "").trim();
            if (!name || !client) return;
            onSave({
              ...defaults,
              name,
              client,
              phase: String(form.get("phase") || defaults.phase),
              health: String(form.get("health") || defaults.health) as Project["health"],
              owner: String(form.get("owner") || "我").trim(),
              startDate: String(form.get("startDate") || today()),
              endDate: String(form.get("endDate") || today()),
              progress: defaults.progress,
              nextMilestone: String(form.get("nextMilestone") || "").trim(),
              description: String(form.get("description") || "").trim(),
              estimatedImplementationPersonDays: personDayValue(form.get("estimatedImplementationPersonDays")),
              estimatedDevelopmentPersonDays: personDayValue(form.get("estimatedDevelopmentPersonDays")),
            });
          }}
        >
          <div className="form-grid">
            <label>
              项目名称
              <input name="name" defaultValue={defaults.name} required autoFocus />
            </label>
            <label>
              客户 / 组织
              <input name="client" defaultValue={defaults.client} required />
            </label>
            <label>
              当前阶段
              <select name="phase" defaultValue={defaults.phase}>
                {stageOptions.map((stage) => (
                  <option key={stage.id} value={stage.label}>
                    {stage.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              健康度
              <select name="health" defaultValue={defaults.health}>
                {healthValues.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              负责人
              <input name="owner" defaultValue={defaults.owner} />
            </label>
            <label>
              下一里程碑
              <select name="nextMilestone" defaultValue={defaults.nextMilestone}>
                <option value="">未设置</option>
                {milestoneOptions.map((milestone) => (
                  <option key={milestone} value={milestone}>
                    {milestone}
                  </option>
                ))}
              </select>
            </label>
            <label>
              预估实施人天
              <input name="estimatedImplementationPersonDays" type="number" min="0" step="0.5" defaultValue={defaults.estimatedImplementationPersonDays} />
            </label>
            <label>
              预估开发人天
              <input name="estimatedDevelopmentPersonDays" type="number" min="0" step="0.5" defaultValue={defaults.estimatedDevelopmentPersonDays} />
            </label>
            <label>
              开始日期
              <input name="startDate" type="date" defaultValue={defaults.startDate || today()} />
            </label>
            <label>
              结束日期
              <input name="endDate" type="date" defaultValue={defaults.endDate || today()} />
            </label>
            <label className="wide">
              项目说明
              <textarea name="description" defaultValue={defaults.description} />
            </label>
          </div>
          <footer className="modal-actions">
            <Button tone="ghost" onClick={onClose}>
              取消
            </Button>
            <Button tone="primary" type="submit">
              保存项目
            </Button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export function TaskDialog({
  state,
  item,
  parentId,
  onSave,
  onClose,
}: {
  state: AppState;
  item?: Task;
  parentId?: string;
  onSave: (task: Task) => void;
  onClose: () => void;
}) {
  const project = getProject(state);
  const tasks = projectTasks(state, project.id);
  const stageOptions = stageDefinitionsForState(state, project.id);
  const defaultStageId = stageOptions.find((stage) => stage.id === "deployment")?.id || stageOptions[0]?.id || "deployment";
  const defaultParentId = item?.parentId || parentId || "";
  const defaults: Task = item || {
    id: crypto.randomUUID(),
    projectId: project.id,
    parentId: defaultParentId,
    code: nextTaskCode(tasks, defaultParentId),
    title: "",
    type: defaultParentId ? "实施" : "主任务",
    status: "todo",
    stage: defaultStageId,
    dimension: "实施事项",
    priority: "中",
    owner: "我",
    startDate: today(),
    dueDate: today(),
    progress: 0,
    updatedAt: "",
  };
  const hasChildTasks = tasks.some((task) => task.parentId === defaults.id);
  const parentOptions = tasks.filter((task) => !task.parentId && task.id !== defaults.id);
  const availableParentOptions = hasChildTasks ? parentOptions.filter((task) => task.id === defaults.parentId) : parentOptions;
  const [selectedParentId, setSelectedParentId] = useState(defaults.parentId);
  const generatedCode = item && selectedParentId === defaults.parentId ? defaults.code : nextTaskCode(tasks, selectedParentId, defaults.id);
  const generatedType = selectedParentId ? "实施" : item && !defaults.parentId ? defaults.type : "主任务";
  const editableProgress = Boolean(selectedParentId);

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="taskDialogTitle">
        <header className="modal-header">
          <div>
            <span className="page-kicker">Task</span>
            <h3 id="taskDialogTitle">{item ? "编辑事项" : "新建事项"}</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <form
          className="modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const title = String(form.get("title") || "").trim();
            if (!title) return;
            const status = String(form.get("status") || "todo") as TaskStatus;
            const parentId = String(form.get("parentId") || "");
            onSave({
              ...defaults,
              code: item && parentId === defaults.parentId ? defaults.code : nextTaskCode(tasks, parentId, defaults.id),
              title,
              type: parentId ? "实施" : item && !defaults.parentId ? defaults.type : "主任务",
              parentId,
              status,
              stage: String(form.get("stage") || defaultStageId) as TaskStage,
              dimension: String(form.get("dimension") || "实施事项").trim(),
              priority: String(form.get("priority") || "中") as Task["priority"],
              owner: String(form.get("owner") || "我").trim(),
              startDate: String(form.get("startDate") || defaults.startDate || today()),
              dueDate: String(form.get("dueDate") || today()),
              progress: parentId ? (status === "done" ? 100 : clampProgress(form.get("progress"))) : 0,
              updatedAt: new Date().toISOString(),
            });
          }}
        >
          <div className="form-grid">
            <label>
              标题
              <input name="title" defaultValue={defaults.title} required autoFocus />
            </label>
            <label>
              编号
              <input name="code" value={generatedCode} readOnly aria-readonly="true" />
            </label>
            <label>
              类型
              <input name="type" value={generatedType} readOnly aria-readonly="true" />
            </label>
            <label>
              上级任务
              <select name="parentId" value={selectedParentId} onChange={(event) => setSelectedParentId(event.currentTarget.value)} disabled={hasChildTasks}>
                <option value="">无，作为主任务</option>
                {availableParentOptions.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.code} - {task.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              状态
              <select name="status" defaultValue={defaults.status}>
                {taskStatuses.map((status) => (
                  <option key={status} value={status}>
                    {taskStatusLabels[status]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              阶段
              <select name="stage" defaultValue={defaults.stage}>
                {stageOptions.map((stage) => (
                  <option key={stage.id} value={stage.id}>
                    {stage.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              优先级
              <select name="priority" defaultValue={defaults.priority}>
                {priorities.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </select>
            </label>
            <label>
              负责人
              <input name="owner" defaultValue={defaults.owner} />
            </label>
            <label>
              开始日期
              <input name="startDate" type="date" defaultValue={defaults.startDate || defaults.dueDate || today()} />
            </label>
            <label>
              截止日期
              <input name="dueDate" type="date" defaultValue={defaults.dueDate || today()} />
            </label>
            <label>
              维度
              <input name="dimension" defaultValue={defaults.dimension} />
            </label>
            <label>
              进度
              <input
                name="progress"
                type="number"
                min="0"
                max="100"
                defaultValue={editableProgress ? defaults.progress : 0}
                disabled={!editableProgress}
                aria-readonly={!editableProgress}
              />
            </label>
          </div>
          <footer className="modal-actions">
            <Button tone="ghost" onClick={onClose}>
              取消
            </Button>
            <Button tone="primary" type="submit">
              保存事项
            </Button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export function ScopeItemDialog({
  state,
  item,
  onSave,
  onClose,
}: {
  state: AppState;
  item?: ScopeItem;
  onSave: (scopeItem: ScopeItem) => void;
  onClose: () => void;
}) {
  const project = getProject(state);
  const defaults: ScopeItem = item || {
    id: crypto.randomUUID(),
    projectId: project.id,
    category: "本期SOW范围",
    personDayType: "实施",
    title: "",
    description: "",
    estimatedPersonDays: 0,
    actualPersonDays: 0,
    progress: 0,
    content: "",
  };
  const defaultTitle = defaults.title || defaults.content;
  const defaultDescription = defaults.description || defaults.content;

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-panel compact" role="dialog" aria-modal="true" aria-labelledby="scopeDialogTitle">
        <header className="modal-header">
          <div>
            <span className="page-kicker">Scope</span>
            <h3 id="scopeDialogTitle">{item ? "编辑范围项" : "新建范围项"}</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <form
          className="modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const title = String(form.get("title") || "").trim();
            const description = String(form.get("description") || "").trim();
            if (!title) return;
            onSave({
              ...defaults,
              category: String(form.get("category") || defaults.category) as ScopeItem["category"],
              personDayType: String(form.get("personDayType") || defaults.personDayType) as ScopeItem["personDayType"],
              title,
              description,
              estimatedPersonDays: personDayValue(form.get("estimatedPersonDays")),
              actualPersonDays: personDayValue(form.get("actualPersonDays")),
              progress: clampProgress(form.get("progress")),
              content: title,
            });
          }}
        >
          <div className="form-grid">
            <label>
              分类
              <select name="category" defaultValue={defaults.category}>
                {scopeCategories.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
            <label>
              人天类型
              <select name="personDayType" defaultValue={defaults.personDayType}>
                {personDayTypes.map((personDayType) => (
                  <option key={personDayType} value={personDayType}>
                    {personDayType}
                  </option>
                ))}
              </select>
            </label>
            <label>
              范围标题
              <input name="title" defaultValue={defaultTitle} required autoFocus />
            </label>
            <label>
              预估人天
              <input name="estimatedPersonDays" type="number" min="0" step="0.5" defaultValue={defaults.estimatedPersonDays} />
            </label>
            <label>
              实际人天
              <input name="actualPersonDays" type="number" min="0" step="0.5" defaultValue={defaults.actualPersonDays} />
            </label>
            <label>
              进度
              <input name="progress" type="number" min="0" max="100" defaultValue={defaults.progress} />
            </label>
            <label className="wide">
              范围描述
              <textarea name="description" defaultValue={defaultDescription} required />
            </label>
          </div>
          <footer className="modal-actions">
            <Button tone="ghost" onClick={onClose}>
              取消
            </Button>
            <Button tone="primary" type="submit">
              保存范围项
            </Button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export function DeliverableDialog({
  state,
  item,
  onSave,
  onClose,
}: {
  state: AppState;
  item?: Deliverable;
  onSave: (deliverable: Deliverable) => void;
  onClose: () => void;
}) {
  const project = getProject(state);
  const tasks = projectTasks(state, project.id);
  const linkedTaskFromCode = item ? tasks.find((task) => task.id === item.linkedTaskId || task.code === item.code) : undefined;
  const defaults: Deliverable = item || {
    id: crypto.randomUUID(),
    projectId: project.id,
    name: "",
    code: nextCode("DOC", state.deliverables.filter((deliverable) => deliverable.projectId === project.id).length),
    linkedTaskId: "",
    status: "草稿",
    acceptance: "待确认",
    dueDate: today(),
    attachmentRequirement: "required",
  };
  const selectedLinkedTaskId = defaults.linkedTaskId || linkedTaskFromCode?.id || "";

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-panel compact" role="dialog" aria-modal="true" aria-labelledby="deliverableDialogTitle">
        <header className="modal-header">
          <div>
            <span className="page-kicker">Deliverable</span>
            <h3 id="deliverableDialogTitle">{item ? "编辑交付物" : "新建交付物"}</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <form
          className="modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const name = String(form.get("name") || "").trim();
            if (!name) return;
            const linkedTaskId = String(form.get("linkedTaskId") || "");
            const linkedTask = tasks.find((task) => task.id === linkedTaskId);
            onSave({
              ...defaults,
              name,
              code: linkedTask?.code || defaults.code,
              linkedTaskId,
              status: String(form.get("status") || "草稿"),
              acceptance: String(form.get("acceptance") || "待确认"),
              dueDate: String(form.get("dueDate") || today()),
              attachmentRequirement: defaults.attachmentRequirement || "required",
            });
          }}
        >
          <div className="form-grid">
            <label>
              交付物名称
              <input name="name" defaultValue={defaults.name} required autoFocus />
            </label>
            <label>
              关联相关任务项
              <select name="linkedTaskId" defaultValue={selectedLinkedTaskId}>
                <option value="">未关联</option>
                {tasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.code} - {task.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              状态
              <select name="status" defaultValue={defaults.status}>
                {["草稿", "待提交", "已提交", "已更新", "待评审", "待客户签字", "已归档"].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              验收
              <select name="acceptance" defaultValue={defaults.acceptance}>
                {["待确认", "待验收", "待评审", "客户确认", "客户验收", "内部确认", "已验收", "未提交"].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              截止日期
              <input name="dueDate" type="date" defaultValue={defaults.dueDate || today()} />
            </label>
          </div>
          <footer className="modal-actions">
            <Button tone="ghost" onClick={onClose}>
              取消
            </Button>
            <Button tone="primary" type="submit">
              保存交付物
            </Button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export function RiskIssueDialog({
  state,
  item,
  riskKind,
  onSave,
  onClose,
}: {
  state: AppState;
  item?: RiskIssue;
  riskKind?: RiskIssue["kind"];
  onSave: (riskIssue: RiskIssue) => void;
  onClose: () => void;
}) {
  const project = getProject(state);
  const tasks = projectTasks(state, project.id);
  const defaults: RiskIssue = item || {
    id: crypto.randomUUID(),
    projectId: project.id,
    kind: riskKind || "risk",
    title: "",
    severity: "中",
    status: "open",
    responsePlan: "",
    linkedTaskId: "",
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-panel compact" role="dialog" aria-modal="true" aria-labelledby="riskDialogTitle">
        <header className="modal-header">
          <div>
            <span className="page-kicker">Risk / Issue</span>
            <h3 id="riskDialogTitle">{item ? "编辑风险问题" : "新建风险问题"}</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <form
          className="modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const title = String(form.get("title") || "").trim();
            if (!title) return;
            onSave({
              ...defaults,
              kind: String(form.get("kind") || "risk") as RiskIssue["kind"],
              title,
              severity: String(form.get("severity") || "中") as RiskIssue["severity"],
              status: String(form.get("status") || "open") as RiskIssue["status"],
              responsePlan: String(form.get("responsePlan") || "").trim(),
              linkedTaskId: String(form.get("linkedTaskId") || ""),
            });
          }}
        >
          <div className="form-grid">
            <label>
              类型
              <select name="kind" defaultValue={defaults.kind}>
                {riskKinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind === "risk" ? "风险" : "问题"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              严重度
              <select name="severity" defaultValue={defaults.severity}>
                {severities.map((severity) => (
                  <option key={severity} value={severity}>
                    {severity}
                  </option>
                ))}
              </select>
            </label>
            <label>
              状态
              <select name="status" defaultValue={defaults.status}>
                {riskStatuses.map((status) => (
                  <option key={status} value={status}>
                    {status === "open" ? "打开" : status === "tracking" ? "跟踪中" : "已关闭"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              关联任务
              <select name="linkedTaskId" defaultValue={defaults.linkedTaskId}>
                <option value="">不关联</option>
                {tasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.code} - {task.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="wide">
              标题
              <input name="title" defaultValue={defaults.title} required autoFocus />
            </label>
            <label className="wide">
              应对方案
              <textarea name="responsePlan" defaultValue={defaults.responsePlan} />
            </label>
          </div>
          <footer className="modal-actions">
            <Button tone="ghost" onClick={onClose}>
              取消
            </Button>
            <Button tone="primary" type="submit">
              保存风险问题
            </Button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export function ConfirmDialog({
  title,
  description,
  confirmText = "确认",
  tone = "primary",
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmText?: string;
  tone?: "primary" | "danger";
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-panel confirm" role="dialog" aria-modal="true" aria-labelledby="confirmDialogTitle">
        <header className="modal-header">
          <div>
            <span className="page-kicker">Confirm</span>
            <h3 id="confirmDialogTitle">{title}</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="modal-form">
          <p className="confirm-copy">{description}</p>
          <footer className="modal-actions">
            <Button tone="ghost" onClick={onClose}>
              取消
            </Button>
            <Button tone={tone} onClick={onConfirm}>
              {confirmText}
            </Button>
          </footer>
        </div>
      </section>
    </div>
  );
}
