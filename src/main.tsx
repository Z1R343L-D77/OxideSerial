import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n } from './locales'
import { applyTheme, watchSystemTheme } from './utils/theme'
import { ErrorBoundary } from './components/ErrorBoundary'
import App from './App.tsx'

// 备注：禁用浏览器右键菜单及刷新快捷键，提升原生桌面应用体验
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('keydown', (e) => {
  if (
    e.key === 'F5' ||
    (e.ctrlKey && e.key === 'r') ||
    (e.ctrlKey && e.shiftKey && e.key === 'R')
  ) {
    e.preventDefault();
  }
});

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

// 备注：实现全局自定义悬浮提示框 (Tooltip) 替换浏览器默认样式
const createGlobalTooltip = () => {
  const tooltipEl = document.createElement('div');
  tooltipEl.className = 'global-app-tooltip';
  tooltipEl.style.position = 'fixed';
  tooltipEl.style.pointerEvents = 'none';
  tooltipEl.style.zIndex = '99999';
  tooltipEl.style.display = 'none';
  document.body.appendChild(tooltipEl);

  let activeEl: HTMLElement | null = null;

  const hideTooltip = () => {
    if (activeEl) {
      const content = activeEl.getAttribute('data-tooltip-content');
      const currentTitle = activeEl.getAttribute('title');
      if (content && !currentTitle) {
        activeEl.setAttribute('title', content);
      }
      activeEl.removeAttribute('data-tooltip-content');
      activeEl = null;
    }
    tooltipEl.style.display = 'none';
  };

  document.addEventListener('mouseover', (e) => {
    try {
      const el = e.target as HTMLElement;
      if (!el || typeof el.closest !== 'function') return;
      const target = el.closest('[title]') as HTMLElement | null;
      if (!target) return;

      if (activeEl && activeEl !== target) {
        hideTooltip();
      }

      activeEl = target;
      const originalTitle = target.getAttribute('title') || '';
      if (!originalTitle) return;

      target.removeAttribute('title');
      target.setAttribute('data-tooltip-content', originalTitle);

      tooltipEl.textContent = originalTitle;
      tooltipEl.style.display = 'block';
      
      const rect = target.getBoundingClientRect();
      let top = rect.top - tooltipEl.offsetHeight - 8;
      let left = rect.left + (rect.width - tooltipEl.offsetWidth) / 2;

      if (top < 8) {
        top = rect.bottom + 8;
      }
      if (left < 8) {
        left = 8;
      } else if (left + tooltipEl.offsetWidth > window.innerWidth - 8) {
        left = window.innerWidth - tooltipEl.offsetWidth - 8;
      }

      tooltipEl.style.top = `${top}px`;
      tooltipEl.style.left = `${left}px`;
    } catch (err) {
      console.error("Error in tooltip mouseover handler:", err);
    }
  }, true);

  document.addEventListener('mouseout', (e) => {
    if (activeEl) {
      try {
        const related = e.relatedTarget;
        if (!related || !(related instanceof Node) || !activeEl.contains(related)) {
          hideTooltip();
        }
      } catch (err) {
        console.error("Error in tooltip mouseout handler:", err);
        hideTooltip();
      }
    }
  }, true);

  document.addEventListener('scroll', hideTooltip, true);
  document.addEventListener('wheel', hideTooltip, true);
  window.addEventListener('blur', hideTooltip);
};

if (typeof document !== 'undefined') {
  createGlobalTooltip();
}
