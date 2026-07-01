import { useState } from "react";
import {
  BriefcaseBusiness,
  CalendarRange,
  Check,
  ChevronDown,
  ClipboardCheck,
  ClipboardList,
  FileText,
  FolderKanban,
  History,
  KanbanSquare,
  ListChecks,
  ShieldAlert,
} from "lucide-react";
import type { AppState, PageKey, Project } from "../../types";
import { calcProjectMetrics } from "../../services/contextBuilder";
import { activeProjects, isArchivedProject } from "../../services/projectStatus";
import { renderNavItems } from "./shared";
import type { NavItem, PrimarySection } from "./types";

const executionNav: NavItem[] = [
  ["overview", "项目概览", BriefcaseBusiness],
  ["board", "实施看板", KanbanSquare],
  ["gantt", "WBS / 计划", CalendarRange],
  ["list", "任务跟踪", ListChecks],
  ["scope", "范围需求", ClipboardList],
  ["deliverables", "文档交付物", FileText],
  ["risks", "风险问题", ShieldAlert],
  ["weekly", "周报", ClipboardCheck],
  ["weeklyHistory", "历史周报", History],
];

const healthClass = (health: Project["health"]) => {
  if (health === "健康") return "success";
  if (health === "延期") return "danger";
  return "warning";
};

export const projectSwitchSection: PrimarySection = {
  key: "projectExecution",
  label: "项目执行中心",
  hint: "选择项目并进入执行管理",
  defaultPage: "overview",
  icon: FolderKanban,
  pages: executionNav,
};

export function ProjectSwitchSidebarBlock({
  state,
  project,
  currentPage,
  onPage,
  onProject,
}: {
  state: AppState;
  project: Project;
  currentPage: PageKey;
  onPage: (page: PageKey) => void;
  onProject: (projectId: string) => void;
}) {
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const currentMetrics = calcProjectMetrics(state, project);
  const selectableProjects = activeProjects(state);
  const archived = isArchivedProject(project);

  return (
    <>
      <div className="nav-section">
        <p className="nav-title">当前项目</p>
        <div
          className="project-select"
          onKeyDown={(event) => {
            if (event.key === "Escape") setProjectMenuOpen(false);
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setProjectMenuOpen(false);
          }}
        >
          <button
            className="project-select-trigger"
            onClick={() => setProjectMenuOpen((value) => !value)}
            aria-haspopup="listbox"
            aria-expanded={projectMenuOpen}
          >
            <span className={`project-switch-health ${healthClass(project.health)}`} />
            <span className="project-select-copy">
              <strong>{project.name}</strong>
              <small>
                {project.client} · {project.phase} · {currentMetrics.completionRate}%{archived ? " · 已归档" : ""}
              </small>
            </span>
            <ChevronDown aria-hidden="true" />
          </button>
          {projectMenuOpen ? (
            <div className="project-select-menu" role="listbox" aria-label="选择项目">
              {selectableProjects.map((item) => {
                const metrics = calcProjectMetrics(state, item);
                const selected = item.id === project.id;
                return (
                  <button
                    key={item.id}
                    className={`project-select-option ${selected ? "active" : ""}`}
                    onClick={() => {
                      onProject(item.id);
                      setProjectMenuOpen(false);
                    }}
                    role="option"
                    aria-selected={selected}
                  >
                    <span className={`project-switch-health ${healthClass(item.health)}`} />
                    <span className="project-select-copy">
                      <strong>{item.name}</strong>
                      <small>
                        {item.client} · {item.phase} · {metrics.completionRate}%
                      </small>
                    </span>
                    {selected ? <Check aria-hidden="true" /> : null}
                  </button>
                );
              })}
              {!selectableProjects.length ? <div className="project-select-empty">暂无在管项目</div> : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="nav-section">
        <p className="nav-title">项目执行页面</p>
        {renderNavItems(projectSwitchSection.pages, currentPage, onPage)}
      </div>
    </>
  );
}
