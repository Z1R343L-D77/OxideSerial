import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WaveformPanel } from "./components/WaveformPanel";
import "./App.css";

// 备注：类型定义
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

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const DATA_BITS = [5, 6, 7, 8];
const STOP_BITS = [1, 2];
const PARITIES = [
  { value: "none", label: "无" },
  { value: "odd", label: "奇" },
  { value: "even", label: "偶" },
];

// 备注：视图模式
type ViewMode = "terminal" | "waveform" | "split";

function App() {
  // 备注：串口状态
  const [ports, setPorts] = useState<string[]>([]);
  const [config, setConfig] = useState<SerialConfig>({
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
  const [viewMode, setViewMode] = useState<ViewMode>("split");

  // 备注：收发模式
  const [sendMode, setSendMode] = useState<"ascii" | "hex">("ascii");
  const [showHex, setShowHex] = useState(false);

  // 备注：发送数据
  const [sendData, setSendData] = useState("");
  const [autoSend, setAutoSend] = useState(false);
  const [autoSendInterval, setAutoSendInterval] = useState(1000);

  // 备注：日志
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logIdRef = useRef(0);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // 备注：波形数据
  const [waveformData, setWaveformData] = useState<DataFrame[]>([]);

  // 备注：Modbus 配置
  const [modbusSlaveId, setModbusSlaveId] = useState(1);
  const [modbusFunction, setModbusFunction] = useState(3);
  const [modbusRegister, setModbusRegister] = useState(0);
  const [modbusCount, setModbusCount] = useState(1);

  const autoSendTimerRef = useRef<number | null>(null);

  // 备注：添加日志
  const addLog = useCallback((direction: string, data: string) => {
    const id = ++logIdRef.current;
    const timestamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    setLogs((prev) => [...prev.slice(-1999), { id, timestamp, direction, data }]);
  }, []);

  // 备注：监听串口数据事件（Rust 后台线程推送）
  useEffect(() => {
    const unlisten1 = listen<TerminalData>("serial-data", (event) => {
      const d = event.payload;
      const display = showHex ? d.hex : d.ascii;
      addLog(d.direction, `[${d.timestamp}] ${display}`);
    });

    const unlisten2 = listen<DataFrame>("waveform-data", (event) => {
      setWaveformData((prev) => [...prev.slice(-999), event.payload]);
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
      if (portList.length > 0 && !config.port_name) {
        setConfig((prev) => ({ ...prev, port_name: portList[0] }));
      }
    } catch (e) {
      addLog("ERROR", `刷新串口失败: ${e}`);
    }
  }, [config.port_name, addLog]);

  // 备注：打开/关闭串口
  const togglePort = useCallback(async () => {
    if (status.connected) {
      try {
        await invoke("close_port");
        setStatus({ connected: false, port_name: "", baud_rate: 0 });
        addLog("INFO", "串口已关闭");
      } catch (e) {
        addLog("ERROR", `关闭串口失败: ${e}`);
      }
    } else {
      try {
        const result = await invoke<SerialStatus>("open_port", { config });
        setStatus(result);
        addLog("INFO", `串口已打开: ${config.port_name} @ ${config.baud_rate}`);
      } catch (e) {
        addLog("ERROR", `打开串口失败: ${e}`);
      }
    }
  }, [status.connected, config, addLog]);

  // 备注：发送数据
  const handleSend = useCallback(async () => {
    if (!status.connected || !sendData.trim()) return;

    try {
      let bytes: number[];
      if (sendMode === "hex") {
        const hexStr = sendData.replace(/\s+/g, "");
        if (hexStr.length % 2 !== 0) {
          addLog("ERROR", "HEX 数据长度必须为偶数");
          return;
        }
        bytes = [];
        for (let i = 0; i < hexStr.length; i += 2) {
          bytes.push(parseInt(hexStr.substring(i, i + 2), 16));
        }
      } else {
        bytes = Array.from(new TextEncoder().encode(sendData));
      }

      await invoke("send_data", { data: bytes });
    } catch (e) {
      addLog("ERROR", `发送失败: ${e}`);
    }
  }, [status.connected, sendData, sendMode, addLog]);

  // 备注：发送 Modbus 请求
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
      addLog("ERROR", `Modbus 发送失败: ${e}`);
    }
  }, [status.connected, modbusSlaveId, modbusFunction, modbusRegister, modbusCount, addLog]);

  // 备注：初始化
  useEffect(() => {
    refreshPorts();
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
          <h1>📡 串口调试器</h1>
          <span className={`status-indicator ${status.connected ? "connected" : ""}`}>
            {status.connected ? `已连接 ${status.port_name} @ ${status.baud_rate}` : "未连接"}
          </span>
        </div>
        <div className="header-right">
          <div className="view-tabs">
            <button className={viewMode === "terminal" ? "active" : ""} onClick={() => setViewMode("terminal")}>终端</button>
            <button className={viewMode === "waveform" ? "active" : ""} onClick={() => setViewMode("waveform")}>波形</button>
            <button className={viewMode === "split" ? "active" : ""} onClick={() => setViewMode("split")}>分屏</button>
          </div>
        </div>
      </header>

      <div className="main-layout">
        {/* 备注：左侧配置面板 */}
        <aside className="sidebar">
          <section className="panel">
            <h3>串口配置</h3>
            <div className="form-group">
              <label>串口</label>
              <div className="port-row">
                <select value={config.port_name} onChange={(e) => setConfig({ ...config, port_name: e.target.value })}>
                  {ports.length === 0 && <option value="">无可用串口</option>}
                  {ports.map((p) => (<option key={p} value={p}>{p}</option>))}
                </select>
                <button onClick={refreshPorts} title="刷新">🔄</button>
              </div>
            </div>
            <div className="form-group">
              <label>波特率</label>
              <select value={config.baud_rate} onChange={(e) => setConfig({ ...config, baud_rate: Number(e.target.value) })}>
                {BAUD_RATES.map((r) => (<option key={r} value={r}>{r}</option>))}
              </select>
            </div>
            <div className="form-row">
              <div className="form-group"><label>数据位</label>
                <select value={config.data_bits} onChange={(e) => setConfig({ ...config, data_bits: Number(e.target.value) })}>
                  {DATA_BITS.map((d) => (<option key={d} value={d}>{d}</option>))}
                </select>
              </div>
              <div className="form-group"><label>停止位</label>
                <select value={config.stop_bits} onChange={(e) => setConfig({ ...config, stop_bits: Number(e.target.value) })}>
                  {STOP_BITS.map((s) => (<option key={s} value={s}>{s}</option>))}
                </select>
              </div>
              <div className="form-group"><label>校验</label>
                <select value={config.parity} onChange={(e) => setConfig({ ...config, parity: e.target.value })}>
                  {PARITIES.map((p) => (<option key={p.value} value={p.value}>{p.label}</option>))}
                </select>
              </div>
            </div>
            <button className={`btn-connect ${status.connected ? "disconnect" : ""}`} onClick={togglePort} disabled={!config.port_name}>
              {status.connected ? "断开" : "打开串口"}
            </button>
          </section>

          <section className="panel">
            <h3>Modbus RTU</h3>
            <div className="form-row">
              <div className="form-group"><label>从站 ID</label>
                <input type="number" min={1} max={247} value={modbusSlaveId} onChange={(e) => setModbusSlaveId(Number(e.target.value))} />
              </div>
              <div className="form-group"><label>功能码</label>
                <select value={modbusFunction} onChange={(e) => setModbusFunction(Number(e.target.value))}>
                  <option value={1}>01 读线圈</option>
                  <option value={2}>02 读离散</option>
                  <option value={3}>03 读保持</option>
                  <option value={4}>04 读输入</option>
                  <option value={5}>05 写线圈</option>
                  <option value={6}>06 写寄存器</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group"><label>起始地址</label>
                <input type="number" min={0} max={65535} value={modbusRegister} onChange={(e) => setModbusRegister(Number(e.target.value))} />
              </div>
              <div className="form-group"><label>数量</label>
                <input type="number" min={1} max={125} value={modbusCount} onChange={(e) => setModbusCount(Number(e.target.value))} />
              </div>
            </div>
            <button className="btn-modbus" onClick={handleModbusSend} disabled={!status.connected}>发送 Modbus</button>
          </section>
        </aside>

        {/* 备注：右侧内容区 */}
        <main className="content">
          {/* 备注：波形面板 */}
          {(viewMode === "waveform" || viewMode === "split") && (
            <WaveformPanel data={waveformData} maxPoints={500} />
          )}

          {/* 备注：终端面板 */}
          {(viewMode === "terminal" || viewMode === "split") && (
            <section className="panel terminal-panel">
              <div className="terminal-header">
                <h3>终端</h3>
                <div className="terminal-controls">
                  <label><input type="checkbox" checked={showHex} onChange={(e) => setShowHex(e.target.checked)} /> HEX</label>
                  <button onClick={() => setLogs([])}>清空</button>
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
                  <label className="auto-send"><input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} /> 自动</label>
                  <input type="number" min={100} value={autoSendInterval} onChange={(e) => setAutoSendInterval(Number(e.target.value))} className="interval" />
                  <span>ms</span>
                </div>
                <div className="send-row">
                  <textarea
                    value={sendData}
                    onChange={(e) => setSendData(e.target.value)}
                    placeholder={sendMode === "hex" ? "01 03 00 00 00 01" : "输入文本"}
                    onKeyDown={(e) => { if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); handleSend(); } }}
                  />
                  <button className="btn-send" onClick={handleSend} disabled={!status.connected}>发送</button>
                </div>
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
