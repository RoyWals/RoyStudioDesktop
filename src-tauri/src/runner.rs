#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine as _;
use serde::Deserialize;
use std::borrow::Cow;
use std::fs;
use std::io::Cursor;
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::window::{Fullscreen, Icon, WindowBuilder};
use wry::{http::Response, WebViewBuilder};

const MAGIC: &[u8; 8] = b"ROYEXE65";

#[derive(Deserialize)]
struct RunnerConfig {
    #[serde(default = "def_title")]
    title: String,
    #[serde(default = "def_w")]
    width: u32,
    #[serde(default = "def_h")]
    height: u32,
    #[serde(default = "def_bg")]
    bg: String,
    #[serde(default)]
    fullscreen: bool,
    #[serde(default = "def_true")]
    resizable: bool,
    #[serde(default)]
    icon_base64: Option<String>,
}

fn def_title() -> String {
    "RoyLang Game".into()
}
fn def_w() -> u32 {
    800
}
fn def_h() -> u32 {
    500
}
fn def_bg() -> String {
    "#0b0f1a".into()
}
fn def_true() -> bool {
    true
}

impl Default for RunnerConfig {
    fn default() -> Self {
        Self {
            title: def_title(),
            width: def_w(),
            height: def_h(),
            bg: def_bg(),
            fullscreen: false,
            resizable: true,
            icon_base64: None,
        }
    }
}

fn load_overlay() -> (RunnerConfig, Vec<u8>) {
    let fallback_html = br#"<!doctype html><html><body style="margin:0;background:#090d16;color:#cbd5e1;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh"><div><h2>RoyLang Runner Ready</h2><p>Attach a ROYEXE65 game payload from RoyStudio Desktop.</p></div></body></html>"#.to_vec();
    let exe_path = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return (RunnerConfig::default(), fallback_html),
    };
    let bytes = match fs::read(exe_path) {
        Ok(b) => b,
        Err(_) => return (RunnerConfig::default(), fallback_html),
    };
    let len = bytes.len();
    if len < 16 || &bytes[len - 8..len] != MAGIC {
        return (RunnerConfig::default(), fallback_html);
    }
    let cfg_len = u32::from_le_bytes(bytes[len - 16..len - 12].try_into().unwrap()) as usize;
    let html_len = u32::from_le_bytes(bytes[len - 12..len - 8].try_into().unwrap()) as usize;
    if cfg_len + html_len + 16 > len {
        return (RunnerConfig::default(), fallback_html);
    }
    let html_start = len - 16 - html_len;
    let cfg_start = html_start - cfg_len;
    let cfg: RunnerConfig = serde_json::from_slice(&bytes[cfg_start..html_start]).unwrap_or_default();
    let html = bytes[html_start..len - 16].to_vec();
    (cfg, html)
}

fn decode_window_icon(b64: &str) -> Option<Icon> {
    let clean = b64.split(',').last().unwrap_or(b64).trim();
    let raw = base64::engine::general_purpose::STANDARD.decode(clean).ok()?;
    let dir = ico::IconDir::read(Cursor::new(raw)).ok()?;
    let entry = dir
        .entries()
        .iter()
        .max_by_key(|e| (e.width(), e.height()))?;
    let image = entry.decode().ok()?;
    let w = image.width();
    let h = image.height();
    let rgba = image.rgba_data().to_vec();
    Icon::from_rgba(rgba, w, h).ok()
}

fn main() {
    let (cfg, html_bytes) = load_overlay();
    let event_loop = EventLoop::new();
    let mut wb = WindowBuilder::new()
        .with_title(if cfg.title.is_empty() { "RoyLang Game" } else { &cfg.title })
        .with_inner_size(LogicalSize::new(cfg.width.max(240) as f64, cfg.height.max(180) as f64))
        .with_resizable(cfg.resizable);

    if cfg.fullscreen {
        wb = wb.with_fullscreen(Some(Fullscreen::Borderless(None)));
    }
    if let Some(ref b64) = cfg.icon_base64 {
        if let Some(icon) = decode_window_icon(b64) {
            wb = wb.with_window_icon(Some(icon));
        }
    }

    let window = wb.build(&event_loop).expect("failed to create game window");

    let _webview = WebViewBuilder::new()
        .with_custom_protocol("roygame".into(), move |_id, _req| {
            Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .body(Cow::Owned(html_bytes.clone()))
                .unwrap()
        })
        .with_url("http://roygame.localhost/index.html")
        .with_devtools(false)
        .build(&window)
        .expect("failed to build WebView2 game view");

    let _bg = cfg.bg;
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            *control_flow = ControlFlow::Exit;
        }
    });
}
