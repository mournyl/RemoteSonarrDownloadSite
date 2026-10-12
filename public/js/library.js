// ---------- Your server: Sonarr (TV) and Radarr (movies) ----------
// Loaded after app.js. Adds:
//   - the "My Server" section (LISTS.server): your Sonarr shows and Radarr movies
//   - a badge on any TV, anime or movie card that's on your server
//   - library info at the top of a show's or movie's detail popup
//   - an "Add to My Server" button for shows (720p) and movies (1080p) you don't have yet
//   - every episode of a show (season by season) in its popup
//   - live download progress (percent, time left) on cards and in popups

const library = { byTmdb: new Map(), byTitle: new Map(), byId: new Map(), shows: [], error: "", loaded: false, pending: [] };
const movieLib = { byTmdb: new Map(), byId: new Map(), movies: [], error: "" };

const libKey = (title, year) =>
  `${String(title || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim()}|${year || ""}`;

function indexLibrary(shows) {
  library.shows = shows || [];
  library.byTmdb.clear();
  library.byTitle.clear();
  library.byId.clear();
  for (const s of library.shows) {
    if (s.id) library.byId.set(s.id, s);
    if (s.tmdbId) library.byTmdb.set(s.tmdbId, s);
    library.byTitle.set(libKey(s.title, s.year), s);
  }
}

async function fetchLibrary(fresh) {
  const res = await fetch(`${API_BASE}/api/library${fresh ? "?fresh=1" : ""}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Library error ${res.status}`);
  indexLibrary(data.shows);
  library.error = "";
}

async function fetchMovies(fresh) {
  const res = await fetch(`${API_BASE}/api/movies${fresh ? "?fresh=1" : ""}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Movie library error ${res.status}`);
  movieLib.movies = data.movies || [];
  movieLib.byTmdb.clear();
  movieLib.byId.clear();
  for (const m of movieLib.movies) {
    if (m.tmdbId) movieLib.byTmdb.set(m.tmdbId, m);
    if (m.id) movieLib.byId.set(m.id, m);
  }
  movieLib.error = "";
}

// What's connected on the server side: { tv, movie, add }
const server = { tv: false, movie: false, add: false };
const serverReady = fetch(`${API_BASE}/api/server`)
  .then((r) => (r.ok ? r.json() : {}))
  .then((d) => Object.assign(server, d))
  .catch(() => {});

const libraryReady = Promise.all([
  fetchLibrary().catch((e) => { library.error = e.message; }),
  fetchMovies().catch((e) => { movieLib.error = e.message; }),
]).finally(() => {
  library.loaded = true;
  // Badge the cards that rendered before the library arrived
  for (const [el, item] of library.pending) libraryBadge(el, item);
  library.pending = [];
});

// Find a TMDB TV item (card or detail) in the Sonarr library
function libraryMatch(item) {
  return library.byTmdb.get(item.id) ||
    library.byTitle.get(libKey(item.name || item.title, String(item.first_air_date || "").slice(0, 4)));
}

// Find a TMDB movie in the Radarr library
const movieMatch = (item) => movieLib.byTmdb.get(item.id);

function libraryStatus(s) {
  if (s.aired > 0 && s.have >= s.aired) return { text: "✓ In library", cls: "full", tip: `All ${s.aired} aired episodes downloaded` };
  if (s.have === 0) return { text: s.monitored ? "Wanted" : "In library", cls: "none", tip: "No episodes downloaded yet" };
  return { text: `${s.have}/${s.aired}`, cls: "partial", tip: `${s.have} of ${s.aired} aired episodes downloaded` };
}

function movieStatus(m) {
  if (m.hasFile) return { text: "✓ In library", cls: "full", tip: `Downloaded${m.quality ? ` (${m.quality})` : ""}` };
  if (!m.available) return { text: "Upcoming", cls: "none", tip: "Not released yet" };
  return { text: m.monitored ? "Wanted" : "In library", cls: "none", tip: "Not downloaded yet" };
}

