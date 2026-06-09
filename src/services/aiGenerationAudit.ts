export type AiGenerationRunStatus = "running" | "success" | "failed";

export type AiGenerationRunPayload = {
  id: string;
  projectId: string;
  kind: string;
  model?: string;
  status: AiGenerationRunStatus;
  inputSnapshot?: Record<string, unknown>;
  outputContent?: string;
  errorMessage?: string;
  createdAt?: string;
  completedAt?: string;
};

export async function recordAiGenerationRun(run: AiGenerationRunPayload) {
  try {
    await fetch("/api/ai/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run }),
    });
  } catch (error) {
    console.warn("AI generation audit unavailable.", error);
  }
}
