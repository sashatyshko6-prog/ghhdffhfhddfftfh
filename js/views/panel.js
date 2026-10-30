import { api, ApiError } from "../api.js";
import { getCurrentUser, getUserInitials, getUserDisplayName, logout, restoreSession } from "../auth.js";
import { navigate } from "../router.js";

const TABS = [
  { id: "antiraid", label: "Антирейд" },
  { id: "antispam", label: "Антиспам" },
  { id: "nsfw", label: "Защита 18+" },
  { id: "aimoderator", label: "ИИ модератор" },
  { id: "ai", label: "ИИ чат" },
];

const ANTISPAM_TYPE_LABELS = {
  text: "Текст",
  sticker: "Стикеры",
  gif: "GIF/анимации",
  photo: "Фото",
  video: "Видео",
  document: "Документы",
  voice: "Голосовые/кружки",
};

const EXTENDED_CHAT_ACCESS_USER_ID = "7273433468";
const RECENT_STICKERS_KEY = "panel_recent_stickers";

let state = {
  chats: [],
  selectedId: null,
  chatSearch: "",
  collapsedChatGroups: { admin: false, bot: false },
  settings: null,
  settingsError: "",
  moderators: [],
  aiProviders: [],
  activeSection: "chat",
  activeTab: "antiraid",
  messages: [],
  messagesChatId: null,
  messagesLimit: 200,
  messagesLoading: false,
  messagesError: "",
  chatDraft: "",
  replyToMessage: null,
  stickerPickerOpen: false,
  stickerPickerTab: "stickers",
  stickerPickerCollection: "recent",
  stickerPickerSearch: "",
  stickerLibrary: null,
  stickerLibraryLoading: false,
  stickerLibraryError: "",
  recentStickers: [],
  chatSending: false,
  sendingChatIds: new Set(),
  audioKind: "music",
  audioMessageId: null,
  loading: true,
  saving: false,
};

let aiProvidersPromise = null;
const moderatorPromises = new Map();
const avatarUrlCache = new Map();
const messageMediaCache = new Map();
const voiceWaveformCache = new Map();
const messageRefreshInFlight = new Set();
let chatRefreshTimer = null;
let chatListRefreshTimer = null;
let chatListRefreshInFlight = false;
let chatListRefreshGeneration = 0;
let messageOverlay = null;
let longPressTimer = null;
let avatarObserver = null;
let messageMediaObserver = null;
let enteringMessageIds = new Set();
let chatSelectionGeneration = 0;
let stickerLibraryLoadGeneration = 0;
let chatAudioElement = null;
let audioMessageGeneration = 0;
let audioPlayerOverlay = null;

function hasExtendedChatAccess(user = getCurrentUser()) {
  return String(user?.id || "") === EXTENDED_CHAT_ACCESS_USER_ID;
}

function readRecentStickers() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_STICKERS_KEY) || "[]");
    return Array.isArray(value) ? value.filter((item) => item?.file_id && item?.set_name).slice(0, 24) : [];
  } catch {
    return [];
  }
}

function rememberSticker(sticker) {
  const entry = {
    file_id: sticker.file_id,
    file_unique_id: sticker.file_unique_id || "",
    thumbnail_file_id: sticker.thumbnail_file_id || sticker.file_id,
    set_name: sticker.set_name,
    emoji: sticker.emoji || "",
    set_title: sticker.set_title || sticker.set_name,
  };
  state.recentStickers = [
    entry,
    ...state.recentStickers.filter((item) => item.file_id !== entry.file_id),
  ].slice(0, 24);
  try {
    localStorage.setItem(RECENT_STICKERS_KEY, JSON.stringify(state.recentStickers));
  } catch {
    // Recent stickers remain available in memory when browser storage is disabled.
  }
}

function getToastStack() {
  let stack = document.getElementById("toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "toast-stack";
    stack.className = "toast-stack";
    document.body.appendChild(stack);
  }
  return stack;
}

function toast(msg, type = "success") {
  const stack = getToastStack();
  const el = document.createElement("div");
  el.className = `toast ${type === "error" ? "toast-error" : ""}`;
  el.innerHTML = `<span class="toast-icon">${type === "error" ? "✕" : "✓"}</span><span>${escapeHtml(msg)}</span>`;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add("toast-hide");
    setTimeout(() => el.remove(), 200);
  }, 2600);
}

async function loadChat(chatId) {
  state.settingsError = "";
  try {
    const settings = await api.getSettings(chatId);
    if (String(state.selectedId) === String(chatId)) state.settings = settings;
  } catch (error) {
    if (String(state.selectedId) === String(chatId)) {
      state.settings = null;
      state.settingsError = error instanceof Error ? error.message : "Не удалось загрузить настройки чата.";
    }
    throw error;
  }
}

async function loadMessages(chatId) {
  if (state.messagesChatId && state.messagesChatId !== String(chatId)) clearMessageMediaCache();
  state.messagesChatId = String(chatId);
  state.messages = [];
  state.messagesLoading = true;
  state.messagesError = "";
  try {
    const response = await api.listMessages(chatId, state.messagesLimit);
    const messages = Array.isArray(response) ? response : response?.messages;
    if (!Array.isArray(messages)) throw new Error("Сервер вернул историю сообщений в неизвестном формате.");
    if (String(state.selectedId) !== String(chatId)) return;
    state.messages = messages;
  } catch (error) {
    if (String(state.selectedId) !== String(chatId)) return;
    state.messagesError = error instanceof Error ? error.message : "Не удалось загрузить сообщения.";
  } finally {
    if (String(state.selectedId) === String(chatId)) state.messagesLoading = false;
  }
}

async function refreshMessages(root, chatId) {
  const chatKey = String(chatId);
  if (messageRefreshInFlight.has(chatKey)) return;
  messageRefreshInFlight.add(chatKey);
  try {
    const response = await api.listMessages(chatId, state.messagesLimit);
    const messages = Array.isArray(response) ? response : response?.messages;
    if (!Array.isArray(messages) || String(state.selectedId) !== String(chatId)) return;
    const contentChanged = messages.length !== state.messages.length || messages.some((message, index) => {
      const current = state.messages[index];
      return !current || JSON.stringify(current) !== JSON.stringify(message);
    });
    if (!contentChanged) return;

    const history = root.querySelector("#chat-history");
    const wasAtBottom = history && history.scrollHeight - history.clientHeight - history.scrollTop < 40;
    const previousScrollTop = history?.scrollTop ?? 0;
    const existingIds = new Set(state.messages.map((message) => String(message.message_id)));
    const lastKnownId = state.messages.reduce((latest, message) => {
      const id = Number(message.message_id);
      return Number.isFinite(id) ? Math.max(latest, id) : latest;
    }, 0);
    enteringMessageIds = new Set(
      messages
        .filter((message) => !existingIds.has(String(message.message_id)) && Number(message.message_id) > lastKnownId)
        .slice(-4)
        .map((message) => String(message.message_id)),
    );
    state.messages = messages;
    if (state.activeSection === "chat" && String(state.selectedId) === String(chatId)) {
      paint(root);
      enteringMessageIds.clear();
      const updatedHistory = root.querySelector("#chat-history");
      if (updatedHistory) {
        updatedHistory.scrollTop = wasAtBottom ? updatedHistory.scrollHeight : previousScrollTop;
        updateJumpToBottomButton(root);
      }
    } else {
      enteringMessageIds.clear();
    }
  } catch {
    // Keep the last good history; the visible refresh button can report a manual retry.
  } finally {
    messageRefreshInFlight.delete(chatKey);
  }
}

async function loadAiMetadata(chatId) {
  if (!aiProvidersPromise) {
    aiProvidersPromise = api.listAiProviders().catch(() => []);
  }
  if (!moderatorPromises.has(chatId)) {
    moderatorPromises.set(chatId, api.listModerators(chatId).catch(() => []));
  }
  const [providers, moderators] = await Promise.all([
    aiProvidersPromise,
    moderatorPromises.get(chatId),
  ]);
  if (state.selectedId === chatId) {
    state.aiProviders = providers;
    state.moderators = moderators;
  }
}

function startMessageRefreshTimer(root) {
  if (chatRefreshTimer) window.clearInterval(chatRefreshTimer);
  chatRefreshTimer = null;
  if (state.selectedId === null) return;
  chatRefreshTimer = window.setInterval(() => {
    if (state.activeSection !== "chat" || state.selectedId === null || document.hidden) return;
    void refreshMessages(root, state.selectedId);
  }, 8000);
}

export async function renderPanel(root) {
  chatListRefreshGeneration += 1;
  chatSelectionGeneration += 1;
  stickerLibraryLoadGeneration += 1;
  if (chatRefreshTimer) {
    window.clearInterval(chatRefreshTimer);
    chatRefreshTimer = null;
  }
  if (chatListRefreshTimer) {
    window.clearInterval(chatListRefreshTimer);
    chatListRefreshTimer = null;
  }
  chatListRefreshInFlight = false;
  if (!(await restoreSession())) {
    navigate("/login", { replace: true });
    return;
  }

  state.chats = [];
  state.selectedId = null;
  state.settings = null;
  state.settingsError = "";
  state.messages = [];
  state.messagesChatId = null;
  state.messagesLimit = 200;
  state.messagesLoading = false;
  state.messagesError = "";
  state.chatDraft = "";
  state.replyToMessage = null;
  state.stickerPickerOpen = false;
  state.stickerPickerTab = "stickers";
  state.stickerPickerCollection = "recent";
  state.stickerPickerSearch = "";
  state.stickerLibrary = null;
  state.stickerLibraryLoading = false;
  state.stickerLibraryError = "";
  state.recentStickers = hasExtendedChatAccess() ? readRecentStickers() : [];
  state.chatSending = false;
  state.sendingChatIds = new Set();
  state.activeSection = "chat";
  state.moderators = [];
  root.innerHTML = `<div class="fixed-center"><div class="spinner"></div></div>`;

  try {
    state.chats = await api.listChats({ includeSettings: true });
    if (state.chats.length > 0) {
      state.selectedId = state.chats[0].id;
      state.settings = state.chats[0].settings || null;
      state.messagesChatId = String(state.selectedId);
      state.messagesLoading = true;
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      navigate("/login", { replace: true });
      return;
    }
    console.error(e);
  }

  state.loading = false;
  paint(root);
  if (state.messages.length) scrollChatToBottom(root);
  startMessageRefreshTimer(root);
  if (hasExtendedChatAccess()) {
    chatListRefreshTimer = window.setInterval(() => {
      if (document.hidden) return;
      void refreshChatList(root);
    }, 20_000);
  }
  if (state.selectedId !== null) {
    const initialChatId = state.selectedId;
    if (!state.settings) {
      void loadChat(initialChatId).then(() => {
        if (String(state.selectedId) === String(initialChatId) && state.activeSection === "settings") paint(root);
      }).catch(() => {});
    }
    void loadMessages(initialChatId).then(() => {
      if (String(state.selectedId) !== String(initialChatId)) return;
      if (state.activeSection === "chat") {
        paint(root);
        scrollChatToBottom(root);
      }
    });
  }
  if (state.activeSection === "settings" && state.activeTab === "ai" && state.selectedId) {
    const chatId = state.selectedId;
    loadAiMetadata(chatId).then(() => {
      if (state.activeSection === "settings" && state.activeTab === "ai" && state.selectedId === chatId) paint(root);
    });
  }
}

function paint(root) {
  closeMessageOverlay();
  avatarObserver?.disconnect();
  const user = getCurrentUser();
  const extendedChatAccess = hasExtendedChatAccess(user);
  const selectedChat = state.chats.find((chat) => String(chat.id) === String(state.selectedId));
  const pageTitle = state.activeSection === "chat"
    ? selectedChat?.title || "Чат"
    : TABS.find((tab) => tab.id === state.activeTab)?.label || "Настройки";
  root.innerHTML = `
    <div class="app-shell ${state.activeSection === "chat" ? "chat-screen" : "settings-screen"}">
      <div class="sidebar-backdrop" id="backdrop" hidden></div>
      <aside class="sidebar" id="sidebar">
        <div class="user-row">
          ${
            user?.photoUrl
              ? `<img src="${user.photoUrl}" class="avatar" alt="" />`
              : `<div class="avatar avatar-fallback">${getUserInitials(user)}</div>`
          }
          <div class="user-info">
            <div class="user-name">${escapeHtml(getUserDisplayName(user))}</div>
            <div class="user-sub">${user?.isDemo ? "Демо-режим" : `@${escapeHtml(user?.username || "user")}`}</div>
          </div>
          <button class="icon-btn" id="logout-btn" title="Выйти">⎋</button>
        </div>

        ${extendedChatAccess ? `
          <label class="chat-search-field">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>
            <input id="chat-search" type="search" value="${escapeHtml(state.chatSearch)}" placeholder="Поиск чатов" aria-label="Поиск чатов" autocomplete="off" />
          </label>
          <div class="chat-directory">
            ${chatGroupHtml("admin", "Чаты", sortChatsByLastActivity(state.chats.filter((chat) => chat.isAdmin !== false)), "Нет доступных чатов.")}
            ${chatGroupHtml("bot", "Чаты, где есть бот", sortChatsByLastActivity(state.chats.filter((chat) => chat.isAdmin === false)), "Нет других чатов с ботом.")}
          </div>
        ` : `
          <div class="chat-list-label">Чаты</div>
          <div class="chat-list" id="chat-list">
            ${
              state.chats.filter((chat) => chat.isAdmin !== false).length === 0
                ? `<div class="empty-hint">Нет доступных чатов.</div>`
                : sortChatsByLastActivity(state.chats.filter((chat) => chat.isAdmin !== false)).map((c) => chatItemHtml(c)).join("")
            }
          </div>
        `}
      </aside>

      <main class="main">
        <div class="topbar">
          <button class="icon-btn mobile-only" id="menu-btn" type="button" aria-label="Открыть список чатов" title="Открыть список чатов">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
          </button>
          ${state.activeSection === "chat" ? `
            <div class="chat-header-avatar" aria-hidden="true">
              <span class="avatar-initials">${escapeHtml((selectedChat?.title || "Ч").trim().slice(0, 1).toUpperCase())}</span>
              ${selectedChat ? `<img class="avatar-photo" data-avatar-path="/api/chats/${encodeURIComponent(selectedChat.id)}/avatar" alt="" loading="lazy" hidden />` : ""}
            </div>
          ` : ""}
          <h1 class="page-title">${escapeHtml(pageTitle)}</h1>
          ${state.activeSection === "chat" ? `
            <button class="icon-btn chat-refresh" type="button" data-refresh-chat aria-label="Обновить сообщения" title="Обновить сообщения">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4"/></svg>
            </button>
          ` : ""}
        </div>

        ${state.activeSection === "settings" && state.selectedId ? `
          <nav class="tabs" aria-label="Настройки чата">
            ${TABS.map((t) => `<button class="tab-btn ${t.id === state.activeTab ? "active" : ""}" data-tab="${t.id}">${t.label}</button>`).join("")}
          </nav>
        ` : ""}

        <div id="tab-content" class="${state.activeSection === "chat" ? "chat-tab-content" : ""}">
          ${state.selectedId
            ? state.activeSection === "chat" ? chatTabHtml() : tabContentHtml()
            : emptyStateHtml()}
        </div>
        ${state.selectedId ? `
          <nav class="panel-bottom-nav" aria-label="Раздел группы">
            <button type="button" class="section-tab ${state.activeSection === "chat" ? "active" : ""}" data-section="chat" aria-current="${state.activeSection === "chat" ? "page" : "false"}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-6.5A7.5 7.5 0 1 1 20 11.5Z"/></svg><strong>Чат</strong>
            </button>
            <button type="button" class="section-tab ${state.activeSection === "settings" ? "active" : ""}" data-section="settings" aria-current="${state.activeSection === "settings" ? "page" : "false"}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/><path d="m19.4 15 .1.1 1.1.9-1.5 2.6-1.4-.6a7.8 7.8 0 0 1-1.5.9l-.2 1.5h-3l-.3-1.5a7.8 7.8 0 0 1-1.5-.9l-1.4.6-1.5-2.6 1.2-.9a7.6 7.6 0 0 1 0-1.8l-1.2-.9 1.5-2.6 1.4.6a7.8 7.8 0 0 1 1.5-.9l.3-1.5h3l.2 1.5a7.8 7.8 0 0 1 1.5.9l1.4-.6 1.5 2.6-1.1.9a7.6 7.6 0 0 1-.1 1.8Z"/></svg><strong>Настройки</strong>
            </button>
          </nav>
        ` : ""}
      </main>
    </div>
  `;

  bindEvents(root);
  hydrateAvatars(root);
  hydrateMessageMedia(root);
}

