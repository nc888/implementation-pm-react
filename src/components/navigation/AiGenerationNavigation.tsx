import { ClipboardList, Cpu, FileText, HardDrive, Workflow } from "lucide-react";
import type { PageKey } from "../../types";
import { renderNavItems } from "./shared";
import type { NavItem, PrimarySection } from "./types";

const aiGenerationNav: NavItem[] = [
  ["sow", "SOW输入", ClipboardList],
  ["resourceEval", "人天评估", Cpu],
  ["hardwareEval", "硬件评估", HardDrive],
  ["wbsPlan", "WBS/计划生成", Workflow],
  ["implementationPlan", "实施方案生成", FileText],
];

export const aiGenerationSection: PrimarySection = {
  key: "aiGeneration",
  label: "AI生成中心",
  hint: "SOW到交付方案生成",
  defaultPage: "sow",
  icon: Cpu,
  pages: aiGenerationNav,
};

export function AiGenerationSidebarBlock({
  currentPage,
  onPage,
}: {
  currentPage: PageKey;
  onPage: (page: PageKey) => void;
}) {
  return (
    <div className="nav-section">
      <p className="nav-title">生成流程</p>
      {renderNavItems(aiGenerationSection.pages, currentPage, onPage, true)}
    </div>
  );
}
