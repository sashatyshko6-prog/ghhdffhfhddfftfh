import { registerRoute, startRouter, navigate } from "./router.js";
import { renderLogin } from "./views/login.js";
import { renderPanel } from "./views/panel.js";

registerRoute("/login", renderLogin);
registerRoute("/", renderPanel);
registerRoute("*", (root) => {
  root.innerHTML = `
    <div class="fixed-center">
      <div class="card center-card">
        <p>Страница не найдена.</p>
        <button class="btn btn-primary mt" id="home-btn">На главную</button>
      </div>
    </div>
  `;
  root.querySelector("#home-btn").addEventListener("click", () => navigate("/"));
});

startRouter();
