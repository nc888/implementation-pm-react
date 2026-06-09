import type { AiMessage, AssistantScope } from "../types";

export function normalizeAssistantScope(scope: AssistantScope | undefined): AssistantScope {
  return scope === "all" ? "all" : "project";
}

export function assistantSessionMessages(messages: AiMessage[], scope: AssistantScope, projectId: string) {
  return messages.filter((message) => {
    if (message.scope === "all") return scope === "all";
    if (message.scope === "project") return scope === "project" && message.projectId === projectId;
    return false;
  });
}

export function assistantSessionProjectId(scope: AssistantScope, projectId: string) {
  return scope === "project" ? projectId : "";
}
