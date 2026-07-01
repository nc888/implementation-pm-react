import * as XLSX from "xlsx";
import { useEffect, useRef, useState } from "react";
import type { ComponentType, MouseEvent, ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  Cpu,
  Database,
  FileCheck2,
  FileText,
  HardDrive,
  Info,
  ListChecks,
  LoaderCircle,
  Maximize2,
  Minimize2,
  RotateCcw,
  Save,
  Sparkles,
  Table2,
  Upload,
  Workflow,
} from "lucide-react";
import type { AppState, DeliveryWorkflow, PageKey, ResourceAssessmentInputs, SowInput } from "../types";
import {
  extractSowHandoffContent as extractWorkflowSowHandoffContent,
  getAiGenerationWorkflow,
  replaceSowHandoffContent as replaceWorkflowSowHandoffContent,
} from "../services/deliveryWorkflowService";
import { Badge, Button, Card } from "../components/ui";
import { RichMessage } from "./page-shared";

function cleanExcelText(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function isMeaningfulCell(value: unknown) {
  return cleanExcelText(value).length > 0;
}

function cellText(cell: XLSX.CellObject | undefined) {
  if (!cell) return "";
  return cleanExcelText(cell.w ?? cell.v ?? "");
}

function excelColumnName(columnIndex: number) {
  let index = columnIndex;
  let name = "";
  while (index >= 0) {
    name = String.fromCharCode((index % 26) + 65) + name;
    index = Math.floor(index / 26) - 1;
  }
  return name;
}

function excelAddress(rowIndex: number, columnIndex: number) {
  return `${excelColumnName(columnIndex)}${rowIndex + 1}`;
}

function isLikelyFieldLabel(value: string) {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized) return false;
  if (/[：:]$/.test(normalized)) return true;
  return [
    "客户名称",
    "项目名称",
    "姓名",
    "联系方式",
    "职位",
    "项目背景",
    "市场调研情况",
    "合同签订情况",
    "代理商全称",
    "实施建议",
    "客户关注点",
    "客户资料",
    "预计入场时间",
    "License",
    "项目目标",
  ].some((label) => normalized === label || normalized.endsWith(label));
}

function limitedExcelLines(lines: string[], maxLines: number, label: string) {
  if (lines.length <= maxLines) return lines.join("\n");
  return [...lines.slice(0, maxLines), `...（${label} 已截断：共 ${lines.length} 行，仅发送前 ${maxLines} 行以提升AI解析速度）`].join("\n");
}

function isCountLike(value: string) {
  return /^\d+(?:\.\d+)?\+?$/.test(value.trim());
}

function sourceCountCell(cells: Array<{ address: string; value: string }>, sequenceIndex: number) {
  const columnNCell = cells.find((cell) => cell.address.replace(/\d+$/, "") === "N");
  if (columnNCell) return isCountLike(columnNCell.value) ? columnNCell : undefined;
  return cells.find((cell, index) => index > sequenceIndex && isCountLike(cell.value));
}

function sheetToSowText(sheetName: string, sheet: XLSX.WorkSheet) {
  const rangeRef = sheet["!ref"];
  if (!rangeRef) return `# Sheet: ${sheetName}\n未读取到有效单元格`;

  const range = XLSX.utils.decode_range(rangeRef);
  const rowLines: string[] = [];
  const fieldLines: string[] = [];
  const tableLines: string[] = [];
  const dataSourceRows: Array<{ row: number; category: string; source: string; count: string; note: string }> = [];

  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    const cells: Array<{ address: string; value: string; columnIndex: number }> = [];
    for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
      const address = excelAddress(rowIndex, columnIndex);
      const value = cellText(sheet[address]);
      if (isMeaningfulCell(value)) cells.push({ address, value, columnIndex });
    }
    if (!cells.length) continue;

    rowLines.push(`R${rowIndex + 1}: ${cells.map((cell) => `${cell.address}=${cell.value}`).join(" | ")}`);
    tableLines.push(cells.map((cell) => cell.value).join("\t"));

    const sequenceIndex = cells.findIndex((cell) => /^\d{1,3}$/.test(cell.value));
    const countCell = sequenceIndex >= 0 ? sourceCountCell(cells, sequenceIndex) : undefined;
    const sequenceNumber = sequenceIndex >= 0 ? Number(cells[sequenceIndex].value) : 0;
    if (sequenceIndex >= 0 && Number.isFinite(sequenceNumber) && sequenceNumber >= 1 && sequenceNumber <= 300 && countCell && rowIndex + 1 >= 35) {
      const values = cells.slice(sequenceIndex + 1).map((cell) => cell.value);
      const knownCategories = ["操作系统", "中间件", "数据库", "交换机", "防火墙", "负载均衡", "堡垒机", "业务系统", "青藤云", "zabbix"];
      const category = values.find((value) => knownCategories.some((item) => value.includes(item))) || "其他";
      const note = cells[cells.length - 1]?.value || "";
      const sourceCandidates = values
        .filter((value) => value !== category && value !== note)
        .filter((value) => !isCountLike(value) && !/^\d{1,3}$/.test(value))
        .filter((value, index, array) => array.indexOf(value) === index);
      const source = sourceCandidates[sourceCandidates.length - 1] || category;
      dataSourceRows.push({ row: rowIndex + 1, category, source, count: countCell.value, note });
    }

    for (let index = 0; index < cells.length - 1; index += 1) {
      const current = cells[index];
      const next = cells[index + 1];
      if (isLikelyFieldLabel(current.value) && !isLikelyFieldLabel(next.value)) {
        fieldLines.push(`${current.value.replace(/[：:]$/, "")}：${next.value}（${current.address}->${next.address}）`);
      }
    }
  }

  const sourceTotals = dataSourceRows.reduce<Record<string, { count: number; items: number }>>((totals, item) => {
    const current = totals[item.category] || { count: 0, items: 0 };
    const count = Number(item.count.match(/\d+(?:\.\d+)?/)?.[0] || 0);
    totals[item.category] = { count: current.count + count, items: current.items + 1 };
    return totals;
  }, {});
  const sourceSummaryLines = Object.entries(sourceTotals)
    .sort(([, a], [, b]) => b.count - a.count)
    .map(([category, summary]) => `${category}\t${summary.items}项\t${summary.count}`);
  const sourceDetailLines = dataSourceRows.map((item) => `R${item.row}\t${item.category}\t${item.source}\t${item.count}\t${item.note}`);

  const parts = [
    `# Sheet: ${sheetName}`,
    "## 关键字段邻近值",
    fieldLines.length ? Array.from(new Set(fieldLines)).join("\n") : "未识别到行内键值对",
    "## 数据接入分类汇总（本地抽取）",
    sourceSummaryLines.length ? ["类别\t明细项\t数量合计", ...sourceSummaryLines].join("\n") : "未识别到数据接入明细",
    "## 数据接入明细（本地抽取）",
    sourceDetailLines.length ? ["行号\t类别\t日志源/设备类型\t设备数量\t说明", ...sourceDetailLines].join("\n") : "未识别到数据接入明细",
    "## 非空单元格坐标",
    rowLines.join("\n"),
    "## 表格行文本（预览）",
    limitedExcelLines(tableLines, 260, "表格行文本"),
  ];

  return parts.join("\n");
}

async function readSowFile(file: File) {
  const lowerName = file.name.toLowerCase();
  console.info("[SOW导入] 开始读取文件", {
    name: file.name,
    size: file.size,
    type: file.type || "unknown",
  });
  if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls") || lowerName.endsWith(".csv")) {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
    console.info("[SOW导入] Excel文件已读取", {
      name: file.name,
      sheets: workbook.SheetNames,
    });
    const text = workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      return sheetToSowText(sheetName, sheet);
    }).join("\n\n");
    console.info("[SOW导入] Excel转文本完成", {
      name: file.name,
      chars: text.length,
    });
    return text;
  }
  const text = await file.text();
  console.info("[SOW导入] 文本文件读取完成", {
    name: file.name,
    chars: text.length,
  });
  return text;
}

type WorkflowStepKey = "sow" | "personDay" | "hardware" | "wbs" | "plan";
type WorkflowIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

const workflowStepItems: Array<{
  key: WorkflowStepKey;
  label: string;
  detail: string;
  tooltip: string;
  page: PageKey;
  icon: WorkflowIcon;
}> = [
  {
    key: "sow",
    label: "SOW输入",
    detail: "统一输入源",
    tooltip: "导入文件后先交给 AI 解析，生成描述清晰、格式稳定的 Markdown 输入源；确认后再进入下一步。",
    page: "sow",
    icon: FileText,
  },
  {
    key: "personDay",
    label: "人天评估",
    detail: "工作量测算",
    tooltip: "调用 project-eval，输出基础服务小计、三项加成门禁、传统估算、PERT 三点估算，并传递给 WBS / 计划。",
    page: "resourceEval",
    icon: Cpu,
  },
  {
    key: "hardware",
    label: "硬件评估",
    detail: "资源测算",
    tooltip: "调用 rizhiyi-hardware-assessment，输出存储容量、Kafka 缓存、三档方案、Flink 补充和 N-1 校验。",
    page: "hardwareEval",
    icon: HardDrive,
  },
  {
    key: "wbs",
    label: "WBS与计划",
    detail: "任务和排期",
    tooltip: "承接人天评估和硬件资源评估，生成 WBS、详细计划表、文本甘特图和里程碑草稿。",
    page: "wbsPlan",
    icon: Workflow,
  },
  {
    key: "plan",
    label: "实施方案",
    detail: "10章草稿",
    tooltip: "承接 SOW、人天评估、硬件资源评估与 WBS / 计划，生成 10 章实施方案草稿。",
    page: "implementationPlan",
    icon: FileCheck2,
  },
];

