import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import Database from "better-sqlite3";
import { ImapFlow } from "imapflow";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import nodemailer from "nodemailer";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type OpenAiEndpointCandidate = { kind: "chat" | "responses"; endpoint: string };
type StreamDeltaHandler = (delta: string, content: string) => void;
type EmailConfig = {
  senderName?: string;
  email?: string;
  username?: string;
  password?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  draftsMailbox?: string;
};
type EmailDraftPayload = {
  to?: string;
  cc?: string;
  subject?: string;
  content?: string;
  htmlContent?: string;
};

const GPT55_PROXY_URL = "https://api.aicodemirror.com/api/codex/v1/chat/completions";
const DEFAULT_MAX_TOKENS = 4096;
const AI_MODEL_CONFIG_FILE = path.resolve(process.cwd(), "config", "ai-model-config.json");
const BACKEND_DB_FILE = path.resolve(process.cwd(), "data", "implementation-pm.sqlite");
const STATE_KEY = "app-state";

type BackendDatabase = ReturnType<typeof Database>;
let backendDb: BackendDatabase | null = null;

function isGpt5Model(model: string) {
  return /^gpt-5(?:[.-]|$)/i.test(model);
}

function isKimiFixedTemperatureModel(model: string) {
  return /^kimi-k2\.6(?:[.-]|$)/i.test(model);
}

function openAiCompatibleTemperature(config: any, model: string) {
  if (isKimiFixedTemperatureModel(model)) return 1;
  return typeof config.temperature === "number" ? config.temperature : undefined;
}

function openAiCompatibleTokenLimit(model: string, maxTokens: number) {
  return isKimiFixedTemperatureModel(model) ? Math.max(maxTokens, 1024) : maxTokens;
}