function chatItemHtml(chat) {
  const initials = (chat.title || "").slice(0, 2).toUpperCase();
  const active = String(chat.id) === String(state.selectedId);
  return `
    <button class="chat-item ${active ? "active" : ""}" data-chat-id="${chat.id}" data-chat-search="${escapeHtml(`${chat.title || ""} ${chat.type || ""} ${chat.id}`.toLocaleLowerCase("ru-RU"))}">
      <div class="chat-avatar ${active ? "chat-avatar-active" : ""}">
        <span class="avatar-initials">${escapeHtml(initials)}</span>
        <img class="avatar-photo" data-avatar-path="/api/chats/${encodeURIComponent(chat.id)}/avatar" alt="" loading="lazy" hidden />
      </div>
      <div class="chat-meta">
        <div class="chat-title">${escapeHtml(chat.title)}</div>
        <div class="chat-sub">${escapeHtml(chat.type || "chat")}${chat.privacyAccepted === false ? " · приватность не принята" : ""}</div>
      </div>
    </button>
  `;
}

function chatGroupHtml(groupId, label, chats, emptyMessage) {
  const search = state.chatSearch.trim().toLocaleLowerCase("ru-RU");
  const filteredChats = chats.filter((chat) => {
    const haystack = `${chat.title || ""} ${chat.type || ""} ${chat.id}`.toLocaleLowerCase("ru-RU");
    return !search || haystack.includes(search);
  });
  const collapsed = Boolean(state.collapsedChatGroups[groupId]);
  return `
    <section class="chat-group">
      <button type="button" class="chat-group-toggle" data-chat-group-toggle="${groupId}" aria-expanded="${!collapsed}">
        <span class="chat-list-label">${escapeHtml(label)}</span>
        <span class="chat-group-count">${chats.length}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>
      </button>
      <div class="chat-group-list" data-chat-group-list="${groupId}" ${collapsed ? "hidden" : ""}>
        ${filteredChats.map((chat) => chatItemHtml(chat)).join("")}
        <div class="empty-hint" data-chat-empty="${groupId}" ${filteredChats.length ? "hidden" : ""}>${escapeHtml(search ? "Ничего не найдено." : emptyMessage)}</div>
      </div>
    </section>
  `;
}

function updateChatSearch(root, value) {
  state.chatSearch = value;
  const query = value.trim().toLocaleLowerCase("ru-RU");
  for (const groupId of ["admin", "bot"]) {
    const groupList = root.querySelector(`[data-chat-group-list="${groupId}"]`);
    const toggle = root.querySelector(`[data-chat-group-toggle="${groupId}"]`);
    const collapsed = Boolean(state.collapsedChatGroups[groupId]) && !query;
    if (groupList) groupList.hidden = collapsed;
    if (toggle) toggle.setAttribute("aria-expanded", String(!collapsed));

    const items = [...root.querySelectorAll(`[data-chat-group-list="${groupId}"] .chat-item`)];
    let visibleCount = 0;
    items.forEach((item) => {
      const matches = !query || item.dataset.chatSearch.includes(query);
      item.hidden = !matches;
      if (matches) visibleCount += 1;
    });
    const empty = root.querySelector(`[data-chat-empty="${groupId}"]`);
    if (empty) {
      empty.hidden = visibleCount > 0;
      empty.textContent = query
        ? "Ничего не найдено."
        : groupId === "admin" ? "Нет доступных чатов." : "Нет других чатов с ботом.";
    }
  }
}

function chatActivityTimestamp(chat) {
  const timestamp = Date.parse(chat.lastMessageAt || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortChatsByLastActivity(chats) {
  return chats
    .map((chat, index) => ({ chat, index, timestamp: chatActivityTimestamp(chat) }))
    .sort((a, b) => b.timestamp - a.timestamp || a.index - b.index)
    .map(({ chat }) => chat);
}

function renderChatDirectory(root) {
  const directory = root.querySelector(".chat-directory");
  if (!directory || !hasExtendedChatAccess()) return;

  const scrollTop = directory.scrollTop;
  const adminChats = sortChatsByLastActivity(state.chats.filter((chat) => chat.isAdmin !== false));
  const botChats = sortChatsByLastActivity(state.chats.filter((chat) => chat.isAdmin === false));
  directory.innerHTML = `
    ${chatGroupHtml("admin", "Чаты", adminChats, "Нет доступных чатов.")}
    ${chatGroupHtml("bot", "Чаты, где есть бот", botChats, "Нет других чатов с ботом.")}
  `;
  directory.scrollTop = scrollTop;
  updateChatSearch(root, state.chatSearch);
  bindChatGroupToggles(root);
  bindChatItemEvents(root);
  hydrateAvatars(root);
}

function chatListSignature(chats) {
  return JSON.stringify(chats.map((chat) => [
    String(chat.id),
    chat.title || "",
    chat.type || "",
    chat.isAdmin !== false,
    chat.lastMessageAt || "",
    chat.privacyAccepted !== false,
  ]));
}

async function refreshChatList(root) {
  if (!hasExtendedChatAccess() || chatListRefreshInFlight) return;
  const generation = chatListRefreshGeneration;
  chatListRefreshInFlight = true;
  try {
    const chats = await api.listChats();
    if (generation !== chatListRefreshGeneration || !Array.isArray(chats)) return;
    if (chatListSignature(chats) === chatListSignature(state.chats)) return;

    const selectedStillExists = chats.some(
      (chat) => String(chat.id) === String(state.selectedId),
    );
    state.chats = chats;
    // Keep the current selection unless the server positively confirms it is
    // no longer accessible. Telegram lookup errors are served from the
    // backend's last-known-good membership cache.
    if (state.selectedId !== null && selectedStillExists) {
      renderChatDirectory(root);
      return;
    }

    const nextChat = chats[0] || null;
    state.selectedId = nextChat?.id ?? null;
    chatSelectionGeneration += 1;
    state.settings = nextChat?.settings || null;
    state.settingsError = "";
    state.messages = [];
    state.messagesChatId = null;
    state.messagesLoading = Boolean(nextChat);
    state.messagesError = "";
    state.replyToMessage = null;
    state.chatDraft = "";
    state.chatSending = nextChat ? state.sendingChatIds.has(String(nextChat.id)) : false;
    if (nextChat) {
      await Promise.allSettled([loadChat(nextChat.id), loadMessages(nextChat.id)]);
    }
    if (generation !== chatListRefreshGeneration) return;
    paint(root);
    if (state.activeSection === "chat") scrollChatToBottom(root);
    startMessageRefreshTimer(root);
  } catch {
    // Preserve the last valid chat directory when a background refresh fails.
  } finally {
    if (generation === chatListRefreshGeneration) chatListRefreshInFlight = false;
  }
}

function emptyStateHtml() {
  return `<div class="card center-card"><p>Нет доступных чатов.</p></div>`;
}

function chatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return date.toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function scrollChatToBottom(root, behavior = "auto") {
  const history = root.querySelector("#chat-history");
  if (history) {
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    history.scrollTo({ top: history.scrollHeight, behavior: reducedMotion ? "auto" : behavior });
    window.requestAnimationFrame(() => updateJumpToBottomButton(root));
  }
}

function updateJumpToBottomButton(root) {
  const history = root.querySelector("#chat-history");
  const button = root.querySelector("[data-jump-bottom]");
  if (!history || !button) return;
  const distanceFromBottom = history.scrollHeight - history.clientHeight - history.scrollTop;
  button.hidden = history.scrollHeight <= history.clientHeight + 40 || distanceFromBottom <= 100;
}

function loadAvatarImage(image) {
  if (!image || !image.isConnected) return;
  const path = image.dataset.avatarPath;
  if (!path || image.dataset.avatarRequested) return;
  image.dataset.avatarRequested = "true";
  const cached = avatarUrlCache.get(path);
  const avatarPromise = cached?.expiresAt > Date.now()
    ? cached.promise
    : api.fetchAvatar(path);
  avatarUrlCache.set(path, { expiresAt: Date.now() + 300_000, promise: avatarPromise });
  if (avatarUrlCache.size > 300) avatarUrlCache.delete(avatarUrlCache.keys().next().value);
  avatarPromise.then((url) => {
    if (!url || !image.isConnected) return;
    image.src = url;
    image.hidden = false;
    image.closest(".chat-avatar, .chat-header-avatar, .chat-message-avatar")?.classList.add("has-photo");
  });
}

function hydrateAvatars(root) {
  const images = [...root.querySelectorAll("img[data-avatar-path]")];
  if (!("IntersectionObserver" in window)) {
    images.forEach(loadAvatarImage);
    return;
  }
  if (!avatarObserver) {
    avatarObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        avatarObserver.unobserve(entry.target);
        loadAvatarImage(entry.target.querySelector("img[data-avatar-path]"));
      });
    }, { rootMargin: "180px" });
  }
  images.forEach((image) => {
    const container = image.closest(".chat-avatar, .chat-header-avatar, .chat-message-avatar") || image;
    avatarObserver.observe(container);
  });
}

function clearMessageMediaCache() {
  stopChatAudio();
  for (const cached of messageMediaCache.values()) {
    cached.promise.then((media) => {
      if (media?.url) URL.revokeObjectURL(media.url);
    }).catch(() => {});
  }
  messageMediaCache.clear();
  voiceWaveformCache.clear();
}

const VOICE_WAVEFORM_BAR_COUNT = 48;
const VOICE_PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.8c0-.8.9-1.3 1.6-.8l9.3 6.2a1 1 0 0 1 0 1.6l-9.3 6.2c-.7.5-1.6 0-1.6-.8V5.8Z"/></svg>';
const VOICE_PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM15 5h4v14h-4z"/></svg>';

function formatPlaybackTime(value) {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function getVoiceWaveform(path, blob) {
  if (voiceWaveformCache.has(path)) return voiceWaveformCache.get(path);
  const waveformPromise = (async () => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || !blob) return null;
    let context;
    try {
      context = new AudioContextClass();
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
      const levels = [];

      for (let bar = 0; bar < VOICE_WAVEFORM_BAR_COUNT; bar += 1) {
        const start = Math.floor((bar * decoded.length) / VOICE_WAVEFORM_BAR_COUNT);
        const end = Math.max(start + 1, Math.floor(((bar + 1) * decoded.length) / VOICE_WAVEFORM_BAR_COUNT));
        const stride = Math.max(1, Math.floor((end - start) / 160));
        let sumSquares = 0;
        let peak = 0;
        let samples = 0;
        for (let index = start; index < end; index += stride) {
          let samplePower = 0;
          for (const channel of channels) {
            const sample = channel[index] || 0;
            const magnitude = Math.abs(sample);
            samplePower += sample * sample / Math.max(1, channels.length);
            peak = Math.max(peak, magnitude);
          }
          sumSquares += samplePower;
          samples += 1;
        }
        const rms = Math.sqrt(sumSquares / Math.max(1, samples));
        levels.push(rms * 0.72 + peak * 0.28);
      }

      const maximum = Math.max(...levels, 0.00001);
      return levels.map((level) => Math.round(5 + 29 * Math.pow(level / maximum, 0.72)));
    } catch {
      return null;
    } finally {
      if (context) void context.close().catch(() => {});
    }
  })();
  voiceWaveformCache.set(path, waveformPromise);
  return waveformPromise;
}

function normalizeAudioKind(value) {
  const type = String(typeof value === "object" ? value?.type : value || "").toLowerCase();
  if (type === "voice") return "voice";
  if (type === "music" || type === "audio") return "music";
  if (type === "document" && /\.(mp3|m4a|aac|flac|wav|ogg|opus|oga)$/i.test(String(value?.file_name || ""))) return "music";
  return null;
}

function getAudioMessages(kind = null) {
  return state.messages.filter((message) => {
    const messageKind = normalizeAudioKind(message);
    return message.has_media && messageKind && (!kind || messageKind === kind);
  });
}

function audioMessageTitle(message) {
  if (normalizeAudioKind(message) === "voice") return "Голосовое сообщение";
  const filename = String(message.file_name || "").replace(/\.[^.]+$/, "");
  return String(message.title || filename || message.caption || "Музыка");
}

function audioMessagePerformer(message) {
  if (normalizeAudioKind(message) === "voice") {
    return String(message.sender_name || message.user_name || message.username || "");
  }
  return String(message.performer || message.sender_name || message.user_name || message.username || "");
}

function audioMediaPath(message) {
  return `/api/chats/${encodeURIComponent(state.selectedId)}/messages/${encodeURIComponent(message.message_id)}/media`;
}

function getSelectedAudioMessage() {
  const kind = state.audioKind || "music";
  const current = state.messages.find((message) =>
    String(message.message_id) === String(state.audioMessageId) &&
    normalizeAudioKind(message) === kind &&
    message.has_media
  );
  const messages = getAudioMessages(kind);
  return current || messages[messages.length - 1] || getAudioMessages()[getAudioMessages().length - 1] || null;
}

function getMessageMedia(path) {
  let cached = messageMediaCache.get(path);
  if (!cached) {
    cached = { promise: api.fetchMessageMedia(path) };
    messageMediaCache.set(path, cached);
  }
  return cached.promise;
}

function ensureChatAudioElement() {
  if (chatAudioElement) return chatAudioElement;
  chatAudioElement = document.createElement("audio");
  chatAudioElement.className = "chat-audio-engine";
  chatAudioElement.preload = "metadata";
  chatAudioElement.setAttribute("aria-hidden", "true");
  chatAudioElement.addEventListener("play", updateAudioPlayerViews);
  chatAudioElement.addEventListener("pause", updateAudioPlayerViews);
  chatAudioElement.addEventListener("ended", updateAudioPlayerViews);
  chatAudioElement.addEventListener("loadedmetadata", updateAudioPlayerViews);
  chatAudioElement.addEventListener("durationchange", updateAudioPlayerViews);
  chatAudioElement.addEventListener("timeupdate", updateAudioPlayerViews);
  document.body.appendChild(chatAudioElement);
  return chatAudioElement;
}

