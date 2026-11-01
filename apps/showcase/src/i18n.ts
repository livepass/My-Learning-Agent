import i18n from "i18next";
import { initReactI18next } from "react-i18next";
// Reuse the main app's locale resources so shared components (MessageBubble's
// collapse/expand labels, etc.) translate identically.
import zhCN from "@inno-web/i18n/locales/zh-CN.json";
import en from "@inno-web/i18n/locales/en.json";

void i18n.use(initReactI18next).init({
	resources: {
		"zh-CN": { translation: zhCN },
		en: { translation: en },
	},
	lng: "zh-CN",
	fallbackLng: "zh-CN",
	interpolation: { escapeValue: false },
	returnNull: false,
});

export default i18n;