function setBadge(badge, type, info) {
  const { text, cls, tip } = type === "movie" ? movieStatus(info) : libraryStatus(info);
  badge.className = `lib-badge ${cls}`;
  badge.textContent = text;
  badge.title = tip;
}

// Which kind of item a card is: "tv" or "movie"
const itemType = (item) => item.__type || (state.type === "server" ? "tv" : state.type);

// Called from card() in app.js for every card
function libraryBadge(el, item) {
  const type = itemType(item);
  if (type !== "tv" && type !== "movie") return;
  if (!library.loaded) {
    library.pending.push([el, item]);
    return;
  }
  const info = type === "movie" ? item.__movie || movieMatch(item) : item.__library || libraryMatch(item);
  if (!info || el.querySelector(".lib-badge")) return;
  const badge = document.createElement("span");
  (el.querySelector(".poster") || el).append(badge);
  setBadge(badge, type, info);
  if (info.id) {
    el.dataset.dl = `${type}:${info.id}`; // live download progress (see Downloads below)
    showDownload(el);
  }
  if (item.id < 0) { // My Server entry with no TMDB match: nothing to open
    el.onclick = null;
    el.style.cursor = "default";
  }
}

// Called from loadMore() in app.js for the "My Server" section
const LIBRARY_PAGE = 40;
const isAnimeShow = (s) => s.seriesType === "anime" || (s.genres || []).some((g) => /^anime$/i.test(g));
const movieCard = (m) => ({
  id: m.tmdbId,                           // Radarr always has the TMDB id
  title: m.title,
  poster_path: m.poster || null,          // full URL from Radarr
  release_date: m.released || (m.year ? `${m.year}-01-01` : ""),
  __type: "movie",
  __movie: m,
});
const showCard = (s) => ({
  id: s.tmdbId || -s.tvdbId,              // negative = no TMDB match
  name: s.title,
  poster_path: s.poster || null,          // full URL from Sonarr
  first_air_date: s.firstAired || (s.year ? `${s.year}-01-01` : ""),
  __type: "tv",
  __library: s,
});

async function libraryPage(page, list = "library", query = "") {
  await libraryReady;
  const q = libKey(query, "").replace(/\|$/, "");
  const match = (x) => !q || libKey(x.title, "").includes(q);
  let items;

  if (list === "library/all") {
    // TV shows first, then movies, each under its own heading
    if (library.error && movieLib.error) throw new Error(library.error);
    const shows = library.error ? [] : library.shows.filter(match);
    const movies = movieLib.error ? [] : movieLib.movies.filter(match);
    items = [];
    if (shows.length || library.error) items.push({ __heading: "TV Shows", count: shows.length, error: library.error }, ...shows.map(showCard));
    if (movies.length || movieLib.error) items.push({ __heading: "Movies", count: movies.length, error: movieLib.error }, ...movies.map(movieCard));
  } else if (list === "library/movies") {
    if (movieLib.error) throw new Error(movieLib.error);
    items = movieLib.movies.filter(match).map(movieCard);
  } else {
    if (library.error) throw new Error(library.error);
    let shows = library.shows;
    if (list === "library/anime") shows = shows.filter(isAnimeShow);
    items = shows.filter(match).map(showCard);
  }

  const start = (page - 1) * LIBRARY_PAGE;
  return {
    total_pages: Math.max(1, Math.ceil(items.length / LIBRARY_PAGE)),
    results: items.slice(start, start + LIBRARY_PAGE),
  };
}

// Section heading inside the grid (used by the "All" tab)
function libraryHeading(item) {
  const h = document.createElement("h2");
  h.className = "lib-section";
  h.innerHTML = `${esc(item.__heading)} <span>${item.error ? esc(item.error) : item.count}</span>`;
  return h;
}

