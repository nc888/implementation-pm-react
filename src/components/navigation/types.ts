import type { LucideIcon } from "lucide-react";
import type { PageKey } from "../../types";

export type NavItem = [PageKey, string, LucideIcon];
export type PrimarySectionKey = "workspace" | "projectExecution" | "aiGeneration" | "aiConfig";

export interface PrimarySection {
  key: PrimarySectionKey;
  label: string;
  hint: string;
  defaultPage: PageKey;
  icon: LucideIcon;
  pages: NavItem[];
}
