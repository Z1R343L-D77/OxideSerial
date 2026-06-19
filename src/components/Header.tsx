import { useTranslation } from "react-i18next";
import type { ViewMode } from "../types/config";
import type { SerialStatus } from "../types/serial";
import { APP_VERSION } from "../types/config";

interface HeaderProps {
  status: SerialStatus;
  viewMode: ViewMode;
  settingsOpen: boolean;
  onViewModeChange: (mode: ViewMode) => void;
  onToggleSettings: () => void;
}

export function Header({ status, viewMode, onViewModeChange, onToggleSettings }: HeaderProps) {
  const { t } = useTranslation();

  return (
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
          {(["terminal", "waveform", "split"] as ViewMode[]).map((mode) => {
            const viewTitles: Record<ViewMode, string> = {
              terminal: t("header.viewTerminalTip", { defaultValue: "只显示终端文本日志" }),
              waveform: t("header.viewWaveformTip", { defaultValue: "只显示波形数据图表" }),
              split: t("header.viewSplitTip", { defaultValue: "同时显示终端日志与波形图表" }),
            };
            return (
              <button
                key={mode}
                role="tab"
                aria-selected={viewMode === mode}
                className={viewMode === mode ? "active" : ""}
                onClick={() => onViewModeChange(mode)}
                title={viewTitles[mode]}
              >
                {t(`settings.view.${mode}`, { defaultValue: mode })}
              </button>
            );
          })}
        </div>
        <button 
          className="btn-settings" 
          onClick={onToggleSettings} 
          aria-label={t("settings.title", { defaultValue: "设置" })}
          title={t("settings.titleTip", { defaultValue: "打开系统配置与偏好设置" })}
        >
          ⚙
        </button>
      </div>
    </header>
  );
}
