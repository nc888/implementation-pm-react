import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AiModelConfig } from "../types";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type OpenAiEndpointCandidate = { kind: "chat" | "responses"; endpoint: string };
export type ModelStreamDeltaHandler = (delta: string, content: string) => void;
type ModelCallOptions = {
  requireProjectDataConsent?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
};
type NativeHttpHeader = { name: string; value: string };
type NativeModelHttpResponse = {
  ok?: boolean;
  status?: number;
  body?: string;
  error?: string;
};
type NativeModelHttpStreamEvent = {
  requestId?: string;
  kind?: "status" | "chunk" | "done" | "error";
  status?: number;
  chunkBase64?: string;
  error?: string;
};

const GPT55_PROXY_URL = "https://api.aicodemirror.com/api/codex/v1/chat/completions";
const DEFAULT_MAX_TOKENS = 4096;

export async function callConfiguredModel(
  config: AiModelConfig,
  messages: ChatMessage[],
  options: ModelCallOptions = {},
): Promise<string> {
  const requireProjectDataConsent = options.requireProjectDataConsent ?? true;
  const startedAt = Date.now();
  console.info("[AI调用] 准备调用模型", {
    provider: config.provider,
    model: config.model || "gpt-5.5",
    useLocalProxy: shouldUseLocalAiProxy(),
    requireProjectDataConsent,
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
    messageCount: messages.length,
    promptChars: messages.reduce((sum, message) => sum + message.content.length, 0),
  });
  if (shouldUseLocalAiProxy()) {
    const content = await callLocalAiProxy(config, messages, { requireProjectDataConsent, maxTokens: options.maxTokens, timeoutMs: options.timeoutMs });
    console.info("[AI调用] 本地代理返回成功", {
      elapsedMs: Date.now() - startedAt,
      outputChars: content.length,
    });
    return content;
  }

  if ((config.provider as string) === "local-simulated") {
    throw new Error("本地模拟模型已禁用。请配置 OpenAI Compatible 或 Ollama 远程模型。");
  }
  if (requireProjectDataConsent && !config.allowRemoteRequest) {
    throw new Error("当前模型配置未允许发送项目数据到远程模型。");
  }
  if (!config.baseUrl.trim()) {
    throw new Error(config.provider === "ollama" ? "请先配置 Ollama Base URL。" : "请先配置 OpenAI-compatible 代理 Base URL。");
  }
  if (config.provider === "openai-compatible" && !config.apiKey.trim()) {
    throw new Error("请先配置 API Key。");
  }

  const baseUrl = config.baseUrl.replace(/\/$/, "");
  if (config.provider === "ollama") {
    return callOllamaModel(config, messages, baseUrl, options.timeoutMs);
  }

  const content = await callOpenAiCompatibleDirect(config, messages, options);
  console.info("[AI调用] 远程模型返回成功", {
    elapsedMs: Date.now() - startedAt,
    outputChars: content.length,
  });
  return content;
}

export async function callConfiguredModelStreaming(
  config: AiModelConfig,
  messages: ChatMessage[],
  options: ModelCallOptions = {},
  onDelta: ModelStreamDeltaHandler = () => undefined,
): Promise<string> {
  const requireProjectDataConsent = options.requireProjectDataConsent ?? true;
  const startedAt = Date.now();
  console.info("[AI调用] 准备流式调用模型", {
    provider: config.provider,
    model: config.model || "gpt-5.5",
    useLocalProxy: shouldUseLocalAiProxy(),
    requireProjectDataConsent,
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
    messageCount: messages.length,
    promptChars: messages.reduce((sum, message) => sum + message.content.length, 0),
  });

  if (shouldUseLocalAiProxy()) {
    const content = await callLocalAiProxyStreaming(
      config,
      messages,
      { requireProjectDataConsent, maxTokens: options.maxTokens, timeoutMs: options.timeoutMs },
      onDelta,
    );
    console.info("[AI调用] 本地代理流式返回成功", {
      elapsedMs: Date.now() - startedAt,
      outputChars: content.length,
    });
    return content;
  }

  if ((config.provider as string) === "local-simulated") {
    throw new Error("本地模拟模型已禁用。请配置 OpenAI Compatible 或 Ollama 远程模型。");
  }
  if (requireProjectDataConsent && !config.allowRemoteRequest) {
    throw new Error("当前模型配置未允许发送项目数据到远程模型。");
  }
  if (!config.baseUrl.trim()) {
    throw new Error(config.provider === "ollama" ? "请先配置 Ollama Base URL。" : "请先配置 OpenAI-compatible 代理 Base URL。");
  }
  if (config.provider === "openai-compatible" && !config.apiKey.trim()) {
    throw new Error("请先配置 API Key。");
  }

  const baseUrl = config.baseUrl.replace(/\/$/, "");
  if (config.provider === "ollama") {
    return callOllamaModelStreaming(config, messages, baseUrl, options.timeoutMs, onDelta);
  }

  const content = await callOpenAiCompatibleDirectStreaming(config, messages, options, onDelta);
  return content;
}

