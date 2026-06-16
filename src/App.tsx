import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { WaveformPanel } from "./components/WaveformPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { TerminalPanel } from "./components/TerminalPanel";
import { useSerial } from "./hooks/useSerial";
import { useTerminalLogs } from "./hooks/useTerminalLogs";
import type { DataFrame } from "./types/serial";
import type { AppConfig, ViewMode } from "./types/config";
import { DEFAULT_CONFIG } from "./types/config";
import { applyTheme, watchSystemTheme } from "./utils/theme";
import "./App.css";

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
  const [viewMode, setViewMode] = useState<ViewMode>(config.defaultViewMode);
  const [waveformFrame, setWaveformFrame] = useState<DataFrame | null>(null);

  // 备注：日志 hook
  const { logs, logContainerRef, addLog, addTextLog, clearLogs, exportLogs } = useTerminalLogs(config.locale || "zh-CN");

  // 备注：串口 hook
  const { ports, serialConfig, setSerialConfig, status, byteStats, refreshPorts, togglePort } = useSerial(
    addLog,
    addTextLog,
    setWaveformFrame,
  );

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

        <Sidebar
          ports={ports}
          serialConfig={serialConfig}
          status={status}
          onSerialConfigChange={setSerialConfig}
          onRefreshPorts={refreshPorts}
          onTogglePort={togglePort}
          onError={(msg) => addTextLog("ERROR", msg)}
        />

        <main className="content">
          <div style={{ display: viewMode === "terminal" ? "none" : "flex", flex: 1, minHeight: 0, minWidth: 0 }}>
            <WaveformPanel frame={waveformFrame} />
          </div>

          <div style={{ display: viewMode === "waveform" ? "none" : "flex", flex: 1, minHeight: 0 }}>
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
        </main>
      </div>
    </div>
  );
}

export default App;