function hasContent(value: string) {
  return value.trim().length > 0;
}

function normalizeResourceInputs(inputs?: Partial<ResourceAssessmentInputs>): ResourceAssessmentInputs {
  return {
    hasFixedPersonDays: Boolean(inputs?.hasFixedPersonDays),
    fixedPersonDays: inputs?.fixedPersonDays || "",
    analysisAppCount: inputs?.analysisAppCount || "",
    analysisBusinessSystemCount: inputs?.analysisBusinessSystemCount || "",
    agentCount: inputs?.agentCount || "",
    syslogCount: inputs?.syslogCount || "",
    dailyDataVolume: inputs?.dailyDataVolume || "",
    dailyDataUnit: inputs?.dailyDataUnit || "GB",
    peakFactor: inputs?.peakFactor || "1",
    singleNodeUsableTb: inputs?.singleNodeUsableTb || "",
    singleNodeCapacityUnit: inputs?.singleNodeCapacityUnit || "TB",
    nodeCount: inputs?.nodeCount || "",
    retentionDays: inputs?.retentionDays || "180",
    needsFlink: Boolean(inputs?.needsFlink),
    includesSiem: Boolean(inputs?.includesSiem),
    includesUeba: Boolean(inputs?.includesUeba),
    involvesDataMigration: Boolean(inputs?.involvesDataMigration),
  };
}

function draftMeta(draft: DeliveryWorkflow["personDayAssessment"]) {
  if (!hasContent(draft.content)) return "尚未生成";
  if (draft.status === "edited") return "已人工修改";
  return "AI草稿";
}

function isWorkflowStepReady(workflow: DeliveryWorkflow, step: WorkflowStepKey) {
  if (step === "sow") return hasContent(workflow.sow.content);
  if (step === "personDay") return hasContent(workflow.personDayAssessment.content);
  if (step === "hardware") return hasContent(workflow.hardwareAssessment.content);
  if (step === "wbs") return hasContent(workflow.wbsPlan.content);
  return hasContent(workflow.implementationPlan.content);
}

function WorkflowStepBar({
  active,
  workflow,
  onPage,
  onResetWorkflow,
}: {
  active: WorkflowStepKey;
  workflow: DeliveryWorkflow;
  onPage: (page: PageKey) => void;
  onResetWorkflow: () => void;
}) {
  return (
    <div className="workflow-step-shell">
      <nav className="workflow-steps" aria-label="AI生成步骤">
        {workflowStepItems.map((step) => {
          const stepState = active === step.key ? "active" : isWorkflowStepReady(workflow, step.key) ? "complete" : "pending";
          const Icon = step.icon;
          return (
            <button
              key={step.key}
              className={`workflow-step ${stepState}`}
              onClick={() => onPage(step.page)}
              aria-current={active === step.key ? "step" : undefined}
            >
              <span className="workflow-step-marker" aria-hidden={true}>
                {stepState === "complete" ? <Check /> : <Icon />}
              </span>
              <span className="workflow-step-copy">
                <strong>{step.label}</strong>
                <small>{stepState === "complete" ? "已完成" : stepState === "active" ? "当前步骤" : step.detail}</small>
              </span>
              <span className="workflow-step-tooltip" role="tooltip">
                {step.tooltip}
              </span>
            </button>
          );
        })}
      </nav>
      <button type="button" className="workflow-reset-button" onClick={onResetWorkflow} aria-label="重置AI生成步骤内容" title="清空AI生成中心的独立草稿内容">
        <RotateCcw aria-hidden="true" />
        <span>重置</span>
      </button>
    </div>
  );
}

function WorkflowPageFrame({
  active,
  workflow,
  onPage,
  onResetWorkflow,
  children,
  aside,
}: {
  active: WorkflowStepKey;
  workflow: DeliveryWorkflow;
  onPage: (page: PageKey) => void;
  onResetWorkflow: () => void;
  children: ReactNode;
  aside: ReactNode;
}) {
  return (
    <section className="workflow-page">
      <WorkflowStepBar active={active} workflow={workflow} onPage={onPage} onResetWorkflow={onResetWorkflow} />
      <div className="workflow-layout">
        <div className="workflow-primary">{children}</div>
        <aside className="workflow-aside">{aside}</aside>
      </div>
    </section>
  );
}

function WorkflowSectionHeader({
  icon: Icon,
  title,
  description,
  badge,
}: {
  icon: WorkflowIcon;
  title: string;
  description: string;
  badge?: ReactNode;
}) {
  void Icon;
  void title;
  void description;
  void badge;
  return null;
}

function WorkflowReadinessList({ items }: { items: Array<{ label: string; detail: string; ready: boolean }> }) {
  return (
    <div className="workflow-check-list">
      {items.map((item) => (
        <div key={item.label} className={item.ready ? "ready" : "pending"}>
          {item.ready ? <CheckCircle2 aria-hidden={true} /> : <Circle aria-hidden={true} />}
          <div>
            <strong>{item.label}</strong>
            <span>{item.detail}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function WorkflowContextPanel({
  workflow,
  active,
  modelName,
  children,
}: {
  workflow: DeliveryWorkflow;
  active: WorkflowStepKey;
  modelName?: string;
  children?: ReactNode;
}) {
  const guide = {
    sow: "先保证输入源完整。保存后的 SOW 会作为后续评估、WBS 和方案生成的唯一基础。",
    personDay: "当前步骤只处理人天测算。硬件资源测算已拆到下一步，页面会更聚焦。",
    hardware: "当前步骤只处理硬件资源测算，结果会进入实施方案第八章和 WBS 资源准备任务。",
    wbs: "WBS 草稿确认前不会写入正式任务。确认后会新建项目，并同步任务、甘特、交付物和里程碑。",
    plan: "实施方案承接前面所有人工修订后的草稿，适合作为交付方案初稿继续编辑。",
  }[active];
  return (
    <Card className="pad workflow-context-card">
      <div className="workflow-context-head">
        <PanelTitle icon={BookOpen} title="生成检查" />
        <Badge tone="primary">草稿链路</Badge>
      </div>
      <div className="workflow-context-block">
        <span>当前建议</span>
        <p>{guide}</p>
      </div>
      <div className="workflow-context-grid">
        <div>
          <span>SOW字数</span>
          <strong>{workflow.sow.content.length}</strong>
        </div>
        <div>
          <span>模型</span>
          <strong>{modelName || "未配置"}</strong>
        </div>
      </div>
      {children}
    </Card>
  );
}

function PanelTitle({ icon: Icon, title }: { icon: WorkflowIcon; title: string }) {
  return (
    <div className="workflow-panel-title">
      <Icon aria-hidden={true} />
      <strong>{title}</strong>
    </div>
  );
}

function UnitSegment({
  value,
  onChange,
  label,
}: {
  value: ResourceAssessmentInputs["dailyDataUnit"];
  onChange: (value: ResourceAssessmentInputs["dailyDataUnit"]) => void;
  label: string;
}) {
  return (
    <div className="unit-segment" role="group" aria-label={label}>
      {(["GB", "TB"] as const).map((unit) => (
        <button
          key={unit}
          type="button"
          className={value === unit ? "active" : ""}
          onClick={() => onChange(unit)}
          aria-pressed={value === unit}
        >
          {unit}
        </button>
      ))}
    </div>
  );
}

function textFromElement(element: Element | null) {
  return (element?.textContent || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function markdownTableFromElement(table: HTMLTableElement) {
  const headers = Array.from(table.querySelectorAll("thead th")).map(textFromElement);
  const rows = Array.from(table.querySelectorAll("tbody tr")).map((row) =>
    Array.from(row.querySelectorAll("td")).map(textFromElement),
  );
  if (!headers.length) return textFromElement(table);
  const separator = headers.map(() => "---");
  return [
    `| ${headers.join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...rows.map((row) => `| ${headers.map((_, index) => row[index] || "").join(" | ")} |`),
  ].join("\n");
}

function markdownFromEditablePreview(root: HTMLElement) {
  const source = root.querySelector(".rich-message") || root;
  const blocks: string[] = [];
  Array.from(source.children).forEach((child) => {
    if (child.matches(".rich-table-card")) {
      const table = child.querySelector("table");
      if (table) blocks.push(markdownTableFromElement(table));
      return;
    }
    if (/^H[1-6]$/.test(child.tagName)) {
      const text = textFromElement(child);
      if (text) blocks.push(`### ${text}`);
      return;
    }
    if (child.tagName === "UL") {
      const items = Array.from(child.querySelectorAll(":scope > li")).map(textFromElement).filter(Boolean);
      if (items.length) blocks.push(items.map((item) => `- ${item}`).join("\n"));
      return;
    }
    if (child.tagName === "OL") {
      const items = Array.from(child.querySelectorAll(":scope > li")).map(textFromElement).filter(Boolean);
      if (items.length) blocks.push(items.map((item, index) => `${index + 1}. ${item}`).join("\n"));
      return;
    }
    const text = textFromElement(child);
    if (text) blocks.push(text);
  });
  return blocks.join("\n\n").trim();
}

function syncEditablePreview(editorId: string | undefined, root: HTMLElement) {
  if (!editorId) return;
  const editor = document.getElementById(editorId) as HTMLTextAreaElement | null;
  if (!editor) return;
  const value = markdownFromEditablePreview(root);
  editor.value = value;
  root.classList.toggle("empty", !hasContent(value));
}

function readDraftValue(editorId: string, fallback: string) {
  const editor = document.getElementById(editorId) as HTMLTextAreaElement | null;
  return editor?.value ?? fallback;
}

function writeDraftValue(editorId: string | undefined, value: string) {
  if (!editorId) return;
  const editor = document.getElementById(editorId) as HTMLTextAreaElement | null;
  if (editor) editor.value = value;
}

function WorkflowZoomButton({ onClick }: { onClick: (event: MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button type="button" className="workflow-zoom-button" onClick={onClick} aria-label="全屏编辑">
      <Maximize2 aria-hidden={true} />
      全屏
    </button>
  );
}

function WorkflowMarkdownZoomEditor({
  title,
  content,
  editorId,
  open,
  onClose,
  onSave,
}: {
  title: string;
  content: string;
  editorId?: string;
  open: boolean;
  onClose: () => void;
  onSave?: (content: string) => void;
}) {
  const [draft, setDraft] = useState(content);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(editorId ? readDraftValue(editorId, content) : content);
  }, [content, editorId, open]);

  if (!open) return null;

  const saveZoomDraft = () => {
    const value = previewRef.current ? markdownFromEditablePreview(previewRef.current) : draft;
    writeDraftValue(editorId, value);
    onSave?.(value);
    onClose();
  };

  return (
    <div className="workflow-zoom-backdrop" role="presentation">
      <section className="workflow-zoom-panel" role="dialog" aria-modal={true} aria-label={`${title}放大编辑`}>
        <div className="workflow-zoom-head">
          <PanelTitle icon={Maximize2} title={title} />
          <div className="workflow-zoom-actions">
            <Button tone="primary" onClick={saveZoomDraft}>
              <Save aria-hidden={true} />
              保存修改
            </Button>
            <Button tone="ghost" onClick={onClose}>
              <Minimize2 aria-hidden={true} />
              退出全屏
            </Button>
          </div>
        </div>
        <div
          ref={previewRef}
          className="workflow-zoom-rich workflow-rich-preview editable"
          contentEditable={true}
          suppressContentEditableWarning={true}
          spellCheck={false}
          aria-label={`${title}放大编辑区`}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text/plain");
            document.execCommand("insertText", false, text);
          }}
        >
          <RichMessage content={draft} openTables={true} />
        </div>
      </section>
    </div>
  );
}

function WorkflowTextareaZoomEditor({
  title,
  editorId,
  open,
  onClose,
  onSave,
}: {
  title: string;
  editorId: string;
  open: boolean;
  onClose: () => void;
  onSave?: (content: string) => void;
}) {
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!open) return;
    setDraft(readDraftValue(editorId, ""));
  }, [editorId, open]);

  if (!open) return null;

  const saveZoomDraft = () => {
    writeDraftValue(editorId, draft);
    onSave?.(draft);
    onClose();
  };

  return (
    <div className="workflow-zoom-backdrop" role="presentation">
      <section className="workflow-zoom-panel textarea-mode" role="dialog" aria-modal={true} aria-label={`${title}放大编辑`}>
        <div className="workflow-zoom-head">
          <PanelTitle icon={Maximize2} title={title} />
          <div className="workflow-zoom-actions">
            <Button tone="primary" onClick={saveZoomDraft}>
              <Save aria-hidden={true} />
              保存修改
            </Button>
            <Button tone="ghost" onClick={onClose}>
              <Minimize2 aria-hidden={true} />
              退出全屏
            </Button>
          </div>
        </div>
        <textarea className="workflow-zoom-textarea" value={draft} onChange={(event) => setDraft(event.target.value)} />
      </section>
    </div>
  );
}

