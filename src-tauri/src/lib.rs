use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use imap::{types::Flag, ClientBuilder, ConnectionMode};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use tauri::Emitter;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmailConfig {
    sender_name: Option<String>,
    email: String,
    username: String,
    password: String,
    imap_host: String,
    imap_port: Option<u16>,
    imap_secure: Option<bool>,
    drafts_mailbox: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmailDraftPayload {
    to: String,
    cc: String,
    subject: String,
    content: String,
    html_content: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
struct EmailDraftResponse {
    ok: bool,
    message: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelHttpHeader {
    name: String,
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelHttpRequest {
    endpoint: String,
    headers: Vec<ModelHttpHeader>,
    body: String,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelHttpResponse {
    ok: bool,
    status: u16,
    body: String,
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelHttpStreamEvent {
    request_id: String,
    kind: String,
    status: Option<u16>,
    chunk_base64: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct BackupSaveResponse {
    ok: bool,
    path: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFileResponse {
    ok: bool,
    path: Option<String>,
    cancelled: bool,
    error: Option<String>,
}

impl NativeFileResponse {
    fn ok(path: PathBuf) -> Self {
        Self {
            ok: true,
            path: Some(path.to_string_lossy().into_owned()),
            cancelled: false,
            error: None,
        }
    }

    fn cancelled() -> Self {
        Self {
            ok: false,
            path: None,
            cancelled: true,
            error: None,
        }
    }

    fn error(message: String) -> Self {
        Self {
            ok: false,
            path: None,
            cancelled: false,
            error: Some(message),
        }
    }
}

fn parse_email_list(value: &str) -> Vec<String> {
    value
        .split(|ch: char| ch == ';' || ch == ',' || ch == '，' || ch == '；' || ch.is_whitespace())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn clean_header_value(value: &str) -> String {
    value.replace(['\r', '\n'], " ").trim().to_string()
}

fn encode_header(value: &str) -> String {
    let clean = clean_header_value(value);
    if clean.is_ascii() {
        clean
    } else {
        format!("=?UTF-8?B?{}?=", general_purpose::STANDARD.encode(clean.as_bytes()))
    }
}

fn wrap_base64(value: &str) -> String {
    let encoded = general_purpose::STANDARD.encode(value.as_bytes());
    encoded
        .as_bytes()
        .chunks(76)
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect::<Vec<_>>()
        .join("\r\n")
}

fn domain_from_email(email: &str) -> &str {
    email.split('@').nth(1).filter(|domain| !domain.is_empty()).unwrap_or("local")
}

fn build_raw_mail(config: &EmailConfig, payload: &EmailDraftPayload) -> Result<String, String> {
    let from_email = clean_header_value(&config.email);
    let sender_name = config.sender_name.as_deref().unwrap_or("").trim();
    let from = if sender_name.is_empty() {
        from_email.clone()
    } else {
        format!("{} <{}>", encode_header(sender_name), from_email)
    };
    let to = parse_email_list(&payload.to).join(", ");
    let cc = parse_email_list(&payload.cc).join(", ");
    if to.is_empty() {
        return Err("请填写至少一个收件人。".to_string());
    }

    let now = Utc::now();
    let html_content = payload
        .html_content
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let mut headers = vec![
        format!("From: {}", from),
        format!("To: {}", to),
        format!("Subject: {}", encode_header(&payload.subject)),
        format!("Date: {}", now.to_rfc2822()),
        format!(
            "Message-ID: <{}.{}@{}>",
            now.timestamp_millis(),
            std::process::id(),
            domain_from_email(&from_email)
        ),
        "MIME-Version: 1.0".to_string(),
    ];
    if !cc.is_empty() {
        headers.insert(2, format!("Cc: {}", cc));
    }

    if let Some(html) = html_content {
        let boundary = format!("implementation-pm-{}-{}", now.timestamp_millis(), std::process::id());
        headers.push(format!(
            "Content-Type: multipart/alternative; boundary=\"{}\"",
            boundary
        ));
        Ok(format!(
            "{}\r\n\r\n--{}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n--{}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n--{}--",
            headers.join("\r\n"),
            boundary,
            wrap_base64(&payload.content),
            boundary,
            wrap_base64(html),
            boundary
        ))
    } else {
        headers.push("Content-Type: text/plain; charset=UTF-8".to_string());
        headers.push("Content-Transfer-Encoding: base64".to_string());
        Ok(format!("{}\r\n\r\n{}", headers.join("\r\n"), wrap_base64(&payload.content)))
    }
}

fn validate_email_request(config: &EmailConfig, payload: &EmailDraftPayload) -> Result<(), String> {
    if config.email.trim().is_empty() {
        return Err("请先在设置中填写发件邮箱。".to_string());
    }
    if config.username.trim().is_empty() {
        return Err("请先在设置中填写邮箱登录账号。".to_string());
    }
    if config.password.trim().is_empty() {
        return Err("请先在设置中填写客户端专用密码或授权码。".to_string());
    }
    if config.imap_host.trim().is_empty() {
        return Err("请先配置 IMAP 服务器。".to_string());
    }
    if config.drafts_mailbox.as_deref().unwrap_or("").trim().is_empty() {
        return Err("请先配置草稿箱目录。".to_string());
    }
    if parse_email_list(&payload.to).is_empty() {
        return Err("请填写至少一个收件人。".to_string());
    }
    if payload.subject.trim().is_empty() {
        return Err("请填写邮件主题。".to_string());
    }
    if payload.content.trim().is_empty() {
        return Err("周报正文为空，无法保存草稿。".to_string());
    }
    Ok(())
}

fn backup_download_dir() -> Result<PathBuf, String> {
    if let Some(profile) = env::var_os("USERPROFILE") {
        return Ok(PathBuf::from(profile).join("Downloads"));
    }
    if let Some(home) = env::var_os("HOME") {
        return Ok(PathBuf::from(home).join("Downloads"));
    }
    env::current_dir().map_err(|error| format!("无法定位保存目录：{}", error))
}

fn safe_backup_file_name(file_name: &str) -> String {
    let cleaned = file_name
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                ch
            }
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    let name = if cleaned.is_empty() {
        "implementation-pm-backup.json".to_string()
    } else {
        cleaned
    };
    if name.to_ascii_lowercase().ends_with(".json") {
        name
    } else {
        format!("{}.json", name)
    }
}

#[tauri::command]
fn save_backup_file(file_name: String, content: String) -> BackupSaveResponse {
    let result = (|| -> Result<String, String> {
        let dir = backup_download_dir()?;
        fs::create_dir_all(&dir).map_err(|error| format!("创建下载目录失败：{}", error))?;
        let path = dir.join(safe_backup_file_name(&file_name));
        fs::write(&path, content).map_err(|error| format!("写入备份文件失败：{}", error))?;
        Ok(path.to_string_lossy().into_owned())
    })();

    match result {
        Ok(path) => BackupSaveResponse {
            ok: true,
            path: Some(path),
            error: None,
        },
        Err(error) => BackupSaveResponse {
            ok: false,
            path: None,
            error: Some(error),
        },
    }
}

fn safe_path_segment(value: &str, fallback: &str) -> String {
    let cleaned = value
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

fn ensure_project_root(project_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(project_path.trim());
    if path.as_os_str().is_empty() {
        return Err("请先选择交付物文件保存路径。".to_string());
    }
    fs::create_dir_all(&path).map_err(|error| format!("创建项目目录失败：{}", error))?;
    path.canonicalize()
        .map_err(|error| format!("无法访问项目目录：{}", error))
}

fn resolve_project_file(project_path: &str, relative_path: &str) -> Result<PathBuf, String> {
    let root = ensure_project_root(project_path)?;
    let relative = Path::new(relative_path);
    if relative.is_absolute() {
        return Err("文件路径必须位于项目目录内。".to_string());
    }

    let mut target = root.clone();
    for component in relative.components() {
        match component {
            Component::Normal(part) => target.push(part),
            Component::CurDir => {}
            _ => return Err("文件路径必须位于项目目录内。".to_string()),
        }
    }

    Ok(target)
}

fn write_project_file_inner(project_path: String, relative_path: String, content_base64: String) -> Result<PathBuf, String> {
    let target = resolve_project_file(&project_path, &relative_path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建文件目录失败：{}", error))?;
    }
    let bytes = general_purpose::STANDARD
        .decode(content_base64.as_bytes())
        .map_err(|error| format!("文件内容编码无效：{}", error))?;
    fs::write(&target, bytes).map_err(|error| format!("写入文件失败：{}", error))?;
    Ok(target)
}

fn delete_project_file_inner(project_path: String, relative_path: String) -> Result<PathBuf, String> {
    let target = resolve_project_file(&project_path, &relative_path)?;
    if target.exists() {
        fs::remove_file(&target).map_err(|error| format!("删除文件失败：{}", error))?;
    }
    Ok(target)
}

fn move_project_file_inner(project_path: String, source_relative_path: String, target_relative_path: String) -> Result<PathBuf, String> {
    let source = resolve_project_file(&project_path, &source_relative_path)?;
    let target = resolve_project_file(&project_path, &target_relative_path)?;
    if source == target {
        return Ok(target);
    }
    if !source.exists() {
        return Err("未找到原附件文件，请重新上传附件。".to_string());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建附件目录失败：{}", error))?;
    }
    fs::copy(&source, &target).map_err(|error| format!("复制附件失败：{}", error))?;
    let _ = fs::remove_file(&source);
    Ok(target)
}

#[cfg(target_os = "windows")]
fn pick_native_folder() -> Result<Option<PathBuf>, String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS, FOS_PATHMUSTEXIST,
        SIGDN_FILESYSPATH,
    };

    const HRESULT_CANCELLED: i32 = 0x800704C7_u32 as i32;

    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|error| format!("初始化系统文件选择器失败：{}", error))?;
        struct ComGuard;
        impl Drop for ComGuard {
            fn drop(&mut self) {
                unsafe {
                    CoUninitialize();
                }
            }
        }
        let _guard = ComGuard;

        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| format!("打开系统文件选择器失败：{}", error))?;
        let options = dialog
            .GetOptions()
            .map_err(|error| format!("读取文件选择器配置失败：{}", error))?;
        dialog
            .SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST)
            .map_err(|error| format!("设置文件选择器配置失败：{}", error))?;
        dialog
            .SetTitle(&HSTRING::from("选择项目交付物保存目录"))
            .map_err(|error| format!("设置文件选择器标题失败：{}", error))?;
        dialog
            .SetOkButtonLabel(&HSTRING::from("选择此文件夹"))
            .map_err(|error| format!("设置文件选择器按钮失败：{}", error))?;

        if let Err(error) = dialog.Show(None) {
            if error.code().0 == HRESULT_CANCELLED {
                return Ok(None);
            }
            return Err(format!("选择目录失败：{}", error));
        }

        let item = dialog.GetResult().map_err(|error| format!("读取选择目录失败：{}", error))?;
        let raw_path = item
            .GetDisplayName(SIGDN_FILESYSPATH)
            .map_err(|error| format!("读取目录路径失败：{}", error))?;
        let path = raw_path
            .to_string()
            .map_err(|error| format!("目录路径编码无效：{}", error))?;
        CoTaskMemFree(Some(raw_path.as_ptr() as _));
        Ok(Some(PathBuf::from(path)))
    }
}

#[cfg(not(target_os = "windows"))]
fn pick_native_folder() -> Result<Option<PathBuf>, String> {
    Err("当前桌面平台暂不支持原生目录选择器，请使用浏览器版本选择保存路径。".to_string())
}

#[tauri::command]
async fn select_deliverable_project_directory(project_name: String) -> NativeFileResponse {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let Some(base_path) = pick_native_folder()? else {
            return Ok(None);
        };
        let project_dir = base_path.join(safe_path_segment(&project_name, "项目交付物"));
        fs::create_dir_all(&project_dir).map_err(|error| format!("创建项目目录失败：{}", error))?;
        project_dir
            .canonicalize()
            .map(Some)
            .map_err(|error| format!("无法访问项目目录：{}", error))
    })
    .await;

    match result {
        Ok(Ok(Some(path))) => NativeFileResponse::ok(path),
        Ok(Ok(None)) => NativeFileResponse::cancelled(),
        Ok(Err(error)) => NativeFileResponse::error(error),
        Err(error) => NativeFileResponse::error(format!("选择目录任务执行失败：{}", error)),
    }
}

#[tauri::command]
async fn write_project_file(project_path: String, relative_path: String, content_base64: String) -> NativeFileResponse {
    match tauri::async_runtime::spawn_blocking(move || write_project_file_inner(project_path, relative_path, content_base64)).await {
        Ok(Ok(path)) => NativeFileResponse::ok(path),
        Ok(Err(error)) => NativeFileResponse::error(error),
        Err(error) => NativeFileResponse::error(format!("写入文件任务执行失败：{}", error)),
    }
}

#[tauri::command]
async fn delete_project_file(project_path: String, relative_path: String) -> NativeFileResponse {
    match tauri::async_runtime::spawn_blocking(move || delete_project_file_inner(project_path, relative_path)).await {
        Ok(Ok(path)) => NativeFileResponse::ok(path),
        Ok(Err(error)) => NativeFileResponse::error(error),
        Err(error) => NativeFileResponse::error(format!("删除文件任务执行失败：{}", error)),
    }
}

#[tauri::command]
async fn move_project_file(project_path: String, source_relative_path: String, target_relative_path: String) -> NativeFileResponse {
    match tauri::async_runtime::spawn_blocking(move || move_project_file_inner(project_path, source_relative_path, target_relative_path)).await {
        Ok(Ok(path)) => NativeFileResponse::ok(path),
        Ok(Err(error)) => NativeFileResponse::error(error),
        Err(error) => NativeFileResponse::error(format!("移动附件任务执行失败：{}", error)),
    }
}

fn save_email_draft_inner(config: EmailConfig, payload: EmailDraftPayload) -> Result<String, String> {
    validate_email_request(&config, &payload)?;
    let raw_mail = build_raw_mail(&config, &payload)?;
    let host = config.imap_host.trim();
    let port = config.imap_port.unwrap_or(993);
    let mailbox = config.drafts_mailbox.as_deref().unwrap_or("Drafts").trim();
    let secure = config.imap_secure.unwrap_or(true);

    let builder = if secure {
        ClientBuilder::new(host, port)
    } else {
        ClientBuilder::new(host, port).mode(ConnectionMode::Plaintext)
    };
    let client = builder.connect().map_err(|error| format!("连接 IMAP 服务器失败：{}", error))?;
    let mut session = client
        .login(config.username.trim(), config.password.trim())
        .map_err(|(error, _client)| format!("IMAP 登录失败：{}", error))?;

    let append_result = session.append(mailbox, raw_mail.as_bytes()).flag(Flag::Draft).finish();
    let logout_result = session.logout();
    append_result.map_err(|error| format!("写入草稿箱失败：{}", error))?;
    logout_result.map_err(|error| format!("草稿已写入，但退出 IMAP 会话失败：{}", error))?;

    Ok(format!("邮件草稿已保存到邮箱草稿箱：{}", mailbox))
}

#[tauri::command]
fn save_email_draft(config: EmailConfig, payload: EmailDraftPayload) -> EmailDraftResponse {
    match save_email_draft_inner(config, payload) {
        Ok(message) => EmailDraftResponse {
            ok: true,
            message: Some(message),
            error: None,
        },
        Err(error) => EmailDraftResponse {
            ok: false,
            message: None,
            error: Some(error),
        },
    }
}

fn model_http_request_inner(request: ModelHttpRequest) -> Result<ModelHttpResponse, String> {
    let endpoint = request.endpoint.trim();
    if !(endpoint.starts_with("https://") || endpoint.starts_with("http://")) {
        return Err("模型请求地址必须以 http:// 或 https:// 开头。".to_string());
    }

    let timeout_ms = request.timeout_ms.unwrap_or(60_000).clamp(10_000, 360_000);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .user_agent("implementation-pm-desktop/0.1")
        .build()
        .map_err(|error| format!("初始化模型网络客户端失败：{}", error))?;

    let mut builder = client.post(endpoint);
    for header in request.headers {
        let name = header.name.trim();
        if name.is_empty() {
            continue;
        }
        builder = builder.header(name, header.value);
    }

    let response = builder
        .body(request.body)
        .send()
        .map_err(|error| format!("模型网络连接失败：{}", error))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .map_err(|error| format!("读取模型响应失败：{}", error))?;

    Ok(ModelHttpResponse {
        ok: true,
        status,
        body,
        error: None,
    })
}

#[tauri::command]
async fn model_http_request(request: ModelHttpRequest) -> ModelHttpResponse {
    match tauri::async_runtime::spawn_blocking(move || model_http_request_inner(request)).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => ModelHttpResponse {
            ok: false,
            status: 0,
            body: String::new(),
            error: Some(error),
        },
        Err(error) => ModelHttpResponse {
            ok: false,
            status: 0,
            body: String::new(),
            error: Some(format!("模型请求任务执行失败：{}", error)),
        },
    }
}