async function callLocalAiProxy(
  config: AiModelConfig,
  messages: ChatMessage[],
  options: { requireProjectDataConsent: boolean; maxTokens?: number; timeoutMs?: number },
) {
  const startedAt = Date.now();
  console.info("[AI调用] POST /api/ai/chat 开始", {
    provider: config.provider,
    model: config.model || "gpt-5.5",
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
    messageCount: messages.length,
  });
  const response = await fetchWithTimeout("/api/ai/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      config,
      messages,
      requireProjectDataConsent: options.requireProjectDataConsent,
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs,
    }),
  }, options.timeoutMs);

  const raw = await response.text();
  console.info("[AI调用] POST /api/ai/chat 返回", {
    status: response.status,
    elapsedMs: Date.now() - startedAt,
    rawChars: raw.length,
  });
  const data = parseProxyResponse(raw) as { ok?: boolean; content?: string; error?: string };
  if (!response.ok) {
    throw new Error(data.error || `本地 AI 代理调用失败：${response.status}`);
  }
  if (data.ok === false) {
    throw new Error(data.error || "本地 AI 代理调用失败。");
  }
  if (!data.content) {
    throw new Error("本地 AI 代理返回为空。");
  }
  return data.content;
}

async function callLocalAiProxyStreaming(
  config: AiModelConfig,
  messages: ChatMessage[],
  options: { requireProjectDataConsent: boolean; maxTokens?: number; timeoutMs?: number },
  onDelta: ModelStreamDeltaHandler,
) {
  const startedAt = Date.now();
  console.info("[AI调用] POST /api/ai/chat stream 开始", {
    provider: config.provider,
    model: config.model || "gpt-5.5",
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
    messageCount: messages.length,
  });
  const response = await fetchWithTimeout("/api/ai/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      config,
      messages,
      requireProjectDataConsent: options.requireProjectDataConsent,
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs,
      stream: true,
    }),
  }, options.timeoutMs);

  const content = await readProxyStreamResponse(response, onDelta);
  console.info("[AI调用] POST /api/ai/chat stream 返回", {
    status: response.status,
    elapsedMs: Date.now() - startedAt,
    outputChars: content.length,
  });
  if (!content) {
    throw new Error("本地 AI 代理流式返回为空。");
  }
  return content;
}

function safeEndpointLabel(endpoint: string) {
  try {
    const url = new URL(endpoint);
    return `${url.host}${url.pathname}`;
  } catch {
    return endpoint.replace(/(Bearer\s+)?sk-[A-Za-z0-9_-]+/g, "sk-***");
  }
}

function shouldUseLocalAiProxy() {
  if (import.meta.env.DEV) return true;
  if (typeof window === "undefined") return false;
  return ["localhost", "127.0.0.1", "0.0.0.0"].includes(window.location.hostname);
}

function clampTimeoutMs(value: number | undefined, fallback = 60_000) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(10_000, Math.min(360_000, Math.floor(value)));
}