function WorkflowDraftResult({
  title,
  content,
  loading,
  emptyTitle,
  emptyDescription,
  icon: Icon = Table2,
  editorId,
  onSaveContent,
}: {
  title: string;
  content: string;
  loading?: boolean;
  emptyTitle: string;
  emptyDescription: string;
  icon?: WorkflowIcon;
  editorId?: string;
  onSaveContent?: (content: string) => void;
}) {
  const ready = hasContent(content);
  const [zoomOpen, setZoomOpen] = useState(false);
  return (
    <div className={`workflow-draft-result ${ready ? "ready" : ""} ${loading ? "loading" : ""}`}>
      <div className="workflow-result-head">
        <PanelTitle icon={Icon} title={title} />
        <div className="workflow-result-actions">
          <Badge tone={ready ? "success" : loading ? "primary" : ""}>{loading ? "生成中" : ready ? "可预览" : "空状态"}</Badge>
          {ready && editorId ? (
            <WorkflowZoomButton
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setZoomOpen(true);
              }}
            />
          ) : null}
        </div>
      </div>
      {loading && !ready ? (
        <div className="workflow-skeleton" aria-label="正在生成">
          <span />
          <span />
          <span />
          <span />
        </div>
      ) : ready ? (
        <div
          className={`workflow-rich-preview ${editorId ? "editable" : ""}`}
          contentEditable={Boolean(editorId) && !loading}
          suppressContentEditableWarning={true}
          spellCheck={false}
          aria-label={`${title}，可直接编辑`}
          onInput={(event) => syncEditablePreview(editorId, event.currentTarget)}
          onBlur={(event) => syncEditablePreview(editorId, event.currentTarget)}
          onPaste={(event) => {
            if (!editorId) return;
            event.preventDefault();
            const text = event.clipboardData.getData("text/plain");
            document.execCommand("insertText", false, text);
          }}
        >
          <RichMessage content={content} openTables={true} />
        </div>
      ) : (
        <div className="workflow-empty-panel">
          <Info aria-hidden={true} />
          <div>
            <strong>{emptyTitle}</strong>
            <p>{emptyDescription}</p>
          </div>
        </div>
      )}
      <WorkflowMarkdownZoomEditor
        title={title}
        content={content}
        editorId={editorId}
        open={zoomOpen}
        onClose={() => setZoomOpen(false)}
        onSave={onSaveContent}
      />
    </div>
  );
}

function WorkflowHandoffEditor({
  title,
  content,
  editorId,
  resetKey,
  emptyText,
  onSave,
}: {
  title: string;
  content: string;
  editorId: string;
  resetKey: string;
  emptyText: string;
  onSave: (content: string) => void;
}) {
  const ready = hasContent(content);
  const [zoomOpen, setZoomOpen] = useState(false);

  const saveCurrent = () => {
    onSave(readDraftValue(editorId, content));
  };

  return (
    <section className="workflow-sow-readable workflow-sow-handoff workflow-step-handoff" aria-label={title}>
      <div className="workflow-sow-readable-head">
        <span>
          <ArrowRight aria-hidden={true} />
          <strong>{title}</strong>
        </span>
        <div className="workflow-result-actions">
          <Badge tone={ready ? "primary" : "warning"}>{ready ? "可编辑" : "待补充"}</Badge>
          <Button tone="ghost" onClick={saveCurrent}>
            <Save aria-hidden={true} />
            保存
          </Button>
          <WorkflowZoomButton
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setZoomOpen(true);
            }}
          />
        </div>
      </div>
      <div
        className={`workflow-sow-readable-body editable ${ready ? "" : "empty"}`}
        contentEditable={true}
        suppressContentEditableWarning={true}
        spellCheck={false}
        data-placeholder={emptyText}
        aria-label={`${title}，可直接编辑`}
        onInput={(event) => syncEditablePreview(editorId, event.currentTarget)}
        onBlur={(event) => syncEditablePreview(editorId, event.currentTarget)}
        onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData.getData("text/plain");
          document.execCommand("insertText", false, text);
        }}
      >
        {ready ? <RichMessage content={content} openTables={true} /> : null}
      </div>
      <WorkflowMarkdownZoomEditor title={title} content={content} editorId={editorId} open={zoomOpen} onClose={() => setZoomOpen(false)} onSave={onSave} />
      <WorkflowDraftEditor id={editorId} resetKey={resetKey} value={content} placeholder="" />
    </section>
  );
}

function WorkflowSupplementEditor({
  title,
  description,
  editorId,
  resetKey,
  value,
  placeholder,
  onSave,
}: {
  title: string;
  description: string;
  editorId: string;
  resetKey: string;
  value: string;
  placeholder: string;
  onSave: (content: string) => void;
}) {
  const [zoomOpen, setZoomOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const ready = hasContent(draft);

  useEffect(() => {
    setDraft(value);
  }, [resetKey, value]);

  const saveCurrent = () => {
    onSave(draft);
  };

  return (
    <section className="workflow-supplement-panel" aria-label={title}>
      <div className="workflow-supplement-head">
        <div className="workflow-supplement-copy">
          <strong>{title}</strong>
          <span>{description}</span>
        </div>
        <div className="workflow-result-actions">
          <Badge tone={ready ? "primary" : "warning"}>{ready ? "已补充" : "可选"}</Badge>
          <Button tone="ghost" onClick={saveCurrent}>
            <Save aria-hidden={true} />
            保存
          </Button>
          <WorkflowZoomButton
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setZoomOpen(true);
            }}
          />
        </div>
      </div>
      <textarea
        key={resetKey}
        id={editorId}
        className="workflow-supplement-textarea"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        aria-label={`${title}，生成前补充信息`}
      />
      <WorkflowTextareaZoomEditor
        title={title}
        editorId={editorId}
        open={zoomOpen}
        onClose={() => setZoomOpen(false)}
        onSave={(content) => {
          setDraft(content);
          onSave(content);
        }}
      />
    </section>
  );
}

