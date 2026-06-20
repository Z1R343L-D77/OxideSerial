use serde::{Deserialize, Serialize};
use serialport::SerialPort;
extern crate encoding_rs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use std::io::{Read, Write};
use tauri::Emitter;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialConfig {
    pub mode: String, // "serial", "udp", "tcp_client", "tcp_server"
    pub port_name: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub stop_bits: u8,
    pub parity: String,
    pub protocol: String,

    // UDP
    pub udp_remote_ip: String,
    pub udp_remote_port: u16,
    pub udp_local_port: u16,

    // TCP Client
    pub tcp_client_ip: String,
    pub tcp_client_port: u16,
    pub tcp_client_handshake: String,

    // TCP Server
    pub tcp_server_port: u16,
}

impl Default for SerialConfig {
    fn default() -> Self {
        Self {
            mode: "serial".into(),
            port_name: String::new(),
            baud_rate: 9600,
            data_bits: 8,
            stop_bits: 1,
            parity: "none".into(),
            protocol: "FireWater".into(),
            udp_remote_ip: "127.0.0.1".into(),
            udp_remote_port: 1346,
            udp_local_port: 1347,
            tcp_client_ip: "127.0.0.1".into(),
            tcp_client_port: 1346,
            tcp_client_handshake: "".into(),
            tcp_server_port: 1347,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialStatus {
    pub connected: bool,
    pub port_name: String,
    pub baud_rate: u32,
    pub mode: String,
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

// 备注：Modbus 后端轮询配置结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModbusRegisterConfig {
    pub id: String,
    pub name: String,
    pub slave_id: u8,
    pub function_code: u8,
    pub address: u16,
    pub count: u16,
    pub data_type: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModbusRegisterResult {
    pub id: String,
    pub value: String,
    pub status: String,
    pub last_updated: String,
}

// 备注：使用 Arc<Mutex> 以便在线程间共享
pub struct AppState {
    pub port: Arc<Mutex<Option<Box<dyn SerialPort>>>>,
    pub udp_socket: Arc<Mutex<Option<std::net::UdpSocket>>>,
    pub tcp_client: Arc<Mutex<Option<std::net::TcpStream>>>,
    pub tcp_server_listener: Arc<Mutex<Option<std::net::TcpListener>>>,
    pub tcp_server_clients: Arc<Mutex<Vec<(String, std::net::TcpStream)>>>,
    pub selected_tcp_client: Arc<Mutex<Option<String>>>,
    pub config: Arc<Mutex<SerialConfig>>,
    pub running: Arc<Mutex<bool>>,
    pub start_time: Instant,
    pub close_to_tray: Arc<Mutex<bool>>,
    pub read_thread: Arc<Mutex<Option<JoinHandle<()>>>>,
    pub tcp_accept_thread: Arc<Mutex<Option<JoinHandle<()>>>>,
    pub rx_bytes: Arc<AtomicU64>,
    pub tx_bytes: Arc<AtomicU64>,
    // Modbus 后端轮询
    pub modbus_polling: Arc<Mutex<bool>>,
    pub modbus_poll_thread: Arc<Mutex<Option<JoinHandle<()>>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            port: Arc::new(Mutex::new(None)),
            udp_socket: Arc::new(Mutex::new(None)),
            tcp_client: Arc::new(Mutex::new(None)),
            tcp_server_listener: Arc::new(Mutex::new(None)),
            tcp_server_clients: Arc::new(Mutex::new(Vec::new())),
            selected_tcp_client: Arc::new(Mutex::new(None)),
            config: Arc::new(Mutex::new(SerialConfig::default())),
            running: Arc::new(Mutex::new(false)),
            start_time: Instant::now(),
            close_to_tray: Arc::new(Mutex::new(true)),
            read_thread: Arc::new(Mutex::new(None)),
            tcp_accept_thread: Arc::new(Mutex::new(None)),
            rx_bytes: Arc::new(AtomicU64::new(0)),
            tx_bytes: Arc::new(AtomicU64::new(0)),
            modbus_polling: Arc::new(Mutex::new(false)),
            modbus_poll_thread: Arc::new(Mutex::new(None)),
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

fn emit_clients_changed(app: &tauri::AppHandle, clients_arc: &Arc<Mutex<Vec<(String, std::net::TcpStream)>>>) {
    if let Ok(clients) = clients_arc.lock() {
        let client_addrs: Vec<String> = clients.iter().map(|(addr, _)| addr.clone()).collect();
        let _ = app.emit("tcp-clients-changed", &client_addrs);
    }
}

#[tauri::command]
fn open_port(
    state: tauri::State<AppState>,
    config: SerialConfig,
    app: tauri::AppHandle,
) -> Result<SerialStatus, String> {
    match config.mode.as_str() {
        "serial" => {
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
            let app_clone = app.clone();

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
                            let _ = app_clone.emit("serial-data", &terminal_data);

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
                                            let _ = app_clone.emit("waveform-data", &frame);
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
                                            let _ = app_clone.emit("waveform-data", &frame);
                                        }
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            // R1: 串口断开检测 — 发送错误事件到前端
                            let _ = app_clone.emit("serial-error", &e);
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
                mode: "serial".to_string(),
            })
        }
        "udp" => {
            use std::net::UdpSocket;
            let socket = UdpSocket::bind(format!("0.0.0.0:{}", config.udp_local_port))
                .map_err(|e| format!("绑定 UDP 本地端口 {} 失败: {e}", config.udp_local_port))?;
            let _ = socket.set_read_timeout(Some(Duration::from_millis(100)));

            {
                let mut udp_lock = lock_or_err!(state.udp_socket, "udp_socket");
                *udp_lock = Some(socket.try_clone().map_err(|e| e.to_string())?);
                let mut config_lock = lock_or_err!(state.config, "config");
                *config_lock = config.clone();
                let mut running = lock_or_err!(state.running, "running");
                *running = true;
            }

            let socket_clone = socket.try_clone().map_err(|e| e.to_string())?;
            let running_arc = Arc::clone(&state.running);
            let rx_counter = Arc::clone(&state.rx_bytes);
            let start_time = state.start_time;
            let config_arc = Arc::clone(&state.config);
            let app_clone = app.clone();

            let handle = std::thread::spawn(move || {
                let mut line_buf = String::new();
                let mut raw_buf = Vec::<u8>::new();
                let mut byte_buf = [0u8; 4096];
                const MAX_LINE_LEN: usize = 65536;

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

                    match socket_clone.recv_from(&mut byte_buf) {
                        Ok((n, src_addr)) => {
                            if n > 0 {
                                let data = byte_buf[..n].to_vec();
                                rx_counter.fetch_add(n as u64, Ordering::Relaxed);

                                let hex_str: String = data
                                    .iter()
                                    .map(|b| format!("{:02X}", b))
                                    .collect::<Vec<_>>()
                                    .join(" ");
                                let ascii_str = String::from_utf8_lossy(&data).to_string();

                                let terminal_data = TerminalData {
                                    direction: format!("RX (UDP: {})", src_addr),
                                    hex: hex_str,
                                    ascii: ascii_str.clone(),
                                    timestamp: chrono_now(),
                                };
                                let _ = app_clone.emit("serial-data", &terminal_data);

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
                                                let _ = app_clone.emit("waveform-data", &frame);
                                            }
                                        }
                                        raw_buf.drain(..pos + 4);
                                    }
                                } else if protocol == "FireWater" {
                                    line_buf.push_str(&ascii_str);
                                    if line_buf.len() > MAX_LINE_LEN {
                                        line_buf.clear();
                                    }
                                    while let Some(pos) = line_buf.find('\n') {
                                        let line = line_buf[..pos].trim().to_string();
                                        line_buf = line_buf[pos + 1..].to_string();
                                        if !line.is_empty() {
                                            if let Some(frame) = parse_data_line(&line, start_time) {
                                                let _ = app_clone.emit("waveform-data", &frame);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        Err(_) => {
                            let running = match running_arc.lock() {
                                Ok(guard) => *guard,
                                Err(_) => false,
                            };
                            if !running {
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(50));
                        }
                    }
                }
            });

            {
                let mut thread_lock = lock_or_err!(state.read_thread, "read_thread");
                *thread_lock = Some(handle);
            }

            Ok(SerialStatus {
                connected: true,
                port_name: format!("UDP:{}", config.udp_local_port),
                baud_rate: 0,
                mode: "udp".to_string(),
            })
        }
        "tcp_client" => {
            use std::net::TcpStream;
            let target_addr = format!("{}:{}", config.tcp_client_ip, config.tcp_client_port);
            let mut stream = TcpStream::connect(&target_addr)
                .map_err(|e| format!("连接 TCP 服务器 {} 失败: {e}", target_addr))?;

            let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));

            if !config.tcp_client_handshake.is_empty() {
                let handshake_bytes = config.tcp_client_handshake.as_bytes();
                if let Err(e) = stream.write_all(handshake_bytes) {
                    return Err(format!("发送握手数据失败: {e}"));
                }

                state.tx_bytes.fetch_add(handshake_bytes.len() as u64, Ordering::Relaxed);
                let hex_str: String = handshake_bytes
                    .iter()
                    .map(|b| format!("{:02X}", b))
                    .collect::<Vec<_>>()
                    .join(" ");
                let terminal_data = TerminalData {
                    direction: "TX (TCP Handshake)".into(),
                    hex: hex_str,
                    ascii: config.tcp_client_handshake.clone(),
                    timestamp: chrono_now(),
                };
                let _ = app.emit("serial-data", &terminal_data);
            }

            {
                let mut tcp_client_lock = lock_or_err!(state.tcp_client, "tcp_client");
                *tcp_client_lock = Some(stream.try_clone().map_err(|e| e.to_string())?);
                let mut config_lock = lock_or_err!(state.config, "config");
                *config_lock = config.clone();
                let mut running = lock_or_err!(state.running, "running");
                *running = true;
            }

            let mut stream_clone = stream.try_clone().map_err(|e| e.to_string())?;
            let running_arc = Arc::clone(&state.running);
            let rx_counter = Arc::clone(&state.rx_bytes);
            let tcp_client_arc = Arc::clone(&state.tcp_client);
            let start_time = state.start_time;
            let config_arc = Arc::clone(&state.config);
            let app_clone = app.clone();

            let handle = std::thread::spawn(move || {
                let mut line_buf = String::new();
                let mut raw_buf = Vec::<u8>::new();
                let mut byte_buf = [0u8; 4096];
                const MAX_LINE_LEN: usize = 65536;
                const MAX_RECONNECT_ATTEMPTS: u32 = 15;
                const RECONNECT_DELAY_MS: u64 = 2000;

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

                    match stream_clone.read(&mut byte_buf) {
                        Ok(0) => {
                            // 备注：服务端断开 — 尝试自动重连
                            let target = {
                                match config_arc.lock() {
                                    Ok(c) => format!("{}:{}", c.tcp_client_ip, c.tcp_client_port),
                                    Err(_) => break,
                                }
                            };
                            let _ = app_clone.emit("serial-reconnecting", &format!("服务器已断开，正在尝试重连 {}...", target));

                            let mut reconnected = false;
                            for attempt in 1..=MAX_RECONNECT_ATTEMPTS {
                                {
                                    let running = match running_arc.lock() {
                                        Ok(guard) => guard,
                                        Err(_) => break,
                                    };
                                    if !*running { break; }
                                }
                                std::thread::sleep(Duration::from_millis(RECONNECT_DELAY_MS));

                                match std::net::TcpStream::connect(&target) {
                                    Ok(new_stream) => {
                                        let _ = new_stream.set_read_timeout(Some(Duration::from_millis(100)));
                                        stream_clone = match new_stream.try_clone() {
                                            Ok(s) => s,
                                            Err(_) => continue,
                                        };
                                        // 更新共享 tcp_client
                                        if let Ok(mut tcp_lock) = tcp_client_arc.lock() {
                                            *tcp_lock = Some(new_stream);
                                        }
                                        line_buf.clear();
                                        raw_buf.clear();
                                        let _ = app_clone.emit("serial-reconnected", &format!("已成功重连到 {} (第 {} 次尝试)", target, attempt));
                                        reconnected = true;
                                        break;
                                    }
                                    Err(_) => {
                                        let _ = app_clone.emit("serial-reconnecting", &format!("重连尝试 {}/{} 失败，{}秒后重试...", attempt, MAX_RECONNECT_ATTEMPTS, RECONNECT_DELAY_MS / 1000));
                                    }
                                }
                            }
                            if !reconnected {
                                let _ = app_clone.emit("serial-error", &format!("重连失败：已达到最大重试次数 ({})", MAX_RECONNECT_ATTEMPTS));
                                break;
                            }
                        }
                        Ok(n) => {
                            let data = byte_buf[..n].to_vec();
                            rx_counter.fetch_add(n as u64, Ordering::Relaxed);

                            let hex_str: String = data
                                .iter()
                                .map(|b| format!("{:02X}", b))
                                .collect::<Vec<_>>()
                                .join(" ");
                            let ascii_str = String::from_utf8_lossy(&data).to_string();

                            let terminal_data = TerminalData {
                                direction: "RX (TCP)".into(),
                                hex: hex_str,
                                ascii: ascii_str.clone(),
                                timestamp: chrono_now(),
                            };
                            let _ = app_clone.emit("serial-data", &terminal_data);

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
                                            let _ = app_clone.emit("waveform-data", &frame);
                                        }
                                    }
                                    raw_buf.drain(..pos + 4);
                                }
                            } else if protocol == "FireWater" {
                                line_buf.push_str(&ascii_str);
                                if line_buf.len() > MAX_LINE_LEN {
                                    line_buf.clear();
                                }
                                while let Some(pos) = line_buf.find('\n') {
                                    let line = line_buf[..pos].trim().to_string();
                                    line_buf = line_buf[pos + 1..].to_string();
                                    if !line.is_empty() {
                                        if let Some(frame) = parse_data_line(&line, start_time) {
                                            let _ = app_clone.emit("waveform-data", &frame);
                                        }
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            if e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::WouldBlock {
                                continue;
                            }
                            // 备注：非超时错误也尝试自动重连
                            let target = {
                                match config_arc.lock() {
                                    Ok(c) => format!("{}:{}", c.tcp_client_ip, c.tcp_client_port),
                                    Err(_) => break,
                                }
                            };
                            let _ = app_clone.emit("serial-reconnecting", &format!("TCP 错误: {e}，正在尝试重连..."));

                            let mut reconnected = false;
                            for attempt in 1..=MAX_RECONNECT_ATTEMPTS {
                                {
                                    let running = match running_arc.lock() {
                                        Ok(guard) => guard,
                                        Err(_) => break,
                                    };
                                    if !*running { break; }
                                }
                                std::thread::sleep(Duration::from_millis(RECONNECT_DELAY_MS));
                                match std::net::TcpStream::connect(&target) {
                                    Ok(new_stream) => {
                                        let _ = new_stream.set_read_timeout(Some(Duration::from_millis(100)));
                                        stream_clone = match new_stream.try_clone() {
                                            Ok(s) => s,
                                            Err(_) => continue,
                                        };
                                        if let Ok(mut tcp_lock) = tcp_client_arc.lock() {
                                            *tcp_lock = Some(new_stream);
                                        }
                                        line_buf.clear();
                                        raw_buf.clear();
                                        let _ = app_clone.emit("serial-reconnected", &format!("已成功重连到 {} (第 {} 次尝试)", target, attempt));
                                        reconnected = true;
                                        break;
                                    }
                                    Err(_) => {}
                                }
                            }
                            if !reconnected {
                                let _ = app_clone.emit("serial-error", &format!("重连失败：已达到最大重试次数 ({})", MAX_RECONNECT_ATTEMPTS));
                                break;
                            }
                        }
                    }
                }
            });

            {
                let mut thread_lock = lock_or_err!(state.read_thread, "read_thread");
                *thread_lock = Some(handle);
            }

            Ok(SerialStatus {
                connected: true,
                port_name: format!("TCP Client:{}", target_addr),
                baud_rate: 0,
                mode: "tcp_client".to_string(),
            })
        }
        "tcp_server" => {
            use std::net::TcpListener;
            let listener = TcpListener::bind(format!("0.0.0.0:{}", config.tcp_server_port))
                .map_err(|e| format!("绑定 TCP 监听端口 {} 失败: {e}", config.tcp_server_port))?;

            {
                let mut listener_lock = lock_or_err!(state.tcp_server_listener, "tcp_server_listener");
                *listener_lock = Some(listener.try_clone().map_err(|e| e.to_string())?);
                let mut config_lock = lock_or_err!(state.config, "config");
                *config_lock = config.clone();
                let mut running = lock_or_err!(state.running, "running");
                *running = true;
            }

            let listener_clone = listener.try_clone().map_err(|e| e.to_string())?;
            let running_arc = Arc::clone(&state.running);
            let clients_arc = Arc::clone(&state.tcp_server_clients);
            let rx_counter = Arc::clone(&state.rx_bytes);
            let start_time = state.start_time;
            let config_arc = Arc::clone(&state.config);
            let app_clone = app.clone();

            let accept_handle = std::thread::spawn(move || {
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

                    match listener_clone.accept() {
                        Ok((stream, addr)) => {
                            let client_addr = addr.to_string();

                            {
                                if let Ok(mut clients) = clients_arc.lock() {
                                    let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
                                    if let Ok(stream_clone) = stream.try_clone() {
                                        clients.push((client_addr.clone(), stream_clone));
                                    }
                                }
                            }

                            emit_clients_changed(&app_clone, &clients_arc);

                            let clients_arc_clone = Arc::clone(&clients_arc);
                            let running_arc_clone = Arc::clone(&running_arc);
                            let rx_counter_clone = Arc::clone(&rx_counter);
                            let config_arc_clone = Arc::clone(&config_arc);
                            let app_clone_2 = app_clone.clone();
                            let mut stream_clone = match stream.try_clone() {
                                Ok(s) => s,
                                Err(_) => continue,
                            };
                            let client_addr_clone = client_addr.clone();

                            std::thread::spawn(move || {
                                let mut line_buf = String::new();
                                let mut raw_buf = Vec::<u8>::new();
                                let mut byte_buf = [0u8; 4096];
                                const MAX_LINE_LEN: usize = 65536;

                                loop {
                                    {
                                        let running = match running_arc_clone.lock() {
                                            Ok(guard) => guard,
                                            Err(_) => break,
                                        };
                                        if !*running {
                                            break;
                                        }
                                    }

                                    match stream_clone.read(&mut byte_buf) {
                                        Ok(0) => break,
                                        Ok(n) => {
                                            let data = byte_buf[..n].to_vec();
                                            rx_counter_clone.fetch_add(n as u64, Ordering::Relaxed);

                                            let hex_str: String = data
                                                .iter()
                                                .map(|b| format!("{:02X}", b))
                                                .collect::<Vec<_>>()
                                                .join(" ");
                                            let ascii_str = String::from_utf8_lossy(&data).to_string();

                                            let terminal_data = TerminalData {
                                                direction: format!("RX (TCP Server: {})", client_addr_clone),
                                                hex: hex_str,
                                                ascii: ascii_str.clone(),
                                                timestamp: chrono_now(),
                                            };
                                            let _ = app_clone_2.emit("serial-data", &terminal_data);

                                            let protocol = {
                                                match config_arc_clone.lock() {
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
                                                            let _ = app_clone_2.emit("waveform-data", &frame);
                                                        }
                                                    }
                                                    raw_buf.drain(..pos + 4);
                                                }
                                            } else if protocol == "FireWater" {
                                                line_buf.push_str(&ascii_str);
                                                if line_buf.len() > MAX_LINE_LEN {
                                                    line_buf.clear();
                                                }
                                                while let Some(pos) = line_buf.find('\n') {
                                                    let line = line_buf[..pos].trim().to_string();
                                                    line_buf = line_buf[pos + 1..].to_string();
                                                    if !line.is_empty() {
                                                        if let Some(frame) = parse_data_line(&line, start_time) {
                                                            let _ = app_clone_2.emit("waveform-data", &frame);
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        Err(e) => {
                                            if e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::WouldBlock {
                                                continue;
                                            }
                                            break;
                                        }
                                    }
                                }

                                {
                                    if let Ok(mut clients) = clients_arc_clone.lock() {
                                        clients.retain(|(addr, _)| addr != &client_addr_clone);
                                    }
                                }
                                emit_clients_changed(&app_clone_2, &clients_arc_clone);
                            });
                        }
                        Err(_) => {
                            let running = match running_arc.lock() {
                                Ok(guard) => *guard,
                                Err(_) => false,
                            };
                            if !running {
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(50));
                        }
                    }
                }
            });

            {
                let mut thread_lock = lock_or_err!(state.tcp_accept_thread, "tcp_accept_thread");
                *thread_lock = Some(accept_handle);
            }

            Ok(SerialStatus {
                connected: true,
                port_name: format!("TCP Server:{}", config.tcp_server_port),
                baud_rate: 0,
                mode: "tcp_server".to_string(),
            })
        }
        _ => Err("不支持的数据传输方式".into()),
    }
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
fn close_port(state: tauri::State<AppState>, app: tauri::AppHandle) -> Result<(), String> {
    // 备注：先停止 Modbus 轮询
    {
        let mut polling = lock_or_err!(state.modbus_polling, "modbus_polling");
        *polling = false;
    }
    {
        let mut thread = lock_or_err!(state.modbus_poll_thread, "modbus_poll_thread");
        if let Some(handle) = thread.take() {
            let _ = handle.join();
        }
    }

    // 备注：先设置 running 标志为 false，停止读取循环
    {
        let mut running = lock_or_err!(state.running, "running");
        *running = false;
    }

    // 备注：释放和关闭所有的端口/套接字，这会立即解除所有读取线程/监听线程的阻塞状态
    // Close and drop Serial
    {
        let mut port_lock = lock_or_err!(state.port, "port");
        *port_lock = None;
    }

    // Close and drop UDP Socket
    {
        let mut udp_lock = lock_or_err!(state.udp_socket, "udp_socket");
        *udp_lock = None;
    }

    // Close and drop TCP Client
    {
        let mut tcp_client_lock = lock_or_err!(state.tcp_client, "tcp_client");
        if let Some(stream) = tcp_client_lock.take() {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }

    // Close and drop TCP Server
    {
        let mut listener_lock = lock_or_err!(state.tcp_server_listener, "tcp_server_listener");
        *listener_lock = None;
    }

    // Shutdown and clear TCP Server client streams
    {
        let mut clients_lock = lock_or_err!(state.tcp_server_clients, "tcp_server_clients");
        for (_, stream) in clients_lock.drain(..) {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }

    // 备注：在所有阻塞操作解除后，再 join 线程，这会立即返回而不会引起界面卡死
    {
        let mut thread_lock = lock_or_err!(state.read_thread, "read_thread");
        if let Some(handle) = thread_lock.take() {
            let _ = handle.join();
        }
    }
    {
        let mut thread_lock = lock_or_err!(state.tcp_accept_thread, "tcp_accept_thread");
        if let Some(handle) = thread_lock.take() {
            let _ = handle.join();
        }
    }

    // Emit clients changed event to clear frontend
    let _ = app.emit("tcp-clients-changed", &Vec::<String>::new());

    // Reset byte counters
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
    let config_lock = lock_or_err!(state.config, "config");
    let mode = config_lock.mode.clone();

    let connected = match mode.as_str() {
        "serial" => {
            let port_lock = lock_or_err!(state.port, "port");
            port_lock.is_some()
        }
        "udp" => {
            let udp_lock = lock_or_err!(state.udp_socket, "udp_socket");
            udp_lock.is_some()
        }
        "tcp_client" => {
            let tcp_client_lock = lock_or_err!(state.tcp_client, "tcp_client");
            tcp_client_lock.is_some()
        }
        "tcp_server" => {
            let listener_lock = lock_or_err!(state.tcp_server_listener, "tcp_server_listener");
            listener_lock.is_some()
        }
        _ => false,
    };

    let display_name = match mode.as_str() {
        "serial" => config_lock.port_name.clone(),
        "udp" => format!("UDP:{}", config_lock.udp_local_port),
        "tcp_client" => format!("TCP Client:{}:{}", config_lock.tcp_client_ip, config_lock.tcp_client_port),
        "tcp_server" => format!("TCP Server:{}", config_lock.tcp_server_port),
        _ => "未连接".to_string(),
    };

    Ok(SerialStatus {
        connected,
        port_name: display_name,
        baud_rate: if mode == "serial" { config_lock.baud_rate } else { 0 },
        mode,
    })
}

#[tauri::command]
fn send_data(
    state: tauri::State<AppState>,
    data: Vec<u8>,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    let mode = {
        let config = lock_or_err!(state.config, "config");
        config.mode.clone()
    };

    let n = match mode.as_str() {
        "serial" => {
            let mut port_lock = lock_or_err!(state.port, "port");
            match port_lock.as_mut() {
                Some(port) => port.write(&data).map_err(|e| format!("发送失败: {e}"))?,
                None => return Err("串口未连接".into()),
            }
        }
        "udp" => {
            let udp_lock = lock_or_err!(state.udp_socket, "udp_socket");
            match udp_lock.as_ref() {
                Some(socket) => {
                    let (remote_ip, remote_port) = {
                        let config = lock_or_err!(state.config, "config");
                        (config.udp_remote_ip.clone(), config.udp_remote_port)
                    };
                    socket.send_to(&data, format!("{}:{}", remote_ip, remote_port)).map_err(|e| format!("UDP 发送失败: {e}"))?
                }
                None => return Err("UDP 接口未启动".into()),
            }
        }
        "tcp_client" => {
            let mut tcp_client_lock = lock_or_err!(state.tcp_client, "tcp_client");
            match tcp_client_lock.as_mut() {
                Some(stream) => {
                    stream.write_all(&data).map_err(|e| format!("TCP 发送失败: {e}"))?;
                    data.len()
                }
                None => return Err("TCP 客户端未连接".into()),
            }
        }
        "tcp_server" => {
            let selected_client = {
                let selected = lock_or_err!(state.selected_tcp_client, "selected_tcp_client");
                selected.clone()
            };

            let mut clients_lock = lock_or_err!(state.tcp_server_clients, "tcp_server_clients");
            if clients_lock.is_empty() {
                return Err("没有已连接的客户端".into());
            }

            if let Some(target) = selected_client {
                if target == "all" || target.is_empty() {
                    let mut sent = 0;
                    for (_, stream) in clients_lock.iter_mut() {
                        if stream.write_all(&data).is_ok() {
                            sent = data.len();
                        }
                    }
                    sent
                } else {
                    if let Some((_, stream)) = clients_lock.iter_mut().find(|(addr, _)| addr == &target) {
                        stream.write_all(&data).map_err(|e| format!("发送到客户端失败: {e}"))?;
                        data.len()
                    } else {
                        return Err(format!("未找到指定的客户端: {}", target));
                    }
                }
            } else {
                let mut sent = 0;
                for (_, stream) in clients_lock.iter_mut() {
                    if stream.write_all(&data).is_ok() {
                        sent = data.len();
                    }
                }
                sent
            }
        }
        _ => return Err("未知的数据接口类型".into()),
    };

    state.tx_bytes.fetch_add(n as u64, std::sync::atomic::Ordering::Relaxed);
    let hex_str: String = data
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(" ");
    
    let direction_prefix = match mode.as_str() {
        "serial" => "TX".to_string(),
        "udp" => "TX (UDP)".to_string(),
        "tcp_client" => "TX (TCP Client)".to_string(),
        "tcp_server" => {
            let selected = lock_or_err!(state.selected_tcp_client, "selected_tcp_client");
            format!("TX (TCP Server -> {})", selected.as_deref().unwrap_or("All"))
        }
        _ => "TX".to_string(),
    };

    let terminal_data = TerminalData {
        direction: direction_prefix,
        hex: hex_str,
        ascii: String::from_utf8_lossy(&data).to_string(),
        timestamp: chrono_now(),
    };
    let _ = app.emit("serial-data", &terminal_data);
    Ok(n)
}

#[tauri::command]
fn get_tcp_connections(state: tauri::State<AppState>) -> Result<Vec<String>, String> {
    let clients = lock_or_err!(state.tcp_server_clients, "tcp_server_clients");
    Ok(clients.iter().map(|(addr, _)| addr.clone()).collect())
}

#[tauri::command]
fn set_active_tcp_client(state: tauri::State<AppState>, client_addr: Option<String>) -> Result<(), String> {
    let mut selected = lock_or_err!(state.selected_tcp_client, "selected_tcp_client");
    *selected = client_addr;
    Ok(())
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

// ============== Modbus 后端轮询系统 ==============

fn modbus_send_and_receive(
    port: &Arc<Mutex<Option<Box<dyn SerialPort>>>>,
    udp_socket: &Arc<Mutex<Option<std::net::UdpSocket>>>,
    tcp_client: &Arc<Mutex<Option<std::net::TcpStream>>>,
    tcp_server_clients: &Arc<Mutex<Vec<(String, std::net::TcpStream)>>>,
    selected_tcp_client: &Arc<Mutex<Option<String>>>,
    config: &Arc<Mutex<SerialConfig>>,
    tx_bytes: &Arc<AtomicU64>,
    frame: &[u8],
    timeout_ms: u64,
) -> Result<Vec<u8>, String> {
    let mode = {
        match config.lock() {
            Ok(c) => c.mode.clone(),
            Err(e) => return Err(format!("config lock: {e}")),
        }
    };

    // 发送
    match mode.as_str() {
        "serial" => {
            let mut port_lock = port.lock().map_err(|e| format!("port lock: {e}"))?;
            match port_lock.as_mut() {
                Some(p) => { p.write_all(frame).map_err(|e| format!("serial write: {e}"))?; }
                None => return Err("串口未连接".into()),
            }
        }
        "udp" => {
            let udp_lock = udp_socket.lock().map_err(|e| format!("udp lock: {e}"))?;
            match udp_lock.as_ref() {
                Some(socket) => {
                    let (remote_ip, remote_port) = {
                        let c = config.lock().map_err(|e| format!("config lock: {e}"))?;
                        (c.udp_remote_ip.clone(), c.udp_remote_port)
                    };
                    socket.send_to(frame, format!("{}:{}", remote_ip, remote_port))
                        .map_err(|e| format!("udp send: {e}"))?;
                }
                None => return Err("UDP 未连接".into()),
            }
        }
        "tcp_client" => {
            let mut tcp_lock = tcp_client.lock().map_err(|e| format!("tcp lock: {e}"))?;
            match tcp_lock.as_mut() {
                Some(stream) => { stream.write_all(frame).map_err(|e| format!("tcp write: {e}"))?; }
                None => return Err("TCP 客户端未连接".into()),
            }
        }
        "tcp_server" => {
            let sel = {
                let s = selected_tcp_client.lock().map_err(|e| format!("sel lock: {e}"))?;
                s.clone()
            };
            let mut clients = tcp_server_clients.lock().map_err(|e| format!("clients lock: {e}"))?;
            if clients.is_empty() {
                return Err("没有已连接的客户端".into());
            }
            if let Some(ref target) = sel {
                if target == "all" || target.is_empty() {
                    for (_, stream) in clients.iter_mut() {
                        let _ = stream.write_all(frame);
                    }
                } else {
                    if let Some((_, stream)) = clients.iter_mut().find(|(addr, _)| addr == target) {
                        stream.write_all(frame).map_err(|e| format!("tcp server write: {e}"))?;
                    }
                }
            } else {
                for (_, stream) in clients.iter_mut() {
                    let _ = stream.write_all(frame);
                }
            }
        }
        _ => return Err("不支持的接口".into()),
    }
    tx_bytes.fetch_add(frame.len() as u64, Ordering::Relaxed);

    // 接收 — 阻塞读取直到拿到完整帧或超时
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut rx_buf = Vec::<u8>::new();
    let mut tmp = [0u8; 256];

    loop {
        if Instant::now() >= deadline {
            return Err("超时无应答".into());
        }
        let remaining = deadline.duration_since(Instant::now());
        let read_result = match mode.as_str() {
            "serial" => {
                let mut port_lock = port.lock().map_err(|e| format!("port lock: {e}"))?;
                match port_lock.as_mut() {
                    Some(p) => {
                        let _ = p.set_timeout(remaining.min(Duration::from_millis(50)));
                        match p.read(&mut tmp) {
                            Ok(n) => Ok(n),
                            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => Ok(0),
                            Err(e) => Err(e.to_string()),
                        }
                    }
                    None => Err("disconnected".into()),
                }
            }
            "udp" => {
                let udp_lock = udp_socket.lock().map_err(|e| format!("udp lock: {e}"))?;
                match udp_lock.as_ref() {
                    Some(socket) => {
                        let _ = socket.set_read_timeout(Some(remaining.min(Duration::from_millis(50))));
                        match socket.recv(&mut tmp) {
                            Ok(n) => Ok(n),
                            Err(_) => Ok(0),
                        }
                    }
                    None => Err("disconnected".into()),
                }
            }
            "tcp_client" => {
                let mut tcp_lock = tcp_client.lock().map_err(|e| format!("tcp lock: {e}"))?;
                match tcp_lock.as_mut() {
                    Some(stream) => {
                        let _ = stream.set_read_timeout(Some(remaining.min(Duration::from_millis(50))));
                        match stream.read(&mut tmp) {
                            Ok(n) => Ok(n),
                            Err(e) if e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::WouldBlock => Ok(0),
                            Err(e) => Err(e.to_string()),
                        }
                    }
                    None => Err("disconnected".into()),
                }
            }
            _ => Err("unsupported".into()),
        };

        match read_result {
            Ok(0) => {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
            Ok(n) => {
                rx_buf.extend_from_slice(&tmp[..n]);
                // 检查是否收到完整 Modbus 响应帧
                if rx_buf.len() >= 5 {
                    let fc = rx_buf[1];
                    if fc & 0x80 != 0 {
                        // 异常响应 = 5 bytes
                        if rx_buf.len() >= 5 { return Ok(rx_buf); }
                    } else if rx_buf.len() >= 3 {
                        let byte_count = rx_buf[2] as usize;
                        let expected = 5 + byte_count; // slave + fc + count + data + crc(2)
                        if rx_buf.len() >= expected {
                            return Ok(rx_buf[..expected].to_vec());
                        }
                    }
                }
            }
            Err(e) => return Err(e),
        }
    }
}

fn decode_modbus_value(data: &[u8], data_type: &str, byte_order: &str) -> String {
    if data_type == "bool" {
        return if data.len() > 0 && (data[0] & 0x01) != 0 { "ON".into() } else { "OFF".into() };
    }
    if data_type == "int16" || data_type == "uint16" {
        if data.len() < 2 { return "-".into(); }
        let val = ((data[0] as u16) << 8) | (data[1] as u16);
        return if data_type == "int16" { (val as i16).to_string() } else { val.to_string() };
    }
    // 32-bit types
    if data.len() < 4 { return "-".into(); }
    let swapped: [u8; 4] = match byte_order {
        "CDAB" => [data[2], data[3], data[0], data[1]],
        "BADC" => [data[1], data[0], data[3], data[2]],
        "DCBA" => [data[3], data[2], data[1], data[0]],
        _ /* ABCD */ => [data[0], data[1], data[2], data[3]],
    };
    match data_type {
        "int32" => i32::from_be_bytes(swapped).to_string(),
        "uint32" => u32::from_be_bytes(swapped).to_string(),
        "float32" => {
            let val = f32::from_be_bytes(swapped);
            if val.is_nan() { "NaN".into() }
            else if val.is_infinite() { "Infinity".into() }
            else { format!("{:.4}", val).trim_end_matches('0').trim_end_matches('.').to_string() }
        }
        _ => "-".into(),
    }
}

#[tauri::command]
fn start_modbus_poll(
    state: tauri::State<AppState>,
    registers: Vec<ModbusRegisterConfig>,
    interval: u64,
    byte_order: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // 停止已有轮询
    {
        let mut polling = lock_or_err!(state.modbus_polling, "modbus_polling");
        *polling = false;
    }
    {
        let mut thread = lock_or_err!(state.modbus_poll_thread, "modbus_poll_thread");
        if let Some(handle) = thread.take() {
            let _ = handle.join();
        }
    }

    // 启动新轮询
    let polling_flag = Arc::clone(&state.modbus_polling);
    let running_flag = Arc::clone(&state.running);
    let port_arc = Arc::clone(&state.port);
    let udp_arc = Arc::clone(&state.udp_socket);
    let tcp_client_arc = Arc::clone(&state.tcp_client);
    let tcp_server_clients_arc = Arc::clone(&state.tcp_server_clients);
    let selected_tcp_arc = Arc::clone(&state.selected_tcp_client);
    let config_arc = Arc::clone(&state.config);
    let tx_bytes = Arc::clone(&state.tx_bytes);
    let rx_bytes = Arc::clone(&state.rx_bytes);

    {
        let mut polling = lock_or_err!(state.modbus_polling, "modbus_polling");
        *polling = true;
    }

    let regs = registers;
    let interval_ms = interval.max(50);
    let app_clone = app.clone();

    let handle = std::thread::spawn(move || {
        loop {
            // 检查是否停止
            {
                let polling = match polling_flag.lock() {
                    Ok(g) => *g,
                    Err(_) => break,
                };
                if !polling { break; }

                let running = match running_flag.lock() {
                    Ok(g) => *g,
                    Err(_) => break,
                };
                if !running { break; }
            }

            let enabled_regs: Vec<&ModbusRegisterConfig> = regs.iter().filter(|r| r.enabled).collect();
            if enabled_regs.is_empty() {
                std::thread::sleep(Duration::from_millis(interval_ms));
                continue;
            }

            let mut results = Vec::<ModbusRegisterResult>::new();

            for reg in &enabled_regs {
                // 再次检查停止标志
                {
                    let polling = match polling_flag.lock() {
                        Ok(g) => *g,
                        Err(_) => break,
                    };
                    if !polling { break; }
                }

                // 构建 RTU 帧
                let mut frame = vec![reg.slave_id, reg.function_code];
                frame.push((reg.address >> 8) as u8);
                frame.push((reg.address & 0xFF) as u8);
                frame.push((reg.count >> 8) as u8);
                frame.push((reg.count & 0xFF) as u8);
                let crc = modbus_crc16(&frame);
                frame.push((crc & 0xFF) as u8);
                frame.push((crc >> 8) as u8);

                match modbus_send_and_receive(
                    &port_arc, &udp_arc, &tcp_client_arc,
                    &tcp_server_clients_arc, &selected_tcp_arc,
                    &config_arc, &tx_bytes,
                    &frame, 300,
                ) {
                    Ok(response) => {
                        rx_bytes.fetch_add(response.len() as u64, Ordering::Relaxed);
                        if response.len() >= 5 {
                            let fc = response[1];
                            if fc & 0x80 != 0 {
                                let exc = if response.len() > 2 { format!("0x{:02X}", response[2]) } else { "未知".into() };
                                results.push(ModbusRegisterResult {
                                    id: reg.id.clone(),
                                    value: format!("异常码: {}", exc),
                                    status: "error".into(),
                                    last_updated: chrono_now(),
                                });
                            } else {
                                // CRC 校验
                                let data_len = response.len();
                                let received_crc = (response[data_len - 1] as u16) << 8 | (response[data_len - 2] as u16);
                                let calculated_crc = modbus_crc16(&response[..data_len - 2]);
                                if received_crc == calculated_crc {
                                    let payload = &response[3..data_len - 2];
                                    let val = decode_modbus_value(payload, &reg.data_type, &byte_order);
                                    results.push(ModbusRegisterResult {
                                        id: reg.id.clone(),
                                        value: val,
                                        status: "success".into(),
                                        last_updated: chrono_now(),
                                    });
                                } else {
                                    results.push(ModbusRegisterResult {
                                        id: reg.id.clone(),
                                        value: "CRC 校验失败".into(),
                                        status: "error".into(),
                                        last_updated: chrono_now(),
                                    });
                                }
                            }
                        } else {
                            results.push(ModbusRegisterResult {
                                id: reg.id.clone(),
                                value: "响应数据不完整".into(),
                                status: "error".into(),
                                last_updated: chrono_now(),
                            });
                        }
                    }
                    Err(e) => {
                        results.push(ModbusRegisterResult {
                            id: reg.id.clone(),
                            value: e,
                            status: "error".into(),
                            last_updated: chrono_now(),
                        });
                    }
                }

                // 帧间安全间隔
                std::thread::sleep(Duration::from_millis(50));
            }

            // 批量发送结果到前端
            if !results.is_empty() {
                let _ = app_clone.emit("modbus-poll-result", &results);
            }

            // 轮询间隔
            let delay = if interval_ms > 50 * enabled_regs.len() as u64 {
                interval_ms - 50 * enabled_regs.len() as u64
            } else {
                0
            };
            if delay > 0 {
                std::thread::sleep(Duration::from_millis(delay));
            }
        }
    });

    {
        let mut thread = lock_or_err!(state.modbus_poll_thread, "modbus_poll_thread");
        *thread = Some(handle);
    }

    Ok(())
}

#[tauri::command]
fn stop_modbus_poll(state: tauri::State<AppState>) -> Result<(), String> {
    {
        let mut polling = lock_or_err!(state.modbus_polling, "modbus_polling");
        *polling = false;
    }
    {
        let mut thread = lock_or_err!(state.modbus_poll_thread, "modbus_poll_thread");
        if let Some(handle) = thread.take() {
            let _ = handle.join();
        }
    }
    Ok(())
}

#[tauri::command]
fn write_modbus_register(
    state: tauri::State<AppState>,
    slave_id: u8,
    function_code: u8,
    register_addr: u16,
    data: Vec<u8>,
) -> Result<Vec<u8>, String> {
    // 构建写入帧
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

    // 发送并等待响应
    modbus_send_and_receive(
        &state.port, &state.udp_socket, &state.tcp_client,
        &state.tcp_server_clients, &state.selected_tcp_client,
        &state.config, &state.tx_bytes,
        &frame, 600,
    )
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
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::DECORATIONS,
                )
                .build(),
        )
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
            get_tcp_connections,
            set_active_tcp_client,
            start_modbus_poll,
            stop_modbus_poll,
            write_modbus_register,
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