async function fetchWithTimeout(input: Parameters<typeof fetch>[0], init: RequestInit, timeoutMs?: number) {
  const timeout = clampTimeoutMs(timeoutMs);
  if (isTauriHttpEndpoint(input)) {
    return fetchWithTauriNative(input, init, timeout);
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as any)?.name === "AbortError") {
      throw new Error(`模型请求超过 ${Math.round(timeout / 1000)} 秒未返回，已自动中断。请检查模型服务、网络代理或缩小输入内容后重试。`);
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

function isTauriHttpEndpoint(input: Parameters<typeof fetch>[0]): input is string {
  return isTauri() && typeof input === "string" && /^https?:\/\//i.test(input);
}

function normalizeNativeHeaders(headers: HeadersInit | undefined): NativeHttpHeader[] {
  if (!headers) return [];
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return Array.from(headers.entries()).map(([name, value]) => ({ name, value }));
  }
  if (Array.isArray(headers)) {
    return headers.map(([name, value]) => ({ name, value }));
  }
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

function normalizeNativeBody(body: BodyInit | null | undefined) {
  if (typeof body === "string") return body;
  if (body == null) return "";
  return String(body);
}

async function fetchWithTauriNative(endpoint: string, init: RequestInit, timeoutMs: number) {
  const response = (await invoke("model_http_request", {
    request: {
      endpoint,
      headers: normalizeNativeHeaders(init.headers),
      body: normalizeNativeBody(init.body),
      timeoutMs,
    },
  })) as NativeModelHttpResponse;

  if (response?.ok !== true) {
    throw new Error(response?.error || "模型网络连接失败。");
  }

  const status = response.status || 200;
  return new Response(response.body || "", { status });
}

function decodeBase64Chunk(value: string) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function invokeNativeModelStreamRequest(
  endpoint: string,
  init: RequestInit,
  timeoutMs: number,
  onChunk: (chunk: string) => void,
) {
  const requestId = crypto.randomUUID();
  const decoder = new TextDecoder();
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await listen<NativeModelHttpStreamEvent>("model-http-stream", (event) => {
      const payload = event.payload;
      if (!payload || payload.requestId !== requestId) return;
      if (payload.kind === "chunk" && payload.chunkBase64) {
        const text = decoder.decode(decodeBase64Chunk(payload.chunkBase64), { stream: true });
        if (text) onChunk(text);
      }
      if (payload.kind === "error" && payload.error) {
        console.warn("[AI调用] 原生流式请求错误", payload.error);
      }
    });
    const response = (await invoke("model_http_stream_request", {
      request: {
        endpoint,
        headers: normalizeNativeHeaders(init.headers),
        body: normalizeNativeBody(init.body),
        timeoutMs,
      },
      requestId,
    })) as NativeModelHttpResponse;
    const trailing = decoder.decode();
    if (trailing) onChunk(trailing);
    if (response?.ok !== true) throw new Error(response?.error || "模型网络连接失败。");
    return response;
  } finally {
    unlisten?.();
  }
}

async function callOpenAiCompatibleDirect(
  config: AiModelConfig,
  messages: ChatMessage[],
  options: ModelCallOptions,
) {
  const endpoints = normalizeOpenAiEndpoints(config.baseUrl, config.model || "");
  const errors: string[] = [];

  for (const candidate of endpoints) {
    const streamChat = candidate.kind === "chat" && shouldStreamChatCompletion(config, candidate.endpoint);
    try {
      console.info("[AI调用] 直接请求远程模型", {
        endpointHost: safeEndpointLabel(candidate.endpoint),
        kind: candidate.kind,
        stream: streamChat,
      });
      const response = await fetchWithTimeout(candidate.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(buildOpenAiPayload(candidate.kind, config, messages, options.maxTokens, streamChat)),
      }, options.timeoutMs);
      const raw = await response.text();

      if (!response.ok) {
        const detail = normalizeResponseError(raw);
        const message = `模型调用失败：${response.status}${detail ? ` ${detail}` : ""}`;
        if (shouldTryNextEndpoint(response.status, detail, candidate.endpoint, endpoints.length)) {
          errors.push(`${safeEndpointLabel(candidate.endpoint)}：${message}`);
          continue;
        }
        throw new Error(message);
      }

      const data = parseModelResponse(raw, candidate.endpoint);
      const content = extractModelContent(data);
      if (content) return content;
      errors.push(emptyModelResponseMessage(candidate.endpoint, data));
    } catch (error) {
      const message = error instanceof Error ? error.message : "模型调用失败。";
      if (/模型调用失败：401|Invalid API Key|Unauthorized/i.test(message)) throw new Error(message);
      errors.push(message);
    }
  }

  throw new Error(errors.length ? errors.join("；") : "模型调用失败。");
}