function updateAudioPlayerViews() {
  const audio = chatAudioElement;
  const selected = getSelectedAudioMessage();
  const currentMessageId = audio?.dataset.messageId || "";
  const currentChatId = audio?.dataset.chatId || "";
  const isCurrent = Boolean(
    audio &&
    selected &&
    currentChatId === String(state.selectedId) &&
    currentMessageId === String(selected.message_id) &&
    String(state.audioMessageId) === currentMessageId
  );
  const duration = isCurrent && Number.isFinite(audio.duration) && audio.duration > 0
    ? audio.duration
    : Number(selected?.duration) || 0;
  const currentTime = isCurrent ? audio.currentTime || 0 : 0;
  const progress = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
  const playing = isCurrent && !audio.paused;

  document.querySelectorAll("[data-audio-mini]").forEach((mini) => {
    const title = mini.querySelector("[data-audio-mini-title]");
    const performer = mini.querySelector("[data-audio-mini-performer]");
    const toggle = mini.querySelector("[data-audio-toggle]");
    const current = mini.querySelector("[data-audio-mini-current]");
    const total = mini.querySelector("[data-audio-mini-duration]");
    const progressBar = mini.querySelector(".audio-mini-progress > span");
    if (title) title.textContent = selected ? audioMessageTitle(selected) : "Аудио в чате";
    if (performer) performer.textContent = selected ? audioMessagePerformer(selected) : "";
    if (current) current.textContent = formatPlaybackTime(currentTime);
    if (total) total.textContent = formatPlaybackTime(duration);
    if (progressBar) progressBar.style.width = `${progress * 100}%`;
    if (toggle) {
      toggle.innerHTML = playing ? VOICE_PAUSE_ICON : VOICE_PLAY_ICON;
      toggle.setAttribute("aria-label", playing ? "Пауза" : "Воспроизвести");
      toggle.title = playing ? "Пауза" : "Воспроизвести";
    }
    mini.querySelectorAll("[data-audio-kind]").forEach((button) => {
      button.classList.toggle("active", button.dataset.audioKind === state.audioKind);
      button.setAttribute("aria-pressed", String(button.dataset.audioKind === state.audioKind));
    });
  });

  document.querySelectorAll("[data-audio-message-player]").forEach((player) => {
    const playerIsCurrent = isCurrent && player.dataset.audioMessageId === currentMessageId;
    const item = state.messages.find((message) => String(message.message_id) === player.dataset.audioMessageId);
    const itemDuration = playerIsCurrent ? duration : Number(item?.duration) || Number(player.dataset.audioDuration) || 0;
    const itemTime = playerIsCurrent ? currentTime : 0;
    const itemProgress = itemDuration > 0 ? Math.min(1, itemTime / itemDuration) : 0;
    player.classList.toggle("is-playing", playerIsCurrent && playing);
    player.querySelectorAll("[data-audio-play]").forEach((button) => {
      const buttonPlaying = playerIsCurrent && playing;
      button.innerHTML = buttonPlaying ? VOICE_PAUSE_ICON : VOICE_PLAY_ICON;
      button.setAttribute("aria-label", buttonPlaying ? "Поставить на паузу" : "Воспроизвести");
      button.title = buttonPlaying ? "Пауза" : "Воспроизвести";
    });
    const currentLabel = player.querySelector("[data-audio-current]");
    const durationLabel = player.querySelector("[data-audio-duration]");
    if (currentLabel) currentLabel.textContent = formatPlaybackTime(itemTime);
    if (durationLabel) durationLabel.textContent = formatPlaybackTime(itemDuration);
    const waveBars = player.querySelectorAll("[data-voice-wave-bar]");
    waveBars.forEach((bar, index) => {
      bar.classList.toggle("is-played", index < Math.floor(itemProgress * waveBars.length));
    });
    const waveform = player.querySelector(".voice-waveform");
    if (waveform) {
      waveform.setAttribute("aria-valuenow", String(Math.round(itemProgress * 100)));
      waveform.setAttribute("aria-valuetext", `${formatPlaybackTime(itemTime)} из ${formatPlaybackTime(itemDuration)}`);
    }
    const progressBar = player.querySelector(".music-player-progress > span");
    if (progressBar) progressBar.style.width = `${itemProgress * 100}%`;
  });

  if (audioPlayerOverlay) {
    const title = audioPlayerOverlay.querySelector("[data-audio-full-title]");
    const performer = audioPlayerOverlay.querySelector("[data-audio-full-performer]");
    const current = audioPlayerOverlay.querySelector("[data-audio-full-current]");
    const total = audioPlayerOverlay.querySelector("[data-audio-full-duration]");
    const toggle = audioPlayerOverlay.querySelector("[data-audio-full-toggle]");
    const seek = audioPlayerOverlay.querySelector("[data-audio-full-seek]");
    if (title && selected) title.textContent = audioMessageTitle(selected);
    if (performer && selected) performer.textContent = audioMessagePerformer(selected) || (state.audioKind === "voice" ? "Голосовое" : "Исполнитель не указан");
    if (current) current.textContent = formatPlaybackTime(currentTime);
    if (total) total.textContent = formatPlaybackTime(duration);
    if (seek && document.activeElement !== seek) {
      seek.max = String(Math.max(1, Math.floor(duration * 10)));
      seek.value = String(Math.floor(currentTime * 10));
    }
    if (toggle) {
      toggle.innerHTML = playing ? VOICE_PAUSE_ICON : VOICE_PLAY_ICON;
      toggle.setAttribute("aria-label", playing ? "Пауза" : "Воспроизвести");
    }
    audioPlayerOverlay.querySelectorAll("[data-audio-track-id]").forEach((button) => {
      button.classList.toggle("active", button.dataset.audioTrackId === String(state.audioMessageId));
    });
  }
}

function stopChatAudio() {
  audioMessageGeneration += 1;
  if (chatAudioElement) {
    chatAudioElement.pause();
    chatAudioElement.removeAttribute("src");
    delete chatAudioElement.dataset.messageId;
    delete chatAudioElement.dataset.chatId;
    chatAudioElement.load();
  }
  state.audioMessageId = null;
  closeAudioPlayer();
}

async function selectAudioMessage(message, { autoplay = false } = {}) {
  const kind = normalizeAudioKind(message);
  if (!message || !kind || !message.has_media || state.selectedId === null) return false;
  state.audioKind = kind;
  state.audioMessageId = String(message.message_id);
  const generation = ++audioMessageGeneration;
  const chatId = String(state.selectedId);
  const path = audioMediaPath(message);
  const audio = ensureChatAudioElement();
  const sameSource = audio.dataset.chatId === chatId && audio.dataset.messageId === String(message.message_id) && audio.src;

  if (!sameSource) {
    audio.pause();
    const media = await getMessageMedia(path).catch(() => {
      messageMediaCache.delete(path);
      return null;
    });
    if (generation !== audioMessageGeneration || String(state.selectedId) !== chatId) return false;
    if (!media?.url) {
      messageMediaCache.delete(path);
      toast("Не удалось загрузить аудиосообщение.", "error");
      return false;
    }
    audio.src = media.url;
    audio.dataset.chatId = chatId;
    audio.dataset.messageId = String(message.message_id);
    audio.load();
  }

  updateAudioPlayerViews();
  if (autoplay) {
    try {
      await audio.play();
      return true;
    } catch {
      toast("Нажми воспроизведение ещё раз после загрузки аудио.", "error");
      return false;
    }
  }
  return true;
}

function toggleAudioMessage(message) {
  if (!message) return;
  const audio = ensureChatAudioElement();
  const isSelected = audio.dataset.chatId === String(state.selectedId) &&
    audio.dataset.messageId === String(message.message_id) &&
    String(state.audioMessageId) === String(message.message_id);
  if (isSelected && !audio.paused) {
    audio.pause();
    return;
  }
  if (isSelected && audio.src) {
    void audio.play().catch(() => toast("Не удалось воспроизвести аудио.", "error"));
    return;
  }
  void selectAudioMessage(message, { autoplay: true });
}

function seekAudioMessage(message, position) {
  const audio = ensureChatAudioElement();
  const messageId = String(message.message_id);
  const applySeek = () => {
    if (
      audio.dataset.chatId !== String(state.selectedId) ||
      audio.dataset.messageId !== messageId ||
      !Number.isFinite(audio.duration) ||
      audio.duration <= 0
    ) return false;
    const ratio = typeof position === "function" ? position(audio) : position;
    audio.currentTime = Math.min(1, Math.max(0, ratio)) * audio.duration;
    updateAudioPlayerViews();
    return true;
  };
  if (applySeek()) return;
  const onMetadata = () => {
    audio.removeEventListener("loadedmetadata", onMetadata);
    applySeek();
  };
  audio.addEventListener("loadedmetadata", onMetadata);
  void selectAudioMessage(message).then((selected) => {
    if (!selected) audio.removeEventListener("loadedmetadata", onMetadata);
    else applySeek();
  });
}

function switchAudioKind(kind) {
  if (!["voice", "music"].includes(kind)) return;
  const messages = getAudioMessages(kind);
  if (!messages.length) return;
  const continuePlayback = Boolean(chatAudioElement && !chatAudioElement.paused);
  state.audioKind = kind;
  const selected = messages[messages.length - 1];
  state.audioMessageId = String(selected.message_id);
  updateAudioPlayerViews();
  void selectAudioMessage(selected, { autoplay: continuePlayback });
}

function audioMiniPlayerHtml() {
  const messages = getAudioMessages();
  if (!messages.length) return "";
  const voiceAvailable = getAudioMessages("voice").length > 0;
  const musicAvailable = getAudioMessages("music").length > 0;
  if (!getAudioMessages(state.audioKind).length) state.audioKind = musicAvailable ? "music" : "voice";
  const selected = getSelectedAudioMessage();
  const duration = Number(selected?.duration) || 0;
  return `
    <div class="audio-mini-bar" data-audio-mini>
      <div class="audio-mini-switch" role="tablist" aria-label="Тип аудио">
        ${voiceAvailable ? `<button type="button" data-audio-kind="voice" class="${state.audioKind === "voice" ? "active" : ""}" aria-pressed="${state.audioKind === "voice"}">ГС</button>` : ""}
        ${musicAvailable ? `<button type="button" data-audio-kind="music" class="${state.audioKind === "music" ? "active" : ""}" aria-pressed="${state.audioKind === "music"}">Музыка</button>` : ""}
      </div>
      <button type="button" class="audio-mini-open" data-audio-open aria-label="Открыть плеер">
        <span class="audio-mini-note" aria-hidden="true">♫</span>
        <span class="audio-mini-track">
          <strong data-audio-mini-title>${escapeHtml(selected ? audioMessageTitle(selected) : "Аудио в чате")}</strong>
          <small data-audio-mini-performer>${escapeHtml(selected ? audioMessagePerformer(selected) : "")}</small>
          <span class="audio-mini-progress" aria-hidden="true"><span></span></span>
        </span>
        <span class="audio-mini-time"><span data-audio-mini-current>0:00</span><span> / </span><span data-audio-mini-duration>${formatPlaybackTime(duration)}</span></span>
      </button>
      <button type="button" class="audio-mini-toggle" data-audio-toggle aria-label="Воспроизвести" title="Воспроизвести">${VOICE_PLAY_ICON}</button>
    </div>
  `;
}

function openAudioPlayer(root, message = getSelectedAudioMessage()) {
  if (!message) return;
  const kind = normalizeAudioKind(message);
  if (!kind) return;
  closeAudioPlayer();
  state.audioKind = kind;
  state.audioMessageId = String(message.message_id);
  const tracks = getAudioMessages(kind).slice(-40).reverse();
  const overlay = document.createElement("div");
  overlay.className = "audio-player-overlay";
  overlay.innerHTML = `
    <section class="audio-player-dialog" role="dialog" aria-modal="true" aria-label="Аудиоплеер">
      <div class="audio-player-grabber" aria-hidden="true"></div>
      <header class="audio-player-header">
        <span>${kind === "voice" ? "ГОЛОСОВЫЕ" : "МУЗЫКА"}</span>
        <button type="button" data-audio-close aria-label="Закрыть плеер">×</button>
      </header>
      <div class="audio-player-art" aria-hidden="true">${kind === "voice" ? "◖)))" : "♫"}</div>
      <h2 data-audio-full-title>${escapeHtml(audioMessageTitle(message))}</h2>
      <p data-audio-full-performer>${escapeHtml(audioMessagePerformer(message) || (kind === "voice" ? "Голосовое" : "Исполнитель не указан"))}</p>
      <div class="audio-full-seek-wrap">
        <input type="range" data-audio-full-seek min="0" max="${Math.max(1, Math.floor((Number(message.duration) || 0) * 10))}" value="0" step="1" aria-label="Перемотка" />
        <div class="audio-full-times"><span data-audio-full-current>0:00</span><span data-audio-full-duration>${formatPlaybackTime(Number(message.duration) || 0)}</span></div>
      </div>
      <div class="audio-full-controls">
        <button type="button" data-audio-previous aria-label="Предыдущий трек">|◀</button>
        <button type="button" class="audio-full-toggle" data-audio-full-toggle aria-label="Воспроизвести">${VOICE_PLAY_ICON}</button>
        <button type="button" data-audio-next aria-label="Следующий трек">▶|</button>
      </div>
      <div class="audio-player-queue-title">${kind === "voice" ? "Голосовые в чате" : "Музыка в чате"}</div>
      <div class="audio-player-queue">
        ${tracks.map((track) => `
          <button type="button" class="audio-player-track ${String(track.message_id) === String(message.message_id) ? "active" : ""}" data-audio-track-id="${escapeHtml(String(track.message_id))}">
            <span class="audio-player-track-icon" aria-hidden="true">${kind === "voice" ? "◖" : "♫"}</span>
            <span class="audio-player-track-copy"><strong>${escapeHtml(audioMessageTitle(track))}</strong><small>${escapeHtml(audioMessagePerformer(track) || "—")}</small></span>
            <span class="audio-player-track-duration">${formatPlaybackTime(Number(track.duration) || 0)}</span>
          </button>
        `).join("")}
      </div>
    </section>
  `;
  audioPlayerOverlay = overlay;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay || event.target.closest("[data-audio-close]")) closeAudioPlayer();
  });
  overlay.querySelector("[data-audio-full-toggle]")?.addEventListener("click", () => toggleAudioMessage(getSelectedAudioMessage()));
  overlay.querySelector("[data-audio-previous]")?.addEventListener("click", () => stepAudioTrack(-1));
  overlay.querySelector("[data-audio-next]")?.addEventListener("click", () => stepAudioTrack(1));
  overlay.querySelector("[data-audio-full-seek]")?.addEventListener("input", (event) => {
    const audio = ensureChatAudioElement();
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = Number(event.currentTarget.value) / 10;
      updateAudioPlayerViews();
    }
  });
  overlay.querySelectorAll("[data-audio-track-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = tracks.find((item) => String(item.message_id) === button.dataset.audioTrackId);
      if (next) {
        state.audioMessageId = String(next.message_id);
        updateAudioPlayerViews();
        void selectAudioMessage(next, { autoplay: true });
      }
    });
  });
  overlay.escapeHandler = (event) => {
    if (event.key === "Escape") closeAudioPlayer();
  };
  document.addEventListener("keydown", overlay.escapeHandler);
  void selectAudioMessage(message);
}

