// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    image::Image,
    menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder,
};

mod auth;
mod cli;
mod commands;
mod config;
mod paths;
mod service;

pub fn refresh_tray(app: &AppHandle) {
    let cfg = config::load_agent_config();
    let info = service::query_status_info();
    let state = config::detect_state(&cfg, &info.service);
    if let Ok(icon) = Image::from_bytes(tray_icon(&state)) {
        let tooltip = tray_tooltip(&state, &cfg);
        if let Some(tray) = app.tray_by_id("main") {
            let _ = tray.set_icon(Some(icon));
            let _ = tray.set_tooltip(Some(&tooltip));
            if let Ok(menu) = build_menu(app, &state, &cfg, &info.service, info.path_count) {
                let _ = tray.set_menu(Some(menu));
            }
        }
    }
}

fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    state: &config::AgentState,
    cfg: &config::AgentConfig,
    service: &str,
    path_count: usize,
) -> tauri::Result<Menu<R>> {
    let quit = MenuItemBuilder::new("Quit").id("quit").build(app)?;

    if *state == config::AgentState::Unconfigured {
        let connect = MenuItemBuilder::new("Connect to Broker…").id("auth").build(app)?;
        MenuBuilder::new(app)
            .item(&connect)
            .item(&PredefinedMenuItem::separator(app)?)
            .item(&quit)
            .build()
    } else {
        let status_text = match state {
            config::AgentState::Connected => format!(
                "● Connected to {}",
                cfg.broker_url.as_deref().unwrap_or("broker")
            ),
            config::AgentState::Connecting => "● Connecting…".to_string(),
            config::AgentState::Disconnected => "● Stopped".to_string(),
            config::AgentState::Error => "● Disconnected".to_string(),
            config::AgentState::Unconfigured => unreachable!(),
        };
        let paths_label = if path_count == 1 { "1 path" } else { &format!("{path_count} paths") };
        let detail_text = format!(
            "  agent: {} · {}",
            cfg.host.as_deref().unwrap_or("—"),
            paths_label,
        );

        let status_line = MenuItemBuilder::new(status_text)
            .id("status-info")
            .enabled(false)
            .build(app)?;
        let detail_line = MenuItemBuilder::new(detail_text)
            .id("detail-info")
            .enabled(false)
            .build(app)?;

        let status = MenuItemBuilder::new("Status & Logs…").id("status").build(app)?;
        let paths = MenuItemBuilder::new("Paths…").id("paths").build(app)?;
        let settings = MenuItemBuilder::new("Settings…").id("settings").build(app)?;
        let running = service == "active";
        let start = MenuItemBuilder::new("Start Agent").id("start").enabled(!running).build(app)?;
        let stop = MenuItemBuilder::new("Stop Agent").id("stop").enabled(running).build(app)?;
        let restart = MenuItemBuilder::new("Restart Agent").id("restart").build(app)?;
        MenuBuilder::new(app)
            .item(&status_line)
            .item(&detail_line)
            .item(&PredefinedMenuItem::separator(app)?)
            .item(&status)
            .item(&paths)
            .item(&settings)
            .item(&PredefinedMenuItem::separator(app)?)
            .item(&start)
            .item(&stop)
            .item(&restart)
            .item(&PredefinedMenuItem::separator(app)?)
            .item(&quit)
            .build()
    }
}

fn open_window(app: &AppHandle, name: &str, title: &str, width: f64, height: f64) {
    if let Some(w) = app.get_webview_window(name) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let url = format!("index.html?window={name}");
    let _ = WebviewWindowBuilder::new(app, name, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(width, height)
        .resizable(false)
        .center()
        .build();
}

fn tray_icon(state: &config::AgentState) -> &'static [u8] {
    match state {
        config::AgentState::Connected => include_bytes!("../icons/tray/connected.png"),
        config::AgentState::Connecting => include_bytes!("../icons/tray/connecting.png"),
        config::AgentState::Disconnected => include_bytes!("../icons/tray/disconnected.png"),
        config::AgentState::Error => include_bytes!("../icons/tray/error.png"),
        config::AgentState::Unconfigured => include_bytes!("../icons/tray/unconfigured.png"),
    }
}

fn tray_tooltip(state: &config::AgentState, cfg: &config::AgentConfig) -> String {
    match state {
        config::AgentState::Connected => format!(
            "Constellation — Connected to {}",
            cfg.broker_url.as_deref().unwrap_or("")
        ),
        config::AgentState::Connecting => "Constellation — Connecting…".to_string(),
        config::AgentState::Disconnected => "Constellation — Stopped".to_string(),
        config::AgentState::Error => "Constellation — Disconnected".to_string(),
        config::AgentState::Unconfigured => "Constellation — Not set up".to_string(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::get_config_dir,
            commands::save_settings,
            commands::update_tray,
            auth::start_device_flow,
            auth::poll_device_flow,
            service::rotate_token,
            service::deregister_agent,
            service::get_service_status,
            service::get_agent_broker_info,
            service::start_agent,
            service::stop_agent,
            service::restart_agent,
            service::get_logs,
            paths::get_paths,
            paths::add_path,
            paths::remove_path,
        ])
        .setup(|app| {
            let cfg = config::load_agent_config();
            let info = service::query_status_info();
            let state = config::detect_state(&cfg, &info.service);

            let icon = Image::from_bytes(tray_icon(&state))?;
            let tooltip = tray_tooltip(&state, &cfg);
            let menu = build_menu(app.handle(), &state, &cfg, &info.service, info.path_count)?;

            TrayIconBuilder::with_id("main")
                .icon(icon)
                .tooltip(&tooltip)
                .menu(&menu)
                .on_menu_event(|app, event| {
                    let app = app.clone();
                    match event.id().as_ref() {
                        "auth" => open_window(&app, "auth", "Connect to Broker", 480.0, 280.0),
                        "status" => open_window(&app, "status", "Constellation — Status", 480.0, 560.0),
                        "paths" => open_window(&app, "paths", "Constellation — Paths", 720.0, 420.0),
                        "settings" => open_window(&app, "settings", "Constellation — Settings", 480.0, 380.0),
                        "start" | "stop" | "restart" => {
                            let cmd = event.id().as_ref().to_string();
                            std::thread::spawn(move || {
                                let _ = crate::cli::run(&["agent", &cmd]);
                                refresh_tray(&app);
                            });
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .build(app)?;

            let poll_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(5));
                refresh_tray(&poll_handle);
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // Only keep the app alive when a window closes naturally (no explicit exit code).
                // app.exit(0) sets code = Some(0) and must be allowed through.
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