function WorkflowDraftEditor({
  id,
  resetKey,
  value,
  placeholder: _placeholder,
  compact: _compact = false,
}: {
  id: string;
  resetKey: string;
  value: string;
  placeholder: string;
  compact?: boolean;
}) {
  return (
    <textarea
      key={resetKey}
      id={id}
      className="workflow-hidden-draft"
      defaultValue={value}
      aria-hidden={true}
      tabIndex={-1}
    />
  );
}

const implementationPlanChapters = [
  { key: "preface", number: "第一章", title: "前言" },
  { key: "product", number: "第二章", title: "产品概述" },
  { key: "background", number: "第三章", title: "项目背景及目标" },
  { key: "scope", number: "第四章", title: "日志接入范围" },
  { key: "scenarios", number: "第五章", title: "建议交付场景方向" },
  { key: "alerts", number: "第六章", title: "告警配置重点场景" },
  { key: "architecture", number: "第七章", title: "系统架构" },
  { key: "resources", number: "第八章", title: "部署规模与资源需求" },
  { key: "schedule", number: "第九章", title: "实施计划" },
  { key: "risk", number: "第十章", title: "沟通与风险管理" },
] as const;

type ImplementationChapter = {
  key: string;
  number: string;
  title: string;
  content: string;
};

function normalizeChapterText(value: string) {
  return value.replace(/\s+/g, "").replace(/[、:：.．]/g, "");
}

function findImplementationChapterIndex(heading: string) {
  const normalized = normalizeChapterText(heading);
  return implementationPlanChapters.findIndex((chapter) => {
    const chapterTitle = normalizeChapterText(chapter.title);
    const chapterNumber = normalizeChapterText(chapter.number);
    return normalized.includes(chapterTitle) || normalized.includes(chapterNumber);
  });
}

function splitImplementationPlanChapters(content: string): ImplementationChapter[] {
  const sections: ImplementationChapter[] = implementationPlanChapters.map((chapter) => ({ ...chapter, content: "" }));
  if (!hasContent(content)) return sections;

  let currentIndex = -1;
  let matchedAnyChapter = false;

  content.split(/\r?\n/).forEach((line) => {
    const heading = line.match(/^#{1,4}\s+(.+)$/);
    const matchedIndex = heading ? findImplementationChapterIndex(heading[1]) : -1;

    if (matchedIndex >= 0) {
      currentIndex = matchedIndex;
      matchedAnyChapter = true;
      return;
    }

    if (currentIndex >= 0) {
      sections[currentIndex].content = `${sections[currentIndex].content}${line}\n`;
      return;
    }

    if (line.trim() && !/^#{1,4}\s+/.test(line)) {
      sections[0].content = `${sections[0].content}${line}\n`;
    }
  });

  if (!matchedAnyChapter) {
    sections[0].content = content;
  }

  return sections.map((section) => ({ ...section, content: section.content.trim() }));
}

function buildImplementationPlanFromFields(fallbackContent = "") {
  const fields = Array.from(document.querySelectorAll<HTMLTextAreaElement>("[data-implementation-chapter]"));
  if (!fields.length) return fallbackContent;
  const content = fields
    .map((field) => {
      const number = field.dataset.chapterNumber || "";
      const title = field.dataset.chapterTitle || "";
      const content = field.value.trim() || "【待补充】";
      return `### ${number} ${title}\n${content}`;
    })
    .join("\n\n");
  return content.trim() || fallbackContent;
}

function ImplementationChapterCard({
  resetKey,
  chapter,
  fallbackContent,
  onSaveContent,
}: {
  resetKey: string;
  chapter: ImplementationChapter;
  fallbackContent: string;
  onSaveContent?: (content: string) => void;
}) {
  const [zoomOpen, setZoomOpen] = useState(false);
  const editorId = `implementation-chapter-${chapter.key}`;

  return (
    <details className="implementation-chapter-card" key={`${resetKey}:${chapter.key}`} open={!hasContent(chapter.content)}>
      <summary>
        <span>
          <strong>{chapter.number}</strong>
          {chapter.title}
        </span>
        <div className="implementation-chapter-actions">
          <Badge tone={hasContent(chapter.content) ? "success" : "warning"}>{hasContent(chapter.content) ? "已生成" : "待补充"}</Badge>
          <WorkflowZoomButton
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setZoomOpen(true);
            }}
          />
        </div>
      </summary>
      <textarea
        key={`${resetKey}:${chapter.key}:editor`}
        id={editorId}
        className="chapter-editor"
        data-implementation-chapter={chapter.key}
        data-chapter-number={chapter.number}
        data-chapter-title={chapter.title}
        defaultValue={chapter.content}
        placeholder={`填写${chapter.number} ${chapter.title}内容`}
      />
      <WorkflowTextareaZoomEditor
        title={`${chapter.number} ${chapter.title}`}
        editorId={editorId}
        open={zoomOpen}
        onClose={() => setZoomOpen(false)}
        onSave={() => onSaveContent?.(buildImplementationPlanFromFields(fallbackContent))}
      />
    </details>
  );
}

function ImplementationChapterEditor({ resetKey, content, onSaveContent }: { resetKey: string; content: string; onSaveContent?: (content: string) => void }) {
  const chapters = splitImplementationPlanChapters(content);
  return (
    <div className="implementation-chapter-editor">
      <div className="implementation-chapter-head">
        <PanelTitle icon={ListChecks} title="10章分块修订" />
        <span>每章独立编辑，保存时合并为实施方案草稿</span>
      </div>
      <div className="implementation-chapter-grid">
        {chapters.map((chapter) => (
          <ImplementationChapterCard key={`${resetKey}:${chapter.key}`} resetKey={resetKey} chapter={chapter} fallbackContent={content} onSaveContent={onSaveContent} />
        ))}
      </div>
    </div>
  );
}

function WorkflowCompactPreview({ title, content, empty }: { title: string; content: string; empty: string }) {
  const ready = hasContent(content);
  return (
    <details className="workflow-accordion" open={ready}>
      <summary>
        <span>{title}</span>
        <Badge tone={ready ? "success" : ""}>{ready ? "已生成" : "缺失"}</Badge>
      </summary>
      {ready ? (
        <div className="workflow-compact-rich">
          <RichMessage content={content} />
        </div>
      ) : (
        <p className="muted">{empty}</p>
      )}
    </details>
  );
}

