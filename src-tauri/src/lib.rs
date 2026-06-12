use serde::{Deserialize, Serialize};
use serialport::SerialPort;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;

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
}

impl AppState {
    pub fn new() -> Self {
        Self {
            port: Arc::new(Mutex::new(None)),
            config: Arc::new(Mutex::new(SerialConfig::default())),
            running: Arc::new(Mutex::new(false)),
            start_time: Instant::now(),
        }
    }
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
        let mut port_lock = state.port.lock().unwrap();
        *port_lock = Some(port);
        let mut config_lock = state.config.lock().unwrap();
        *config_lock = config.clone();
        let mut running = state.running.lock().unwrap();
        *running = true;
    }

    // 备注：启动后台读取线程
    let port_arc = Arc::clone(&state.port);
    let running_arc = Arc::clone(&state.running);
    let start_time = state.start_time;

    std::thread::spawn(move || {
        let mut line_buf = String::new();
        let mut byte_buf = [0u8; 4096];

        loop {
            {
                let running = running_arc.lock().unwrap();
                if !*running {
                    break;
                }
            }

            let read_result = {
                let mut port_lock = port_arc.lock().unwrap();
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

fn chrono_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let ms = now.as_millis();
    let secs = (ms / 1000) % 86400;
    let hours = secs / 3600;
    let minutes = (secs % 3600) / 60;
    let seconds = secs % 60;
    let millis = ms % 1000;
    format!("{:02}:{:02}:{:02}.{:03}", hours, minutes, seconds, millis)
}

#[tauri::command]
fn close_port(state: tauri::State<AppState>) -> Result<(), String> {
    {
        let mut running = state.running.lock().unwrap();
        *running = false;
    }
    let mut port_lock = state.port.lock().unwrap();
    *port_lock = None;
    Ok(())
}

#[tauri::command]
fn get_status(state: tauri::State<AppState>) -> Result<SerialStatus, String> {
    let port_lock = state.port.lock().unwrap();
    let config_lock = state.config.lock().unwrap();
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
    let mut port_lock = state.port.lock().unwrap();
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

#[tauri::command]
fn read_data(state: tauri::State<AppState>) -> Result<Vec<u8>, String> {
    let mut port_lock = state.port.lock().unwrap();
    match port_lock.as_mut() {
        Some(port) => {
            let mut buf = [0u8; 1024];
            match port.read(&mut buf) {
                Ok(n) => Ok(buf[..n].to_vec()),
                Err(e) => {
                    if e.kind() == std::io::ErrorKind::TimedOut {
                        Ok(vec![])
                    } else {
                        Err(format!("读取失败: {e}"))
                    }
                }
            }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .plugin(tauri_plugin_log::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            list_ports,
            open_port,
            close_port,
            get_status,
            send_data,
            read_data,
            build_modbus_rtu,
            parse_modbus_rtu,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