// Called from openDetail() in app.js after the popup renders
async function libraryDetail(type, d) {
  const token = (body.__libToken = {});           // ignore if another popup opened meanwhile
  await Promise.all([libraryReady, serverReady]);
  if (body.__libToken !== token) return;
  if (type === "tv") {
    const s = libraryMatch(d);
    if (s) return showLibraryInfo(s);
  } else if (type === "movie") {
    const m = movieMatch(d);
    if (m) return showMovieInfo(m);
  }
  if (server.add && server[type]) showAddButton(type, d, token);
}

function placePanel(box) {
  const hero = body.querySelector(".hero");
  if (hero) hero.after(box); else body.prepend(box);
}

function libraryPanel(parts, pct, dlKey) {
  const box = document.createElement("div");
  box.className = "lib-detail";
  if (dlKey) box.dataset.dl = dlKey;
  box.innerHTML = `
    <div class="lib-detail-head"><span class="lib-dot"></span>In your library</div>
    <div class="lib-detail-meta">${parts.filter(Boolean).map(esc).join(" · ")}</div>
    <div class="lib-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>`;
  placePanel(box);
  if (dlKey) showDownload(box);
}

function showLibraryInfo(s) {
  const next = s.nextAiring
    ? new Date(s.nextAiring).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
    : "";
  libraryPanel([
    `${s.have} of ${s.aired} aired episode${s.aired === 1 ? "" : "s"}`,
    s.sizeGB ? `${s.sizeGB} GB` : "",
    s.status ? s.status[0].toUpperCase() + s.status.slice(1) : "",
    next ? `Next episode ${next}` : "",
    s.monitored ? "" : "Not monitored",
  ], s.aired ? Math.min(100, Math.round((s.have / s.aired) * 100)) : 0, s.id && `tv:${s.id}`);
  if (s.id) showEpisodes(s, body.__libToken);
}

function showMovieInfo(m) {
  libraryPanel(
    m.hasFile
      ? ["Downloaded", m.quality, m.sizeGB ? `${m.sizeGB} GB` : ""]
      : [m.available ? (m.monitored ? "Not downloaded yet · Radarr is watching for it" : "Not downloaded") : "Not released yet · Radarr will grab it when it's out"],
    m.hasFile ? 100 : 0,
    m.id && `movie:${m.id}`,
  );
}

