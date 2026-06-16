import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n } from './locales'
import { applyTheme, watchSystemTheme } from './utils/theme'
import { ErrorBoundary } from './components/ErrorBoundary'
import App from './App.tsx'

// 备注：初始化 i18n 和主题
const savedLocale = localStorage.getItem('app-locale') || 'zh-CN'
initI18n(savedLocale)

const savedTheme = (localStorage.getItem('theme-option') as 'light' | 'dark' | 'system') || 'dark'
applyTheme(savedTheme)
watchSystemTheme(savedTheme)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
