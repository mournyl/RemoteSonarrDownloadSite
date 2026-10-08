// When you open index.html by double-clicking (file://), API calls go to your live site.
// Put your deployed URL here, e.g. "https://yourdomain.com". On the live site it's ignored.
const LIVE_SITE = "https://mournyl.com";
const API_BASE = location.protocol === "file:" ? LIVE_SITE : "";

const IMG = "https://image.tmdb.org/t/p/";
const LISTS = {
  movie: [
    ["trending/movie/week", "Trending"],
    ["movie/now_playing", "In Theaters"],
    ["movie/upcoming", "Coming Soon"],
    ["movie/popular", "Popular"],
    ["movie/top_rated", "Top Rated"],
  ],
  tv: [
    ["trending/tv/week", "Trending"],
    ["tv/on_the_air", "On the Air"],
    ["tv/airing_today", "Airing Today"],
    ["tv/popular", "Popular"],
    ["tv/top_rated", "Top Rated"],
  ],
  anime: [
    ["anime/popular", "Popular"],
    ["anime/airing", "Airing This Week"],
    ["anime/top", "Top Rated"],
    ["anime/new", "New"],
    ["anime/movies", "Movies"],
  ],
  server: [
    ["library", "All Shows"],
    ["library/anime", "Anime"],
    ["library/missing", "Missing Episodes"],
  ],
};

// Anime lists use TMDB's discover search: Animation genre + Japanese original language
const ANIME = { with_genres: "16", with_original_language: "ja" };
const isoDay = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };
// In Theaters / Coming Soon: only real first-run US theatrical releases.
// primary_release_date (the movie's first release anywhere) within the last year
// keeps out re-releases of old movies that TMDB's own lists include.
const FIRST_RUN = { region: "US", with_release_type: "2|3", sort_by: "popularity.desc" };
const LIST_QUERIES = {
  "movie/now_playing": () => ({ path: "discover/movie", type: "movie", params: { ...FIRST_RUN, "release_date.gte": isoDay(-42), "release_date.lte": isoDay(0), "primary_release_date.gte": isoDay(-365) } }),
  "movie/upcoming": () => ({ path: "discover/movie", type: "movie", params: { ...FIRST_RUN, "release_date.gte": isoDay(1), "release_date.lte": isoDay(180), "primary_release_date.gte": isoDay(-365) } }),
  "anime/popular": () => ({ path: "discover/tv", type: "tv", sfw: true, params: { ...ANIME, sort_by: "popularity.desc" } }),
  "anime/airing": () => ({ path: "discover/tv", type: "tv", sfw: true, params: { ...ANIME, sort_by: "popularity.desc", "air_date.gte": isoDay(0), "air_date.lte": isoDay(7) } }),
  "anime/top": () => ({ path: "discover/tv", type: "tv", sfw: true, params: { ...ANIME, sort_by: "vote_average.desc", "vote_count.gte": "300" } }),
  "anime/new": () => ({ path: "discover/tv", type: "tv", sfw: true, params: { ...ANIME, sort_by: "first_air_date.desc", "first_air_date.lte": isoDay(0), "vote_count.gte": "5" } }),
  "anime/movies": () => ({ path: "discover/movie", type: "movie", sfw: true, params: { ...ANIME, sort_by: "popularity.desc" } }),
};

// NSFW anime filter: TMDB's "hentai" and "ecchi" keywords (ids looked up once), plus adult-flagged titles
let nsfwKeywords = null;
async function nsfwKeywordIds() {
  if (nsfwKeywords) return nsfwKeywords;
  const ids = new Set(["195669"]); // "ecchi"
  await Promise.all(["hentai", "ecchi"].map(async (word) => {
    try {
      const r = await api("search/keyword", { query: word });
      for (const k of r.results || []) if (String(k.name).toLowerCase() === word) ids.add(String(k.id));
    } catch {}
  }));
  return (nsfwKeywords = [...ids].join("|"));
}
const sfw = (r) => !r.adult;
const isAnime = (r) => (r.genre_ids || []).includes(16) && (r.original_language === "ja" || (r.origin_country || []).includes("JP"));
const SEARCH_LABEL = { movie: "movies", tv: "TV shows", anime: "anime", server: "your server" };