function closeAudioPlayer() {
  if (!audioPlayerOverlay) return;
  if (audioPlayerOverlay.escapeHandler) document.removeEventListener("keydown", audioPlayerOverlay.escapeHandler);
  audioPlayerOverlay.remove();
  audioPlayerOverlay = null;
}

function stepAudioTrack(direction) {
  const tracks = getAudioMessages(state.audioKind);
  if (tracks.length < 2) return;
  const index = tracks.findIndex((message) => String(message.message_id) === String(state.audioMessageId));
  const nextIndex = (index + direction + tracks.length) % tracks.length;
  void selectAudioMessage(tracks[nextIndex], { autoplay: true });
}

function renderVoiceMessagePlayer(container, media) {
  const message = state.messages.find((item) => String(item.message_id) === container.dataset.messageId);
  if (!message) return;
  const player = document.createElement("div");
  player.className = "voice-player chat-audio-message-player";
  player.dataset.audioMessagePlayer = "true";
  player.dataset.audioMessageId = String(message.message_id);
  player.dataset.audioDuration = String(Number(message.duration) || 0);

  const playButton = document.createElement("button");
  playButton.className = "voice-player-button";
  playButton.type = "button";
  playButton.dataset.audioPlay = "true";
  playButton.setAttribute("aria-label", "Прослушать голосовое сообщение");
  playButton.title = "Прослушать";
  playButton.innerHTML = VOICE_PLAY_ICON;
  playButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleAudioMessage(message);
  });

  const main = document.createElement("div");
  main.className = "voice-player-main";
  const waveform = document.createElement("div");
  waveform.className = "voice-waveform";
  waveform.tabIndex = 0;
  waveform.setAttribute("role", "slider");
  waveform.setAttribute("aria-label", "Позиция голосового сообщения");
  waveform.setAttribute("aria-valuemin", "0");
  waveform.setAttribute("aria-valuemax", "100");
  waveform.setAttribute("aria-valuenow", "0");

  const times = document.createElement("div");
  times.className = "voice-player-times";
  const currentTime = document.createElement("span");
  currentTime.dataset.audioCurrent = "true";
  currentTime.textContent = "0:00";
  const duration = document.createElement("span");
  duration.dataset.audioDuration = "true";
  duration.textContent = formatPlaybackTime(Number(message.duration) || 0);
  times.append(currentTime, duration);
  main.append(waveform, times);
  player.append(playButton, main);
  container.replaceChildren(player);

  const seekTo = (ratio) => {
    seekAudioMessage(message, ratio);
  };
  waveform.addEventListener("click", (event) => {
    event.stopPropagation();
    const bounds = waveform.getBoundingClientRect();
    if (bounds.width > 0) seekTo((event.clientX - bounds.left) / bounds.width);
  });
  waveform.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      seekAudioMessage(message, (audio) => (audio.currentTime + (event.key === "ArrowRight" ? 3 : -3)) / audio.duration);
    } else if (event.key === "Home") {
      event.preventDefault();
      seekTo(0);
    } else if (event.key === "End") {
      event.preventDefault();
      seekTo(1);
    }
  });

  const placeholderHeights = Array(VOICE_WAVEFORM_BAR_COUNT).fill(6);
  waveform.replaceChildren(...placeholderHeights.map((height) => {
    const bar = document.createElement("span");
    bar.className = "voice-wave-bar";
    bar.dataset.voiceWaveBar = "true";
    bar.style.setProperty("--bar-height", `${height}px`);
    return bar;
  }));
  void getVoiceWaveform(container.dataset.mediaPath, media.blob).then((heights) => {
    if (!player.isConnected) return;
    waveform.replaceChildren(...(heights || placeholderHeights).map((height) => {
      const bar = document.createElement("span");
      bar.className = "voice-wave-bar";
      bar.dataset.voiceWaveBar = "true";
      bar.style.setProperty("--bar-height", `${height}px`);
      return bar;
    }));
    updateAudioPlayerViews();
  });
}

function renderMusicMessagePlayer(container) {
  const message = state.messages.find((item) => String(item.message_id) === container.dataset.messageId);
  if (!message) return;
  const player = document.createElement("div");
  player.className = "music-player chat-audio-message-player";
  player.dataset.audioMessagePlayer = "true";
  player.dataset.audioMessageId = String(message.message_id);
  player.dataset.audioDuration = String(Number(message.duration) || 0);

  const playButton = document.createElement("button");
  playButton.className = "music-player-button";
  playButton.type = "button";
  playButton.dataset.audioPlay = "true";
  playButton.innerHTML = VOICE_PLAY_ICON;
  playButton.setAttribute("aria-label", "Воспроизвести музыку");
  playButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleAudioMessage(message);
  });

  const details = document.createElement("button");
  details.className = "music-player-details";
  details.type = "button";
  details.setAttribute("aria-label", `Открыть плеер: ${audioMessageTitle(message)}`);
  details.addEventListener("click", (event) => {
    event.stopPropagation();
    openAudioPlayer(null, message);
  });
  const title = document.createElement("strong");
  title.textContent = audioMessageTitle(message);
  const performer = document.createElement("small");
  performer.textContent = audioMessagePerformer(message) || "Музыка";
  const progress = document.createElement("span");
  progress.className = "music-player-progress";
  progress.setAttribute("aria-hidden", "true");
  progress.append(document.createElement("span"));
  const time = document.createElement("span");
  time.className = "music-player-time";
  time.dataset.audioDuration = "true";
  time.textContent = formatPlaybackTime(Number(message.duration) || 0);
  details.append(title, performer, progress, time);
  player.append(playButton, details);
  container.replaceChildren(player);
  updateAudioPlayerViews();
}

function loadMessageMedia(container) {
  if (!container || !container.isConnected || container.dataset.mediaRequested) return;
  const path = container.dataset.mediaPath;
  if (!path) return;
  container.dataset.mediaRequested = "true";

  getMessageMedia(path).then((media) => {
    if (!container.isConnected) return;
    if (!media?.url) {
      container.innerHTML = container.dataset.mediaKind === "sticker"
        ? `<span class="chat-sticker-fallback" role="img">${escapeHtml(container.dataset.mediaFallback || "Стикер")}</span>`
        : `<span class="chat-media-unavailable">Медиа недоступно</span>`;
      messageMediaCache.delete(path);
      return;
    }

    if (container.dataset.mediaKind === "voice") {
      renderVoiceMessagePlayer(container, media);
      return;
    }

    if (["music", "audio"].includes(container.dataset.mediaKind)) {
      renderMusicMessagePlayer(container);
      return;
    }

    if (media.contentType.startsWith("audio/")) {
      const audio = document.createElement("audio");
      audio.className = "chat-media-audio";
      audio.controls = true;
      audio.preload = "none";
      audio.src = media.url;
      audio.setAttribute("aria-label", "Аудиосообщение");
      container.replaceChildren(audio);
      return;
    }

    if (media.contentType.startsWith("video/")) {
      const video = document.createElement("video");
      video.className = "chat-media-video";
      video.autoplay = true;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.src = media.url;
      video.setAttribute("aria-label", "Анимация из Telegram");
      container.replaceChildren(video);
      return;
    }

    if (media.contentType.startsWith("image/")) {
      const image = document.createElement("img");
      const kind = container.dataset.mediaKind;
      image.className = kind === "sticker" ? "chat-media-sticker" : "chat-media-image";
      image.alt = kind === "sticker" ? "Стикер из Telegram" : kind === "animation" ? "GIF из Telegram" : "Фото из Telegram";
      image.src = media.url;
      container.replaceChildren(image);
      return;
    }

    container.innerHTML = container.dataset.mediaKind === "sticker"
      ? `<span class="chat-sticker-fallback" role="img">${escapeHtml(container.dataset.mediaFallback || "Стикер")}</span>`
      : `<span class="chat-media-unavailable">Формат медиа не поддерживается для предпросмотра</span>`;
  }).catch(() => {
    if (container.isConnected) {
      container.innerHTML = container.dataset.mediaKind === "sticker"
        ? `<span class="chat-sticker-fallback" role="img">${escapeHtml(container.dataset.mediaFallback || "Стикер")}</span>`
        : `<span class="chat-media-unavailable">Не удалось загрузить медиа</span>`;
    }
    messageMediaCache.delete(path);
  });
}

function hydrateMessageMedia(root) {
  const containers = [...root.querySelectorAll("[data-media-path]")];
  if (!containers.length) return;
  if (!("IntersectionObserver" in window)) {
    containers.forEach(loadMessageMedia);
    return;
  }
  if (!messageMediaObserver) {
    messageMediaObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        messageMediaObserver.unobserve(entry.target);
        loadMessageMedia(entry.target);
      });
    }, { rootMargin: "220px" });
  }
  containers.forEach((container) => messageMediaObserver.observe(container));
}

function chatMessageHtml(message) {
  const name = message.sender_name || message.user_name || (message.username ? `@${message.username}` : "Участник");
  const username = String(message.username || "").replace(/^@/, "");
  const outgoing = Boolean(message.is_own_bot || message.is_outgoing);
  const text = message.text || message.caption || "";
  const media = chatMessageMediaHtml(message);
  const body = text ? `<p>${escapeHtml(text)}</p>` : media ? "" : `<p>Сообщение: ${escapeHtml(String(message.type || "без текста").replaceAll("_", " "))}</p>`;
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
  const avatarPath = message.user_id
    ? `/api/chats/${encodeURIComponent(state.selectedId)}/members/${encodeURIComponent(message.user_id)}/avatar`
    : "";
  const repliedMessage = message.reply_to
    ? state.messages.find((item) => String(item.message_id) === String(message.reply_to))
    : null;
  const replyQuoteText = repliedMessage
    ? repliedMessage.text || repliedMessage.caption || "Медиа-сообщение"
    : `Сообщение #${message.reply_to}`;
  const replyQuote = message.reply_to
    ? `<button type="button" class="chat-reply-quote" data-reply-target="${escapeHtml(String(message.reply_to))}" aria-label="Перейти к сообщению, на которое ответили">
        <strong>${escapeHtml(repliedMessage?.sender_name || repliedMessage?.user_name || "Ответ на сообщение")}</strong>
        <span>${escapeHtml(String(replyQuoteText).replace(/\s+/g, " ").slice(0, 90))}</span>
      </button>`
    : "";

  return `
    <article class="chat-message ${outgoing ? "outgoing" : ""} ${enteringMessageIds.has(String(message.message_id)) ? "chat-message-enter" : ""}" data-message-id="${escapeHtml(String(message.message_id ?? ""))}">
      <div class="chat-message-avatar" aria-hidden="true">
        <span class="avatar-initials">${escapeHtml(initials)}</span>
        ${avatarPath ? `<img class="avatar-photo" data-avatar-path="${escapeHtml(avatarPath)}" alt="" loading="lazy" hidden />` : ""}
      </div>
      <div class="chat-message-bubble">
        <div class="chat-message-heading">
          <strong class="chat-message-name">${escapeHtml(name)}</strong>
          ${username ? `<span class="chat-message-username">@${escapeHtml(username)}</span>` : ""}
        </div>
        ${replyQuote}
        ${media}
        ${body}
        <div class="chat-message-footer">
          <button type="button" class="chat-reply-button" data-reply-message aria-label="Ответить на сообщение">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h9a7 7 0 0 1 7 7v2"/></svg>
            <span>Ответить</span>
          </button>
          <time>${chatTime(message.date)}</time>
        </div>
      </div>
    </article>
  `;
}

