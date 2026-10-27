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

let state = {
  chats: [],
  selectedId: null,
  settings: null,
  settingsError: "",
  moderators: [],
  aiProviders: [],
  activeSection: "chat",
  activeTab: "antiraid",
  messages: [],
  messagesChatId: null,
  messagesLoading: false,
  messagesError: "",
  chatDraft: "",
  replyToMessage: null,
  chatSending: false,
  sendingChatIds: new Set(),
  loading: true,
  saving: false,
};

let aiProvidersPromise = null;
const moderatorPromises = new Map();
const avatarUrlCache = new Map();
const messageMediaCache = new Map();
let chatRefreshTimer = null;
let messageOverlay = null;
let longPressTimer = null;
let avatarObserver = null;
let messageMediaObserver = null;

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
    const response = await api.listMessages(chatId);
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
  try {
    const response = await api.listMessages(chatId);
    const messages = Array.isArray(response) ? response : response?.messages;
    if (!Array.isArray(messages) || String(state.selectedId) !== String(chatId)) return;
    const currentIds = state.messages.map((message) => String(message.message_id)).join(",");
    const nextIds = messages.map((message) => String(message.message_id)).join(",");
    const contentChanged = currentIds !== nextIds || messages.some((message, index) => {
      const current = state.messages[index];
      return current && (current.text !== message.text || current.username !== message.username);
    });
    if (!contentChanged) return;

    const history = root.querySelector("#chat-history");
    const wasAtBottom = history && history.scrollHeight - history.clientHeight - history.scrollTop < 40;
    const previousScrollTop = history?.scrollTop ?? 0;
    state.messages = messages;
    if (state.activeSection === "chat" && String(state.selectedId) === String(chatId)) {
      paint(root);
      const updatedHistory = root.querySelector("#chat-history");
      if (updatedHistory) updatedHistory.scrollTop = wasAtBottom ? updatedHistory.scrollHeight : previousScrollTop;
    }
  } catch {
    // Keep the last good history; the visible refresh button can report a manual retry.
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

export async function renderPanel(root) {
  if (chatRefreshTimer) {
    window.clearInterval(chatRefreshTimer);
    chatRefreshTimer = null;
  }
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
  state.messagesError = "";
  state.chatDraft = "";
  state.replyToMessage = null;
  state.chatSending = false;
  state.sendingChatIds = new Set();
  state.activeSection = "chat";
  state.moderators = [];
  root.innerHTML = `<div class="fixed-center"><div class="spinner"></div></div>`;

  try {
    state.chats = await api.listChats({ includeSettings: true });
    if (state.chats.length > 0) {
      state.selectedId = state.chats[0].id;
      if (state.chats[0].settings) state.settings = state.chats[0].settings;
      else await loadChat(state.selectedId).catch(() => {});
      await loadMessages(state.selectedId);
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
  scrollChatToBottom(root);
  if (state.selectedId !== null) {
    chatRefreshTimer = window.setInterval(() => {
      if (state.activeSection !== "chat" || state.selectedId === null || document.hidden) return;
      void refreshMessages(root, state.selectedId);
    }, 8000);
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

        <div class="chat-list-label">Чаты</div>
        <div class="chat-list" id="chat-list">
          ${
            state.chats.length === 0
              ? `<div class="empty-hint">Нет доступных чатов.</div>`
              : state.chats.map((c) => chatItemHtml(c)).join("")
          }
        </div>
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
    <button class="chat-item ${active ? "active" : ""}" data-chat-id="${chat.id}">
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

function emptyStateHtml() {
  return `<div class="card center-card"><p>Нет доступных чатов.</p></div>`;
}

function chatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return date.toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function scrollChatToBottom(root) {
  const history = root.querySelector("#chat-history");
  if (history) history.scrollTop = history.scrollHeight;
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
  for (const cached of messageMediaCache.values()) {
    cached.promise.then((media) => {
      if (media?.url) URL.revokeObjectURL(media.url);
    }).catch(() => {});
  }
  messageMediaCache.clear();
}

function loadMessageMedia(container) {
  if (!container || !container.isConnected || container.dataset.mediaRequested) return;
  const path = container.dataset.mediaPath;
  if (!path) return;
  container.dataset.mediaRequested = "true";

  let cached = messageMediaCache.get(path);
  if (!cached) {
    cached = { promise: api.fetchMessageMedia(path) };
    messageMediaCache.set(path, cached);
  }

  cached.promise.then((media) => {
    if (!container.isConnected) return;
    if (!media?.url) {
      container.innerHTML = `<span class="chat-media-unavailable">Медиа недоступно</span>`;
      messageMediaCache.delete(path);
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

    container.innerHTML = `<span class="chat-media-unavailable">Формат медиа не поддерживается для предпросмотра</span>`;
  }).catch(() => {
    if (container.isConnected) {
      container.innerHTML = `<span class="chat-media-unavailable">Не удалось загрузить медиа</span>`;
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

  return `
    <article class="chat-message ${outgoing ? "outgoing" : ""}" data-message-id="${escapeHtml(String(message.message_id ?? ""))}">
      <div class="chat-message-avatar" aria-hidden="true">
        <span class="avatar-initials">${escapeHtml(initials)}</span>
        ${avatarPath ? `<img class="avatar-photo" data-avatar-path="${escapeHtml(avatarPath)}" alt="" loading="lazy" hidden />` : ""}
      </div>
      <div class="chat-message-bubble">
        <div class="chat-message-heading">
          <strong class="chat-message-name">${escapeHtml(name)}</strong>
          ${username ? `<span class="chat-message-username">@${escapeHtml(username)}</span>` : ""}
        </div>
        ${repliedMessage ? `<div class="chat-reply-quote"><strong>${escapeHtml(repliedMessage.sender_name || repliedMessage.user_name || "Участник")}</strong><span>${escapeHtml(String(repliedMessage.text || repliedMessage.caption || "Медиа-сообщение").replace(/\s+/g, " ").slice(0, 90))}</span></div>` : ""}
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

  if (type === "document") {
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

  if (!["photo", "sticker", "animation", "gif"].includes(type)) return "";
  let mediaPath = `/api/chats/${encodeURIComponent(state.selectedId)}/messages/${encodeURIComponent(messageId)}/media`;
  if (type === "sticker" && (message.is_animated || message.is_video)) {
    if (!message.has_thumbnail) {
      return `<div class="chat-sticker-fallback" role="img" aria-label="Анимированный стикер">${escapeHtml(message.sticker_emoji || "Анимированный стикер")}</div>`;
    }
    mediaPath += "?thumbnail=1";
  }
  const kind = type === "gif" ? "animation" : type;
  const label = kind === "photo" ? "Загрузка фото…" : kind === "sticker" ? "Загрузка стикера…" : "Загрузка GIF…";
  return `<div class="chat-message-media ${kind === "sticker" ? "sticker" : ""}" data-media-path="${escapeHtml(mediaPath)}" data-media-kind="${escapeHtml(kind)}" aria-label="${escapeHtml(label)}"><span class="chat-media-loading">${escapeHtml(label)}</span></div>`;
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
      <div class="chat-history" id="chat-history" aria-live="polite">${content}</div>
      <form class="chat-composer" id="chat-composer">
        ${replyPreviewHtml(state.replyToMessage)}
        <div class="chat-composer-row">
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

function bindMessageGestures(root) {
  root.querySelectorAll(".chat-message").forEach((article) => {
    const message = state.messages.find(
      (item) => String(item.message_id) === String(article.dataset.messageId),
    );
    if (!message) return;
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
    let startX = 0;
    let startY = 0;

    article.addEventListener("pointerdown", (event) => {
      if (event.target.closest?.("button, a, video")) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      startX = event.clientX;
      startY = event.clientY;
      if (longPressTimer) window.clearTimeout(longPressTimer);
      longPressTimer = window.setTimeout(() => {
        longPressTimer = null;
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
    article.addEventListener("contextmenu", (event) => {
      if (event.target.closest?.("button, a, video")) return;
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

function bindEvents(root) {
  bindMessageGestures(root);

  root.querySelector("#logout-btn")?.addEventListener("click", () => {
    if (chatRefreshTimer) {
      window.clearInterval(chatRefreshTimer);
      chatRefreshTimer = null;
    }
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

  root.querySelectorAll(".chat-item").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const chatId = btn.dataset.chatId;
      state.selectedId = chatId;
      state.activeSection = "chat";
      state.settings = null;
      state.settingsError = "";
      state.messages = [];
      state.messagesChatId = String(chatId);
      state.messagesLoading = true;
      state.messagesError = "";
      state.chatDraft = "";
      state.replyToMessage = null;
      state.chatSending = state.sendingChatIds.has(String(chatId));
      paint(root);
      await Promise.allSettled([loadChat(chatId), loadMessages(chatId)]);
      if (state.selectedId !== chatId) return;
      if (state.activeSection === "settings" && state.activeTab === "ai") await loadAiMetadata(chatId);
      paint(root);
      if (state.activeSection === "chat") scrollChatToBottom(root);
    });
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
    paint(root);
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
      paint(root);
      scrollChatToBottom(root);
    } catch (error) {
      state.sendingChatIds.delete(chatKey);
      state.chatSending = state.sendingChatIds.has(String(state.selectedId));
      if (String(state.selectedId) !== String(chatId)) {
        if (state.activeSection === "chat") paint(root);
        return;
      }
      state.chatDraft = text;
      state.replyToMessage = replyMessage;
      paint(root);
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