const state = { type: "movie", list: LISTS.movie[0][0], query: "", page: 1, totalPages: 1, loading: false, gen: 0, seen: new Set() };

const $ = (s) => document.querySelector(s);
const grid = $("#grid"), statusEl = $("#status"), listsNav = $("#lists"), search = $("#search");
const dlg = $("#detail"), body = $("#detailBody"), sentinel = $("#sentinel");

// "2026-09-23" -> "Sep 23, 2026" (parsed as a local date so it doesn't shift a day)
const fmtDate = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, params = {}) {
  const qs = new URLSearchParams({ language: "en-US", ...params });
  const res = await fetch(`${API_BASE}/api/${path}?${qs}`);
  if (res.status === 401) { location.replace("/login"); throw new Error("Logged out"); }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

// ---------- Theaters near you (shown on Movies → In Theaters) ----------
const theaterList = $("#theaterList"), zipInput = $("#zip"), radiusSel = $("#radius");

function updateTheaterBar() {
  const box = document.getElementById("theaters");
  if (box) box.hidden = !(state.type === "movie" && state.list === "movie/now_playing" && !state.query);
}

async function findTheaters(e) {
  if (e) e.preventDefault();
  const zip = zipInput.value.trim();
  if (!/^\d{5}$/.test(zip)) {
    theaterList.innerHTML = `<p class="th-note">Enter a 5-digit ZIP code.</p>`;
    return;
  }
  try { localStorage.setItem("zip", zip); } catch {}
  theaterList.innerHTML = `<p class="th-note">Finding theaters near ${esc(zip)}…</p>`;
  try {
    const res = await fetch(`${API_BASE}/api/theaters?zip=${zip}&radius=${radiusSel.value}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.status);
    if (!data.theaters.length) {
      theaterList.innerHTML = `<p class="th-note">No theaters found within ${data.radius} miles of ${esc(data.place)}.</p>`;
      return;
    }
    theaterList.innerHTML =
      `<p class="th-note">${data.theaters.length} theater${data.theaters.length === 1 ? "" : "s"} near ${esc(data.place)}</p><ul>` +
      data.theaters.map((t) => {
        const addr = [t.street, t.city].filter(Boolean).join(", ");
        const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr ? `${t.name}, ${addr}` : `${t.lat},${t.lon}`)}`;
        const times = `https://www.google.com/search?q=${encodeURIComponent(`${t.name} ${t.city} showtimes`)}`;
        return `<li>
          <div class="th-head"><span class="th-name">${esc(t.name)}</span><span class="th-dist">${t.miles} mi</span></div>
          ${addr ? `<div class="th-addr">${esc(addr)}</div>` : ""}
          <div class="th-links">
            <a href="${times}" target="_blank" rel="noopener">Showtimes</a>
            <a href="${maps}" target="_blank" rel="noopener">Directions</a>
            ${t.website ? `<a href="${esc(t.website)}" target="_blank" rel="noopener">Website</a>` : ""}
            ${t.phone ? `<a href="tel:${esc(t.phone.replace(/[^\d+]/g, ""))}">${esc(t.phone)}</a>` : ""}
          </div>
        </li>`;
      }).join("") + `</ul>`;
  } catch (err) {
    theaterList.innerHTML = `<p class="th-note">Couldn't load theaters: ${esc(err.message)}</p>`;
  }
}

$("#zipForm").addEventListener("submit", findTheaters);
try { zipInput.value = localStorage.getItem("zip") || ""; } catch {}

// ---------- Wall ----------
function renderLists() {
  listsNav.innerHTML = "";
  for (const [path, label] of LISTS[state.type]) {
    const b = document.createElement("button");
    b.textContent = label;
    if (path === state.list && !state.query) b.className = "active";
    b.onclick = () => { state.list = path; state.query = ""; search.value = ""; reset(); };
    listsNav.append(b);
  }
}

