import { useEffect, useRef, useState } from "react";
import { Bot, FileText, Lightbulb, Send, Trash2, User } from "lucide-react";
import type { AiMessage, AppState, AssistantScope } from "../types";
import { buildProjectSnapshot, calcProjectMetrics, getProject } from "../services/contextBuilder";
import type { AiService } from "../services/aiService";
import { assistantSessionMessages, normalizeAssistantScope } from "../services/assistantSessions";
import { Card } from "../components/ui";
import { RichMessage } from "./page-shared";

const defaultAssistantGreeting =
  "我可以基于当前项目快照回答问题、解释健康评分、生成周报草稿，也可以按明确指令直接更新任务状态、日期、进度和负责人。";

const legacyAssistantGreeting =
  "我可以基于当前项目快照回答问题、解释健康评分、生成周报草稿。AI 结果默认只是建议，不会直接修改项目数据。";

const compactAssistantGreeting = "已接入当前项目。你可以直接问进度、风险，也可以下达任务状态、日期和进度变更指令。";

const assistantLoadingText = "正在基于当前项目快照调用 AI 模型...";
const scopedAssistantLoadingText = "正在基于当前会话范围调用 AI 模型...";

function displayAssistantContent(content: string) {
  return content === defaultAssistantGreeting || content === legacyAssistantGreeting ? compactAssistantGreeting : content;
}

function assistantGreeting(scope: AssistantScope) {
  return scope === "all"
    ? "已进入所有项目模式。你可以汇总全平台进度、风险、逾期、交付物，也可以下达跨项目任务变更指令。"
    : compactAssistantGreeting;
}

function TypingIndicator() {
  return (
    <div className="typing-indicator" aria-label="AI 正在生成回复">
      <span />
      <span />
      <span />
    </div>
  );
}

