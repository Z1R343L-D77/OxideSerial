import { useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { applyTheme, watchSystemTheme } from "../utils/theme";
import type { AppConfig, ThemeOption, ViewMode } from "../types/config";
import { APP_VERSION } from "../types/config";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";

interface SettingsPanelProps {
  config: AppConfig;
  onChange: (config: AppConfig) => void;
  onClose: () => void;
}

export function SettingsPanel({ config, onChange, onClose }: SettingsPanelProps) {
  const { t, i18n } = useTranslation();

  const setConfigValue = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  const handleThemeChange = (theme: ThemeOption) => {
    setConfigValue("theme", theme);
    applyTheme(theme);
    watchSystemTheme(theme);
  };

  const handleLocaleChange = (locale: string) => {
    setConfigValue("locale", locale);
    i18n.changeLanguage(locale);
    localStorage.setItem("app-locale", locale);
  };

  // 备注：同步开机自启状态
  useEffect(() => {
    isEnabled().then((enabled) => {
      if (enabled !== config.autostart) {
        setConfigValue("autostart", enabled);
      }
    }).catch(() => {});
  }, []);

  const handleAutostartToggle = useCallback(async (v: boolean) => {
    try {
      if (v) {
        await enable();
      } else {
        await disable();
      }
      setConfigValue("autostart", v);
    } catch (e) {
      console.error("autostart toggle failed:", e);
    }
  }, [config]);

  return (
    <div className="settings-panel">
      {/* 备注：标题栏 */}
      <div className="settings-header">
        <h3>{t("settings.title", { defaultValue: "设置" })}</h3>
        <button className="btn-close" onClick={onClose}>✕</button>
      </div>

      {/* 备注：主题 */}
      <section className="settings-section">
        <label className="settings-label">{t("settings.theme.title", { defaultValue: "主题" })}</label>
        <div className="segmented-control">
          {(["light", "dark", "system"] as ThemeOption[]).map((opt) => (
            <button
              key={opt}
              className={config.theme === opt ? "active" : ""}
              onClick={() => handleThemeChange(opt)}
            >
              {t(`settings.theme.${opt}`, { defaultValue: opt })}
            </button>
          ))}
        </div>
      </section>

      {/* 备注：语言 */}
      <section className="settings-section">
        <label className="settings-label">{t("settings.language.title", { defaultValue: "语言" })}</label>
        <div className="segmented-control">
          {(["zh-CN", "en-US", "zh-HK"] as const).map((loc) => (
            <button
              key={loc}
              className={config.locale === loc ? "active" : ""}
              onClick={() => handleLocaleChange(loc)}
            >
              {t(`settings.language.${loc}`, { defaultValue: loc })}
            </button>
          ))}
        </div>
      </section>

      {/* 备注：默认视图 */}
      <section className="settings-section">
        <label className="settings-label">{t("settings.view.title", { defaultValue: "默认视图" })}</label>
        <div className="segmented-control">
          {(["terminal", "waveform", "split"] as ViewMode[]).map((opt) => (
            <button
              key={opt}
              className={config.defaultViewMode === opt ? "active" : ""}
              onClick={() => setConfigValue("defaultViewMode", opt)}
            >
              {t(`settings.view.${opt}`, { defaultValue: opt })}
            </button>
          ))}
        </div>
      </section>

      {/* 备注：开关选项 */}
      <section className="settings-section">
        <ToggleRow
          label={t("settings.general.closeToTray", { defaultValue: "关闭到托盘" })}
          checked={config.closeToTray}
          onChange={(v) => {
            setConfigValue("closeToTray", v);
            void invoke("set_close_to_tray", { enabled: v });
          }}
        />
        <ToggleRow
          label={t("settings.general.autostart", { defaultValue: "开机自启" })}
          checked={config.autostart}
          onChange={(v) => void handleAutostartToggle(v)}
        />
      </section>

      {/* 备注：关于 */}
      <section className="settings-section settings-about">
        <label className="settings-label">{t("settings.about.title", { defaultValue: "关于" })}</label>
        <div className="about-content">
          <p className="about-name">OxideSerial v{APP_VERSION}</p>
          <p className="about-desc">{t("settings.about.description", { defaultValue: "工业级串口调试器" })}</p>
          <p className="about-tech">{t("settings.about.techStack", { defaultValue: "基于 Tauri + Rust + React 构建" })}</p>
        </div>
      </section>
    </div>
  );
}

// 备注：开关行组件（键盘可访问）
function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <div
        className={`toggle-switch ${checked ? "on" : ""}`}
        role="switch"
        aria-checked={checked}
        tabIndex={0}
        onClick={() => onChange(!checked)}
        onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); onChange(!checked); } }}
      >
        <div className="toggle-thumb" />
      </div>
    </label>
  );
}
