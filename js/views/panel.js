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
  moderators: [],
  aiProviders: [],
  activeTab: "antiraid",
  loading: true,
  saving: false,
};

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