function readJsonBody(req: any) {
  return new Promise<any>((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > 2_000_000) reject(new Error("请求体过大。"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("请求体不是合法 JSON。"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: any, statusCode: number, data: unknown) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json;charset=utf-8");
  res.end(JSON.stringify(data));
}

function parseEmailList(value: string) {
  return value
    .split(/[;,，；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function validateEmailDraftRequest(config: EmailConfig, payload: EmailDraftPayload) {
  if (!String(config.email || "").trim()) throw new Error("请先在设置中填写发件邮箱。");
  if (!String(config.username || "").trim()) throw new Error("请先在设置中填写邮箱登录账号。");
  if (!String(config.password || "").trim()) throw new Error("请先在设置中填写客户端专用密码或授权码。");
  if (!String(config.imapHost || "").trim()) throw new Error("请先配置 IMAP 服务器。");
  if (!String(config.draftsMailbox || "").trim()) throw new Error("请先配置草稿箱目录。");
  if (!parseEmailList(String(payload.to || "")).length) throw new Error("请填写至少一个收件人。");
  if (!String(payload.subject || "").trim()) throw new Error("请填写邮件主题。");
  if (!String(payload.content || "").trim()) throw new Error("周报正文为空，无法保存草稿。");
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}

function inlineMarkdownToHtml(value: string) {
  const parts: string[] = [];
  const pattern = /(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    if (match.index > lastIndex) parts.push(escapeHtml(value.slice(lastIndex, match.index)));
    const token = match[0];
    if (token.startsWith("**")) {
      parts.push(`<strong style="font-weight:700;color:#1f2b3b">${escapeHtml(token.slice(2, -2))}</strong>`);
    } else if (token.startsWith("~~")) {
      parts.push(`<s style="text-decoration:line-through;color:#6b7280">${escapeHtml(token.slice(2, -2))}</s>`);
    } else {
      parts.push(`<code style="padding:1px 5px;border:1px solid #dbe6f3;border-radius:5px;background:#f7fbff;color:#3f73d8;font-size:12px">${escapeHtml(token.slice(1, -1))}</code>`);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < value.length) parts.push(escapeHtml(value.slice(lastIndex)));
  return parts.join("");
}

const markdownTableSeparatorPattern = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function parseMarkdownTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function stripInlineMarkdownText(value: string) {
  return value.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/~~([^~]+)~~/g, "$1").replace(/`([^`]+)`/g, "$1").trim();
}

function extractPercent(value: string) {
  const normalized = stripInlineMarkdownText(value);
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!match) return null;
  const percent = Number(match[1]);
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null;
}

function weeklyMailStatusColors(value: string) {
  const status = stripInlineMarkdownText(value);
  if (/健康|已完成|已验收|内部确认|完成|关闭|低/.test(status)) return { border: "#bbf7d0", bg: "#f0fdf4", color: "#15803d" };
  if (/需关注|客户待确认|待确认|跟踪|中|待验收|待上传|进行|开发|实施/.test(status)) return { border: "#fde68a", bg: "#fffbeb", color: "#b45309" };
  if (/延期|逾期|阻塞|高/.test(status)) return { border: "#fed7aa", bg: "#fff7ed", color: "#c2410c" };
  if (/风险|打开|问题/.test(status)) return { border: "#fecaca", bg: "#fef2f2", color: "#dc2626" };
  if (/暂停|未开始|待办|未上传|未维护/.test(status)) return { border: "#d1d5db", bg: "#f9fafb", color: "#6b7280" };
  return { border: "#e5e7eb", bg: "#f9fafb", color: "#4b5563" };
}

function weeklyMailStatusPill(value: string) {
  const colors = weeklyMailStatusColors(value);
  const text = escapeHtml(stripInlineMarkdownText(value));
  return `<span style="display:inline-block;max-width:100%;min-height:20px;padding:3px 9px;border:1px solid ${colors.border};border-radius:999px;background:${colors.bg};color:${colors.color};font-size:12px;font-weight:700;line-height:1.2;white-space:normal;word-break:break-word;overflow-wrap:anywhere"><span style="display:inline-block;width:6px;height:6px;margin-right:6px;border-radius:999px;background:${colors.color};vertical-align:middle"></span>${text}</span>`;
}

function weeklyMailProgressBar(value: number) {
  return `<span style="display:block;width:100%;min-width:0;white-space:normal"><span style="display:inline-block;width:76px;max-width:70%;height:8px;margin-right:6px;overflow:hidden;border-radius:999px;background:#e5e7eb;vertical-align:middle"><span style="display:block;width:${value}%;height:100%;border-radius:999px;background:#2563eb"></span></span><strong style="color:#111827;font-size:12px;font-weight:800;white-space:nowrap">${value}%</strong></span>`;
}

function isWeeklyMailProgressMetricLabel(value: string) {
  const normalized = stripInlineMarkdownText(value).replace(/\s/g, "");
  return /进度|使用率|完成率|完成度|占比|达成率|百分比/.test(normalized);
}

function shouldRenderWeeklyMailProgressCell(header: string, cell: string, rowLabel = "") {
  const normalizedHeader = stripInlineMarkdownText(header).replace(/\s/g, "");
  if (normalizedHeader === "指标") return false;
  return extractPercent(cell) !== null && (isWeeklyMailProgressMetricLabel(header) || isWeeklyMailProgressMetricLabel(rowLabel));
}

function shouldRenderWeeklyMailStatusCell(header: string, rowLabel = "") {
  const normalizedHeader = stripInlineMarkdownText(header).replace(/\s/g, "");
  const normalizedRowLabel = stripInlineMarkdownText(rowLabel).replace(/\s/g, "");
  if (normalizedHeader === "指标") return false;
  return normalizedHeader.includes("状态") || normalizedHeader === "验收" || normalizedHeader === "等级" || normalizedRowLabel.includes("状态");
}

function renderWeeklyMailTableCell(header: string, cell: string, rowLabel = "") {
  const percent = extractPercent(cell);
  if (percent !== null && shouldRenderWeeklyMailProgressCell(header, cell, rowLabel)) return weeklyMailProgressBar(percent);
  if (cell && shouldRenderWeeklyMailStatusCell(header, rowLabel)) return weeklyMailStatusPill(cell);
  return inlineMarkdownToHtml(cell);
}

function isMarkdownTableStart(lines: string[], index: number) {
  return lines[index]?.includes("|") && markdownTableSeparatorPattern.test(lines[index + 1] || "");
}

function isMailBlockStart(lines: string[], index: number) {
  const line = lines[index] || "";
  return !line.trim() || /^报告日期：|^统计周期：/.test(line.trim()) || /^#{1,4}\s+/.test(line) || /^\d+[.)]\s+/.test(line) || /^[-*]\s+/.test(line) || isMarkdownTableStart(lines, index);
}

function countWeeklyMailRowsInSection(content: string, sectionKeyword: string) {
  const lines = content.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^#{1,4}\s+/.test(line.trim()) && line.includes(sectionKeyword));
  if (headingIndex < 0) return 0;
  const tableIndex = lines.findIndex((line, index) => index > headingIndex && isMarkdownTableStart(lines, index));
  if (tableIndex < 0) return 0;
  let index = tableIndex + 2;
  let count = 0;
  while (index < lines.length && lines[index].includes("|") && !markdownTableSeparatorPattern.test(lines[index])) {
    const row = parseMarkdownTableRow(lines[index]);
    if (!/^暂无$/.test(stripInlineMarkdownText(row[0] || ""))) count += 1;
    index += 1;
  }
  return count;
}

function weeklyMailRiskStats(content: string) {
  const lines = content.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^#{1,4}\s+/.test(line.trim()) && line.includes("风险"));
  if (headingIndex < 0) return { riskCount: 0, issueCount: 0, openRiskIssueCount: 0, totalRiskIssueCount: 0 };
  const tableIndex = lines.findIndex((line, index) => index > headingIndex && isMarkdownTableStart(lines, index));
  if (tableIndex < 0) return { riskCount: 0, issueCount: 0, openRiskIssueCount: 0, totalRiskIssueCount: 0 };
  let index = tableIndex + 2;
  let riskCount = 0;
  let issueCount = 0;
  let openRiskIssueCount = 0;
  while (index < lines.length && lines[index].includes("|") && !markdownTableSeparatorPattern.test(lines[index])) {
    const row = parseMarkdownTableRow(lines[index]);
    const kind = stripInlineMarkdownText(row[0] || "");
    const status = stripInlineMarkdownText(row[3] || "");
    if (!/^暂无$/.test(kind)) {
      if (kind.includes("风险")) riskCount += 1;
      if (kind.includes("问题")) issueCount += 1;
      if (status !== "关闭") openRiskIssueCount += 1;
    }
    index += 1;
  }
  return { riskCount, issueCount, openRiskIssueCount, totalRiskIssueCount: riskCount + issueCount };
}

function extractWeeklyMailVisualStats(content: string) {
  const progressMatch = content.match(/整体进度\s+\*\*(\d+(?:\.\d+)?)%\*\*/);
  const fallbackProgressMatch = content.match(/整体进度\s*(\d+(?:\.\d+)?)%/);
  const statusMatch = content.match(/项目状态为\s+\*\*([^*]+)\*\*/);
  const taskCompletionMatch = content.match(/任务完成情况：已完成\s+(\d+)\/(\d+)\s+项，\s*(?:(\d+)\s*个交付物未更新状态|开放\s+(\d+)\s+项)/);
  const thisWeekMatch = content.match(/本周已纳入\s+(\d+)\s+个/);
  const nextWeekMatch = content.match(/下周计划推进\s+(\d+)\s+个/);
  const progress = Number(progressMatch?.[1] || fallbackProgressMatch?.[1] || 0);
  const doneCount = Number(taskCompletionMatch?.[1] || 0);
  const totalCount = Number(taskCompletionMatch?.[2] || 0);
  const riskStats = weeklyMailRiskStats(content);
  return {
    progress: Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : 0,
    status: statusMatch?.[1] || "未维护",
    doneCount,
    totalCount,
    openCount: Number(taskCompletionMatch?.[4] || Math.max(0, totalCount - doneCount)),
    pendingDeliverableCount: Number(taskCompletionMatch?.[3] || 0),
    thisWeekCount: Number(thisWeekMatch?.[1] || 0),
    nextWeekCount: Number(nextWeekMatch?.[1] || 0),
    ...riskStats,
  };
}

function weeklyMailVisualSummary(content: string) {
  const stats = extractWeeklyMailVisualStats(content);
  const bars = [
    ["本周任务", stats.thisWeekCount, stats.totalCount],
    ["下周任务", stats.nextWeekCount, stats.openCount],
    ["风险问题", stats.openRiskIssueCount, stats.totalRiskIssueCount],
  ] as const;
  const analysisBars = bars
    .map(([label, value, total]) => {
      const width = Math.max(6, Math.round((value / Math.max(1, total)) * 100));
      return `<tr><td style="width:58px;padding:3px 8px 3px 0;color:#6b7280;font-size:12px;white-space:normal;word-break:break-word">${escapeHtml(label)}</td><td style="padding:3px 0"><span style="display:block;height:7px;overflow:hidden;border-radius:999px;background:#e5e7eb"><span style="display:block;width:${width}%;height:100%;border-radius:999px;background:#14b8a6"></span></span></td><td style="width:44px;padding:3px 0 3px 8px;color:#374151;font-size:12px;font-weight:800;text-align:right">${value}/${total}</td></tr>`;
    })
    .join("");
  const baseCardStyle =
    "height:160px;min-height:160px;box-sizing:border-box;padding:10px 6px;border:1px solid #e5e7eb;border-radius:8px;background:#fbfdff;word-break:break-word;overflow-wrap:anywhere";
  const centeredCardStyle = `${baseCardStyle};text-align:center`;
  const centerCellStyle = "padding:0;text-align:center;vertical-align:middle";
  const analysisCellStyle = "padding:0;text-align:left;vertical-align:middle";
  const fillTableStyle = "width:100%;height:100%;border-collapse:collapse";
  return `<div style="width:100%;max-width:100%;margin:12px 0 16px"><table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;max-width:100%;border-collapse:collapse;table-layout:fixed"><tr><td style="width:33.333%;padding:0 4px 0 0;vertical-align:top"><div style="${centeredCardStyle}"><table role="presentation" cellspacing="0" cellpadding="0" style="${fillTableStyle}"><tr><td style="${centerCellStyle}"><div style="display:inline-block;width:84px;height:84px;border-radius:999px;background:conic-gradient(#2563eb ${stats.progress}%, #e5e7eb 0);text-align:center;vertical-align:middle"><div style="display:inline-block;width:62px;height:62px;margin-top:11px;border-radius:999px;background:#ffffff;text-align:center"><div style="padding-top:16px;color:#111827;font-size:20px;font-weight:800;line-height:1">${stats.progress}%</div><div style="margin-top:3px;color:#6b7280;font-size:10px;font-weight:700;line-height:1">整体进度</div></div></div><div style="margin-top:9px;color:#6b7280;font-size:12px;line-height:1.45">已完成 <strong style="color:#111827;font-weight:800">${stats.doneCount}/${stats.totalCount}</strong> 项，<strong style="color:#111827;font-weight:800">${stats.pendingDeliverableCount}</strong> 个交付物未更新状态</div></td></tr></table></div></td><td style="width:33.333%;padding:0 4px;vertical-align:top"><div style="${centeredCardStyle}"><table role="presentation" cellspacing="0" cellpadding="0" style="${fillTableStyle}"><tr><td style="${centerCellStyle}"><div style="margin:0 0 10px;color:#6b7280;font-size:12px">项目状态</div>${weeklyMailStatusPill(stats.status)}<div style="margin-top:10px;color:#6b7280;font-size:12px;line-height:1.45">风险 ${stats.riskCount} 个，问题 ${stats.issueCount} 个</div></td></tr></table></div></td><td style="width:33.333%;padding:0 0 0 4px;vertical-align:top"><div style="${baseCardStyle}"><table role="presentation" cellspacing="0" cellpadding="0" style="${fillTableStyle}"><tr><td style="${analysisCellStyle}"><div style="margin-bottom:8px;color:#6b7280;font-size:12px">本周分析</div><table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;max-width:100%;border-collapse:collapse;table-layout:fixed">${analysisBars}</table></td></tr></table></div></td></tr></table></div>`;
}

function markdownToMailHtml(content: string) {
  const lines = content.split(/\r?\n/);
  const html: string[] = [];
  let inList = false;
  const closeList = () => {
    if (!inList) return;
    html.push("</ul>");
    inList = false;
  };
  let index = 0;
  let currentHeading = "";
  let visualSummaryInserted = false;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      index += 1;
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      closeList();
      const header = parseMarkdownTableRow(lines[index]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|") && !markdownTableSeparatorPattern.test(lines[index])) {
        rows.push(parseMarkdownTableRow(lines[index]));
        index += 1;
      }
      html.push(`<div style="width:100%;max-width:100%;margin:12px 0 18px;border:1px solid #dbe6f3;border-radius:8px;background:#ffffff">`);
      html.push(`<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;max-width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px;line-height:1.5">`);
      html.push(`<thead><tr>`);
      for (const cell of header) {
        html.push(`<th style="padding:8px 8px;border-bottom:1px solid #dbe6f3;background:#f6f9fd;color:#52677f;font-size:12px;font-weight:700;text-align:left;vertical-align:top;white-space:normal;word-break:break-word;overflow-wrap:anywhere">${inlineMarkdownToHtml(cell)}</th>`);
      }
      html.push(`</tr></thead><tbody>`);
      for (const row of rows) {
        html.push(`<tr>`);
        for (let cellIndex = 0; cellIndex < header.length; cellIndex += 1) {
          html.push(`<td style="padding:8px 8px;border-bottom:1px solid #e8eef6;color:#28384d;text-align:left;vertical-align:top;word-break:break-word;overflow-wrap:anywhere">${renderWeeklyMailTableCell(header[cellIndex] || "", row[cellIndex] || "", row[0] || "")}</td>`);
        }
        html.push(`</tr>`);
      }
      html.push(`</tbody></table></div>`);
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      const title = inlineMarkdownToHtml(heading[2]);
      currentHeading = heading[2];
      if (level === 1) {
        html.push(`<div style="margin:0 0 16px;padding:18px 20px;border:1px solid #dbe6f3;border-left:4px solid #3f73d8;border-radius:8px;background:#ffffff">`);
        html.push(`<div style="margin:0 0 6px;color:#3f73d8;font-size:12px;font-weight:700">项目周报</div>`);
        html.push(`<h1 style="margin:0;color:#1f2b3b;font-size:24px;line-height:1.28;font-weight:800">${title}</h1>`);
        html.push(`</div>`);
      } else if (level === 2) {
        html.push(`<h2 style="margin:20px 0 10px;padding-left:10px;border-left:4px solid #1797b6;color:#223047;font-size:17px;line-height:1.35;font-weight:800">${title}</h2>`);
      } else {
        html.push(`<h3 style="margin:14px 0 8px;color:#34465f;font-size:14px;line-height:1.35;font-weight:700">${title}</h3>`);
      }
      index += 1;
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (!inList) {
        html.push(`<ul style="margin:8px 0 16px;padding-left:22px;color:#34465f">`);
        inList = true;
      }
      html.push(`<li style="margin:0 0 7px">${inlineMarkdownToHtml(bullet[1])}</li>`);
      index += 1;
      continue;
    }

    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      closeList();
      const items: string[] = [];
      while (index < lines.length) {
        const match = lines[index].trim().match(/^\d+[.)]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      html.push(`<ol style="margin:8px 0 16px;padding-left:22px;color:#34465f">`);
      for (const item of items) html.push(`<li style="margin:0 0 7px">${inlineMarkdownToHtml(item)}</li>`);
      html.push(`</ol>`);
      continue;
    }

    closeList();
    const paragraph = [trimmed];
    index += 1;
    while (index < lines.length && !isMailBlockStart(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    const text = paragraph.join(" ").trim();
    const meta = /^报告日期：|^统计周期：/.test(text);
    html.push(
      meta
        ? `<p style="display:inline-block;margin:0 8px 8px 0;padding:5px 9px;border:1px solid #dbe6f3;border-radius:6px;background:#ffffff;color:#58708b;font-size:12px;font-weight:700">${inlineMarkdownToHtml(text)}</p>`
        : `<p style="margin:0 0 10px;color:#34465f;font-size:14px;line-height:1.7">${inlineMarkdownToHtml(text)}</p>`,
    );
    if (!meta && !visualSummaryInserted && /执行摘要/.test(currentHeading)) {
      html.push(weeklyMailVisualSummary(content));
      visualSummaryInserted = true;
    }
  }
  closeList();
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body style="width:100%;margin:0;padding:0;background:#ffffff;-webkit-text-size-adjust:100%;text-size-adjust:100%"><div style="width:100%;max-width:100%;margin:0;padding:0;background:#ffffff"><div style="width:100%;max-width:100%;margin:0;padding:12px 10px;border:0;background:#ffffff;box-sizing:border-box;font-family:Segoe UI,Microsoft YaHei,Arial,sans-serif;color:#263445;line-height:1.65;word-break:break-word;overflow-wrap:anywhere">${html.join("\n")}</div></div></body></html>`;
}

async function buildRawMail(config: EmailConfig, payload: EmailDraftPayload) {
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "unix",
  } as any);
  const info = (await transport.sendMail({
    from: {
      name: String(config.senderName || "").trim() || String(config.email || "").trim(),
      address: String(config.email || "").trim(),
    },
    to: parseEmailList(String(payload.to || "")).join(", "),
    cc: parseEmailList(String(payload.cc || "")).join(", ") || undefined,
    subject: String(payload.subject || "").trim(),
    text: String(payload.content || ""),
    html: String(payload.htmlContent || "").trim() || markdownToMailHtml(String(payload.content || "")),
    date: new Date(),
  })) as any;
  const message = info.message;
  if (Buffer.isBuffer(message)) return message;
  if (typeof message === "string") return Buffer.from(message, "utf8");
  throw new Error("邮件内容生成失败。");
}

async function saveDraftToMailbox(config: EmailConfig, payload: EmailDraftPayload) {
  validateEmailDraftRequest(config, payload);
  const client = new ImapFlow({
    host: String(config.imapHost || "").trim(),
    port: Number(config.imapPort || 993),
    secure: config.imapSecure !== false,
    auth: {
      user: String(config.username || "").trim(),
      pass: String(config.password || ""),
    },
    logger: false,
  });
  await client.connect();
  try {
    const rawMail = await buildRawMail(config, payload);
    const mailbox = String(config.draftsMailbox || "Drafts").trim();
    const result = await client.append(mailbox, rawMail, ["\\Draft"], new Date());
    if (result === false) throw new Error("IMAP 服务器未接受草稿写入。");
    return `邮件草稿已保存到 ${mailbox}。`;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

function beginSse(res: any) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream;charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.socket?.setTimeout?.(0);
  res.flushHeaders?.();
}

function sendSseEvent(res: any, event: "delta" | "done" | "error", data: unknown) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  res.flush?.();
}

async function streamAiProxyResponse(
  res: any,
  config: any,
  messages: ChatMessage[],
  options: { maxTokens?: number; timeoutMs?: number },
) {
  beginSse(res);
  let content = "";
  try {
    const onDelta: StreamDeltaHandler = (delta, nextContent) => {
      content = nextContent;
      sendSseEvent(res, "delta", { delta });
    };
    content =
      config.provider === "ollama"
        ? await callOllamaStreaming(config, messages, { timeoutMs: options.timeoutMs }, onDelta)
        : await callOpenAiCompatibleStreaming(config, messages, options, onDelta);
    sendSseEvent(res, "done", { ok: true, content });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI 代理流式调用失败。";
    sendSseEvent(res, "error", { ok: false, error: message });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

function getBackendDb() {
  if (backendDb) return backendDb;
  mkdirSync(path.dirname(BACKEND_DB_FILE), { recursive: true });
  backendDb = new Database(BACKEND_DB_FILE);
  backendDb.pragma("journal_mode = WAL");
  backendDb.pragma("foreign_keys = ON");
  ensureBackendSchema(backendDb);
  return backendDb;
}

function ensureBackendSchema(db: BackendDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_delivery_workflows (
      project_id TEXT PRIMARY KEY,
      sow_content TEXT NOT NULL DEFAULT '',
      sow_file_name TEXT NOT NULL DEFAULT '',
      sow_updated_at TEXT NOT NULL DEFAULT '',
      resource_inputs_json TEXT NOT NULL,
      person_day_json TEXT NOT NULL,
      hardware_json TEXT NOT NULL,
      wbs_json TEXT NOT NULL,
      implementation_json TEXT NOT NULL,
      project_flow_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_generation_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      input_snapshot_json TEXT NOT NULL DEFAULT '{}',
      output_content TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      completed_at TEXT NOT NULL DEFAULT ''
    );
  `);
}

function loadBackendState() {
  const db = getBackendDb();
  const row = db.prepare("SELECT value FROM app_state WHERE key = ? LIMIT 1").get(STATE_KEY) as { value?: string } | undefined;
  return row?.value ? JSON.parse(row.value) : null;
}

function mergeStoredAiModelConfigs(incomingState: any, storedState: any) {
  const incomingConfigs = Array.isArray(incomingState?.aiModelConfigs) ? incomingState.aiModelConfigs : [];
  const storedConfigs = Array.isArray(storedState?.aiModelConfigs) ? storedState.aiModelConfigs : [];
  if (!incomingConfigs.length || !storedConfigs.length) return incomingState;

  const storedById = new Map(storedConfigs.map((config: any) => [String(config.id || ""), config]));
  const incomingIds = new Set(incomingConfigs.map((config: any) => String(config.id || "")));
  const mergedConfigs = incomingConfigs.map((config: any) => {
    const stored = storedById.get(String(config.id || ""));
    if (!stored?.apiKey || String(config.apiKey || "").trim()) return config;
    return { ...config, apiKey: stored.apiKey };
  });
  for (const stored of storedConfigs) {
    const id = String(stored?.id || "");
    if (id && !incomingIds.has(id)) {
      mergedConfigs.push({ ...stored, isDefault: false });
    }
  }
  return { ...incomingState, aiModelConfigs: mergedConfigs };
}

function upsertWorkflowRows(db: BackendDatabase, workflows: any[] = []) {
  const knownProjectIds = workflows.map((workflow) => String(workflow.projectId || "")).filter(Boolean);
  const upsert = db.prepare(`
    INSERT INTO ai_delivery_workflows (
      project_id, sow_content, sow_file_name, sow_updated_at, resource_inputs_json,
      person_day_json, hardware_json, wbs_json, implementation_json, project_flow_json, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      sow_content = excluded.sow_content,
      sow_file_name = excluded.sow_file_name,
      sow_updated_at = excluded.sow_updated_at,
      resource_inputs_json = excluded.resource_inputs_json,
      person_day_json = excluded.person_day_json,
      hardware_json = excluded.hardware_json,
      wbs_json = excluded.wbs_json,
      implementation_json = excluded.implementation_json,
      project_flow_json = excluded.project_flow_json,
      updated_at = excluded.updated_at
  `);
  const now = new Date().toISOString();
  for (const workflow of workflows) {
    if (!workflow?.projectId) continue;
    upsert.run(
      workflow.projectId,
      workflow.sow?.content || "",
      workflow.sow?.fileName || "",
      workflow.sow?.updatedAt || "",
      JSON.stringify(workflow.resourceInputs || {}),
      JSON.stringify(workflow.personDayAssessment || {}),
      JSON.stringify(workflow.hardwareAssessment || {}),
      JSON.stringify(workflow.wbsPlan || {}),
      JSON.stringify(workflow.implementationPlan || {}),
      JSON.stringify(workflow.projectFlow || {}),
      now,
    );
  }
  if (knownProjectIds.length) {
    const placeholders = knownProjectIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM ai_delivery_workflows WHERE project_id NOT IN (${placeholders})`).run(...knownProjectIds);
  } else {
    db.prepare("DELETE FROM ai_delivery_workflows").run();
  }
}

function saveBackendState(state: any) {
  const db = getBackendDb();
  const now = new Date().toISOString();
  const storedState = loadBackendState();
  const stateToSave = mergeStoredAiModelConfigs(state, storedState);
  const save = db.transaction(() => {
    db.prepare(`
      INSERT INTO app_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(STATE_KEY, JSON.stringify(stateToSave), now);
    upsertWorkflowRows(db, stateToSave?.deliveryWorkflows || []);
  });
  save();
}

function loadWorkflowRows() {
  const db = getBackendDb();
  return db.prepare("SELECT * FROM ai_delivery_workflows ORDER BY updated_at DESC").all();
}

function upsertGenerationRun(run: any) {
  const db = getBackendDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ai_generation_runs (
      id, project_id, kind, model, status, input_snapshot_json, output_content, error_message, created_at, completed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project_id = excluded.project_id,
      kind = excluded.kind,
      model = excluded.model,
      status = excluded.status,
      input_snapshot_json = excluded.input_snapshot_json,
      output_content = excluded.output_content,
      error_message = excluded.error_message,
      completed_at = excluded.completed_at
  `).run(
    String(run.id || crypto.randomUUID()),
    String(run.projectId || ""),
    String(run.kind || ""),
    String(run.model || ""),
    String(run.status || "running"),
    JSON.stringify(run.inputSnapshot || {}),
    String(run.outputContent || ""),
    String(run.errorMessage || ""),
    String(run.createdAt || now),
    String(run.completedAt || ""),
  );
}

function normalizeAiModelConfig(config: any) {
  const model = String(config.model || "gpt-5.5");
  return {
    id: String(config.id || "ai-gpt55-proxy"),
    name: String(config.name || "GPT-5.5 国内代理"),
    provider: String(config.provider || "openai-compatible"),
    baseUrl: String(config.baseUrl || GPT55_PROXY_URL),
    model,
    apiKey: String(config.apiKey || ""),
    temperature: isKimiFixedTemperatureModel(model) ? 1 : typeof config.temperature === "number" ? config.temperature : 0.2,
    isDefault: true,
    allowRemoteRequest: Boolean(config.allowRemoteRequest),
    lastHealth: String(config.lastHealth || "已从 JSON 配置文件加载"),
  };
}

async function readAiModelConfigFile() {
  try {
    const raw = await readFile(AI_MODEL_CONFIG_FILE, "utf8");
    const data = JSON.parse(raw);
    const config = data?.config || data;
    if (!config || typeof config !== "object") return null;
    return normalizeAiModelConfig(config);
  } catch (error) {
    if ((error as any)?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAiModelConfigFile(config: any) {
  const normalized = normalizeAiModelConfig(config);
  await mkdir(path.dirname(AI_MODEL_CONFIG_FILE), { recursive: true });
  await writeFile(
    AI_MODEL_CONFIG_FILE,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        config: normalized,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return normalized;
}

function normalizeOpenAiEndpoints(baseUrl: string, model: string): OpenAiEndpointCandidate[] {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return [{ kind: "chat", endpoint: base }];
  if (base.endsWith("/responses")) return [{ kind: "responses", endpoint: base }];

  const host = (() => {
    try {
      return new URL(base).host;
    } catch {
      return "";
    }
  })();
  const path = (() => {
    try {
      return new URL(base).pathname;
    } catch {
      return base;
    }
  })();
  if (host === "api.moonshot.cn") {
    const origin = new URL(base).origin;
    const root = path === "/" ? `${origin}/v1` : base;
    return [{ kind: "chat", endpoint: `${root.replace(/\/+$/, "")}/chat/completions` }];
  }
  const looksLikeCodexGateway = host === "api.aicodemirror.com" || /\/backend-api\/codex$/.test(path) || /\/codex$/.test(path);
  const candidates = looksLikeCodexGateway
    ? [
        { kind: "chat" as const, endpoint: GPT55_PROXY_URL },
        { kind: "chat" as const, endpoint: `${base}/v1/chat/completions` },
        { kind: "chat" as const, endpoint: `${base}/chat/completions` },
      ]
    : [
        { kind: "chat" as const, endpoint: `${base}/chat/completions` },
        { kind: "responses" as const, endpoint: `${base}/responses` },
      ];

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.endpoint)) return false;
    seen.add(candidate.endpoint);
    return true;
  });
}

function normalizeOllamaEndpoint(baseUrl: string) {
  const base = baseUrl.replace(/\/$/, "");
  if (base.endsWith("/api/chat")) return base;
  if (base.endsWith("/api")) return `${base}/chat`;
  return `${base}/api/chat`;
}

function endpointHost(endpoint: string) {
  try {
    const url = new URL(endpoint);
    return url.host;
  } catch {
    return endpoint;
  }
}

function diagnosticMessage(error: unknown) {
  const anyError = error as any;
  const cause = anyError?.cause || anyError;
  const code = cause?.code || cause?.name;
  const name = cause?.name || anyError?.name;
  const message = cause?.message || anyError?.message || "未知网络错误";

  if (code === "ENOTFOUND") return "DNS 解析失败，Base URL 的域名无法解析。";
  if (code === "ECONNREFUSED") return "目标服务拒绝连接，请确认模型服务已启动、端口正确、网络可达。";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "AbortError" || name === "AbortError") return "连接超时，请检查网络代理、防火墙或模型服务响应时间。";
  if (code === "ECONNRESET") return "连接被远端重置，可能是代理服务、中间网关或 TLS 握手中断。";
  if (["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"].includes(code)) {
    return "TLS 证书校验失败，请检查 HTTPS 证书或改用可信代理地址。";
  }
  return `${message}${code ? `（${code}）` : ""}`;
}

function clampMaxTokens(value: unknown, fallback = DEFAULT_MAX_TOKENS) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(16, Math.min(8192, Math.floor(value)));
}

function clampTimeoutMs(value: unknown, fallback = 60_000) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(10_000, Math.min(360_000, Math.floor(value)));
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithDiagnostics(label: string, endpoint: string, init: RequestInit, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(endpoint, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(`${label} 网络连接失败：${diagnosticMessage(error)}目标：${endpointHost(endpoint)}。`);
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAiCompatible(config: any, messages: ChatMessage[], options: { maxTokens?: number; timeoutMs?: number } = {}) {
  const endpoints = normalizeOpenAiEndpoints(config.baseUrl, config.model || "");
  const errors: string[] = [];
  const timeoutMs = clampTimeoutMs(options.timeoutMs);
  const maxTokens = clampMaxTokens(options.maxTokens);
  for (const candidate of endpoints) {
    const streamChat = candidate.kind === "chat" && shouldStreamChatCompletion(config, candidate.endpoint);
    const attempts = streamChat ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetchWithDiagnostics("OpenAI-compatible", candidate.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(buildOpenAiPayload(candidate.kind, config, messages, maxTokens, streamChat)),
        }, timeoutMs);

        const raw = await response.text();
        if (!response.ok) {
          const detail = normalizeResponseError(raw);
          const errorMessage = `模型调用失败：${response.status}${detail ? ` ${detail}` : ""}`;
          if (shouldTryNextEndpoint(response.status, detail, candidate.endpoint, endpoints.length)) {
            errors.push(`${endpointHost(candidate.endpoint)}：${errorMessage}`);
            break;
          }
          if (attempt < attempts && shouldRetryModelCall(errorMessage)) {
            await wait(900);
            continue;
          }
          throw new Error(errorMessage);
        }

        const data = parseJsonResponse(raw, candidate.endpoint);
        const content = extractModelContent(data);
        if (content) return content;
        errors.push(`${endpointHost(candidate.endpoint)}：模型返回为空。`);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : "模型调用失败。";
        if (/模型调用失败：401|Invalid API Key|Unauthorized/i.test(message)) {
          throw new Error(message);
        }
        if (attempt < attempts && shouldRetryModelCall(message)) {
          await wait(900);
          continue;
        }
        errors.push(message);
        break;
      }
    }
  }

  throw new Error(errors.length ? errors.join("；") : "模型调用失败。");
}

async function callOpenAiCompatibleStreaming(
  config: any,
  messages: ChatMessage[],
  options: { maxTokens?: number; timeoutMs?: number } = {},
  onDelta: StreamDeltaHandler,
) {
  const endpoints = normalizeOpenAiEndpoints(config.baseUrl, config.model || "");
  const errors: string[] = [];
  const timeoutMs = clampTimeoutMs(options.timeoutMs);
  const maxTokens = clampMaxTokens(options.maxTokens);

  for (const candidate of endpoints) {
    const streamChat = candidate.kind === "chat";
    const attempts = streamChat ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetchWithDiagnostics("OpenAI-compatible", candidate.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(buildOpenAiPayload(candidate.kind, config, messages, maxTokens, streamChat)),
        }, timeoutMs);

        if (!response.ok) {
          const raw = await response.text();
          const detail = normalizeResponseError(raw);
          const errorMessage = `模型调用失败：${response.status}${detail ? ` ${detail}` : ""}`;
          if (shouldTryNextEndpoint(response.status, detail, candidate.endpoint, endpoints.length)) {
            errors.push(`${endpointHost(candidate.endpoint)}：${errorMessage}`);
            break;
          }
          if (attempt < attempts && shouldRetryModelCall(errorMessage)) {
            await wait(900);
            continue;
          }
          throw new Error(errorMessage);
        }

        const content = streamChat
          ? await readOpenAiCompatibleStream(response, candidate.endpoint, onDelta)
          : await readOpenAiCompatibleJson(response, candidate.endpoint, onDelta);
        if (content) return content;
        errors.push(`${endpointHost(candidate.endpoint)}：模型返回为空。`);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : "模型调用失败。";
        if (/模型调用失败：401|Invalid API Key|Unauthorized/i.test(message)) {
          throw new Error(message);
        }
        if (attempt < attempts && shouldRetryModelCall(message)) {
          await wait(900);
          continue;
        }
        errors.push(message);
        break;
      }
    }
  }

  throw new Error(errors.length ? errors.join("；") : "模型调用失败。");
}

async function callOllama(config: any, messages: ChatMessage[], options: { timeoutMs?: number } = {}) {
  const endpoint = normalizeOllamaEndpoint(config.baseUrl);
  const response = await fetchWithDiagnostics("Ollama", endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model || "llama3.1",
      messages,
      stream: false,
      options: {
        temperature: config.temperature,
      },
    }),
  }, clampTimeoutMs(options.timeoutMs));

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Ollama 调用失败：${response.status} ${normalizeResponseError(raw)}`);
  }

  const data = parseJsonResponse(raw, endpoint);
  const content = extractModelContent(data);
  if (!content) throw new Error("Ollama 返回为空。");
  return content;
}

async function callOllamaStreaming(
  config: any,
  messages: ChatMessage[],
  options: { timeoutMs?: number } = {},
  onDelta: StreamDeltaHandler,
) {
  const endpoint = normalizeOllamaEndpoint(config.baseUrl);
  const response = await fetchWithDiagnostics("Ollama", endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model || "llama3.1",
      messages,
      stream: true,
      options: {
        temperature: config.temperature,
      },
    }),
  }, clampTimeoutMs(options.timeoutMs));

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`Ollama 调用失败：${response.status} ${normalizeResponseError(raw)}`);
  }

  if (!response.body) {
    const raw = await response.text();
    const data = parseJsonResponse(raw, endpoint);
    const content = extractModelContent(data);
    if (content) onDelta(content, content);
    return content;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";

  const readLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    const data = JSON.parse(trimmed);
    if (data?.error) throw new Error(String(data.error));
    const delta = data?.message?.content || data?.response || "";
    if (delta) {
      content += delta;
      onDelta(delta, content);
    }
    return Boolean(data?.done);
  };

  while (true) {
    const { value, done } = await reader.read();
    const chunk = value ? decoder.decode(value, { stream: !done }) : "";
    if (chunk) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (readLine(line)) return content;
      }
    }
    if (done) break;
  }

  const trailing = decoder.decode();
  if (trailing) buffer += trailing;
  if (buffer.trim()) readLine(buffer);
  return content;
}