function reset() {
  state.gen++;
  state.page = 1;
  state.totalPages = 1;
  state.loading = false;
  state.seen.clear();
  grid.innerHTML = "";
  renderLists();
  updateTheaterBar();
  loadMore();
}

async function loadMore() {
  if (state.loading || state.page > state.totalPages) return;
  const gen = state.gen;
  state.loading = true;
  statusEl.textContent = "Loading…";
  try {
    let data;
    if (state.type === "server") {
      // Everything from Sonarr (library.js); search filters your library by title
      data = await libraryPage(state.page, state.list, state.query);
    } else if (state.query) {
      const t = state.type === "anime" ? "tv" : state.type;
      data = await api(`search/${t}`, { query: state.query, page: state.page, include_adult: "false" });
      data.results.forEach((r) => (r.__type = t));
      if (state.type === "anime") data.results = data.results.filter((r) => isAnime(r) && sfw(r));
    } else if (LIST_QUERIES[state.list]) {
      const q = LIST_QUERIES[state.list]();
      const extra = q.sfw ? { include_adult: "false", without_keywords: await nsfwKeywordIds() } : {};
      data = await api(q.path, { ...q.params, ...extra, page: state.page });
      if (q.sfw) data.results = data.results.filter(sfw);
      data.results.forEach((r) => (r.__type = q.type));
    } else {
      data = await api(state.list, { page: state.page, region: "US" });
    }
    if (gen !== state.gen) return;
    state.totalPages = Math.min(data.total_pages || 1, 500);
    state.page++;
    for (const item of data.results) {
      if (state.seen.has(item.id)) continue;
      state.seen.add(item.id);
      grid.append(card(item));
    }
    statusEl.textContent = grid.children.length ? "" : "Nothing found.";
  } catch (e) {
    if (gen === state.gen) statusEl.textContent = "Couldn't load: " + e.message;
    return;
  } finally {
    if (gen === state.gen) state.loading = false;
  }
  // Keep filling if the screen isn't full yet
  requestAnimationFrame(() => {
    if (sentinel.getBoundingClientRect().top < innerHeight + 800) loadMore();
  });
}

function card(item) {
  const title = item.title || item.name;
  const date = fmtDate(item.release_date || item.first_air_date);
  const el = document.createElement("button");
  el.className = "card";
  el.title = title;
  el.innerHTML = `
    <span class="poster">${item.poster_path ? `<img loading="lazy" src="${esc(item.poster_path.startsWith("http") ? item.poster_path : IMG + "w342" + item.poster_path)}" alt="">` : `<span class="noimg">${esc(title)}</span>`}</span>
    <span class="title">${esc(title)}</span>
    <span class="date">${date || "TBA"}</span>
    ${item.vote_average ? `<span class="score">${Math.round(item.vote_average * 10)}%</span>` : ""}`;
  el.onclick = () => openDetail(item.__type || state.type, item.id);
  if (typeof libraryBadge === "function") libraryBadge(el, item); // Sonarr badge (library.js)
  return el;
}

// ---------- Detail ----------
async function openDetail(type, id) {
  body.innerHTML = `<p class="loading">Loading…</p>`;
  body.scrollTop = 0;
  if (!dlg.open) dlg.showModal();
  try {
    const d = await api(`${type}/${id}`, { append_to_response: "credits,videos,watch/providers,recommendations" });
    body.innerHTML = detailHTML(type, d);
    if (typeof libraryDetail === "function") libraryDetail(type, d); // Sonarr info (library.js)
    body.scrollTop = 0;
    body.querySelectorAll(".rec").forEach((b) => (b.onclick = () => openDetail(type, b.dataset.id)));
  } catch (e) {
    body.innerHTML = `<p class="loading">Couldn't load details: ${esc(e.message)}</p>`;
  }
}

