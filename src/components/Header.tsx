import { useTranslation } from "react-i18next";
import type { SerialStatus, ViewMode } from "../types/config";
import { APP_VERSION } from "../types/config";

interface HeaderProps {
  status: SerialStatus;
  viewMode: ViewMode;
  settingsOpen: boolean;
  onViewModeChange: (mode: ViewMode) => void;
  onToggleSettings: () => void;
}

export function Header({ status, viewMode, settingsOpen, onViewModeChange, onToggleSettings }: HeaderProps) {
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
          {(["terminal", "waveform", "split"] as ViewMode[]).map((mode) => (
            <button
              key={mode}
              role="tab"
              aria-selected={viewMode === mode}
              className={viewMode === mode ? "active" : ""}
              onClick={() => onViewModeChange(mode)}
            >
              {t(`settings.view.${mode}`, { defaultValue: mode })}
            </button>
          ))}
        </div>
        <button className="btn-settings" onClick={onToggleSettings} aria-label={t("settings.title", { defaultValue: "设置" })}>
          ⚙
        </button>
      </div>
    </header>
  );
}