export function SowPage({
  state,
  onSaveSow,
  onStandardizeSow,
  standardizing,
  onPage,
  onResetWorkflow,
}: {
  state: AppState;
  onSaveSow: (sow: SowInput, handoffContent?: string, supplementContent?: string) => void;
  onStandardizeSow: (input: { projectId: string; fileName: string; rawContent: string; supplementalInfo?: string }) => void;
  standardizing: boolean;
  onPage: (page: PageKey) => void;
  onResetWorkflow: () => void;
}) {
  const workflow = getAiGenerationWorkflow(state);
  const [sowZoomOpen, setSowZoomOpen] = useState(false);
  const [sowHandoffZoomOpen, setSowHandoffZoomOpen] = useState(false);
  const sowHandoffContent = workflow.handoff.sow || extractWorkflowSowHandoffContent(workflow.sow.content);

  const currentSowSupplement = () => readDraftValue("sowSupplement", workflow.supplements.sow).trim();

  const save = (content?: string, fileName?: string, handoffContent?: string, supplementContent = currentSowSupplement()) => {
    const input = document.querySelector("#sowContent") as HTMLTextAreaElement | null;
    const nextContent = content ?? input?.value ?? workflow.sow.content;
    const nextHandoff = handoffContent ?? readDraftValue("sowHandoffContent", workflow.handoff.sow || extractWorkflowSowHandoffContent(nextContent));
    onSaveSow({
      projectId: workflow.projectId,
      content: nextContent,
      fileName: fileName ?? workflow.sow.fileName,
      updatedAt: new Date().toISOString(),
    }, nextHandoff, supplementContent);
  };

  const standardizeFromEditor = () => {
    const input = document.querySelector("#sowContent") as HTMLTextAreaElement | null;
    onStandardizeSow({
      projectId: workflow.projectId,
      fileName: workflow.sow.fileName || "手工粘贴",
      rawContent: input?.value ?? workflow.sow.content,
      supplementalInfo: currentSowSupplement(),
    });
  };

  const saveSowContent = (content: string) => {
    writeDraftValue("sowContent", content);
    const nextHandoff = extractWorkflowSowHandoffContent(content);
    writeDraftValue("sowHandoffContent", nextHandoff);
    save(content, undefined, nextHandoff);
  };

  const syncSowHandoffContent = (content: string) => {
    const nextContent = replaceWorkflowSowHandoffContent(readDraftValue("sowContent", workflow.sow.content), content);
    writeDraftValue("sowHandoffContent", content);
    writeDraftValue("sowContent", nextContent);
    return nextContent;
  };

  const saveSowHandoffContent = (content: string) => {
    save(syncSowHandoffContent(content), undefined, content);
  };

  return (
    <WorkflowPageFrame
      active="sow"
      workflow={workflow}
      onPage={onPage}
      onResetWorkflow={onResetWorkflow}
      aside={
        <WorkflowContextPanel
          workflow={workflow}
          active="sow"
          modelName={state.aiModelConfigs.find((item) => item.isDefault)?.model}
        >
          <WorkflowReadinessList
            items={[
              {
                label: "SOW输入源",
                detail: hasContent(workflow.sow.content) ? `${workflow.sow.content.length} 字已保存` : "导入后由 AI 生成标准输入源",
                ready: hasContent(workflow.sow.content),
              },
              {
                label: "文件来源",
                detail: workflow.sow.fileName || "可直接粘贴正文，无需强制上传",
                ready: Boolean(workflow.sow.fileName),
              },
              {
                label: "下一步",
                detail: hasContent(workflow.sow.content) ? "可进入人天评估" : "等待 SOW 输入",
                ready: hasContent(workflow.sow.content),
              },
            ]}
          />
        </WorkflowContextPanel>
      }
    >
      <Card className="pad workflow-section-card">
        <WorkflowSectionHeader
          icon={FileText}
          title="SOW 输入"
          description="导入文件后先交给 AI 解析，生成描述清晰、格式稳定的 Markdown 输入源；确认后再进入下一步。"
          badge={
            <Badge tone={standardizing ? "primary" : hasContent(workflow.sow.content) ? "success" : "warning"}>
              {standardizing ? "AI解析中" : hasContent(workflow.sow.content) ? "已保存" : "待输入"}
            </Badge>
          }
        />
        <WorkflowSupplementEditor
          title="生成前补充信息"
          description="补充客户口径、缺失字段或需要 AI 优先采纳的判断，生成标准 SOW 时会一起传入。"
          editorId="sowSupplement"
          resetKey={`${workflow.projectId}:sow-supplement:${workflow.supplements.sow}`}
          value={workflow.supplements.sow}
          placeholder="例如：客户简称、项目边界、SOW 表格里的空值解释、需要按某个 Sheet 为准等。"
          onSave={(content) => save(undefined, undefined, undefined, content)}
        />
        <div className="field">
          <label className={`workflow-upload-zone ${standardizing ? "loading" : ""}`}>
            {standardizing ? <LoaderCircle aria-hidden={true} /> : <Upload aria-hidden={true} />}
            <span>
              <strong>{workflow.sow.fileName || "导入 SOW 文件"}</strong>
              <small>{standardizing ? "AI 正在读取并标准化文件内容..." : "支持 .xlsx / .xls / .csv / .txt / .md；导入后自动生成标准 Markdown 输入源。"}</small>
            </span>
            <input
              className="workflow-file-input"
              type="file"
              accept=".xlsx,.xls,.csv,.txt,.md"
              disabled={standardizing}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                console.info("[SOW导入] 用户选择文件", {
                  name: file.name,
                  size: file.size,
                });
                try {
                  const text = await readSowFile(file);
                  console.info("[SOW导入] 文件读取完成，准备进入AI标准化", {
                    name: file.name,
                    chars: text.length,
                  });
                  onStandardizeSow({
                    projectId: workflow.projectId,
                    fileName: file.name,
                    rawContent: text,
                    supplementalInfo: currentSowSupplement(),
                  });
                } catch (error) {
                  console.error("[SOW导入] 文件读取失败", {
                    name: file.name,
                    error,
                  });
                } finally {
                  event.currentTarget.value = "";
                }
              }}
            />
          </label>
        </div>
        <div className="workflow-sow-summary">
          <div>
            <span>输入状态</span>
            <strong>{hasContent(workflow.sow.content) ? "已保存" : "待输入"}</strong>
          </div>
          <div>
            <span>字数</span>
            <strong>{workflow.sow.content.length}</strong>
          </div>
          <div>
            <span>来源</span>
            <strong>{workflow.sow.fileName || "手工粘贴"}</strong>
          </div>
          <div>
            <span>更新时间</span>
            <strong>{workflow.sow.updatedAt ? workflow.sow.updatedAt.slice(0, 16).replace("T", " ") : "未保存"}</strong>
          </div>
        </div>
        <details className="workflow-sow-readable" aria-label="标准化 SOW 可读预览" open={hasContent(workflow.sow.content) || standardizing}>
          <summary className="workflow-sow-readable-head">
              <span>
                <BookOpen aria-hidden={true} />
                <strong>标准化 SOW 预览</strong>
              </span>
              <div className="workflow-result-actions">
                <Badge tone={standardizing ? "primary" : hasContent(workflow.sow.content) ? "success" : ""}>
                  {standardizing ? "解析中" : hasContent(workflow.sow.content) ? "可读版" : "暂无数据"}
                </Badge>
                <WorkflowZoomButton
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setSowZoomOpen(true);
                  }}
                />
              </div>
            </summary>
            <div
              className={`workflow-sow-readable-body editable ${hasContent(workflow.sow.content) ? "" : "empty"}`}
              contentEditable={true}
              suppressContentEditableWarning={true}
              spellCheck={false}
              data-placeholder="暂无标准化 SOW 结果，AI解析完成后会写入这里。"
              aria-label="标准化 SOW 预览，可直接编辑"
              onInput={(event) => {
                syncEditablePreview("sowContent", event.currentTarget);
                writeDraftValue("sowHandoffContent", extractWorkflowSowHandoffContent(readDraftValue("sowContent", workflow.sow.content)));
              }}
              onBlur={(event) => {
                syncEditablePreview("sowContent", event.currentTarget);
                writeDraftValue("sowHandoffContent", extractWorkflowSowHandoffContent(readDraftValue("sowContent", workflow.sow.content)));
              }}
              onPaste={(event) => {
                event.preventDefault();
                const text = event.clipboardData.getData("text/plain");
                document.execCommand("insertText", false, text);
              }}
            >
              {hasContent(workflow.sow.content) ? <RichMessage content={workflow.sow.content} openTables={true} /> : null}
            </div>
            <WorkflowMarkdownZoomEditor
              title="标准化 SOW 预览"
              content={workflow.sow.content}
              editorId="sowContent"
              open={sowZoomOpen}
              onClose={() => setSowZoomOpen(false)}
              onSave={saveSowContent}
            />
        </details>
        {hasContent(workflow.sow.content) ? (
          <section className="workflow-sow-readable workflow-sow-handoff" aria-label="准备传入下一步的信息">
            <div className="workflow-sow-readable-head">
              <span>
                <ArrowRight aria-hidden={true} />
                <strong>准备传入下一步的信息</strong>
              </span>
              <div className="workflow-result-actions">
                <Badge tone={hasContent(sowHandoffContent) ? "primary" : "warning"}>{hasContent(sowHandoffContent) ? "可编辑" : "未识别"}</Badge>
                <Button tone="ghost" onClick={() => saveSowHandoffContent(readDraftValue("sowHandoffContent", sowHandoffContent))}>
                  <Save aria-hidden={true} />
                  保存
                </Button>
                <WorkflowZoomButton
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setSowHandoffZoomOpen(true);
                  }}
                />
              </div>
            </div>
            <div
              className="workflow-sow-readable-body editable"
              contentEditable={true}
              suppressContentEditableWarning={true}
              spellCheck={false}
              aria-label="准备传入下一步的信息，可直接编辑"
              onInput={(event) => syncSowHandoffContent(markdownFromEditablePreview(event.currentTarget))}
              onBlur={(event) => syncSowHandoffContent(markdownFromEditablePreview(event.currentTarget))}
              onPaste={(event) => {
                event.preventDefault();
                const text = event.clipboardData.getData("text/plain");
                document.execCommand("insertText", false, text);
              }}
            >
              {hasContent(sowHandoffContent) ? <RichMessage content={sowHandoffContent} openTables={true} /> : <p className="muted">未识别到“传递给人天&资源评估的结构化摘要”，可在这里手工填写。</p>}
            </div>
            <WorkflowMarkdownZoomEditor
              title="准备传入下一步的信息"
              content={sowHandoffContent}
              editorId="sowHandoffContent"
              open={sowHandoffZoomOpen}
              onClose={() => setSowHandoffZoomOpen(false)}
              onSave={saveSowHandoffContent}
            />
          </section>
        ) : null}
        <WorkflowDraftEditor id="sowContent" resetKey={`${workflow.projectId}:${workflow.sow.updatedAt}`} value={workflow.sow.content} placeholder="" />
        <WorkflowDraftEditor id="sowHandoffContent" resetKey={`${workflow.projectId}:${workflow.sow.updatedAt}:handoff`} value={sowHandoffContent} placeholder="" />
        <div className="actions-row workflow-actions-row">
          <Button tone="primary" onClick={standardizeFromEditor} disabled={standardizing}>
            {standardizing ? <LoaderCircle aria-hidden={true} /> : <Sparkles aria-hidden={true} />}
            {standardizing ? "AI解析中..." : "AI解析为标准SOW"}
          </Button>
          <Button tone="ghost" onClick={() => save()} disabled={standardizing}>
            <Save aria-hidden={true} />
            保存当前输入源
          </Button>
          <Button
            tone="ghost"
            onClick={() => {
              save();
              onPage("resourceEval");
            }}
            disabled={!hasContent(workflow.sow.content) || standardizing}
          >
            <ArrowRight aria-hidden={true} />
            进入人天评估
          </Button>
        </div>
      </Card>
    </WorkflowPageFrame>
  );
}

