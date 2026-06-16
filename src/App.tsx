import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { WaveformPanel } from "./components/WaveformPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import type { SerialConfig, SerialStatus, TerminalData, DataFrame, LogEntry } from "./types/serial";
import type { AppConfig, ViewMode } from "./types/config";
import { DEFAULT_CONFIG, APP_VERSION } from "./types/config";
import { applyTheme, watchSystemTheme } from "./utils/theme";
import "./App.css";

const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 74800, 115200, 230400, 460800, 500000, 576000, 921600, 1000000, 1152000, 1500000, 2000000, 2500000, 3000000, 3500000, 4000000];
const DATA_BITS = [5, 6, 7, 8];
const STOP_BITS = [1, 2];
const PARITIES = ["none", "odd", "even"];

function App() {
  const { t } = useTranslation();

  // 备注：设置状态
  const [config, setConfig] = useState<AppConfig>(() => {
    try {
      const saved = localStorage.getItem("app-config");
      return saved ? { ...DEFAULT_CONFIG, ...JSON.parse(saved) } : DEFAULT_CONFIG;
    } catch {
      return DEFAULT_CONFIG;
    }
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
  const showHexRef = useRef(false);
  const [sendData, setSendData] = useState("");
  const sendDataRef = useRef("");

  // 备注：切换 ASCII/HEX 时自动转换输入框格式
  const handleSendModeChange = useCallback((mode: "ascii" | "hex") => {
    setSendData((prev) => {
      if (mode === "hex") {
        // ASCII → HEX：去除空格，每 2 字符加空格
        const raw = prev.replace(/\s/g, "");
        return raw.replace(/(.{2})/g, "$1 ").trim();
      } else {
        // HEX → ASCII：去除空格
        return prev.replace(/\s/g, "");
      }
    });
    setSendMode(mode);
  }, []);
  const [autoSend, setAutoSend] = useState(false);
  const [autoSendInterval, setAutoSendInterval] = useState(1000);
  const [lineEnding, setLineEnding] = useState<"none" | "LF" | "CR" | "CRLF" | "LFCR">("none");
  const lineEndingRef = useRef<"none" | "LF" | "CR" | "CRLF" | "LFCR">("none");
  const [sendHistory, setSendHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const sendHistoryLimit = 20;

  // 备注：日志
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logIdRef = useRef(0);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // M10: RX/TX 字节计数
  const [byteStats, setByteStats] = useState<[number, number]>([0, 0]);

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

  // 备注：添加日志（同时存储 hex 和 ascii，渲染时根据 showHex 切换）
  const addLog = useCallback((direction: string, hex: string, ascii: string) => {
    const id = ++logIdRef.current;
    const locale = config.locale || "zh-CN";
    const timestamp = new Date().toLocaleTimeString(locale, { hour12: false });
    setLogs((prev) => [...prev.slice(-1999), { id, timestamp, direction, data: "", hex, ascii }]);
  }, [config.locale]);

  // 备注：添加普通日志（非串口数据，如 INFO/ERROR）
  const addTextLog = useCallback((direction: string, text: string) => {
    const id = ++logIdRef.current;
    const locale = config.locale || "zh-CN";
    const timestamp = new Date().toLocaleTimeString(locale, { hour12: false });
    setLogs((prev) => [...prev.slice(-1999), { id, timestamp, direction, data: text, hex: "", ascii: text }]);
  }, [config.locale]);

  // 备注：监听串口数据事件（showHex 通过 ref 读取，避免重建监听器）
  useEffect(() => {
    const unlisten1 = listen<TerminalData>("serial-data", (event) => {
      const d = event.payload;
      addLog(d.direction, `[${d.timestamp}] ${d.hex}`, `[${d.timestamp}] ${d.ascii}`);
    });

    const unlisten2 = listen<DataFrame>("waveform-data", (event) => {
      setWaveformFrame(event.payload);
    });

    // R1: 监听串口断开事件
    const unlisten3 = listen<string>("serial-error", (event) => {
      addTextLog("ERROR", `串口错误: ${event.payload}`);
      setStatus({ connected: false, port_name: "", baud_rate: 0 });
      void invoke("close_port").catch(() => {});
    });

    return () => {
      void unlisten1.then((fn) => fn());
      void unlisten2.then((fn) => fn());
      void unlisten3.then((fn) => fn());
    };
  }, [addLog]);

  // M10: 定时轮询 RX/TX 字节统计
  useEffect(() => {
    if (!status.connected) {
      setByteStats([0, 0]);
      return;
    }
    const timer = setInterval(() => {
      invoke<[number, number]>("get_byte_stats").then((stats) => {
        setByteStats(stats);
      }).catch(() => {});
    }, 500);
    return () => clearInterval(timer);
  }, [status.connected]);

  // 备注：刷新串口列表
  const refreshPorts = useCallback(async () => {
    try {
      const portList = await invoke<string[]>("list_ports");
      setPorts(portList);
      if (portList.length > 0 && !serialConfig.port_name) {
        setSerialConfig((prev) => ({ ...prev, port_name: portList[0] }));
      }
    } catch (e) {
      addTextLog("ERROR", `${t("serial.refreshFail", { defaultValue: "刷新串口失败" })}: ${e}`);
    }
  }, [serialConfig.port_name, addLog, t]);

  // 备注：打开/关闭串口
  const togglePort = useCallback(async () => {
    if (status.connected) {
      try {
        await invoke("close_port");
        setStatus({ connected: false, port_name: "", baud_rate: 0 });
        addTextLog("INFO", t("serial.portClosed", { defaultValue: "串口已关闭" }));
      } catch (e) {
        addTextLog("ERROR", `${e}`);
      }
    } else {
      try {
        const result = await invoke<SerialStatus>("open_port", { config: serialConfig });
        setStatus(result);
        addTextLog("INFO", `${t("status.connected", { defaultValue: "已连接" })}: ${serialConfig.port_name} @ ${serialConfig.baud_rate}`);
      } catch (e) {
        addTextLog("ERROR", `${e}`);
      }
    }
  }, [status.connected, serialConfig, addLog, t]);

  // 备注：同步 refs（用于事件回调中读取最新值，避免重建监听器）
  useEffect(() => { showHexRef.current = showHex; }, [showHex]);
  useEffect(() => { sendDataRef.current = sendData; }, [sendData]);
  useEffect(() => { lineEndingRef.current = lineEnding; }, [lineEnding]);

  // 备注：发送数据（通过 ref 读取最新值，保证 auto-send interval 稳定）
  const handleSendRef = useRef<() => Promise<void>>(async () => {});
  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);
  const sendModeRef = useRef(sendMode);
  useEffect(() => { sendModeRef.current = sendMode; }, [sendMode]);

  handleSendRef.current = async () => {
    const currentStatus = statusRef.current;
    const currentSendData = sendDataRef.current;
    const currentSendMode = sendModeRef.current;
    const currentLineEnding = lineEndingRef.current;
    if (!currentStatus.connected || !currentSendData.trim()) return;
    try {
      let bytes: number[];
      if (currentSendMode === "hex") {
        const hexStr = currentSendData.replace(/\s+/g, "");
        // R3: 校验 HEX 输入合法性
        if (hexStr.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hexStr)) {
          addTextLog("ERROR", "HEX 格式错误：包含非法字符或长度为奇数");
          return;
        }
        bytes = [];
        for (let i = 0; i < hexStr.length; i += 2) {
          bytes.push(parseInt(hexStr.substring(i, i + 2), 16));
        }
      } else {
        bytes = Array.from(new TextEncoder().encode(currentSendData));
      }

      const lineEndingBytes: Record<string, number[]> = {
        none: [],
        LF: [0x0A],
        CR: [0x0D],
        CRLF: [0x0D, 0x0A],
        LFCR: [0x0A, 0x0D],
      };
      const extra = lineEndingBytes[currentLineEnding] ?? [];
      if (extra.length > 0) {
        bytes = [...bytes, ...extra];
      }

      await invoke("send_data", { data: bytes });

      setSendHistory((prev) => {
        const filtered = prev.filter((item) => item !== currentSendData);
        return [currentSendData, ...filtered].slice(0, sendHistoryLimit);
      });
    } catch (e) {
      addTextLog("ERROR", `${e}`);
    }
  };

  const handleSend = useCallback(() => { void handleSendRef.current(); }, []);

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
      addTextLog("ERROR", `${e}`);
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

  // U7: 导出终端日志
  const handleExportLog = useCallback(async () => {
    if (logs.length === 0) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filePath = await save({
        defaultPath: `log-${stamp}.txt`,
        filters: [{ name: "Text", extensions: ["txt", "log"] }],
      });
      if (!filePath) return;
      const content = logs.map((l) => `[${l.timestamp}] ${l.direction} ${l.data}`).join("\n");
      await writeTextFile(filePath, content);
    } catch (e) {
      addTextLog("ERROR", `导出失败: ${e}`);
    }
  }, [logs, addLog]);

  // 备注：自动发送（通过 ref 读取最新 send 逻辑，避免 interval 随输入重建）
  useEffect(() => {
    if (autoSend && status.connected) {
      autoSendTimerRef.current = window.setInterval(() => {
        void handleSendRef.current();
      }, autoSendInterval);
    } else {
      if (autoSendTimerRef.current) {
        clearInterval(autoSendTimerRef.current);
        autoSendTimerRef.current = null;
      }
    }
    return () => {
      if (autoSendTimerRef.current) clearInterval(autoSendTimerRef.current);
    };
  }, [autoSend, status.connected, autoSendInterval]);

  // 备注：自动滚动日志
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="app noise-bg">
      {/* 备注：顶部工具栏 */}
      <header className="header">
        <div className="header-left">
          <div className="app-logo-area">
            <h1>OxideSerial</h1>
            <span className="app-version">v{APP_VERSION}</span>
          </div>
          <span className={`status-indicator ${status.connected ? "connected" : ""}`}>
            {status.connected
              ? `${t("status.connected", { defaultValue: "已连接" })} ${status.port_name} @ ${status.baud_rate}`
              : t("status.disconnected", { defaultValue: "未连接" })}
          </span>
        </div>
        <div className="header-right">
          <div className="view-tabs" role="tablist">
            <button role="tab" aria-selected={viewMode === "terminal"} className={viewMode === "terminal" ? "active" : ""} onClick={() => setViewMode("terminal")}>
              {t("settings.view.terminal", { defaultValue: "终端" })}
            </button>
            <button role="tab" aria-selected={viewMode === "waveform"} className={viewMode === "waveform" ? "active" : ""} onClick={() => setViewMode("waveform")}>
              {t("settings.view.waveform", { defaultValue: "波形" })}
            </button>
            <button role="tab" aria-selected={viewMode === "split"} className={viewMode === "split" ? "active" : ""} onClick={() => setViewMode("split")}>
              {t("settings.view.split", { defaultValue: "分屏" })}
            </button>
          </div>
          <button className="btn-settings" onClick={() => setSettingsOpen(!settingsOpen)} aria-label={t("settings.title", { defaultValue: "设置" })}>
            ⚙
          </button>
        </div>
      </header>

      <div className="main-layout">
        {/* 备注：设置面板 */}
        {settingsOpen && (
          <>
            <div className="settings-backdrop" onClick={() => setSettingsOpen(false)} role="presentation" />
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
                <button className="btn-refresh" onClick={refreshPorts} title={t("serial.refresh", { defaultValue: "刷新" })}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M23 4v6h-6" />
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                  </svg>
                </button>
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
                  {/* M10: RX/TX 字节计数 */}
                  {status.connected && (
                    <span className="byte-stats" style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "Consolas, monospace" }}>
                      RX: {(byteStats[0] / 1024).toFixed(1)}K TX: {(byteStats[1] / 1024).toFixed(1)}K
                    </span>
                  )}
                  <label><input type="checkbox" checked={showHex} onChange={(e) => setShowHex(e.target.checked)} /> HEX</label>
                  <button onClick={() => setLogs([])}>{t("terminal.clear", { defaultValue: "清空" })}</button>
                  {/* U7: 导出日志 */}
                  <button onClick={handleExportLog}>{t("terminal.export", { defaultValue: "导出" })}</button>
                </div>
              </div>
              <div className="log-container" ref={logContainerRef} role="log" aria-live="polite">
                {logs.map((log) => (
                  <div key={log.id} className={`log-entry log-${log.direction.toLowerCase()}`}>
                    <span className="log-dir">{log.direction}</span>
                    <span className="log-data">{log.data || (showHex ? log.hex : log.ascii)}</span>
                  </div>
                ))}
              </div>
              <div className="send-area">
                <div className="send-controls">
                  <label><input type="radio" checked={sendMode === "ascii"} onChange={() => handleSendModeChange("ascii")} /> ASCII</label>
                  <label><input type="radio" checked={sendMode === "hex"} onChange={() => handleSendModeChange("hex")} /> HEX</label>
                  <label className="auto-send"><input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} /> {t("terminal.autoSend", { defaultValue: "自动" })}</label>
                  <input type="number" min={100} value={autoSendInterval} onChange={(e) => setAutoSendInterval(Number(e.target.value))} className="interval" />
                  <span>ms</span>
                </div>
                <div className="send-row">
                  <textarea
                    value={sendData}
                    onChange={(e) => {
                      if (sendMode === "hex") {
                        // HEX 输入自动格式化：每 2 个字符加空格
                        const raw = e.target.value.replace(/[^0-9a-fA-F]/g, "");
                        const formatted = raw.replace(/(.{2})/g, "$1 ").trim();
                        setSendData(formatted);
                      } else {
                        setSendData(e.target.value);
                      }
                    }}
                    placeholder={sendMode === "hex" ? t("terminal.hexPlaceholder", { defaultValue: "01 03 00 00 00 01" }) : t("terminal.placeholder", { defaultValue: "输入文本" })}
                    onKeyDown={(e) => { if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); handleSend(); } }}
                  />
                  <div className="send-buttons">
                    <button className="btn-icon clear-btn" onClick={() => setSendData("")} title={t("terminal.clearInput", { defaultValue: "清空输入" })}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                      </svg>
                    </button>
                    <div className="history-wrapper">
                      <button className="btn-icon history-btn" onClick={() => setShowHistory(!showHistory)} title={t("terminal.history", { defaultValue: "发送记录" })}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
                          <rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect>
                        </svg>
                      </button>
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
                      title={t("terminal.lineEnding", { defaultValue: "行尾追加" })}
                    >
                      <option value="none">{t("terminal.lineEndingNone", { defaultValue: "无" })}</option>
                      <option value="LF">{t("terminal.lineEndingLf", { defaultValue: "LF (\\n)" })}</option>
                      <option value="CR">{t("terminal.lineEndingCr", { defaultValue: "CR (\\r)" })}</option>
                      <option value="CRLF">{t("terminal.lineEndingCrLf", { defaultValue: "CRLF (\\r\\n)" })}</option>
                      <option value="LFCR">{t("terminal.lineEndingLfCr", { defaultValue: "LFCR (\\n\\r)" })}</option>
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