function shouldStreamChatCompletion(config: any, endpoint: string) {
  return isGpt5Model(config.model || "") && endpoint.includes("api.aicodemirror.com");
}

function buildOpenAiPayload(
  kind: OpenAiEndpointCandidate["kind"],
  config: any,
  messages: ChatMessage[],
  maxTokens = DEFAULT_MAX_TOKENS,
  streamChat = false,
) {
  const model = config.model || "gpt-5.5";
  const tokenLimit = openAiCompatibleTokenLimit(model, clampMaxTokens(maxTokens));
  if (kind === "responses") {
    const body: Record<string, unknown> = {
      model,
      input: messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    };
    if (isGpt5Model(model)) {
      body.max_output_tokens = tokenLimit;
    } else {
      body.max_tokens = tokenLimit;
      const temperature = openAiCompatibleTemperature(config, model);
      if (typeof temperature === "number") body.temperature = temperature;
    }
    return body;
  }
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: streamChat,
  };
  if (isGpt5Model(model)) {
    body.max_completion_tokens = tokenLimit;
  } else {
    body.max_tokens = tokenLimit;
    const temperature = openAiCompatibleTemperature(config, model);
    if (typeof temperature === "number") body.temperature = temperature;
  }
  return body;
}

function parseJsonResponse(raw: string, endpoint: string) {
  if (/^\s*data:/m.test(raw)) {
    return { output_text: extractSseContent(raw) };
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    const preview = raw.trim().slice(0, 220);
    const htmlHint = /^<!doctype|^<html/i.test(preview)
      ? "远端返回了 HTML 页面，不是模型 JSON。请检查 Base URL 是否应指向 /responses 或 /v1/chat/completions。"
      : `远端返回非 JSON：${preview || "空响应"}`;
    throw new Error(`${htmlHint} 目标：${endpointHost(endpoint)}。`);
  }
}

