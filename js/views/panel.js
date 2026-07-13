import { api, ApiError } from "../api.js";
import { getCurrentUser, getUserInitials, getUserDisplayName, logout, restoreSession } from "../auth.js";
import { navigate } from "../router.js";

const TABS = [
  { id: "antiraid", label: "Антирейд" },
  { id: "antispam", label: "Антиспам" },
  { id: "nsfw", label: "Защита 18+" },
  { id: "ai", label: "ИИ модератор" },
];

let state = {
  chats: [],
  selectedId: null,
  settings: null,
  moderators: [],
  aiProviders: [],
  activeTab: "antiraid",
  loading: true,
  saving: false,
};

function toast(msg, type = "success") {
  const el = document.createElement("div");
  el.className = `toast ${type === "error" ? "toast-error" : ""}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

async function loadChat(chatId) {
  const [settings, moderators] = await Promise.all([
    api.getSettings(chatId),
    api.listModerators(chatId).catch(() => []),
  ]);
  state.settings = settings;
  state.moderators = moderators;
}

export async function renderPanel(root) {
  if (!(await restoreSession())) {
    navigate("/login", { replace: true });
    return;
  }

  root.innerHTML = `<div class="fixed-center"><div class="spinner"></div></div>`;

  try {
    state.chats = await api.listChats();
    state.aiProviders = await api.listAiProviders().catch(() => []);
    if (state.chats.length > 0) {
      state.selectedId = state.chats[0].id;
      await loadChat(state.selectedId);
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
}

function paint(root) {
  const user = getCurrentUser();
  root.innerHTML = `
    <div class="app-shell">
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
              ? `<div class="empty-hint">Бот пока не состоит ни в одном чате, где вы админ.</div>`
              : state.chats.map((c) => chatItemHtml(c)).join("")
          }
        </div>
      </aside>

      <main class="main">
        <div class="topbar">
          <button class="icon-btn mobile-only" id="menu-btn">☰</button>
          <h1 class="page-title">${TABS.find((t) => t.id === state.activeTab)?.label || ""}</h1>
          <div class="status-pill">Готово</div>
        </div>

        <nav class="tabs">
          ${TABS.map((t) => `<button class="tab-btn ${t.id === state.activeTab ? "active" : ""}" data-tab="${t.id}">${t.label}</button>`).join("")}
        </nav>

        <div id="tab-content">
          ${state.selectedId ? tabContentHtml() : emptyStateHtml()}
        </div>
      </main>
    </div>
  `;

  bindEvents(root);
}

function chatItemHtml(chat) {
  const initials = (chat.title || "").slice(0, 2).toUpperCase();
  const active = chat.id === state.selectedId;
  return `
    <button class="chat-item ${active ? "active" : ""}" data-chat-id="${chat.id}">
      <div class="chat-avatar ${active ? "chat-avatar-active" : ""}">${initials}</div>
      <div class="chat-meta">
        <div class="chat-title">${escapeHtml(chat.title)}</div>
        <div class="chat-sub">${chat.type || "chat"}${chat.privacyAccepted === false ? " · приватность не принята" : ""}</div>
      </div>
    </button>
  `;
}

function emptyStateHtml() {
  return `<div class="card center-card"><p>Нет доступных чатов. Добавьте бота в чат и выдайте ему права администратора.</p></div>`;
}

function tabContentHtml() {
  const s = state.settings;
  if (!s) return emptyStateHtml();
  switch (state.activeTab) {
    case "antiraid":
      return antiraidTabHtml(s.anti_raid || {});
    case "antispam":
      return antispamTabHtml(s.antispam || {});
    case "nsfw":
      return nsfwTabHtml(s.antinsfw || {});
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
            ${["мут", "кик", "бан"].map((p) => `<option value="${p}" ${v.punishment === p ? "selected" : ""}>${p}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>Длительность</label><input type="number" class="input" data-field="duration" value="${v.duration ?? 30}" /></div>
        <div class="field">
          <label>Единица</label>
          <select class="input" data-field="unit">
            ${["сек", "мин", "час", "дней"].map((u) => `<option value="${u}" ${v.unit === u ? "selected" : ""}>${u}</option>`).join("")}
          </select>
        </div>
      </div>
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
            ${["мут", "кик", "бан"].map((p) => `<option value="${p}" ${v.punishment === p ? "selected" : ""}>${p}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>Длительность</label><input type="number" class="input" data-field="duration" value="${v.duration ?? 30}" /></div>
        <div class="field">
          <label>Единица</label>
          <select class="input" data-field="unit">
            ${["сек", "мин", "час", "дней"].map((u) => `<option value="${u}" ${v.unit === u ? "selected" : ""}>${u}</option>`).join("")}
          </select>
        </div>
      </div>
      ${saveButtonHtml()}
    </form>
  `;
}

// ---------------------------------------------------------------------------
// AI (includes AI moderator: enabled + personality/custom prompt)
// ---------------------------------------------------------------------------
function aiTabHtml(v) {
  const providers = state.aiProviders.length
    ? state.aiProviders
    : [{ id: v.ai_provider || "laozhang", label: v.ai_provider || "laozhang", models: v.ai_model ? [v.ai_model] : [] }];
  const currentProvider = providers.find((p) => p.id === v.ai_provider) || providers[0];
  const hasKey = !!v.providerKeys?.[v.ai_provider];

  return `
    <form class="card" id="form-ai" data-section="ai">
      ${cardHeader("ИИ модератор", "Модерация сообщений и общение с помощью ИИ.", v.ai_enabled, "ai_enabled")}

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
            <div class="chat-avatar">${(m.name || "?").slice(0, 2).toUpperCase()}</div>
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
  return `<button type="submit" class="btn btn-primary mt-lg">Сохранить</button>`;
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
  return data;
}

async function saveSection(section, form) {
  const body = collectFormData(form);
  try {
    let updated;
    if (section === "antiraid") updated = await api.patchAntiRaid(state.selectedId, body);
    else if (section === "antispam") updated = await api.patchAntispam(state.selectedId, body);
    else if (section === "nsfw") updated = await api.patchAntinsfw(state.selectedId, body);
    else if (section === "ai") updated = await api.patchAi(state.selectedId, body);

    const sectionKey = section === "nsfw" ? "antinsfw" : section === "antiraid" ? "anti_raid" : section;
    state.settings[sectionKey] = updated;
    toast("Настройки сохранены");
  } catch (e) {
    console.error(e);
    toast("Ошибка сохранения", "error");
  }
}

function bindEvents(root) {
  root.querySelector("#logout-btn")?.addEventListener("click", () => {
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
      state.selectedId = btn.dataset.chatId;
      root.querySelector("#tab-content").innerHTML = `<div class="fixed-center-inline"><div class="spinner"></div></div>`;
      await loadChat(state.selectedId);
      paint(root);
    });
  });

  root.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeTab = btn.dataset.tab;
      paint(root);
    });
  });

  const form = root.querySelector("#tab-content form");
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      saveSection(form.dataset.section, form);
    });

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
  }
}
