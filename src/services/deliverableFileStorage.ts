import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Project, WeeklyReportAudience } from "../types";

export type LocalWritableFile = {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
};

export type LocalFileHandle = {
  getFile(): Promise<File>;
  createWritable(): Promise<LocalWritableFile>;
};

export type LocalDirectoryHandle = {
  name: string;
  queryPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<LocalDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<LocalFileHandle>;
  removeEntry?: (name: string, options?: { recursive?: boolean }) => Promise<void>;
};

type DirectoryPickerWindow = {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<LocalDirectoryHandle>;
};

export type DeliverableDirectoryRecord = {
  projectId: string;
  handle?: LocalDirectoryHandle | null;
  pathLabel: string;
  updatedAt: string;
  mode?: "browser" | "desktop";
};

type NativeFileResponse = {
  ok?: boolean;
  path?: string;
  cancelled?: boolean;
  error?: string;
};

export type AttachmentSaveResult = {
  attachmentName: string;
  attachmentPath: string;
  attachmentUploadedAt: string;
};

export type WeeklyReportMarkdownSaveResult = {
  fileName: string;
  filePath: string;
  archivedAt: string;
};

export type ProjectCsvSaveResult = {
  fileName: string;
  filePath: string;
  savedAt: string;
};

const deliverableDirectoryHandles = new Map<string, LocalDirectoryHandle>();
const deliverableDirectoryPathLabels = new Map<string, string>();
const deliverableDirectoryDbName = "implementation-pm-file-handles";
const deliverableDirectoryStoreName = "deliverableDirectories";

export function sanitizePathSegment(value: string) {
  return (value || "未分阶段").replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim() || "未分阶段";
}

export function getDirectoryPicker() {
  return (window as unknown as DirectoryPickerWindow).showDirectoryPicker;
}

function isNativeAbsolutePath(value: string | undefined) {
  const normalized = (value || "").trim();
  return /^[a-zA-Z]:[\\/]/.test(normalized) || normalized.startsWith("\\\\") || normalized.startsWith("/");
}