// ---------- Add to My Server ----------
// Only shown when you're logged in (the Worker reports server.add = true).
function showAddButton(type, d, token) {
  const app = type === "tv" ? "Sonarr" : "Radarr";
  const box = document.createElement("div");
  box.className = "lib-detail";
  box.innerHTML = `
    <div class="lib-detail-head"><span class="lib-dot off"></span>Not on your server</div>
    <div class="lib-detail-meta">Adds it to ${app} and starts downloading in ${type === "tv" ? "720p" : "1080p"}.</div>
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
      if (data.status === "added") {
        (type === "tv" ? fetchLibrary : fetchMovies)().catch(() => {}); // shows up in My Server
        pollDownloadsSoon();                                            // its download shows up shortly
      }
    } catch (err) {
      if (body.__libToken !== token) return;
      say(err.message, "err");
      btn.disabled = false;
      btn.textContent = "＋ Add to My Server";
    }
  });
}

// ---------- Episodes (in a show's popup) ----------
const shortDate = (iso) => iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "TBA";

async function showEpisodes(s, token, box) {
  if (!box) {
    box = document.createElement("div");
    box.className = "section eps";
    box.dataset.series = s.id;
    box.innerHTML = `<h3>Episodes</h3><p class="eps-msg">Loading episodes…</p>`;
    const overview = body.querySelector(".section");
    if (overview) overview.after(box); else body.append(box);
  }
  const keepOpen = new Set([...box.querySelectorAll(".season[open]")].map((d) => d.dataset.season));

  let eps;
  try {
    const res = await fetch(`${API_BASE}/api/episodes?series=${s.id}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    eps = data.episodes || [];
  } catch (e) {
    if (body.__libToken === token) box.querySelector(".eps-msg").textContent = "Couldn't load episodes: " + e.message;
    return;
  }
  if (body.__libToken !== token) return;
  if (!eps.length) { box.querySelector(".eps-msg").textContent = "Sonarr has no episodes for this show yet."; return; }

  const now = Date.now();
  const aired = (e) => e.airDate && new Date(e.airDate).getTime() <= now;
  const seasons = new Map();
  for (const e of eps) {
    if (!seasons.has(e.season)) seasons.set(e.season, []);
    seasons.get(e.season).push(e);
  }
  // Regular seasons newest first, Specials (season 0) last
  const order = [...seasons.keys()].sort((a, b) => (a === 0) - (b === 0) || b - a);
  // Open the newest season that has aired episodes
  const openSeason = order.find((n) => n !== 0 && seasons.get(n).some(aired)) ?? order[0];
  const isOpen = (n) => (keepOpen.size ? keepOpen.has(String(n)) : n === openSeason);

  box.innerHTML = `<h3>Episodes</h3>` + order.map((n) => {
    const list = seasons.get(n);
    const airedEps = list.filter(aired);
    const have = list.filter((e) => e.hasFile).length;
    return `
      <details class="season" data-season="${n}"${isOpen(n) ? " open" : ""}>
        <summary>${n === 0 ? "Specials" : `Season ${n}`}<span>${have}/${airedEps.length || list.length}</span></summary>
        <ol>${list.map((e) => `
          <li class="ep" data-ep="${e.id}" data-state="${e.hasFile ? "have" : !aired(e) ? "future" : e.monitored ? "missing" : "skip"}"
              data-quality="${esc(e.quality)}" data-air="${esc(e.airDate)}">
            <span class="ep-n">${e.number}</span>
            <span class="ep-t">${esc(e.title || "TBA")}</span>
            <span class="ep-d">${shortDate(e.airDate)}</span>
            <span class="ep-s"></span>
          </li>`).join("")}
        </ol>
      </details>`;
  }).join("");
  box.querySelectorAll(".ep").forEach(showEpisodeState);
}

function showEpisodeState(li) {
  const el = li.querySelector(".ep-s");
  const d = downloads.byEpisode.get(Number(li.dataset.ep));
  li.classList.toggle("dl", Boolean(d));
  if (d) { el.textContent = dlText(d, true); return; }
  const st = li.dataset.state;
  el.textContent = st === "have" ? `✓ ${li.dataset.quality || "Downloaded"}`
    : st === "future" ? (li.dataset.air ? "Upcoming" : "TBA")
    : st === "missing" ? "Missing" : "Not monitored";
}

// ---------- Downloads (Sonarr/Radarr queues + live SABnzbd) ----------
const downloads = { byKey: new Map(), byEpisode: new Map(), sab: null, timer: 0, busy: false };

