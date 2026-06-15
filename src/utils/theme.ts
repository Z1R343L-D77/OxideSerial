import type { ThemeOption } from "../types/config";

export function applyTheme(option: ThemeOption): void {
  const resolved =
    option === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : option;

  document.documentElement.setAttribute("data-theme", resolved);
  localStorage.setItem("theme-option", option);
  localStorage.setItem("theme-resolved", resolved);
}

let systemListener: ((e: MediaQueryListEvent) => void) | null = null;

export function watchSystemTheme(option: ThemeOption): void {
  if (systemListener) {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .removeEventListener("change", systemListener);
    systemListener = null;
  }

  if (option === "system") {
    systemListener = () => applyTheme("system");
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", systemListener);
  }
}