function extractSseContent(raw: string) {
  const parts: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const data = JSON.parse(payload);
      const chunk = extractModelContent(data);
      if (chunk) {
        parts.push(chunk);
        continue;
      }
      const choice = data?.choices?.[0];
      const deltaContent = choice?.delta?.content;
      if (typeof deltaContent === "string") {
        parts.push(deltaContent);
      } else if (Array.isArray(deltaContent)) {
        parts.push(
          deltaContent
            .map((item: any) => (typeof item === "string" ? item : item?.text || item?.content || ""))
            .join(""),
        );
      } else if (typeof data?.delta === "string") {
        parts.push(data.delta);
      }
    } catch {
      continue;
    }
  }
  return parts.join("").trim();
}

async function readOpenAiCompatibleJson(response: Response, endpoint: string, onDelta: StreamDeltaHandler) {
  const raw = await response.text();
  const data = parseJsonResponse(raw, endpoint);
  const content = extractModelContent(data);
  if (content) onDelta(content, content);
  return content;
}

async function readOpenAiCompatibleStream(response: Response, endpoint: string, onDelta: StreamDeltaHandler) {
  let content = "";
  let errorMessage = "";
  const raw = await readEventStream(response, (_eventName, payload) => {
    if (!payload) return false;
    if (payload === "[DONE]") return true;
    try {
      const data = JSON.parse(payload);
      const error = extractModelError(data);
      if (error) {
        errorMessage = error;
        return true;
      }
      const delta = extractModelStreamDelta(data);
      if (delta) {
        content += delta;
        onDelta(delta, content);
      }
    } catch {
      return false;
    }
    return false;
  });

  if (errorMessage) throw new Error(errorMessage);
  if (content) return content;

  const data = parseJsonResponse(raw || "", endpoint);
  content = extractModelContent(data);
  if (content) onDelta(content, content);
  return content;
}

