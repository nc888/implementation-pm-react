import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { AppShell } from "./components/AppShell";
import { ConfirmDialog, DeliverableDialog, ProjectDialog, RiskIssueDialog, ScopeItemDialog, TaskDialog } from "./components/EntityDialogs";
import { createRepository } from "./services/repositoryFactory";
import { migrateAppState, type ProjectRepository } from "./services/repository";
import { exportSingleProjectBackupJson, importProjectsFromBackup, type ProjectBackupScope } from "./services/projectImport";
import {
  buildProjectSnapshot,
  createProjectStageConfig,
  getProject,
  normalizeProjectPhase,
  normalizeProjectMilestones,
  normalizeStageDefinitions,
  normalizeTaskStage,
  projectTasks,
  stageCoefficientTotal,
  stageDefinitionsForProject,
  stageLabel,
} from "./services/contextBuilder";
import { ruleBasedAiService } from "./services/aiService";
import {
  draftKeyFor,
  canRunHardwareSkillKernel,
  confirmProjectFlow,
  emptyWorkflow,
  type DeliveryDraftKind,
  generateDeliveryDraft,
  getWorkflow,
  extractSowHandoffContent,
  mergeResourceInputsFromSowHandoff,
  normalizeSowWithAi,
  summarizeWbsPlanDraft,
  updateDraft,
  upsertWorkflow,
} from "./services/deliveryWorkflowService";
import { callConfiguredModel, callConfiguredModelStreaming, defaultModelConfig } from "./services/modelGateway";
import { loadAiConfigFromFile } from "./services/aiConfigFile";
import { recordAiGenerationRun } from "./services/aiGenerationAudit";
import { assistantSessionMessages, assistantSessionProjectId, normalizeAssistantScope } from "./services/assistantSessions";
import { deleteWeeklyReportMarkdownFile, moveDeliverableAttachmentToStage, saveWeeklyReportMarkdownFile } from "./services/deliverableFileStorage";
import { localDateKey, normalizeWeeklyCustomerMailSubject, normalizeWeeklyMailSubject } from "./services/weeklyReportService";
import {
  applyTaskCommandPlan,
  buildTaskCommandExtractionMessages,
  formatTaskCommandResult,
  inferRuleBasedTaskCommandPlan,
  looksLikeTaskCommandRequest,
  parseTaskCommandPlan,
} from "./services/aiTaskCommandService";
import {
  applyProjectDataCommandPlan,
  buildAssistantDataSnapshot,
  buildProjectDataCommandExtractionMessages,
  formatProjectDataCommandResult,
  inferRuleBasedProjectDataCommandPlan,
  looksLikeProjectDataCommandRequest,
  parseProjectDataCommandPlan,
} from "./services/assistantProjectDataService";
import type {
  AiModelConfig,
  AppState,
  AssistantScope,
  Deliverable,
  DeliveryWorkflow,
  EmailConfig,
  PageKey,
  Project,
  ProjectMilestone,
  RiskIssue,
  ScopeItem,
  SowInput,
  Task,
  TaskStageDefinition,
  TaskStatus,
  WeeklyReportPreferenceInput,
  WeeklyReportInput,
} from "./types";
import {
  DashboardPage,
  PortalPage,
} from "./pages/project-workbench";
import { BoardPage, DeliverablesPage, GanttPage, ListPage, ProjectOverviewPage, RisksPage, ScopePage, WeeklyHistoryPage, WeeklyPage } from "./pages/project-execution";
import { HardwareAssessmentPage, ImplementationPlanPage, ResourceAssessmentPage, SowPage, WbsPlanPage } from "./pages/ai-generation";
import { AssistantPage } from "./pages/project-intelligence";
import { SettingsPage } from "./pages/ai-model-config";

function mergeLegacyAiConfig(state: AppState, config: AiModelConfig): AppState {
  const defaultConfigId = state.aiModelConfigs.find((item) => item.isDefault)?.id;
  const existing = state.aiModelConfigs.find((item) => item.id === config.id);
  if (existing?.apiKey?.trim()) return state;
  const normalized = { ...config, isDefault: defaultConfigId ? config.id === defaultConfigId : config.isDefault };
  return {
    ...state,
    aiModelConfigs: existing
      ? state.aiModelConfigs.map((item) => (item.id === normalized.id ? { ...item, ...normalized } : item))
      : [...state.aiModelConfigs, { ...normalized, isDefault: !defaultConfigId && normalized.isDefault }],
  };
}

function backupFileSegment(value: string) {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "project";
}

function backupTimestamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function buildAssistantSnapshot(state: AppState, project: Project, scope: AssistantScope) {
  return buildAssistantDataSnapshot(state, project, scope);
}