function detailHTML(type, d) {
  const title = d.title || d.name;
  const released = fmtDate(d.release_date || d.first_air_date);
  const length = type === "movie"
    ? (d.runtime ? `${Math.floor(d.runtime / 60)}h ${d.runtime % 60}m` : "")
    : (d.number_of_seasons ? `${d.number_of_seasons} season${d.number_of_seasons === 1 ? "" : "s"} · ${d.number_of_episodes} episodes` : "");
  const makers = type === "movie"
    ? (d.credits?.crew || []).filter((c) => c.job === "Director").map((c) => c.name)
    : (d.created_by || []).map((c) => c.name);
  const vids = d.videos?.results || [];
  const trailer = vids.find((v) => v.site === "YouTube" && v.type === "Trailer") || vids.find((v) => v.site === "YouTube");
  const stream = d["watch/providers"]?.results?.US?.flatrate || [];
  const cast = (d.credits?.cast || []).slice(0, 20);
  const recs = (d.recommendations?.results || []).filter((r) => r.poster_path).slice(0, 15);

  const facts = [
    released,
    length,
    d.vote_average ? `${Math.round(d.vote_average * 10)}%` : "",
    type === "tv" ? d.status : "",
    ...(d.genres || []).map((g) => g.name),
  ].filter(Boolean);

  return `
    <div class="hero" style="${d.backdrop_path ? `background-image:url(${IMG}w1280${d.backdrop_path})` : ""}">
      <div class="hero-inner">
        ${d.poster_path ? `<img src="${IMG}w342${d.poster_path}" alt="">` : ""}
        <div>
          <h2>${esc(title)}</h2>
          ${d.tagline ? `<p class="tagline">${esc(d.tagline)}</p>` : ""}
          <div class="facts">${facts.map((f) => `<span>${esc(f)}</span>`).join("")}</div>
          ${trailer ? `<a class="trailer" href="https://www.youtube.com/watch?v=${trailer.key}" target="_blank" rel="noopener">▶ Trailer</a>` : ""}
        </div>
      </div>
    </div>

    <div class="section"><h3>Overview</h3><p>${esc(d.overview || "No overview available.")}</p></div>

    ${makers.length ? `<div class="section"><h3>${type === "movie" ? "Director" : "Created by"}</h3><div class="plain">${esc(makers.join(", "))}</div></div>` : ""}

    ${stream.length ? `<div class="section"><h3>Streaming</h3><div class="plain">${stream.map((p) => esc(p.provider_name)).join(" · ")}</div></div>` : ""}

    ${cast.length ? `
    <div class="section"><h3>Cast</h3>
      <div class="row">${cast.map((c) => `
        <div class="person">
          ${c.profile_path ? `<img loading="lazy" src="${IMG}w185${c.profile_path}" alt="">` : `<div class="ph"></div>`}
          ${esc(c.name)}<small>${esc(c.character || "")}</small>
        </div>`).join("")}
      </div>
    </div>` : ""}

    ${recs.length ? `
    <div class="section"><h3>More like this</h3>
      <div class="row">${recs.map((r) => `
        <button class="rec" data-id="${r.id}"><img loading="lazy" src="${IMG}w185${r.poster_path}" alt="">${esc(r.title || r.name)}</button>`).join("")}
      </div>
    </div>` : ""}`;
}

// ---------- Controls ----------
document.querySelectorAll(".toggle button").forEach((b) => {
  b.onclick = () => {
    if (b.dataset.type === state.type) return;
    state.type = b.dataset.type;
    state.list = LISTS[state.type][0][0];
    document.querySelectorAll(".toggle button").forEach((x) => x.classList.toggle("active", x === b));
    search.placeholder = `Search ${SEARCH_LABEL[state.type]}…`;
    reset();
  };
});

let debounce;
search.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => { state.query = search.value.trim(); reset(); }, 350);
});

$(".close").onclick = () => dlg.close();
dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });

new IntersectionObserver((entries) => { if (entries[0].isIntersecting) loadMore(); }, { rootMargin: "800px" }).observe(sentinel);


reset();