async function readEventStream(response: Response, onEvent: (eventName: string, payload: string) => boolean | void) {
  if (!response.body) return response.text();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let raw = "";
  let stop = false;

  while (!stop) {
    const { value, done } = await reader.read();
    const chunk = value ? decoder.decode(value, { stream: !done }) : "";
    if (chunk) {
      raw += chunk;
      buffer += chunk;
      const split = splitSseBuffer(buffer);
      buffer = split.rest;
      for (const eventText of split.events) {
        const event = parseSseEvent(eventText);
        if (onEvent(event.name, event.data)) {
          stop = true;
          break;
        }
      }
    }
    if (done) break;
  }

  const trailing = decoder.decode();
  if (trailing) {
    raw += trailing;
    buffer += trailing;
  }

  if (!stop && buffer.trim()) {
    const event = parseSseEvent(buffer);
    if (event.data) onEvent(event.name, event.data);
  }

  return raw;
}

function splitSseBuffer(buffer: string) {
  const events: string[] = [];
  const boundary = /\r?\n\r?\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(buffer))) {
    events.push(buffer.slice(start, match.index));
    start = boundary.lastIndex;
  }
  return { events, rest: buffer.slice(start) };
}

function parseSseEvent(eventText: string) {
  let name = "message";
  const dataLines: string[] = [];
  for (const line of eventText.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      name = line.slice(6).trim() || "message";
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  return { name, data: dataLines.join("\n").trim() };
}

function extractModelStreamDelta(data: any): string {
  const choice = data?.choices?.[0];
  const deltaContent = choice?.delta?.content;
  if (typeof deltaContent === "string") return deltaContent;
  if (Array.isArray(deltaContent)) {
    return deltaContent.map((item: any) => (typeof item === "string" ? item : item?.text || item?.content || "")).join("");
  }
  if (typeof data?.delta === "string") return data.delta;
  if (typeof data?.text === "string" && /delta/i.test(String(data?.type || ""))) return data.text;
  return "";
}

function extractModelError(data: any) {
  const error = data?.error;
  if (typeof error === "string") return error;
  if (typeof error?.message === "string") return error.message;
  if (typeof data?.message === "string" && data?.type === "error") return data.message;
  return "";
}

function normalizeResponseError(raw: string) {
  if (!raw.trim()) return "";
  try {
    const data = JSON.parse(raw);
    const error = data?.error;
    if (typeof error === "string") return error.slice(0, 500);
    if (typeof error?.message === "string") return error.message.slice(0, 500);
    if (typeof data?.message === "string") return data.message.slice(0, 500);
  } catch {
    const preview = raw.trim().slice(0, 500);
    if (/^<!doctype|^<html/i.test(preview)) return "远端返回 HTML 页面，不是模型 API JSON。";
    return preview;
  }
  return raw.trim().slice(0, 500);
}

function shouldTryNextEndpoint(status: number, detail: string, endpoint: string, total: number) {
  if (total <= 1) return false;
  if (status === 404 || status === 405 || status === 501) return true;
  if (status === 400 && /not found|unknown|invalid endpoint|route|path|responses|chat/i.test(detail)) return true;
  if (/chat\/completions$/.test(endpoint) && !detail) return true;
  return false;
}

function shouldRetryModelCall(message: string) {
  return /ECONNRESET|连接被远端重置|连接超时|temporarily unavailable|Service temporarily unavailable|AbortError/i.test(message);
}

function extractModelContent(data: any): string {
  const choice = data?.choices?.[0];
  const messageContent = choice?.message?.content;
  const deltaContent = choice?.delta?.content;
  if (typeof messageContent === "string") return messageContent.trim();
  if (Array.isArray(messageContent)) {
    return messageContent
      .map((item) => (typeof item === "string" ? item : item?.text || item?.content || ""))
      .join("")
      .trim();
  }
  if (typeof deltaContent === "string") return deltaContent;
  if (Array.isArray(deltaContent)) {
    return deltaContent
      .map((item) => (typeof item === "string" ? item : item?.text || item?.content || ""))
      .join("");
  }
  if (typeof choice?.text === "string") return choice.text.trim();
  if (typeof data?.output_text === "string") return data.output_text.trim();
  if (typeof data?.delta === "string") return data.delta;
  if (Array.isArray(data?.output)) {
    return data.output
      .flatMap((item: any) => item?.content || [])
      .map((item: any) => item?.text || item?.content || "")
      .join("")
      .trim();
  }
  if (typeof data?.text === "string") return data.text.trim();
  if (typeof data?.message?.content === "string") return data.message.content.trim();
  if (typeof data?.response === "string") return data.response.trim();
  return "";
}

function validateAiProxyPayload(payload: any) {
  const config = payload.config || {};
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const requireProjectDataConsent = payload.requireProjectDataConsent ?? true;
  const maxTokens = clampMaxTokens(payload.maxTokens);
  const timeoutMs = clampTimeoutMs(payload.timeoutMs);

  if (config.provider === "local-simulated") throw new Error("本地模拟模型已禁用。请配置 OpenAI Compatible 或 Ollama 远程模型。");
  if (requireProjectDataConsent && !config.allowRemoteRequest) throw new Error("当前模型配置未允许发送项目数据到远程模型。");
  if (!String(config.baseUrl || "").trim()) throw new Error(config.provider === "ollama" ? "请先配置 Ollama Base URL。" : "请先配置 OpenAI-compatible 代理 Base URL。");
  if (config.provider === "openai-compatible" && !String(config.apiKey || "").trim()) throw new Error("请先配置 API Key。");
  if (!messages.length) throw new Error("AI 消息为空。");

  return { config, messages, requireProjectDataConsent, maxTokens, timeoutMs };
}

function aiProxyPlugin() {
  const handleAiProxyRequest = async (req: any, res: any) => {
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "只支持 POST 请求。" });
      return;
    }

    try {
      const payload = await readJsonBody(req);
      const stream = payload.stream === true;
      const { config, messages, maxTokens, timeoutMs } = validateAiProxyPayload(payload);
      if (stream) {
        await streamAiProxyResponse(res, config, messages, { maxTokens, timeoutMs });
        return;
      }
      const content =
        config.provider === "ollama"
          ? await callOllama(config, messages, { timeoutMs })
          : await callOpenAiCompatible(config, messages, { maxTokens, timeoutMs });
      sendJson(res, 200, { ok: true, content });
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 代理调用失败。";
      sendJson(res, 200, { ok: false, error: message });
    }
  };

  const handleAiConfigRequest = async (req: any, res: any) => {
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      if (req.method === "GET") {
        const config = await readAiModelConfigFile();
        sendJson(res, 200, { ok: true, config, path: AI_MODEL_CONFIG_FILE });
        return;
      }

      if (req.method === "POST" || req.method === "PUT") {
        const payload = await readJsonBody(req);
        const config = await writeAiModelConfigFile(payload.config || payload);
        sendJson(res, 200, { ok: true, config, path: AI_MODEL_CONFIG_FILE });
        return;
      }

      sendJson(res, 405, { ok: false, error: "只支持 GET / POST / PUT 请求。" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 配置文件读写失败。";
      sendJson(res, 200, { ok: false, error: message, path: AI_MODEL_CONFIG_FILE });
    }
  };

  const handleStateRequest = async (req: any, res: any) => {
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      if (req.method === "GET") {
        const state = loadBackendState();
        sendJson(res, 200, { ok: true, state, path: BACKEND_DB_FILE });
        return;
      }

      if (req.method === "POST" || req.method === "PUT") {
        const payload = await readJsonBody(req);
        if (!payload?.state || typeof payload.state !== "object") throw new Error("缺少 state 对象。");
        saveBackendState(payload.state);
        sendJson(res, 200, { ok: true, path: BACKEND_DB_FILE });
        return;
      }

      sendJson(res, 405, { ok: false, error: "只支持 GET / POST / PUT 请求。" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "状态存储失败。";
      sendJson(res, 200, { ok: false, error: message, path: BACKEND_DB_FILE });
    }
  };

  const handleAiWorkflowRequest = async (req: any, res: any) => {
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      if (req.method === "GET") {
        sendJson(res, 200, { ok: true, workflows: loadWorkflowRows(), path: BACKEND_DB_FILE });
        return;
      }

      if (req.method === "POST" || req.method === "PUT") {
        const payload = await readJsonBody(req);
        const workflow = payload.workflow;
        if (!workflow?.projectId) throw new Error("缺少 workflow.projectId。");
        const state = loadBackendState() || {};
        const workflows = Array.isArray(state.deliveryWorkflows) ? state.deliveryWorkflows : [];
        const exists = workflows.some((item: any) => item.projectId === workflow.projectId);
        const nextWorkflows = exists
          ? workflows.map((item: any) => (item.projectId === workflow.projectId ? workflow : item))
          : [...workflows, workflow];
        saveBackendState({ ...state, deliveryWorkflows: nextWorkflows });
        sendJson(res, 200, { ok: true, path: BACKEND_DB_FILE });
        return;
      }

      sendJson(res, 405, { ok: false, error: "只支持 GET / POST / PUT 请求。" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI工作流存储失败。";
      sendJson(res, 200, { ok: false, error: message, path: BACKEND_DB_FILE });
    }
  };

  const handleAiRunRequest = async (req: any, res: any) => {
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      if (req.method === "GET") {
        const rows = getBackendDb()
          .prepare("SELECT * FROM ai_generation_runs ORDER BY created_at DESC LIMIT 100")
          .all();
        sendJson(res, 200, { ok: true, runs: rows, path: BACKEND_DB_FILE });
        return;
      }

      if (req.method === "POST" || req.method === "PUT") {
        const payload = await readJsonBody(req);
        upsertGenerationRun(payload.run || payload);
        sendJson(res, 200, { ok: true, path: BACKEND_DB_FILE });
        return;
      }

      sendJson(res, 405, { ok: false, error: "只支持 GET / POST / PUT 请求。" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI生成记录存储失败。";
      sendJson(res, 200, { ok: false, error: message, path: BACKEND_DB_FILE });
    }
  };

  const handleEmailDraftRequest = async (req: any, res: any) => {
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "只支持 POST 请求。" });
      return;
    }

    try {
      const payload = await readJsonBody(req);
      const message = await saveDraftToMailbox(payload.config || {}, payload.payload || {});
      sendJson(res, 200, { ok: true, message });
    } catch (error) {
      const message = error instanceof Error ? error.message : "邮箱草稿保存失败。";
      sendJson(res, 200, { ok: false, error: message });
    }
  };

  return {
    name: "local-ai-proxy",
    configureServer(server: any) {
      server.middlewares.use("/api/state", handleStateRequest);
      server.middlewares.use("/api/ai/chat", handleAiProxyRequest);
      server.middlewares.use("/api/ai/config", handleAiConfigRequest);
      server.middlewares.use("/api/ai/workflows", handleAiWorkflowRequest);
      server.middlewares.use("/api/ai/runs", handleAiRunRequest);
      server.middlewares.use("/api/email/draft", handleEmailDraftRequest);
    },
    configurePreviewServer(server: any) {
      server.middlewares.use("/api/state", handleStateRequest);
      server.middlewares.use("/api/ai/chat", handleAiProxyRequest);
      server.middlewares.use("/api/ai/config", handleAiConfigRequest);
      server.middlewares.use("/api/ai/workflows", handleAiWorkflowRequest);
      server.middlewares.use("/api/ai/runs", handleAiRunRequest);
      server.middlewares.use("/api/email/draft", handleEmailDraftRequest);
    },
  };
}

export default defineConfig({
  base: "./",
  optimizeDeps: {
    entries: ["index.html"],
  },
  plugins: [react(), aiProxyPlugin()],
});
