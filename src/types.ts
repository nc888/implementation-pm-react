export type PageKey =
  | "portal"
  | "dashboard"
  | "overview"
  | "board"
  | "list"
  | "scope"
  | "gantt"
  | "deliverables"
  | "risks"
  | "weekly"
  | "weeklyHistory"
  | "sow"
  | "resourceEval"
  | "hardwareEval"
  | "wbsPlan"
  | "implementationPlan"
  | "assistant"
  | "settings"
  | "modelSettings"
  | "stageSettings"
  | "emailSettings";

export type TaskStatus = "todo" | "doing" | "customer" | "blocked" | "done";
export type TaskStage = string;
export type RiskKind = "risk" | "issue";
export type RiskVisibility = "internal" | "external";
export type AssistantScope = "project" | "all";
export type ScopeCategory = "本期SOW范围" | "变更增加范围" | "不在本期范围";
export type PersonDayType = "实施" | "开发";
export type ProjectImplementationMode = "本地实施" | "出差实施";
export type WeeklyProjectStatus = "健康" | "延期" | "暂停" | "需关注" | "风险";
export type WeeklyMailDraftStatus = "not-created" | "local-draft" | "mailbox-draft" | "failed";
export type WeeklyMarkdownArchiveStatus = "not-archived" | "archived" | "failed";
export type WeeklyReportAudience = "internal" | "customer";
export type ProjectStatus = "active" | "archived";

export interface TaskStageDefinition {
  id: string;
  label: string;
  coefficient?: number;
}

export interface ProjectMilestone {
  id: string;
  title: string;
  dueDate: string;
  status: string;
  description: string;
}

export interface ProjectStageConfig {
  projectId: string;
  stages: TaskStageDefinition[];
  milestones: ProjectMilestone[];
  updatedAt: string;
}

export interface UiState {
  currentPage: PageKey;
  currentProjectId: string;
  search: string;
  assistantScope: AssistantScope;
}

export interface Project {
  id: string;
  name: string;
  client: string;
  phase: string;
  health: "健康" | "关注" | "延期";
  status?: ProjectStatus;
  archivedAt?: string;
  archiveReason?: string;
  owner: string;
  startDate: string;
  endDate: string;
  progress: number;
  nextMilestone: string;
  description: string;
  estimatedImplementationPersonDays: number;
  estimatedDevelopmentPersonDays: number;
  deliverableStoragePath?: string;
}

export interface Task {
  id: string;
  projectId: string;
  parentId: string;
  code: string;
  title: string;
  type: string;
  status: TaskStatus;
  stage: TaskStage;
  dimension: string;
  priority: "高" | "中" | "低";
  owner: string;
  startDate: string;
  dueDate: string;
  progress: number;
  updatedAt: string;
}

export interface ScopeItem {
  id: string;
  projectId: string;
  category: ScopeCategory;
  personDayType: PersonDayType;
  title: string;
  description: string;
  estimatedPersonDays: number;
  actualPersonDays: number;
  progress: number;
  content: string;
}

export interface Deliverable {
  id: string;
  projectId: string;
  name: string;
  code: string;
  linkedTaskId?: string;
  status: string;
  acceptance: string;
  dueDate: string;
  attachmentRequirement?: "required" | "none";
  attachmentName?: string;
  attachmentPath?: string;
  attachmentUploadedAt?: string;
}

export type DeliverableBulkPatch = Partial<Pick<Deliverable, "status" | "acceptance" | "dueDate" | "attachmentRequirement">>;

export interface RiskIssue {
  id: string;
  projectId: string;
  kind: RiskKind;
  title: string;
  severity: "高" | "中" | "低";
  status: "open" | "tracking" | "closed";
  riskVisibility: RiskVisibility;
  responsePlan: string;
  internalHandling: string;
  customerAssistance: string;
  linkedTaskId: string;
}

export interface AiModelConfig {
  id: string;
  name: string;
  provider: "openai-compatible" | "ollama";
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  isDefault: boolean;
  allowRemoteRequest: boolean;
  lastHealth: string;
}

export interface AiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  scope?: AssistantScope;
  projectId?: string;
}

export interface WeeklyReport {
  id: string;
  projectId: string;
  audience: WeeklyReportAudience;
  reportDate: string;
  title: string;
  content: string;
  generatedBy: "manual" | "ai";
  projectOwner: string;
  implementationPersonnel: string;
  implementationMode: ProjectImplementationMode;
  projectStatus: WeeklyProjectStatus;
  thisWeekTaskIds: string[];
  nextWeekTaskIds: string[];
  recipientsTo: string;
  recipientsCc: string;
  mailSubject: string;
  mailDraftStatus: WeeklyMailDraftStatus;
  mailDraftMessage: string;
  mailDraftedAt: string;
  markdownArchiveStatus: WeeklyMarkdownArchiveStatus;
  markdownArchiveMessage: string;
  markdownArchiveFileName: string;
  markdownArchivePath: string;
  markdownArchivedAt: string;
  snapshot: ProjectSnapshot;
  createdAt: string;
  updatedAt: string;
}

