// ---------- Your server: Sonarr (TV) and Radarr (movies) ----------
// Loaded after app.js. Adds:
//   - the "My Server" section (LISTS.server): your Sonarr shows and Radarr movies
//   - a badge on any TV, anime or movie card that's on your server
//   - library info at the top of a show's or movie's detail popup
//   - an "Add to My Server" button for shows/movies you don't have yet (720p)

const library = { byTmdb: new Map(), byTitle: new Map(), shows: [], error: "", loaded: false, pending: [] };
const movieLib = { byTmdb: new Map(), movies: [], error: "" };

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

async function fetchMovies() {
  const res = await fetch(`${API_BASE}/api/movies`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Movie library error ${res.status}`);
  movieLib.movies = data.movies || [];
  movieLib.byTmdb.clear();
  for (const m of movieLib.movies) if (m.tmdbId) movieLib.byTmdb.set(m.tmdbId, m);
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
  const { text, cls, tip } = type === "movie" ? movieStatus(info) : libraryStatus(info);
  const badge = document.createElement("span");
  badge.className = `lib-badge ${cls}`;
  badge.textContent = text;
  badge.title = tip;
  (el.querySelector(".poster") || el).append(badge);
  if (item.id < 0) { // My Server entry with no TMDB match: nothing to open
    el.onclick = null;
    el.style.cursor = "default";
  }
}

// Called from loadMore() in app.js for the "My Server" section
const LIBRARY_PAGE = 40;
const isAnimeShow = (s) => s.seriesType === "anime" || (s.genres || []).some((g) => /^anime$/i.test(g));
async function libraryPage(page, list = "library", query = "") {
  await libraryReady;
  const q = libKey(query, "").replace(/\|$/, "");
  const start = (page - 1) * LIBRARY_PAGE;

  if (list === "library/movies") {
    if (movieLib.error) throw new Error(movieLib.error);
    let movies = movieLib.movies;
    if (q) movies = movies.filter((m) => libKey(m.title, "").includes(q));
    return {
      total_pages: Math.max(1, Math.ceil(movies.length / LIBRARY_PAGE)),
      results: movies.slice(start, start + LIBRARY_PAGE).map((m) => ({
        id: m.tmdbId,                           // Radarr always has the TMDB id
        title: m.title,
        poster_path: m.poster || null,          // full URL from Radarr
        release_date: m.released || (m.year ? `${m.year}-01-01` : ""),
        __type: "movie",
        __movie: m,
      })),
    };
  }

  if (library.error) throw new Error(library.error);
  let shows = library.shows;
  if (list === "library/anime") shows = shows.filter(isAnimeShow);
  if (list === "library/missing") shows = shows.filter((s) => s.monitored && s.have < s.aired);
  if (q) shows = shows.filter((s) => libKey(s.title, "").includes(q));
  return {
    total_pages: Math.max(1, Math.ceil(shows.length / LIBRARY_PAGE)),
    results: shows.slice(start, start + LIBRARY_PAGE).map((s) => ({
      id: s.tmdbId || -s.tvdbId,              // negative = no TMDB match
      name: s.title,
      poster_path: s.poster || null,          // full URL from Sonarr
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

function libraryPanel(parts, pct) {
  const box = document.createElement("div");
  box.className = "lib-detail";
  box.innerHTML = `
    <div class="lib-detail-head"><span class="lib-dot"></span>In your library</div>
    <div class="lib-detail-meta">${parts.filter(Boolean).map(esc).join(" · ")}</div>
    <div class="lib-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>`;
  placePanel(box);
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
  ], s.aired ? Math.min(100, Math.round((s.have / s.aired) * 100)) : 0);
}

function showMovieInfo(m) {
  libraryPanel(
    m.hasFile
      ? ["Downloaded", m.quality, m.sizeGB ? `${m.sizeGB} GB` : ""]
      : [m.available ? (m.monitored ? "Not downloaded yet · Radarr is watching for it" : "Not downloaded") : "Not released yet · Radarr will grab it when it's out"],
    m.hasFile ? 100 : 0,
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
      if (data.status === "added") (type === "tv" ? fetchLibrary : fetchMovies)().catch(() => {}); // shows up in My Server
    } catch (err) {
      if (body.__libToken !== token) return;
      say(err.message, "err");
      btn.disabled = false;
      btn.textContent = "＋ Add to My Server";
    }
  });
}
