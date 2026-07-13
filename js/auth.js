// ============================================================================
// Аутентификация через Telegram (Login Widget + Mini App), см.
// backend_src/bot/webapi/auth.py для серверной проверки подписи.
// ----------------------------------------------------------------------------
import { api, getToken, setToken, ApiError } from "./api.js";

let currentUser = null;

export function getCurrentUser() {
  return currentUser;
}

export function getUserInitials(user) {
  if (!user) return "?";
  const f = user.firstName?.[0] || "";
  const l = user.lastName?.[0] || "";
  return (f + l).toUpperCase() || (user.username?.[0] || "?").toUpperCase();
}

export function getUserDisplayName(user) {
  if (!user) return "";
  const parts = [user.firstName, user.lastName].filter(Boolean);
  if (parts.length) return parts.join(" ");
  return user.username || "Пользователь";
}

export function getTelegramWebApp() {
  return window.Telegram?.WebApp || null;
}

/** Проверяет сохранённый токен на сервере. Возвращает true, если сессия жива. */
export async function restoreSession() {
  const token = getToken();
  if (!token) return false;
  try {
    const user = await api.me();
    currentUser = user;
    return true;
  } catch (e) {
    if (e instanceof ApiError) setToken(null);
    return false;
  }
}

/** Логин через Telegram Mini App (initData), если приложение открыто внутри Telegram.
 * Возвращает { ok: true } при успехе или { ok: false, error } с текстом причины —
 * чтобы её можно было показать на экране (в Mini App WebView нет консоли). */
export async function tryMiniAppLogin() {
  const tg = getTelegramWebApp();
  if (!tg) {
    return { ok: false, error: 'window.Telegram.WebApp недоступен — SDK не загрузился (проверьте <script src="https://telegram.org/js/telegram-web-app.js"> в index.html, интернет внутри WebView, CSP).' };
  }
  if (!tg.initData) {
    return { ok: false, error: "tg.initData пустой. Обычно значит: страница открыта не как Web App (нужен именно Menu Button/inline web_app URL), либо WebView показывает старую закэшированную версию страницы." };
  }
  try {
    const { token, user } = await api.authTelegramWebapp(tg.initData);
    setToken(token);
    currentUser = user;
    tg.ready();
    tg.expand();
    return { ok: true };
  } catch (e) {
    console.error("Mini App login failed:", e);
    const error = e instanceof ApiError
      ? `Бэкенд отклонил вход (HTTP ${e.status}): ${JSON.stringify(e.data ?? e.message)}`
      : `Сетевая ошибка при обращении к API: ${e.message}`;
    return { ok: false, error };
  }
}

/** Логин через редирект Telegram Login Widget (query-параметры на /login). */
export async function tryWidgetRedirectLogin() {
  const params = new URLSearchParams(window.location.search);
  if (!params.get("id") || !params.get("hash")) return false;

  const payload = {
    id: Number(params.get("id")),
    first_name: params.get("first_name") || "",
    last_name: params.get("last_name") || undefined,
    username: params.get("username") || undefined,
    photo_url: params.get("photo_url") || undefined,
    auth_date: Number(params.get("auth_date")),
    hash: params.get("hash"),
  };

  try {
    const { token, user } = await api.authTelegramWidget(payload);
    setToken(token);
    currentUser = user;
    window.history.replaceState({}, document.title, window.location.pathname);
    return true;
  } catch (e) {
    console.error("Widget login failed:", e);
    return false;
  }
}

export function logout() {
  setToken(null);
  currentUser = null;
}

export function injectLoginWidget(container) {
  if (container.querySelector("script")) return;
  const script = document.createElement("script");
  script.async = true;
  script.src = "https://telegram.org/js/telegram-widget.js?22";
  script.setAttribute("data-telegram-login", window.TELEGRAM_BOT_USERNAME || "");
  script.setAttribute("data-size", "large");
  script.setAttribute("data-radius", "10");
  script.setAttribute("data-auth-url", window.location.origin + window.location.pathname);
  script.setAttribute("data-request-access", "write");
  container.appendChild(script);
}
