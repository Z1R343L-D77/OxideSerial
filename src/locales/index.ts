import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./zh-CN/translation.json";
import enUS from "./en-US/translation.json";
import zhHK from "./zh-HK/translation.json";

// 备注：主语言静态导入，其余按需加载
const resources = {
  "zh-CN": { translation: zhCN },
  "en-US": { translation: enUS },
  "zh-HK": { translation: zhHK },
};

export function initI18n(locale?: string) {
  const saved = locale || localStorage.getItem("app-locale") || "zh-CN";

  i18n.use(initReactI18next).init({
    resources,
    lng: saved,
    fallbackLng: "zh-CN",
    interpolation: { escapeValue: false },
    // 备注：只加载当前语言，其余语言按需加载时再补充
    partialBundledLanguages: true,
  });
}

export default i18n;