export type WeeklyReportInput = Pick<WeeklyReport, "projectId" | "content"> &
  Partial<Omit<WeeklyReport, "projectId" | "content" | "createdAt" | "updatedAt">>;

export interface WeeklyReportPreference {
  projectId: string;
  projectOwner: string;
  implementationPersonnel: string;
  implementationMode: ProjectImplementationMode;
  projectStatus: WeeklyProjectStatus;
  recipientsTo: string;
  recipientsCc: string;
  customerRecipientsTo: string;
  customerRecipientsCc: string;
  mailSubjectTemplate: string;
  customerMailSubjectTemplate: string;
  updatedAt: string;
}

export type WeeklyReportPreferenceInput = Pick<WeeklyReportPreference, "projectId"> &
  Partial<Omit<WeeklyReportPreference, "projectId" | "updatedAt">>;

export interface EmailConfig {
  provider: "tencent-exmail" | "custom";
  senderName: string;
  email: string;
  username: string;
  password: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  draftsMailbox: string;
  lastStatus: string;
  updatedAt: string;
}

export interface SowInput {
  projectId: string;
  content: string;
  fileName: string;
  updatedAt: string;
}

export interface AiDraft {
  content: string;
  generatedAt: string;
  model: string;
  status: "empty" | "draft" | "edited";
}

export interface ProjectFlowState {
  status: "not_started" | "draft_ready" | "confirmed";
  confirmedAt: string;
  generatedTaskIds: string[];
  generatedDeliverableIds: string[];
  sourceDraftAt: string;
}

export interface ResourceAssessmentInputs {
  hasFixedPersonDays: boolean;
  fixedPersonDays: string;
  analysisAppCount: string;
  analysisBusinessSystemCount: string;
  agentCount: string;
  syslogCount: string;
  dailyDataVolume: string;
  dailyDataUnit: "GB" | "TB";
  peakFactor: string;
  singleNodeUsableTb: string;
  singleNodeCapacityUnit: "GB" | "TB";
  nodeCount: string;
  retentionDays: string;
  needsFlink: boolean;
  includesSiem: boolean;
  includesUeba: boolean;
  involvesDataMigration: boolean;
}

export interface WorkflowHandoffContent {
  sow: string;
  personDay: string;
  hardware: string;
  wbs: string;
}

export interface WorkflowSupplementContent {
  sow: string;
  personDay: string;
  hardware: string;
  wbs: string;
  implementation: string;
}

export interface DeliveryWorkflow {
  projectId: string;
  sow: SowInput;
  resourceInputs: ResourceAssessmentInputs;
  handoff: WorkflowHandoffContent;
  supplements: WorkflowSupplementContent;
  personDayAssessment: AiDraft;
  hardwareAssessment: AiDraft;
  wbsPlan: AiDraft;
  implementationPlan: AiDraft;
  projectFlow: ProjectFlowState;
}

export interface AiScore {
  id: string;
  projectId: string;
  score: number;
  level: "绿灯" | "黄灯" | "红灯";
  mode: "rule-only" | "ai-enhanced";
  summary: string;
  actions: string[];
  createdAt: string;
}

export interface AppState {
  schemaVersion: number;
  ui: UiState;
  taskStages: TaskStageDefinition[];
  projectStageConfigs: ProjectStageConfig[];
  projects: Project[];
  tasks: Task[];
  scopeItems: ScopeItem[];
  deliverables: Deliverable[];
  risksIssues: RiskIssue[];
  aiModelConfigs: AiModelConfig[];
  aiMessages: AiMessage[];
  aiScores: AiScore[];
  weeklyReports: WeeklyReport[];
  weeklyReportPreferences: WeeklyReportPreference[];
  emailConfig: EmailConfig;
  deliveryWorkflows: DeliveryWorkflow[];
}

export interface ProjectMetrics {
  done: number;
  blocked: number;
  customer: number;
  open: number;
  openHighRisks: number;
  issues: number;
  pendingDeliverables: number;
  overdue: number;
  completionRate: number;
  estimatedPersonDays: number;
  actualPersonDays: number;
  personDayUsageRate: number;
  implementationEstimatedPersonDays: number;
  implementationActualPersonDays: number;
  implementationPersonDayUsageRate: number;
  developmentEstimatedPersonDays: number;
  developmentActualPersonDays: number;
  developmentPersonDayUsageRate: number;
}

export interface ProjectSnapshot {
  schemaVersion: "1.0";
  projectId: string;
  generatedAt: string;
  purpose: "chat" | "score" | "weekly-report";
  project: Pick<Project, "id" | "name" | "client" | "phase" | "health" | "progress" | "nextMilestone">;
  metrics: ProjectMetrics & {
    totalTasks: number;
    pendingDeliverables: number;
  };
  tasks: Array<Pick<Task, "code" | "title" | "status" | "priority" | "startDate" | "dueDate" | "dimension" | "parentId">>;
  risks: Array<Pick<RiskIssue, "kind" | "title" | "severity" | "status" | "riskVisibility" | "responsePlan">>;
  deliverables: Array<Pick<Deliverable, "code" | "name" | "status" | "acceptance" | "dueDate">>;
}