function ensureNativeResponse(response: NativeFileResponse, fallback: string) {
  if (response.ok && response.path) return response.path;
  if (response.cancelled) {
    throw new DOMException("Directory selection was cancelled.", "AbortError");
  }
  throw new Error(response.error || fallback);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function textToBase64(value: string) {
  return bytesToBase64(new TextEncoder().encode(value));
}

async function fileToBase64(file: File) {
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

async function writeNativeProjectFile(projectPath: string, relativePath: string, contentBase64: string) {
  return ensureNativeResponse(
    await invoke<NativeFileResponse>("write_project_file", {
      projectPath,
      relativePath,
      contentBase64,
    }),
    "文件写入失败，请重新选择保存路径后重试。",
  );
}

async function deleteNativeProjectFile(projectPath: string, relativePath: string) {
  ensureNativeResponse(
    await invoke<NativeFileResponse>("delete_project_file", {
      projectPath,
      relativePath,
    }),
    "文件删除失败，请重新选择保存路径后重试。",
  );
}

async function moveNativeProjectFile(projectPath: string, sourceRelativePath: string, targetRelativePath: string) {
  return ensureNativeResponse(
    await invoke<NativeFileResponse>("move_project_file", {
      projectPath,
      sourceRelativePath,
      targetRelativePath,
    }),
    "附件移动失败，请重新选择保存路径后重试。",
  );
}

export function getCachedDeliverableDirectory(projectId: string): DeliverableDirectoryRecord | null {
  const handle = deliverableDirectoryHandles.get(projectId);
  const pathLabel = deliverableDirectoryPathLabels.get(projectId);
  if (!handle && !pathLabel) return null;
  return {
    projectId,
    handle: handle || null,
    pathLabel: pathLabel || handle?.name || "",
    updatedAt: "",
    mode: handle ? "browser" : "desktop",
  } satisfies DeliverableDirectoryRecord;
}

export function getDeliverableDirectoryPathLabel(projectId: string) {
  return deliverableDirectoryPathLabels.get(projectId) || "";
}

function requestToPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function openDeliverableDirectoryDb() {
  if (typeof indexedDB === "undefined") return null;
  const request = indexedDB.open(deliverableDirectoryDbName, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(deliverableDirectoryStoreName)) {
      db.createObjectStore(deliverableDirectoryStoreName, { keyPath: "projectId" });
    }
  };
  return requestToPromise(request);
}

export async function saveDeliverableDirectoryHandle(projectId: string, handle: LocalDirectoryHandle, pathLabel: string) {
  deliverableDirectoryHandles.set(projectId, handle);
  deliverableDirectoryPathLabels.set(projectId, pathLabel);
  try {
    const db = await openDeliverableDirectoryDb();
    if (!db) return;
    const transaction = db.transaction(deliverableDirectoryStoreName, "readwrite");
    transaction.objectStore(deliverableDirectoryStoreName).put({
      projectId,
      handle,
      pathLabel,
      updatedAt: new Date().toISOString(),
    } satisfies DeliverableDirectoryRecord);
    await transactionDone(transaction);
    db.close();
  } catch {
    // The handle is still available for the current session.
  }
}

export async function loadDeliverableDirectoryHandle(projectId: string) {
  const cached = getCachedDeliverableDirectory(projectId);
  if (cached) return cached;
  try {
    const db = await openDeliverableDirectoryDb();
    if (!db) return null;
    const transaction = db.transaction(deliverableDirectoryStoreName, "readonly");
    const record = await requestToPromise<DeliverableDirectoryRecord | undefined>(transaction.objectStore(deliverableDirectoryStoreName).get(projectId));
    db.close();
    if (!record?.handle) return null;
    deliverableDirectoryHandles.set(projectId, record.handle);
    deliverableDirectoryPathLabels.set(projectId, record.pathLabel);
    return record;
  } catch {
    return null;
  }
}

export async function ensureDirectoryWritePermission(handle: LocalDirectoryHandle) {
  try {
    const current = await handle.queryPermission?.({ mode: "readwrite" });
    if (current === "granted" || (!handle.queryPermission && !handle.requestPermission)) return true;
    const requested = await handle.requestPermission?.({ mode: "readwrite" });
    return requested === "granted";
  } catch {
    return false;
  }
}

function normalizeFileSystemError(error: unknown, fallback: string) {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
    return new Error("目录句柄权限已失效，请重新选择交付物保存路径。");
  }
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return new Error("未找到原附件文件，请重新上传附件。");
  }
  return error instanceof Error ? error : new Error(fallback);
}

export async function chooseDeliverableProjectDirectory(project: Pick<Project, "id" | "name">) {
  if (isTauri()) {
    const pathLabel = ensureNativeResponse(
      await invoke<NativeFileResponse>("select_deliverable_project_directory", {
        projectName: project.name,
      }),
      "选择保存路径失败。",
    );
    deliverableDirectoryPathLabels.set(project.id, pathLabel);
    return {
      projectId: project.id,
      handle: null,
      pathLabel,
      updatedAt: new Date().toISOString(),
      mode: "desktop",
    } satisfies DeliverableDirectoryRecord;
  }

  const picker = getDirectoryPicker();
  if (!picker) {
    throw new Error("当前浏览器不支持选择本机文件夹。");
  }
  const baseHandle = await picker({ mode: "readwrite" });
  const projectFolderName = sanitizePathSegment(project.name);
  const projectHandle = await baseHandle.getDirectoryHandle(projectFolderName, { create: true });
  const pathLabel = `${baseHandle.name}/${projectFolderName}`;
  await saveDeliverableDirectoryHandle(project.id, projectHandle, pathLabel);
  return {
    projectId: project.id,
    handle: projectHandle,
    pathLabel,
    updatedAt: new Date().toISOString(),
    mode: "browser",
  } satisfies DeliverableDirectoryRecord;
}

