// ============================================================================
// Держит CSS-переменную --tg-vh (см. css/styles.css) в синхроне с реальной
// видимой высотой Telegram Mini App WebView.
// ----------------------------------------------------------------------------
// Раньше styles.css уже опирался на --tg-vh, но ничего в проекте её не
// выставляло -- переменная падала на дефолт 100dvh. Внутри Telegram WebView
// 100dvh не совпадает с фактической высотой, которую отдаёт сам Telegram
// (особенно до вызова expand() и при появлении/скрытии системных панелей),
// поэтому интерфейс "сжимался" под старую высоту и на html/body появлялись
// лишние скроллы. Этот файл должен быть подключён в index.html сразу после
// telegram-web-app.js и до main.js, чтобы --tg-vh был выставлен ДО первого
// рендера панели.
(function () {
  function setVar(height) {
    if (height && height > 0) {
      document.documentElement.style.setProperty("--tg-vh", `${height}px`);
    }
  }

  function initTelegram(tg) {
    // ready()/expand() тут дублируют вызов из auth.js (после логина) --
    // это нормально и безопасно, Telegram SDK идемпотентен. Вызывать нужно
    // как можно раньше, а не только после успешного логина, иначе первый
    // экран (спиннер/логин) ещё рисуется под старую, не развёрнутую высоту.
    try { tg.ready(); } catch (_) {}
    try { tg.expand(); } catch (_) {}
    // Отключает свайп-вниз для закрытия мини-аппа поверх скроллируемых
    // областей -- без этого случайный вертикальный свайп по .main или
    // .chat-list схлопывает WebView и заново триггерит "прыжок" вёрстки.
    try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch (_) {}

    const update = () => setVar(tg.viewportStableHeight || tg.viewportHeight || window.innerHeight);
    update();

    tg.onEvent("viewportChanged", update);
    // Некоторые версии клиента не шлют viewportChanged сразу при повороте
    // экрана / смене раскладки клавиатуры -- подстрахуемся resize-событием.
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", () => setTimeout(update, 50));
  }

  function initFallback() {
    // Вне Telegram (обычный мобильный браузер) аналогичная проблема даёт
    // адресная строка/панель браузера -- visualViewport решает то же самое.
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setVar(vv.height);
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
  }

  function init() {
    const tg = window.Telegram && window.Telegram.WebApp;
    if (tg) initTelegram(tg);
    else initFallback();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
