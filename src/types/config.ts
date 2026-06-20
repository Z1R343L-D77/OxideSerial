export type ThemeOption = "light" | "dark" | "system";
export type ViewMode = "terminal" | "waveform" | "split";

// D3: 版本号单一来源
export const APP_VERSION = "0.3.1";

export interface AppConfig {
  theme: ThemeOption;
  locale: string;
  defaultViewMode: ViewMode;
  closeToTray: boolean;
  autostart: boolean;
}

export const DEFAULT_CONFIG: AppConfig = {
  theme: "dark",
  locale: "zh-CN",
  defaultViewMode: "split",
  closeToTray: true,
  autostart: false,
};
