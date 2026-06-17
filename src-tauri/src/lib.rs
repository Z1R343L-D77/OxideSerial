use serde::{Deserialize, Serialize};
use serialport::SerialPort;
extern crate encoding_rs;
use std::sync::atomic::{AtomicU64, Ordering};
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
    pub protocol: String,
}

impl Default for SerialConfig {
    fn default() -> Self {
        Self {
            port_name: String::new(),
            baud_rate: 9600,
            data_bits: 8,
            stop_bits: 1,
            parity: "none".into(),
            protocol: "FireWater".into(),
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
    pub rx_bytes: Arc<AtomicU64>,
    pub tx_bytes: Arc<AtomicU64>,
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
            rx_bytes: Arc::new(AtomicU64::new(0)),
            tx_bytes: Arc::new(AtomicU64::new(0)),
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
    let rx_counter = Arc::clone(&state.rx_bytes);
    let config_arc = Arc::clone(&state.config);

    let handle = std::thread::spawn(move || {
        let mut line_buf = String::new();
        let mut raw_buf = Vec::<u8>::new();
        let mut byte_buf = [0u8; 4096];
        const MAX_LINE_LEN: usize = 65536; // R5: line_buf 最大 64KB

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
                    // M10: RX 字节计数
                    rx_counter.fetch_add(n as u64, Ordering::Relaxed);

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

                    // 获取当前协议
                    let protocol = {
                        match config_arc.lock() {
                            Ok(guard) => guard.protocol.clone(),
                            Err(_) => "FireWater".to_string(),
                        }
                    };

                    if protocol == "JustFloat" {
                        raw_buf.extend_from_slice(&data);
                        if raw_buf.len() > 65536 {
                            raw_buf.clear();
                        }
                        let tail = [0x00, 0x00, 0x80, 0x7f];
                        while let Some(pos) = find_subsequence(&raw_buf, &tail) {
                            let frame_bytes = &raw_buf[..pos];
                            if frame_bytes.len() > 0 && frame_bytes.len() % 4 == 0 {
                                let mut values = Vec::new();
                                for chunk in frame_bytes.chunks_exact(4) {
                                    let val = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                                    values.push(val as f64);
                                }
                                if !values.is_empty() {
                                    let frame = DataFrame {
                                        timestamp: start_time.elapsed().as_secs_f64(),
                                        values,
                                        raw: format!("JustFloat Frame: {} channels", frame_bytes.len() / 4),
                                    };
                                    let _ = app.emit("waveform-data", &frame);
                                }
                            }
                            raw_buf.drain(..pos + 4);
                        }
                    } else if protocol == "FireWater" {
                        // 备注：解析数值行用于波形
                        line_buf.push_str(&ascii_str);

                        // R5: line_buf 长度限制
                        if line_buf.len() > MAX_LINE_LEN {
                            line_buf.clear();
                        }

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
                }
                Err(e) => {
                    // R1: 串口断开检测 — 发送错误事件到前端
                    let _ = app.emit("serial-error", &e);
                    break;
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

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
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

    // M10: 重置计数器
    state.rx_bytes.store(0, std::sync::atomic::Ordering::Relaxed);
    state.tx_bytes.store(0, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

// M10: 获取收发字节统计
#[tauri::command]
fn get_byte_stats(state: tauri::State<AppState>) -> Result<(u64, u64), String> {
    let rx = state.rx_bytes.load(std::sync::atomic::Ordering::Relaxed);
    let tx = state.tx_bytes.load(std::sync::atomic::Ordering::Relaxed);
    Ok((rx, tx))
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
            // M10: TX 字节计数
            state.tx_bytes.fetch_add(n as u64, std::sync::atomic::Ordering::Relaxed);
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

#[tauri::command]
fn encode_string(text: String, encoding: String) -> Result<Vec<u8>, String> {
    if encoding.to_lowercase() == "gbk" {
        let (cow, _, _) = encoding_rs::GBK.encode(&text);
        Ok(cow.into_owned())
    } else {
        Ok(text.into_bytes())
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

#[tauri::command]
fn build_modbus_write_rtu(
    slave_id: u8,
    function_code: u8,
    register_addr: u16,
    data: Vec<u8>,
) -> Result<Vec<u8>, String> {
    let mut frame = vec![slave_id, function_code];
    frame.push((register_addr >> 8) as u8);
    frame.push((register_addr & 0xFF) as u8);

    if function_code == 5 || function_code == 6 {
        if data.len() != 2 {
            return Err("FC 05/06 requires exactly 2 bytes of data".into());
        }
        frame.extend_from_slice(&data);
    } else if function_code == 16 {
        let register_count = (data.len() / 2) as u16;
        frame.push((register_count >> 8) as u8);
        frame.push((register_count & 0xFF) as u8);
        frame.push(data.len() as u8);
        frame.extend_from_slice(&data);
    } else {
        return Err("Unsupported write function code".into());
    }

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

#[tauri::command]
fn set_protocol(state: tauri::State<AppState>, protocol: String) -> Result<(), String> {
    let mut config = lock_or_err!(state.config, "config");
    config.protocol = protocol;
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
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            list_ports,
            open_port,
            close_port,
            get_status,
            send_data,
            build_modbus_rtu,
            build_modbus_write_rtu,
            parse_modbus_rtu,
            set_close_to_tray,
            get_byte_stats,
            set_protocol,
            encode_string,
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
