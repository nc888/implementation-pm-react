import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  CheckCircle2,
  Database,
  Eye,
  EyeOff,
  Inbox,
  KeyRound,
  LockKeyhole,
  Mail,
  Plus,
  RadioTower,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Wifi,
} from "lucide-react";
import type { AiModelConfig, AppState, EmailConfig, PageKey, ProjectMilestone, TaskStageDefinition } from "../types";
import { defaultTaskStages, projectMilestonesForState, stageCoefficientTotal, stageDefinitionsForProject } from "../services/contextBuilder";
import { Badge, Button } from "../components/ui";

function endpointLabel(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    return `${url.host}${url.pathname}`;
  } catch {
    return baseUrl || "未配置";
  }
}

function keyStatus(apiKey: string) {
  return apiKey.trim() ? "已保存" : "未填写";
}

function isKimiFixedTemperatureModel(model: string) {
  return /^kimi-k2\.6(?:[.-]|$)/i.test(model);
}

function normalizeTemperature(config: AiModelConfig) {
  if (isKimiFixedTemperatureModel(config.model || "")) return 1;
  return typeof config.temperature === "number" && Number.isFinite(config.temperature) ? config.temperature : 0.2;
}

function vendorLabel(config: AiModelConfig) {
  const id = config.id || "";
  const baseUrl = config.baseUrl || "";
  const model = config.model || "";
  if (id === "ai-gpt55-proxy" || /aicodemirror\.com/i.test(baseUrl) || /^gpt-5\.5/i.test(model)) return "GPT-5.5 国内代理";
  if (id === "ai-xiaomi-mimo" || /xiaomimimo\.com/i.test(baseUrl) || /^mimo-/i.test(model)) return "小米 Mimo";
  if (id === "ai-kimi-k26" || /moonshot\.cn/i.test(baseUrl) || /^kimi-/i.test(model)) return "Kimi / Moonshot";
  if (config.provider === "ollama") return "Ollama";
  return "自定义";
}

