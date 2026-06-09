import { FolderKanban, LayoutDashboard } from "lucide-react";
import type { PageKey } from "../../types";
import { renderNavItems } from "./shared";
import type { NavItem, PrimarySection } from "./types";

const workspaceNav: NavItem[] = [
  ["portal", "项目入口", FolderKanban],
  ["dashboard", "项目总览", LayoutDashboard],
];

export const projectWorkspaceSection: PrimarySection = {
  key: "workspace",
  label: "项目工作台",
  hint: "项目入口与组合总览",
  defaultPage: "portal",
  icon: LayoutDashboard,
  pages: workspaceNav,
};

export function WorkspaceSidebarBlock({
  currentPage,
  onPage,
}: {
  currentPage: PageKey;
  onPage: (page: PageKey) => void;
}) {
  return (
    <div className="nav-section">
      <p className="nav-title">工作台页面</p>
      {renderNavItems(projectWorkspaceSection.pages, currentPage, onPage)}
    </div>
  );
}
