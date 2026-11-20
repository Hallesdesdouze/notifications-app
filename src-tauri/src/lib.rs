use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::{Map, Value};
use tauri::{
    ipc::Response,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WindowEvent, Wry,
};
use tauri_plugin_autostart::MacosLauncher;

/* ================= Constantes ================= */

const HISTORY_FILE: &str = "history.jsonl";
const HISTORY_RETENTION_MS: u64 = 10 * 24 * 60 * 60 * 1000; // 10 jours
const HISTORY_PRUNE_INTERVAL: Duration = Duration::from_secs(60 * 60); // toutes les heures
const HISTORY_MAX_MESSAGE_CHARS: usize = 2000;

const SOUND_DIR: &str = "sounds";
const SOUND_FILES: [&str; 2] = ["custom.ogg", "custom.wav"];
const SOUND_MAX_BYTES: u64 = 2 * 1024 * 1024; // 2 Mo

const OVERLAY_MARGIN: f64 = 16.0; // marge avec le bord de l'écran (px logiques)

/* ================= État partagé ================= */

/// Sérialise les accès au fichier d'historique (ajout / purge / lecture)
struct HistoryLock(Mutex<()>);

/// Case « Couper le son » du menu de l'icône, synchronisée avec l'appli
struct TrayMenuState {
    mute: CheckMenuItem<Wry>,
}

/* ================= Utilitaires ================= */

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn data_dir(app: &AppHandle, sub: Option<&str>) -> Result<PathBuf, String> {
    let mut dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if let Some(sub) = sub {
        dir = dir.join(sub);
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app, None)?.join(HISTORY_FILE))
}

fn entry_at(entry: &Value) -> u64 {
    entry.get("at").and_then(Value::as_u64).unwrap_or(0)
}