function formatFileSize(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} Б`;
  const units = ["КБ", "МБ", "ГБ"];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function chatMessageMediaHtml(message) {
  const type = String(message.type || "").toLowerCase();
  if (!message.has_media) return "";
  const messageId = String(message.message_id ?? "");
  const isMusicDocument = type === "document" && /\.(mp3|m4a|aac|flac|wav|ogg|opus|oga)$/i.test(String(message.file_name || ""));

  if (type === "document" && !isMusicDocument) {
    const filename = String(message.file_name || "Документ");
    const extension = filename.includes(".") ? filename.split(".").pop().slice(0, 5).toUpperCase() : "FILE";
    const size = formatFileSize(message.file_size);
    return `
      <div class="chat-document">
        <span class="chat-document-icon" aria-hidden="true">${escapeHtml(extension || "FILE")}</span>
        <span class="chat-document-info">
          <strong title="${escapeHtml(filename)}">${escapeHtml(filename)}</strong>
          <small>${size ? `Документ · ${escapeHtml(size)}` : "Документ"}</small>
        </span>
        <button type="button" class="chat-download-button" data-download-message="${escapeHtml(messageId)}" aria-label="Скачать ${escapeHtml(filename)}" title="Скачать документ">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 16v4h14v-4"/></svg>
          <span>Скачать</span>
        </button>
      </div>
    `;
  }

  if (["voice", "music", "audio"].includes(type) || isMusicDocument) {
    const voice = type === "voice";
    const kind = voice ? "voice" : "music";
    const label = voice ? "Голосовое сообщение" : "Музыка";
    const loading = voice ? "Готовлю волну…" : "Загружаю плеер…";
    return `<div class="chat-message-media ${kind}" data-media-path="/api/chats/${encodeURIComponent(state.selectedId)}/messages/${encodeURIComponent(messageId)}/media" data-media-kind="${kind}" data-message-id="${escapeHtml(messageId)}" aria-label="${label}"><span class="chat-media-loading">${loading}</span></div>`;
  }

  if (!["photo", "sticker", "animation", "gif"].includes(type)) return "";
  let mediaPath = `/api/chats/${encodeURIComponent(state.selectedId)}/messages/${encodeURIComponent(messageId)}/media`;
  if (type === "sticker" && (message.is_animated || message.is_video)) {
    mediaPath += "?thumbnail=1";
  }
  const kind = type === "gif" ? "animation" : type;
  const label = kind === "photo" ? "Загрузка фото…" : kind === "sticker" ? "Загрузка стикера…" : "Загрузка GIF…";
  return `<div class="chat-message-media ${kind === "sticker" ? "sticker" : ""}" data-media-path="${escapeHtml(mediaPath)}" data-media-kind="${escapeHtml(kind)}" data-media-fallback="${escapeHtml(message.sticker_emoji || "Стикер")}" aria-label="${escapeHtml(label)}"><span class="chat-media-loading">${escapeHtml(label)}</span></div>`;
}

function replyPreviewHtml(message) {
  if (!message) return "";
  const author = message.sender_name || message.user_name || "Участник";
  const text = String(message.text || message.caption || "Медиа-сообщение").replace(/\s+/g, " ").slice(0, 120);
  return `
    <div class="reply-preview">
      <div class="reply-preview-mark" aria-hidden="true"></div>
      <div class="reply-preview-copy">
        <strong>Ответ: ${escapeHtml(author)}</strong>
        <span>${escapeHtml(text)}</span>
      </div>
      <button type="button" class="reply-preview-close" data-clear-reply aria-label="Отменить ответ" title="Отменить ответ">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>
    </div>
  `;
}

function stickerPickerHtml() {
  const library = state.stickerLibrary || { sticker_sets: [], gifs: [] };
  const isGifTab = state.stickerPickerTab === "gifs";
  const sets = Array.isArray(library.sticker_sets) ? library.sticker_sets : [];
  const gifs = Array.isArray(library.gifs) ? library.gifs : [];
  const selectedSet = sets.find((item) => item.name === state.stickerPickerCollection);
  const items = isGifTab
    ? gifs
    : state.stickerPickerCollection === "recent"
      ? state.recentStickers
      : (selectedSet?.stickers || []).map((item) => ({ ...item, set_title: selectedSet?.title || item.set_name }));
  const grid = items.map((item) => {
    if (isGifTab) {
      const mediaPath = `/api/sticker-library/gifs/${encodeURIComponent(item.id)}/media`;
      return `
        <button type="button" class="sticker-picker-item gif-picker-item" data-saved-gif-id="${escapeHtml(item.id)}" data-picker-search="${escapeHtml(`${item.name || ""} ${item.file_name || ""} gif` .toLocaleLowerCase("ru-RU"))}" title="${escapeHtml(item.name || "GIF")}">
          <span class="sticker-picker-media gif-picker-media" data-media-path="${escapeHtml(mediaPath)}" data-media-kind="animation"><span class="sticker-picker-placeholder">GIF</span></span>
          <span class="sticker-picker-caption">${escapeHtml(item.name || "GIF")}</span>
        </button>
      `;
    }
    const previewId = item.thumbnail_file_id || item.file_id;
    const setName = item.set_name || state.stickerPickerCollection;
    const mediaPath = `/api/sticker-library/sticker-media?file_id=${encodeURIComponent(previewId)}&set_name=${encodeURIComponent(setName)}`;
    const searchValue = `${item.emoji || ""} ${item.set_title || ""} ${setName}`.toLocaleLowerCase("ru-RU");
    return `
      <button type="button" class="sticker-picker-item" data-sticker-send data-file-id="${escapeHtml(item.file_id)}" data-file-unique-id="${escapeHtml(item.file_unique_id || "")}" data-set-name="${escapeHtml(setName)}" data-emoji="${escapeHtml(item.emoji || "")}" data-thumbnail-file-id="${escapeHtml(previewId)}" data-set-title="${escapeHtml(item.set_title || setName)}" data-picker-search="${escapeHtml(searchValue)}" title="${escapeHtml(`${item.emoji || ""} ${item.set_title || setName}`.trim())}">
        <span class="sticker-picker-media" data-media-path="${escapeHtml(mediaPath)}" data-media-kind="sticker"><span class="sticker-picker-placeholder">${escapeHtml(item.emoji || "☺")}</span></span>
        ${item.emoji ? `<span class="sticker-picker-caption">${escapeHtml(item.emoji)}</span>` : ""}
      </button>
    `;
  }).join("");
  const collectionButtons = isGifTab ? "" : `
    <div class="sticker-picker-collections" aria-label="Стикерпаки">
      <button type="button" class="sticker-collection-btn ${state.stickerPickerCollection === "recent" ? "active" : ""}" data-sticker-collection="recent">Недавние</button>
      ${sets.map((set) => `
        <button type="button" class="sticker-collection-btn ${state.stickerPickerCollection === set.name ? "active" : ""}" data-sticker-collection="${escapeHtml(set.name)}" title="${escapeHtml(set.title || set.name)}">
          ${escapeHtml(set.title || set.name)}
        </button>
      `).join("")}
    </div>
  `;
  const emptyMessage = state.stickerPickerError
    ? state.stickerPickerError
    : state.stickerLibraryLoading
      ? "Загружаю сохранённые стикеры…"
      : isGifTab
        ? "Сохранённых GIF пока нет."
        : state.stickerPickerCollection === "recent"
          ? "Недавних стикеров пока нет. Выберите стикерпак ниже."
          : selectedSet?.unavailable
            ? "Не удалось загрузить стикерпак из Telegram."
            : "В этом стикерпаке нет стикеров.";
  return `
    <section class="sticker-picker" id="sticker-picker" aria-label="Стикеры и GIF">
      <div class="sticker-picker-toolbar">
        <label class="sticker-picker-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>
          <input type="search" data-sticker-search value="${escapeHtml(state.stickerPickerSearch)}" placeholder="Поиск" aria-label="Поиск стикеров" autocomplete="off" />
        </label>
        <div class="sticker-picker-tabs" role="tablist" aria-label="Тип вложения">
          <button type="button" role="tab" data-sticker-tab="stickers" class="${!isGifTab ? "active" : ""}" aria-selected="${!isGifTab}">Стикеры</button>
          <button type="button" role="tab" data-sticker-tab="gifs" class="${isGifTab ? "active" : ""}" aria-selected="${isGifTab}">GIF</button>
        </div>
      </div>
      ${collectionButtons}
      <div class="sticker-picker-grid" data-sticker-grid>${grid}</div>
      <div class="sticker-picker-empty" data-sticker-empty ${grid ? "hidden" : ""}>${escapeHtml(emptyMessage)}</div>
    </section>
  `;
}

function filterStickerPicker(root) {
  const query = state.stickerPickerSearch.trim().toLocaleLowerCase("ru-RU");
  const items = [...(root.querySelectorAll("#sticker-picker [data-picker-search]") || [])];
  let visible = 0;
  items.forEach((item) => {
    const matches = !query || item.dataset.pickerSearch.includes(query);
    item.hidden = !matches;
    if (matches) visible += 1;
  });
  const empty = root.querySelector("#sticker-picker [data-sticker-empty]");
  const grid = root.querySelector("#sticker-picker [data-sticker-grid]");
  if (empty) {
    empty.hidden = visible > 0;
    if (query && visible === 0) empty.textContent = "Ничего не найдено.";
  }
  if (grid) grid.hidden = visible === 0 && (state.stickerLibraryLoading || Boolean(state.stickerPickerError));
}

function bindStickerPickerEvents(root) {
  const picker = root.querySelector("#sticker-picker");
  if (!picker) return;
  picker.querySelector("[data-sticker-search]")?.addEventListener("input", (event) => {
    state.stickerPickerSearch = event.currentTarget.value;
    filterStickerPicker(root);
  });
  picker.querySelectorAll("[data-sticker-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.stickerPickerTab = button.dataset.stickerTab;
      if (state.stickerPickerTab === "gifs") state.stickerPickerCollection = "recent";
      renderStickerPicker(root);
    });
  });
  picker.querySelectorAll("[data-sticker-collection]").forEach((button) => {
    button.addEventListener("click", () => {
      state.stickerPickerCollection = button.dataset.stickerCollection;
      renderStickerPicker(root);
    });
  });
  picker.querySelectorAll("[data-sticker-send]").forEach((button) => {
    button.addEventListener("click", () => {
      void sendStickerFromPicker(root, {
        file_id: button.dataset.fileId,
        file_unique_id: button.dataset.fileUniqueId,
        thumbnail_file_id: button.dataset.thumbnailFileId,
        set_name: button.dataset.setName,
        set_title: button.dataset.setTitle,
        emoji: button.dataset.emoji,
      });
    });
  });
  picker.querySelectorAll("[data-saved-gif-id]").forEach((button) => {
    button.addEventListener("click", () => {
      void sendSavedGifFromPicker(root, button.dataset.savedGifId);
    });
  });
  filterStickerPicker(root);
}

function renderStickerPicker(root) {
  const slot = root.querySelector("#sticker-picker-slot");
  if (!slot) return;
  slot.innerHTML = state.stickerPickerOpen ? stickerPickerHtml() : "";
  if (state.stickerPickerOpen) {
    bindStickerPickerEvents(root);
    hydrateMessageMedia(root);
  }
}

async function loadStickerLibrary(root) {
  if (state.stickerLibraryLoading) return;
  const generation = ++stickerLibraryLoadGeneration;
  state.stickerLibraryLoading = true;
  state.stickerLibraryError = "";
  renderStickerPicker(root);
  try {
    const library = await api.getStickerLibrary();
    if (generation !== stickerLibraryLoadGeneration) return;
    state.stickerLibrary = {
      sticker_sets: Array.isArray(library?.sticker_sets) ? library.sticker_sets : [],
      gifs: Array.isArray(library?.gifs) ? library.gifs : [],
    };
    if (
      state.stickerPickerCollection !== "recent" &&
      !state.stickerLibrary.sticker_sets.some((item) => item.name === state.stickerPickerCollection)
    ) {
      state.stickerPickerCollection = "recent";
    }
  } catch (error) {
    if (generation !== stickerLibraryLoadGeneration) return;
    state.stickerPickerError = error instanceof Error ? error.message : "Не удалось загрузить стикеры.";
  } finally {
    if (generation === stickerLibraryLoadGeneration) {
      state.stickerLibraryLoading = false;
      if (state.stickerPickerOpen) renderStickerPicker(root);
    }
  }
}

function invalidateStickerLibrary(root) {
  stickerLibraryLoadGeneration += 1;
  state.stickerLibrary = null;
  state.stickerLibraryLoading = false;
  state.stickerLibraryError = "";
  if (state.stickerPickerOpen) void loadStickerLibrary(root);
}

function chatTabHtml() {
  const messages = state.messagesChatId === String(state.selectedId) ? state.messages : [];
  const content = state.messagesLoading
    ? `<div class="chat-empty" role="status">Загрузка переписки…</div>`
    : state.messagesError
      ? `<div class="chat-empty chat-error" role="alert">${escapeHtml(state.messagesError)}</div>`
      : messages.length
        ? messages.map(chatMessageHtml).join("")
        : `<div class="chat-empty">Пока сообщений нет.</div>`;

  return `
    <section class="group-chat" aria-label="Переписка группы">
      ${audioMiniPlayerHtml()}
      <div class="chat-history" id="chat-history" aria-live="polite">${content}</div>
      <button type="button" class="chat-jump-bottom" data-jump-bottom aria-label="Перейти к последним сообщениям" title="Последние сообщения" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v15m0 0 6-6m-6 6-6-6"/></svg>
      </button>
      <form class="chat-composer" id="chat-composer">
        ${replyPreviewHtml(state.replyToMessage)}
        ${hasExtendedChatAccess() ? `
          <div id="sticker-picker-slot">${state.stickerPickerOpen ? stickerPickerHtml() : ""}</div>
          <input id="chat-file-input" type="file" multiple hidden />
        ` : ""}
        <div class="chat-composer-row">
          ${hasExtendedChatAccess() ? `
            <button type="button" class="composer-tool" data-attach-file aria-label="Прикрепить файл" title="Прикрепить файл" ${state.chatSending ? "disabled" : ""}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.4 11.1-9.9 9.9a6 6 0 0 1-8.5-8.5l10.6-10.6a4 4 0 0 1 5.7 5.7L8.7 18.2a2 2 0 0 1-2.8-2.8l9.9-9.9"/></svg>
            </button>
            <button type="button" class="composer-tool" data-toggle-stickers aria-label="Открыть стикеры и GIF" title="Стикеры и GIF" aria-expanded="${state.stickerPickerOpen}" ${state.chatSending ? "disabled" : ""}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v11l-5 5H4z"/><path d="M15 20v-5h5"/><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/><path d="M8 14c1.2 1.3 2.3 2 4 2"/></svg>
            </button>
          ` : ""}
          <textarea id="chat-draft" rows="1" maxlength="4096" ${state.chatSending ? "disabled" : ""} placeholder="Сообщение в группу…" aria-label="Сообщение группе">${escapeHtml(state.chatDraft)}</textarea>
          <button type="submit" class="chat-send" aria-label="Отправить сообщение" title="Отправить сообщение" ${state.chatSending || !state.chatDraft.trim() ? "disabled" : ""}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 3-7.2 18-3.7-7.1L3 10.2 21 3Z"/><path d="M10.1 13.9 21 3"/></svg>
          </button>
        </div>
      </form>
    </section>
  `;
}

function tabContentHtml() {
  const s = state.settings;
  if (state.settingsError) {
    return `<div class="card center-card"><p>${escapeHtml(state.settingsError)}</p><button type="button" class="btn btn-secondary" data-retry-settings>Повторить</button></div>`;
  }
  if (!s) return emptyStateHtml();
  switch (state.activeTab) {
    case "antiraid":
      return antiraidTabHtml(s.anti_raid || {});
    case "antispam":
      return antispamTabHtml(s.antispam || {});
    case "nsfw":
      return nsfwTabHtml(s.antinsfw || {});
    case "aimoderator":
      return aiModeratorTabHtml(s.ai_moderator || {});
    case "ai":
      return aiTabHtml(s.ai || {});
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// ANTIRAID
// ---------------------------------------------------------------------------
function antiraidTabHtml(v) {
  const num = (key, def) => `<input type="number" class="input" data-field="${key}" value="${v[key] ?? def}" />`;
  const toggle = (key, label) => toggleFieldHtml(key, label, v[key]);
  return `
    <form class="card" id="form-antiraid" data-section="antiraid">
      ${cardHeader("Антирейд", "Защита от массовых входов и координированных атак.", v.enabled)}
      <div class="grid-2">
        <div class="field"><label>Порог массового входа (человек)</label>${num("join_threshold", 5)}</div>
        <div class="field"><label>Окно входов (сек)</label>${num("join_window", 300)}</div>
        <div class="field"><label>Длительность лockдауна (сек)</label>${num("lockdown_duration", 600)}</div>
        <div class="field"><label>Окно детекта дублей (сек)</label>${num("msg_window", 60)}</div>
        <div class="field"><label>Порог одинаковых тегов у новых</label>${num("same_tag_threshold", 3)}</div>
        <div class="field"><label>Порог одинаковых сообщений</label>${num("same_msg_threshold", 4)}</div>
        <div class="field"><label>Порог одинаковых стикеров</label>${num("same_sticker_threshold", 5)}</div>
      </div>
      <div class="grid-2 mt">
        ${toggle("ban_new_joins", "Банить новых при лockдауне")}
        ${toggle("restrict_chat", "Закрывать чат на запись")}
        ${toggle("ban_during_lockdown", "Банить входящих во время лockдауна")}
        ${toggle("notify_admins", "Уведомлять админов")}
        ${toggle("pin_alert", "Закреплять сообщение о рейде")}
        ${toggle("ban_for_tags", "Банить за теги")}
        ${toggle("delete_links", "Удалять ссылки")}
        ${toggle("analyze_photos", "Анализировать фото")}
      </div>
      <div class="grid-2 mt">${toggle("test_mode", "Тестовый режим (без наказаний)")}</div>
      ${antiRaidStatusHtml()}
      ${saveButtonHtml()}
    </form>
  `;
}

function antiRaidStatusHtml() {
  return `
    <div class="raid-status" id="raid-status">
      <span class="hint">Статус лockдауна загружается…</span>
    </div>
  `;
}

async function loadRaidStatus() {
  const box = document.getElementById("raid-status");
  if (!box) return;
  try {
    const status = await api.getAntiRaidStatus(state.selectedId);
    box.innerHTML = `
      <div class="raid-status-row">
        <span class="badge ${status.lockdownActive ? "badge-danger" : "badge-ok"}">
          ${status.lockdownActive ? "Лockдаун активен" : "Лockдаун не активен"}
        </span>
        <span class="hint">Входов в окне: ${status.joinsInWindow ?? 0} / ${status.joinThreshold ?? 0}</span>
        ${status.lockdownActive ? `<button type="button" class="btn btn-secondary" id="lift-raid-btn">Снять лockдаун</button>` : ""}
      </div>
    `;
    document.getElementById("lift-raid-btn")?.addEventListener("click", async () => {
      try {
        await api.liftAntiRaid(state.selectedId);
        toast("Лockдаун снят");
        loadRaidStatus();
      } catch {
        toast("Не удалось снять лockдаун", "error");
      }
    });
  } catch {
    box.innerHTML = `<span class="hint">Не удалось загрузить статус лockдауна.</span>`;
  }
}

// ---------------------------------------------------------------------------
// ANTISPAM
// ---------------------------------------------------------------------------
function antispamTabHtml(v) {
  const types = { text: true, sticker: true, gif: true, photo: true, video: true, document: true, voice: true, ...(v.types || {}) };
  return `
    <form class="card" id="form-antispam" data-section="antispam">
      ${cardHeader("Антиспам", "Автоматическая реакция на флуд и спам-сообщения.", v.enabled)}
      <div class="grid-2">
        <div class="field"><label>Сообщений</label><input type="number" class="input" data-field="threshold_count" value="${v.threshold_count ?? 5}" /></div>
        <div class="field"><label>За период (сек)</label><input type="number" class="input" data-field="threshold_seconds" value="${v.threshold_seconds ?? 10}" /></div>
        <div class="field"><label>Лимит повторов (дубли)</label><input type="number" class="input" data-field="duplicate_limit" value="${v.duplicate_limit ?? 3}" /></div>
        <div class="field">
          <label>Наказание</label>
          <select class="input" data-field="punishment">
            ${["мут", "бан"].map((p) => `<option value="${p}" ${v.punishment === p ? "selected" : ""}>${p}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>Длительность</label><input type="number" class="input" data-field="duration" value="${v.duration ?? 30}" /></div>
        <div class="field">
          <label>Единица</label>
          <select class="input" data-field="unit">
            ${["сек", "мин", "час", "день"].map((u) => `<option value="${u}" ${v.unit === u ? "selected" : ""}>${u}</option>`).join("")}
          </select>
        </div>
      </div>

      <div class="section-label mt-lg">Реакция по типам сообщений</div>
      <div class="grid-2">
        ${Object.entries(ANTISPAM_TYPE_LABELS)
          .map(([key, label]) => `
            <div class="toggle-field">
              <label>${label}</label>
              <label class="switch">
                <input type="checkbox" data-type-field="${key}" ${types[key] ? "checked" : ""} />
                <span class="switch-track"><span class="switch-thumb"></span></span>
              </label>
            </div>`)
          .join("")}
      </div>

      <div class="grid-2 mt">${toggleFieldHtml("test_mode", "Тестовый режим (только уведомления, без наказаний)", v.test_mode)}</div>

      ${saveButtonHtml()}
    </form>
  `;
}

// ---------------------------------------------------------------------------
// NSFW
// ---------------------------------------------------------------------------
function nsfwTabHtml(v) {
  return `
    <form class="card" id="form-nsfw" data-section="nsfw">
      ${cardHeader("Защита 18+", "Автоматическое обнаружение и модерация NSFW-контента.", v.enabled)}
      <div class="grid-2">
        <div class="field">
          <label>Наказание</label>
          <select class="input" data-field="punishment">
            ${["мут", "бан"].map((p) => `<option value="${p}" ${v.punishment === p ? "selected" : ""}>${p}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>Длительность</label><input type="number" class="input" data-field="duration" value="${v.duration ?? 30}" /></div>
        <div class="field">
          <label>Единица</label>
          <select class="input" data-field="unit">
            ${["сек", "мин", "час", "день"].map((u) => `<option value="${u}" ${v.unit === u ? "selected" : ""}>${u}</option>`).join("")}
          </select>
        </div>
      </div>
      ${saveButtonHtml()}
    </form>
  `;
}

// ---------------------------------------------------------------------------
// AI ЧАТ (личность/промпт для обычных ответов бота -- НЕ модератор, см.
// aiModeratorTabHtml ниже для настоящей ИИ-модерации).
// ---------------------------------------------------------------------------
function aiTabHtml(v) {
  const providers = state.aiProviders.length
    ? state.aiProviders
    : [{ id: v.ai_provider || "laozhang", label: v.ai_provider || "laozhang", models: v.ai_model ? [v.ai_model] : [] }];
  const currentProvider = providers.find((p) => p.id === v.ai_provider) || providers[0];
  const hasKey = !!v.providerKeys?.[v.ai_provider];

  return `
    <form class="card" id="form-ai" data-section="ai">
      ${cardHeader("ИИ чат", "Личность и провайдер ИИ для обычных ответов бота в чате.", v.ai_enabled, "ai_enabled")}

      <div class="field">
        <label>Личность / стиль общения</label>
        <input type="text" class="input" data-field="personality" value="${escapeHtml(v.personality || "")}" placeholder="нейтральный" />
      </div>
      <div class="field mt">
        <label>Правила / промпт модерации</label>
        <textarea class="input textarea" data-field="custom" rows="4" placeholder="Запрещены: оскорбления, спам, реклама…">${escapeHtml(v.custom || "")}</textarea>
      </div>

      <div class="grid-2 mt">
        <div class="field">
          <label>Провайдер ИИ</label>
          <select class="input" id="ai-provider-select" data-field="ai_provider">
            ${providers.map((p) => `<option value="${p.id}" ${p.id === v.ai_provider ? "selected" : ""}>${p.label}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>Модель</label>
          <select class="input" id="ai-model-select" data-field="ai_model">
            ${(currentProvider?.models || []).map((m) => `<option value="${m}" ${m === v.ai_model ? "selected" : ""}>${m}</option>`).join("")}
          </select>
        </div>
      </div>

      <div class="field mt">
        <label>API-ключ провайдера ${hasKey ? '<span class="hint">(сохранён)</span>' : ""}</label>
        <div class="key-row">
          <input type="password" class="input" id="api-key-input" placeholder="${hasKey ? "••••••••" : "Вставьте API-ключ"}" />
          <button type="button" class="btn btn-secondary" id="save-key-btn">Сохранить ключ</button>
          ${hasKey ? `<button type="button" class="btn btn-danger" id="delete-key-btn">Удалить</button>` : ""}
        </div>
      </div>

      ${saveButtonHtml()}
      ${moderatorsHtml()}
    </form>
  `;
}

// ---------------------------------------------------------------------------
// ИИ МОДЕРАТОР (bot/handlers/ai_moderator.py) -- отдельная от "ИИ чат" фича:
// автоматически читает сообщения и сам решает warn/delete/mute/ban по
// заданным правилам. Раньше эта вкладка на самом деле сохраняла настройки
// личности/провайдера обычного чат-бота, поэтому переключатель тут ничего
// не включал -- теперь бьётся в свой собственный набор эндпоинтов.
// ---------------------------------------------------------------------------
function aiModeratorTabHtml(v) {
  const providerLabels = { auto: "Авто", github: "GitHub Models", laozhang: "LaoZhang" };
  const hasAnyKey = !!(v.has_github_key || v.has_laozhang_key);
  return `
    <form class="card" id="form-aimoderator" data-section="aimoderator">
      ${cardHeader("ИИ модератор", "ИИ читает сообщения чата и сам применяет предупреждение, удаление, мут или бан по заданным правилам.", v.enabled)}

      ${!hasAnyKey ? `<p class="hint" style="text-align:left;margin-bottom:16px;">⚠️ Добавьте хотя бы один API-ключ ниже, иначе включить ИИ-модератора не получится.</p>` : ""}

      <div class="field">
        <label>Правила модерации</label>
        <textarea class="input textarea" data-field="rules" rows="5" placeholder="Запрещены: оскорбления, мат, флуд/спам, реклама, NSFW-контент…">${escapeHtml(v.rules || "")}</textarea>
      </div>

      <div class="grid-2 mt">
        <div class="field"><label>Кулдаун между проверками (сек)</label><input type="number" min="0" class="input" data-field="cooldown_seconds" value="${v.cooldown_seconds ?? 2}" /></div>
        <div class="field">
          <label>Провайдер ИИ</label>
          <select class="input" data-field="provider">
            ${Object.entries(providerLabels).map(([id, label]) => `<option value="${id}" ${v.provider === id ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>Модель GitHub Models</label><input type="text" class="input" data-field="github_model" value="${escapeHtml(v.github_model || "gpt-4o")}" /></div>
      </div>

      <div class="field mt">
        <label>Ключ GitHub Models ${v.has_github_key ? '<span class="hint">(сохранён)</span>' : ""}</label>
        <div class="key-row">
          <input type="password" class="input" id="aimod-github-key-input" placeholder="${v.has_github_key ? "••••••••" : "ghp_… / github_pat_…"}" />
          <button type="button" class="btn btn-secondary" id="aimod-save-github-key">Сохранить</button>
          ${v.has_github_key ? `<button type="button" class="btn btn-danger" id="aimod-delete-github-key">Удалить</button>` : ""}
        </div>
      </div>

      <div class="field mt">
        <label>Ключ LaoZhang ${v.has_laozhang_key ? '<span class="hint">(сохранён)</span>' : ""}</label>
        <div class="key-row">
          <input type="password" class="input" id="aimod-laozhang-key-input" placeholder="${v.has_laozhang_key ? "••••••••" : "sk-… / lz-…"}" />
          <button type="button" class="btn btn-secondary" id="aimod-save-laozhang-key">Сохранить</button>
          ${v.has_laozhang_key ? `<button type="button" class="btn btn-danger" id="aimod-delete-laozhang-key">Удалить</button>` : ""}
        </div>
      </div>

      ${saveButtonHtml()}
    </form>
  `;
}

function moderatorsHtml() {
  if (!state.moderators.length) return "";
  return `
    <div class="mt">
      <div class="section-label">Модераторы чата</div>
      <div class="mod-list">
        ${state.moderators
          .map(
            (m) => `
          <div class="mod-item">
            <div class="chat-avatar">
              <span class="avatar-initials">${escapeHtml((m.name || "?").slice(0, 2).toUpperCase())}</span>
              <img class="avatar-photo" data-avatar-path="/api/chats/${encodeURIComponent(state.selectedId)}/members/${encodeURIComponent(m.id)}/avatar" alt="" loading="lazy" hidden />
            </div>
            <div>
              <div class="mod-name">${escapeHtml(m.name)}</div>
              <div class="hint">${m.status}</div>
            </div>
          </div>`
          )
          .join("")}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------
function cardHeader(title, desc, enabledField, enabledFieldName = "enabled") {
  return `
    <div class="card-header">
      <div>
        <h2>${title}</h2>
        <p>${desc}</p>
      </div>
      <label class="switch">
        <input type="checkbox" data-field="${enabledFieldName}" ${enabledField ? "checked" : ""} />
        <span class="switch-track"><span class="switch-thumb"></span></span>
      </label>
    </div>
  `;
}

function toggleFieldHtml(key, label, checked) {
  return `
    <div class="toggle-field">
      <label>${label}</label>
      <label class="switch">
        <input type="checkbox" data-field="${key}" ${checked ? "checked" : ""} />
        <span class="switch-track"><span class="switch-thumb"></span></span>
      </label>
    </div>
  `;
}

function saveButtonHtml() {
  return `<div class="save-status mt-lg" id="save-status" data-state="idle"><span class="save-status-dot"></span><span class="save-status-text">Изменения сохраняются автоматически</span></div>`;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function collectFormData(form) {
  const data = {};
  form.querySelectorAll("[data-field]").forEach((el) => {
    const key = el.dataset.field;
    if (el.type === "checkbox") data[key] = el.checked;
    else if (el.type === "number") data[key] = Number(el.value);
    else data[key] = el.value;
  });
  // Per-type toggles (antispam: text/sticker/gif/photo/video/document/voice)
  // are nested under a single "types" object server-side, not top-level
  // fields, so they use a separate data-type-field attribute and get folded
  // into data.types here.
  const typeEls = form.querySelectorAll("[data-type-field]");
  if (typeEls.length) {
    const types = {};
    typeEls.forEach((el) => {
      types[el.dataset.typeField] = el.checked;
    });
    data.types = types;
  }
  return data;
}

function setSaveStatus(form, state_) {
  // state_: "saving" | "saved" | "error" | "idle"
  const el = form.querySelector("#save-status");
  if (!el) return;
  el.dataset.state = state_;
  const text = el.querySelector(".save-status-text");
  if (!text) return;
  if (state_ === "saving") text.textContent = "Сохранение…";
  else if (state_ === "saved") text.textContent = "Сохранено";
  else if (state_ === "error") text.textContent = "Не удалось сохранить";
  else text.textContent = "Изменения сохраняются автоматически";
}

async function saveSection(section, form) {
  const body = collectFormData(form);
  setSaveStatus(form, "saving");
  try {
    let updated;
    if (section === "antiraid") updated = await api.patchAntiRaid(state.selectedId, body);
    else if (section === "antispam") updated = await api.patchAntispam(state.selectedId, body);
    else if (section === "nsfw") updated = await api.patchAntinsfw(state.selectedId, body);
    else if (section === "ai") updated = await api.patchAi(state.selectedId, body);
    else if (section === "aimoderator") updated = await api.patchAiModerator(state.selectedId, body);

    const sectionKey =
      section === "nsfw" ? "antinsfw" : section === "antiraid" ? "anti_raid" : section === "aimoderator" ? "ai_moderator" : section;
    state.settings[sectionKey] = updated;
    setSaveStatus(form, "saved");
    toast(`${SECTION_LABELS[section] || "Настройки"}: сохранено`);
    setTimeout(() => setSaveStatus(form, "idle"), 1800);
  } catch (e) {
    console.error(e);
    setSaveStatus(form, "error");
    const msg = e instanceof ApiError && e.data && e.data.error ? e.data.error : "не удалось сохранить";
    toast(`${SECTION_LABELS[section] || "Настройки"}: ${msg}`, "error");
  }
}

const SECTION_LABELS = {
  antiraid: "Антирейд",
  antispam: "Антиспам",
  nsfw: "Защита 18+",
  ai: "ИИ чат",
  aimoderator: "ИИ модератор",
};

// Debounced autosave: checkboxes/selects save instantly on change,
// text/number inputs debounce a bit after the user stops typing so we don't
// spam a PATCH request per keystroke.
const AUTOSAVE_DEBOUNCE_MS = 500;
const autosaveTimers = new WeakMap();

function scheduleAutosave(section, form, immediate) {
  if (immediate) {
    clearTimeout(autosaveTimers.get(form));
    autosaveTimers.delete(form);
    saveSection(section, form);
    return;
  }
  clearTimeout(autosaveTimers.get(form));
  const timer = setTimeout(() => {
    autosaveTimers.delete(form);
    saveSection(section, form);
  }, AUTOSAVE_DEBOUNCE_MS);
  autosaveTimers.set(form, timer);
}

function attachAutosave(form) {
  const section = form.dataset.section;
  form.querySelectorAll("[data-field], [data-type-field]").forEach((el) => {
    const immediate = el.type === "checkbox" || el.tagName === "SELECT";
    const eventName = immediate ? "change" : "input";
    el.addEventListener(eventName, () => scheduleAutosave(section, form, immediate));
    // number/text inputs also save on blur so a value survives even if the
    // user clicks away before the debounce timer fires.
    if (!immediate) {
      el.addEventListener("blur", () => scheduleAutosave(section, form, true));
    }
  });
}

function closeMessageOverlay() {
  if (longPressTimer) {
    window.clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  if (messageOverlay?.escapeHandler) {
    document.removeEventListener("keydown", messageOverlay.escapeHandler);
  }
  messageOverlay?.remove();
  messageOverlay = null;
}

function setMessageOverlay(overlay) {
  closeMessageOverlay();
  messageOverlay = overlay;
  overlay.escapeHandler = (event) => {
    if (event.key === "Escape") closeMessageOverlay();
  };
  document.addEventListener("keydown", overlay.escapeHandler);
  document.body.appendChild(overlay);
}

function showMessageActionMenu(root, message, x, y) {
  closeMessageOverlay();
  const hasUser = Boolean(message.user_id && !message.is_bot && !message.is_own_bot);
  const canCopy = Boolean(message.text || message.caption);
  const owner = hasExtendedChatAccess();
  const messageType = String(message.type || "").toLowerCase();
  const canSaveStickerPack = owner && messageType === "sticker";
  const canSaveGif = owner && ["animation", "gif"].includes(messageType);
  const overlay = document.createElement("div");
  overlay.className = "message-action-backdrop";
  overlay.innerHTML = `
    <div class="message-action-menu" role="menu" aria-label="Действия с сообщением">
      <button type="button" role="menuitem" data-message-action="delete" ${message.message_id ? "" : "disabled"}>Удалить сообщение</button>
      <button type="button" role="menuitem" data-message-action="copy" ${canCopy ? "" : "disabled"}>Скопировать</button>
      ${hasUser ? `
        <div class="message-menu-divider"></div>
        <button type="button" role="menuitem" data-message-action="ban" data-banned="false" disabled>Проверка статуса…</button>
        <button type="button" role="menuitem" data-message-action="mute" disabled>Мут</button>
      ` : ""}
      ${canSaveStickerPack ? `<div class="message-menu-divider"></div><button type="button" role="menuitem" data-message-action="save-sticker-pack">Сохранить стикерпак</button>` : ""}
      ${canSaveGif ? `<div class="message-menu-divider"></div><button type="button" role="menuitem" data-message-action="save-gif">Сохранить GIF</button>` : ""}
      <div class="message-menu-divider"></div>
      <button type="button" role="menuitem" data-message-action="reply" ${message.message_id ? "" : "disabled"}>Ответить</button>
    </div>
  `;
  setMessageOverlay(overlay);

  const menu = overlay.querySelector(".message-action-menu");
  const bounds = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(Number(x) || 8, window.innerWidth - bounds.width - 8));
  const top = Math.max(8, Math.min(Number(y) || 8, window.innerHeight - bounds.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      closeMessageOverlay();
      return;
    }
    const button = event.target.closest?.("[data-message-action]");
    if (!button || button.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    void performMessageAction(root, message, button);
  });

  if (hasUser) {
    const banButton = menu.querySelector('[data-message-action="ban"]');
    const muteButton = menu.querySelector('[data-message-action="mute"]');
    api.getMemberModeration(state.selectedId, message.user_id).then((status) => {
      if (messageOverlay !== overlay) return;
      if (!status.can_moderate) {
        banButton.hidden = true;
        muteButton.hidden = true;
        return;
      }
      banButton.dataset.banned = String(Boolean(status.is_banned));
      banButton.textContent = status.is_banned ? "Разбанить" : "Забанить";
      banButton.disabled = false;
      muteButton.hidden = !status.can_mute;
      muteButton.disabled = false;
    }).catch(() => {
      if (messageOverlay !== overlay) return;
      banButton.textContent = "Статус недоступен";
      banButton.disabled = true;
      muteButton.disabled = true;
    });
  }
}

async function copyMessageText(message) {
  const text = String(message.text || message.caption || "");
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const copyField = document.createElement("textarea");
      copyField.value = text;
      copyField.style.position = "fixed";
      copyField.style.opacity = "0";
      document.body.appendChild(copyField);
      copyField.select();
      const copied = document.execCommand("copy");
      copyField.remove();
      if (!copied) throw new Error("copy_failed");
    }
    toast("Текст скопирован");
  } catch {
    toast("Не удалось скопировать текст.", "error");
  }
}

function startReply(root, message) {
  state.replyToMessage = message;
  closeMessageOverlay();
  paint(root);
  root.querySelector("#chat-draft")?.focus();
}

async function performMessageAction(root, message, button) {
  const action = button.dataset.messageAction;
  const chatId = state.selectedId;
  const userId = message.user_id;
  if (chatId === null) return closeMessageOverlay();

  if (action === "reply") {
    startReply(root, message);
    return;
  }
  if (action === "copy") {
    closeMessageOverlay();
    await copyMessageText(message);
    return;
  }
  if (action === "save-sticker-pack") {
    closeMessageOverlay();
    try {
      const result = await api.saveStickerPack(chatId, message.message_id);
      invalidateStickerLibrary(root);
      state.stickerPickerCollection = result?.name || "recent";
      toast(`Стикерпак «${result?.title || "Сохранён"}» добавлен`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Не удалось сохранить стикерпак.", "error");
    }
    return;
  }
  if (action === "save-gif") {
    closeMessageOverlay();
    try {
      await api.saveGif(chatId, message.message_id);
      invalidateStickerLibrary(root);
      toast("GIF сохранена в вашей панели");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Не удалось сохранить GIF.", "error");
    }
    return;
  }
  if (action === "delete") {
    closeMessageOverlay();
    if (!window.confirm("Удалить это сообщение из группы?")) return;
    try {
      await api.deleteMessage(chatId, message.message_id);
      state.messages = state.messages.filter(
        (item) => String(item.message_id) !== String(message.message_id),
      );
      paint(root);
      toast("Сообщение удалено");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Не удалось удалить сообщение.", "error");
    }
    return;
  }
  if (action === "ban") {
    const isBanned = button.dataset.banned === "true";
    closeMessageOverlay();
    if (!isBanned && !window.confirm("Забанить этого участника в группе?")) return;
    if (isBanned && !window.confirm("Разбанить этого участника?")) return;
    try {
      if (isBanned) await api.unbanMember(chatId, userId);
      else await api.banMember(chatId, userId);
      toast(isBanned ? "Пользователь разбанен" : "Пользователь забанен");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Не удалось изменить бан.", "error");
    }
    return;
  }
  if (action === "mute") {
    closeMessageOverlay();
    showMuteDialog(root, message);
  }
}

function showMuteDialog(root, message) {
  const overlay = document.createElement("div");
  overlay.className = "message-action-backdrop modal-backdrop";
  overlay.innerHTML = `
    <section class="message-action-dialog" role="dialog" aria-modal="true" aria-labelledby="mute-dialog-title">
      <h2 id="mute-dialog-title">Срок мута</h2>
      <div class="mute-duration-grid">
        <button type="button" data-duration="60" data-duration-label="1 мин">1 мин</button>
        <button type="button" data-duration="300" data-duration-label="5 мин">5 мин</button>
        <button type="button" data-duration="1800" data-duration-label="30 мин">30 мин</button>
        <button type="button" data-duration="3600" data-duration-label="1 час">1 час</button>
        <button type="button" data-duration="7200" data-duration-label="2 часа">2 часа</button>
        <button type="button" data-duration="18000" data-duration-label="5 часов">5 часов</button>
        <button type="button" data-duration="86400" data-duration-label="24 часа">24 часа</button>
        <button type="button" data-duration="31536000" data-duration-label="1 год">1 год</button>
      </div>
      <button type="button" class="mute-custom-toggle" data-custom-toggle>Выбрать срок</button>
      <form class="mute-custom-form" data-custom-form hidden>
        <label class="mute-custom-field">
          <span>Срок</span>
          <input type="number" min="1" step="1" value="1" data-custom-value required />
        </label>
        <select aria-label="Единица срока" data-custom-unit>
          <option value="3600">Час</option>
          <option value="60" selected>мин</option>
        </select>
        <button type="submit" class="mute-confirm" data-custom-confirm>Подтвердить</button>
      </form>
      <button type="button" class="mute-cancel" data-close-dialog>Отмена</button>
    </section>
  `;
  setMessageOverlay(overlay);
  overlay.querySelector(".message-action-dialog").addEventListener("click", (event) => event.stopPropagation());
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeMessageOverlay();
  });
  overlay.querySelector("[data-close-dialog]").addEventListener("click", closeMessageOverlay);
  overlay.querySelectorAll("[data-duration]").forEach((button) => {
    button.addEventListener("click", () => {
      void applyMuteDuration(
        root,
        message,
        Number(button.dataset.duration),
        button.dataset.durationLabel,
        button,
      );
    });
  });
  overlay.querySelector("[data-custom-toggle]").addEventListener("click", () => {
    const form = overlay.querySelector("[data-custom-form]");
    form.hidden = false;
    overlay.querySelector("[data-custom-value]").focus();
  });
  overlay.querySelector("[data-custom-form]").addEventListener("submit", (event) => {
    event.preventDefault();
    const amount = Number(overlay.querySelector("[data-custom-value]").value);
    const unitSeconds = Number(overlay.querySelector("[data-custom-unit]").value);
    const durationSeconds = amount * unitSeconds;
    if (!Number.isInteger(amount) || amount < 1 || durationSeconds > 31_536_000) {
      toast("Срок должен быть не меньше 1 и не больше 1 года.", "error");
      return;
    }
    const unitLabel = unitSeconds === 3600 ? "ч." : "мин.";
    void applyMuteDuration(root, message, durationSeconds, `${amount} ${unitLabel}`, event.submitter);
  });
}

async function applyMuteDuration(root, message, durationSeconds, label, trigger) {
  if (trigger) trigger.disabled = true;
  try {
    await api.muteMember(state.selectedId, message.user_id, durationSeconds);
    closeMessageOverlay();
    toast(`Мут установлен на ${label}`);
  } catch (error) {
    if (trigger) trigger.disabled = false;
    toast(error instanceof Error ? error.message : "Не удалось замутить пользователя.", "error");
  }
}

function bindAudioMiniPlayer(root) {
  root.querySelector("[data-audio-mini]")?.addEventListener("click", (event) => {
    if (event.target.closest?.("[data-audio-kind], [data-audio-toggle], [data-audio-open]")) return;
    openAudioPlayer(root);
  });
  root.querySelectorAll("[data-audio-kind]").forEach((button) => {
    button.addEventListener("click", () => switchAudioKind(button.dataset.audioKind));
  });
  root.querySelector("[data-audio-toggle]")?.addEventListener("click", () => {
    toggleAudioMessage(getSelectedAudioMessage());
  });
  root.querySelector("[data-audio-open]")?.addEventListener("click", () => {
    openAudioPlayer(root);
  });
  updateAudioPlayerViews();
}

function bindMessageGestures(root) {
  root.querySelectorAll(".chat-message").forEach((article) => {
    const message = state.messages.find(
      (item) => String(item.message_id) === String(article.dataset.messageId),
    );
    if (!message) return;
    let longPressTriggered = false;
    article.querySelector("[data-reply-message]")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      startReply(root, message);
    });
    article.querySelector("[data-download-message]")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void downloadChatDocument(event.currentTarget, message);
    });
    article.querySelector("[data-reply-target]")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void jumpToReplyTarget(root, event.currentTarget.dataset.replyTarget, event.currentTarget);
    });
    let startX = 0;
    let startY = 0;

    article.addEventListener("pointerdown", (event) => {
      if (event.target.closest?.("button, a")) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      longPressTriggered = false;
      startX = event.clientX;
      startY = event.clientY;
      if (longPressTimer) window.clearTimeout(longPressTimer);
      longPressTimer = window.setTimeout(() => {
        longPressTimer = null;
        longPressTriggered = true;
        showMessageActionMenu(root, message, startX, startY);
      }, 500);
    });
    article.addEventListener("pointermove", (event) => {
      if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10) {
        if (longPressTimer) window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((eventName) => {
      article.addEventListener(eventName, () => {
        if (longPressTimer) window.clearTimeout(longPressTimer);
        longPressTimer = null;
      });
    });
    article.addEventListener("click", (event) => {
      if (event.target.closest?.("button, a")) return;
      event.preventDefault();
      if (longPressTriggered) {
        longPressTriggered = false;
        return;
      }
      if (event.target.closest?.(".music-player, .chat-message-media.music")) {
        openAudioPlayer(root, message);
        return;
      }
      showMessageActionMenu(root, message, event.clientX, event.clientY);
    });
    article.addEventListener("contextmenu", (event) => {
      if (event.target.closest?.("button, a")) return;
      event.preventDefault();
      showMessageActionMenu(root, message, event.clientX, event.clientY);
    });
  });
}

