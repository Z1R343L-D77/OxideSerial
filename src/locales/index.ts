import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./zh-CN/translation.json";
import enUS from "./en-US/translation.json";
import zhHK from "./zh-HK/translation.json";

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
  });
}

export default i18n;
