use serde::{Deserialize, Serialize};
use serialport::SerialPort;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialConfig {
    pub port_name: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub stop_bits: u8,
    pub parity: String,
}

impl Default for SerialConfig {
    fn default() -> Self {
        Self {
            port_name: String::new(),
            baud_rate: 9600,
            data_bits: 8,
            stop_bits: 1,
            parity: "none".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialStatus {
    pub connected: bool,
    pub port_name: String,
    pub baud_rate: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataFrame {
    pub timestamp: f64,
    pub values: Vec<f64>,
    pub raw: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalData {
    pub direction: String,
    pub hex: String,
    pub ascii: String,
    pub timestamp: String,
}

// 备注：使用 Arc<Mutex> 以便在线程间共享
pub struct AppState {
    pub port: Arc<Mutex<Option<Box<dyn SerialPort>>>>,
    pub config: Arc<Mutex<SerialConfig>>,
    pub running: Arc<Mutex<bool>>,
    pub start_time: Instant,
    pub close_to_tray: Arc<Mutex<bool>>,
    pub read_thread: Arc<Mutex<Option<JoinHandle<()>>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            port: Arc::new(Mutex::new(None)),
            config: Arc::new(Mutex::new(SerialConfig::default())),
            running: Arc::new(Mutex::new(false)),
            start_time: Instant::now(),
            close_to_tray: Arc::new(Mutex::new(true)),
            read_thread: Arc::new(Mutex::new(None)),
        }
    }
}

/// 备注：安全锁获取宏，避免 unwrap 导致 panic 连锁
macro_rules! lock_or_err {
    ($mutex:expr, $name:expr) => {
        $mutex
            .lock()
            .map_err(|e| format!("{}: {}", $name, e))?
    };
}

#[tauri::command]
fn list_ports() -> Result<Vec<String>, String> {
    serialport::available_ports()
        .map(|ports| ports.iter().map(|p| p.port_name.clone()).collect())
        .map_err(|e| format!("获取串口列表失败: {e}"))
}

#[tauri::command]
fn open_port(
    state: tauri::State<AppState>,
    config: SerialConfig,
    app: tauri::AppHandle,
) -> Result<SerialStatus, String> {
    let data_bits = match config.data_bits {
        5 => serialport::DataBits::Five,
        6 => serialport::DataBits::Six,
        7 => serialport::DataBits::Seven,
        8 => serialport::DataBits::Eight,
        _ => return Err("无效数据位".into()),
    };
    let stop_bits = match config.stop_bits {
        1 => serialport::StopBits::One,
        2 => serialport::StopBits::Two,
        _ => return Err("无效停止位".into()),
    };
    let parity = match config.parity.as_str() {
        "none" => serialport::Parity::None,
        "odd" => serialport::Parity::Odd,
        "even" => serialport::Parity::Even,
        _ => return Err("无效校验位".into()),
    };

    let port = serialport::new(&config.port_name, config.baud_rate)
        .data_bits(data_bits)
        .stop_bits(stop_bits)
        .parity(parity)
        .timeout(Duration::from_millis(10))
        .open()
        .map_err(|e| format!("打开串口失败: {e}"))?;

    {
        let mut port_lock = lock_or_err!(state.port, "port");
        *port_lock = Some(port);
        let mut config_lock = lock_or_err!(state.config, "config");
        *config_lock = config.clone();
        let mut running = lock_or_err!(state.running, "running");
        *running = true;
    }

    // 备注：启动后台读取线程
    let port_arc = Arc::clone(&state.port);
    let running_arc = Arc::clone(&state.running);
    let start_time = state.start_time;

    let handle = std::thread::spawn(move || {
        let mut line_buf = String::new();
        let mut byte_buf = [0u8; 4096];

        loop {
            {
                let running = match running_arc.lock() {
                    Ok(guard) => guard,
                    Err(_) => break,
                };
                if !*running {
                    break;
                }
            }

            let read_result = {
                let mut port_lock = match port_arc.lock() {
                    Ok(guard) => guard,
                    Err(_) => break,
                };
                match port_lock.as_mut() {
                    Some(port) => match port.read(&mut byte_buf) {
                        Ok(n) => Ok((byte_buf[..n].to_vec(), n)),
                        Err(e) => {
                            if e.kind() == std::io::ErrorKind::TimedOut {
                                Ok((vec![], 0))
                            } else {
                                Err(e.to_string())
                            }
                        }
                    },
                    None => {
                        std::thread::sleep(Duration::from_millis(50));
                        continue;
                    }
                }
            };

            match read_result {
                Ok((data, n)) if n > 0 => {
                    let hex_str: String = data
                        .iter()
                        .map(|b| format!("{:02X}", b))
                        .collect::<Vec<_>>()
                        .join(" ");
                    let ascii_str = String::from_utf8_lossy(&data).to_string();

                    let terminal_data = TerminalData {
                        direction: "RX".into(),
                        hex: hex_str,
                        ascii: ascii_str.clone(),
                        timestamp: chrono_now(),
                    };
                    let _ = app.emit("serial-data", &terminal_data);

                    // 备注：解析数值行用于波形
                    line_buf.push_str(&ascii_str);
                    while let Some(pos) = line_buf.find('\n') {
                        let line = line_buf[..pos].trim().to_string();
                        line_buf = line_buf[pos + 1..].to_string();
                        if !line.is_empty() {
                            if let Some(frame) = parse_data_line(&line, start_time) {
                                let _ = app.emit("waveform-data", &frame);
                            }
                        }
                    }
                }
                _ => {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
    });

    // 备注：保存线程句柄
    {
        let mut thread_lock = lock_or_err!(state.read_thread, "read_thread");
        *thread_lock = Some(handle);
    }

    Ok(SerialStatus {
        connected: true,
        port_name: config.port_name,
        baud_rate: config.baud_rate,
    })
}

fn parse_data_line(line: &str, start_time: Instant) -> Option<DataFrame> {
    let parts: Vec<&str> = line.split(',').collect();
    if parts.is_empty() {
        return None;
    }

    let start_idx = if parts[0].parse::<f64>().is_ok() {
        0
    } else {
        1
    };

    let mut values = Vec::new();
    for part in &parts[start_idx..] {
        match part.trim().parse::<f64>() {
            Ok(v) => values.push(v),
            Err(_) => return None,
        }
    }

    if values.is_empty() {
        return None;
    }

    Some(DataFrame {
        timestamp: start_time.elapsed().as_secs_f64(),
        values,
        raw: line.to_string(),
    })
}

// 备注：获取本地时间 HH:MM:SS.mmm
fn chrono_now() -> String {
    match time::OffsetDateTime::now_local() {
        Ok(dt) => format!("{:02}:{:02}:{:02}.{:03}", dt.hour(), dt.minute(), dt.second(), dt.millisecond()),
        Err(_) => {
            // 备注：回退到 UTC
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default();
            let ms = now.as_millis();
            let total_secs = (ms / 1000) % 86400;
            format!(
                "{:02}:{:02}:{:02}.{:03}",
                total_secs / 3600,
                (total_secs % 3600) / 60,
                total_secs % 60,
                ms % 1000
            )
        }
    }
}

#[tauri::command]
fn close_port(state: tauri::State<AppState>) -> Result<(), String> {
    // 备注：先停止读取线程，等待其退出，再释放串口
    {
        let mut running = lock_or_err!(state.running, "running");
        *running = false;
    }

    // 备注：join 线程，避免竞态
    {
        let mut thread_lock = lock_or_err!(state.read_thread, "read_thread");
        if let Some(handle) = thread_lock.take() {
            let _ = handle.join();
        }
    }

    // 备注：线程已退出，安全释放串口
    let mut port_lock = lock_or_err!(state.port, "port");
    *port_lock = None;
    Ok(())
}

#[tauri::command]
fn get_status(state: tauri::State<AppState>) -> Result<SerialStatus, String> {
    let port_lock = lock_or_err!(state.port, "port");
    let config_lock = lock_or_err!(state.config, "config");
    Ok(SerialStatus {
        connected: port_lock.is_some(),
        port_name: config_lock.port_name.clone(),
        baud_rate: config_lock.baud_rate,
    })
}

#[tauri::command]
fn send_data(
    state: tauri::State<AppState>,
    data: Vec<u8>,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    let mut port_lock = lock_or_err!(state.port, "port");
    match port_lock.as_mut() {
        Some(port) => {
            let n = port.write(&data).map_err(|e| format!("发送失败: {e}"))?;
            let hex_str: String = data
                .iter()
                .map(|b| format!("{:02X}", b))
                .collect::<Vec<_>>()
                .join(" ");
            let terminal_data = TerminalData {
                direction: "TX".into(),
                hex: hex_str,
                ascii: String::from_utf8_lossy(&data).to_string(),
                timestamp: chrono_now(),
            };
            let _ = app.emit("serial-data", &terminal_data);
            Ok(n)
        }
        None => Err("串口未连接".into()),
    }
}

fn modbus_crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for byte in data {
        crc ^= *byte as u16;
        for _ in 0..8 {
            if crc & 0x0001 != 0 {
                crc = (crc >> 1) ^ 0xA001;
            } else {
                crc >>= 1;
            }
        }
    }
    crc
}

#[tauri::command]
fn build_modbus_rtu(
    slave_id: u8,
    function_code: u8,
    register_addr: u16,
    register_count: u16,
) -> Result<Vec<u8>, String> {
    let mut frame = vec![slave_id, function_code];
    frame.push((register_addr >> 8) as u8);
    frame.push((register_addr & 0xFF) as u8);
    frame.push((register_count >> 8) as u8);
    frame.push((register_count & 0xFF) as u8);
    let crc = modbus_crc16(&frame);
    frame.push((crc & 0xFF) as u8);
    frame.push((crc >> 8) as u8);
    Ok(frame)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModbusResponse {
    pub slave_id: u8,
    pub function_code: u8,
    pub data: Vec<u8>,
    pub is_exception: bool,
    pub exception_code: Option<u8>,
    pub crc_valid: bool,
}

#[tauri::command]
fn parse_modbus_rtu(data: Vec<u8>) -> Result<ModbusResponse, String> {
    if data.len() < 3 {
        return Err("数据长度不足".into());
    }
    let slave_id = data[0];
    let function_code = data[1];
    if function_code & 0x80 != 0 {
        let exception_code = if data.len() > 2 { data[2] } else { 0 };
        return Ok(ModbusResponse {
            slave_id,
            function_code,
            data: vec![],
            is_exception: true,
            exception_code: Some(exception_code),
            crc_valid: false,
        });
    }
    let data_len = data.len();
    let received_crc = (data[data_len - 1] as u16) << 8 | (data[data_len - 2] as u16);
    let calculated_crc = modbus_crc16(&data[..data_len - 2]);
    let crc_valid = received_crc == calculated_crc;
    let payload = if data_len > 4 {
        data[2..data_len - 2].to_vec()
    } else {
        vec![]
    };
    Ok(ModbusResponse {
        slave_id,
        function_code,
        data: payload,
        is_exception: false,
        exception_code: None,
        crc_valid,
    })
}

#[tauri::command]
fn set_close_to_tray(state: tauri::State<AppState>, enabled: bool) -> Result<(), String> {
    let mut flag = lock_or_err!(state.close_to_tray, "close_to_tray");
    *flag = enabled;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
        ))
        .invoke_handler(tauri::generate_handler![
            list_ports,
            open_port,
            close_port,
            get_status,
            send_data,
            build_modbus_rtu,
            parse_modbus_rtu,
            set_close_to_tray,
        ])
        .setup(|app| {
            // 备注：系统托盘菜单
            let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            // 备注：创建托盘图标
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("OxideSerial")
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 备注：根据 close_to_tray 设置决定隐藏还是退出
                let state = window.state::<AppState>();
                let should_tray = match state.close_to_tray.lock() {
                    Ok(guard) => *guard,
                    Err(_) => true, // 默认隐藏到托盘
                };
                if should_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