export function SettingsPage({
  state,
  onSaveConfig,
  onTestConfig,
  onSaveStages,
  onSaveEmailConfig,
}: {
  state: AppState;
  onSaveConfig: (config: AiModelConfig) => void;
  onTestConfig: (config: AiModelConfig) => Promise<void> | void;
  onSaveStages: (projectId: string, stages: TaskStageDefinition[], milestones: ProjectMilestone[]) => void;
  onSaveEmailConfig: (config: EmailConfig) => void;
}) {
  const defaultConfig = state.aiModelConfigs.find((item) => item.isDefault) || state.aiModelConfigs[0];
  const [selectedConfigId, setSelectedConfigId] = useState(defaultConfig.id);
  const selectedConfig = state.aiModelConfigs.find((item) => item.id === selectedConfigId) || defaultConfig;
  const [selectedStageProjectId, setSelectedStageProjectId] = useState(state.ui.currentProjectId || state.projects[0]?.id || "");
  const [draft, setDraft] = useState<AiModelConfig>(selectedConfig);
  const [stageDrafts, setStageDrafts] = useState<TaskStageDefinition[]>(stageDefinitionsForProject(state, selectedStageProjectId).map((stage) => ({ ...stage })));
  const [milestoneDrafts, setMilestoneDrafts] = useState<ProjectMilestone[]>(projectMilestonesForState(state, selectedStageProjectId).map((milestone) => ({ ...milestone })));
  const [emailDraft, setEmailDraft] = useState<EmailConfig>(state.emailConfig);
  const [testing, setTesting] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [showMailPassword, setShowMailPassword] = useState(false);

  useEffect(() => {
    if (!state.aiModelConfigs.some((item) => item.id === selectedConfigId)) {
      setSelectedConfigId(defaultConfig.id);
    }
  }, [defaultConfig.id, selectedConfigId, state.aiModelConfigs]);

  useEffect(() => {
    setDraft(selectedConfig);
    setShowKey(false);
  }, [selectedConfig]);

  useEffect(() => {
    if (state.projects.some((project) => project.id === selectedStageProjectId)) return;
    setSelectedStageProjectId(state.ui.currentProjectId || state.projects[0]?.id || "");
  }, [selectedStageProjectId, state.projects, state.ui.currentProjectId]);

  useEffect(() => {
    setStageDrafts(stageDefinitionsForProject(state, selectedStageProjectId).map((stage) => ({ ...stage })));
    setMilestoneDrafts(projectMilestonesForState(state, selectedStageProjectId).map((milestone) => ({ ...milestone })));
  }, [selectedStageProjectId, state.projectStageConfigs, state.taskStages, state.deliverables, state.projects]);

  useEffect(() => {
    setEmailDraft(state.emailConfig);
    setShowMailPassword(false);
  }, [state.emailConfig]);

  const patchDraft = (patch: Partial<AiModelConfig>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const patchEmailDraft = (patch: Partial<EmailConfig>) => {
    setEmailDraft((current) => ({ ...current, ...patch }));
  };

  const switchConfig = (configId: string) => {
    const next = state.aiModelConfigs.find((item) => item.id === configId);
    if (!next) return;
    setSelectedConfigId(configId);
    setDraft(next);
    setShowKey(false);
  };

  const saveDraft = () => {
    onSaveConfig({ ...draft, temperature: normalizeTemperature(draft), lastHealth: draft.lastHealth || "已保存，待测试" });
  };

  const saveAndTest = async () => {
    const next = { ...draft, temperature: normalizeTemperature(draft), lastHealth: "已保存，正在测试连接" };
    setTesting(true);
    setDraft(next);
    onSaveConfig(next);
    try {
      await onTestConfig(next);
    } finally {
      setTesting(false);
    }
  };

  const patchStageLabel = (stageId: string, label: string) => {
    setStageDrafts((current) => current.map((stage) => (stage.id === stageId ? { ...stage, label } : stage)));
  };

  const patchStageCoefficient = (stageId: string, coefficient: number) => {
    setStageDrafts((current) =>
      current.map((stage) => (stage.id === stageId ? { ...stage, coefficient: Number.isFinite(coefficient) ? Math.max(0, Math.round(coefficient * 100) / 100) : 1 } : stage)),
    );
  };

  const moveStage = (stageId: string, direction: -1 | 1) => {
    setStageDrafts((current) => {
      const index = current.findIndex((stage) => stage.id === stageId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  const addStage = () => {
    setStageDrafts((current) => [...current, { id: `custom-${Date.now().toString(36)}`, label: `阶段${current.length + 1}`, coefficient: 1 }]);
  };

  const removeStage = (stageId: string) => {
    setStageDrafts((current) => (current.length <= 1 ? current : current.filter((stage) => stage.id !== stageId)));
  };

  const patchMilestone = (milestoneId: string, patch: Partial<ProjectMilestone>) => {
    setMilestoneDrafts((current) => current.map((milestone) => (milestone.id === milestoneId ? { ...milestone, ...patch } : milestone)));
  };

  const addMilestone = () => {
    setMilestoneDrafts((current) => [
      ...current,
      {
        id: `milestone-${Date.now().toString(36)}`,
        title: `M${current.length + 1} 里程碑`,
        dueDate: "",
        status: "未开始",
        description: "",
      },
    ]);
  };

  const removeMilestone = (milestoneId: string) => {
    setMilestoneDrafts((current) => current.filter((milestone) => milestone.id !== milestoneId));
  };

  const resetTencentEmailConfig = () => {
    setEmailDraft((current) => ({
      ...current,
      provider: "tencent-exmail",
      smtpHost: "smtp.exmail.qq.com",
      smtpPort: 465,
      smtpSecure: true,
      imapHost: "imap.exmail.qq.com",
      imapPort: 993,
      imapSecure: true,
      draftsMailbox: current.draftsMailbox || "Drafts",
      lastStatus: "已恢复腾讯企业邮箱默认服务器参数",
    }));
  };

  const readyModelCount = state.aiModelConfigs.filter((item) => item.provider === "ollama" || item.apiKey.trim()).length;
  const emailReady = Boolean(emailDraft.email.trim() && emailDraft.password.trim() && emailDraft.smtpHost.trim() && emailDraft.imapHost.trim());
  const selectedStageProject = state.projects.find((project) => project.id === selectedStageProjectId) || state.projects[0];
  const coefficientTotal = stageCoefficientTotal(stageDrafts);
  const coefficientTarget = stageDrafts.length;
  const coefficientValid = coefficientTotal === coefficientTarget;
  const activeSettingsPage: Extract<PageKey, "modelSettings" | "stageSettings" | "emailSettings"> =
    state.ui.currentPage === "stageSettings" ? "stageSettings" : state.ui.currentPage === "emailSettings" ? "emailSettings" : "modelSettings";

  return (
    <section className="model-config-page settings-page">
      {activeSettingsPage === "modelSettings" ? (
      <section id="model-settings" className="settings-section">
        <div className="settings-section-head">
          <div className="settings-section-title">
            <span className="settings-section-icon">
              <Wifi aria-hidden="true" />
            </span>
            <div>
              <h3>模型设置</h3>
              <p>默认模型、连接参数、远程数据策略</p>
            </div>
          </div>
          <div className="settings-section-meta">
            <Badge tone={readyModelCount ? "success" : "warning"}>{readyModelCount} 个可用</Badge>
            <span>{selectedConfig.lastHealth || "未测试"}</span>
          </div>
        </div>

        <div className="settings-model-grid">
          <aside className="settings-panel model-list-card">
            <div className="model-panel-heading">
              <SlidersHorizontal aria-hidden="true" />
              <div>
                <strong>模型列表</strong>
                <span>选择后编辑该模型配置</span>
              </div>
            </div>
            <div className="model-list">
              {state.aiModelConfigs.map((item) => {
                const active = item.id === draft.id;
                const ready = item.provider === "ollama" || item.apiKey.trim();
                return (
                  <button key={item.id} className={`model-list-item ${active ? "active" : ""}`} onClick={() => switchConfig(item.id)}>
                    <span className={`model-list-status ${ready ? "ready" : ""}`} aria-hidden={true} />
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.isDefault ? "当前默认" : vendorLabel(item)}</small>
                    </span>
                    <Badge tone={ready ? "success" : "warning"}>{ready ? "可用" : "待配置"}</Badge>
                  </button>
                );
              })}
            </div>
          </aside>

          <div className="settings-panel model-config-card">
            <div className="model-panel-heading">
              <RadioTower aria-hidden="true" />
              <div>
                <strong>连接参数</strong>
                <span>保存后会将当前配置设为默认模型</span>
              </div>
            </div>
            <div className="model-form-grid">
              <div className="field">
                <label>配置名称</label>
                <input value={draft.name} onChange={(event) => patchDraft({ name: event.target.value })} />
              </div>
              <div className="field">
                <label>供应商</label>
                <input value={vendorLabel(draft)} readOnly />
              </div>
              <div className="field">
                <label>接口协议</label>
                <select value={draft.provider} onChange={(event) => patchDraft({ provider: event.target.value as AiModelConfig["provider"] })}>
                  <option value="openai-compatible">OpenAI Compatible</option>
                  <option value="ollama">Ollama</option>
                </select>
              </div>
              <div className="field">
                <label>Temperature</label>
                <input
                  type="number"
                  min={isKimiFixedTemperatureModel(draft.model || "") ? 1 : 0}
                  max={isKimiFixedTemperatureModel(draft.model || "") ? 1 : 2}
                  step="0.1"
                  value={normalizeTemperature(draft)}
                  disabled={isKimiFixedTemperatureModel(draft.model || "")}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    patchDraft({ temperature: Number.isFinite(value) ? value : 0.2 });
                  }}
                />
              </div>
              <div className="field model-field-wide">
                <label>API Base URL</label>
                <input value={draft.baseUrl} onChange={(event) => patchDraft({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1 或 http://localhost:11434" />
              </div>
              <div className="field model-field-wide">
                <label>模型名称</label>
                <input value={draft.model} onChange={(event) => patchDraft({ model: event.target.value })} placeholder="例如 gpt-5.5 / kimi-k2.6 / llama3" />
              </div>
              <div className="field model-field-wide">
                <label>API Key</label>
                <div className="key-input-control">
                  <input
                    type={showKey ? "text" : "password"}
                    value={draft.apiKey}
                    onChange={(event) => patchDraft({ apiKey: event.target.value })}
                    placeholder={draft.provider === "ollama" ? "本地 Ollama 可留空" : "填写后随该模型独立保存"}
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                  <button type="button" className="key-visibility-button" onClick={() => setShowKey((current) => !current)} aria-label={showKey ? "隐藏 API Key" : "显示 API Key"} title={showKey ? "隐藏 API Key" : "显示 API Key"}>
                    {showKey ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                  </button>
                </div>
              </div>
            </div>

            <label className="remote-consent-card">
              <input type="checkbox" checked={draft.allowRemoteRequest} onChange={(event) => patchDraft({ allowRemoteRequest: event.target.checked })} />
              <span>
                <strong>允许发送项目快照到远程模型</strong>
                <small>关闭后仅保存配置，不会把项目上下文发送到远程接口。</small>
              </span>
            </label>

            <div className="actions-row model-config-actions">
              <Button tone="primary" onClick={saveDraft}>
                保存并设为默认
              </Button>
              <Button tone="ghost" onClick={saveAndTest} disabled={testing}>
                {testing ? "测试中..." : "保存并测试"}
              </Button>
            </div>
          </div>

          <aside className="settings-panel model-policy-card">
            <div className="model-panel-heading">
              <ShieldCheck aria-hidden="true" />
              <div>
                <strong>运行状态</strong>
                <span>当前选中配置的连接信息</span>
              </div>
            </div>
            <div className="model-status-list">
              <div>
                <RadioTower aria-hidden="true" />
                <span>调用路径</span>
                <strong>{endpointLabel(draft.baseUrl)}</strong>
              </div>
              <div>
                <CheckCircle2 aria-hidden="true" />
                <span>模型名称</span>
                <strong>{draft.model || "未配置"}</strong>
              </div>
              <div>
                <KeyRound aria-hidden="true" />
                <span>Key 状态</span>
                <strong>{keyStatus(draft.apiKey)}</strong>
              </div>
              <div>
                <Database aria-hidden="true" />
                <span>最近测试</span>
                <strong>{selectedConfig.lastHealth || "未测试"}</strong>
              </div>
            </div>
            <div className="model-lock-note">
              <LockKeyhole aria-hidden="true" />
              <span>不同模型的 Key 独立保存，切换默认模型不会覆盖其他配置。</span>
            </div>
          </aside>
        </div>
      </section>
      ) : null}

      {activeSettingsPage === "stageSettings" ? (
      <section id="stage-settings" className="settings-section">
        <div className="settings-section-head">
          <div className="settings-section-title">
            <span className="settings-section-icon">
              <SlidersHorizontal aria-hidden="true" />
            </span>
            <div>
              <h3>阶段配置</h3>
              <p>按项目维护阶段名称、展示顺序和阶段系数</p>
            </div>
          </div>
          <div className="settings-section-meta">
            <Badge>{stageDrafts.length} 个阶段</Badge>
            <Badge tone={coefficientValid ? "success" : "warning"}>系数合计 {coefficientTotal}/{coefficientTarget}</Badge>
          </div>
        </div>

        <div className="settings-panel stage-project-panel">
          <div className="model-panel-heading">
            <Database aria-hidden="true" />
            <div>
              <strong>项目阶段方案</strong>
            <span>每个项目独立保存阶段、系数与里程碑，项目进度会按该项目的阶段系数加权计算。</span>
            </div>
          </div>
          <div className="model-form-grid stage-project-form">
            <div className="field model-field-wide">
              <label>选择项目</label>
              <select value={selectedStageProjectId} onChange={(event) => setSelectedStageProjectId(event.target.value)}>
                {state.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} / {project.client}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className={`stage-coefficient-summary ${coefficientValid ? "" : "warning"}`}>
            <strong>{selectedStageProject?.name || "未选择项目"}</strong>
            <span>阶段系数合计必须等于阶段数量；单个阶段系数越高，该阶段对自动项目进度的权重越高。</span>
          </div>
        </div>

        <div className="stage-settings-grid">
          <div className="settings-panel stage-flow-panel">
            <div className="stage-flow-strip">
              {stageDrafts.map((stage, index) => (
                <div key={stage.id} className="stage-flow-node">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <strong>{stage.label || "未命名阶段"}</strong>
                    <small>系数 {stage.coefficient ?? 1}</small>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="settings-panel stage-config-card">
            <div className="stage-config-list">
              {stageDrafts.map((stage, index) => (
                <div key={stage.id} className="stage-config-row">
                  <span className="stage-config-index">{index + 1}</span>
                  <input value={stage.label} onChange={(event) => patchStageLabel(stage.id, event.target.value)} aria-label={`阶段 ${index + 1} 名称`} />
                  <label className="stage-coefficient-input">
                    <span>系数</span>
                    <input
                      type="number"
                      min="0"
                      step="0.05"
                      value={stage.coefficient ?? 1}
                      onChange={(event) => patchStageCoefficient(stage.id, Number(event.target.value))}
                      aria-label={`阶段 ${index + 1} 系数`}
                    />
                  </label>
                  <button type="button" className="button ghost settings-icon-button" onClick={() => moveStage(stage.id, -1)} disabled={index === 0} aria-label="上移阶段" title="上移阶段">
                    <ArrowUp aria-hidden="true" />
                  </button>
                  <button type="button" className="button ghost settings-icon-button" onClick={() => moveStage(stage.id, 1)} disabled={index === stageDrafts.length - 1} aria-label="下移阶段" title="下移阶段">
                    <ArrowDown aria-hidden="true" />
                  </button>
                  <button type="button" className="button danger settings-icon-button" onClick={() => removeStage(stage.id)} disabled={stageDrafts.length <= 1} aria-label="删除阶段" title="删除阶段">
                    <Trash2 aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
            <div className="actions-row model-config-actions">
              <Button tone="ghost" onClick={addStage}>
                <Plus aria-hidden="true" />
                新增阶段
              </Button>
              <Button tone="ghost" onClick={() => setStageDrafts(defaultTaskStages.map((stage) => ({ ...stage })))}>
                <RotateCcw aria-hidden="true" />
                恢复专家推荐
              </Button>
              <Button tone="primary" onClick={() => onSaveStages(selectedStageProjectId, stageDrafts, milestoneDrafts)} disabled={!selectedStageProject || !coefficientValid}>
                保存阶段配置
              </Button>
            </div>
          </div>
        </div>
        <div className="settings-panel stage-config-card milestone-config-card">
          <div className="model-panel-heading">
            <CalendarDays aria-hidden="true" />
            <div>
              <strong>里程碑配置</strong>
              <span>导入项目、项目编辑和 AI 上下文都会读取这里的里程碑列表。</span>
            </div>
          </div>
          <div className="stage-config-list">
            {milestoneDrafts.map((milestone, index) => (
              <div key={milestone.id} className="stage-config-row milestone-config-row">
                <span className="stage-config-index">{index + 1}</span>
                <input value={milestone.title} onChange={(event) => patchMilestone(milestone.id, { title: event.target.value })} aria-label={`里程碑 ${index + 1} 名称`} />
                <label className="stage-coefficient-input">
                  <span>日期</span>
                  <input type="date" value={milestone.dueDate} onChange={(event) => patchMilestone(milestone.id, { dueDate: event.target.value })} aria-label={`里程碑 ${index + 1} 日期`} />
                </label>
                <label className="stage-coefficient-input">
                  <span>状态</span>
                  <input value={milestone.status} onChange={(event) => patchMilestone(milestone.id, { status: event.target.value })} aria-label={`里程碑 ${index + 1} 状态`} />
                </label>
                <button type="button" className="button danger settings-icon-button" onClick={() => removeMilestone(milestone.id)} aria-label="删除里程碑" title="删除里程碑">
                  <Trash2 aria-hidden="true" />
                </button>
              </div>
            ))}
            {!milestoneDrafts.length ? <div className="empty compact">暂无里程碑。</div> : null}
          </div>
          <div className="actions-row model-config-actions">
            <Button tone="ghost" onClick={addMilestone}>
              <Plus aria-hidden="true" />
              新增里程碑
            </Button>
            <Button tone="primary" onClick={() => onSaveStages(selectedStageProjectId, stageDrafts, milestoneDrafts)} disabled={!selectedStageProject || !coefficientValid}>
              保存阶段与里程碑
            </Button>
          </div>
        </div>
      </section>
      ) : null}

      {activeSettingsPage === "emailSettings" ? (
      <section id="email-settings" className="settings-section">
        <div className="settings-section-head">
          <div className="settings-section-title">
            <span className="settings-section-icon">
              <Mail aria-hidden="true" />
            </span>
            <div>
              <h3>邮箱配置</h3>
              <p>发件账号、SMTP / IMAP 和草稿箱目录</p>
            </div>
          </div>
          <div className="settings-section-meta">
            <Badge tone={emailReady ? "success" : "warning"}>{emailReady ? "就绪" : "待配置"}</Badge>
            <span>{emailDraft.lastStatus || "未保存"}</span>
          </div>
        </div>

        <div className="email-settings-grid">
          <div className="settings-panel email-config-card">
            <div className="model-form-grid email-form-grid">
              <div className="field">
                <label>发件人名称</label>
                <input value={emailDraft.senderName} onChange={(event) => patchEmailDraft({ senderName: event.target.value })} placeholder="例如 项目经理" />
              </div>
              <div className="field">
                <label>发件邮箱</label>
                <input value={emailDraft.email} onChange={(event) => patchEmailDraft({ email: event.target.value, username: emailDraft.username || event.target.value })} placeholder="name@company.com" />
              </div>
              <div className="field">
                <label>登录账号</label>
                <input value={emailDraft.username} onChange={(event) => patchEmailDraft({ username: event.target.value })} placeholder="通常与邮箱地址一致" />
              </div>
              <div className="field">
                <label>客户端专用密码 / 授权码</label>
                <div className="key-input-control">
                  <input
                    type={showMailPassword ? "text" : "password"}
                    value={emailDraft.password}
                    onChange={(event) => patchEmailDraft({ password: event.target.value })}
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                  <button type="button" className="key-visibility-button" onClick={() => setShowMailPassword((current) => !current)} aria-label={showMailPassword ? "隐藏邮箱密码" : "显示邮箱密码"} title={showMailPassword ? "隐藏邮箱密码" : "显示邮箱密码"}>
                    {showMailPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                  </button>
                </div>
              </div>
              <div className="field">
                <label>SMTP 服务器</label>
                <input value={emailDraft.smtpHost} onChange={(event) => patchEmailDraft({ smtpHost: event.target.value })} />
              </div>
              <div className="field compact-port-field">
                <label>SMTP 端口</label>
                <input type="number" value={emailDraft.smtpPort} onChange={(event) => patchEmailDraft({ smtpPort: Number(event.target.value) || 465 })} />
                <label className="inline-check"><input type="checkbox" checked={emailDraft.smtpSecure} onChange={(event) => patchEmailDraft({ smtpSecure: event.target.checked })} /> SSL</label>
              </div>
              <div className="field">
                <label>IMAP 服务器</label>
                <input value={emailDraft.imapHost} onChange={(event) => patchEmailDraft({ imapHost: event.target.value })} />
              </div>
              <div className="field compact-port-field">
                <label>IMAP 端口</label>
                <input type="number" value={emailDraft.imapPort} onChange={(event) => patchEmailDraft({ imapPort: Number(event.target.value) || 993 })} />
                <label className="inline-check"><input type="checkbox" checked={emailDraft.imapSecure} onChange={(event) => patchEmailDraft({ imapSecure: event.target.checked })} /> SSL</label>
              </div>
              <div className="field">
                <label>草稿箱目录</label>
                <input value={emailDraft.draftsMailbox} onChange={(event) => patchEmailDraft({ draftsMailbox: event.target.value })} placeholder="Drafts 或 草稿箱" />
              </div>
              <div className="field">
                <label>最近状态</label>
                <input value={emailDraft.lastStatus || "未保存"} readOnly />
              </div>
            </div>
            <div className="actions-row model-config-actions">
              <Button tone="ghost" onClick={resetTencentEmailConfig}>
                <RotateCcw aria-hidden="true" />
                腾讯企业邮箱默认参数
              </Button>
              <Button tone="primary" onClick={() => onSaveEmailConfig(emailDraft)}>
                <Mail aria-hidden="true" />
                保存邮箱配置
              </Button>
            </div>
          </div>

          <aside className="settings-panel email-status-panel">
            <div className="model-panel-heading">
              <Inbox aria-hidden="true" />
              <div>
                <strong>邮箱状态</strong>
                <span>当前保存目标与服务参数</span>
              </div>
            </div>
            <div className="model-status-list">
              <div>
                <Mail aria-hidden="true" />
                <span>发件邮箱</span>
                <strong>{emailDraft.email || "未配置"}</strong>
              </div>
              <div>
                <RadioTower aria-hidden="true" />
                <span>SMTP</span>
                <strong>{emailDraft.smtpHost ? `${emailDraft.smtpHost}:${emailDraft.smtpPort}${emailDraft.smtpSecure ? " SSL" : ""}` : "未配置"}</strong>
              </div>
              <div>
                <Database aria-hidden="true" />
                <span>IMAP</span>
                <strong>{emailDraft.imapHost ? `${emailDraft.imapHost}:${emailDraft.imapPort}${emailDraft.imapSecure ? " SSL" : ""}` : "未配置"}</strong>
              </div>
              <div>
                <Inbox aria-hidden="true" />
                <span>草稿箱</span>
                <strong>{emailDraft.draftsMailbox || "未配置"}</strong>
              </div>
            </div>
            <div className="model-lock-note email-note">
              <LockKeyhole aria-hidden="true" />
              <span>保存到邮箱草稿箱需要 IMAP 写入权限。腾讯企业邮箱默认 SMTP 为 smtp.exmail.qq.com:465，IMAP 为 imap.exmail.qq.com:993。</span>
            </div>
          </aside>
        </div>
      </section>
      ) : null}
    </section>
  );
}
