import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { WaveformPanel } from "./components/WaveformPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import type { AppConfig, ViewMode } from "./types/config";
import { DEFAULT_CONFIG } from "./types/config";
import { applyTheme, watchSystemTheme } from "./utils/theme";
import "./App.css";

interface SerialConfig {
  port_name: string;
  baud_rate: number;
  data_bits: number;
  stop_bits: number;
  parity: string;
}

interface SerialStatus {
  connected: boolean;
  port_name: string;
  baud_rate: number;
}

interface TerminalData {
  direction: string;
  hex: string;
  ascii: string;
  timestamp: string;
}

interface DataFrame {
  timestamp: number;
  values: number[];
  raw: string;
}

interface LogEntry {
  id: number;
  timestamp: string;
  direction: string;
  data: string;
}

const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 74800, 115200, 230400, 460800, 500000, 576000, 921600, 1000000, 1152000, 1500000, 2000000, 2500000, 3000000, 3500000, 4000000];
const DATA_BITS = [5, 6, 7, 8];
const STOP_BITS = [1, 2];
const PARITIES = ["none", "odd", "even"];

function App() {
  const { t } = useTranslation();

  // 备注：设置状态
  const [config, setConfig] = useState<AppConfig>(() => {
    const saved = localStorage.getItem("app-config");
    return saved ? { ...DEFAULT_CONFIG, ...JSON.parse(saved) } : DEFAULT_CONFIG;
  });
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 备注：串口状态
  const [ports, setPorts] = useState<string[]>([]);
  const [serialConfig, setSerialConfig] = useState<SerialConfig>({
    port_name: "",
    baud_rate: 115200,
    data_bits: 8,
    stop_bits: 1,
    parity: "none",
  });
  const [status, setStatus] = useState<SerialStatus>({
    connected: false,
    port_name: "",
    baud_rate: 0,
  });

  // 备注：视图模式
  const [viewMode, setViewMode] = useState<ViewMode>(config.defaultViewMode);

  // 备注：收发
  const [sendMode, setSendMode] = useState<"ascii" | "hex">("ascii");
  const [showHex, setShowHex] = useState(false);
  const [sendData, setSendData] = useState("");
  const [autoSend, setAutoSend] = useState(false);
  const [autoSendInterval, setAutoSendInterval] = useState(1000);
  const [lineEnding, setLineEnding] = useState<"none" | "LF" | "CR" | "CRLF" | "LFCR">("none");
  const [sendHistory, setSendHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const sendHistoryLimit = 20;

  // 备注：日志
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logIdRef = useRef(0);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // 备注：波形数据
  const [waveformFrame, setWaveformFrame] = useState<DataFrame | null>(null);

  // 备注：Modbus
  const [modbusSlaveId, setModbusSlaveId] = useState(1);
  const [modbusFunction, setModbusFunction] = useState(3);
  const [modbusRegister, setModbusRegister] = useState(0);
  const [modbusCount, setModbusCount] = useState(1);

  const autoSendTimerRef = useRef<number | null>(null);

  // 备注：保存设置
  const handleSettingsChange = useCallback((nextConfig: AppConfig) => {
    setConfig(nextConfig);
    localStorage.setItem("app-config", JSON.stringify(nextConfig));
    applyTheme(nextConfig.theme);
    watchSystemTheme(nextConfig.theme);
    setViewMode(nextConfig.defaultViewMode);
  }, []);

  // 备注：添加日志
  const addLog = useCallback((direction: string, data: string) => {
    const id = ++logIdRef.current;
    const timestamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    setLogs((prev) => [...prev.slice(-1999), { id, timestamp, direction, data }]);
  }, []);

  // 备注：监听串口数据事件
  useEffect(() => {
    const unlisten1 = listen<TerminalData>("serial-data", (event) => {
      const d = event.payload;
      const display = showHex ? d.hex : d.ascii;
      addLog(d.direction, `[${d.timestamp}] ${display}`);
    });

    const unlisten2 = listen<DataFrame>("waveform-data", (event) => {
      setWaveformFrame(event.payload);
    });

    return () => {
      void unlisten1.then((fn) => fn());
      void unlisten2.then((fn) => fn());
    };
  }, [showHex, addLog]);

  // 备注：刷新串口列表
  const refreshPorts = useCallback(async () => {
    try {
      const portList = await invoke<string[]>("list_ports");
      setPorts(portList);
      if (portList.length > 0 && !serialConfig.port_name) {
        setSerialConfig((prev) => ({ ...prev, port_name: portList[0] }));
      }
    } catch (e) {
      addLog("ERROR", `${t("serial.refresh", { defaultValue: "刷新串口失败" })}: ${e}`);
    }
  }, [serialConfig.port_name, addLog, t]);

  // 备注：打开/关闭串口
  const togglePort = useCallback(async () => {
    if (status.connected) {
      try {
        await invoke("close_port");
        setStatus({ connected: false, port_name: "", baud_rate: 0 });
        addLog("INFO", t("status.disconnected", { defaultValue: "串口已关闭" }));
      } catch (e) {
        addLog("ERROR", `${e}`);
      }
    } else {
      try {
        const result = await invoke<SerialStatus>("open_port", { config: serialConfig });
        setStatus(result);
        addLog("INFO", `${t("status.connected", { defaultValue: "已连接" })}: ${serialConfig.port_name} @ ${serialConfig.baud_rate}`);
      } catch (e) {
        addLog("ERROR", `${e}`);
      }
    }
  }, [status.connected, serialConfig, addLog, t]);

  // 备注：发送数据
  const handleSend = useCallback(async () => {
    if (!status.connected || !sendData.trim()) return;
    try {
      let bytes: number[];
      if (sendMode === "hex") {
        const hexStr = sendData.replace(/\s+/g, "");
        if (hexStr.length % 2 !== 0) {
          addLog("ERROR", "HEX");
          return;
        }
        bytes = [];
        for (let i = 0; i < hexStr.length; i += 2) {
          bytes.push(parseInt(hexStr.substring(i, i + 2), 16));
        }
      } else {
        bytes = Array.from(new TextEncoder().encode(sendData));
      }

      // 备注：追加行尾
      const lineEndingBytes: Record<string, number[]> = {
        none: [],
        LF: [0x0A],
        CR: [0x0D],
        CRLF: [0x0D, 0x0A],
        LFCR: [0x0A, 0x0D],
      };
      const extra = lineEndingBytes[lineEnding] ?? [];
      if (extra.length > 0) {
        bytes = [...bytes, ...extra];
      }

      await invoke("send_data", { data: bytes });

      // 备注：保存到发送历史
      setSendHistory((prev) => {
        const filtered = prev.filter((item) => item !== sendData);
        return [sendData, ...filtered].slice(0, sendHistoryLimit);
      });
    } catch (e) {
      addLog("ERROR", `${e}`);
    }
  }, [status.connected, sendData, sendMode, lineEnding, addLog]);

  // 备注：Modbus 发送
  const handleModbusSend = useCallback(async () => {
    if (!status.connected) return;
    try {
      const frame = await invoke<number[]>("build_modbus_rtu", {
        slaveId: modbusSlaveId,
        functionCode: modbusFunction,
        registerAddr: modbusRegister,
        registerCount: modbusCount,
      });
      await invoke("send_data", { data: frame });
    } catch (e) {
      addLog("ERROR", `${e}`);
    }
  }, [status.connected, modbusSlaveId, modbusFunction, modbusRegister, modbusCount, addLog]);

  // 备注：初始化
  const refreshPortsRef = useRef(refreshPorts);
  useEffect(() => {
    refreshPortsRef.current = refreshPorts;
  }, [refreshPorts]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshPortsRef.current();
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  // 备注：自动发送
  useEffect(() => {
    if (autoSend && status.connected) {
      autoSendTimerRef.current = window.setInterval(handleSend, autoSendInterval);
    } else {
      if (autoSendTimerRef.current) {
        clearInterval(autoSendTimerRef.current);
        autoSendTimerRef.current = null;
      }
    }
    return () => {
      if (autoSendTimerRef.current) clearInterval(autoSendTimerRef.current);
    };
  }, [autoSend, status.connected, autoSendInterval, handleSend]);

  // 备注：自动滚动日志
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="app">
      {/* 备注：顶部工具栏 */}
      <header className="header">
        <div className="header-left">
          <h1>OxideSerial</h1>
          <span className={`status-indicator ${status.connected ? "connected" : ""}`}>
            {status.connected
              ? `${t("status.connected", { defaultValue: "已连接" })} ${status.port_name} @ ${status.baud_rate}`
              : t("status.disconnected", { defaultValue: "未连接" })}
          </span>
        </div>
        <div className="header-right">
          <div className="view-tabs">
            <button className={viewMode === "terminal" ? "active" : ""} onClick={() => setViewMode("terminal")}>
              {t("settings.view.terminal", { defaultValue: "终端" })}
            </button>
            <button className={viewMode === "waveform" ? "active" : ""} onClick={() => setViewMode("waveform")}>
              {t("settings.view.waveform", { defaultValue: "波形" })}
            </button>
            <button className={viewMode === "split" ? "active" : ""} onClick={() => setViewMode("split")}>
              {t("settings.view.split", { defaultValue: "分屏" })}
            </button>
          </div>
          <button className="btn-settings" onClick={() => setSettingsOpen(!settingsOpen)} title={t("settings.title", { defaultValue: "设置" })}>
            ⚙
          </button>
        </div>
      </header>

      <div className="main-layout">
        {/* 备注：设置面板 */}
        {settingsOpen && (
          <>
            <div className="settings-backdrop" onClick={() => setSettingsOpen(false)} />
            <SettingsPanel config={config} onChange={handleSettingsChange} onClose={() => setSettingsOpen(false)} />
          </>
        )}

        {/* 备注：左侧配置 */}
        <aside className="sidebar">
          <section className="panel">
            <h3>{t("serial.title", { defaultValue: "串口配置" })}</h3>
            <div className="form-group">
              <label>{t("serial.port", { defaultValue: "串口" })}</label>
              <div className="port-row">
                <select value={serialConfig.port_name} onChange={(e) => setSerialConfig({ ...serialConfig, port_name: e.target.value })}>
                  {ports.length === 0 && <option value="">{t("serial.noPorts", { defaultValue: "无可用串口" })}</option>}
                  {ports.map((p) => (<option key={p} value={p}>{p}</option>))}
                </select>
                <button onClick={refreshPorts} title={t("serial.refresh", { defaultValue: "刷新" })}>🔄</button>
              </div>
            </div>
            <div className="form-group">
              <label>{t("serial.baudRate", { defaultValue: "波特率" })}</label>
              <select value={serialConfig.baud_rate} onChange={(e) => setSerialConfig({ ...serialConfig, baud_rate: Number(e.target.value) })}>
                {BAUD_RATES.map((r) => (<option key={r} value={r}>{r}</option>))}
              </select>
            </div>
            <div className="form-row">
              <div className="form-group"><label>{t("serial.dataBits", { defaultValue: "数据位" })}</label>
                <select value={serialConfig.data_bits} onChange={(e) => setSerialConfig({ ...serialConfig, data_bits: Number(e.target.value) })}>
                  {DATA_BITS.map((d) => (<option key={d} value={d}>{d}</option>))}
                </select>
              </div>
              <div className="form-group"><label>{t("serial.stopBits", { defaultValue: "停止位" })}</label>
                <select value={serialConfig.stop_bits} onChange={(e) => setSerialConfig({ ...serialConfig, stop_bits: Number(e.target.value) })}>
                  {STOP_BITS.map((s) => (<option key={s} value={s}>{s}</option>))}
                </select>
              </div>
              <div className="form-group"><label>{t("serial.parity", { defaultValue: "校验" })}</label>
                <select value={serialConfig.parity} onChange={(e) => setSerialConfig({ ...serialConfig, parity: e.target.value })}>
                  {PARITIES.map((p) => (
                    <option key={p} value={p}>{t(`serial.parity${p.charAt(0).toUpperCase() + p.slice(1)}`, { defaultValue: p })}</option>
                  ))}
                </select>
              </div>
            </div>
            <button className={`btn-connect ${status.connected ? "disconnect" : ""}`} onClick={togglePort} disabled={!serialConfig.port_name}>
              {status.connected ? t("serial.disconnect", { defaultValue: "断开" }) : t("serial.connect", { defaultValue: "打开串口" })}
            </button>
          </section>

          <section className="panel">
            <h3>{t("modbus.title", { defaultValue: "Modbus RTU" })}</h3>
            <div className="form-row">
              <div className="form-group"><label>{t("modbus.slaveId", { defaultValue: "从站 ID" })}</label>
                <input type="number" min={1} max={247} value={modbusSlaveId} onChange={(e) => setModbusSlaveId(Number(e.target.value))} />
              </div>
              <div className="form-group"><label>{t("modbus.functionCode", { defaultValue: "功能码" })}</label>
                <select value={modbusFunction} onChange={(e) => setModbusFunction(Number(e.target.value))}>
                  <option value={1}>01</option>
                  <option value={2}>02</option>
                  <option value={3}>03</option>
                  <option value={4}>04</option>
                  <option value={5}>05</option>
                  <option value={6}>06</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group"><label>{t("modbus.startAddr", { defaultValue: "起始地址" })}</label>
                <input type="number" min={0} max={65535} value={modbusRegister} onChange={(e) => setModbusRegister(Number(e.target.value))} />
              </div>
              <div className="form-group"><label>{t("modbus.count", { defaultValue: "数量" })}</label>
                <input type="number" min={1} max={125} value={modbusCount} onChange={(e) => setModbusCount(Number(e.target.value))} />
              </div>
            </div>
            <button className="btn-modbus" onClick={handleModbusSend} disabled={!status.connected}>{t("modbus.send", { defaultValue: "发送 Modbus" })}</button>
          </section>
        </aside>

        {/* 备注：右侧内容区 - 始终挂载，用 CSS 控制显隐 */}
        <main className="content">
          <div style={{ display: viewMode === "terminal" ? "none" : "flex", flex: 1, minHeight: 0, minWidth: 0 }}>
            <WaveformPanel frame={waveformFrame} />
          </div>

          <section className="panel terminal-panel" style={{ display: viewMode === "waveform" ? "none" : "flex" }}>
              <div className="terminal-header">
                <h3>{t("terminal.title", { defaultValue: "终端" })}</h3>
                <div className="terminal-controls">
                  <label><input type="checkbox" checked={showHex} onChange={(e) => setShowHex(e.target.checked)} /> HEX</label>
                  <button onClick={() => setLogs([])}>{t("terminal.clear", { defaultValue: "清空" })}</button>
                </div>
              </div>
              <div className="log-container" ref={logContainerRef}>
                {logs.map((log) => (
                  <div key={log.id} className={`log-entry log-${log.direction.toLowerCase()}`}>
                    <span className="log-dir">{log.direction}</span>
                    <span className="log-data">{log.data}</span>
                  </div>
                ))}
              </div>
              <div className="send-area">
                <div className="send-controls">
                  <label><input type="radio" checked={sendMode === "ascii"} onChange={() => setSendMode("ascii")} /> ASCII</label>
                  <label><input type="radio" checked={sendMode === "hex"} onChange={() => setSendMode("hex")} /> HEX</label>
                  <label className="auto-send"><input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} /> {t("terminal.autoSend", { defaultValue: "自动" })}</label>
                  <input type="number" min={100} value={autoSendInterval} onChange={(e) => setAutoSendInterval(Number(e.target.value))} className="interval" />
                  <span>ms</span>
                </div>
                <div className="send-row">
                  <textarea
                    value={sendData}
                    onChange={(e) => setSendData(e.target.value)}
                    placeholder={sendMode === "hex" ? t("terminal.hexPlaceholder", { defaultValue: "01 03 00 00 00 01" }) : t("terminal.placeholder", { defaultValue: "输入文本" })}
                    onKeyDown={(e) => { if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); handleSend(); } }}
                  />
                  <div className="send-buttons">
                    <button className="btn-icon" onClick={() => setSendData("")} title="清空输入">✕</button>
                    <div className="history-wrapper">
                      <button className="btn-icon" onClick={() => setShowHistory(!showHistory)} title="发送记录">📋</button>
                      {showHistory && sendHistory.length > 0 && (
                        <div className="history-dropdown">
                          {sendHistory.map((item, index) => (
                            <div
                              key={index}
                              className="history-item"
                              onClick={() => { setSendData(item); setShowHistory(false); }}
                            >
                              {item.length > 40 ? item.slice(0, 40) + "..." : item}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <select
                      value={lineEnding}
                      onChange={(e) => setLineEnding(e.target.value as typeof lineEnding)}
                      className="line-ending-select"
                      title="行尾追加"
                    >
                      <option value="none">无</option>
                      <option value="LF">LF (\n)</option>
                      <option value="CR">CR (\r)</option>
                      <option value="CRLF">CRLF (\r\n)</option>
                      <option value="LFCR">LFCR (\n\r)</option>
                    </select>
                    <button className="btn-send" onClick={handleSend} disabled={!status.connected}>
                      {t("terminal.send", { defaultValue: "发送" })}
                    </button>
                  </div>
                </div>
              </div>
            </section>
        </main>
      </div>
    </div>
  );
}

export default App;
