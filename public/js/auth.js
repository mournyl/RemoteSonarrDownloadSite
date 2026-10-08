// ---------- Log out ----------
// The whole site is behind the login page (/login), so anyone seeing this page is logged in.
(() => {
  const btn = document.getElementById("loginBtn");
  if (!btn) return;
  btn.textContent = "Log out";
  btn.hidden = false;
  btn.addEventListener("click", async () => {
    await fetch(`${API_BASE}/api/logout`, { method: "POST" }).catch(() => {});
    location.replace("/login");
  });
})();