async function downloadChatDocument(button, message) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    const result = await api.downloadMessageMedia(state.selectedId, message.message_id);
    const url = URL.createObjectURL(result.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = result.fileName || message.file_name || `document-${message.message_id}`;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast("Загрузка документа началась");
  } catch (error) {
    toast(error instanceof Error ? error.message : "Не удалось скачать документ.", "error");
  } finally {
    button.disabled = false;
  }
}

function highlightChatMessage(root, messageId) {
  const target = [...root.querySelectorAll(".chat-message[data-message-id]")]
    .find((article) => article.dataset.messageId === String(messageId));
  if (!target) return false;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
  target.classList.remove("chat-message-target");
  void target.offsetWidth;
  target.classList.add("chat-message-target");
  window.setTimeout(() => target.classList.remove("chat-message-target"), 1500);
  return true;
}

function bindChatGroupToggles(root) {
  root.querySelectorAll("[data-chat-group-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const groupId = button.dataset.chatGroupToggle;
      state.collapsedChatGroups[groupId] = !state.collapsedChatGroups[groupId];
      const groupList = root.querySelector(`[data-chat-group-list="${groupId}"]`);
      if (groupList) groupList.hidden = state.collapsedChatGroups[groupId];
      button.setAttribute("aria-expanded", String(!state.collapsedChatGroups[groupId]));
    });
  });
}

