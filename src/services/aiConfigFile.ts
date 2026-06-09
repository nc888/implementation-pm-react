import type { AiModelConfig } from "../types";

type AiConfigFileResponse = {
  ok?: boolean;
  config?: AiModelConfig | null;
  error?: string;
  path?: string;
};

const canUseLocalConfigFile = () => {
  if (typeof window === "undefined") return false;
  return ["localhost", "127.0.0.1", "0.0.0.0"].includes(window.location.hostname);
};

export async function loadAiConfigFromFile() {
  if (!canUseLocalConfigFile()) return null;
  const response = await fetch("/api/ai/config");
  const data = (await response.json().catch(() => ({}))) as AiConfigFileResponse;
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || "AI 配置文件读取失败。");
  }
  return data.config || null;
}

export async function saveAiConfigToFile(config: AiModelConfig) {
  if (!canUseLocalConfigFile()) return null;
  const response = await fetch("/api/ai/config", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ config }),
  });
  const data = (await response.json().catch(() => ({}))) as AiConfigFileResponse;
  if (!response.ok || data.ok === false || !data.config) {
    throw new Error(data.error || "AI 配置文件保存失败。");
  }
  return data.config;
}