export function ResourceAssessmentPage({
  state,
  onGeneratePersonDay,
  onSaveDraft,
  generatingPersonDay,
  onPage,
  onResetWorkflow,
}: {
  state: AppState;
  onGeneratePersonDay: (workflow: DeliveryWorkflow) => void;
  onSaveDraft: (workflow: DeliveryWorkflow) => void;
  generatingPersonDay: boolean;
  onPage: (page: PageKey) => void;
  onResetWorkflow: () => void;
}) {
  const workflow = getAiGenerationWorkflow(state);
  const [resourceInputs, setResourceInputs] = useState<ResourceAssessmentInputs>(() => normalizeResourceInputs(workflow.resourceInputs));

  useEffect(() => {
    setResourceInputs(normalizeResourceInputs(workflow.resourceInputs));
  }, [
    workflow.projectId,
    workflow.resourceInputs.hasFixedPersonDays,
    workflow.resourceInputs.fixedPersonDays,
    workflow.resourceInputs.analysisAppCount,
    workflow.resourceInputs.analysisBusinessSystemCount,
    workflow.resourceInputs.agentCount,
    workflow.resourceInputs.syslogCount,
    workflow.resourceInputs.retentionDays,
    workflow.resourceInputs.needsFlink,
    workflow.resourceInputs.includesSiem,
    workflow.resourceInputs.includesUeba,
    workflow.resourceInputs.involvesDataMigration,
  ]);

  const patchResourceInputs = (patch: Partial<ResourceAssessmentInputs>) => {
    setResourceInputs((current) => ({ ...current, ...patch }));
  };

  const workflowWithCurrentResourceInputs = () => ({
    ...workflow,
    resourceInputs,
    supplements: {
      ...workflow.supplements,
      personDay: "",
    },
  });
  const saveResourceInputs = () => {
    onSaveDraft(workflowWithCurrentResourceInputs());
  };
  const generatePersonDayWithInputs = () => {
    onGeneratePersonDay(workflowWithCurrentResourceInputs());
  };
  const savePersonDayDraft = (content: string) => {
    onSaveDraft({
      ...workflowWithCurrentResourceInputs(),
      handoff: {
        ...workflow.handoff,
        personDay: readDraftValue("personDayHandoff", workflow.handoff.personDay).trim(),
      },
      personDayAssessment: { ...workflow.personDayAssessment, content, status: "edited" },
    });
  };
  const savePersonDayHandoff = (content: string) => {
    onSaveDraft({
      ...workflowWithCurrentResourceInputs(),
      handoff: {
        ...workflow.handoff,
        personDay: content.trim(),
      },
    });
  };
  return (
    <WorkflowPageFrame
      active="personDay"
      workflow={workflow}
      onPage={onPage}
      onResetWorkflow={onResetWorkflow}
      aside={
        <WorkflowContextPanel
          workflow={workflow}
          active="personDay"
          modelName={state.aiModelConfigs.find((item) => item.isDefault)?.model}
        >
          <WorkflowReadinessList
            items={[
              {
                label: "SOW内容",
                detail: hasContent(workflow.sow.content) ? `${workflow.sow.content.length} 字可用` : "请先到 SOW 输入页保存",
                ready: hasContent(workflow.sow.content),
              },
              {
                label: "人天评估",
                detail: draftMeta(workflow.personDayAssessment),
                ready: hasContent(workflow.personDayAssessment.content),
              },
              {
                label: "硬件评估",
                detail: draftMeta(workflow.hardwareAssessment),
                ready: hasContent(workflow.hardwareAssessment.content),
              },
            ]}
          />
        </WorkflowContextPanel>
      }
    >
      <Card className="pad workflow-section-card">
        <WorkflowSectionHeader
          icon={Cpu}
          title="人天评估"
          description="调用 project-eval，输出基础服务小计、三项加成门禁、传统估算、PERT 三点估算，并传递给 WBS / 计划。"
          badge={<Badge tone={hasContent(workflow.personDayAssessment.content) ? "success" : ""}>{draftMeta(workflow.personDayAssessment)}</Badge>}
        />
        <div className="compact-parameter-panel">
          <div className="compact-parameter-head">
            <PanelTitle icon={ListChecks} title="评估参数" />
            <Button tone="ghost" onClick={saveResourceInputs}>
              <Save aria-hidden={true} />
              保存参数
            </Button>
          </div>
          <div className="compact-parameter-grid personday-parameter-grid">
            <label className="compact-switch">
              <span>固定人天</span>
              <input
                type="checkbox"
                checked={resourceInputs.hasFixedPersonDays}
                onChange={(event) => patchResourceInputs({ hasFixedPersonDays: event.target.checked })}
              />
            </label>
            <label className={`compact-input ${resourceInputs.hasFixedPersonDays ? "" : "disabled"}`}>
              <span>固定人天数</span>
              <input
                type="number"
                min="0"
                step="0.5"
                value={resourceInputs.fixedPersonDays}
                onChange={(event) => patchResourceInputs({ fixedPersonDays: event.target.value })}
                placeholder="如 35"
                disabled={!resourceInputs.hasFixedPersonDays}
              />
            </label>
            <label className="compact-input">
              <span>分析APP套数</span>
              <input
                type="number"
                min="0"
                step="1"
                value={resourceInputs.analysisAppCount}
                onChange={(event) => patchResourceInputs({ analysisAppCount: event.target.value })}
                placeholder="如 5"
              />
            </label>
            <label className="compact-input">
              <span>分析业务系统套数</span>
              <input
                type="number"
                min="0"
                step="1"
                value={resourceInputs.analysisBusinessSystemCount}
                onChange={(event) => patchResourceInputs({ analysisBusinessSystemCount: event.target.value })}
                placeholder="如 3"
              />
            </label>
            <label className="compact-input">
              <span>Agent数量</span>
              <input
                type="number"
                min="0"
                step="1"
                value={resourceInputs.agentCount}
                onChange={(event) => patchResourceInputs({ agentCount: event.target.value })}
                placeholder="如 1200"
              />
            </label>
            <label className="compact-input">
              <span>Syslog数量</span>
              <input
                type="number"
                min="0"
                step="1"
                value={resourceInputs.syslogCount}
                onChange={(event) => patchResourceInputs({ syslogCount: event.target.value })}
                placeholder="如 80"
              />
            </label>
          </div>
        </div>
        <div className="actions-row workflow-actions-row">
          <Button tone="primary" onClick={generatePersonDayWithInputs} disabled={generatingPersonDay}>
            {generatingPersonDay ? <LoaderCircle aria-hidden={true} /> : <Sparkles aria-hidden={true} />}
            {generatingPersonDay ? "生成中..." : "评估人天"}
          </Button>
          <Button
            tone="ghost"
            onClick={() => {
              savePersonDayDraft(readDraftValue("personDayDraft", workflow.personDayAssessment.content));
            }}
          >
            <Save aria-hidden={true} />
            保存人天
          </Button>
        </div>
        <WorkflowDraftResult
          title="人天评估结果预览"
          content={workflow.personDayAssessment.content}
          loading={generatingPersonDay}
          emptyTitle="尚未生成人天评估"
          emptyDescription="生成后会在这里把 Markdown 表格、标题和列表结构化展示，便于快速评审。"
          icon={Table2}
          editorId="personDayDraft"
          onSaveContent={savePersonDayDraft}
        />
        <WorkflowHandoffEditor
          title="准备传入 WBS/实施计划的信息"
          content={workflow.handoff.personDay}
          editorId="personDayHandoff"
          resetKey={`${workflow.projectId}:${workflow.personDayAssessment.generatedAt}:${workflow.personDayAssessment.status}:handoff:${workflow.handoff.personDay}`}
          emptyText="人天评估生成后会自动提取结构化摘要，也可以在这里手工补充总人天口径、阶段工时和待确认项。"
          onSave={savePersonDayHandoff}
        />
        <WorkflowDraftEditor
          id="personDayDraft"
          resetKey={`${workflow.projectId}:${workflow.personDayAssessment.generatedAt}:${workflow.personDayAssessment.status}`}
          value={workflow.personDayAssessment.content}
          placeholder="点击评估人天后生成，可人工修改。"
        />
      </Card>
    </WorkflowPageFrame>
  );
}