function bindChatItemEvents(root) {
  root.querySelectorAll(".chat-item").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const chatId = btn.dataset.chatId;
      if (String(state.selectedId) === String(chatId)) {
        root.querySelector("#sidebar")?.classList.remove("open");
        const backdrop = root.querySelector("#backdrop");
        if (backdrop) backdrop.hidden = true;
        return;
      }
      const selectionGeneration = ++chatSelectionGeneration;
      if (state.messagesChatId && state.messagesChatId !== String(chatId)) clearMessageMediaCache();
      state.selectedId = chatId;
      state.activeSection = "chat";
      state.settings = null;
      state.settingsError = "";
      state.messages = [];
      state.messagesChatId = String(chatId);
      state.messagesLimit = 200;
      state.messagesLoading = true;
      state.messagesError = "";
      state.chatDraft = "";
      state.replyToMessage = null;
      state.stickerPickerOpen = false;
      state.stickerPickerSearch = "";
      state.chatSending = state.sendingChatIds.has(String(chatId));
      paint(root);
      root.querySelector("#sidebar")?.classList.remove("open");
      const backdrop = root.querySelector("#backdrop");
      if (backdrop) backdrop.hidden = true;
      await Promise.allSettled([loadChat(chatId), loadMessages(chatId)]);
      if (selectionGeneration !== chatSelectionGeneration || String(state.selectedId) !== String(chatId)) return;
      if (state.activeSection === "settings" && state.activeTab === "ai") await loadAiMetadata(chatId);
      paint(root);
      if (state.activeSection === "chat") scrollChatToBottom(root);
    });
  });
}

function normalizeOutgoingMessage(response) {
  const message = response?.message ?? response;
  return {
    ...message,
    sender_name: message?.sender_name || message?.user_name || "Бот",
    is_bot: true,
    is_own_bot: true,
    is_outgoing: true,
  };
}