function fmtLeft(sec) {
  if (sec == null) return "";
  if (sec < 60) return "<1m left";
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m left` : `${m}m left`;
}

function dlText(d, long) {
  if (d.status === "importing") return "Importing…";
  if (d.status === "failed") return "Download failed";
  if (d.status === "queued") return "Queued";
  const pct = `${Math.floor(d.percent)}%`;
  if (d.status === "paused") return `Paused · ${pct}`;
  const parts = [`⬇ ${pct}`, fmtLeft(d.secondsLeft)];
  if (long && d.count > 1) parts.unshift(`${d.count} episodes`);
  return parts.filter(Boolean).join(" · ");
}

// Cards and popup panels carry data-dl="tv:<sonarr id>" or "movie:<radarr id>"
function showDownload(el) {
  const d = downloads.byKey.get(el.dataset.dl);
  const isCard = el.classList.contains("card");
  const host = isCard ? el.querySelector(".poster") || el : el;
  let box = host.querySelector(":scope > .dl");
  if (!d) { if (box) box.remove(); return; }
  if (!box) {
    box = document.createElement("div");
    box.className = isCard ? "dl dl-card" : "dl dl-panel";
    box.innerHTML = `<div class="dl-text"></div><div class="dl-bar"><span></span></div>`;
    host.append(box);
  }
  box.dataset.status = d.status;
  let text = dlText(d, !isCard);
  if (!isCard && d.status === "downloading" && downloads.sab && downloads.sab.speedKBs) {
    text += ` · ${(downloads.sab.speedKBs / 1024).toFixed(1)} MB/s`;
  }
  if (!isCard && d.warning) text += ` — ${d.warning}`;
  box.querySelector(".dl-text").textContent = text;
  box.querySelector(".dl-bar span").style.width = `${d.status === "importing" ? 100 : d.percent}%`;
}

async function pollDownloads() {
  clearTimeout(downloads.timer);
  if (downloads.busy) return;
  if (document.hidden) { downloads.timer = setTimeout(pollDownloads, 30000); return; }
  downloads.busy = true;
  let active = false;
  try {
    await serverReady;
    if (!server.tv && !server.movie) return;
    const res = await fetch(`${API_BASE}/api/downloads`);
    if (!res.ok) return;
    const data = await res.json();
    const before = new Set(downloads.byKey.keys());

    // Combine episodes of the same show into one entry
    const byKey = new Map(), byEpisode = new Map();
    for (const it of data.items || []) {
      const key = it.type === "tv" ? `tv:${it.seriesId}` : `movie:${it.movieId}`;
      if (it.type === "tv" && it.episodeId) byEpisode.set(it.episodeId, it);
      const a = byKey.get(key) || { status: "", count: 0, sizeMB: 0, doneMB: 0, secondsLeft: null, warning: "" };
      a.count += 1;
      a.sizeMB += it.sizeMB || 0;
      a.doneMB += ((it.sizeMB || 0) * (it.percent || 0)) / 100;
      if (it.secondsLeft != null) a.secondsLeft = Math.max(a.secondsLeft || 0, it.secondsLeft);
      a.warning = a.warning || it.warning;
      const rank = ["downloading", "importing", "paused", "queued", "failed"];
      if (!a.status || rank.indexOf(it.status) < rank.indexOf(a.status)) a.status = it.status;
      a.percent = a.sizeMB ? (a.doneMB / a.sizeMB) * 100 : it.percent || 0;
      byKey.set(key, a);
    }
    downloads.byKey = byKey;
    downloads.byEpisode = byEpisode;
    downloads.sab = data.sab;
    active = byKey.size > 0;

    document.querySelectorAll("[data-dl]").forEach(showDownload);
    document.querySelectorAll(".ep[data-ep]").forEach(showEpisodeState);

    // Something finished: reload the library so badges and episode lists catch up
    const finished = [...before].filter((k) => !byKey.has(k));
    if (finished.length) refreshLibrary(finished);
  } catch {
    // ignore; try again next time
  } finally {
    downloads.busy = false;
    downloads.timer = setTimeout(pollDownloads, active ? 5000 : 30000);
  }
}

// Check again in a few seconds (after adding something)
function pollDownloadsSoon() {
  clearTimeout(downloads.timer);
  downloads.timer = setTimeout(pollDownloads, 4000);
}

async function refreshLibrary(finished = []) {
  await Promise.all([fetchLibrary(true).catch(() => {}), fetchMovies(true).catch(() => {})]);
  // Reload the episode list if that show's popup is open
  for (const key of finished) {
    const box = body.querySelector(`.eps[data-series="${key.split(":")[1]}"]`);
    const s = key.startsWith("tv:") && library.byId.get(Number(key.split(":")[1]));
    if (box && s) showEpisodes(s, body.__libToken, box);
  }
  document.querySelectorAll(".card[data-dl]").forEach((el) => {
    const [type, id] = el.dataset.dl.split(":");
    const info = (type === "movie" ? movieLib : library).byId.get(Number(id));
    const badge = el.querySelector(".lib-badge");
    if (info && badge) setBadge(badge, type, info);
  });
}

document.addEventListener("visibilitychange", () => { if (!document.hidden) pollDownloads(); });
libraryReady.then(pollDownloads);