export function HardwareAssessmentPage({
  state,
  onGenerateHardware,
  onSaveDraft,
  generatingHardware,
  onPage,
  onResetWorkflow,
}: {
  state: AppState;
  onGenerateHardware: (workflow: DeliveryWorkflow) => void;
  onSaveDraft: (workflow: DeliveryWorkflow) => void;
  generatingHardware: boolean;
  onPage: (page: PageKey) => void;
  onResetWorkflow: () => void;
}) {
  const workflow = getAiGenerationWorkflow(state);
  const [resourceInputs, setResourceInputs] = useState<ResourceAssessmentInputs>(() => normalizeResourceInputs(workflow.resourceInputs));

  useEffect(() => {
    setResourceInputs(normalizeResourceInputs(workflow.resourceInputs));
  }, [
    workflow.projectId,
    workflow.resourceInputs.dailyDataVolume,
    workflow.resourceInputs.dailyDataUnit,
    workflow.resourceInputs.peakFactor,
    workflow.resourceInputs.singleNodeUsableTb,
    workflow.resourceInputs.singleNodeCapacityUnit,
    workflow.resourceInputs.nodeCount,
    workflow.resourceInputs.retentionDays,
    workflow.resourceInputs.needsFlink,
    workflow.resourceInputs.includesSiem,
    workflow.resourceInputs.includesUeba,
    workflow.resourceInputs.involvesDataMigration,
  ]);

  const patchResourceInputs = (patch: Partial<ResourceAssessmentInputs>) => {
    setResourceInputs((current) => ({ ...current, ...patch }));
  };
  const workflowWithCurrentResourceInputs = () => ({
    ...workflow,
    resourceInputs,
    supplements: {
      ...workflow.supplements,
      hardware: "",
    },
  });
  const saveResourceInputs = () => {
    onSaveDraft(workflowWithCurrentResourceInputs());
  };
  const generateHardwareWithInputs = () => {
    onGenerateHardware(workflowWithCurrentResourceInputs());
  };
  const saveHardwareDraft = (content: string) => {
    onSaveDraft({
      ...workflowWithCurrentResourceInputs(),
      handoff: {
        ...workflow.handoff,
        hardware: readDraftValue("hardwareHandoff", workflow.handoff.hardware).trim(),
      },
      hardwareAssessment: { ...workflow.hardwareAssessment, content, status: "edited" },
    });
  };
  const saveHardwareHandoff = (content: string) => {
    onSaveDraft({
      ...workflowWithCurrentResourceInputs(),
      handoff: {
        ...workflow.handoff,
        hardware: content.trim(),
      },
    });
  };

  return (
    <WorkflowPageFrame
      active="hardware"
      workflow={workflow}
      onPage={onPage}
      onResetWorkflow={onResetWorkflow}
      aside={
        <WorkflowContextPanel
          workflow={workflow}
          active="hardware"
          modelName={state.aiModelConfigs.find((item) => item.isDefault)?.model}
        >
          <WorkflowReadinessList
            items={[
              {
                label: "SOW内容",
                detail: hasContent(workflow.sow.content) ? `${workflow.sow.content.length} 字可用` : "请先到 SOW 输入页保存",
                ready: hasContent(workflow.sow.content),
              },
              {
                label: "人天评估",
                detail: draftMeta(workflow.personDayAssessment),
                ready: hasContent(workflow.personDayAssessment.content),
              },
              {
                label: "硬件评估",
                detail: draftMeta(workflow.hardwareAssessment),
                ready: hasContent(workflow.hardwareAssessment.content),
              },
            ]}
          />
        </WorkflowContextPanel>
      }
    >
      <Card className="pad workflow-section-card">
        <WorkflowSectionHeader
          icon={HardDrive}
          title="硬件资源评估"
          description="调用 rizhiyi-hardware-assessment，输出存储容量、Kafka 缓存、三档方案、Flink 补充和 N-1 校验。"
          badge={<Badge tone={hasContent(workflow.hardwareAssessment.content) ? "success" : ""}>{draftMeta(workflow.hardwareAssessment)}</Badge>}
        />
        <div className="compact-parameter-panel">
          <div className="compact-parameter-head">
            <PanelTitle icon={ListChecks} title="硬件参数" />
            <Button tone="ghost" onClick={saveResourceInputs}>
              <Save aria-hidden={true} />
              保存参数
            </Button>
          </div>
          <div className="compact-parameter-grid hardware-parameter-grid">
            <label className="compact-input hardware-unit-field">
              <span>日均数据量</span>
              <div className="unit-input-control">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={resourceInputs.dailyDataVolume}
                  onChange={(event) => patchResourceInputs({ dailyDataVolume: event.target.value })}
                  placeholder="如 500"
                />
                <UnitSegment
                  label="日均数据量单位"
                  value={resourceInputs.dailyDataUnit}
                  onChange={(dailyDataUnit) => patchResourceInputs({ dailyDataUnit })}
                />
              </div>
            </label>
            <label className="compact-input">
              <span>峰值系数</span>
              <input
                type="number"
                min="1"
                step="0.1"
                value={resourceInputs.peakFactor}
                onChange={(event) => patchResourceInputs({ peakFactor: event.target.value })}
                placeholder="默认 1"
              />
            </label>
            <label className="compact-input hardware-unit-field">
              <span>单节点磁盘容量</span>
              <div className="unit-input-control">
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={resourceInputs.singleNodeUsableTb}
                  onChange={(event) => patchResourceInputs({ singleNodeUsableTb: event.target.value })}
                  placeholder="如 20"
                />
                <UnitSegment
                  label="单节点磁盘容量单位"
                  value={resourceInputs.singleNodeCapacityUnit}
                  onChange={(singleNodeCapacityUnit) => patchResourceInputs({ singleNodeCapacityUnit })}
                />
              </div>
            </label>
            <label className="compact-input">
              <span>节点数</span>
              <input
                type="number"
                min="1"
                step="1"
                value={resourceInputs.nodeCount}
                onChange={(event) => patchResourceInputs({ nodeCount: event.target.value })}
                placeholder="如 3"
              />
            </label>
            <label className="compact-input">
              <span>留存天数</span>
              <input
                type="number"
                min="1"
                step="1"
                value={resourceInputs.retentionDays}
                onChange={(event) => patchResourceInputs({ retentionDays: event.target.value })}
                placeholder="180"
              />
            </label>
            <div className="hardware-toggle-group">
              <span>附加范围</span>
              <div className="hardware-toggle-list">
                <label className="mini-toggle">
                  <span>Flink</span>
                  <input
                    type="checkbox"
                    checked={resourceInputs.needsFlink}
                    onChange={(event) => patchResourceInputs({ needsFlink: event.target.checked })}
                  />
                </label>
                <label className="mini-toggle">
                  <span>SIEM</span>
                  <input
                    type="checkbox"
                    checked={resourceInputs.includesSiem}
                    onChange={(event) => patchResourceInputs({ includesSiem: event.target.checked })}
                  />
                </label>
                <label className="mini-toggle">
                  <span>UEBA</span>
                  <input
                    type="checkbox"
                    checked={resourceInputs.includesUeba}
                    onChange={(event) => patchResourceInputs({ includesUeba: event.target.checked })}
                  />
                </label>
                <label className="mini-toggle">
                  <span>数据迁移</span>
                  <input
                    type="checkbox"
                    checked={resourceInputs.involvesDataMigration}
                    onChange={(event) => patchResourceInputs({ involvesDataMigration: event.target.checked })}
                  />
                </label>
              </div>
            </div>
          </div>
        </div>
        <div className="actions-row workflow-actions-row">
          <Button tone="primary" onClick={generateHardwareWithInputs} disabled={generatingHardware}>
            {generatingHardware ? <LoaderCircle aria-hidden={true} /> : <Database aria-hidden={true} />}
            {generatingHardware ? "生成中..." : "评估硬件"}
          </Button>
          <Button
            tone="ghost"
            onClick={() => {
              saveHardwareDraft(readDraftValue("hardwareDraft", workflow.hardwareAssessment.content));
            }}
          >
            <Save aria-hidden={true} />
            保存硬件
          </Button>
        </div>
        <WorkflowDraftResult
          title="硬件资源结果预览"
          content={workflow.hardwareAssessment.content}
          loading={generatingHardware}
          emptyTitle="尚未生成硬件资源评估"
          emptyDescription="生成后会在这里展示容量测算、三档资源方案和待确认项。"
          icon={HardDrive}
          editorId="hardwareDraft"
          onSaveContent={saveHardwareDraft}
        />
        <WorkflowHandoffEditor
          title="准备传入实施方案第八章的信息"
          content={workflow.handoff.hardware}
          editorId="hardwareHandoff"
          resetKey={`${workflow.projectId}:${workflow.hardwareAssessment.generatedAt}:${workflow.hardwareAssessment.status}:handoff:${workflow.handoff.hardware}`}
          emptyText="硬件评估生成后会自动提取第八章结构化摘要，也可以在这里手工补充部署模式、推荐方案、容量口径和校验结论。"
          onSave={saveHardwareHandoff}
        />
        <WorkflowDraftEditor
          id="hardwareDraft"
          resetKey={`${workflow.projectId}:${workflow.hardwareAssessment.generatedAt}:${workflow.hardwareAssessment.status}`}
          value={workflow.hardwareAssessment.content}
          placeholder="点击评估硬件后生成，可人工修改。"
        />
      </Card>
    </WorkflowPageFrame>
  );
}