export function App() {
  const aiService = useMemo(() => ruleBasedAiService, []);
  const [repository, setRepository] = useState<ProjectRepository | null>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [streamingAssistantMessages, setStreamingAssistantMessages] = useState<Record<string, AppState["aiMessages"][number]>>({});
  const saveQueueRef = useRef<{ saving: boolean; pending: AppState | null; repository: ProjectRepository | null }>({
    saving: false,
    pending: null,
    repository: null,
  });
  const [storageError, setStorageError] = useState("");
  const [generatingWorkflow, setGeneratingWorkflow] = useState<"" | DeliveryDraftKind>("");
  const [standardizingSow, setStandardizingSow] = useState(false);
  const [notice, setNotice] = useState<{ id: number; tone: "primary" | "success" | "warning" | "danger"; message: string } | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: "project"; item?: Project }
    | { kind: "task"; item?: Task; parentId?: string }
    | { kind: "scope"; item?: ScopeItem }
    | { kind: "deliverable"; item?: Deliverable }
    | { kind: "risk"; item?: RiskIssue; riskKind?: RiskIssue["kind"] }
    | {
        kind: "confirm";
        title: string;
        description: string;
        confirmText?: string;
        tone?: "primary" | "danger";
        onConfirm: () => void;
      }
    | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    createRepository()
      .then(async (repo) => {
        let loaded = await repo.load();
        try {
          const fileConfig = await loadAiConfigFromFile();
          if (fileConfig) {
            loaded = mergeLegacyAiConfig(loaded, fileConfig);
          }
        } catch (error) {
          console.warn("AI config file unavailable.", error);
        }
        if (!cancelled) {
          setRepository(repo);
          setState(loaded);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setStorageError(error instanceof Error ? error.message : "本地数据加载失败");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!state) return;
    const hasGpt55Config = state.aiModelConfigs.some((item) => item.id === "ai-gpt55-proxy");
    const hasXiaomiConfig = state.aiModelConfigs.some((item) => item.id === "ai-xiaomi-mimo");
    const hasKimiConfig = state.aiModelConfigs.some((item) => item.id === "ai-kimi-k26");
    if (!hasGpt55Config || !hasXiaomiConfig || !hasKimiConfig) {
      setState(migrateAppState(state));
    }
  }, [state]);

  useEffect(() => {
    if (!repository || !state) return;
    const queue = saveQueueRef.current;
    if (queue.repository !== repository) {
      queue.repository = repository;
      queue.pending = null;
      queue.saving = false;
    }
    queue.pending = state;

    if (queue.saving) return;

    queue.saving = true;
    const flush = async () => {
      try {
        while (queue.pending) {
          const nextState = queue.pending;
          queue.pending = null;
          await repository.save(nextState);
        }
      } catch (error) {
        console.error("Project state save failed.", error);
        setStorageError(error instanceof Error ? error.message : "项目数据保存失败");
      } finally {
        queue.saving = false;
        if (queue.pending) {
          queue.saving = true;
          void flush();
        }
      }
    };

    void flush();
  }, [repository, state]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (!repository || !state) {
    return (
      <div className="boot-screen">
        <div className="boot-card">
          <strong>实施项目管家</strong>
          <p>{storageError || "正在加载本地项目数据..."}</p>
        </div>
      </div>
    );
  }

  const update = (next: AppState) => setState(next);
  const notify = (message: string, tone: "primary" | "success" | "warning" | "danger" = "success") => {
    setNotice({ id: Date.now(), tone, message });
  };
  const persistImmediately = async (nextState: AppState) => {
    const queue = saveQueueRef.current;
    if (queue.repository === repository) {
      queue.pending = nextState;
    }
    try {
      await repository.save(nextState);
    } catch (error) {
      const message = error instanceof Error ? error.message : "项目数据保存失败";
      setStorageError(message);
      throw error;
    }
  };
  const requestConfirm = ({
    title,
    description,
    confirmText,
    tone = "danger",
    onConfirm,
  }: {
    title: string;
    description: string;
    confirmText?: string;
    tone?: "primary" | "danger";
    onConfirm: () => void;
  }) => {
    setDialog({
      kind: "confirm",
      title,
      description,
      confirmText,
      tone,
      onConfirm: () => {
        onConfirm();
        setDialog(null);
      },
    });
  };

  const setPage = (page: PageKey) => {
    setState((current) => {
      if (!current) return current;
      return { ...current, ui: { ...current.ui, currentPage: page } };
    });
  };

  const setSearch = (search: string) => {
    setState((current) => (current ? { ...current, ui: { ...current.ui, search } } : current));
  };

  const setAssistantScope = (assistantScope: AssistantScope) => {
    setState((current) => (current ? { ...current, ui: { ...current.ui, assistantScope } } : current));
  };

  const clearAssistantHistory = (assistantScope: AssistantScope) => {
    const scope = normalizeAssistantScope(assistantScope);
    const project = getProject(state);
    const sessionProjectId = assistantSessionProjectId(scope, project.id);
    setState((current) =>
      current
        ? {
            ...current,
            aiMessages: current.aiMessages.filter((message) => !(message.scope === scope && message.projectId === sessionProjectId)),
          }
        : current,
    );
    setStreamingAssistantMessages((current) =>
      Object.fromEntries(Object.entries(current).filter(([, message]) => !(message.scope === scope && message.projectId === sessionProjectId))),
    );
    notify(scope === "all" ? "已清空所有项目模式的项目智囊历史。" : "已清空当前项目的项目智囊历史。", "warning");
  };

  const setProject = (projectId: string) => {
    setState((current) => {
      if (!current) return current;
      return {
        ...current,
        ui: {
          ...current.ui,
          currentProjectId: projectId,
          currentPage: ["portal", "dashboard", "assistant", "settings", "modelSettings", "stageSettings", "emailSettings"].includes(current.ui.currentPage)
            ? "overview"
            : current.ui.currentPage,
        },
      };
    });
  };

  const exportData = async (scope: ProjectBackupScope = "all") => {
    const project = getProject(state);
    const timeKey = backupTimestamp();
    const isProjectExport = scope === "project";
    const content = isProjectExport ? exportSingleProjectBackupJson(state, project.id) : repository.exportJson(state);
    const fileName = isProjectExport
      ? `implementation-pm-project-${backupFileSegment(project.name)}-${timeKey}.json`
      : `implementation-pm-backup-${timeKey}.json`;
    if (isTauri()) {
      try {
        const response = (await invoke("save_backup_file", { fileName, content })) as { ok?: boolean; path?: string; error?: string };
        if (response?.ok !== true) {
          notify(`导出失败：${response?.error || "无法保存备份文件。"}`, "danger");
          return;
        }
        notify(`${isProjectExport ? "当前项目备份" : "平台全部数据备份"}已导出：${response.path}`, "primary");
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || "无法保存备份文件。");
        notify(`导出失败：${message}`, "danger");
      }
      return;
    }
    const blob = new Blob([content], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    notify(isProjectExport ? `当前项目备份已导出：${project.name}` : "平台全部数据备份已导出。", "primary");
  };

  const importData = async (file: File) => {
    try {
      const raw = await file.text();
      if (!raw.trim()) {
        notify("导入失败：JSON 文件内容为空。", "warning");
        return;
      }
      const payload = JSON.parse(raw) as unknown;
      const result = importProjectsFromBackup(state, payload);
      setState(result.state);
      const details = [`${result.taskCount} 个任务`, `${result.deliverableCount} 个交付物`, `${result.riskIssueCount} 个风险/问题`].join("、");
      notify(`已导入 ${result.projectCount} 个项目：${result.projectNames.join("、")}。同步导入 ${details}。`, "success");
    } catch (error) {
      const message = error instanceof SyntaxError ? "JSON 格式无效，请选择平台导出的备份文件。" : error instanceof Error ? error.message : "无法读取导入文件。";
      notify(`导入失败：${message}`, "danger");
    }
  };

  const quickAdd = () => setDialog({ kind: "task" });

  const updateTaskStatus = (taskId: string, status: TaskStatus) => {
    setState((current) => (current ? repository.updateTaskStatus(current, taskId, status) : current));
    notify("事项状态已更新。", "primary");
  };

  const updateTaskProgress = (taskId: string, progress: number) => {
    setState((current) => (current ? repository.updateTaskProgress(current, taskId, progress) : current));
    notify("事项进度已更新。", "primary");
  };

  const updateScopeProgress = (scopeItemId: string, progress: number) => {
    const nextProgress = Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : 0;
    setState((current) =>
      current
        ? {
            ...current,
            scopeItems: current.scopeItems.map((item) => (item.id === scopeItemId ? { ...item, progress: nextProgress } : item)),
          }
        : current,
    );
    notify("范围进度已更新。", "primary");
  };

  const saveProject = (project: Project, milestones?: ProjectMilestone[]) => {
    const exists = state.projects.some((item) => item.id === project.id);
    setState((current) => {
      if (!current) return current;
      const projects = exists ? current.projects.map((item) => (item.id === project.id ? project : item)) : [...current.projects, project];
      const shouldSaveMilestones = Array.isArray(milestones);
      const normalizedMilestones = shouldSaveMilestones ? normalizeProjectMilestones(milestones) : [];
      const projectStageConfigs =
        current.projectStageConfigs.some((item) => item.projectId === project.id)
          ? current.projectStageConfigs.map((config) =>
              config.projectId === project.id && shouldSaveMilestones
                ? { ...config, milestones: normalizedMilestones, updatedAt: new Date().toISOString() }
                : config,
            )
          : [...current.projectStageConfigs, createProjectStageConfig(project.id, current.taskStages, new Date().toISOString(), normalizedMilestones)];
      return {
        ...current,
        projects,
        projectStageConfigs,
        ui: {
          ...current.ui,
          currentProjectId: project.id,
          currentPage: exists ? current.ui.currentPage : "overview",
        },
      };
    });
    setDialog(null);
    notify(exists ? "项目已更新。" : "项目已创建并进入项目概览。");
  };

  const deleteProject = (projectId: string) => {
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) return;
    if (state.projects.length <= 1) {
      notify("至少需要保留一个项目，不能删除最后一个项目。", "warning");
      return;
    }
    requestConfirm({
      title: "删除项目",
      description: `确认删除「${project.name}」？项目下的事项、范围、交付物、风险问题、周报和 AI 生成草稿都会一起删除。`,
      confirmText: "删除项目",
      onConfirm: () => {
        setState((current) => {
          if (!current || current.projects.length <= 1) return current;
          const projects = current.projects.filter((item) => item.id !== projectId);
          const nextProjectId = current.ui.currentProjectId === projectId ? projects[0].id : current.ui.currentProjectId;
          return {
            ...current,
            projects,
            tasks: current.tasks.filter((item) => item.projectId !== projectId),
            scopeItems: current.scopeItems.filter((item) => item.projectId !== projectId),
            deliverables: current.deliverables.filter((item) => item.projectId !== projectId),
            risksIssues: current.risksIssues.filter((item) => item.projectId !== projectId),
            weeklyReports: current.weeklyReports.filter((item) => item.projectId !== projectId),
            weeklyReportPreferences: current.weeklyReportPreferences.filter((item) => item.projectId !== projectId),
            projectStageConfigs: current.projectStageConfigs.filter((item) => item.projectId !== projectId),
            deliveryWorkflows: current.deliveryWorkflows.filter((item) => item.projectId !== projectId),
            ui: { ...current.ui, currentProjectId: nextProjectId, currentPage: "portal" },
          };
        });
        notify("项目已删除。", "danger");
      },
    });
  };

  const saveTask = (task: Task) => {
    const exists = state.tasks.some((item) => item.id === task.id);
    setState((current) => {
      if (!current) return current;
      const tasks = exists ? current.tasks.map((item) => (item.id === task.id ? task : item)) : [...current.tasks, task];
      return { ...current, tasks };
    });
    setDialog(null);
    if (!exists && state.ui.currentPage !== "board") setPage("list");
    notify(exists ? "事项已更新。" : "事项已创建，并同步到列表、看板、甘特和周报。");
  };

  const deleteTask = (taskId: string) => {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return;
    const childCount = state.tasks.filter((item) => item.parentId === taskId).length;
    requestConfirm({
      title: "删除事项",
      description: `确认删除「${task.title}」？关联的风险/问题会保留，但会解除与该事项的关联。${childCount ? `该事项下的 ${childCount} 个子任务会自动提升到上一层。` : ""}`,
      confirmText: "删除事项",
      onConfirm: () => {
        setState((current) =>
          current
            ? {
                ...current,
                tasks: current.tasks
                  .filter((item) => item.id !== taskId)
                  .map((item) => (item.parentId === taskId ? { ...item, parentId: task.parentId } : item)),
                risksIssues: current.risksIssues.map((item) => (item.linkedTaskId === taskId ? { ...item, linkedTaskId: "" } : item)),
                deliverables: current.deliverables.map((item) => (item.linkedTaskId === taskId ? { ...item, linkedTaskId: "" } : item)),
              }
            : current,
        );
        notify("事项已删除。", "danger");
      },
    });
  };

  const saveScopeItem = (scopeItem: ScopeItem) => {
    const exists = state.scopeItems.some((item) => item.id === scopeItem.id);
    setState((current) => {
      if (!current) return current;
      const scopeItems = exists
        ? current.scopeItems.map((item) => (item.id === scopeItem.id ? scopeItem : item))
        : [...current.scopeItems, scopeItem];
      return { ...current, scopeItems };
    });
    setDialog(null);
    setPage("scope");
    notify(exists ? "范围项已更新。" : "范围项已创建。");
  };

  const deleteScopeItem = (scopeItemId: string) => {
    const scopeItem = state.scopeItems.find((item) => item.id === scopeItemId);
    if (!scopeItem) return;
    requestConfirm({
      title: "删除范围项",
      description: `确认删除「${scopeItem.category}：${scopeItem.content}」？这会影响范围页和 AI 快照里的项目边界。`,
      confirmText: "删除范围项",
      onConfirm: () => {
        setState((current) => (current ? { ...current, scopeItems: current.scopeItems.filter((item) => item.id !== scopeItemId) } : current));
        notify("范围项已删除。", "danger");
      },
    });
  };

  const commitDeliverable = async (deliverable: Deliverable, exists: boolean) => {
    const deliverables = exists
      ? state.deliverables.map((item) => (item.id === deliverable.id ? deliverable : item))
      : [...state.deliverables, deliverable];
    const nextState = {
      ...state,
      deliverables,
      ui: { ...state.ui, currentPage: "deliverables" as PageKey },
    };
    setState(nextState);
    setDialog(null);
    await persistImmediately(nextState);
  };

  const saveDeliverable = async (deliverable: Deliverable) => {
    const previous = state.deliverables.find((item) => item.id === deliverable.id);
    const exists = Boolean(previous);
    let nextDeliverable = deliverable;
    const linkedTaskChanged = previous && previous.linkedTaskId !== deliverable.linkedTaskId;
    const shouldMoveAttachment = Boolean(linkedTaskChanged && previous?.attachmentName && previous.attachmentPath && deliverable.linkedTaskId);

    if (shouldMoveAttachment) {
      const project = state.projects.find((item) => item.id === deliverable.projectId) || getProject(state);
      const linkedTask = projectTasks(state, project.id).find((task) => task.id === deliverable.linkedTaskId);
      if (linkedTask) {
        try {
          const movedAttachment = await moveDeliverableAttachmentToStage({
            projectId: project.id,
            storageLabel: project.deliverableStoragePath || "",
            targetStageLabel: stageLabel(state, linkedTask.stage, linkedTask.projectId),
            attachmentName: previous?.attachmentName,
            attachmentPath: previous?.attachmentPath,
          });
          nextDeliverable = {
            ...deliverable,
            ...movedAttachment,
            attachmentUploadedAt: previous?.attachmentUploadedAt || deliverable.attachmentUploadedAt,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "附件移动失败，请确认目录权限后重试。";
          notify(`交付物未保存：${message}`, "danger");
          return;
        }
      }
    }

    try {
      await commitDeliverable(nextDeliverable, exists);
    } catch (error) {
      const message = error instanceof Error ? error.message : "项目数据保存失败";
      notify(`交付物未保存：${message}`, "danger");
      return;
    }
    notify(exists ? "交付物已更新。" : "交付物已创建。");
  };

  const updateDeliverable = async (deliverable: Deliverable) => {
    const nextState = {
      ...state,
      deliverables: state.deliverables.map((item) => (item.id === deliverable.id ? deliverable : item)),
    };
    setState(nextState);
    await persistImmediately(nextState);
  };

  const saveDeliverableStoragePath = async (projectId: string, deliverableStoragePath: string) => {
    const nextState = {
      ...state,
      projects: state.projects.map((project) => (project.id === projectId ? { ...project, deliverableStoragePath } : project)),
    };
    setState(nextState);
    await persistImmediately(nextState);
  };

  const deleteDeliverable = (deliverableId: string) => {
    const deliverable = state.deliverables.find((item) => item.id === deliverableId);
    if (!deliverable) return;
    requestConfirm({
      title: "删除交付物",
      description: `确认删除「${deliverable.name}」？删除后项目概览、周报和 AI 快照中的交付物统计会同步变化。`,
      confirmText: "删除交付物",
      onConfirm: () => {
        setState((current) =>
          current ? { ...current, deliverables: current.deliverables.filter((item) => item.id !== deliverableId) } : current,
        );
        notify("交付物已删除。", "danger");
      },
    });
  };

  const saveRiskIssue = (riskIssue: RiskIssue) => {
    const exists = state.risksIssues.some((item) => item.id === riskIssue.id);
    setState((current) => {
      if (!current) return current;
      const risksIssues = exists
        ? current.risksIssues.map((item) => (item.id === riskIssue.id ? riskIssue : item))
        : [...current.risksIssues, riskIssue];
      return { ...current, risksIssues };
    });
    setDialog(null);
    setPage("risks");
    notify(exists ? "风险/问题已更新。" : "风险/问题已创建。");
  };

  const deleteRiskIssue = (riskIssueId: string) => {
    const riskIssue = state.risksIssues.find((item) => item.id === riskIssueId);
    if (!riskIssue) return;
    requestConfirm({
      title: riskIssue.kind === "risk" ? "删除风险" : "删除问题",
      description: `确认删除「${riskIssue.title}」？删除后风险问题页、周报和 AI 快照会同步更新。`,
      confirmText: "删除",
      onConfirm: () => {
        setState((current) =>
          current ? { ...current, risksIssues: current.risksIssues.filter((item) => item.id !== riskIssueId) } : current,
        );
        notify("风险/问题已删除。", "danger");
      },
    });
  };

  const saveWeekly = (report: WeeklyReportInput | string) => {
    const project = getProject(state);
    const reportInput: WeeklyReportInput =
      typeof report === "string"
        ? {
            projectId: project.id,
            content: report,
            generatedBy: "ai",
            snapshot: buildProjectSnapshot(state, project, "weekly-report"),
          }
        : report;
    const projectId = reportInput.projectId || project.id;
    const targetProject = state.projects.find((item) => item.id === projectId) || project;
    const reportDate = reportInput.reportDate || localDateKey();
    const audience = reportInput.audience === "customer" ? "customer" : "internal";
    const mailSubject =
      audience === "customer"
        ? normalizeWeeklyCustomerMailSubject(targetProject, reportDate, reportInput.mailSubject || reportInput.title)
        : normalizeWeeklyMailSubject(targetProject, reportDate, reportInput.mailSubject || reportInput.title);
    const normalizedReportInput: WeeklyReportInput = {
      ...reportInput,
      projectId,
      audience,
      reportDate,
      title: mailSubject,
      mailSubject,
    };
    const persistWeeklyReportInput = (input: WeeklyReportInput) => {
      setState((current) => {
        if (!current) return current;
        const currentProject = current.projects.find((item) => item.id === input.projectId) || getProject(current);
        return repository.addWeeklyReport(current, {
          ...input,
          snapshot: input.snapshot || buildProjectSnapshot(current, currentProject, "weekly-report"),
        });
      });
    };

    persistWeeklyReportInput(normalizedReportInput);

    const isMailboxIntermediateDraft =
      normalizedReportInput.mailDraftStatus === "local-draft" && /正在保存到邮箱草稿箱/.test(normalizedReportInput.mailDraftMessage || "");
    if (isMailboxIntermediateDraft) {
      notify("周报记录已保存，正在保存邮箱草稿。", "primary");
      return;
    }

    void saveWeeklyReportMarkdownFile({
      projectId,
      storageLabel: targetProject.deliverableStoragePath || "",
      fileName: mailSubject,
      content: normalizedReportInput.content,
      audience,
    })
      .then((archive) => {
        persistWeeklyReportInput({
          ...normalizedReportInput,
          markdownArchiveStatus: "archived",
          markdownArchiveMessage: "Markdown 已归档到交付物目录。",
          markdownArchiveFileName: archive.fileName,
          markdownArchivePath: archive.filePath,
          markdownArchivedAt: archive.archivedAt,
        });
        notify(
          normalizedReportInput.mailDraftStatus === "mailbox-draft"
            ? "周报已保存，邮箱草稿状态已更新，Markdown 已归档。"
            : "周报记录已按日期保存，Markdown 已归档。",
        );
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Markdown 归档失败。";
        persistWeeklyReportInput({
          ...normalizedReportInput,
          markdownArchiveStatus: "failed",
          markdownArchiveMessage: message,
          markdownArchivedAt: new Date().toISOString(),
        });
        notify(`周报记录已保存；Markdown 归档失败：${message}`, "warning");
      });
  };

  const saveWeeklyPreference = (preference: WeeklyReportPreferenceInput) => {
    setState((current) => (current ? repository.upsertWeeklyReportPreference(current, preference) : current));
  };

  const deleteWeeklyReport = (reportId: string) => {
    const report = state.weeklyReports.find((item) => item.id === reportId);
    if (!report) return;
    requestConfirm({
      title: "删除周报归档",
      description: `确认删除「${report.mailSubject || report.title || report.reportDate}」？将删除历史周报记录，并尝试同步删除已归档的 Markdown 文件。`,
      confirmText: "删除周报",
      onConfirm: () => {
        const removeReportRecord = () => {
          setState((current) => (current ? { ...current, weeklyReports: current.weeklyReports.filter((item) => item.id !== reportId) } : current));
        };
        const shouldDeleteArchive = report.markdownArchiveStatus === "archived" && (report.markdownArchiveFileName || report.markdownArchivePath);
        if (!shouldDeleteArchive) {
          removeReportRecord();
          notify("周报记录已删除。", "danger");
          return;
        }
        void deleteWeeklyReportMarkdownFile({
          projectId: report.projectId,
          fileName: report.markdownArchiveFileName,
          filePath: report.markdownArchivePath,
          audience: report.audience === "customer" ? "customer" : "internal",
        })
          .then(() => {
            removeReportRecord();
            notify("周报记录和 Markdown 归档已删除。", "danger");
          })
          .catch((error) => {
            removeReportRecord();
            const message = error instanceof Error ? error.message : "Markdown 归档文件删除失败。";
            notify(`周报记录已删除；Markdown 归档删除失败：${message}`, "warning");
          });
      },
    });
  };

  const askAi = async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed) return;
    const config = defaultModelConfig(state.aiModelConfigs);
    const project = getProject(state);
    const assistantScope = normalizeAssistantScope(state.ui.assistantScope);
    const sessionProjectId = assistantSessionProjectId(assistantScope, project.id);
    const snapshot = buildAssistantSnapshot(state, project, assistantScope);
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    setState((current) => {
      if (!current) return current;
      return {
        ...current,
        aiMessages: [
          ...current.aiMessages,
          { id: userMessageId, role: "user", content: trimmed, createdAt, scope: assistantScope, projectId: sessionProjectId },
          { id: assistantMessageId, role: "assistant", content: "正在基于当前会话范围调用 AI 模型...", createdAt, scope: assistantScope, projectId: sessionProjectId },
        ],
      };
    });

    const updateAssistantReply = (content: string) => {
      setState((current) =>
        current
          ? {
              ...current,
              aiMessages: current.aiMessages.map((message) =>
                message.id === assistantMessageId ? { ...message, content, createdAt: new Date().toISOString() } : message,
              ),
            }
          : current,
      );
      setStreamingAssistantMessages((current) => {
        if (!current[assistantMessageId]) return current;
        const { [assistantMessageId]: _removed, ...rest } = current;
        return rest;
      });
    };

    const updateStreamingAssistantReply = (content: string) => {
      setStreamingAssistantMessages((current) => ({
        ...current,
        [assistantMessageId]: {
          id: assistantMessageId,
          role: "assistant",
          content,
          createdAt: new Date().toISOString(),
          scope: assistantScope,
          projectId: sessionProjectId,
        },
      }));
    };

    const executeTaskCommandPlan = (plan: ReturnType<typeof parseTaskCommandPlan> | NonNullable<ReturnType<typeof inferRuleBasedTaskCommandPlan>>) => {
      if (!plan || plan.mode !== "execute" || !plan.actions.length) return false;
      const commandProjectId = assistantScope === "all" ? "all" : project.id;
      const previewExecution = applyTaskCommandPlan(state, commandProjectId, plan);
      setState((current) => (current ? applyTaskCommandPlan(current, commandProjectId, plan).state : current));
      updateAssistantReply(formatTaskCommandResult(plan, previewExecution));
      notify(
        previewExecution.changedTasks.length ? `AI 已更新 ${previewExecution.changedTasks.length} 个任务。` : "AI 没有找到可更新的任务。",
        previewExecution.changedTasks.length ? "success" : "warning",
      );
      return true;
    };

    const executeProjectDataCommandPlan = (
      plan: ReturnType<typeof parseProjectDataCommandPlan> | NonNullable<ReturnType<typeof inferRuleBasedProjectDataCommandPlan>>,
    ) => {
      if (!plan || plan.mode !== "execute" || !plan.actions.length) return false;
      const commandProjectId = assistantScope === "all" ? "all" : project.id;
      const previewExecution = applyProjectDataCommandPlan(state, commandProjectId, plan);
      setState((current) => (current ? applyProjectDataCommandPlan(current, commandProjectId, plan).state : current));
      updateAssistantReply(formatProjectDataCommandResult(plan, previewExecution));
      notify(
        previewExecution.changedRecords.length ? `AI 已更新 ${previewExecution.changedRecords.length} 条项目数据。` : "AI 没有找到可更新的数据。",
        previewExecution.changedRecords.length ? "success" : "warning",
      );
      return true;
    };

    const ruleTaskPlan = inferRuleBasedTaskCommandPlan(trimmed);
    const ruleProjectPlan = inferRuleBasedProjectDataCommandPlan(trimmed);

    if (!config) {
      if (ruleProjectPlan && executeProjectDataCommandPlan(ruleProjectPlan)) return;
      if (ruleTaskPlan && executeTaskCommandPlan(ruleTaskPlan)) return;
      updateAssistantReply(aiService.reply(state, trimmed));
      return;
    }

    try {
      if (looksLikeProjectDataCommandRequest(trimmed)) {
        const commandRaw = await callConfiguredModel(
          config,
          buildProjectDataCommandExtractionMessages(state, project, trimmed, assistantScope),
          { requireProjectDataConsent: true, maxTokens: 2200, timeoutMs: 120_000 },
        );
        const commandPlan = parseProjectDataCommandPlan(commandRaw);
        if (commandPlan && commandPlan.mode === "execute" && commandPlan.actions.length) {
          executeProjectDataCommandPlan(commandPlan);
          return;
        }
        if (ruleProjectPlan && executeProjectDataCommandPlan(ruleProjectPlan)) {
          return;
        }

        if (!looksLikeTaskCommandRequest(trimmed)) {
          updateAssistantReply("我识别到这是项目数据变更指令，但没有解析出可执行的数据更新。请明确要改的对象、字段和新值。");
          return;
        }
      }

      if (looksLikeTaskCommandRequest(trimmed)) {
        const commandRaw = await callConfiguredModel(
          config,
          buildTaskCommandExtractionMessages(state, project, trimmed, assistantScope),
          { requireProjectDataConsent: true, maxTokens: 1200, timeoutMs: 90_000 },
        );
        const commandPlan = parseTaskCommandPlan(commandRaw);
        if (commandPlan && commandPlan.mode === "execute" && commandPlan.actions.length) {
          executeTaskCommandPlan(commandPlan);
          return;
        }
        if (ruleTaskPlan && executeTaskCommandPlan(ruleTaskPlan)) {
          return;
        }
        updateAssistantReply("我识别到这是项目数据变更指令，但没有解析出可执行的任务更新。请明确任务名称、状态或日期。");
        return;
      }

      const recentMessages = assistantSessionMessages(state.aiMessages, assistantScope, project.id)
        .slice(-4)
        .map(({ role, content }) => ({ role, content }))
        .filter((message) => message.content.trim());
      let streamedReply = "";
      let visibleReply = "";
      let revealTarget = "";
      let revealTimer: number | null = null;
      let revealResolve: (() => void) | null = null;
      let revealPromise = Promise.resolve();
      let revealStopped = false;
      let lastReplyFlush = 0;
      const resolveReveal = () => {
        if (!revealResolve) return;
        revealResolve();
        revealResolve = null;
      };
      const stepReveal = () => {
        revealTimer = null;
        if (revealStopped) {
          resolveReveal();
          return;
        }
        if (visibleReply.length >= revealTarget.length) {
          resolveReveal();
          return;
        }
        const remaining = revealTarget.length - visibleReply.length;
        const chunkSize = remaining > 360 ? 54 : remaining > 160 ? 34 : 20;
        visibleReply = revealTarget.slice(0, visibleReply.length + chunkSize);
        updateStreamingAssistantReply(visibleReply);
        if (visibleReply.length < revealTarget.length) {
          revealTimer = window.setTimeout(stepReveal, 24);
        } else {
          resolveReveal();
        }
      };
      const scheduleStreamingReveal = (content: string) => {
        if (!content || content.length <= revealTarget.length || revealStopped) return;
        revealTarget = content;
        if (!revealResolve) {
          revealPromise = new Promise((resolve) => {
            revealResolve = resolve;
          });
        }
        if (revealTimer === null) stepReveal();
      };
      const stopStreamingReveal = () => {
        revealStopped = true;
        if (revealTimer !== null) {
          window.clearTimeout(revealTimer);
          revealTimer = null;
        }
        resolveReveal();
      };
      const reply = await callConfiguredModelStreaming(
        config,
        [
          {
            role: "system",
            content:
              `你是软件实施项目管理助手。只能基于用户提供的${assistantScope === "all" ? "所有项目" : "当前项目"}完整快照和对话上下文回答，不要编造快照之外的项目事实。快照中包含项目基本信息、健康分、阶段/里程碑、任务、SOW范围、交付物、风险问题、周报和交付流程数据。普通问答模式不能声称已经修改项目数据；只有系统返回了本地执行结果时，才可以说“已更新/已修改”。默认回答保持中等简洁：先给 1 句结论，再给 4-6 条要点或行动建议；每条不超过 55 个字；总字数控制在 350-500 字。除非用户明确要求详细分析，不要展开长背景、过程推导或重复大段快照数据。使用中文。`,
          },
          ...recentMessages,
          {
            role: "user",
            content: `${assistantScope === "all" ? "所有项目快照" : "当前项目快照"}：\n${JSON.stringify(snapshot, null, 2)}\n\n用户问题：${trimmed}`,
          },
        ],
        { requireProjectDataConsent: true, maxTokens: 1100, timeoutMs: 120_000 },
        (_delta, content) => {
          streamedReply = content;
          if (!streamedReply) return;
          const now = Date.now();
          if (now - lastReplyFlush < 80) return;
          lastReplyFlush = now;
          scheduleStreamingReveal(streamedReply);
        },
      );
      const finalReply = reply || streamedReply;
      if (finalReply) {
        scheduleStreamingReveal(finalReply);
        await revealPromise;
      }
      stopStreamingReveal();
      updateAssistantReply(finalReply);
    } catch (error) {
      if (looksLikeProjectDataCommandRequest(trimmed) && ruleProjectPlan && executeProjectDataCommandPlan(ruleProjectPlan)) return;
      if (looksLikeTaskCommandRequest(trimmed) && ruleTaskPlan && executeTaskCommandPlan(ruleTaskPlan)) return;
      const message = error instanceof Error ? error.message : "远程模型返回异常";
      updateAssistantReply(`远程 AI 调用失败：${message}`);
    }
  };

  const saveConfig = (config: AiModelConfig) => {
    const nextConfig = { ...config, isDefault: true };
    setState((current) => {
      if (!current) return current;
      const exists = current.aiModelConfigs.some((item) => item.id === nextConfig.id);
      return {
        ...current,
        aiModelConfigs: exists
          ? current.aiModelConfigs.map((item) => (item.id === nextConfig.id ? nextConfig : { ...item, isDefault: false }))
          : [nextConfig, ...current.aiModelConfigs.map((item) => ({ ...item, isDefault: false }))],
      };
    });
    notify(`模型设置已保存到 ${repository.storageLabel}。`);
  };

  const saveTaskStages = (projectId: string, taskStages: TaskStageDefinition[], milestones?: ProjectMilestone[]) => {
    const draftStages = taskStages.filter((stage) => String(stage.label || "").trim());
    const coefficientTotal = stageCoefficientTotal(draftStages);
    if (coefficientTotal !== draftStages.length) {
      notify(`阶段系数合计必须等于阶段数量。当前 ${coefficientTotal}，目标 ${draftStages.length}。`, "warning");
      return;
    }
    const normalizedStages = normalizeStageDefinitions(taskStages);
    setState((current) => {
      if (!current) return current;
      const nextLabelById = new Map(normalizedStages.map((stage) => [stage.id, stage.label]));
      const previousStages = stageDefinitionsForProject(current, projectId);
      const previousIdByLabel = new Map(previousStages.map((stage) => [stage.label, stage.id]));
      const shouldSaveMilestones = Array.isArray(milestones);
      const projectStageConfigs = current.projectStageConfigs.some((config) => config.projectId === projectId)
        ? current.projectStageConfigs.map((config) =>
            config.projectId === projectId
              ? { ...config, stages: normalizedStages, ...(shouldSaveMilestones ? { milestones } : {}), updatedAt: new Date().toISOString() }
              : config,
          )
        : [...current.projectStageConfigs, createProjectStageConfig(projectId, normalizedStages, new Date().toISOString(), shouldSaveMilestones ? milestones : [])];
      return {
        ...current,
        projectStageConfigs,
        projects: current.projects.map((project) => {
          if (project.id !== projectId) return project;
          const previousStageId = previousIdByLabel.get(project.phase);
          const phase = previousStageId ? nextLabelById.get(previousStageId) || normalizedStages[0].label : normalizeProjectPhase(project.phase, normalizedStages);
          return { ...project, phase };
        }),
        tasks: current.tasks.map((task) => (task.projectId === projectId ? { ...task, stage: normalizeTaskStage(task.stage, normalizedStages) } : task)),
      };
    });
    notify("项目阶段配置已保存。");
  };

  const saveEmailConfig = (emailConfig: EmailConfig) => {
    setState((current) =>
      current
        ? {
            ...current,
            emailConfig: {
              ...emailConfig,
              lastStatus: emailConfig.lastStatus || "邮箱配置已保存，发送周报时会尝试写入草稿箱。",
              updatedAt: new Date().toISOString(),
            },
          }
        : current,
    );
    notify("邮箱配置已保存。");
  };

  const updateConfigHealth = (configId: string, lastHealth: string) => {
    setState((current) =>
      current
        ? {
            ...current,
            aiModelConfigs: current.aiModelConfigs.map((item) => (item.id === configId ? { ...item, lastHealth } : item)),
          }
        : current,
    );
  };

  const testConfig = async (config: AiModelConfig) => {
    try {
      const reply = await callConfiguredModel(
        config,
        [
          { role: "system", content: "你是模型连通性测试助手。只需用中文返回一句简短确认。" },
          { role: "user", content: "请确认模型连通性正常。" },
        ],
        { requireProjectDataConsent: false, maxTokens: 96, timeoutMs: 60_000 },
      );
      updateConfigHealth(config.id, `连接正常：${new Date().toLocaleString("zh-CN", { hour12: false })}`);
      notify(`连接测试通过：${reply.slice(0, 160)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "连接测试失败";
      updateConfigHealth(config.id, `连接失败：${message.slice(0, 180)}`);
      notify(`连接测试失败：${message}`, "danger");
    }
  };

  const saveWorkflow = (workflow: DeliveryWorkflow) => {
    setState((current) => (current ? upsertWorkflow(current, workflow) : current));
    notify("工作流内容已保存。");
  };

  const resetCurrentWorkflow = () => {
    const project = getProject(state);
    requestConfirm({
      title: "重置 AI 生成内容",
      description: "确认清空当前项目的 SOW 输入、人天评估、硬件评估、WBS 与实施方案草稿？项目执行中心里已经生成的正式任务和交付物不会被删除。",
      confirmText: "确认重置",
      onConfirm: () => {
        setState((current) => {
          if (!current) return current;
          const workflow = getWorkflow(current, project.id);
          const resetWorkflow = emptyWorkflow(project.id);
          return upsertWorkflow(current, {
            ...resetWorkflow,
            projectFlow: {
              ...resetWorkflow.projectFlow,
              generatedTaskIds: workflow.projectFlow.generatedTaskIds,
              generatedDeliverableIds: workflow.projectFlow.generatedDeliverableIds,
            },
          });
        });
        notify("AI 生成步骤内容已重置。", "warning");
      },
    });
  };

  const saveSow = (sow: SowInput, handoffContent?: string) => {
    setState((current) => {
      if (!current) return current;
      const workflow = getWorkflow(current, sow.projectId);
      const sowHandoff = handoffContent !== undefined ? handoffContent.trim() : extractSowHandoffContent(sow.content);
      return upsertWorkflow(current, {
        ...workflow,
        sow,
        handoff: {
          ...workflow.handoff,
          sow: sowHandoff,
        },
        resourceInputs: sowHandoff ? mergeResourceInputsFromSowHandoff(sowHandoff, workflow.resourceInputs) : workflow.resourceInputs,
      });
    });
    notify("SOW 已保存。");
  };

  const standardizeSow = async ({ projectId, fileName, rawContent }: { projectId: string; fileName: string; rawContent: string }) => {
    const trimmed = rawContent.trim();
    console.info("[SOW导入] 进入标准化流程", {
      projectId,
      fileName,
      rawChars: rawContent.length,
      trimmedChars: trimmed.length,
    });
    if (!trimmed) {
      console.warn("[SOW导入] 文件内容为空，终止标准化", { fileName });
      notify("未读取到可用的 SOW 内容。", "warning");
      return;
    }

    const config = defaultModelConfig(state.aiModelConfigs);
    if (!config) {
      console.warn("[SOW导入] 未找到默认AI模型配置，终止标准化");
      notify("请先在设置页的模型设置中创建默认模型配置。", "warning");
      return;
    }

    const project = state.projects.find((item) => item.id === projectId) || getProject(state);
    console.info("[SOW导入] 准备调用SOW标准化", {
      containerProject: project.name,
      containerClient: project.client,
      provider: config.provider,
      model: config.model,
      allowRemoteRequest: config.allowRemoteRequest,
      hasApiKey: Boolean(config.apiKey?.trim()),
    });
    setStandardizingSow(true);
    const runId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    void recordAiGenerationRun({
      id: runId,
      projectId,
      kind: "sow-standardize",
      model: config.model,
      status: "running",
      createdAt,
      inputSnapshot: {
        fileName,
        rawChars: trimmed.length,
        projectName: project.name,
        client: project.client,
      },
    });
    try {
      const result = await normalizeSowWithAi(project, fileName, trimmed, config);
      console.info("[SOW导入] 标准化结果返回，准备写入工作流", {
        model: result.model,
        outputChars: result.content.length,
      });
      setState((current) => {
        if (!current) return current;
        const workflow = getWorkflow(current, projectId);
        const sowHandoff = extractSowHandoffContent(result.content);
        return upsertWorkflow(current, {
          ...workflow,
          sow: {
            projectId,
            content: result.content,
            fileName,
            updatedAt: new Date().toISOString(),
          },
          handoff: {
            ...workflow.handoff,
            sow: sowHandoff,
          },
          resourceInputs: sowHandoff ? mergeResourceInputsFromSowHandoff(sowHandoff, workflow.resourceInputs) : workflow.resourceInputs,
        });
      });
      console.info("[SOW导入] 标准化SOW已保存", {
        projectId,
        fileName,
        model: result.model,
      });
      void recordAiGenerationRun({
        id: runId,
        projectId,
        kind: "sow-standardize",
        model: result.model,
        status: "success",
        createdAt,
        completedAt: new Date().toISOString(),
        inputSnapshot: { fileName, rawChars: trimmed.length },
        outputContent: result.content,
      });
      notify("AI 已解析 SOW，并生成标准化输入源。", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "SOW 标准化失败";
      console.error("[SOW导入] 标准化失败", {
        fileName,
        message,
        error,
      });
      void recordAiGenerationRun({
        id: runId,
        projectId,
        kind: "sow-standardize",
        model: config.model,
        status: "failed",
        createdAt,
        completedAt: new Date().toISOString(),
        inputSnapshot: { fileName, rawChars: trimmed.length },
        errorMessage: message,
      });
      notify(`SOW 标准化失败：${message}`, "danger");
    } finally {
      console.info("[SOW导入] 标准化流程结束", { fileName });
      setStandardizingSow(false);
    }
  };

  const generateWorkflowDraft = async (kind: DeliveryDraftKind, workflowOverride?: DeliveryWorkflow) => {
    if (!state) return;
    const project = getProject(state);
    const workflow = workflowOverride || getWorkflow(state, project.id);
    const config = defaultModelConfig(state.aiModelConfigs);
    const canUseHardwareKernel = kind === "hardware" && canRunHardwareSkillKernel(workflow);
    if (!config && !canUseHardwareKernel) {
      notify("请先在设置页的模型设置中创建默认模型配置。", "warning");
      return;
    }

    console.info("[AI生成] 进入草稿生成流程", {
      kind,
      projectId: project.id,
      projectName: project.name,
      provider: config?.provider || "skill-kernel",
      model: config?.model || "skill-kernel",
      hasSow: Boolean(workflow.sow.content.trim()),
      personDayChars: workflow.personDayAssessment.content.length,
      hardwareChars: workflow.hardwareAssessment.content.length,
      wbsChars: workflow.wbsPlan.content.length,
    });
    if (workflowOverride) {
      setState((current) => (current ? upsertWorkflow(current, workflowOverride) : current));
    }
    setGeneratingWorkflow(kind);
    const runId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    void recordAiGenerationRun({
      id: runId,
      projectId: project.id,
      kind,
      model: config?.model || "skill-kernel",
      status: "running",
      createdAt,
      inputSnapshot: {
        sowChars: workflow.sow.content.length,
        personDayChars: workflow.personDayAssessment.content.length,
        hardwareChars: workflow.hardwareAssessment.content.length,
        wbsChars: workflow.wbsPlan.content.length,
        resourceInputs: workflow.resourceInputs,
      },
    });
    const draftKey = draftKeyFor(kind);
    try {
      let streamedDraft = "";
      let lastDraftFlush = 0;
      const flushWorkflowDraft = (content: string, model = config?.model || "streaming") => {
        if (!content) return;
        const now = Date.now();
        if (now - lastDraftFlush < 120) return;
        lastDraftFlush = now;
        setState((current) => {
          if (!current) return current;
          const currentWorkflow = getWorkflow(current, project.id);
          return upsertWorkflow(current, updateDraft(currentWorkflow, draftKey, content, model));
        });
      };
      const draft = await generateDeliveryDraft(kind, project, workflow, config, {
        onDelta: (_delta, content) => {
          streamedDraft = content;
          flushWorkflowDraft(streamedDraft);
        },
      });
      console.info("[AI生成] 草稿生成完成", {
        kind,
        model: draft.model,
        outputChars: draft.content.length,
      });
      setState((current) => {
        if (!current) return current;
        const currentWorkflow = getWorkflow(current, project.id);
        return upsertWorkflow(current, updateDraft(currentWorkflow, draftKey, draft.content, draft.model));
      });
      void recordAiGenerationRun({
        id: runId,
        projectId: project.id,
        kind,
        model: draft.model,
        status: "success",
        createdAt,
        completedAt: new Date().toISOString(),
        inputSnapshot: {
          sowChars: workflow.sow.content.length,
          resourceInputs: workflow.resourceInputs,
        },
        outputContent: draft.content,
      });
      notify(draft.model.includes("skill-kernel") ? "硬件评估已按技能内核生成，可继续人工修改并保存。" : "AI 草稿已生成，可继续人工修改并保存。");
    } catch (error) {
      const message = error instanceof Error ? error.message : "生成失败";
      console.error("[AI生成] 草稿生成失败", {
        kind,
        message,
        error,
      });
      void recordAiGenerationRun({
        id: runId,
        projectId: project.id,
        kind,
        model: config?.model || "skill-kernel",
        status: "failed",
        createdAt,
        completedAt: new Date().toISOString(),
        inputSnapshot: {
          sowChars: workflow.sow.content.length,
          resourceInputs: workflow.resourceInputs,
        },
        errorMessage: message,
      });
      notify(`AI 草稿生成失败：${message}`, "danger");
    } finally {
      setGeneratingWorkflow("");
    }
  };

  const confirmCurrentProjectFlow = (workflowOverride?: DeliveryWorkflow) => {
    const project = getProject(state);
    const workflow = workflowOverride || getWorkflow(state, project.id);
    if (!workflow.wbsPlan.content.trim()) {
      notify("请先生成并保存 WBS / 实施计划草稿，再确认生成项目执行流。", "warning");
      return;
    }
    const flowSummary = summarizeWbsPlanDraft(workflow.wbsPlan.content);
    if (!flowSummary.taskCount) {
      notify("当前 WBS / 计划草稿没有可识别的计划表行，不能生成项目执行流。请重新生成或补齐标准计划表。", "warning");
      return;
    }
    requestConfirm({
      title: "确认生成项目执行流",
      description:
        `系统将基于当前 WBS / 计划创建 ${flowSummary.taskCount} 个正式任务和 ${flowSummary.deliverableCount} 个交付物。生成后会进入当前项目的「任务跟踪」。若此前已生成过，将替换上一批由 AI 草稿转入的任务和交付物。`,
      confirmText: "生成项目执行流",
      tone: "primary",
      onConfirm: () => {
        setState((current) => {
          if (!current) return current;
          const baseState = workflowOverride ? upsertWorkflow(current, workflowOverride) : current;
          const nextState = confirmProjectFlow(baseState, project.id);
          return {
            ...nextState,
            ui: {
              ...nextState.ui,
              currentProjectId: project.id,
              currentPage: "list",
              search: "",
            },
          };
        });
        notify(`项目执行流已生成：${flowSummary.taskCount} 个任务，${flowSummary.deliverableCount} 个交付物。`);
      },
    });
  };

  const renderPage = () => {
    switch (state.ui.currentPage) {
      case "portal":
        return (
          <PortalPage
            state={state}
            onProject={setProject}
            onAddProject={() => setDialog({ kind: "project" })}
            onImportProject={importData}
            onEditProject={(project) => setDialog({ kind: "project", item: project })}
            onDeleteProject={deleteProject}
            aiService={aiService}
          />
        );
      case "dashboard":
        return <DashboardPage state={state} aiService={aiService} />;
      case "overview":
        return <ProjectOverviewPage state={state} onPage={setPage} onTaskStatus={updateTaskStatus} />;
      case "board":
        return (
          <BoardPage
            state={state}
            onTaskStatus={updateTaskStatus}
            onEditTask={(task) => setDialog({ kind: "task", item: task })}
            onAddSubtask={(parentId) => setDialog({ kind: "task", parentId })}
            onDeleteTask={deleteTask}
          />
        );
      case "list":
        return (
          <ListPage
            state={state}
            onAddTask={() => setDialog({ kind: "task" })}
            onTaskStatus={updateTaskStatus}
            onTaskProgress={updateTaskProgress}
            onEditTask={(task) => setDialog({ kind: "task", item: task })}
            onDeleteTask={deleteTask}
          />
        );
      case "scope":
        return (
          <ScopePage
            state={state}
            onAddScopeItem={() => setDialog({ kind: "scope" })}
            onEditScopeItem={(scopeItem) => setDialog({ kind: "scope", item: scopeItem })}
            onScopeProgress={updateScopeProgress}
            onDeleteScopeItem={deleteScopeItem}
          />
        );
      case "gantt":
        return <GanttPage state={state} onTaskStatus={updateTaskStatus} onTaskProgress={updateTaskProgress} />;
      case "deliverables":
        return (
          <DeliverablesPage
            state={state}
            onAddDeliverable={() => setDialog({ kind: "deliverable" })}
            onEditDeliverable={(deliverable) => setDialog({ kind: "deliverable", item: deliverable })}
            onSaveDeliverable={updateDeliverable}
            onSaveDeliverableStoragePath={saveDeliverableStoragePath}
            onDeleteDeliverable={deleteDeliverable}
          />
        );
      case "risks":
        return (
          <RisksPage
            state={state}
            onAddRiskIssue={(riskKind) => setDialog({ kind: "risk", riskKind })}
            onEditRiskIssue={(riskIssue) => setDialog({ kind: "risk", item: riskIssue })}
            onDeleteRiskIssue={deleteRiskIssue}
          />
        );
      case "weekly":
        return <WeeklyPage state={state} aiService={aiService} onPage={setPage} onSave={saveWeekly} onSavePreference={saveWeeklyPreference} />;
      case "weeklyHistory":
        return <WeeklyHistoryPage state={state} onPage={setPage} onDeleteReport={deleteWeeklyReport} />;
      case "sow":
        return (
          <SowPage
            state={state}
            onSaveSow={saveSow}
            onStandardizeSow={standardizeSow}
            standardizing={standardizingSow}
            onPage={setPage}
            onResetWorkflow={resetCurrentWorkflow}
          />
        );
      case "resourceEval":
        return (
          <ResourceAssessmentPage
            state={state}
            onGeneratePersonDay={(workflow) => generateWorkflowDraft("personDay", workflow)}
            onSaveDraft={saveWorkflow}
            generatingPersonDay={generatingWorkflow === "personDay"}
            onPage={setPage}
            onResetWorkflow={resetCurrentWorkflow}
          />
        );
      case "hardwareEval":
        return (
          <HardwareAssessmentPage
            state={state}
            onGenerateHardware={(workflow) => generateWorkflowDraft("hardware", workflow)}
            onSaveDraft={saveWorkflow}
            generatingHardware={generatingWorkflow === "hardware"}
            onPage={setPage}
            onResetWorkflow={resetCurrentWorkflow}
          />
        );
      case "wbsPlan":
        return (
          <WbsPlanPage
            state={state}
            onGenerate={() => generateWorkflowDraft("wbs")}
            onSaveDraft={saveWorkflow}
            onConfirmFlow={confirmCurrentProjectFlow}
            generating={generatingWorkflow === "wbs"}
            onPage={setPage}
            onResetWorkflow={resetCurrentWorkflow}
          />
        );
      case "implementationPlan":
        return (
          <ImplementationPlanPage
            state={state}
            onGenerate={() => generateWorkflowDraft("implementation")}
            onSaveDraft={saveWorkflow}
            generating={generatingWorkflow === "implementation"}
            onPage={setPage}
            onResetWorkflow={resetCurrentWorkflow}
          />
        );
      case "assistant":
        return (
          <AssistantPage
            state={state}
            aiService={aiService}
            onAsk={askAi}
            streamingMessages={streamingAssistantMessages}
            assistantScope={normalizeAssistantScope(state.ui.assistantScope)}
            onAssistantScopeChange={setAssistantScope}
            onClearHistory={clearAssistantHistory}
          />
        );
      case "settings":
      case "modelSettings":
      case "stageSettings":
      case "emailSettings":
        return <SettingsPage state={state} onSaveConfig={saveConfig} onTestConfig={testConfig} onSaveStages={saveTaskStages} onSaveEmailConfig={saveEmailConfig} />;
      default:
        return (
          <PortalPage
            state={state}
            onProject={setProject}
            onAddProject={() => setDialog({ kind: "project" })}
            onImportProject={importData}
            onEditProject={(project) => setDialog({ kind: "project", item: project })}
            onDeleteProject={deleteProject}
            aiService={aiService}
          />
        );
    }
  };

  return (
    <>
      <AppShell
        state={state}
        onPage={setPage}
        onProject={setProject}
        onSearch={setSearch}
        onExport={exportData}
        onQuickAdd={quickAdd}
        storageLabel={repository.storageLabel}
      >
        {renderPage()}
      </AppShell>
      {notice ? (
        <div className={`toast ${notice.tone}`} role="status">
          <span>{notice.message}</span>
          <button onClick={() => setNotice(null)} aria-label="关闭通知">
            ×
          </button>
        </div>
      ) : null}
      {dialog?.kind === "project" ? <ProjectDialog state={state} item={dialog.item} onSave={saveProject} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "task" ? (
        <TaskDialog state={state} item={dialog.item} parentId={dialog.parentId} onSave={saveTask} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "scope" ? (
        <ScopeItemDialog state={state} item={dialog.item} onSave={saveScopeItem} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "deliverable" ? (
        <DeliverableDialog state={state} item={dialog.item} onSave={saveDeliverable} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "risk" ? (
        <RiskIssueDialog
          state={state}
          item={dialog.item}
          riskKind={dialog.riskKind}
          onSave={saveRiskIssue}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "confirm" ? (
        <ConfirmDialog
          title={dialog.title}
          description={dialog.description}
          confirmText={dialog.confirmText}
          tone={dialog.tone}
          onConfirm={dialog.onConfirm}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}
