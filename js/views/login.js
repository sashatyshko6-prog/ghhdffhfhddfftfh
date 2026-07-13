import { tryMiniAppLogin, tryWidgetRedirectLogin, injectLoginWidget, getTelegramWebApp } from "../auth.js";
import { navigate } from "../router.js";

export async function renderLogin(root) {
  // Автологин: Mini App или редирект от Login Widget.
  root.innerHTML = `<div class="fixed-center"><div class="spinner"></div></div>`;

  let miniAppError = null;
  const tg = getTelegramWebApp();
  if (tg) {
    const result = await tryMiniAppLogin();
    if (result.ok) {
      navigate("/", { replace: true });
      return;
    }
    miniAppError = result.error;
  }

  if (new URLSearchParams(window.location.search).get("id")) {
    if (await tryWidgetRedirectLogin()) {
      navigate("/", { replace: true });
      return;
    }
  }

  root.innerHTML = `
    <div class="login-screen">
      <div class="login-box">
        <div class="login-header">
          <div class="login-icon">🛡</div>
          <h1>Панель управления ботом</h1>
          <p>Войдите через Telegram, чтобы управлять настройками чатов</p>
        </div>
        <div class="card login-card">
          <div id="tg-widget" class="tg-widget-slot"></div>
          <p class="hint">Откройте эту страницу как Telegram Mini App или войдите через виджет выше.</p>
        </div>
        ${miniAppError ? `
        <div class="card login-card" style="margin-top:12px;border-color:#e33;">
          <p class="hint" style="color:#e33;word-break:break-word;"><b>Debug (Mini App):</b> ${miniAppError.replace(/</g, "&lt;")}</p>
        </div>` : ""}
      </div>
    </div>
  `;

  injectLoginWidget(document.getElementById("tg-widget"));
}
