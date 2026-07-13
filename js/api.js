// ============================================================================
// Тонкий клиент REST API панели.
// Реализует ровно тот контракт, который отдаёт backend_src/bot/webapi/server.py
// ----------------------------------------------------------------------------
const TOKEN_KEY = "panel_token";

function resolveApiBase() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("api_base");
  if (fromUrl) {
    localStorage.setItem("api_base_override", fromUrl);
    params.delete("api_base");
    const qs = params.toString();
    const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
    window.history.replaceState({}, document.title, newUrl);
    return fromUrl;
  }
  return localStorage.getItem("api_base_override") || window.API_BASE_URL || "";
}

const API_BASE = resolveApiBase();

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(status, data) {
    super((data && data.error) || `HTTP ${status}`);
    this.status = status;
    this.data = data;
  }
}

async function request(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, data);
  }
  return data;
}

export const api = {
  // --- auth ---------------------------------------------------------------
  healthz: () => request("GET", "/api/healthz"),
  authTelegramWidget: (payload) => request("POST", "/api/auth/telegram-widget", payload),
  authTelegramWebapp: (initData) => request("POST", "/api/auth/telegram-webapp", { initData }),
  me: () => request("GET", "/api/auth/me"),

  // --- chats ----------------------------------------------------------------
  listChats: () => request("GET", "/api/chats"),
  getChat: (chatId) => request("GET", `/api/chats/${chatId}`),
  listModerators: (chatId) => request("GET", `/api/chats/${chatId}/moderators`),
  getSettings: (chatId) => request("GET", `/api/chats/${chatId}/settings`),

  patchAntispam: (chatId, body) => request("PATCH", `/api/chats/${chatId}/settings/antispam`, body),
  patchAntinsfw: (chatId, body) => request("PATCH", `/api/chats/${chatId}/settings/antinsfw`, body),
  patchAntiRaid: (chatId, body) => request("PATCH", `/api/chats/${chatId}/settings/anti-raid`, body),

  getAntiRaidStatus: (chatId) => request("GET", `/api/chats/${chatId}/anti-raid/status`),
  liftAntiRaid: (chatId) => request("POST", `/api/chats/${chatId}/anti-raid/lift`),

  listAiProviders: () => request("GET", "/api/ai/providers"),
  getAi: (chatId) => request("GET", `/api/chats/${chatId}/ai`),
  patchAi: (chatId, body) => request("PATCH", `/api/chats/${chatId}/ai`, body),
  setAiApiKey: (chatId, provider, apiKey) =>
    request("POST", `/api/chats/${chatId}/ai/api-key`, { provider, api_key: apiKey }),
  deleteAiApiKey: (chatId, provider) => request("DELETE", `/api/chats/${chatId}/ai/api-key/${provider}`),
};