export function AssistantPage({
  state,
  onAsk,
  streamingMessages,
  assistantScope,
  onAssistantScopeChange,
  onClearHistory,
}: {
  state: AppState;
  aiService: AiService;
  onAsk: (question: string) => void;
  streamingMessages: Record<string, AiMessage>;
  assistantScope: AssistantScope;
  onAssistantScopeChange: (scope: AssistantScope) => void;
  onClearHistory: (scope: AssistantScope) => void;
}) {
  const project = getProject(state);
  const scope = normalizeAssistantScope(assistantScope);
  const snapshot = buildProjectSnapshot(state, project, "chat");
  const metrics = calcProjectMetrics(state, project);
  const visibleMessages = assistantSessionMessages(state.aiMessages, scope, project.id);
  const sessionMessages = visibleMessages.map((message) => streamingMessages[message.id] || message);
  const renderedMessages =
    sessionMessages.length > 0
      ? sessionMessages
      : [{ id: `assistant-greeting-${scope}-${project.id}`, role: "assistant" as const, content: assistantGreeting(scope), createdAt: "" }];
  const projectSummaries = state.projects.map((item) => {
    const projectMetrics = calcProjectMetrics(state, item);
    const projectSnapshot = buildProjectSnapshot(state, item, "chat");
    return { project: item, metrics: projectMetrics, snapshot: projectSnapshot };
  });
  const platformTotals = {
    projects: projectSummaries.length,
    open: projectSummaries.reduce((sum, item) => sum + item.metrics.open, 0),
    blocked: projectSummaries.reduce((sum, item) => sum + item.metrics.blocked, 0),
    customer: projectSummaries.reduce((sum, item) => sum + item.metrics.customer, 0),
    overdue: projectSummaries.reduce((sum, item) => sum + item.metrics.overdue, 0),
    highRisks: projectSummaries.reduce((sum, item) => sum + item.metrics.openHighRisks, 0),
  };
  const platformTasks = projectSummaries
    .flatMap((item) => item.snapshot.tasks.map((task) => ({ ...task, projectName: item.project.name })))
    .filter((task) => task.status !== "done")
    .slice(0, 6);
  const modalSnapshot =
    scope === "all"
      ? {
          scope: "all-projects",
          generatedAt: new Date().toISOString(),
          totals: platformTotals,
          projects: projectSummaries.map((item) => ({
            project: item.snapshot.project,
            metrics: item.snapshot.metrics,
            tasks: item.snapshot.tasks,
            risks: item.snapshot.risks,
            deliverables: item.snapshot.deliverables,
          })),
        }
      : snapshot;
  const config = state.aiModelConfigs.find((item) => item.isDefault) || state.aiModelConfigs[0];
  const [question, setQuestion] = useState("");
  const [showSnapshot, setShowSnapshot] = useState(false);
  const [showPrompts, setShowPrompts] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const chatBoxRef = useRef<HTMLDivElement | null>(null);
  const hasConfiguredModel = Boolean(config?.apiKey?.trim());
  const quickPrompts = ["解释当前健康状态", "把所有任务完成时间推迟一个月", "把客户UAT启动标记为进行中", "生成客户沟通纪要草稿"];
  const latestMessageKey = renderedMessages.map((message) => `${message.id}:${message.content.length}`).join("|");
  const sendQuestion = (value = question) => {
    const nextQuestion = value.trim();
    if (!nextQuestion) return;
    onAsk(nextQuestion);
    setQuestion("");
  };

  useEffect(() => {
    const input = composerRef.current;
    if (!input) return;
    input.style.height = "42px";
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  }, [question]);

  useEffect(() => {
    const chatBox = chatBoxRef.current;
    if (!chatBox) return;
    const frame = window.requestAnimationFrame(() => {
      chatBox.scrollTop = chatBox.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [latestMessageKey]);

  return (
    <section className="assistant-page">
      <Card className="pad assistant-workbench">
        <div className="assistant-chat-shell">
          <div className="assistant-chat-toolbar">
            <div className="assistant-session">
              <span className="message-avatar assistant">
                <Bot aria-hidden="true" />
              </span>
              <div className="assistant-session-copy">
                  <strong>{scope === "all" ? "所有项目" : project.name}</strong>
                <span
                  className={`assistant-status-dot ${hasConfiguredModel ? "ready" : "idle"}`}
                  title={hasConfiguredModel ? "AI 已就绪" : "AI 未配置"}
                  aria-label={hasConfiguredModel ? "AI 已就绪" : "AI 未配置"}
                />
              </div>
            </div>
            <div className="assistant-toolbar-actions">
              <div className="assistant-scope-toggle" role="group" aria-label="对话范围">
                <button
                  className={scope === "project" ? "active" : ""}
                  onClick={() => onAssistantScopeChange("project")}
                  type="button"
                >
                  当前项目
                </button>
                <button
                  className={scope === "all" ? "active" : ""}
                  onClick={() => onAssistantScopeChange("all")}
                  type="button"
                >
                  所有项目
                </button>
              </div>
              <div className="assistant-menu-wrap">
                <button
                  className="toolbar-icon-button"
                  onClick={() => setShowPrompts((value) => !value)}
                  title="建议问题"
                  aria-label="建议问题"
                  aria-expanded={showPrompts}
                >
                  <Lightbulb aria-hidden="true" />
                </button>
                {showPrompts ? (
                  <div className="prompt-menu">
                    {quickPrompts.map((prompt) => (
                      <button
                        key={prompt}
                        onClick={() => {
                          setShowPrompts(false);
                          sendQuestion(prompt);
                        }}
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <button
                className="toolbar-icon-button"
                onClick={() => {
                  if (!visibleMessages.length) return;
                  if (window.confirm(scope === "all" ? "确认清空所有项目模式的对话历史？" : "确认清空当前项目的对话历史？")) {
                    onClearHistory(scope);
                  }
                }}
                title="清空历史"
                aria-label="清空历史"
                disabled={!visibleMessages.length}
              >
                <Trash2 aria-hidden="true" />
              </button>
              <button
                className="toolbar-icon-button"
                onClick={() => {
                  setShowPrompts(false);
                  setShowSnapshot(true);
                }}
                title="上下文"
                aria-label="上下文"
              >
                <FileText aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="chat-box" ref={chatBoxRef}>
            {renderedMessages.map((message) => {
              const isLoadingMessage = message.role === "assistant" && (message.content === assistantLoadingText || message.content === scopedAssistantLoadingText);
              const assistantContent = message.role === "assistant" ? displayAssistantContent(message.content) : message.content;

              return (
                <div key={message.id} className={`message-row ${message.role}`}>
                  {message.role === "assistant" ? (
                    <span className="message-avatar assistant">
                      <Bot aria-hidden="true" />
                    </span>
                  ) : null}
                  <div className={`message ${message.role} ${isLoadingMessage ? "loading" : ""}`}>
                    {message.role === "assistant" ? (isLoadingMessage ? <TypingIndicator /> : <RichMessage content={assistantContent} />) : message.content}
                  </div>
                  {message.role === "user" ? (
                    <span className="message-avatar user">
                      <User aria-hidden="true" />
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="assistant-composer">
            <div className="assistant-composer-inner">
              <div className="composer-box">
                <textarea
                  ref={composerRef}
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      sendQuestion();
                    }
                  }}
                  rows={1}
                  placeholder="输入消息..."
                />
                <button className="composer-send" onClick={() => sendQuestion()} disabled={!question.trim()} title="发送" aria-label="发送">
                  <Send aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </Card>
      {showSnapshot ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-panel assistant-snapshot-modal">
            <div className="modal-header">
              <div>
                <h3>发送给 AI 的项目快照</h3>
                <p className="muted">当前对话会携带这些项目上下文；明确的任务变更指令会直接写入本地项目数据。</p>
              </div>
              <button className="icon-button" onClick={() => setShowSnapshot(false)} aria-label="关闭">
                ×
              </button>
            </div>
            <div className="snapshot-block">
              <div className="snapshot-summary-grid">
                <div>
                  <span>{scope === "all" ? "范围" : "项目"}</span>
                  <strong>{scope === "all" ? "所有项目" : snapshot.project.name}</strong>
                </div>
                <div>
                  <span>{scope === "all" ? "项目数" : "客户"}</span>
                  <strong>{scope === "all" ? platformTotals.projects : snapshot.project.client}</strong>
                </div>
                <div>
                  <span>{scope === "all" ? "未完成任务" : "阶段"}</span>
                  <strong>{scope === "all" ? platformTotals.open : snapshot.project.phase}</strong>
                </div>
                <div>
                  <span>{scope === "all" ? "阻塞任务" : "整体进度"}</span>
                  <strong>{scope === "all" ? platformTotals.blocked : `${metrics.completionRate}%`}</strong>
                </div>
                <div>
                  <span>{scope === "all" ? "待客户任务" : "未完成任务"}</span>
                  <strong>{scope === "all" ? platformTotals.customer : metrics.open}</strong>
                </div>
                <div>
                  <span>{scope === "all" ? "高风险" : "高风险"}</span>
                  <strong>{scope === "all" ? platformTotals.highRisks : metrics.openHighRisks}</strong>
                </div>
              </div>
              <div className="snapshot-section">
                <h4>{scope === "all" ? "跨项目近期任务" : "最近任务"}</h4>
                <div className="snapshot-mini-list">
                  {(scope === "all" ? platformTasks : snapshot.tasks.slice(0, 6)).map((task) => (
                    <div key={`${"projectName" in task ? task.projectName : snapshot.project.name}-${task.code}-${task.title}`}>
                      <strong>{task.code}</strong>
                      <span>{"projectName" in task ? `${task.projectName} · ${task.title}` : task.title}</span>
                    </div>
                  ))}
                </div>
              </div>
              <details className="snapshot-raw">
                <summary>完整快照数据</summary>
                <pre className="muted">{JSON.stringify(modalSnapshot, null, 2)}</pre>
              </details>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