export function WbsPlanPage({
  state,
  onGenerate,
  onSaveDraft,
  onConfirmFlow,
  generating,
  onPage,
  onResetWorkflow,
}: {
  state: AppState;
  onGenerate: (workflow: DeliveryWorkflow) => void;
  onSaveDraft: (workflow: DeliveryWorkflow) => void;
  onConfirmFlow: (workflow: DeliveryWorkflow) => void;
  generating: boolean;
  onPage: (page: PageKey) => void;
  onResetWorkflow: () => void;
}) {
  const workflow = getAiGenerationWorkflow(state);
  const flowConfirmed = workflow.projectFlow.status === "confirmed";
  const currentWbsSupplement = () => readDraftValue("wbsSupplement", workflow.supplements.wbs).trim();
  const workflowWithCurrentWbs = (content = readDraftValue("wbsPlanDraft", workflow.wbsPlan.content)) => ({
      ...workflow,
      handoff: {
        ...workflow.handoff,
        wbs: readDraftValue("wbsHandoff", workflow.handoff.wbs).trim(),
      },
      supplements: {
        ...workflow.supplements,
        wbs: currentWbsSupplement(),
      },
      wbsPlan: { ...workflow.wbsPlan, content, status: "edited" as const },
  });
  const saveWbsDraft = (content: string) => {
    onSaveDraft(workflowWithCurrentWbs(content));
  };
  const saveWbsHandoff = (content: string) => {
    onSaveDraft({
      ...workflow,
      handoff: {
        ...workflow.handoff,
        wbs: content.trim(),
      },
      supplements: {
        ...workflow.supplements,
        wbs: currentWbsSupplement(),
      },
    });
  };
  return (
    <WorkflowPageFrame
      active="wbs"
      workflow={workflow}
      onPage={onPage}
      onResetWorkflow={onResetWorkflow}
      aside={
        <WorkflowContextPanel
          workflow={workflow}
          active="wbs"
          modelName={state.aiModelConfigs.find((item) => item.isDefault)?.model}
        >
          <WorkflowReadinessList
            items={[
              {
                label: "人天评估",
                detail: draftMeta(workflow.personDayAssessment),
                ready: hasContent(workflow.personDayAssessment.content),
              },
              {
                label: "硬件评估",
                detail: draftMeta(workflow.hardwareAssessment),
                ready: hasContent(workflow.hardwareAssessment.content),
              },
              {
                label: "新项目",
                detail: flowConfirmed ? `已在 ${workflow.projectFlow.confirmedAt.slice(0, 10)} 创建` : "确认后新建项目并写入正式任务",
                ready: flowConfirmed,
              },
            ]}
          />
          <WorkflowCompactPreview title="人天评估摘要" content={workflow.personDayAssessment.content} empty="尚未生成人天评估。" />
          <WorkflowCompactPreview title="硬件资源摘要" content={workflow.hardwareAssessment.content} empty="尚未生成硬件资源评估。" />
        </WorkflowContextPanel>
      }
    >
      <Card className="pad workflow-section-card">
        <WorkflowSectionHeader
          icon={Workflow}
          title="WBS分解与实施计划表"
          description="承接人天评估和硬件资源评估，调用 skill-export 生成 WBS、详细计划表、文本甘特图和里程碑草稿。"
          badge={
            <Badge tone={flowConfirmed ? "success" : hasContent(workflow.wbsPlan.content) ? "warning" : ""}>
              {flowConfirmed ? "已创建项目" : hasContent(workflow.wbsPlan.content) ? "草稿待确认" : "未生成"}
            </Badge>
          }
        />
        <WorkflowSupplementEditor
          title="生成前补充信息"
          description="补充排期口径、里程碑、角色安排或客户时间约束，生成 WBS 与计划时会优先参考。"
          editorId="wbsSupplement"
          resetKey={`${workflow.projectId}:wbs-supplement:${workflow.supplements.wbs}`}
          value={workflow.supplements.wbs}
          placeholder="例如：入场时间按 2026-07-01；只按工作日排期；客户每周三评审；试运行阶段保留 10 个工作日。"
          onSave={(content) =>
            onSaveDraft({
              ...workflowWithCurrentWbs(),
              supplements: {
                ...workflow.supplements,
                wbs: content.trim(),
              },
            })
          }
        />
        <div className="actions-row workflow-actions-row">
          <Button tone="primary" onClick={() => onGenerate(workflowWithCurrentWbs())} disabled={generating}>
            {generating ? <LoaderCircle aria-hidden={true} /> : <Sparkles aria-hidden={true} />}
            {generating ? "生成中..." : "生成 WBS 与计划"}
          </Button>
          <Button
            tone="ghost"
            onClick={() => {
              saveWbsDraft(readDraftValue("wbsPlanDraft", workflow.wbsPlan.content));
            }}
          >
            <Save aria-hidden={true} />
            保存修改
          </Button>
          <Button tone="success" onClick={() => onConfirmFlow(workflowWithCurrentWbs())} disabled={!hasContent(workflow.wbsPlan.content) || generating}>
            <ClipboardCheck aria-hidden={true} />
            创建新项目
          </Button>
        </div>
        <div className={`handoff-banner ${flowConfirmed ? "confirmed" : ""}`}>
          {flowConfirmed ? <CheckCircle2 aria-hidden={true} /> : <AlertTriangle aria-hidden={true} />}
          <strong>{flowConfirmed ? "项目已创建" : "AI草稿尚未创建项目"}</strong>
          <span>
            {flowConfirmed
              ? `已在 ${workflow.projectFlow.confirmedAt.slice(0, 10)} 转入正式任务和交付物，可在新项目中继续跟踪。`
              : "WBS/计划生成后，点击“创建新项目”会新建项目，并写入正式任务、交付物和后续管理视图。"}
          </span>
        </div>
        <WorkflowDraftResult
          title="WBS / 计划预览"
          content={workflow.wbsPlan.content}
          loading={generating}
          emptyTitle="尚未生成 WBS 与实施计划"
          emptyDescription="生成后会在这里展示任务清单、计划表、文本甘特图和里程碑草稿。"
          icon={Table2}
          editorId="wbsPlanDraft"
          onSaveContent={saveWbsDraft}
        />
        <WorkflowHandoffEditor
          title="准备传入实施方案的信息"
          content={workflow.handoff.wbs}
          editorId="wbsHandoff"
          resetKey={`${workflow.projectId}:${workflow.wbsPlan.generatedAt}:${workflow.wbsPlan.status}:handoff:${workflow.handoff.wbs}`}
          emptyText="WBS/计划生成后会自动提取计划摘要，也可以在这里手工补充阶段、里程碑、排期口径和待确认项。"
          onSave={saveWbsHandoff}
        />
        <WorkflowDraftEditor
          id="wbsPlanDraft"
          resetKey={`${workflow.projectId}:${workflow.wbsPlan.generatedAt}:${workflow.wbsPlan.status}`}
          value={workflow.wbsPlan.content}
          placeholder="点击生成后输出，可人工修改。"
        />
      </Card>
    </WorkflowPageFrame>
  );
}

export function ImplementationPlanPage({
  state,
  onGenerate,
  onSaveDraft,
  generating,
  onPage,
  onResetWorkflow,
}: {
  state: AppState;
  onGenerate: (workflow: DeliveryWorkflow) => void;
  onSaveDraft: (workflow: DeliveryWorkflow) => void;
  generating: boolean;
  onPage: (page: PageKey) => void;
  onResetWorkflow: () => void;
}) {
  const workflow = getAiGenerationWorkflow(state);
  const workflowWithCurrentImplementation = (content = workflow.implementationPlan.content) => ({
    ...workflow,
    supplements: {
      ...workflow.supplements,
      implementation: "",
    },
    implementationPlan: {
      ...workflow.implementationPlan,
      content,
      status: hasContent(content) ? ("edited" as const) : workflow.implementationPlan.status,
    },
  });

  return (
    <WorkflowPageFrame
      active="plan"
      workflow={workflow}
      onPage={onPage}
      onResetWorkflow={onResetWorkflow}
      aside={
        <WorkflowContextPanel
          workflow={workflow}
          active="plan"
          modelName={state.aiModelConfigs.find((item) => item.isDefault)?.model}
        >
          <WorkflowReadinessList
            items={[
              {
                label: "SOW输入",
                detail: hasContent(workflow.sow.content) ? `${workflow.sow.content.length} 字已保存` : "缺少方案基础",
                ready: hasContent(workflow.sow.content),
              },
              {
                label: "人天评估",
                detail: draftMeta(workflow.personDayAssessment),
                ready: hasContent(workflow.personDayAssessment.content),
              },
              {
                label: "硬件评估",
                detail: draftMeta(workflow.hardwareAssessment),
                ready: hasContent(workflow.hardwareAssessment.content),
              },
              {
                label: "WBS计划",
                detail: draftMeta(workflow.wbsPlan),
                ready: hasContent(workflow.wbsPlan.content),
              },
            ]}
          />
          <WorkflowCompactPreview title="WBS / 计划摘要" content={workflow.wbsPlan.content} empty="尚未生成WBS与实施计划。" />
        </WorkflowContextPanel>
      }
    >
      <Card className="pad workflow-section-card">
        <WorkflowSectionHeader
          icon={FileCheck2}
          title="实施方案生成"
          description="承接 SOW、人天评估、硬件资源评估与 WBS / 计划，调用 project-implementation-program 生成 10 章实施方案草稿。"
          badge={<Badge tone={hasContent(workflow.implementationPlan.content) ? "success" : ""}>{draftMeta(workflow.implementationPlan)}</Badge>}
        />
        <div className="actions-row workflow-actions-row">
          <Button tone="primary" onClick={() => onGenerate(workflowWithCurrentImplementation())} disabled={generating}>
            {generating ? <LoaderCircle aria-hidden={true} /> : <Sparkles aria-hidden={true} />}
            {generating ? "生成中..." : "生成实施方案"}
          </Button>
          <Button
            tone="ghost"
            onClick={() => {
              onSaveDraft(workflowWithCurrentImplementation(buildImplementationPlanFromFields(workflow.implementationPlan.content)));
            }}
            disabled={!hasContent(workflow.implementationPlan.content) || generating}
          >
            <Save aria-hidden={true} />
            保存修改
          </Button>
        </div>
        {hasContent(workflow.implementationPlan.content) && !generating ? (
          <ImplementationChapterEditor
            resetKey={`${workflow.projectId}:${workflow.implementationPlan.generatedAt}:${workflow.implementationPlan.status}`}
            content={workflow.implementationPlan.content}
            onSaveContent={(content) => {
              onSaveDraft(workflowWithCurrentImplementation(content));
            }}
          />
        ) : (
          <WorkflowDraftResult
            title="实施方案预览"
            content={workflow.implementationPlan.content}
            loading={generating}
            emptyTitle="尚未生成实施方案"
            emptyDescription="生成后会按10章拆分为独立编辑区，方便逐章修改和评审。"
            icon={FileCheck2}
          />
        )}
      </Card>
    </WorkflowPageFrame>
  );
}
