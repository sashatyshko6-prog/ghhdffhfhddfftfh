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
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
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

async function fetchAvatar(path) {
  const headers = {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers });
    if (!res.ok) return null;
    const blob = await res.blob();
    return blob.size ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}

function filenameFromDisposition(value) {
  if (!value) return "";
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // Fall through to the ASCII filename.
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(value);
  return plain?.[1] || "";
}

async function fetchProtectedBlob(path) {
  const headers = {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) {
    const text = await res.text();
    let data = text || null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text };
      }
    }
    throw new ApiError(res.status, data);
  }

  const blob = await res.blob();
  return {
    blob,
    fileName: filenameFromDisposition(res.headers.get("Content-Disposition")),
    contentType: res.headers.get("Content-Type") || blob.type || "",
  };
}

async function fetchMessageMedia(path) {
  const { blob, contentType } = await fetchProtectedBlob(path);
  if (!blob.size) return null;
  return { url: URL.createObjectURL(blob), contentType: contentType.split(";")[0].trim().toLowerCase() };
}

export const api = {
  // --- auth ---------------------------------------------------------------
  healthz: () => request("GET", "/api/healthz"),
  authTelegramWidget: (payload) => request("POST", "/api/auth/telegram-widget", payload),
  authTelegramWebapp: (initData) => request("POST", "/api/auth/telegram-webapp", { initData }),
  me: () => request("GET", "/api/auth/me"),

  // --- chats ----------------------------------------------------------------
  listChats: ({ includeSettings = false } = {}) =>
    request("GET", `/api/chats${includeSettings ? "?include_settings=1" : ""}`),
  getChat: (chatId) => request("GET", `/api/chats/${chatId}`),
  listModerators: (chatId) => request("GET", `/api/chats/${chatId}/moderators`),
  getSettings: (chatId) => request("GET", `/api/chats/${chatId}/settings`),
  listMessages: (chatId, limit = 200) =>
    request("GET", `/api/chats/${encodeURIComponent(chatId)}/messages?limit=${encodeURIComponent(limit)}`),
  sendMessage: (chatId, body) => request("POST", `/api/chats/${encodeURIComponent(chatId)}/send`, body),
  fetchAvatar,
  fetchMessageMedia,
  downloadMessageMedia: (chatId, messageId) =>
    fetchProtectedBlob(`/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/media`),
  getChatAvatar: (chatId) => fetchAvatar(`/api/chats/${encodeURIComponent(chatId)}/avatar`),
  getMemberAvatar: (chatId, userId) =>
    fetchAvatar(`/api/chats/${encodeURIComponent(chatId)}/members/${encodeURIComponent(userId)}/avatar`),
  deleteMessage: (chatId, messageId) =>
    request("DELETE", `/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`),
  getMemberModeration: (chatId, userId) =>
    request("GET", `/api/chats/${encodeURIComponent(chatId)}/members/${encodeURIComponent(userId)}/moderation`),
  banMember: (chatId, userId) =>
    request("POST", `/api/chats/${encodeURIComponent(chatId)}/members/${encodeURIComponent(userId)}/ban`, {}),
  unbanMember: (chatId, userId) =>
    request("POST", `/api/chats/${encodeURIComponent(chatId)}/members/${encodeURIComponent(userId)}/unban`, {}),
  muteMember: (chatId, userId, durationSeconds) =>
    request("POST", `/api/chats/${encodeURIComponent(chatId)}/members/${encodeURIComponent(userId)}/mute`, {
      duration_seconds: durationSeconds,
    }),

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

  // --- ai moderator (separate feature from the chat-personality AI above) --
  getAiModerator: (chatId) => request("GET", `/api/chats/${chatId}/ai-moderator`),
  patchAiModerator: (chatId, body) => request("PATCH", `/api/chats/${chatId}/ai-moderator`, body),
  setAiModeratorKey: (chatId, provider, apiKey) =>
    request("POST", `/api/chats/${chatId}/ai-moderator/api-key`, { provider, api_key: apiKey }),
  deleteAiModeratorKey: (chatId, provider) =>
    request("DELETE", `/api/chats/${chatId}/ai-moderator/api-key/${provider}`),
};
