// ---------- Your Sonarr library ----------
// Loaded after app.js. Adds:
//   - the "My Server" section (LISTS.server): everything in Sonarr
//   - a badge on any TV or anime card that's in your library
//   - library info at the top of a show's detail popup
//   - an "Add to My Server" button for shows/movies you don't have yet (720p)

const library = { byTmdb: new Map(), byTitle: new Map(), shows: [], error: "", loaded: false, pending: [] };

const libKey = (title, year) =>
  `${String(title || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim()}|${year || ""}`;

function indexLibrary(shows) {
  library.shows = shows || [];
  library.byTmdb.clear();
  library.byTitle.clear();
  for (const s of library.shows) {
    if (s.tmdbId) library.byTmdb.set(s.tmdbId, s);
    library.byTitle.set(libKey(s.title, s.year), s);
  }
}

async function fetchLibrary() {
  const res = await fetch(`${API_BASE}/api/library`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Library error ${res.status}`);
  indexLibrary(data.shows);
  library.error = "";
}

// What's connected on the server side: { tv, movie, add }
const server = { tv: false, movie: false, add: false };
const serverReady = fetch(`${API_BASE}/api/server`)
  .then((r) => (r.ok ? r.json() : {}))
  .then((d) => Object.assign(server, d))
  .catch(() => {});

const libraryReady = fetchLibrary()
  .catch((e) => { library.error = e.message; })
  .finally(() => {
    library.loaded = true;
    // Badge the cards that rendered before the library arrived
    for (const [el, item] of library.pending) libraryBadge(el, item);
    library.pending = [];
  });

// Find a TMDB TV item (card or detail) in the library
function libraryMatch(item) {
  return library.byTmdb.get(item.id) ||
    library.byTitle.get(libKey(item.name || item.title, String(item.first_air_date || "").slice(0, 4)));
}

function libraryStatus(s) {
  if (s.aired > 0 && s.have >= s.aired) return { text: "✓ In library", cls: "full" };
  if (s.have === 0) return { text: s.monitored ? "Wanted" : "In library", cls: "none" };
  return { text: `${s.have}/${s.aired}`, cls: "partial" };
}

// Called from card() in app.js for every card
function libraryBadge(el, item) {
  if ((item.__type || state.type) !== "tv" && state.type !== "server") return;
  if (!library.loaded) {
    library.pending.push([el, item]);
    return;
  }
  const s = item.__library || libraryMatch(item);
  if (!s || el.querySelector(".lib-badge")) return;
  const { text, cls } = libraryStatus(s);
  const badge = document.createElement("span");
  badge.className = `lib-badge ${cls}`;
  badge.textContent = text;
  badge.title = `${s.have} of ${s.aired} aired episodes downloaded`;
  (el.querySelector(".poster") || el).append(badge);
  if (item.id < 0) { // My Shows entry with no TMDB match: nothing to open
    el.onclick = null;
    el.style.cursor = "default";
  }
}

// Called from loadMore() in app.js for the "My Server" section
const LIBRARY_PAGE = 40;
const isAnimeShow = (s) => s.seriesType === "anime" || (s.genres || []).some((g) => /^anime$/i.test(g));
async function libraryPage(page, list = "library", query = "") {
  await libraryReady;
  if (library.error) throw new Error(library.error);
  const q = libKey(query, "").replace(/\|$/, "");
  let shows = library.shows;
  if (list === "library/anime") shows = shows.filter(isAnimeShow);
  if (list === "library/missing") shows = shows.filter((s) => s.monitored && s.have < s.aired);
  if (q) shows = shows.filter((s) => libKey(s.title, "").includes(q));
  const start = (page - 1) * LIBRARY_PAGE;
  return {
    total_pages: Math.max(1, Math.ceil(shows.length / LIBRARY_PAGE)),
    results: shows.slice(start, start + LIBRARY_PAGE).map((s) => ({
      id: s.tmdbId || -s.tvdbId,            // negative = no TMDB match
      name: s.title,
      poster_path: s.poster || null,        // full URL from Sonarr
      first_air_date: s.firstAired || (s.year ? `${s.year}-01-01` : ""),
      __type: "tv",
      __library: s,
    })),
  };
}

// Called from openDetail() in app.js after the popup renders
async function libraryDetail(type, d) {
  const token = (body.__libToken = {});           // ignore if another popup opened meanwhile
  await Promise.all([libraryReady, serverReady]);
  if (body.__libToken !== token) return;
  const s = type === "tv" ? libraryMatch(d) : null;
  if (s) return showLibraryInfo(s);
  if (server.add && server[type]) showAddButton(type, d, token);
}

function placePanel(box) {
  const hero = body.querySelector(".hero");
  if (hero) hero.after(box); else body.prepend(box);
}

function showLibraryInfo(s) {
  const next = s.nextAiring
    ? new Date(s.nextAiring).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
    : "";
  const parts = [
    `${s.have} of ${s.aired} aired episode${s.aired === 1 ? "" : "s"}`,
    s.sizeGB ? `${s.sizeGB} GB` : "",
    s.status ? s.status[0].toUpperCase() + s.status.slice(1) : "",
    next ? `Next episode ${next}` : "",
    s.monitored ? "" : "Not monitored",
  ].filter(Boolean);
  const pct = s.aired ? Math.min(100, Math.round((s.have / s.aired) * 100)) : 0;
  const box = document.createElement("div");
  box.className = "lib-detail";
  box.innerHTML = `
    <div class="lib-detail-head"><span class="lib-dot"></span>In your library</div>
    <div class="lib-detail-meta">${parts.map(esc).join(" · ")}</div>
    <div class="lib-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>`;
  placePanel(box);
}

// ---------- Add to My Server ----------
// Only shown on your local copy for now (the Worker reports server.add = true on localhost).
function showAddButton(type, d, token) {
  const app = type === "tv" ? "Sonarr" : "Radarr";
  const box = document.createElement("div");
  box.className = "lib-detail";
  box.innerHTML = `
    <div class="lib-detail-head"><span class="lib-dot off"></span>Not on your server</div>
    <div class="lib-detail-meta">Adds it to ${app} and starts downloading in 720p.</div>
    <form class="lib-add">
      ${type === "tv" ? `<select class="lib-monitor" aria-label="Which episodes">
        <option value="all">All seasons</option>
        <option value="lastSeason">Latest season</option>
        <option value="firstSeason">First season</option>
        <option value="future">New episodes only</option>
      </select>` : ""}
      <button type="submit" class="lib-add-btn">＋ Add to My Server</button>
    </form>
    <div class="lib-msg" role="status"></div>`;
  placePanel(box);

  const form = box.querySelector(".lib-add");
  const btn = box.querySelector(".lib-add-btn");
  const msg = box.querySelector(".lib-msg");
  const say = (text, kind = "") => { msg.textContent = text; msg.className = `lib-msg ${kind}`; };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = "Adding…";
    say("");
    try {
      const res = await fetch(`${API_BASE}/api/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, tmdbId: d.id, monitor: box.querySelector(".lib-monitor")?.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      form.hidden = true;
      box.querySelector(".lib-detail-meta").hidden = true;
      box.querySelector(".lib-detail-head").innerHTML = `<span class="lib-dot"></span>${data.status === "exists" ? "Already on your server" : "Added to your server"}`;
      say(data.message || "Added.", "ok");
      if (type === "tv" && data.status === "added") fetchLibrary().catch(() => {}); // shows up in My Server
    } catch (err) {
      if (body.__libToken !== token) return;
      say(err.message, "err");
      btn.disabled = false;
      btn.textContent = "＋ Add to My Server";
    }
  });
}
