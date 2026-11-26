use base64::Engine as _;
use flate2::{write::DeflateEncoder, Compression};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize)]
pub struct FileEntry {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

fn collect_entries(root: &Path, dir: &Path, out: &mut Vec<FileEntry>) -> Result<(), String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        if out.len() >= 5000 {
            break;
        }
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let Ok(stripped) = p.strip_prefix(root) else {
            continue;
        };
        let rel = stripped.to_string_lossy().replace('\\', "/");
        if meta.is_dir() {
            out.push(FileEntry {
                path: rel,
                is_dir: true,
                size: 0,
            });
            let _ = collect_entries(root, &p, out);
        } else {
            out.push(FileEntry {
                path: rel,
                is_dir: false,
                size: meta.len(),
            });
        }
    }
    Ok(())
}

fn safe_join(root: &str, rel: &str) -> Result<PathBuf, String> {
    let base = Path::new(root).canonicalize().map_err(|e| e.to_string())?;
    let candidate = base.join(rel);
    if !candidate.starts_with(&base) {
        return Err("Path traversal denied".into());
    }
    Ok(candidate)
}

#[tauri::command]
fn scan_project(root: String) -> Result<Vec<FileEntry>, String> {
    let root_path = Path::new(&root);
    let mut out = Vec::new();
    collect_entries(root_path, root_path, &mut out)?;
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

#[tauri::command]
fn read_project_file(root: String, rel: String) -> Result<String, String> {
    let full = safe_join(&root, &rel)?;
    fs::read_to_string(full).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_project_file_base64(root: String, rel: String) -> Result<String, String> {
    let full = safe_join(&root, &rel)?;
    let bytes = fs::read(full).map_err(|e| e.to_string())?;
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(((bytes.len() + 2) / 3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };
        out.push(TABLE[(b0 >> 2) & 0x3F] as char);
        out.push(TABLE[((b0 & 0x03) << 4) | ((b1 >> 4) & 0x0F)] as char);
        out.push(if chunk.len() > 1 { TABLE[((b1 & 0x0F) << 2) | ((b2 >> 6) & 0x03)] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[b2 & 0x3F] as char } else { '=' });
    }
    Ok(out)
}

#[tauri::command]
fn write_project_file(root: String, rel: String, content: String) -> Result<(), String> {
    let base = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    let full = base.join(&rel);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(full, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_project_file_base64(root: String, rel: String, content: String) -> Result<(), String> {
    let full = safe_join(&root, &rel)?;
    let clean = content.split(',').last().unwrap_or(&content).trim();
    let bytes = base64::engine::general_purpose::STANDARD.decode(clean).map_err(|e| e.to_string())?;
    if let Some(parent) = full.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    fs::write(full, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_external_file(file_path: String) -> Result<String, String> {
    let bytes = fs::read(file_path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
fn copy_external_file(root: String, file_path: String, rel: String) -> Result<(), String> {
    let dest = safe_join(&root, &rel)?;
    if let Some(parent) = dest.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    fs::copy(file_path, dest).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn export_html_file(out_path: String, html: String) -> Result<(), String> {
    fs::write(out_path, html).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_project_dir(root: String, rel: String) -> Result<(), String> {
    let base = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    let full = base.join(&rel);
    if !full.starts_with(&base) {
        return Err("Path traversal denied".into());
    }
    fs::create_dir_all(full).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_project_entry(root: String, old_rel: String, new_rel: String) -> Result<(), String> {
    let src = safe_join(&root, &old_rel)?;
    let base = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    let dst = base.join(&new_rel);
    if !dst.starts_with(&base) {
        return Err("Path traversal denied".into());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(src, dst).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_project_entry(root: String, rel: String) -> Result<(), String> {
    let full = safe_join(&root, &rel)?;
    if full.is_dir() {
        fs::remove_dir_all(full).map_err(|e| e.to_string())
    } else {
        fs::remove_file(full).map_err(|e| e.to_string())
    }
}

#[derive(Serialize)]
pub struct GitChange {
    pub code: String,
    pub path: String,
}

#[derive(Serialize)]
pub struct GitStatusResult {
    pub is_repo: bool,
    pub branch: String,
    pub changes: Vec<GitChange>,
}

#[tauri::command]
fn git_status(root: String) -> Result<GitStatusResult, String> {
    let out = Command::new("git")
        .args(["status", "--porcelain", "-b"])
        .current_dir(&root)
        .output();
    let out = match out {
        Ok(o) => o,
        Err(_) => {
            return Ok(GitStatusResult {
                is_repo: false,
                branch: String::new(),
                changes: Vec::new(),
            })
        }
    };
    if !out.status.success() {
        return Ok(GitStatusResult {
            is_repo: false,
            branch: String::new(),
            changes: Vec::new(),
        });
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut branch = String::from("main");
    let mut changes = Vec::new();
    for (idx, line) in text.lines().enumerate() {
        if idx == 0 && line.starts_with("## ") {
            let b = line.trim_start_matches("## ").split("...").next().unwrap_or("main");
            branch = b.to_string();
            continue;
        }
        if line.len() >= 4 {
            let code = line[..2].trim().to_string();
            let path = line[3..].trim().to_string();
            changes.push(GitChange { code, path });
        }
    }
    Ok(GitStatusResult {
        is_repo: true,
        branch,
        changes,
    })
}

#[tauri::command]
fn git_init(root: String) -> Result<String, String> {
    let out = Command::new("git")
        .args(["init"])
        .current_dir(&root)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[tauri::command]
fn git_commit(root: String, message: String) -> Result<String, String> {
    let add = Command::new("git")
        .args(["add", "-A"])
        .current_dir(&root)
        .output()
        .map_err(|e| e.to_string())?;
    if !add.status.success() {
        return Err(String::from_utf8_lossy(&add.stderr).to_string());
    }
    let msg = if message.trim().is_empty() { "Update project" } else { message.trim() };
    let cm = Command::new("git")
        .args(["commit", "-m", msg])
        .current_dir(&root)
        .output()
        .map_err(|e| e.to_string())?;
    if !cm.status.success() {
        return Err(String::from_utf8_lossy(&cm.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&cm.stdout).to_string())
}

#[tauri::command]
fn git_show_head(root: String, rel: String) -> Result<String, String> {
    let spec = format!("HEAD:{}", rel.replace('\\', "/"));
    let out = Command::new("git")
        .args(["show", &spec])
        .current_dir(&root)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(String::new());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[tauri::command]
fn git_branches(root: String) -> Result<Vec<String>, String> {
    let out = Command::new("git")
        .args(["branch", "--format=%(refname:short)"])
        .current_dir(&root)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(Vec::new());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect())
}

#[tauri::command]
fn git_checkout(root: String, branch: String, create: bool) -> Result<String, String> {
    let args: Vec<&str> = if create {
        vec!["checkout", "-b", &branch]
    } else {
        vec!["checkout", &branch]
    };
    let out = Command::new("git")
        .args(&args)
        .current_dir(&root)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[tauri::command]
fn git_log(root: String, limit: usize) -> Result<Vec<String>, String> {
    let n = limit.clamp(1, 50).to_string();
    let out = Command::new("git")
        .args(["log", "-n", &n, "--pretty=format:%h · %s (%cr)"])
        .current_dir(&root)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(Vec::new());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|s| s.to_string())
        .collect())
}

#[tauri::command]
fn git_discard(root: String, rel: String) -> Result<String, String> {
    let clean = rel.replace('\\', "/");
    let out = Command::new("git")
        .args(["checkout", "--", &clean])
        .current_dir(&root)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok("OK".into())
}

#[derive(Serialize)]
pub struct TermOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[tauri::command]
fn run_terminal_command(cwd: Option<String>, command: String) -> Result<TermOutput, String> {
    let dir = cwd.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| ".".to_string());
    #[cfg(target_os = "windows")]
    let out = Command::new("cmd")
        .args(["/C", &command])
        .current_dir(&dir)
        .output()
        .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "windows"))]
    let out = Command::new("sh")
        .args(["-c", &command])
        .current_dir(&dir)
        .output()
        .map_err(|e| e.to_string())?;

    Ok(TermOutput {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    })
}

#[tauri::command]
fn get_parent_dir(file_path: String) -> Result<String, String> {
    let p = Path::new(&file_path);
    p.parent()
        .map(|d| d.to_string_lossy().to_string())
        .ok_or_else(|| "Cannot determine parent directory".into())
}

#[tauri::command]
fn write_text_absolute(out_path: String, content: String) -> Result<u64, String> {
    let p = Path::new(&out_path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = content.as_bytes();
    fs::write(p, bytes).map_err(|e| e.to_string())?;
    Ok(bytes.len() as u64)
}

#[tauri::command]
fn write_base64_absolute(out_path: String, b64: String) -> Result<u64, String> {
    let p = Path::new(&out_path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| e.to_string())?;
    fs::write(p, &bytes).map_err(|e| e.to_string())?;
    Ok(bytes.len() as u64)
}

#[derive(Deserialize)]
pub struct ZipEntryInput {
    pub path: String,
    #[serde(default)]
    pub is_base64: bool,
    pub data: String,
}

fn write_zip_bytes(entries: &[(String, Vec<u8>)]) -> Result<Vec<u8>, String> {
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();

    for (raw_name, raw_data) in entries {
        let name = raw_name.replace('\\', "/").trim_start_matches('/').to_string();
        let name_bytes = name.as_bytes();
        let crc = crc32fast::hash(raw_data);
        let uncomp_len = raw_data.len() as u32;

        let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
        enc.write_all(raw_data).map_err(|e| e.to_string())?;
        let comp_data = enc.finish().map_err(|e| e.to_string())?;
        let comp_len = comp_data.len() as u32;

        let local_offset = out.len() as u32;
        // Local file header
        out.extend_from_slice(&0x04034b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 flag
        out.extend_from_slice(&8u16.to_le_bytes()); // DEFLATE
        out.extend_from_slice(&0u16.to_le_bytes()); // mod time
        out.extend_from_slice(&0x5421u16.to_le_bytes()); // mod date
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&comp_len.to_le_bytes());
        out.extend_from_slice(&uncomp_len.to_le_bytes());
        out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra len
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(&comp_data);

        // Central directory header
        central.extend_from_slice(&0x02014b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 flag
        central.extend_from_slice(&8u16.to_le_bytes()); // DEFLATE
        central.extend_from_slice(&0u16.to_le_bytes()); // mod time
        central.extend_from_slice(&0x5421u16.to_le_bytes()); // mod date
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&comp_len.to_le_bytes());
        central.extend_from_slice(&uncomp_len.to_le_bytes());
        central.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra len
        central.extend_from_slice(&0u16.to_le_bytes()); // comment len
        central.extend_from_slice(&0u16.to_le_bytes()); // disk start
        central.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        central.extend_from_slice(&local_offset.to_le_bytes());
        central.extend_from_slice(name_bytes);
    }

    let cd_offset = out.len() as u32;
    let cd_size = central.len() as u32;
    let count = entries.len() as u16;
    out.extend_from_slice(&central);

    // End of central directory
    out.extend_from_slice(&0x06054b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // disk
    out.extend_from_slice(&0u16.to_le_bytes()); // cd disk
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // comment len
    Ok(out)
}

#[tauri::command]
fn export_zip_archive(out_path: String, entries: Vec<ZipEntryInput>) -> Result<u64, String> {
    let mut parsed: Vec<(String, Vec<u8>)> = Vec::with_capacity(entries.len());
    for e in entries {
        let bytes = if e.is_base64 {
            let clean = e.data.split(',').last().unwrap_or(&e.data).trim();
            base64::engine::general_purpose::STANDARD
                .decode(clean)
                .map_err(|err| format!("Base64 error in {}: {}", e.path, err))?
        } else {
            e.data.into_bytes()
        };
        parsed.push((e.path, bytes));
    }
    let zip_bytes = write_zip_bytes(&parsed)?;
    let p = Path::new(&out_path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(p, &zip_bytes).map_err(|e| e.to_string())?;
    Ok(zip_bytes.len() as u64)
}

#[derive(Serialize)]
pub struct BuildExeResult {
    pub exe_path: String,
    pub size_bytes: u64,
    pub copied_loader: bool,
}

#[tauri::command]
fn build_standalone_exe(
    app: AppHandle,
    out_dir: String,
    exe_name: String,
    config_json: String,
    html: String,
    icon_path: Option<String>,
    project_root: Option<String>,
) -> Result<BuildExeResult, String> {
    let exe_dir = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("Missing exe parent")?
        .to_path_buf();

    let mut stub_candidates = vec![
        exe_dir.join("resources").join("runners").join("roy-runner-win-x64.exe"),
        exe_dir.join("..").join("resources").join("runners").join("roy-runner-win-x64.exe"),
        exe_dir.join("roy-runner.exe"),
    ];
    if let Ok(res_dir) = app.path().resource_dir() {
        stub_candidates.push(res_dir.join("resources").join("runners").join("roy-runner-win-x64.exe"));
        stub_candidates.push(res_dir.join("runners").join("roy-runner-win-x64.exe"));
    }
    let stub_path = stub_candidates
        .iter()
        .find(|p| p.exists())
        .ok_or_else(|| "Runner stub resources/runners/roy-runner-win-x64.exe not found".to_string())?;

    let mut cfg_val: serde_json::Value =
        serde_json::from_str(&config_json).map_err(|e| format!("Invalid config JSON: {}", e))?;

    if let Some(ref ic) = icon_path {
        let trimmed = ic.trim();
        if !trimmed.is_empty() {
            let ic_path = Path::new(trimmed);
            let resolved = if ic_path.is_absolute() {
                ic_path.to_path_buf()
            } else if let Some(ref root) = project_root {
                let p1 = Path::new(root).join(ic_path);
                if p1.exists() { p1 } else { Path::new(&out_dir).join(ic_path) }
            } else {
                Path::new(&out_dir).join(ic_path)
            };
            if resolved.exists() {
                let icon_bytes = fs::read(&resolved).map_err(|e| e.to_string())?;
                let b64 = base64::engine::general_purpose::STANDARD.encode(icon_bytes);
                if let Some(obj) = cfg_val.as_object_mut() {
                    obj.insert("icon_base64".to_string(), serde_json::Value::String(b64));
                }
            }
        }
    }

    let final_cfg = serde_json::to_vec(&cfg_val).map_err(|e| e.to_string())?;
    let html_bytes = html.into_bytes();
    let stub_bytes = fs::read(stub_path).map_err(|e| e.to_string())?;

    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let clean_name = exe_name
        .trim()
        .trim_end_matches(".exe")
        .replace(['<', '>', ':', '"', '/', '\\', '|', '?', '*'], "_");
    let final_name = if clean_name.is_empty() { "RoyGame" } else { &clean_name };
    let out_exe = Path::new(&out_dir).join(format!("{}.exe", final_name));

    let mut buf = Vec::with_capacity(stub_bytes.len() + final_cfg.len() + html_bytes.len() + 16);
    buf.extend_from_slice(&stub_bytes);
    buf.extend_from_slice(&final_cfg);
    buf.extend_from_slice(&html_bytes);
    buf.extend_from_slice(&(final_cfg.len() as u32).to_le_bytes());
    buf.extend_from_slice(&(html_bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(b"ROYEXE65");

    fs::write(&out_exe, &buf).map_err(|e| e.to_string())?;

    let mut copied_loader = false;
    let mut loader_candidates = vec![exe_dir.join("WebView2Loader.dll")];
    if let Ok(res_dir) = app.path().resource_dir() {
        loader_candidates.push(res_dir.join("WebView2Loader.dll"));
    }
    let loader_dst = Path::new(&out_dir).join("WebView2Loader.dll");
    if let Some(loader_src) = loader_candidates.into_iter().find(|p| p.exists()) {
        if loader_src != loader_dst && fs::copy(&loader_src, &loader_dst).is_ok() {
            copied_loader = true;
        }
    }

    Ok(BuildExeResult {
        exe_path: out_exe.to_string_lossy().to_string(),
        size_bytes: buf.len() as u64,
        copied_loader,
    })
}

    #[tauri::command]
    fn open_in_explorer(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    let mut cmd = Command::new("explorer");
    if p.is_file() { cmd.arg("/select,").arg(p); } else { cmd.arg(p); }
    cmd
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// =====================================================================
// Level 2 Updater: RoyLang Engine Manager (GitHub Releases + Tags + Raw)
// Level 1 Updater: RoyStudio Desktop IDE (tauri-plugin-updater)
// =====================================================================

const ROYLANG_GITHUB_API: &str = "https://api.github.com/repos/RoyWals/RoyLang";
const ROYLANG_GITHUB_RAW: &str = "https://raw.githubusercontent.com/RoyWals/RoyLang";
const IDE_GITHUB_LATEST: &str = "https://api.github.com/repos/RoyWals/RoyStudioDesktop/releases/latest";

fn parse_semver_tag(tag: &str) -> (u64, u64, u64, String) {
    let clean = tag.trim().trim_start_matches(['v', 'V']);
    let mut nums = [0u64; 3];
    for (i, part) in clean.split('.').take(3).enumerate() {
        let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
        nums[i] = digits.parse::<u64>().unwrap_or(0);
    }
    (nums[0], nums[1], nums[2], clean.to_string())
}

fn is_version_tag(tag: &str) -> bool {
    let s = tag.trim();
    let rest = s.strip_prefix('v').or_else(|| s.strip_prefix('V')).unwrap_or("");
    rest.chars().next().is_some_and(|c| c.is_ascii_digit())
}

fn validate_engine_tag(tag: &str) -> Result<String, String> {
    let t = tag.trim();
    if t.is_empty()
        || t.len() > 64
        || t.contains("..")
        || !t
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err(format!("Некорректный тег версии: {}", tag));
    }
    Ok(t.to_string())
}

fn engines_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("engines"))
}

fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("RoyStudioDesktop/1.0")
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

#[derive(Deserialize)]
struct GhTag {
    name: String,
}

#[derive(Serialize, Clone)]
pub struct EngineReleaseInfo {
    pub tag: String,
    pub title: String,
    pub body: String,
    pub published_at: String,
    pub html_url: String,
    pub is_release: bool,
    pub prerelease: bool,
}

#[derive(Serialize, Clone)]
pub struct InstalledEngineItem {
    pub tag: String,
    pub has_docs: bool,
    pub has_gamepad: bool,
    pub size_bytes: u64,
}

#[derive(Serialize)]
pub struct InstalledEnginesState {
    pub active: Option<String>,
    pub engines: Vec<InstalledEngineItem>,
}

#[derive(Serialize)]
pub struct EngineBundlePayload {
    pub tag: String,
    pub roylang_js: String,
    pub roylang_docs_js: Option<String>,
    pub roy_gamepad_js: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct ActiveEngineFile {
    active: Option<String>,
}

#[derive(Serialize, Clone)]
struct EngineProgressEvent {
    tag: String,
    file: String,
    downloaded: u64,
    total: Option<u64>,
}

#[derive(Serialize, Clone)]
struct IdeProgressEvent {
    downloaded: u64,
    total: Option<u64>,
    finished: bool,
}

#[derive(Serialize)]
pub struct IdeUpdateInfo {
    pub current_version: String,
    pub available: bool,
    pub pubkey_configured: bool,
    pub latest_version: Option<String>,
    pub notes: String,
    pub message: String,
}

#[tauri::command]
fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn get_launch_file() -> Option<String> {
    std::env::args().skip(1).find_map(|arg| {
        let p = Path::new(&arg);
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if matches!(
            ext.as_str(),
            "roy" | "roylang" | "royson" | "royproj" | "royscene" | "royprefab" | "royanim" | "roymodel" | "roydata" | "lua" | "luau" | "cs" | "gd" | "py" | "md"
        ) && p.is_file() {
            let resolved = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
            let s = resolved.to_string_lossy().to_string();
            Some(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string())
        } else {
            None
        }
    })
}

#[tauri::command]
async fn fetch_roylang_releases() -> Result<Vec<EngineReleaseInfo>, String> {
    let client = build_http_client()?;
    let rel_url = format!("{}/releases?per_page=30", ROYLANG_GITHUB_API);
    let tag_url = format!("{}/tags?per_page=30", ROYLANG_GITHUB_API);

    let mut by_tag: HashMap<String, EngineReleaseInfo> = HashMap::new();

    if let Ok(resp) = client.get(&rel_url).send().await {
        if resp.status().is_success() {
            if let Ok(rels) = resp.json::<Vec<GhRelease>>().await {
                for r in rels {
                    if r.draft || !is_version_tag(&r.tag_name) {
                        continue;
                    }
                    let tag = r.tag_name.trim().to_string();
                    let title = r
                        .name
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or_else(|| format!("RoyLang {}", tag));
                    by_tag.insert(
                        tag.clone(),
                        EngineReleaseInfo {
                            tag,
                            title,
                            body: r.body.unwrap_or_default(),
                            published_at: r.published_at.unwrap_or_default(),
                            html_url: r.html_url.unwrap_or_default(),
                            is_release: true,
                            prerelease: r.prerelease,
                        },
                    );
                }
            }
        }
    }

    let tag_resp = client.get(&tag_url).send().await.map_err(|e| e.to_string())?;
    if !tag_resp.status().is_success() && by_tag.is_empty() {
        return Err(format!("GitHub API HTTP {}", tag_resp.status()));
    }
    if tag_resp.status().is_success() {
        if let Ok(tags) = tag_resp.json::<Vec<GhTag>>().await {
            for t in tags {
                if !is_version_tag(&t.name) {
                    continue;
                }
                let tag = t.name.trim().to_string();
                by_tag.entry(tag.clone()).or_insert_with(|| EngineReleaseInfo {
                    tag: tag.clone(),
                    title: format!("RoyLang {}", tag),
                    body: String::new(),
                    published_at: String::new(),
                    html_url: format!("https://github.com/RoyWals/RoyLang/releases/tag/{}", tag),
                    is_release: false,
                    prerelease: false,
                });
            }
        }
    }

    let mut list: Vec<EngineReleaseInfo> = by_tag.into_values().collect();
    list.sort_by(|a, b| parse_semver_tag(&b.tag).cmp(&parse_semver_tag(&a.tag)));
    Ok(list)
}

#[tauri::command]
fn list_installed_engines(app: AppHandle) -> Result<InstalledEnginesState, String> {
    let dir = engines_dir(&app)?;
    if !dir.exists() {
        return Ok(InstalledEnginesState {
            active: None,
            engines: Vec::new(),
        });
    }
    let active_path = dir.join("active.json");
    let mut active = fs::read_to_string(&active_path)
        .ok()
        .and_then(|s| serde_json::from_str::<ActiveEngineFile>(&s).ok())
        .and_then(|a| a.active);

    let mut engines = Vec::new();
    for ent in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let ent = ent.map_err(|e| e.to_string())?;
        let p = ent.path();
        if !p.is_dir() {
            continue;
        }
        let name = ent.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let core_file = p.join("roylang.js");
        if !core_file.exists() {
            continue;
        }
        let docs_file = p.join("roylang-docs.js");
        let pad_file = p.join("roy-gamepad.js");
        let size_bytes = fs::metadata(&core_file).map(|m| m.len()).unwrap_or(0)
            + fs::metadata(&docs_file).map(|m| m.len()).unwrap_or(0)
            + fs::metadata(&pad_file).map(|m| m.len()).unwrap_or(0);
        engines.push(InstalledEngineItem {
            tag: name,
            has_docs: docs_file.exists(),
            has_gamepad: pad_file.exists(),
            size_bytes,
        });
    }
    engines.sort_by(|a, b| parse_semver_tag(&b.tag).cmp(&parse_semver_tag(&a.tag)));
    if let Some(ref act) = active {
        if !engines.iter().any(|e| &e.tag == act) {
            active = None;
        }
    }
    Ok(InstalledEnginesState { active, engines })
}

async fn stream_download_utf8(
    app: &AppHandle,
    client: &reqwest::Client,
    tag: &str,
    file_name: &str,
) -> Result<Option<Vec<u8>>, String> {
    let url = format!("{}/{}/{}", ROYLANG_GITHUB_RAW, tag, file_name);
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(format!("Ошибка загрузки {} ({}): HTTP {}", file_name, tag, status));
    }
    let total = resp.content_length();
    let mut stream = resp.bytes_stream();
    let mut buf = Vec::with_capacity(total.unwrap_or(131072) as usize);
    let mut downloaded: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        downloaded += bytes.len() as u64;
        buf.extend_from_slice(&bytes);
        let _ = app.emit(
            "engine-download-progress",
            EngineProgressEvent {
                tag: tag.to_string(),
                file: file_name.to_string(),
                downloaded,
                total,
            },
        );
    }
    if buf.is_empty() {
        return Ok(None);
    }
    std::str::from_utf8(&buf)
        .map_err(|_| format!("Файл {} для {} не является корректным UTF-8", file_name, tag))?;
    Ok(Some(buf))
}

#[tauri::command]
async fn download_roylang_engine(
    app: AppHandle,
    tag: String,
) -> Result<InstalledEngineItem, String> {
    let clean_tag = validate_engine_tag(&tag)?;
    let root = engines_dir(&app)?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    let tmp_dir = root.join(format!(".tmp-{}", clean_tag));
    if tmp_dir.exists() {
        let _ = fs::remove_dir_all(&tmp_dir);
    }
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    let client = build_http_client()?;

    let core_bytes = match stream_download_utf8(&app, &client, &clean_tag, "roylang.js").await {
        Ok(Some(b)) => b,
        Ok(None) => {
            let _ = fs::remove_dir_all(&tmp_dir);
            return Err(format!("В релизе {} не найден roylang.js", clean_tag));
        }
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp_dir);
            return Err(e);
        }
    };
    fs::write(tmp_dir.join("roylang.js"), &core_bytes).map_err(|e| e.to_string())?;

    let mut total_bytes = core_bytes.len() as u64;
    let mut has_gamepad = false;
    if let Ok(Some(pad_bytes)) = stream_download_utf8(&app, &client, &clean_tag, "roy-gamepad.js").await {
        if fs::write(tmp_dir.join("roy-gamepad.js"), &pad_bytes).is_ok() {
            total_bytes += pad_bytes.len() as u64;
            has_gamepad = true;
        }
    }

    let mut has_docs = false;
    if let Ok(Some(docs_bytes)) = stream_download_utf8(&app, &client, &clean_tag, "roylang-docs.js").await {
        if fs::write(tmp_dir.join("roylang-docs.js"), &docs_bytes).is_ok() {
            total_bytes += docs_bytes.len() as u64;
            has_docs = true;
        }
    }

    let final_dir = root.join(&clean_tag);
    if final_dir.exists() {
        fs::remove_dir_all(&final_dir).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp_dir, &final_dir).map_err(|e| e.to_string())?;

    Ok(InstalledEngineItem {
        tag: clean_tag,
        has_docs,
        has_gamepad,
        size_bytes: total_bytes,
    })
}

#[tauri::command]
fn read_installed_engine(app: AppHandle, tag: String) -> Result<EngineBundlePayload, String> {
    let clean_tag = validate_engine_tag(&tag)?;
    let dir = engines_dir(&app)?.join(&clean_tag);
    let roylang_js = fs::read_to_string(dir.join("roylang.js"))
        .map_err(|e| format!("Не удалось прочитать движок {}: {}", clean_tag, e))?;
    let roylang_docs_js = fs::read_to_string(dir.join("roylang-docs.js")).ok();
    let roy_gamepad_js = fs::read_to_string(dir.join("roy-gamepad.js")).ok();
    Ok(EngineBundlePayload {
        tag: clean_tag,
        roylang_js,
        roylang_docs_js,
        roy_gamepad_js,
    })
}

#[tauri::command]
fn set_active_engine(app: AppHandle, tag: Option<String>) -> Result<(), String> {
    let clean = match tag {
        Some(t) => Some(validate_engine_tag(&t)?),
        None => None,
    };
    let root = engines_dir(&app)?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&ActiveEngineFile { active: clean })
        .map_err(|e| e.to_string())?;
    fs::write(root.join("active.json"), json).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_installed_engine(app: AppHandle, tag: String) -> Result<(), String> {
    let clean_tag = validate_engine_tag(&tag)?;
    let root = engines_dir(&app)?;
    let target = root.join(&clean_tag);
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
    }
    let active_path = root.join("active.json");
    if let Ok(s) = fs::read_to_string(&active_path) {
        if let Ok(mut parsed) = serde_json::from_str::<ActiveEngineFile>(&s) {
            if parsed.active.as_deref() == Some(clean_tag.as_str()) {
                parsed.active = None;
                if let Ok(json) = serde_json::to_string_pretty(&parsed) {
                    let _ = fs::write(&active_path, json);
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn check_ide_update(app: AppHandle) -> Result<IdeUpdateInfo, String> {
    let current_version = app.package_info().version.to_string();
    let updater = match app.updater() {
        Ok(u) => u,
        Err(_) => {
            let mut latest_version = None;
            let mut notes = String::new();
            if let Ok(client) = build_http_client() {
                if let Ok(resp) = client.get(IDE_GITHUB_LATEST).send().await {
                    if resp.status().is_success() {
                        if let Ok(rel) = resp.json::<GhRelease>().await {
                            latest_version = Some(rel.tag_name);
                            notes = rel.body.unwrap_or_default();
                        }
                    }
                }
            }
            return Ok(IdeUpdateInfo {
                current_version,
                available: false,
                pubkey_configured: false,
                latest_version,
                notes,
                message: "Ключ подписи (pubkey) ещё не настроен в tauri.conf.json. После генерации ключа и публикации релиза автообновление заработает в 1 клик.".into(),
            });
        }
    };

    match updater.check().await {
        Ok(Some(update)) => Ok(IdeUpdateInfo {
            current_version,
            available: true,
            pubkey_configured: true,
            latest_version: Some(update.version.clone()),
            notes: update.body.clone().unwrap_or_default(),
            message: String::new(),
        }),
        Ok(None) => Ok(IdeUpdateInfo {
            current_version: current_version.clone(),
            available: false,
            pubkey_configured: true,
            latest_version: Some(current_version),
            notes: String::new(),
            message: String::new(),
        }),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn install_ide_update(app: AppHandle) -> Result<(), String> {
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };

    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Новых версий RoyStudio Desktop не найдено.".to_string())?;

    let downloaded = Arc::new(AtomicU64::new(0));
    let dl_chunk = Arc::clone(&downloaded);
    let dl_done = Arc::clone(&downloaded);
    let app_prog = app.clone();
    let app_done = app.clone();

    let bytes = update
        .download(
            move |chunk_len, content_len| {
                let total_dl =
                    dl_chunk.fetch_add(chunk_len as u64, Ordering::Relaxed) + chunk_len as u64;
                let _ = app_prog.emit(
                    "ide-update-progress",
                    IdeProgressEvent {
                        downloaded: total_dl,
                        total: content_len,
                        finished: false,
                    },
                );
            },
            move || {
                let total_dl = dl_done.load(Ordering::Relaxed);
                let _ = app_done.emit(
                    "ide-update-progress",
                    IdeProgressEvent {
                        downloaded: total_dl,
                        total: Some(total_dl),
                        finished: true,
                    },
                );
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    // Даём интерфейсу 350 мс, чтобы полоска честно доехала до 100%
    std::thread::sleep(Duration::from_millis(350));

    update.install(bytes).map_err(|e| e.to_string())?;

    // На Windows NSIS сам заменяет файлы и запускает новую версию.
    // app.restart() здесь вызывать НЕЛЬЗЯ — иначе старый .exe заблокирует установку!
    #[cfg(target_os = "windows")]
    {
        app.exit(0);
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        app.restart();
    }
}

#[tauri::command]
fn relaunch_app(app: AppHandle) {
    app.restart();
}

#[tauri::command]
fn host_os_call(app: AppHandle, cmd: String, payload: serde_json::Value) -> Result<serde_json::Value, String> {
    let win = app.get_webview_window("main");
    match cmd.as_str() {
        "fs:readText" => {
            let path = payload.get("path").and_then(|v| v.as_str()).ok_or("Missing path")?;
            let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "ok": true, "text": text }))
        }
        "fs:writeText" => {
            let path = payload.get("path").and_then(|v| v.as_str()).ok_or("Missing path")?;
            let text = payload.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(parent) = Path::new(path).parent() {
                let _ = fs::create_dir_all(parent);
            }
            fs::write(path, text.as_bytes()).map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "ok": true, "bytes": text.len() }))
        }
        "fs:readDir" => {
            let path = payload.get("path").and_then(|v| v.as_str()).ok_or("Missing path")?;
            let entries = fs::read_dir(path).map_err(|e| e.to_string())?;
            let mut list = Vec::new();
            for e in entries.flatten() {
                let is_dir = e.metadata().map(|m| m.is_dir()).unwrap_or(false);
                list.push(serde_json::json!({
                    "name": e.file_name().to_string_lossy().to_string(),
                    "isDir": is_dir
                }));
            }
            Ok(serde_json::json!({ "ok": true, "entries": list }))
        }
        "fs:exists" => {
            let path = payload.get("path").and_then(|v| v.as_str()).unwrap_or("");
            Ok(serde_json::json!({ "ok": true, "exists": !path.is_empty() && Path::new(path).exists() }))
        }
        "window:setTitle" => {
            if let Some(w) = &win {
                let title = payload.get("title").and_then(|v| v.as_str()).unwrap_or("RoyLang App");
                let _ = w.set_title(title);
            }
            Ok(serde_json::json!({ "ok": true }))
        }
        "window:setSize" => {
            if let Some(w) = &win {
                let width = payload.get("width").and_then(|v| v.as_f64()).unwrap_or(1024.0);
                let height = payload.get("height").and_then(|v| v.as_f64()).unwrap_or(720.0);
                let _ = w.set_size(tauri::LogicalSize::new(width, height));
            }
            Ok(serde_json::json!({ "ok": true }))
        }
        "window:minimize" => {
            if let Some(w) = &win {
                let _ = w.minimize();
            }
            Ok(serde_json::json!({ "ok": true }))
        }
        "window:maximize" => {
            if let Some(w) = &win {
                if w.is_maximized().unwrap_or(false) {
                    let _ = w.unmaximize();
                } else {
                    let _ = w.maximize();
                }
            }
            Ok(serde_json::json!({ "ok": true }))
        }
        "window:setAlwaysOnTop" => {
            if let Some(w) = &win {
                let flag = payload.get("alwaysOnTop").and_then(|v| v.as_bool()).unwrap_or(true);
                let _ = w.set_always_on_top(flag);
            }
            Ok(serde_json::json!({ "ok": true }))
        }
        "os:notify" | "tray:setIcon" | "tray:setTooltip" | "tray:setMenu" => {
            Ok(serde_json::json!({ "ok": true, "handled": true }))
        }
        _ => Ok(serde_json::json!({ "ok": false, "error": format!("Unsupported host command: {}", cmd) })),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[derive(Serialize)]
pub struct AndroidBuildResult {
    pub ok: bool,
    pub apk_path: Option<String>,
    pub apk_dir: Option<String>,
    pub missing: Vec<String>,
    pub message: String,
}

fn find_android_sdk() -> Option<PathBuf> {
    for var in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Ok(val) = std::env::var(var) {
            let p = PathBuf::from(val.trim());
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    #[cfg(windows)]
    if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
        let p = PathBuf::from(local_app).join("Android").join("Sdk");
        if p.is_dir() {
            return Some(p);
        }
    }
    #[cfg(not(windows))]
    if let Ok(home) = std::env::var("HOME") {
        for sub in ["Android/Sdk", "Library/Android/sdk"] {
            let p = PathBuf::from(&home).join(sub);
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    None
}

fn check_java_17_plus() -> bool {
    let mut cmd = Command::new("java");
    cmd.arg("-version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let Ok(out) = cmd.output() else {
        return false;
    };
    if !out.status.success() {
        return false;
    }
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    for line in text.lines() {
        if let Some(q1) = line.find('"') {
            if let Some(q2) = line[q1 + 1..].find('"') {
                let ver = &line[q1 + 1..q1 + 1 + q2];
                let major_str = ver.split('.').next().unwrap_or("0");
                if let Ok(major) = major_str.parse::<u32>() {
                    return major >= 17;
                }
            }
        }
    }
    true
}

fn check_gradle_cmd(project_path: &Path) -> Option<String> {
    #[cfg(windows)]
    let wrapper = project_path.join("gradlew.bat");
    #[cfg(not(windows))]
    let wrapper = project_path.join("gradlew");
    if wrapper.is_file() {
        return Some(wrapper.to_string_lossy().to_string());
    }
    let mut cmd = Command::new(if cfg!(windows) { "gradle.bat" } else { "gradle" });
    cmd.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    if let Ok(out) = cmd.output() {
        if out.status.success() {
            return Some(if cfg!(windows) { "gradle.bat" } else { "gradle" }.to_string());
        }
    }
    let mut cmd2 = Command::new("gradle");
    cmd2.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd2.creation_flags(0x08000000);
    }
    if let Ok(out) = cmd2.output() {
        if out.status.success() {
            return Some("gradle".to_string());
        }
    }
    None
}

#[tauri::command]
async fn build_android_apk(app: AppHandle, project_dir: String) -> Result<AndroidBuildResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::{BufRead, BufReader};
        use std::process::Stdio;

        let proj = PathBuf::from(&project_dir);
        if !proj.is_dir() {
            return Ok(AndroidBuildResult {
                ok: false,
                apk_path: None,
                apk_dir: None,
                missing: vec![],
                message: format!("Папка проекта не найдена: {}", project_dir),
            });
        }

        let mut missing = Vec::new();
        if !check_java_17_plus() {
            missing.push("JDK 17+ (команда java не найдена или версия < 17)".to_string());
        }
        let sdk_opt = find_android_sdk();
        if sdk_opt.is_none() {
            missing.push("Android SDK (не задан ANDROID_HOME и не найден %LOCALAPPDATA%\\Android\\Sdk)".to_string());
        }
        let gradle_opt = check_gradle_cmd(&proj);
        if gradle_opt.is_none() {
            missing.push("Gradle (не найден gradle в PATH и отсутствует gradlew.bat)".to_string());
        }

        if !missing.is_empty() {
            return Ok(AndroidBuildResult {
                ok: false,
                apk_path: None,
                apk_dir: None,
                missing: missing.clone(),
                message: format!("Для локальной сборки .apk не хватает: {}", missing.join("; ")),
            });
        }

        let sdk_path = sdk_opt.unwrap();
        let sdk_str = sdk_path.to_string_lossy().to_string();
        let escaped_sdk = sdk_str.replace('\\', "\\\\").replace(':', "\\:");
        let local_props = proj.join("local.properties");
        let _ = fs::write(&local_props, format!("sdk.dir={}\n", escaped_sdk));

        let gradle_bin = gradle_opt.unwrap();
        let _ = app.emit("android-build-log", format!("> {} assembleDebug --no-daemon", gradle_bin));
        let _ = app.emit("android-build-log", format!("> ANDROID_HOME={}", sdk_str));

        let mut cmd = Command::new(&gradle_bin);
        cmd.arg("assembleDebug")
            .arg("--no-daemon")
            .current_dir(&proj)
            .env("ANDROID_HOME", &sdk_str)
            .env("ANDROID_SDK_ROOT", &sdk_str)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        let mut child = cmd.spawn().map_err(|e| format!("Не удалось запустить {}: {}", gradle_bin, e))?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let app1 = app.clone();
        let t1 = std::thread::spawn(move || {
            if let Some(out) = stdout {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    let _ = app1.emit("android-build-log", line);
                }
            }
        });
        let app2 = app.clone();
        let t2 = std::thread::spawn(move || {
            if let Some(err) = stderr {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    let _ = app2.emit("android-build-log", line);
                }
            }
        });

        let status = child.wait().map_err(|e| format!("Ошибка ожидания Gradle: {}", e))?;
        let _ = t1.join();
        let _ = t2.join();

        let apk_file = proj.join("app").join("build").join("outputs").join("apk").join("debug").join("app-debug.apk");
        if status.success() && apk_file.is_file() {
            let apk_dir = apk_file.parent().map(|p| p.to_string_lossy().to_string());
            return Ok(AndroidBuildResult {
                ok: true,
                apk_path: Some(apk_file.to_string_lossy().to_string()),
                apk_dir,
                missing: vec![],
                message: "Android APK успешно собран!".to_string(),
            });
        }

        Ok(AndroidBuildResult {
            ok: false,
            apk_path: None,
            apk_dir: None,
            missing: vec![],
            message: format!("Сборка Gradle завершилась с ошибкой (код {:?}). Проверьте лог выше.", status.code()),
        })
    })
    .await
    .map_err(|e| format!("Ошибка потока сборки Android: {}", e))?
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if let Some(path_str) = args.iter().skip(1).find_map(|arg| {
                let p = Path::new(arg);
                let ext = p
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if matches!(
            ext.as_str(),
            "roy" | "roylang" | "royson" | "royproj" | "royscene" | "royprefab" | "royanim" | "roymodel" | "roydata" | "lua" | "luau" | "cs" | "gd" | "py" | "md"
        ) && p.is_file() {
                    let resolved = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
                    let s = resolved.to_string_lossy().to_string();
                    Some(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string())
                } else {
                    None
                }
            }) {
                let _ = app.emit("open-launch-file", path_str);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            Ok(())
        })
            .invoke_handler(tauri::generate_handler![
            scan_project,
            read_project_file,
            read_project_file_base64,
                write_project_file,
                write_project_file_base64,
                read_external_file,
                copy_external_file,
            export_html_file,
            write_text_absolute,
            write_base64_absolute,
            get_parent_dir,
            export_zip_archive,
            build_standalone_exe,
            build_android_apk,
            open_in_explorer,
            create_project_dir,
            rename_project_entry,
            delete_project_entry,
            git_status,
            git_init,
            git_commit,
            git_show_head,
            git_branches,
            git_checkout,
            git_log,
            git_discard,
            run_terminal_command,
            get_app_version,
            get_launch_file,
            fetch_roylang_releases,
            list_installed_engines,
            download_roylang_engine,
            read_installed_engine,
            set_active_engine,
            delete_installed_engine,
            check_ide_update,
            install_ide_update,
            relaunch_app,
            host_os_call
        ])
        .run(tauri::generate_context!())
        .expect("error while running RoyStudio Desktop");
}
