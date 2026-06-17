import { useState, useCallback, useEffect } from "react";
import { WaveformPanel } from "./components/WaveformPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { TerminalPanel } from "./components/TerminalPanel";
import { ModbusMonitor } from "./components/ModbusMonitor";
import { useSerial } from "./hooks/useSerial";
import { useTerminalLogs } from "./hooks/useTerminalLogs";
import type { DataFrame } from "./types/serial";
import type { AppConfig, ViewMode } from "./types/config";
import type { ModbusRegister, ByteOrderOption } from "./types/modbus";
import { DEFAULT_CONFIG } from "./types/config";
import { applyTheme, watchSystemTheme } from "./utils/theme";
import "./App.css";

function App() {

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
  const [viewMode, setViewMode] = useState<ViewMode>(config.defaultViewMode);
  const [waveformFrame, setWaveformFrame] = useState<DataFrame | null>(null);
  const [activeFunction, setActiveFunction] = useState<"serial" | "modbus" | "can">("serial");

  // Modbus State
  const [modbusRegisters, setModbusRegisters] = useState<ModbusRegister[]>(() => {
    try {
      const saved = localStorage.getItem("modbus-registers");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [isModbusPolling, setIsModbusPolling] = useState(false);
  const [modbusInterval, setModbusInterval] = useState(() => {
    try {
      const saved = localStorage.getItem("modbus-interval");
      return saved ? Number(saved) : 500;
    } catch {
      return 500;
    }
  });
  const [modbusByteOrder, setModbusByteOrder] = useState<ByteOrderOption>(() => {
    try {
      const saved = localStorage.getItem("modbus-byte-order");
      return (saved as ByteOrderOption) || "ABCD";
    } catch {
      return "ABCD";
    }
  });

  // Save Modbus registers to localStorage
  useEffect(() => {
    localStorage.setItem("modbus-registers", JSON.stringify(modbusRegisters));
  }, [modbusRegisters]);

  // Save Modbus interval
  useEffect(() => {
    localStorage.setItem("modbus-interval", String(modbusInterval));
  }, [modbusInterval]);

  // Save Modbus byte order
  useEffect(() => {
    localStorage.setItem("modbus-byte-order", modbusByteOrder);
  }, [modbusByteOrder]);

  // 备注：日志 hook
  const { logs, logContainerRef, addLog, addTextLog, clearLogs, exportLogs } = useTerminalLogs(config.locale || "zh-CN");

  // 备注：串口 hook
  const { ports, serialConfig, setSerialConfig, status, byteStats, refreshPorts, togglePort } = useSerial(
    addLog,
    addTextLog,
    setWaveformFrame,
  );

  // Stop polling if serial disconnects
  useEffect(() => {
    if (!status.connected) {
      setIsModbusPolling(false);
    }
  }, [status.connected]);

  // Sidebar drag to resize width state
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = localStorage.getItem("sidebar-width");
      return saved ? Number(saved) : 240;
    } catch {
      return 240;
    }
  });

  useEffect(() => {
    localStorage.setItem("sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);

  const handleResizerMouseDown = useCallback((mouseDownEvent: React.MouseEvent) => {
    mouseDownEvent.preventDefault();
    const startX = mouseDownEvent.clientX;
    const startWidth = sidebarWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      // Constraint to [180px, 600px]
      const nextWidth = Math.max(180, Math.min(600, startWidth + deltaX));
      setSidebarWidth(nextWidth);
    };

    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [sidebarWidth]);

  // Waveform Panel drag to resize height state (Split mode)
  const [waveformHeight, setWaveformHeight] = useState(() => {
    try {
      const saved = localStorage.getItem("waveform-height");
      return saved ? Number(saved) : 400;
    } catch {
      return 400;
    }
  });

  useEffect(() => {
    localStorage.setItem("waveform-height", String(waveformHeight));
  }, [waveformHeight]);

  const handleResizerHMouseDown = useCallback((mouseDownEvent: React.MouseEvent) => {
    mouseDownEvent.preventDefault();
    const startY = mouseDownEvent.clientY;
    const startHeight = waveformHeight;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = moveEvent.clientY - startY;
      const nextHeight = Math.max(150, Math.min(window.innerHeight - 200, startHeight + deltaY));
      setWaveformHeight(nextHeight);
    };

    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [waveformHeight]);

  // 备注：保存设置
  const handleSettingsChange = useCallback((nextConfig: AppConfig) => {
    setConfig(nextConfig);
    localStorage.setItem("app-config", JSON.stringify(nextConfig));
    applyTheme(nextConfig.theme);
    watchSystemTheme(nextConfig.theme);
    setViewMode(nextConfig.defaultViewMode);
  }, []);

  return (
    <div className="app noise-bg">
      <Header
        status={status}
        viewMode={viewMode}
        settingsOpen={settingsOpen}
        onViewModeChange={setViewMode}
        onToggleSettings={() => setSettingsOpen(!settingsOpen)}
      />

      <div className="main-layout">
        {settingsOpen && (
          <>
            <div className="settings-backdrop" onClick={() => setSettingsOpen(false)} role="presentation" />
            <SettingsPanel config={config} onChange={handleSettingsChange} onClose={() => setSettingsOpen(false)} />
          </>
        )}

        {/* leftmost function selection sidebar */}
        <div className="function-sidebar-nav">
          <button
            className={`function-nav-item ${activeFunction === "serial" ? "active" : ""}`}
            onClick={() => setActiveFunction("serial")}
            title="串口与协议"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 6h16l-2 12H6L4 6z" />
              <circle cx="8" cy="10" r="1.2" fill="currentColor" />
              <circle cx="10" cy="10" r="1.2" fill="currentColor" />
              <circle cx="12" cy="10" r="1.2" fill="currentColor" />
              <circle cx="14" cy="10" r="1.2" fill="currentColor" />
              <circle cx="16" cy="10" r="1.2" fill="currentColor" />
              <circle cx="9" cy="14" r="1.2" fill="currentColor" />
              <circle cx="11" cy="14" r="1.2" fill="currentColor" />
              <circle cx="13" cy="14" r="1.2" fill="currentColor" />
              <circle cx="15" cy="14" r="1.2" fill="currentColor" />
              <path d="M2 6h2M20 6h2" />
            </svg>
          </button>
          <button
            className={`function-nav-item ${activeFunction === "modbus" ? "active" : ""}`}
            onClick={() => setActiveFunction("modbus")}
            title="Modbus RTU M表监测"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 14.5a8 8 0 1 1 16 0" />
              <path d="M2 18h20" />
              <circle cx="12" cy="14.5" r="1.5" fill="currentColor" />
              <path d="M12 14.5L15.5 8" />
              <path d="M6 10l1.5 1.5M18 10l-1.5 1.5M12 4v2" />
            </svg>
          </button>
          <button
            className={`function-nav-item disabled-nav ${activeFunction === "can" ? "active" : ""}`}
            onClick={() => {
              addTextLog("INFO", "CAN总线监测功能正在规划中，敬请期待！");
            }}
            title="CAN总线监测 (规划中)"
            style={{ opacity: 0.4 }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 8h20M2 16h20" />
              <path d="M6 8v3M6 16v-3" />
              <circle cx="6" cy="12" r="2.5" />
              <path d="M12 8v3M12 16v-3" />
              <circle cx="12" cy="12" r="2.5" fill="currentColor" />
              <path d="M18 8v3M18 16v-3" />
              <circle cx="18" cy="12" r="2.5" />
            </svg>
          </button>
        </div>

        <Sidebar
          ports={ports}
          serialConfig={serialConfig}
          status={status}
          onSerialConfigChange={setSerialConfig}
          onRefreshPorts={refreshPorts}
          onTogglePort={togglePort}
          onError={(msg) => addTextLog("ERROR", msg)}
          activeFunction={activeFunction}
          registers={modbusRegisters}
          setRegisters={setModbusRegisters}
          isPolling={isModbusPolling}
          setIsPolling={setIsModbusPolling}
          pollInterval={modbusInterval}
          setPollInterval={setModbusInterval}
          byteOrder={modbusByteOrder}
          setByteOrder={setModbusByteOrder}
          width={sidebarWidth}
        />

        <div className="sidebar-resizer" onMouseDown={handleResizerMouseDown} />

        <main className="content">
          {activeFunction === "modbus" ? (
            <ModbusMonitor
              registers={modbusRegisters}
              setRegisters={setModbusRegisters}
              isPolling={isModbusPolling}
              pollInterval={modbusInterval}
              byteOrder={modbusByteOrder}
              connected={status.connected}
              onAddTextLog={addTextLog}
            />
          ) : (
            <>
              {/* Waveform Wrapper */}
              <div
                style={{
                  display: viewMode === "terminal" ? "none" : "flex",
                  flex: viewMode === "split" ? "none" : 1,
                  height: viewMode === "split" ? `${waveformHeight}px` : "auto",
                  minHeight: 0,
                  minWidth: 0,
                }}
              >
                <WaveformPanel frame={waveformFrame} />
              </div>

              {/* Horizontal Resizer in Split Mode */}
              {viewMode === "split" && (
                <div className="content-resizer-h" onMouseDown={handleResizerHMouseDown} />
              )}

              {/* Terminal Wrapper */}
              <div
                style={{
                  display: viewMode === "waveform" ? "none" : "flex",
                  flex: 1,
                  minHeight: 0,
                }}
              >
                <TerminalPanel
                  logs={logs}
                  logContainerRef={logContainerRef}
                  status={status}
                  byteStats={byteStats}
                  onAddTextLog={addTextLog}
                  onClearLogs={clearLogs}
                  onExportLogs={exportLogs}
                />
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
