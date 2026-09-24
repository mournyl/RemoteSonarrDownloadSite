// When you open index.html by double-clicking (file://), API calls go to your live site.
// Put your deployed URL here, e.g. "https://yourdomain.com". On the live site it's ignored.
const LIVE_SITE = "https://yourdomain.com";
const API_BASE = location.protocol === "file:" ? LIVE_SITE : "";

// TESTING ONLY: with a token here, the page calls TMDB directly (no Worker needed).
// Set it back to "" before committing, or your key goes public on GitHub.
const TEST_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI2NTA5NzgxZjI1YmE4Zjk0YjJiMjUzYTQwM2NlMWE1NCIsIm5iZiI6MTc5MDIwODg4NC4wMDgsInN1YiI6IjZhYjQ2Yjc0MTFiMDVmYThjNzNmODNkZCIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.12XM1Ba4Lcj8OcrwmgYv6NoBsdDNAP1ytjw6lPgCixA"; // DELETE BEFORE COMMITTING

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
};

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
  const res = TEST_TOKEN
    ? await fetch(`https://api.themoviedb.org/3/${path}?${qs}`, { headers: { Authorization: `Bearer ${TEST_TOKEN}` } })
    : await fetch(`${API_BASE}/api/${path}?${qs}`);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

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
  loadMore();
}

async function loadMore() {
  if (state.loading || state.page > state.totalPages) return;
  const gen = state.gen;
  state.loading = true;
  statusEl.textContent = "Loading…";
  try {
    const data = state.query
      ? await api(`search/${state.type}`, { query: state.query, page: state.page })
      : await api(state.list, { page: state.page, region: "US" });
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
    <span class="poster">${item.poster_path ? `<img loading="lazy" src="${IMG}w342${item.poster_path}" alt="">` : `<span class="noimg">${esc(title)}</span>`}</span>
    <span class="title">${esc(title)}</span>
    <span class="date">${date || "TBA"}</span>
    ${item.vote_average ? `<span class="score">${Math.round(item.vote_average * 10)}%</span>` : ""}`;
  el.onclick = () => openDetail(state.type, item.id);
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
    search.placeholder = `Search ${state.type === "movie" ? "movies" : "TV shows"}…`;
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