function appendOutgoingMessages(sentMessages) {
  const knownIds = new Set(state.messages.map((message) => String(message.message_id)));
  const normalized = sentMessages.map(normalizeOutgoingMessage);
  state.messages = [
    ...state.messages,
    ...normalized.filter((message) => !knownIds.has(String(message.message_id))),
  ];
  state.messagesChatId = String(state.selectedId);
  state.messagesError = "";
  enteringMessageIds = new Set(normalized.map((message) => String(message.message_id)));
}

function finishSendingForChat(chatId) {
  state.sendingChatIds.delete(String(chatId));
  state.chatSending = state.sendingChatIds.has(String(state.selectedId));
}

async function sendStickerFromPicker(root, sticker) {
  const chatId = state.selectedId;
  if (chatId === null || state.chatSending || !sticker.file_id || !sticker.set_name) return;
  const replyMessage = state.replyToMessage;
  const chatKey = String(chatId);
  state.sendingChatIds.add(chatKey);
  state.chatSending = true;
  state.stickerPickerOpen = false;
  paint(root);
  try {
    const response = await api.sendSticker(
      chatId,
      sticker,
      replyMessage?.message_id || null,
    );
    finishSendingForChat(chatId);
    if (String(state.selectedId) !== String(chatId)) return;
    state.replyToMessage = null;
    appendOutgoingMessages([response]);
    rememberSticker(sticker);
    paint(root);
    enteringMessageIds.clear();
    scrollChatToBottom(root);
    void refreshChatList(root);
  } catch (error) {
    finishSendingForChat(chatId);
    if (String(state.selectedId) === String(chatId)) {
      state.stickerPickerOpen = true;
      paint(root);
    }
    toast(error instanceof Error ? error.message : "Не удалось отправить стикер.", "error");
  }
}

async function sendSavedGifFromPicker(root, gifId) {
  const chatId = state.selectedId;
  if (chatId === null || state.chatSending || !gifId) return;
  const replyMessage = state.replyToMessage;
  const chatKey = String(chatId);
  state.sendingChatIds.add(chatKey);
  state.chatSending = true;
  state.stickerPickerOpen = false;
  paint(root);
  try {
    const response = await api.sendSavedGif(chatId, gifId, replyMessage?.message_id || null);
    finishSendingForChat(chatId);
    if (String(state.selectedId) !== String(chatId)) return;
    state.replyToMessage = null;
    appendOutgoingMessages([response]);
    paint(root);
    enteringMessageIds.clear();
    scrollChatToBottom(root);
    void refreshChatList(root);
  } catch (error) {
    finishSendingForChat(chatId);
    if (String(state.selectedId) === String(chatId)) {
      state.stickerPickerOpen = true;
      paint(root);
    }
    toast(error instanceof Error ? error.message : "Не удалось отправить GIF.", "error");
  }
}

async function sendSelectedFiles(root, fileList) {
  const files = Array.from(fileList || []);
  const chatId = state.selectedId;
  if (!files.length || chatId === null || state.chatSending) return;

  const caption = state.chatDraft.trim();
  const replyMessage = state.replyToMessage;
  const chatKey = String(chatId);
  state.sendingChatIds.add(chatKey);
  state.chatSending = true;
  const fileInput = root.querySelector("#chat-file-input");
  if (fileInput) fileInput.value = "";
  paint(root);

  const sentMessages = [];
  let sendError = null;
  for (let index = 0; index < files.length; index += 1) {
    try {
      const response = await api.sendMedia(chatId, files[index], {
        caption: index === 0 ? caption : "",
        replyToMessageId: replyMessage?.message_id || null,
      });
      sentMessages.push(response);
      if (index === 0 && String(state.selectedId) === String(chatId)) state.chatDraft = "";
    } catch (error) {
      sendError = error;
      break;
    }
  }

  finishSendingForChat(chatId);
  if (String(state.selectedId) !== String(chatId)) {
    if (sendError) toast(sendError instanceof Error ? sendError.message : "Не удалось отправить файл.", "error");
    return;
  }
  if (sentMessages.length) {
    state.replyToMessage = null;
    appendOutgoingMessages(sentMessages);
  } else {
    state.chatDraft = caption;
    state.replyToMessage = replyMessage;
  }
  paint(root);
  enteringMessageIds.clear();
  if (sentMessages.length) {
    scrollChatToBottom(root);
    void refreshChatList(root);
  }
  if (sendError) {
    const sentCount = sentMessages.length;
    const detail = sendError instanceof Error ? sendError.message : "Ошибка отправки.";
    toast(sentCount ? `Отправлено ${sentCount} из ${files.length}; остальные файлы не отправлены. ${detail}` : detail, "error");
  } else if (files.length > 1) {
    toast(`Отправлено файлов: ${sentMessages.length}`);
  }
}

async function jumpToReplyTarget(root, messageId, trigger) {
  if (highlightChatMessage(root, messageId)) return;
  const chatId = state.selectedId;
  if (chatId === null) return;

  trigger.disabled = true;
  try {
    const response = await api.listMessages(chatId, 500);
    const messages = Array.isArray(response) ? response : response?.messages;
    if (!Array.isArray(messages) || String(state.selectedId) !== String(chatId)) return;
    if (!messages.some((message) => String(message.message_id) === String(messageId))) {
      toast("Исходное сообщение не найдено в сохранённой истории.", "error");
      return;
    }
    state.messagesLimit = 500;
    state.messages = messages;
    state.messagesChatId = String(chatId);
    paint(root);
    window.requestAnimationFrame(() => {
      if (!highlightChatMessage(root, messageId)) {
        toast("Не удалось перейти к исходному сообщению.", "error");
      }
    });
  } catch (error) {
    toast(error instanceof Error ? error.message : "Не удалось найти исходное сообщение.", "error");
  } finally {
    if (trigger.isConnected) trigger.disabled = false;
  }
}

function bindEvents(root) {
  bindMessageGestures(root);
  bindAudioMiniPlayer(root);

  const chatHistory = root.querySelector("#chat-history");
  chatHistory?.addEventListener("scroll", () => updateJumpToBottomButton(root), { passive: true });
  root.querySelector("[data-jump-bottom]")?.addEventListener("click", () => scrollChatToBottom(root, "smooth"));
  updateJumpToBottomButton(root);

  root.querySelector("#logout-btn")?.addEventListener("click", () => {
    if (chatRefreshTimer) {
      window.clearInterval(chatRefreshTimer);
      chatRefreshTimer = null;
    }
    if (chatListRefreshTimer) {
      window.clearInterval(chatListRefreshTimer);
      chatListRefreshTimer = null;
    }
    chatListRefreshGeneration += 1;
    logout();
    navigate("/login", { replace: true });
  });

  root.querySelector("#menu-btn")?.addEventListener("click", () => {
    root.querySelector("#sidebar")?.classList.add("open");
    const bd = root.querySelector("#backdrop");
    if (bd) bd.hidden = false;
  });
  root.querySelector("#backdrop")?.addEventListener("click", () => {
    root.querySelector("#sidebar")?.classList.remove("open");
    root.querySelector("#backdrop").hidden = true;
  });

  root.querySelector("#chat-search")?.addEventListener("input", (event) => {
    updateChatSearch(root, event.currentTarget.value);
  });

  bindChatGroupToggles(root);
  bindChatItemEvents(root);
  bindStickerPickerEvents(root);

  root.querySelector("[data-attach-file]")?.addEventListener("click", () => {
    if (!state.chatSending) root.querySelector("#chat-file-input")?.click();
  });
  root.querySelector("#chat-file-input")?.addEventListener("change", (event) => {
    void sendSelectedFiles(root, event.currentTarget.files);
  });
  root.querySelector("[data-toggle-stickers]")?.addEventListener("click", () => {
    if (state.chatSending) return;
    state.stickerPickerOpen = !state.stickerPickerOpen;
    paint(root);
    if (state.stickerPickerOpen && !state.stickerLibrary) void loadStickerLibrary(root);
  });

  root.querySelectorAll(".section-tab").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.activeSection = btn.dataset.section;
      paint(root);
      if (state.activeSection === "chat" && state.selectedId !== null) {
        const chatId = state.selectedId;
        await loadMessages(chatId);
        if (String(state.selectedId) === String(chatId)) {
          paint(root);
          scrollChatToBottom(root);
        }
      }
      if (state.activeSection === "settings" && state.activeTab === "ai" && state.selectedId) {
        const chatId = state.selectedId;
        await loadAiMetadata(chatId);
        if (state.activeSection === "settings" && String(state.selectedId) === String(chatId)) paint(root);
      }
    });
  });

  root.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeTab = btn.dataset.tab;
      paint(root);
      if (state.activeTab === "ai" && state.selectedId) {
        const chatId = state.selectedId;
        loadAiMetadata(chatId).then(() => {
          if (state.activeTab === "ai" && state.selectedId === chatId) paint(root);
        });
      }
    });
  });

  root.querySelector("[data-retry-settings]")?.addEventListener("click", async () => {
    const chatId = state.selectedId;
    if (chatId === null) return;
    await loadChat(chatId).catch(() => {});
    if (String(state.selectedId) === String(chatId) && state.activeSection === "settings") paint(root);
  });

  root.querySelector("[data-refresh-chat]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const chatId = state.selectedId;
    await loadMessages(chatId);
    if (String(state.selectedId) === String(chatId) && state.activeSection === "chat") paint(root);
  });

  const chatDraft = root.querySelector("#chat-draft");
  root.querySelector("[data-clear-reply]")?.addEventListener("click", () => {
    state.replyToMessage = null;
    paint(root);
    root.querySelector("#chat-draft")?.focus();
  });
  chatDraft?.addEventListener("input", (event) => {
    state.chatDraft = event.currentTarget.value;
    const sendButton = root.querySelector(".chat-send");
    if (sendButton) sendButton.disabled = state.chatSending || !state.chatDraft.trim();
  });
  chatDraft?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  });

  root.querySelector("#chat-composer")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = state.chatDraft.trim();
    const chatId = state.selectedId;
    const replyMessage = state.replyToMessage;
    if (!text || chatId === null || state.chatSending) return;

    const chatKey = String(chatId);
    state.sendingChatIds.add(chatKey);
    state.chatSending = true;
    state.chatDraft = "";
    const draftField = root.querySelector("#chat-draft");
    const sendButton = root.querySelector(".chat-send");
    if (draftField) {
      draftField.value = "";
      draftField.disabled = true;
    }
    if (sendButton) sendButton.disabled = true;
    try {
      const response = await api.sendMessage(chatId, {
        text,
        ...(replyMessage?.message_id ? { reply_to_message_id: replyMessage.message_id } : {}),
      });
      const sentMessage = response?.message ?? response;
      state.sendingChatIds.delete(chatKey);
      state.chatSending = state.sendingChatIds.has(String(state.selectedId));
      if (String(state.selectedId) !== String(chatId)) {
        if (state.activeSection === "chat") paint(root);
        return;
      }
      const normalized = {
        ...sentMessage,
        sender_name: sentMessage.sender_name || sentMessage.user_name || "Бот",
        is_bot: true,
        is_own_bot: true,
        is_outgoing: true,
      };
      state.messages = [
        ...state.messages.filter((message) => String(message.message_id) !== String(normalized.message_id)),
        normalized,
      ];
      state.messagesChatId = String(chatId);
      state.messagesError = "";
      if (state.replyToMessage === replyMessage) state.replyToMessage = null;
      enteringMessageIds = new Set([String(normalized.message_id)]);
      paint(root);
      enteringMessageIds.clear();
      scrollChatToBottom(root);
      void refreshChatList(root);
    } catch (error) {
      state.sendingChatIds.delete(chatKey);
      state.chatSending = state.sendingChatIds.has(String(state.selectedId));
      if (String(state.selectedId) !== String(chatId)) {
        if (state.activeSection === "chat") paint(root);
        return;
      }
      state.chatDraft = text;
      state.replyToMessage = replyMessage;
      const restoredDraft = root.querySelector("#chat-draft");
      const restoredSendButton = root.querySelector(".chat-send");
      if (restoredDraft) {
        restoredDraft.value = text;
        restoredDraft.disabled = false;
      }
      if (restoredSendButton) {
        restoredSendButton.disabled = state.chatSending || !text.trim();
      }
      toast(error instanceof Error ? error.message : "Не удалось отправить сообщение.", "error");
    }
  });

  const form = root.querySelector("#tab-content form");
  if (form) {
    // No explicit save button anymore -- every field autosaves as soon as
    // it changes (see attachAutosave). Still guard against accidental
    // Enter-key submits inside text inputs.
    form.addEventListener("submit", (e) => e.preventDefault());
    attachAutosave(form);

    if (state.activeTab === "antiraid") loadRaidStatus();

    if (state.activeTab === "ai") {
      const providerSelect = form.querySelector("#ai-provider-select");
      const modelSelect = form.querySelector("#ai-model-select");
      providerSelect?.addEventListener("change", () => {
        const provider = state.aiProviders.find((p) => p.id === providerSelect.value);
        modelSelect.innerHTML = (provider?.models || [])
          .map((m) => `<option value="${m}">${m}</option>`)
          .join("");
      });

      form.querySelector("#save-key-btn")?.addEventListener("click", async () => {
        const provider = providerSelect.value;
        const key = form.querySelector("#api-key-input").value.trim();
        if (!key) return toast("Введите API-ключ", "error");
        try {
          const updated = await api.setAiApiKey(state.selectedId, provider, key);
          state.settings.ai = updated;
          toast("Ключ сохранён");
          paint(root);
        } catch {
          toast("Не удалось сохранить ключ", "error");
        }
      });

      form.querySelector("#delete-key-btn")?.addEventListener("click", async () => {
        const provider = providerSelect.value;
        try {
          const updated = await api.deleteAiApiKey(state.selectedId, provider);
          state.settings.ai = updated;
          toast("Ключ удалён");
          paint(root);
        } catch {
          toast("Не удалось удалить ключ", "error");
        }
      });
    }

    if (state.activeTab === "aimoderator") {
      const setAimodKey = async (provider, inputId) => {
        const input = form.querySelector(`#${inputId}`);
        const key = input?.value.trim();
        if (!key) return toast("Введите API-ключ", "error");
        try {
          const updated = await api.setAiModeratorKey(state.selectedId, provider, key);
          state.settings.ai_moderator = updated;
          toast("Ключ сохранён");
          paint(root);
        } catch {
          toast("Не удалось сохранить ключ", "error");
        }
      };
      const deleteAimodKey = async (provider) => {
        try {
          const updated = await api.deleteAiModeratorKey(state.selectedId, provider);
          state.settings.ai_moderator = updated;
          toast("Ключ удалён");
          paint(root);
        } catch {
          toast("Не удалось удалить ключ", "error");
        }
      };

      form.querySelector("#aimod-save-github-key")?.addEventListener("click", () => setAimodKey("github", "aimod-github-key-input"));
      form.querySelector("#aimod-delete-github-key")?.addEventListener("click", () => deleteAimodKey("github"));
      form.querySelector("#aimod-save-laozhang-key")?.addEventListener("click", () => setAimodKey("laozhang", "aimod-laozhang-key-input"));
      form.querySelector("#aimod-delete-laozhang-key")?.addEventListener("click", () => deleteAimodKey("laozhang"));
    }
  }
}
