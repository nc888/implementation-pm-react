import type { AiScore, AppState, Project } from "../types";
import { buildProjectSnapshot, calcProjectMetrics, isExecutableTask, projectDeliverables, projectRisks, projectTasks } from "./contextBuilder";

export interface AiService {
  scoreProject(state: AppState, project: Project): Omit<AiScore, "id" | "createdAt">;
  reply(state: AppState, question: string): string;
  draftWeeklyReport(state: AppState, project: Project): string;
  testModel(): Promise<string>;
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export const ruleBasedAiService: AiService = {
  scoreProject(state, project) {
    const metrics = calcProjectMetrics(state, project);
    const today = localDateKey();
    const executableTasks = projectTasks(state, project.id).filter(isExecutableTask);
    const overdueTasks = executableTasks.filter((task) => task.status !== "done" && task.dueDate && task.dueDate < today);
    const pendingDeliverables = projectDeliverables(state, project.id).filter((item) => !["已验收", "内部确认"].includes(item.acceptance));
    const overdueDeliverables = pendingDeliverables.filter((item) => item.dueDate && item.dueDate < today);
    let score = 100;
    score -= overdueTasks.length * 8;
    score -= metrics.blocked * 10;
    score -= metrics.customer * 5;
    score -= metrics.openHighRisks * 12;
    score -= metrics.issues * 6;
    score -= overdueDeliverables.length * 6;
    if (project.health === "延期") score -= 14;
    if (project.health === "关注") score -= 6;
    score = Math.max(0, Math.min(100, score));
    const level = score >= 80 ? "绿灯" : score >= 60 ? "黄灯" : "红灯";
    return {
      projectId: project.id,
      score,
      level,
      mode: "rule-only",
      summary: `${project.name} 当前为${level}，主要受 ${overdueTasks.length} 个逾期任务、${metrics.customer} 个客户待确认、${metrics.blocked} 个阻塞事项、${overdueDeliverables.length} 个到期未验收交付物影响。`,
      actions: [
        overdueTasks.length ? "优先处理已逾期的可执行任务，确认实际完成状态。" : "可执行任务逾期情况正常。",
        metrics.customer ? "优先推进客户确认项，避免影响后续验收。" : "保持客户确认节奏。",
        metrics.blocked ? "拆解已阻塞事项，明确责任人与截止时间。" : "阻塞事项暂时可控。",
        overdueDeliverables.length ? "处理到期未验收交付物，推进签字闭环。" : "交付物到期验收状态良好。",
      ],
    };
  },
  reply(state, question) {
    const project = state.projects.find((item) => item.id === state.ui.currentProjectId) || state.projects[0];
    const score = this.scoreProject(state, project);
    const metrics = calcProjectMetrics(state, project);
    const normalized = question.toLowerCase();
    if (question.includes("周报") || question.includes("总结")) {
      return this.draftWeeklyReport(state, project);
    }
    if (question.includes("风险") || question.includes("问题")) {
      const items = projectRisks(state, project.id)
        .map((item) => `- ${item.kind === "risk" ? "风险" : "问题"}：${item.title}（${item.severity}）\n  建议：${item.responsePlan}`)
        .join("\n");
      return `当前最需要关注的是风险和问题闭环：\n${items}\n\n建议先处理高风险和已阻塞事项，AI 结果仅作为建议草稿。`;
    }
    if (question.includes("评分") || question.includes("健康") || normalized.includes("score")) {
      return `${score.summary}\n\n建议动作：\n${score.actions.map((item) => `- ${item}`).join("\n")}`;
    }
    return `基于当前项目快照，我建议今天优先处理：\n- 客户待确认项：${metrics.customer} 个\n- 已阻塞事项：${metrics.blocked} 个\n- 待验收交付物：${metrics.pendingDeliverables} 个\n\n可以继续问我：“生成周报”“解释健康评分”“当前最大风险是什么”。`;
  },
  draftWeeklyReport(state, project) {
    const tasks = projectTasks(state, project.id);
    const done = tasks.filter((task) => task.status === "done");
    const doing = tasks.filter((task) => task.status === "doing");
    const blocked = tasks.filter((task) => task.status === "blocked");
    const customer = tasks.filter((task) => task.status === "customer");
    const risks = projectRisks(state, project.id).filter((item) => item.status !== "closed");
    return `# ${project.name} 周报草稿

## 本周进展
${done.slice(0, 4).map((item) => `- ${item.code} ${item.title}`).join("\n") || "- 本周暂无已完成事项"}

## 进行中
${doing.slice(0, 4).map((item) => `- ${item.code} ${item.title}（进度 ${item.progress}%）`).join("\n") || "- 暂无进行中事项"}

## 风险与阻塞
${blocked.map((item) => `- ${item.code} ${item.title}`).join("\n") || "- 暂无阻塞事项"}
${risks.slice(0, 3).map((item) => `- ${item.title}：${item.responsePlan}`).join("\n")}

## 客户待确认
${customer.map((item) => `- ${item.code} ${item.title}，截止 ${item.dueDate}`).join("\n") || "- 暂无客户待确认项"}

## 下周计划
- 推进 UAT 准备和客户确认闭环
- 处理高风险和阻塞事项
- 更新交付物验收状态`;
  },
  async testModel() {
    buildProjectSnapshot;
    return "连接测试通过：当前为本地规则/模拟模式。";
  },
};
