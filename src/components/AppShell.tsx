import { useEffect, useRef, useState } from "react";
import { Bot, Database, Download, Palette, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings } from "lucide-react";
import type { AppState, PageKey } from "../types";
import type { ProjectBackupScope } from "../services/projectImport";
import { getProject } from "../services/contextBuilder";
import { LevelTwoNavigation, getPrimarySection, primarySections, type PrimarySection } from "./navigation";

type VisualTheme = "default" | "deep-blue" | "soft-green";

const visualThemeStorageKey = "implementation-pm-visual-theme";

const visualThemeLabels: Record<VisualTheme, string> = {
  default: "默认主题",
  "deep-blue": "深蓝背景",
  "soft-green": "绿色背景",
};

const visualThemeCycle: VisualTheme[] = ["default", "deep-blue", "soft-green"];

const titles: Record<PageKey, [string, string]> = {
  portal: ["项目入口", "先选项目，再进入单项目的看板、计划、风险、交付物和周报。"],
  dashboard: ["项目总览", "项目经理驾驶舱：快速判断今天优先处理哪个项目。"],
  overview: ["项目概览", "从任务、交付物、风险和范围中自动汇总当前项目整体状态。"],
  board: ["实施看板", "按任务状态推进执行流转，并同步任务列表、WBS 和甘特视图。"],
  list: ["任务跟踪", "主任务和子任务共用同一套结构化数据，支持层级展开收起。"],
  scope: ["范围需求", "本期SOW范围、变更增加范围和不在本期范围要明确分开。"],
  gantt: ["甘特计划", "基于任务日期和层级自动生成轻量排期视图。"],
  deliverables: ["交付物管理", "附件只是形式，核心是交付物验收状态。"],
  risks: ["风险问题", "风险是可能发生，问题是已经发生。"],
  weekly: ["周报管理", "从任务、范围、人天和风险问题自动汇总。"],
  weeklyHistory: ["历史周报", "按日期查看项目周报记录和 Markdown 归档状态。"],
  sow: ["SOW输入", "导入或粘贴 SOW，作为人天评估、硬件评估、WBS 计划和实施方案生成的统一输入。"],
  resourceEval: ["人天评估", "人天评估结果可人工修订，并继续传递到后续 WBS 和实施计划。"],
  hardwareEval: ["硬件资源评估", "按数据规模、留存周期和能力范围生成硬件资源测算草稿。"],
  wbsPlan: ["WBS与计划生成", "承接评估结果生成 WBS、计划表、甘特图和里程碑草稿。"],
  implementationPlan: ["实施方案生成", "承接 SOW、评估和 WBS 计划生成可编辑实施方案草稿。"],
  assistant: ["项目智囊", "基于当前项目快照对话、解释评分、生成周报草稿。"],
  settings: ["设置", "统一维护模型设置、阶段配置和邮箱配置。"],
  modelSettings: ["模型设置", "维护 AI 模型供应商、接口地址、模型名称和密钥。"],
  stageSettings: ["阶段配置", "维护项目阶段字典，影响任务、看板、周报和统计口径。"],
  emailSettings: ["邮箱配置", "维护企业邮箱 SMTP/IMAP 参数，用于保存周报邮箱草稿。"],
};

function SectionIntro({ section }: { section: PrimarySection }) {
  const Icon = section.icon;
  return (
    <div className="project-chip">
      <span className="project-mark">
        <Icon aria-hidden="true" />
      </span>
      <div>
        <strong>{section.label}</strong>
        <p className="muted">{section.hint}</p>
      </div>
    </div>
  );
}

