export type ThemeOption = "light" | "dark" | "system";
export type ViewMode = "terminal" | "waveform" | "split";

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
