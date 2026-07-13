// ============================================================================
// Простейший роутер на History API — двух маршрутов достаточно для панели.
// ----------------------------------------------------------------------------
const routes = [];

export function registerRoute(path, render) {
  routes.push({ path, render });
}

export function navigate(path, { replace = false } = {}) {
  if (replace) window.history.replaceState({}, "", path);
  else window.history.pushState({}, "", path);
  dispatch();
}

function matchRoute(pathname) {
  return routes.find((r) => r.path === pathname) || routes.find((r) => r.path === "*");
}

async function dispatch() {
  const root = document.getElementById("app");
  const route = matchRoute(window.location.pathname);
  if (!route) return;
  await route.render(root);
}

window.addEventListener("popstate", dispatch);

export function startRouter() {
  dispatch();
}