export function AppShell({
  state,
  children,
  onPage,
  onProject,
  onSearch,
  onExport,
  onQuickAdd,
  storageLabel,
}: {
  state: AppState;
  children: React.ReactNode;
  onPage: (page: PageKey) => void;
  onProject: (projectId: string) => void;
  onSearch: (search: string) => void;
  onExport: (scope: ProjectBackupScope) => void;
  onQuickAdd: () => void;
  storageLabel: string;
}) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarManualOpen, setSidebarManualOpen] = useState(false);
  const themeSwitchTimerRef = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [visualTheme, setVisualTheme] = useState<VisualTheme>(() => {
    try {
      const savedTheme = window.localStorage.getItem(visualThemeStorageKey);
      return savedTheme === "soft-green" || savedTheme === "deep-blue" || savedTheme === "default" ? savedTheme : "default";
    } catch {
      return "default";
    }
  });
  const project = getProject(state);
  const [title, subtitle] = titles[state.ui.currentPage];
  const activeSection = getPrimarySection(state.ui.currentPage);
  const showProjectExecutionActions = activeSection.key === "projectExecution";
  const showQuickAddTask = state.ui.currentPage === "board" || state.ui.currentPage === "list" || state.ui.currentPage === "gantt";
  const isSettingsPage = state.ui.currentPage === "settings" || state.ui.currentPage === "modelSettings" || state.ui.currentPage === "stageSettings" || state.ui.currentPage === "emailSettings";
  const effectiveSidebarCollapsed = isSettingsPage ? false : sidebarCollapsed;
  const hideSidebar = state.ui.currentPage === "assistant" || activeSection.key === "aiGeneration";
  const hideTopbar = state.ui.currentPage === "assistant" || activeSection.key === "aiGeneration";
  const displayTitle = state.ui.currentPage === "overview" ? `${title}：${project.name}` : title;
  const pageKicker =
    state.ui.currentPage === "assistant"
      ? `项目智囊 / ${project.name}`
      : activeSection.key === "workspace"
      ? "Workspace"
      : activeSection.key === "projectExecution"
        ? `${activeSection.label} / ${project.client}`
        : activeSection.key === "aiGeneration"
        ? activeSection.label
        : `${activeSection.label} / ${project.name}`;
  const logoSrc = `${import.meta.env.BASE_URL}logo.svg`;
  const nextVisualTheme = visualThemeCycle[(visualThemeCycle.indexOf(visualTheme) + 1) % visualThemeCycle.length];

  useEffect(() => {
    setSidebarCollapsed(false);
    setSidebarManualOpen(false);
  }, [activeSection.key, state.ui.currentPage]);

  useEffect(() => {
    return () => {
      if (themeSwitchTimerRef.current !== null) {
        window.clearTimeout(themeSwitchTimerRef.current);
      }
      document.documentElement.classList.remove("theme-switching");
    };
  }, []);

  useEffect(() => {
    if (visualTheme === "default") {
      delete document.documentElement.dataset.visualTheme;
    } else {
      document.documentElement.dataset.visualTheme = visualTheme;
    }

    const persistTimer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(visualThemeStorageKey, visualTheme);
      } catch {
        // localStorage can be unavailable in embedded webviews; the visual switch still works for the session.
      }
    }, 220);
    return () => window.clearTimeout(persistTimer);
  }, [visualTheme]);

  useEffect(() => {
    if (isSettingsPage) return;
    if (sidebarCollapsed || sidebarManualOpen) return;
    const timer = window.setTimeout(() => setSidebarCollapsed(true), 5000);
    return () => window.clearTimeout(timer);
  }, [isSettingsPage, sidebarCollapsed, sidebarManualOpen, activeSection.key, state.ui.currentPage]);

  useEffect(() => {
    if (!showProjectExecutionActions && state.ui.search) onSearch("");
  }, [showProjectExecutionActions, state.ui.search, onSearch]);

  useEffect(() => {
    if (!showProjectExecutionActions) return;
    const isTextEditingTarget = (target: EventTarget | null) =>
      target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (event.key === "/" && !isTextEditingTarget(event.target)) {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showProjectExecutionActions]);

  const switchVisualTheme = () => {
    if (themeSwitchTimerRef.current !== null) {
      window.clearTimeout(themeSwitchTimerRef.current);
    }
    document.documentElement.classList.add("theme-switching");
    themeSwitchTimerRef.current = window.setTimeout(() => {
      document.documentElement.classList.remove("theme-switching");
      themeSwitchTimerRef.current = null;
    }, 180);
    setVisualTheme(nextVisualTheme);
  };

  return (
    <div className={`app-shell ${effectiveSidebarCollapsed ? "sidebar-collapsed" : ""} ${hideSidebar ? "no-sidebar" : ""}`}>
      <header className="primary-nav">
        <div className="nav-brand" aria-label="实施项目管家">
          <img className="rail-logo-mark" src={logoSrc} alt="" aria-hidden="true" />
          <div>
            <strong>实施项目管家</strong>
            <small>Implementation PM</small>
          </div>
        </div>
        <nav className="primary-tabs" aria-label="一级导航">
          {primarySections.map((section) => {
            const Icon = section.icon;
            return (
              <button
                key={section.key}
                className={`primary-tab ${activeSection.key === section.key ? "active" : ""}`}
                onClick={() => onPage(section.defaultPage)}
                title={section.label}
              >
                <Icon aria-hidden="true" />
                <span>{section.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="primary-actions">
          <button
            className={`theme-toggle-button ${visualTheme}`}
            onClick={switchVisualTheme}
            title={`切换到${visualThemeLabels[nextVisualTheme]}`}
            aria-label={`切换到${visualThemeLabels[nextVisualTheme]}`}
          >
            <Palette aria-hidden="true" />
            <span className="theme-toggle-swatch" aria-hidden="true" />
          </button>
          <span className="storage-indicator" title={`Data storage: ${storageLabel}`}>
            <Database aria-hidden="true" />
            <span>{storageLabel}</span>
          </span>
          <button
            className={`nav-action-button ai ${state.ui.currentPage === "assistant" ? "active" : ""}`}
            onClick={() => onPage("assistant")}
            title="项目智囊"
            aria-label="项目智囊"
          >
            <span className="nav-action-glyph">
              <Bot aria-hidden="true" />
            </span>
            <span className="nav-action-node" aria-hidden="true" />
          </button>
          <button
            className={`nav-action-button settings ${isSettingsPage ? "active" : ""}`}
            onClick={() => onPage("modelSettings")}
            title="设置"
            aria-label="设置"
          >
            <span className="nav-action-glyph">
              <Settings aria-hidden="true" />
            </span>
            <span className="nav-action-index" aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="workspace-shell">
        {hideSidebar ? null : (
          <aside className="sidebar">
            {isSettingsPage ? null : (
              <button
                className="sidebar-toggle"
                onClick={() => {
                  if (sidebarCollapsed) {
                    setSidebarCollapsed(false);
                    setSidebarManualOpen(true);
                  } else {
                    setSidebarCollapsed(true);
                    setSidebarManualOpen(false);
                  }
                }}
                aria-label={sidebarCollapsed ? "展开二级导航" : "收起二级导航"}
                title={sidebarCollapsed ? "展开二级导航" : "收起二级导航"}
              >
                {sidebarCollapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
              </button>
            )}
            <div className="sidebar-content">
              <SectionIntro section={activeSection} />
              <LevelTwoNavigation
                section={activeSection}
                state={state}
                project={project}
                currentPage={state.ui.currentPage}
                onPage={onPage}
                onProject={onProject}
              />
            </div>
          </aside>
        )}
        <main className="main">
          {hideTopbar ? null : (
            <header className="topbar">
              <div>
                <span className="page-kicker">{pageKicker}</span>
                <h2>{displayTitle}</h2>
                {activeSection.key === "aiGeneration" ? null : <p>{subtitle}</p>}
              </div>
              {showProjectExecutionActions ? (
                <div className="top-actions">
                  <label className="search-field">
                    <Search aria-hidden="true" />
                    <input
                      ref={searchInputRef}
                      value={state.ui.search}
                      onChange={(event) => onSearch(event.target.value)}
                      placeholder="搜索 / 或 Ctrl K"
                      aria-label="搜索项目执行数据，快捷键斜杠或 Ctrl K"
                    />
                  </label>
                  <button className="button ghost" onClick={() => onExport("project")}>
                    <Download aria-hidden="true" />
                    导出当前项目
                  </button>
                  <button className="button ghost" onClick={() => onExport("all")}>
                    <Download aria-hidden="true" />
                    导出全部
                  </button>
                  {showQuickAddTask ? (
                    <button className="button primary" onClick={onQuickAdd}>
                      <Plus aria-hidden="true" />
                      新建任务
                    </button>
                  ) : null}
                </div>
              ) : null}
            </header>
          )}
          <div className="content">{children}</div>
        </main>
      </div>
    </div>
  );
}
