import { Mail, SlidersHorizontal, Wifi } from "lucide-react";
import type { PageKey } from "../../types";
import { renderNavItems } from "./shared";
import type { NavItem, PrimarySection } from "./types";

const systemNav: NavItem[] = [
  ["modelSettings", "模型设置", Wifi],
  ["stageSettings", "阶段配置", SlidersHorizontal],
  ["emailSettings", "邮箱配置", Mail],
];

export const aiConfigSection: PrimarySection = {
  key: "aiConfig",
  label: "设置",
  hint: "模型、阶段与邮箱",
  defaultPage: "modelSettings",
  icon: Wifi,
  pages: systemNav,
};

export function AiConfigSidebarBlock({
  currentPage,
  onPage,
}: {
  currentPage: PageKey;
  onPage: (page: PageKey) => void;
}) {
  return (
    <div className="nav-section">
      <p className="nav-title">配置项</p>
      {renderNavItems(aiConfigSection.pages, currentPage, onPage)}
    </div>
  );
}
