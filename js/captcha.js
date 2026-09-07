import { TURNSTILE_SITE_KEY } from './supabase-config.js';

const widgets = new Map();
let loaderPromise = null;

export const isCaptchaConfigured = Boolean(TURNSTILE_SITE_KEY?.trim());

function loadTurnstile() {
  if (!isCaptchaConfigured) return Promise.resolve(null);
  if (globalThis.turnstile) return Promise.resolve(globalThis.turnstile);
  if (loaderPromise) return loaderPromise;

  loaderPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-taskflow-turnstile]');
    if (existing) {
      existing.addEventListener('load', () => resolve(globalThis.turnstile), { once: true });
      existing.addEventListener('error', () => reject(new Error('Falha ao carregar o CAPTCHA.')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.dataset.taskflowTurnstile = 'true';
    script.onload = () => resolve(globalThis.turnstile);
    script.onerror = () => reject(new Error('Falha ao carregar o CAPTCHA.'));
    document.head.appendChild(script);
  });

  return loaderPromise;
}

export async function mountCaptcha(key, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!isCaptchaConfigured) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const turnstile = await loadTurnstile();
  if (!turnstile) return;
  if (widgets.has(key)) return;
  const widgetId = turnstile.render(container, {
    sitekey: TURNSTILE_SITE_KEY,
    theme: 'light',
    size: 'flexible'
  });
  widgets.set(key, widgetId);
}

export function getCaptchaToken(key) {
  if (!isCaptchaConfigured) return null;
  const widgetId = widgets.get(key);
  if (widgetId == null || !globalThis.turnstile) return null;
  return globalThis.turnstile.getResponse(widgetId) || null;
}

export function requireCaptchaToken(key) {
  const token = getCaptchaToken(key);
  if (isCaptchaConfigured && !token) throw new Error('Conclua a verificação anti-bot antes de continuar.');
  return token;
}

export function resetCaptcha(key) {
  const widgetId = widgets.get(key);
  if (widgetId != null && globalThis.turnstile) globalThis.turnstile.reset(widgetId);
}
