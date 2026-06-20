import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { ViewMode } from "../types/config";
import type { SerialStatus } from "../types/serial";
import { APP_VERSION } from "../types/config";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface HeaderProps {
  status: SerialStatus;
  viewMode: ViewMode;
  settingsOpen: boolean;
  onViewModeChange: (mode: ViewMode) => void;
  onToggleSettings: () => void;
}

export function Header({ status, viewMode, onViewModeChange, onToggleSettings }: HeaderProps) {
  const { t } = useTranslation();
  const [isPinned, setIsPinned] = useState(false);

  // Sync initial pinned state
  useEffect(() => {
    getCurrentWindow()
      .isAlwaysOnTop()
      .then((pinned) => {
        setIsPinned(pinned);
      })
      .catch((err) => {
        console.error("Failed to query initial always-on-top status:", err);
      });
  }, []);

  const handleTogglePin = async () => {
    try {
      const window = getCurrentWindow();
      const nextPinned = !isPinned;
      await window.setAlwaysOnTop(nextPinned);
      setIsPinned(nextPinned);
    } catch (err) {
      console.error("Failed to set always-on-top:", err);
    }
  };

  const handleMinimize = async () => {
    try {
      await getCurrentWindow().minimize();
    } catch (err) {
      console.error("Failed to minimize window:", err);
    }
  };

  const handleMaximize = async () => {
    try {
      await getCurrentWindow().toggleMaximize();
    } catch (err) {
      console.error("Failed to toggle maximize:", err);
    }
  };

  const handleClose = async () => {
    try {
      await getCurrentWindow().close();
    } catch (err) {
      console.error("Failed to close window:", err);
    }
  };

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

        {/* Window Control Buttons */}
        <div className="window-controls">
          <button
            className={`btn-win-control btn-pin ${isPinned ? "active" : ""}`}
            onClick={handleTogglePin}
            title={isPinned ? t("header.unpinTip", { defaultValue: "取消置顶" }) : t("header.pinTip", { defaultValue: "窗口置顶" })}
            aria-label="pin"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="17" x2="12" y2="22"></line>
              <path d="M5 17h14v-1.76a2 2 0 0 0-.44-1.24l-2.78-3.5A2 2 0 0 1 15 9.24V5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v4.24c0 .43-.14.85-.4 1.2l-2.8 3.5a2 2 0 0 0-.44 1.24V17z"></path>
            </svg>
            <span className="pin-text">{t("header.pin", { defaultValue: "置顶" })}</span>
          </button>
          <button
            className="btn-win-control btn-minimize"
            onClick={handleMinimize}
            title={t("header.minimizeTip", { defaultValue: "最小化" })}
            aria-label="minimize"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="12" x2="18" y2="12"></line>
            </svg>
          </button>
          <button
            className="btn-win-control btn-maximize"
            onClick={handleMaximize}
            title={t("header.maximizeTip", { defaultValue: "最大化" })}
            aria-label="maximize"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="6" y="6" width="12" height="12" rx="1.5"></rect>
            </svg>
          </button>
          <button
            className="btn-win-control btn-close-win"
            onClick={handleClose}
            title={t("header.closeTip", { defaultValue: "关闭" })}
            aria-label="close"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}