fn read_entries(path: &Path) -> Vec<Value> {
    match fs::read_to_string(path) {
        Ok(content) => content
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Réécrit le fichier en ne gardant que les 10 derniers jours
fn prune_history_file(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let cutoff = now_ms().saturating_sub(HISTORY_RETENTION_MS);
    let mut out = String::new();

    for entry in read_entries(path).iter().filter(|e| entry_at(e) >= cutoff) {
        out.push_str(&entry.to_string());
        out.push('\n');
    }

    let tmp = path.with_extension("jsonl.tmp");
    fs::write(&tmp, out).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/* ================= Commandes ================= */

/// Nom de l'appareil affiché sur le site (liste des appareils connectés)
#[tauri::command]
fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Application de bureau".into())
}

/// Ajoute une notification à l'historique (une ligne JSON par notification)
#[tauri::command]
fn history_add(app: AppHandle, lock: State<'_, HistoryLock>, entry: Value) -> Result<(), String> {
    let mut entry: Map<String, Value> = match entry {
        Value::Object(map) => map,
        _ => return Err("Entrée d'historique invalide".into()),
    };

    if entry.get("at").and_then(Value::as_u64).is_none() {
        entry.insert("at".to_string(), Value::from(now_ms()));
    }

    if let Some(Value::String(message)) = entry.get_mut("message") {
        if message.chars().count() > HISTORY_MAX_MESSAGE_CHARS {
            *message = message.chars().take(HISTORY_MAX_MESSAGE_CHARS).collect();
        }
    }

    let line = Value::Object(entry).to_string();

    let _guard = lock.0.lock().unwrap_or_else(|e| e.into_inner());
    let path = history_path(&app)?;

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;

    writeln!(file, "{line}").map_err(|e| e.to_string())
}

/// Historique des 10 derniers jours, du plus récent au plus ancien
#[tauri::command]
fn history_list(app: AppHandle, lock: State<'_, HistoryLock>) -> Result<Vec<Value>, String> {
    let _guard = lock.0.lock().unwrap_or_else(|e| e.into_inner());
    let path = history_path(&app)?;
    let cutoff = now_ms().saturating_sub(HISTORY_RETENTION_MS);

    let mut entries: Vec<Value> = read_entries(&path)
        .into_iter()
        .filter(|e| entry_at(e) >= cutoff)
        .collect();

    entries.reverse();
    Ok(entries)
}

#[tauri::command]
fn history_clear(app: AppHandle, lock: State<'_, HistoryLock>) -> Result<(), String> {
    let _guard = lock.0.lock().unwrap_or_else(|e| e.into_inner());
    let path = history_path(&app)?;

    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Copie le son choisi par l'utilisateur dans le dossier de l'appli.
/// Renvoie le nom du fichier d'origine (pour l'affichage).
#[tauri::command]
fn import_sound(app: AppHandle, path: String) -> Result<String, String> {
    let source = PathBuf::from(&path);

    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or("Le fichier n'a pas d'extension.")?;

    if ext != "ogg" && ext != "wav" {
        return Err("Seuls les fichiers .ogg et .wav sont acceptés.".into());
    }

    let metadata = fs::metadata(&source).map_err(|e| e.to_string())?;

    if metadata.len() > SOUND_MAX_BYTES {
        return Err("Le fichier dépasse 2 Mo.".into());
    }

    let dir = data_dir(&app, Some(SOUND_DIR))?;

    for old in SOUND_FILES {
        let _ = fs::remove_file(dir.join(old));
    }

    fs::copy(&source, dir.join(format!("custom.{ext}"))).map_err(|e| e.to_string())?;

    Ok(source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Son personnalisé")
        .to_string())
}

/// Contenu brut du son personnalisé (lu côté JS en ArrayBuffer)
#[tauri::command]
fn read_sound(app: AppHandle) -> Result<Response, String> {
    let dir = data_dir(&app, Some(SOUND_DIR))?;

    for name in SOUND_FILES {
        let path = dir.join(name);

        if path.exists() {
            let bytes = fs::read(&path).map_err(|e| e.to_string())?;
            return Ok(Response::new(bytes));
        }
    }

    Err("Aucun son personnalisé".into())
}

#[tauri::command]
fn set_tray_muted(state: State<'_, TrayMenuState>, muted: bool) -> Result<(), String> {
    state.mute.set_checked(muted).map_err(|e| e.to_string())
}

/// Place l'overlay dans le coin choisi et l'ajuste à la taille de son contenu.
/// height = 0 : plus de notification, l'overlay devient minuscule et laisse passer les clics.
#[tauri::command]
fn overlay_layout(app: AppHandle, corner: String, width: f64, height: f64) -> Result<(), String> {
    let window = app
        .get_webview_window("overlay")
        .ok_or("Fenêtre d'overlay introuvable")?;

    if height <= 0.0 {
        window.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
        window.set_size(PhysicalSize::new(1u32, 1u32)).map_err(|e| e.to_string())?;
        return Ok(());
    }

    let monitor = window
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("Aucun écran détecté")?;

    let scale = monitor.scale_factor();
    let area = monitor.work_area(); // écran sans la barre des tâches

    let margin = (OVERLAY_MARGIN * scale).round() as i32;
    let w = (width * scale).round() as i32;
    let h = (height * scale).round() as i32;

    let left = area.position.x + margin;
    let right = area.position.x + area.size.width as i32 - w - margin;
    let top = area.position.y + margin;
    let bottom = area.position.y + area.size.height as i32 - h - margin;

    let (x, y) = match corner.as_str() {
        "top-left" => (left, top),
        "top-right" => (right, top),
        "bottom-left" => (left, bottom),
        _ => (right, bottom),
    };

    window
        .set_size(PhysicalSize::new(w.max(1) as u32, h.max(1) as u32))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    window.set_ignore_cursor_events(false).map_err(|e| e.to_string())?;
    window.set_always_on_top(true).map_err(|e| e.to_string())?;

    Ok(())
}

/* ================= Application ================= */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Doit être le premier plugin : une 2e instance réaffiche la fenêtre existante
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .manage(HistoryLock(Mutex::new(())))
        .invoke_handler(tauri::generate_handler![
            device_name,
            history_add,
            history_list,
            history_clear,
            import_sound,
            read_sound,
            set_tray_muted,
            overlay_layout
        ])
        .setup(|app| {
            /* ----- Menu de l'icône ----- */
            let open = MenuItem::with_id(app, "open", "Ouvrir", true, None::<&str>)?;
            let mute = CheckMenuItem::with_id(app, "mute", "Couper le son", true, false, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
            let separator_1 = PredefinedMenuItem::separator(app)?;
            let separator_2 = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&open, &separator_1, &mute, &separator_2, &quit])?;

            app.manage(TrayMenuState { mute: mute.clone() });

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Halles des Douze")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    // L'appli inverse l'état et renvoie la valeur via set_tray_muted
                    "mute" => {
                        let _ = app.emit_to("main", "tray:mute-toggle", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            /* ----- Overlay : laisse passer les clics tant qu'il est vide ----- */
            if let Some(overlay) = app.get_webview_window("overlay") {
                let _ = overlay.set_ignore_cursor_events(true);
            }

            /* ----- Purge de l'historique au démarrage puis toutes les heures ----- */
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                {
                    let lock = handle.state::<HistoryLock>();
                    let _guard = lock.0.lock().unwrap_or_else(|e| e.into_inner());

                    if let Ok(path) = history_path(&handle) {
                        let _ = prune_history_file(&path);
                    }
                }
                std::thread::sleep(HISTORY_PRUNE_INTERVAL);
            });

            /* ----- Lancé au démarrage de Windows : on reste discret ----- */
            if std::env::args().any(|arg| arg == "--minimized") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();

                // La croix cache la fenêtre principale ; l'overlay ne se ferme jamais
                if window.label() == "main" {
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application");
}