fn emit_model_stream_event(
    window: &tauri::Window,
    request_id: &str,
    kind: &str,
    status: Option<u16>,
    chunk_base64: Option<String>,
    error: Option<String>,
) {
    let _ = window.emit(
        "model-http-stream",
        ModelHttpStreamEvent {
            request_id: request_id.to_string(),
            kind: kind.to_string(),
            status,
            chunk_base64,
            error,
        },
    );
}

fn model_http_stream_request_inner(
    window: tauri::Window,
    request: ModelHttpRequest,
    request_id: String,
) -> Result<ModelHttpResponse, String> {
    let endpoint = request.endpoint.trim();
    if !(endpoint.starts_with("https://") || endpoint.starts_with("http://")) {
        return Err("模型请求地址必须以 http:// 或 https:// 开头。".to_string());
    }

    let timeout_ms = request.timeout_ms.unwrap_or(60_000).clamp(10_000, 360_000);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .user_agent("implementation-pm-desktop/0.1")
        .build()
        .map_err(|error| format!("初始化模型网络客户端失败：{}", error))?;

    let mut builder = client.post(endpoint);
    for header in request.headers {
        let name = header.name.trim();
        if name.is_empty() {
            continue;
        }
        builder = builder.header(name, header.value);
    }

    let mut response = builder
        .body(request.body)
        .send()
        .map_err(|error| format!("模型网络连接失败：{}", error))?;
    let status = response.status().as_u16();
    emit_model_stream_event(&window, &request_id, "status", Some(status), None, None);

    let mut all_bytes: Vec<u8> = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("读取模型响应失败：{}", error))?;
        if read == 0 {
            break;
        }
        all_bytes.extend_from_slice(&buffer[..read]);
        emit_model_stream_event(
            &window,
            &request_id,
            "chunk",
            Some(status),
            Some(general_purpose::STANDARD.encode(&buffer[..read])),
            None,
        );
    }

    emit_model_stream_event(&window, &request_id, "done", Some(status), None, None);
    let body = String::from_utf8_lossy(&all_bytes).into_owned();
    Ok(ModelHttpResponse {
        ok: true,
        status,
        body,
        error: None,
    })
}

#[tauri::command]
async fn model_http_stream_request(
    window: tauri::Window,
    request: ModelHttpRequest,
    request_id: String,
) -> ModelHttpResponse {
    let event_request_id = request_id.clone();
    let event_window = window.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        model_http_stream_request_inner(window, request, request_id)
    })
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            emit_model_stream_event(
                &event_window,
                &event_request_id,
                "error",
                None,
                None,
                Some(error.clone()),
            );
            ModelHttpResponse {
                ok: false,
                status: 0,
                body: String::new(),
                error: Some(error),
            }
        }
        Err(error) => {
            let message = format!("模型请求任务执行失败：{}", error);
            emit_model_stream_event(
                &event_window,
                &event_request_id,
                "error",
                None,
                None,
                Some(message.clone()),
            );
            ModelHttpResponse {
                ok: false,
                status: 0,
                body: String::new(),
                error: Some(message),
            }
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            save_backup_file,
            select_deliverable_project_directory,
            write_project_file,
            delete_project_file,
            move_project_file,
            save_email_draft,
            model_http_request,
            model_http_stream_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
