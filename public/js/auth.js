// ---------- Simple login ----------
// Loaded after library.js. Shows "Log in" / "Log out" in the header when LOGIN_PASSWORD is set.
// Logging in turns on the "Add to My Server" button on mournyl.com.
(() => {
  const btn = document.getElementById("loginBtn");
  const dlgLogin = document.getElementById("loginDlg");
  const form = document.getElementById("loginForm");
  const pw = document.getElementById("loginPw");
  const msg = document.getElementById("loginMsg");
  if (!btn || !dlgLogin) return;

  serverReady.then(() => {
    if (!server.login) return; // login not set up on the Worker
    btn.textContent = server.loggedIn ? "Log out" : "Log in";
    btn.hidden = false;
  });

  btn.addEventListener("click", async () => {
    if (server.loggedIn) {
      await fetch(`${API_BASE}/api/logout`, { method: "POST" }).catch(() => {});
      location.reload();
      return;
    }
    msg.textContent = "";
    pw.value = "";
    dlgLogin.showModal();
    pw.focus();
  });

  document.getElementById("loginCancel").addEventListener("click", () => dlgLogin.close());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    msg.textContent = "";
    try {
      const res = await fetch(`${API_BASE}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: pw.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      location.reload();
    } catch (err) {
      msg.textContent = err.message;
      pw.select();
    } finally {
      submit.disabled = false;
    }
  });
})();