async function callOpenAiCompatibleDirectStreaming(
  config: AiModelConfig,
  messages: ChatMessage[],
  options: ModelCallOptions,
  onDelta: ModelStreamDeltaHandler,
) {
  const endpoints = normalizeOpenAiEndpoints(config.baseUrl, config.model || "");
  const errors: string[] = [];

  for (const candidate of endpoints) {
    const streamChat = candidate.kind === "chat" && shouldStreamChatCompletion(config, candidate.endpoint);
    try {
      console.info("[AI调用] 直接流式请求远程模型", {
        endpointHost: safeEndpointLabel(candidate.endpoint),
        kind: candidate.kind,
        stream: streamChat,
      });
      if (isTauriHttpEndpoint(candidate.endpoint)) {
        const content = await callOpenAiCompatibleNativeStreaming(candidate, config, messages, options, streamChat, onDelta);
        if (content) return content;
        errors.push(`${safeEndpointLabel(candidate.endpoint)}：模型返回为空。`);
        continue;
      }
      const response = await fetchWithTimeout(candidate.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(buildOpenAiPayload(candidate.kind, config, messages, options.maxTokens, streamChat)),
      }, options.timeoutMs);

      if (!response.ok) {
        const raw = await response.text();
        const detail = normalizeResponseError(raw);
        const message = `模型调用失败：${response.status}${detail ? ` ${detail}` : ""}`;
        if (shouldTryNextEndpoint(response.status, detail, candidate.endpoint, endpoints.length)) {
          errors.push(`${safeEndpointLabel(candidate.endpoint)}：${message}`);
          continue;
        }
        throw new Error(message);
      }

      const content = await readModelStreamResponse(response, candidate.endpoint, onDelta);
      if (content) return content;
      errors.push(`${safeEndpointLabel(candidate.endpoint)}：模型返回为空。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "模型调用失败。";
      if (/模型调用失败：401|Invalid API Key|Unauthorized/i.test(message)) throw new Error(message);
      errors.push(message);
    }
  }

  throw new Error(errors.length ? errors.join("；") : "模型流式调用失败。");
}

async function callOpenAiCompatibleNativeStreaming(
  candidate: OpenAiEndpointCandidate,
  config: AiModelConfig,
  messages: ChatMessage[],
  options: ModelCallOptions,
  streamChat: boolean,
  onDelta: ModelStreamDeltaHandler,
) {
  let raw = "";
  let buffer = "";
  let content = "";
  let errorMessage = "";

  const handleSsePayload = (payload: string) => {
    if (!payload) return;
    if (payload === "[DONE]") return;
    try {
      const data = JSON.parse(payload);
      const error = extractModelError(data);
      if (error) {
        errorMessage = error;
        return;
      }
      const delta = extractModelStreamDelta(data);
      if (delta) {
        content += delta;
        onDelta(delta, content);
      }
    } catch {
      // Non-SSE JSON responses are parsed after the request completes.
    }
  };

  const handleChunk = (chunk: string) => {
    raw += chunk;
    buffer += chunk;
    const split = splitSseBuffer(buffer);
    buffer = split.rest;
    for (const eventText of split.events) {
      const event = parseSseEvent(eventText);
      handleSsePayload(event.data);
    }
  };

  const response = await invokeNativeModelStreamRequest(
    candidate.endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(buildOpenAiPayload(candidate.kind, config, messages, options.maxTokens, streamChat)),
    },
    clampTimeoutMs(options.timeoutMs),
    handleChunk,
  );

  const status = response.status || 0;
  const finalRaw = response.body || raw;
  if (status < 200 || status >= 300) {
    const detail = normalizeResponseError(finalRaw);
    throw new Error(`模型调用失败：${status}${detail ? ` ${detail}` : ""}`);
  }

  if (buffer.trim()) {
    const event = parseSseEvent(buffer);
    handleSsePayload(event.data);
  }
  if (errorMessage) throw new Error(errorMessage);
  if (content) return content;

  const data = parseModelResponse(finalRaw, candidate.endpoint);
  content = extractModelContent(data);
  if (content) emitFullContent(content, onDelta);
  if (!content) throw new Error(emptyModelResponseMessage(candidate.endpoint, data));
  return content;
}

function parseProxyResponse(raw: string) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    const preview = raw.trim().slice(0, 220);
    if (/^<!doctype|^<html/i.test(preview)) {
      throw new Error("本地 AI 代理没有生效，/api/ai/chat 返回了前端页面。请重启 localhost:5174 的开发服务后再测试。");
    }
    throw new Error(`本地 AI 代理返回非 JSON：${preview || "空响应"}`);
  }
}

function parseModelResponse(raw: string, endpoint = "") {
  if (/^\s*data:/m.test(raw)) {
    return { output_text: extractSseContent(raw) };
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    const preview = raw.trim().slice(0, 220);
    const htmlHint = /^<!doctype|^<html/i.test(preview)
      ? "远端返回了 HTML 页面，不是模型 API JSON。请检查 Base URL 是否应指向 /responses 或 /v1/chat/completions。"
      : `远端返回非 JSON：${preview || "空响应"}`;
    throw new Error(endpoint ? `${htmlHint} 目标：${safeEndpointLabel(endpoint)}。` : htmlHint);
  }
}

function normalizeResponseError(raw: string) {
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
      if (chunk) parts.push(chunk);
    } catch {
      continue;
    }
  }
  return parts.join("").trim();
}

async function readProxyStreamResponse(response: Response, onDelta: ModelStreamDeltaHandler) {
  if (!response.ok) {
    const raw = await response.text();
    const data = parseProxyResponse(raw) as { error?: string };
    throw new Error(data.error || `本地 AI 代理流式调用失败：${response.status}`);
  }

  let content = "";
  let errorMessage = "";
  const raw = await readEventStream(response, (eventName, payload) => {
    if (!payload) return false;
    if (payload === "[DONE]") return true;
    try {
      const data = JSON.parse(payload);
      if (eventName === "error" || data.ok === false || data.error) {
        errorMessage = String(data.error || "本地 AI 代理流式调用失败。");
        return true;
      }
      if (eventName === "done") {
        if (typeof data.content === "string" && data.content) {
          const finalContent = data.content;
          const appended = finalContent.startsWith(content) ? finalContent.slice(content.length) : "";
          content = finalContent;
          if (appended) onDelta(appended, content);
        }
        return true;
      }
      const delta = extractProxyStreamDelta(data);
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

  const data = parseProxyResponse(raw) as { ok?: boolean; content?: string; error?: string };
  if (data.ok === false) throw new Error(data.error || "本地 AI 代理调用失败。");
  if (data.content) emitFullContent(data.content, onDelta);
  return data.content || "";
}

function extractProxyStreamDelta(data: any): string {
  if (typeof data?.delta === "string") return data.delta;
  const modelDelta = extractModelStreamDelta(data);
  if (modelDelta) return modelDelta;
  if (typeof data?.content === "string" && data?.ok !== true) return data.content;
  return "";
}

async function readModelStreamResponse(response: Response, endpoint: string, onDelta: ModelStreamDeltaHandler) {
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

  const data = parseModelResponse(raw || "");
  content = extractModelContent(data);
  if (content) emitFullContent(content, onDelta);
  if (!content && endpoint) throw new Error(emptyModelResponseMessage(endpoint, data));
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

function emitFullContent(content: string, onDelta: ModelStreamDeltaHandler) {
  if (content) onDelta(content, content);
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

function jsonPreview(value: unknown, maxLength = 180) {
  try {
    return JSON.stringify(value).slice(0, maxLength);
  } catch {
    return String(value).slice(0, maxLength);
  }
}

function contentShape(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

function emptyModelResponseMessage(endpoint: string, data: any) {
  const choice = data?.choices?.[0];
  const message = choice?.message || data?.message || {};
  const content = message?.content ?? choice?.text ?? data?.output_text ?? data?.text ?? data?.response;
  const reasoningContent = message?.reasoning_content ?? choice?.delta?.reasoning_content;
  const details = [
    choice?.finish_reason ? `finish_reason=${choice.finish_reason}` : "",
    `content=${contentShape(content)}`,
    typeof reasoningContent === "string" && reasoningContent ? `reasoning_content=${reasoningContent.length}字` : "",
    data?.usage ? `usage=${jsonPreview(data.usage)}` : "",
    data && typeof data === "object" ? `keys=${Object.keys(data).slice(0, 8).join(",")}` : "",
  ].filter(Boolean).join("；");
  return `${safeEndpointLabel(endpoint)}：模型返回为空${details ? `（${details}）` : ""}。`;
}

function isGpt5Model(model: string) {
  return /^gpt-5(?:[.-]|$)/i.test(model);
}

function isKimiFixedTemperatureModel(model: string) {
  return /^kimi-k2\.6(?:[.-]|$)/i.test(model);
}

function isKimiModel(model: string) {
  return /^kimi-/i.test(model) || /^moonshot-/i.test(model);
}

function isKimiThinkingToggleModel(model: string) {
  return /^kimi-k2\.(?:5|6)(?:[.-]|$)/i.test(model);
}

function isMoonshotBaseUrl(baseUrl: string) {
  try {
    const host = new URL(baseUrl).host;
    return /(?:^|\.)moonshot\.(?:cn|ai)$/i.test(host) || /(?:^|\.)kimi\.(?:com|ai)$/i.test(host);
  } catch {
    return /moonshot\.(?:cn|ai)|kimi\.(?:com|ai)/i.test(baseUrl);
  }
}

function openAiCompatibleTemperature(config: AiModelConfig, model: string) {
  if (isKimiModel(model)) return undefined;
  if (isKimiFixedTemperatureModel(model)) return 1;
  return typeof config.temperature === "number" ? config.temperature : undefined;
}

function openAiCompatibleTokenLimit(model: string, maxTokens?: number) {
  const tokenLimit = clampMaxTokens(maxTokens);
  return isKimiModel(model) ? Math.max(tokenLimit, 4096) : tokenLimit;
}

function normalizeOpenAiEndpoints(baseUrl: string, model: string): OpenAiEndpointCandidate[] {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return [{ kind: "chat", endpoint: base }];
  if (base.endsWith("/responses")) return [{ kind: "responses", endpoint: base }];
  try {
    const url = new URL(base);
    if (url.host === "api.aicodemirror.com" || /\/backend-api\/codex$/.test(url.pathname) || /\/codex$/.test(url.pathname)) {
      return [{ kind: "chat", endpoint: GPT55_PROXY_URL }];
    }
    if (url.host === "api.moonshot.cn") {
      const pathBase = url.pathname === "/" ? `${url.origin}/v1` : base;
      return [{ kind: "chat", endpoint: `${pathBase.replace(/\/+$/, "")}/chat/completions` }];
    }
  } catch {
    if (/backend-api\/codex$/.test(base) || /\/codex$/.test(base)) return [{ kind: "chat", endpoint: GPT55_PROXY_URL }];
  }
  const candidates = isGpt5Model(model) && base.includes("aicodemirror.com")
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

function clampMaxTokens(value: number | undefined, fallback = DEFAULT_MAX_TOKENS) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(16, Math.min(8192, Math.floor(value)));
}

function shouldStreamChatCompletion(config: AiModelConfig, endpoint: string) {
  return isGpt5Model(config.model || "") && endpoint.includes("api.aicodemirror.com");
}

function shouldTryNextEndpoint(status: number, detail: string, endpoint: string, total: number) {
  if (total <= 1) return false;
  if (status === 404 || status === 405 || status === 501) return true;
  if (status === 400 && /not found|unknown|invalid endpoint|route|path|responses|chat/i.test(detail)) return true;
  if (/chat\/completions$/.test(endpoint) && !detail) return true;
  return false;
}

function buildOpenAiPayload(
  kind: OpenAiEndpointCandidate["kind"],
  config: AiModelConfig,
  messages: ChatMessage[],
  maxTokens?: number,
  streamChat = false,
) {
  const model = config.model || "gpt-5.5";
  const tokenLimit = openAiCompatibleTokenLimit(model, maxTokens);
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
  if (isMoonshotBaseUrl(config.baseUrl) && isKimiThinkingToggleModel(model)) {
    body.thinking = { type: "disabled" };
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
  if (isMoonshotBaseUrl(config.baseUrl) && isKimiThinkingToggleModel(model)) {
    body.thinking = { type: "disabled" };
  }
  return body;
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
      .map((item: any) => (typeof item === "string" ? item : item?.text || item?.content || ""))
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

async function callOllamaModel(config: AiModelConfig, messages: ChatMessage[], baseUrl: string, timeoutMs?: number) {
  const endpoint = baseUrl.endsWith("/api/chat") ? baseUrl : baseUrl.endsWith("/api") ? `${baseUrl}/chat` : `${baseUrl}/api/chat`;
  const response = await fetchWithTimeout(endpoint, {
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
  }, timeoutMs);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama 调用失败：${response.status} ${text.slice(0, 240)}`);
  }

  const data = await response.json();
  const content = extractModelContent(data);
  if (!content) {
    throw new Error("Ollama 返回为空。");
  }
  return content;
}

async function callOllamaModelStreaming(
  config: AiModelConfig,
  messages: ChatMessage[],
  baseUrl: string,
  timeoutMs: number | undefined,
  onDelta: ModelStreamDeltaHandler,
) {
  const endpoint = baseUrl.endsWith("/api/chat") ? baseUrl : baseUrl.endsWith("/api") ? `${baseUrl}/chat` : `${baseUrl}/api/chat`;
  const response = await fetchWithTimeout(endpoint, {
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
  }, timeoutMs);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama 调用失败：${response.status} ${text.slice(0, 240)}`);
  }

  if (!response.body) {
    const data = await response.json();
    const content = extractModelContent(data);
    if (content) emitFullContent(content, onDelta);
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

export function defaultModelConfig(configs: AiModelConfig[]) {
  return configs.find((item) => item.isDefault) || configs[0];
}