async function resolveWritableProjectDirectory(projectId: string, storageLabel?: string): Promise<DeliverableDirectoryRecord> {
  const nativeStorageLabel = isNativeAbsolutePath(storageLabel) ? storageLabel : deliverableDirectoryPathLabels.get(projectId);
  if (isTauri() && isNativeAbsolutePath(nativeStorageLabel)) {
    deliverableDirectoryPathLabels.set(projectId, nativeStorageLabel || "");
    return {
      projectId,
      handle: null,
      pathLabel: nativeStorageLabel || "",
      updatedAt: "",
      mode: "desktop",
    } satisfies DeliverableDirectoryRecord;
  }
  const record = await loadDeliverableDirectoryHandle(projectId);
  if (!record?.handle) {
    throw new Error("请先选择交付物文件保存路径。");
  }
  return record;
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function normalizeMarkdownFileName(fileName: string) {
  const normalizedBase = sanitizePathSegment((fileName || "项目周报").replace(/\.md$/i, ""));
  return `${normalizedBase}.md`;
}

function weeklyReportAudienceFolder(audience?: WeeklyReportAudience) {
  return audience === "customer" ? "客户" : "内部";
}

async function removeRequiredDirectoryEntry(directory: LocalDirectoryHandle, fileName: string) {
  if (!directory.removeEntry) {
    throw new Error("当前浏览器不支持删除目录中的文件。");
  }
  await directory.removeEntry(fileName);
}

function normalizeCsvFileName(fileName: string) {
  const normalizedBase = sanitizePathSegment((fileName || "项目数据").replace(/\.csv$/i, ""));
  return `${normalizedBase}.csv`;
}

function parseAttachmentRef(attachmentPath: string | undefined, fallbackName: string | undefined) {
  if (!attachmentPath && !fallbackName) return null;
  const segments = normalizePath(attachmentPath || fallbackName || "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const fileName = segments.at(-1) || fallbackName || "";
  const folderName = segments.length >= 2 ? segments.at(-2) || "" : "";
  if (!fileName) return null;
  return { folderName, fileName };
}

async function removeAttachmentFile(handle: LocalDirectoryHandle, attachmentPath: string | undefined, fallbackName: string | undefined) {
  const ref = parseAttachmentRef(attachmentPath, fallbackName);
  if (!ref?.folderName || !handle.removeEntry) return;
  try {
    const folder = await handle.getDirectoryHandle(ref.folderName);
    await folder.removeEntry?.(ref.fileName);
  } catch {
    // Removing the old file is best-effort; the new file has already been written.
  }
}

export async function saveDeliverableAttachmentFile({
  projectId,
  storageLabel,
  stageLabel,
  file,
  previousAttachmentPath,
  previousAttachmentName,
}: {
  projectId: string;
  storageLabel: string;
  stageLabel: string;
  file: File;
  previousAttachmentPath?: string;
  previousAttachmentName?: string;
}): Promise<AttachmentSaveResult> {
  const record = await resolveWritableProjectDirectory(projectId, storageLabel);
  const folderName = sanitizePathSegment(stageLabel);
  const pathLabel = record.pathLabel || storageLabel || record.handle?.name || "";
  const attachmentPath = `${pathLabel}/${folderName}/${file.name}`;

  if (record.mode === "desktop") {
    await writeNativeProjectFile(pathLabel, `${folderName}/${file.name}`, await fileToBase64(file));
    if (previousAttachmentPath && normalizePath(previousAttachmentPath) !== normalizePath(attachmentPath)) {
      const ref = parseAttachmentRef(previousAttachmentPath, previousAttachmentName);
      if (ref?.folderName) {
        await deleteNativeProjectFile(pathLabel, `${ref.folderName}/${ref.fileName}`);
      }
    }
    return {
      attachmentName: file.name,
      attachmentPath,
      attachmentUploadedAt: new Date().toISOString(),
    };
  }

  if (!record.handle) {
    throw new Error("请先选择交付物文件保存路径。");
  }

  try {
    const stageDirectory = await record.handle.getDirectoryHandle(folderName, { create: true });
    const fileHandle = await stageDirectory.getFileHandle(file.name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(file);
    await writable.close();
  } catch (error) {
    throw normalizeFileSystemError(error, "附件保存失败，请重新选择保存路径后重试。");
  }

  if (previousAttachmentPath && normalizePath(previousAttachmentPath) !== normalizePath(attachmentPath)) {
    await removeAttachmentFile(record.handle, previousAttachmentPath, previousAttachmentName);
  }

  return {
    attachmentName: file.name,
    attachmentPath,
    attachmentUploadedAt: new Date().toISOString(),
  };
}

export async function saveWeeklyReportMarkdownFile({
  projectId,
  storageLabel,
  fileName,
  content,
  audience,
}: {
  projectId: string;
  storageLabel?: string;
  fileName: string;
  content: string;
  audience?: WeeklyReportAudience;
}): Promise<WeeklyReportMarkdownSaveResult> {
  const record = await resolveWritableProjectDirectory(projectId, storageLabel);
  const weeklyFolderName = "周报";
  const audienceFolderName = weeklyReportAudienceFolder(audience);
  const safeFileName = normalizeMarkdownFileName(fileName);
  const pathLabel = record.pathLabel || storageLabel || record.handle?.name || "";

  if (record.mode === "desktop") {
    await writeNativeProjectFile(pathLabel, `${weeklyFolderName}/${audienceFolderName}/${safeFileName}`, textToBase64(content));
    const archivedAt = new Date().toISOString();
    return {
      fileName: safeFileName,
      filePath: `${pathLabel}/${weeklyFolderName}/${audienceFolderName}/${safeFileName}`,
      archivedAt,
    };
  }

  if (!record.handle) {
    throw new Error("请先选择交付物文件保存路径。");
  }

  try {
    const allowed = await ensureDirectoryWritePermission(record.handle);
    if (!allowed) {
      throw new Error("目录句柄权限已失效，请重新选择交付物保存路径。");
    }
    const weeklyDirectory = await record.handle.getDirectoryHandle(weeklyFolderName, { create: true });
    const audienceDirectory = await weeklyDirectory.getDirectoryHandle(audienceFolderName, { create: true });
    const fileHandle = await audienceDirectory.getFileHandle(safeFileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(new Blob([content], { type: "text/markdown;charset=utf-8" }));
    await writable.close();
  } catch (error) {
    throw normalizeFileSystemError(error, "周报 Markdown 归档失败，请重新选择保存路径后重试。");
  }

  const archivedAt = new Date().toISOString();
  return {
    fileName: safeFileName,
    filePath: `${pathLabel}/${weeklyFolderName}/${audienceFolderName}/${safeFileName}`,
    archivedAt,
  };
}

export async function deleteWeeklyReportMarkdownFile({
  projectId,
  fileName,
  filePath,
  storageLabel,
  audience,
}: {
  projectId: string;
  fileName?: string;
  filePath?: string;
  storageLabel?: string;
  audience?: WeeklyReportAudience;
}) {
  const record = await resolveWritableProjectDirectory(projectId, storageLabel);
  const weeklyFolderName = "周报";
  const pathSegments = normalizePath(filePath || "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const inferredFileName = fileName || pathSegments.at(-1) || "";
  const safeFileName = normalizeMarkdownFileName(inferredFileName);
  const inferredAudience = pathSegments.includes("客户") ? "customer" : pathSegments.includes("内部") ? "internal" : audience;
  const audienceFolderName = weeklyReportAudienceFolder(inferredAudience);
  const pathLabel = record.pathLabel || storageLabel || record.handle?.name || "";

  if (record.mode === "desktop") {
    await deleteNativeProjectFile(pathLabel, `${weeklyFolderName}/${audienceFolderName}/${safeFileName}`);
    return;
  }

  if (!record.handle) {
    throw new Error("请先选择交付物文件保存路径。");
  }

  try {
    const allowed = await ensureDirectoryWritePermission(record.handle);
    if (!allowed) {
      throw new Error("目录授权权限已失效，请重新选择交付物保存路径。");
    }
    const weeklyDirectory = await record.handle.getDirectoryHandle(weeklyFolderName);
    const candidateFolders = [audienceFolderName, audienceFolderName === "客户" ? "内部" : "客户"];
    for (const folderName of candidateFolders) {
      try {
        const audienceDirectory = await weeklyDirectory.getDirectoryHandle(folderName);
        await removeRequiredDirectoryEntry(audienceDirectory, safeFileName);
        return;
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
      }
    }
    await removeRequiredDirectoryEntry(weeklyDirectory, safeFileName);
  } catch (error) {
    throw normalizeFileSystemError(error, "周报 Markdown 删除失败，请重新选择保存路径后重试。");
  }
}

export async function saveProjectCsvFile({
  projectId,
  storageLabel,
  fileName,
  content,
}: {
  projectId: string;
  storageLabel?: string;
  fileName: string;
  content: string;
}): Promise<ProjectCsvSaveResult> {
  const record = await resolveWritableProjectDirectory(projectId, storageLabel);
  const safeFileName = normalizeCsvFileName(fileName);
  const pathLabel = record.pathLabel || storageLabel || record.handle?.name || "";

  if (record.mode === "desktop") {
    await writeNativeProjectFile(pathLabel, safeFileName, textToBase64(`\uFEFF${content}`));
    const savedAt = new Date().toISOString();
    return {
      fileName: safeFileName,
      filePath: `${pathLabel}/${safeFileName}`,
      savedAt,
    };
  }

  if (!record.handle) {
    throw new Error("请先选择交付物文件保存路径。");
  }

  try {
    const allowed = await ensureDirectoryWritePermission(record.handle);
    if (!allowed) {
      throw new Error("目录句柄权限已失效，请重新选择交付物保存路径。");
    }
    const fileHandle = await record.handle.getFileHandle(safeFileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(new Blob([`\uFEFF${content}`], { type: "text/csv;charset=utf-8" }));
    await writable.close();
  } catch (error) {
    throw normalizeFileSystemError(error, "CSV 保存失败，请重新选择保存路径后重试。");
  }

  const savedAt = new Date().toISOString();
  return {
    fileName: safeFileName,
    filePath: `${pathLabel}/${safeFileName}`,
    savedAt,
  };
}

export async function moveDeliverableAttachmentToStage({
  projectId,
  storageLabel,
  targetStageLabel,
  attachmentPath,
  attachmentName,
}: {
  projectId: string;
  storageLabel: string;
  targetStageLabel: string;
  attachmentPath?: string;
  attachmentName?: string;
}): Promise<Pick<AttachmentSaveResult, "attachmentName" | "attachmentPath">> {
  const ref = parseAttachmentRef(attachmentPath, attachmentName);
  if (!ref) {
    throw new Error("交付物没有可移动的附件。");
  }
  const record = await resolveWritableProjectDirectory(projectId, storageLabel);
  const targetFolderName = sanitizePathSegment(targetStageLabel);
  const pathLabel = record.pathLabel || storageLabel || record.handle?.name || "";
  const nextPath = `${pathLabel}/${targetFolderName}/${ref.fileName}`;
  if (ref.folderName === targetFolderName && normalizePath(attachmentPath || "") === normalizePath(nextPath)) {
    return { attachmentName: ref.fileName, attachmentPath: nextPath };
  }

  if (record.mode === "desktop") {
    await moveNativeProjectFile(pathLabel, `${ref.folderName}/${ref.fileName}`, `${targetFolderName}/${ref.fileName}`);
    return { attachmentName: ref.fileName, attachmentPath: nextPath };
  }

  if (!record.handle) {
    throw new Error("请先选择交付物文件保存路径。");
  }

  let sourceDirectory: LocalDirectoryHandle;
  try {
    sourceDirectory = ref.folderName ? await record.handle.getDirectoryHandle(ref.folderName) : record.handle;
    const sourceFile = await sourceDirectory.getFileHandle(ref.fileName);
    const file = await sourceFile.getFile();
    const targetDirectory = await record.handle.getDirectoryHandle(targetFolderName, { create: true });
    const targetFile = await targetDirectory.getFileHandle(ref.fileName, { create: true });
    const writable = await targetFile.createWritable();
    await writable.write(file);
    await writable.close();
  } catch (error) {
    throw normalizeFileSystemError(error, "附件移动失败，请重新选择保存路径后重试。");
  }
  if (ref.folderName !== targetFolderName) {
    try {
      await sourceDirectory.removeEntry?.(ref.fileName);
    } catch {
      // Old file cleanup is best-effort after the file has been copied.
    }
  }
  return { attachmentName: ref.fileName, attachmentPath: nextPath };
}
