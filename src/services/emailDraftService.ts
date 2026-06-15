import { invoke, isTauri } from "@tauri-apps/api/core";
import type { EmailConfig } from "../types";

export type EmailDraftPayload = {
  to: string;
  cc: string;
  subject: string;
  content: string;
  htmlContent?: string;
  displayTitle?: string;
};

type EmailDraftResponse = {
  ok?: boolean;
  message?: string;
  error?: string;
};

export function parseEmailList(value: string) {
  return value
    .split(/[;,，；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function validateEmailConfig(config: EmailConfig) {
  if (!config.email.trim()) return "请先在设置中填写发件邮箱。";
  if (!config.username.trim()) return "请先在设置中填写邮箱登录账号。";
  if (!config.password.trim()) return "请先在设置中填写客户端专用密码或授权码。";
  if (!config.imapHost.trim()) return "请先配置 IMAP 服务器。";
  if (!config.draftsMailbox.trim()) return "请先配置草稿箱目录。";
  return "";
}

export function validateEmailDraft(payload: EmailDraftPayload) {
  if (!parseEmailList(payload.to).length) return "请填写至少一个收件人。";
  if (!payload.subject.trim()) return "请填写邮件主题。";
  if (!payload.content.trim()) return "周报正文为空，无法保存草稿。";
  return "";
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
      parts.push(`<strong style="font-weight:700;color:#172033">${escapeHtml(token.slice(2, -2))}</strong>`);
    } else if (token.startsWith("~~")) {
      parts.push(`<s style="text-decoration:line-through;color:#6b7280">${escapeHtml(token.slice(2, -2))}</s>`);
    } else {
      parts.push(`<code style="padding:1px 5px;border:1px solid #d9e5f3;border-radius:4px;background:#f7fbff;color:#2563eb;font-size:12px">${escapeHtml(token.slice(1, -1))}</code>`);
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
  if (/需关注|关注|客户待确认|待确认|跟踪|中|待验收|待上传|进行|开发|实施/.test(status)) return { border: "#fde68a", bg: "#fffbeb", color: "#b45309" };
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
  return !line.trim() || /^#{1,4}\s+/.test(line) || /^\d+[.)]\s+/.test(line) || /^[-*]\s+/.test(line) || isMarkdownTableStart(lines, index);
}

function countWeeklyMailRowsInSection(content: string, sectionKeyword: string) {
  const lines = content.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^#{1,4}\s+/.test(line.trim()) && line.includes(sectionKeyword));
  if (headingIndex < 0) return 0;
  const tableIndex = lines.findIndex((line, index) => index > headingIndex && isMarkdownTableStart(lines, index));
  if (tableIndex < 0) {
    let index = headingIndex + 1;
    let count = 0;
    while (index < lines.length && !/^#{1,4}\s+/.test(lines[index].trim())) {
      if (/^[-*]\s+/.test(lines[index].trim()) && !/暂无/.test(lines[index])) count += 1;
      index += 1;
    }
    return count;
  }
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
  const headers = parseMarkdownTableRow(lines[tableIndex]).map(stripInlineMarkdownText);
  const statusIndex = headers.findIndex((header) => header.includes("状态"));
  while (index < lines.length && lines[index].includes("|") && !markdownTableSeparatorPattern.test(lines[index])) {
    const row = parseMarkdownTableRow(lines[index]);
    const kind = stripInlineMarkdownText(row[0] || "");
    const status = stripInlineMarkdownText(row[statusIndex >= 0 ? statusIndex : 3] || "");
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
  const taskCompletionMatch = content.match(/任务完成情况：已完成\s+(\d+)\/(\d+)\s+项，\s*(?:未完成\s+(\d+)\s+项，\s*)?(?:(\d+)\s*个交付物未更新状态|开放\s+(\d+)\s+项)/);
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
    openCount: Number(taskCompletionMatch?.[3] || taskCompletionMatch?.[5] || Math.max(0, totalCount - doneCount)),
    pendingDeliverableCount: Number(taskCompletionMatch?.[4] || 0),
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
  return `<div style="width:100%;max-width:100%;margin:12px 0 16px"><table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;max-width:100%;border-collapse:collapse;table-layout:fixed"><tr><td style="width:33.333%;padding:0 4px 0 0;vertical-align:top"><div style="${centeredCardStyle}"><table role="presentation" cellspacing="0" cellpadding="0" style="${fillTableStyle}"><tr><td style="${centerCellStyle}"><div style="display:inline-block;width:84px;height:84px;border-radius:999px;background:conic-gradient(#2563eb ${stats.progress}%, #e5e7eb 0);text-align:center;vertical-align:middle"><div style="display:inline-block;width:62px;height:62px;margin-top:11px;border-radius:999px;background:#ffffff;text-align:center"><div style="padding-top:16px;color:#111827;font-size:20px;font-weight:800;line-height:1">${stats.progress}%</div><div style="margin-top:3px;color:#6b7280;font-size:10px;font-weight:700;line-height:1">整体进度</div></div></div><div style="margin-top:9px;color:#6b7280;font-size:12px;line-height:1.45">已完成 <strong style="color:#111827;font-weight:800">${stats.doneCount}/${stats.totalCount}</strong> 项，未完成 <strong style="color:#111827;font-weight:800">${stats.openCount}</strong> 项，<strong style="color:#111827;font-weight:800">${stats.pendingDeliverableCount}</strong> 个交付物未更新状态</div></td></tr></table></div></td><td style="width:33.333%;padding:0 4px;vertical-align:top"><div style="${centeredCardStyle}"><table role="presentation" cellspacing="0" cellpadding="0" style="${fillTableStyle}"><tr><td style="${centerCellStyle}"><div style="margin:0 0 10px;color:#6b7280;font-size:12px">项目状态</div>${weeklyMailStatusPill(stats.status)}<div style="margin-top:10px;color:#6b7280;font-size:12px;line-height:1.45">风险 ${stats.riskCount} 个，问题 ${stats.issueCount} 个</div></td></tr></table></div></td><td style="width:33.333%;padding:0 0 0 4px;vertical-align:top"><div style="${baseCardStyle}"><table role="presentation" cellspacing="0" cellpadding="0" style="${fillTableStyle}"><tr><td style="${analysisCellStyle}"><div style="margin-bottom:8px;color:#6b7280;font-size:12px">本周分析</div><table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;max-width:100%;border-collapse:collapse;table-layout:fixed">${analysisBars}</table></td></tr></table></div></td></tr></table></div>`;
}

function isCustomerWeeklyMailContent(content: string) {
  return content.includes("本周工作内容") && content.includes("需客户关注") && content.includes("下周计划") && !content.includes("执行摘要");
}

function weeklyCustomerMailVisualSummary(content: string) {
  const workCount = countWeeklyMailRowsInSection(content, "本周工作内容");
  const attentionCount = countWeeklyMailRowsInSection(content, "需客户关注");
  const riskIssueCount = countWeeklyMailRowsInSection(content, "风险");
  const planCount = countWeeklyMailRowsInSection(content, "下周计划");
  const attentionLevel = attentionCount || riskIssueCount ? "需关注" : "平稳";
  const cardStyle = "height:136px;min-height:136px;box-sizing:border-box;padding:14px;border:1px solid #dbe6f3;border-radius:10px;background:#ffffff;word-break:break-word;overflow-wrap:anywhere";
  const metricCellStyle = "height:136px;padding:0 6px;text-align:center;vertical-align:middle";
  const metricContent = (label: string, value: number) => `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;height:136px;border-collapse:collapse"><tr><td style="${metricCellStyle}"><div style="margin:0;color:#64748b;font-size:12px;line-height:1.35;text-align:center">${escapeHtml(label)}</div><div style="margin:10px 0 0;color:#172033;font-size:25px;font-weight:800;line-height:1;text-align:center">${value}</div></td></tr></table>`;
  return `<div style="width:100%;max-width:100%;margin:4px 0 18px"><table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;max-width:100%;border-collapse:collapse;table-layout:fixed"><tr><td style="width:36%;padding:0 5px 0 0;vertical-align:top"><div style="${cardStyle};border-left:4px solid #0f766e;background:#f7fbfb"><div style="color:#64748b;font-size:12px;font-weight:700">客户协同看板</div><div style="margin-top:12px;color:#0f766e;font-size:25px;font-weight:800;line-height:1">${attentionLevel}</div><div style="margin-top:10px;color:#334155;font-size:12px;line-height:1.45">${attentionCount ? `${attentionCount} 项需要客户关注或配合` : "暂无需客户额外配合事项"}</div></div></td><td style="width:64%;padding:0 0 0 5px;vertical-align:top"><div style="${cardStyle};padding:0;overflow:hidden"><table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;height:136px;border-collapse:collapse;table-layout:fixed"><tr><td style="height:136px;padding:0;border-right:1px solid #edf2f7;text-align:center;vertical-align:middle">${metricContent("本周工作", workCount)}</td><td style="height:136px;padding:0;border-right:1px solid #edf2f7;text-align:center;vertical-align:middle">${metricContent("风险问题", riskIssueCount)}</td><td style="height:136px;padding:0;text-align:center;vertical-align:middle">${metricContent("下周计划", planCount)}</td></tr></table></div></td></tr></table></div>`;
}

export function markdownToMailHtml(content: string, displayTitle?: string) {
  const lines = content.split(/\r?\n/);
  const html: string[] = [];
  const title = (displayTitle || "").trim();
  if (title && !content.trimStart().startsWith("# ")) {
    html.push(`<h1 style="margin:0 0 18px;color:#172033;font-size:24px;line-height:1.3;font-weight:800">${inlineMarkdownToHtml(title)}</h1>`);
  }
  if (isCustomerWeeklyMailContent(content)) {
    html.push(weeklyCustomerMailVisualSummary(content));
  }
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
      html.push(`<div style="width:100%;max-width:100%;margin:12px 0 18px;border:1px solid #d9e5f3;border-radius:8px;background:#ffffff">`);
      html.push(`<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;max-width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px;line-height:1.5">`);
      html.push("<thead><tr>");
      for (const cell of header) {
        html.push(`<th style="padding:8px 8px;border-bottom:1px solid #d9e5f3;background:#f6f9fd;color:#4f657c;font-size:12px;font-weight:700;text-align:left;vertical-align:top;white-space:normal;word-break:break-word;overflow-wrap:anywhere">${inlineMarkdownToHtml(cell)}</th>`);
      }
      html.push("</tr></thead><tbody>");
      for (const row of rows) {
        html.push("<tr>");
        for (let cellIndex = 0; cellIndex < header.length; cellIndex += 1) {
          html.push(`<td style="padding:8px 8px;border-bottom:1px solid #e8eef6;color:#263445;text-align:left;vertical-align:top;word-break:break-word;overflow-wrap:anywhere">${renderWeeklyMailTableCell(header[cellIndex] || "", row[cellIndex] || "", row[0] || "")}</td>`);
        }
        html.push("</tr>");
      }
      html.push("</tbody></table></div>");
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      const title = inlineMarkdownToHtml(heading[2]);
      currentHeading = heading[2];
      if (level === 1) {
        html.push(`<h1 style="margin:0 0 16px;color:#172033;font-size:24px;line-height:1.3;font-weight:800">${title}</h1>`);
      } else if (level === 2) {
        html.push(`<h2 style="margin:22px 0 10px;padding-left:10px;border-left:4px solid #2563eb;color:#172033;font-size:17px;line-height:1.35;font-weight:800">${title}</h2>`);
      } else {
        html.push(`<h3 style="margin:14px 0 8px;color:#263445;font-size:14px;line-height:1.35;font-weight:700">${title}</h3>`);
      }
      index += 1;
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (!inList) {
        html.push(`<ul style="margin:8px 0 16px;padding-left:22px;color:#263445">`);
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
      html.push(`<ol style="margin:8px 0 16px;padding-left:22px;color:#263445">`);
      for (const item of items) html.push(`<li style="margin:0 0 7px">${inlineMarkdownToHtml(item)}</li>`);
      html.push("</ol>");
      continue;
    }

    closeList();
    const paragraph = [trimmed];
    index += 1;
    while (index < lines.length && !isMailBlockStart(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    html.push(`<p style="margin:0 0 10px;color:#263445;font-size:14px;line-height:1.7">${inlineMarkdownToHtml(paragraph.join(" "))}</p>`);
    if (!visualSummaryInserted && currentHeading.includes("执行摘要")) {
      html.push(weeklyMailVisualSummary(content));
      visualSummaryInserted = true;
    }
  }
  closeList();

  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body style="width:100%;margin:0;padding:0;background:#ffffff;-webkit-text-size-adjust:100%;text-size-adjust:100%"><div style="width:100%;max-width:100%;margin:0;padding:0;background:#ffffff"><div style="width:100%;max-width:100%;margin:0;padding:12px 10px;border:0;background:#ffffff;box-sizing:border-box;font-family:Segoe UI,Microsoft YaHei,Arial,sans-serif;color:#263445;line-height:1.65;word-break:break-word;overflow-wrap:anywhere">${html.join("\n")}</div></div></body></html>`;
}

function withHtmlContent(payload: EmailDraftPayload): EmailDraftPayload {
  return {
    ...payload,
    htmlContent: payload.htmlContent?.trim() || markdownToMailHtml(payload.content, payload.displayTitle || payload.subject),
  };
}

export async function saveEmailDraft(config: EmailConfig, payload: EmailDraftPayload) {
  const configError = validateEmailConfig(config);
  if (configError) throw new Error(configError);
  const draftError = validateEmailDraft(payload);
  if (draftError) throw new Error(draftError);
  const payloadWithHtml = withHtmlContent(payload);

  if (isTauri()) {
    const response = (await invoke("save_email_draft", { config, payload: payloadWithHtml })) as EmailDraftResponse;
    if (response?.ok !== true) throw new Error(response?.error || "邮箱草稿保存失败。");
    return response.message || "邮件草稿已保存到邮箱草稿箱。";
  }

  try {
    const response = await fetch("/api/email/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, payload: payloadWithHtml }),
    });
    const data = (await response.json().catch(() => ({}))) as EmailDraftResponse;
    if (!response.ok || data.ok !== true) throw new Error(data.error || `邮箱草稿保存失败：${response.status}`);
    return data.message || "邮件草稿已保存到邮箱草稿箱。";
  } catch (error) {
    throw error;
  }
}
