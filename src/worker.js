// Serves the static site from /public and proxies /api/* to TMDB,
// adding your secret token server-side so it never reaches the browser.
//   /api/showtimes?zip=12345&radius=10&date=2026-10-04  movies + showtimes near a ZIP (needs GRACENOTE_KEY)
//   /api/theaters?zip=12345&radius=10                   nearby theaters only (OpenStreetMap, no key)
//   /api/library                                        your Sonarr shows (needs SONARR_URL + SONARR_API_KEY)
//   /api/movies                                         your Radarr movies (needs RADARR_URL + RADARR_API_KEY)
//   /api/episodes?series=123                            every episode of one Sonarr show
//   /api/downloads                                      what's downloading now (Sonarr/Radarr queues + live SABnzbd stats)
//   /api/server                                         what's connected (no secrets)
//   /api/request   POST {type, tmdbId, monitor}         add to Sonarr (720p) / Radarr (1080p) (logged in only)
//   /api/login     POST {password}  /api/logout POST    simple one-password login (LOGIN_PASSWORD secret)
const TMDB = "https://api.themoviedb.org/3";
const GRACENOTE = "https://data.tmsapi.com/v1.1";
const ALLOWED = /^\/(movie|tv|trending|search|discover)\//;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---- Login first: nothing else is served until you're logged in ----
    if (url.pathname === "/login") return loginPage();
    if (url.pathname === "/api/login") return login(request, env);
    if (url.pathname === "/api/logout") return logout(request);
    if (!(await isLoggedIn(request, env))) {
      if (url.pathname.startsWith("/api/")) {
        return new Response(JSON.stringify({ error: "Not logged in", loginRequired: true }), {
          status: 401, headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      return toLogin(url);
    }

    // ---- Every page load needs a fresh login ----
    // Logging in sets a one-time "ticket" cookie. Loading the page uses it up, so a reload,
    // a new tab, or a restored tab goes back to /login. (The session cookie stays for the
    // page's own API calls and files.)
    if (!url.pathname.startsWith("/api/") && isPageLoad(request, url)) {
      if (readCookie(request, TICKET_COOKIE) !== "1") return toLogin(url);
      const page = await env.ASSETS.fetch(request);
      const res = new Response(page.body, page);
      res.headers.set("cache-control", "no-store");
      res.headers.append("set-cookie", `${TICKET_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
      return res;
    }

    if (url.pathname.startsWith("/api/")) {
      const cors = { "Access-Control-Allow-Origin": "*" };
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" } });
      }
      if (url.pathname === "/api/request") return requestMedia(request, env, ctx, cors);
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: cors });
      if (url.pathname === "/api/server") return json(await serverInfo(request, env), 200, cors);

      if (url.pathname === "/api/showtimes") return showtimes(url, env, cors);
      if (url.pathname === "/api/theaters") return theaters(url, cors);
      if (url.pathname === "/api/library") return library(request, env, ctx, cors);
      if (url.pathname === "/api/movies") return movieLibrary(request, env, ctx, cors);
      if (url.pathname === "/api/episodes") return episodes(url, env, cors);
      if (url.pathname === "/api/downloads") return downloads(env, cors);

      const path = url.pathname.slice(4); // "/movie/now_playing"
      if (!ALLOWED.test(path)) return new Response("Not allowed", { status: 403, headers: cors });
      if (!env.TMDB_TOKEN) return new Response("TMDB_TOKEN secret is not set", { status: 500, headers: cors });

      const target = new URL(TMDB + path);
      url.searchParams.forEach((v, k) => target.searchParams.set(k, v));

      const res = await fetch(target, {
        headers: { Authorization: `Bearer ${env.TMDB_TOKEN}`, accept: "application/json" },
        // Cache successes for 30 min; never cache errors.
        cf: { cacheTtlByStatus: { "200-299": 1800, "400-599": 0 } },
      });
      return new Response(res.body, {
        status: res.status,
        headers: {
          "content-type": "application/json",
          "cache-control": res.ok ? "public, max-age=600" : "no-store",
          ...cors,
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
};

// ---------- Shared helpers ----------

const json = (data, status, cors, maxAge = 0) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store",
      ...cors,
    },
  });

// Straight-line distance in miles.
function miles(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(a));
}

function readZipRadius(url) {
  const zip = (url.searchParams.get("zip") || "").trim();
  const radius = Math.min(Math.max(Number(url.searchParams.get("radius")) || 10, 1), 50);
  return { zip, radius, ok: /^\d{5}$/.test(zip) };
}

// ---------- Showtimes near a ZIP code (Gracenote) ----------

// Premium formats worth calling out next to a showtime.
const FORMATS = [
  [/imax/i, "IMAX"], [/dolby cinema/i, "Dolby Cinema"], [/4dx/i, "4DX"], [/screenx/i, "ScreenX"],
  [/\bRPX\b/, "RPX"], [/\bXD\b/, "XD"], [/\b3D\b/, "3D"], [/open caption/i, "Open Caption"],
];

function formatOf(quals) {
  const q = String(quals || "");
  return FORMATS.filter(([re]) => re.test(q)).map(([, label]) => label).join(" · ");
}

function runtime(iso) {
  const m = String(iso || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m || (!m[1] && !m[2])) return "";
  return [m[1] && `${Number(m[1])}h`, m[2] && Number(m[2]) && `${Number(m[2])}m`].filter(Boolean).join(" ");
}

async function gracenote(path, params, key) {
  const u = new URL(GRACENOTE + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("api_key", key);
  const res = await fetch(u, {
    headers: { accept: "application/json" },
    // Showtimes change during the day; an hour keeps you well under the free key's limits.
    cf: { cacheTtlByStatus: { "200-299": 3600, "400-599": 0 } },
  });
  if (!res.ok) {
    const err = new Error(
      res.status === 403 || res.status === 401
        ? "Showtime service refused the request (check GRACENOTE_KEY, or the daily limit was hit)"
        : `Showtime service error ${res.status}`,
    );
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Find the TMDB match for a Gracenote movie so the page can show your posters and detail view.
async function tmdbMatch(movie, token) {
  const q = new URL(`${TMDB}/search/movie`);
  q.searchParams.set("query", movie.title.replace(/\s*\((?:\d{4}|re-?release|\d+(?:th|st|nd|rd) anniversary)[^)]*\)\s*$/i, ""));
  if (movie.year) q.searchParams.set("primary_release_year", movie.year);
  q.searchParams.set("include_adult", "false");
  try {
    const res = await fetch(q, {
      headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
      cf: { cacheTtlByStatus: { "200-299": 86400, "400-599": 0 } },
    });
    if (!res.ok) return null;
    const hit = ((await res.json()).results || [])[0];
    return hit ? { tmdbId: hit.id, poster: hit.poster_path || "", score: hit.vote_average || 0 } : null;
  } catch {
    return null;
  }
}

async function showtimes(url, env, cors) {
  const { zip, radius, ok } = readZipRadius(url);
  if (!ok) return json({ error: "Enter a 5-digit US ZIP code" }, 400, cors);
  if (!env.GRACENOTE_KEY) return json({ error: "Showtimes aren't set up yet (GRACENOTE_KEY missing)", noKey: true }, 501, cors);

  const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Bad date" }, 400, cors);

  let showings, theatreList;
  try {
    [showings, theatreList] = await Promise.all([
      gracenote("/movies/showings", { startDate: date, zip, radius, units: "mi" }, env.GRACENOTE_KEY),
      gracenote("/theatres", { zip, radius, units: "mi" }, env.GRACENOTE_KEY),
    ]);
  } catch (e) {
    return json({ error: e.message }, 502, cors);
  }

  // Theaters, keyed by Gracenote id
  const theaters = new Map();
  for (const t of Array.isArray(theatreList) ? theatreList : []) {
    const loc = t.location || {}, addr = loc.address || {}, geo = loc.geoCode || {};
    theaters.set(String(t.theatreId), {
      id: String(t.theatreId),
      name: t.name || "Movie theater",
      street: addr.street || "",
      city: [addr.city, addr.state].filter(Boolean).join(", "),
      phone: loc.telephone || "",
      lat: Number(geo.latitude) || null,
      lon: Number(geo.longitude) || null,
      miles: loc.distance != null ? Math.round(Number(loc.distance) * 10) / 10 : null,
      movies: new Map(),
    });
  }

  // Movies, and each theater's showtimes for them
  const movies = [];
  for (const m of Array.isArray(showings) ? showings : []) {
    if (!m || !m.tmsId || !Array.isArray(m.showtimes) || !m.showtimes.length) continue;
    const movie = {
      id: m.tmsId,
      title: m.title || "Untitled",
      year: m.releaseYear || "",
      rating: ((m.ratings || []).find((r) => /america/i.test(r.body || "")) || (m.ratings || [])[0] || {}).code || "",
      runtime: runtime(m.runTime),
      genres: Array.isArray(m.genres) ? m.genres : String(m.genres || "").split(",").map((g) => g.trim()).filter(Boolean),
      description: m.shortDescription || "",
      tmdbId: null, poster: "", score: 0,
      theaterCount: 0, showCount: 0,
    };
    for (const s of m.showtimes) {
      const tid = String((s.theatre && s.theatre.id) || "");
      if (!tid || !s.dateTime) continue;
      if (!theaters.has(tid)) {
        theaters.set(tid, { id: tid, name: (s.theatre && s.theatre.name) || "Movie theater", street: "", city: "", phone: "", lat: null, lon: null, miles: null, movies: new Map() });
      }
      const th = theaters.get(tid);
      if (!th.movies.has(movie.id)) { th.movies.set(movie.id, []); movie.theaterCount += 1; }
      th.movies.get(movie.id).push({
        time: s.dateTime,
        ticket: /^https?:\/\//i.test(s.ticketURI || "") ? s.ticketURI : "",
        format: formatOf(s.quals),
        bargain: Boolean(s.barg),
      });
      movie.showCount += 1;
    }
    if (movie.showCount) movies.push(movie);
  }

  // Posters and detail links from TMDB (capped to stay under the Worker's per-request fetch limit)
  if (env.TMDB_TOKEN) {
    movies.sort((a, b) => b.showCount - a.showCount);
    const matches = await Promise.all(movies.slice(0, 40).map((m) => tmdbMatch(m, env.TMDB_TOKEN)));
    matches.forEach((hit, i) => { if (hit) Object.assign(movies[i], hit); });
  }

  // Shape the output: theaters nearest first, each with its movies by earliest showtime
  const theaterOut = [...theaters.values()]
    .filter((t) => t.movies.size)
    .map((t) => ({
      ...t,
      movies: [...t.movies.entries()]
        .map(([movieId, times]) => ({ movieId, times: times.sort((a, b) => a.time.localeCompare(b.time)) }))
        .sort((a, b) => a.times[0].time.localeCompare(b.times[0].time)),
    }))
    .sort((a, b) => (a.miles ?? 999) - (b.miles ?? 999) || a.name.localeCompare(b.name));

  movies.sort((a, b) => b.theaterCount - a.theaterCount || b.showCount - a.showCount || a.title.localeCompare(b.title));

  return json({ zip, date, radius, movies, theaters: theaterOut }, 200, cors, 900);
}

// ---------- Theaters near a ZIP code (OpenStreetMap; used when showtimes aren't set up) ----------

async function theaters(url, cors) {
  const { zip, radius, ok } = readZipRadius(url);
  if (!ok) return json({ error: "Enter a 5-digit US ZIP code" }, 400, cors);

  // 1. ZIP -> coordinates (cached a week; ZIPs don't move)
  const z = await fetch(`https://api.zippopotam.us/us/${zip}`, {
    cf: { cacheTtlByStatus: { "200-299": 604800, "400-599": 0 } },
  });
  if (z.status === 404) return json({ error: `ZIP code ${zip} not found` }, 404, cors);
  if (!z.ok) return json({ error: "ZIP lookup failed, try again" }, 502, cors);
  const p = (await z.json()).places[0];
  const lat = Number(p.latitude), lon = Number(p.longitude);
  const place = `${p["place name"]}, ${p["state abbreviation"]}`;

  // 2. Cinemas within the radius from OpenStreetMap (cached a day per ZIP + radius)
  const m = Math.round(radius * 1609.34);
  const q = `[out:json][timeout:20];(nwr["amenity"="cinema"](around:${m},${lat},${lon}););out center tags;`;
  const o = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`, {
    headers: { "user-agent": "mournyl.com theater finder" },
    cf: { cacheTtlByStatus: { "200-299": 86400, "400-599": 0 } },
  });
  if (!o.ok) return json({ error: "Theater lookup is busy, try again in a minute" }, 502, cors);

  const list = [];
  for (const e of (await o.json()).elements || []) {
    const t = e.tags || {};
    const tlat = e.lat ?? e.center?.lat, tlon = e.lon ?? e.center?.lon;
    if (tlat == null || tlon == null) continue;
    const site = t.website || t["contact:website"] || "";
    list.push({
      name: t.name || t.brand || "Movie theater",
      street: [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" "),
      city: [t["addr:city"], t["addr:state"]].filter(Boolean).join(", "),
      phone: t.phone || t["contact:phone"] || "",
      website: /^https?:\/\//i.test(site) ? site : "",
      lat: tlat,
      lon: tlon,
      miles: Math.round(miles(lat, lon, tlat, tlon) * 10) / 10,
    });
  }
  list.sort((a, b) => a.miles - b.miles);

  return json({ zip, place, radius, theaters: list }, 200, cors, 3600);
}

// ---------- Your Sonarr library ----------
// Sonarr runs at home; the Worker reaches it through a Cloudflare Tunnel (SONARR_URL),
// sending your Sonarr API key and, if the tunnel is behind Cloudflare Access, a service token.

const LIBRARY_CACHE_SECONDS = 300;

async function library(request, env, ctx, cors) {
  if (!env.SONARR_URL || !env.SONARR_API_KEY) {
    return json({ error: "Sonarr isn't connected yet (SONARR_URL / SONARR_API_KEY missing)", notConfigured: true }, 501, cors);
  }

  // Cached copy for 5 minutes so every page view doesn't hit your server.
  // Uses a private cache key that visitors can't request directly.
  const cache = caches.default;
  const cacheKey = new Request(new URL("/__cache/sonarr-library", request.url).toString());
  // ?fresh=1 skips the cached copy (the site asks for that right after a download finishes)
  const hit = new URL(request.url).searchParams.has("fresh") ? null : await cache.match(cacheKey);
  if (hit) return new Response(hit.body, { headers: { ...Object.fromEntries(hit.headers), ...cors } });

  const headers = { "X-Api-Key": env.SONARR_API_KEY, accept: "application/json" };
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET;
  }

  let res;
  try {
    res = await fetch(env.SONARR_URL.replace(/\/+$/, "") + "/api/v3/series", { headers, redirect: "manual" });
  } catch (e) {
    return json({ error: "Couldn't reach Sonarr (is the tunnel running?)" }, 502, cors);
  }
  const type = res.headers.get("content-type") || "";
  if (res.status === 401) return json({ error: "Sonarr rejected the API key (check SONARR_API_KEY)" }, 502, cors);
  if (res.status >= 300 && res.status < 400 || (res.ok && !type.includes("json"))) {
    return json({ error: "Cloudflare Access blocked the request (check the service token secrets and the Access policy)" }, 502, cors);
  }
  if (res.status === 502 || res.status === 503 || res.status === 530) {
    return json({ error: "Sonarr is offline or the tunnel is down" }, 502, cors);
  }
  if (!res.ok) return json({ error: `Sonarr error ${res.status}` }, 502, cors);

  const series = await res.json();
  const shows = (Array.isArray(series) ? series : []).map((s) => {
    const st = s.statistics || {};
    const poster = (s.images || []).find((i) => i.coverType === "poster") || {};
    const posterUrl = /^https:\/\//i.test(poster.remoteUrl || "") ? poster.remoteUrl : "";
    return {
      id: s.id,                          // Sonarr's own id (episodes + downloads use it)
      tmdbId: s.tmdbId || 0,
      tvdbId: s.tvdbId || 0,
      title: s.title || "",
      sortTitle: s.sortTitle || (s.title || "").toLowerCase(),
      year: s.year || 0,
      firstAired: (s.firstAired || "").slice(0, 10),
      status: s.status || "",            // continuing, ended, upcoming
      monitored: Boolean(s.monitored),
      network: s.network || "",
      seriesType: s.seriesType || "",    // standard, anime, daily
      genres: Array.isArray(s.genres) ? s.genres : [],
      have: st.episodeFileCount || 0,    // episodes downloaded
      aired: st.episodeCount || 0,       // monitored episodes that have aired
      total: st.totalEpisodeCount || 0,
      sizeGB: Math.round(((st.sizeOnDisk || 0) / 1073741824) * 10) / 10,
      nextAiring: s.nextAiring || "",
      poster: posterUrl,
    };
  }).sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));

  const out = new Response(JSON.stringify({ updated: new Date().toISOString(), shows }), {
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${LIBRARY_CACHE_SECONDS}` },
  });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return new Response(out.body, { headers: { ...Object.fromEntries(out.headers), ...cors } });
}

// ---------- Add to My Server (Sonarr for TV, Radarr for movies) ----------
// Adding only works when you're logged in, so nobody else can add downloads through the site.
// TV uses Sonarr's "HD-720p" profile and movies use Radarr's "HD-1080p" profile,
// unless SONARR_PROFILE / RADARR_PROFILE say otherwise.

const MONITOR_OPTIONS = new Set(["all", "lastSeason", "firstSeason", "future"]);


async function serverInfo(request, env) {
  const loggedIn = await isLoggedIn(request, env);
  return {
    tv: Boolean(env.SONARR_URL && env.SONARR_API_KEY),
    movie: Boolean(env.RADARR_URL && env.RADARR_API_KEY),
    add: loggedIn,
    login: Boolean(env.LOGIN_PASSWORD),
    loggedIn,
  };
}

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function arr(env, base, key, app, path, init = {}) {
  const headers = { "X-Api-Key": key, accept: "application/json", "content-type": "application/json" };
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET;
  }
  let res;
  try {
    res = await fetch(base.replace(/\/+$/, "") + "/api/v3" + path, { ...init, headers, redirect: "manual" });
  } catch {
    throw httpErr(502, `Couldn't reach ${app} (is the tunnel running?)`);
  }
  const type = res.headers.get("content-type") || "";
  if (res.status === 401) throw httpErr(502, `${app} rejected the API key`);
  if ((res.status >= 300 && res.status < 400) || (res.ok && !type.includes("json"))) {
    throw httpErr(502, `Cloudflare Access blocked the request to ${app}`);
  }
  if ([502, 503, 530].includes(res.status)) throw httpErr(502, `${app} is offline or the tunnel is down`);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = Array.isArray(body) ? body.map((e) => e.errorMessage).filter(Boolean).join("; ") : body && body.message;
    throw httpErr(res.status === 400 ? 409 : 502, msg || `${app} error ${res.status}`);
  }
  return body;
}

async function tmdbGet(env, path) {
  const res = await fetch(`${TMDB}/${path}`, { headers: { Authorization: `Bearer ${env.TMDB_TOKEN}`, accept: "application/json" } });
  if (!res.ok) throw httpErr(502, `TMDB error ${res.status}`);
  return res.json();
}

function pickProfile(profiles, wanted, app) {
  const p = (profiles || []).find((x) => String(x.name).toLowerCase() === wanted.toLowerCase());
  if (!p) {
    const names = (profiles || []).map((x) => x.name).join(", ");
    throw httpErr(409, `No "${wanted}" quality profile in ${app}${names ? ` (it has: ${names})` : ""}`);
  }
  return p;
}

function pickRoot(roots, wanted, app) {
  const list = (roots || []).map((r) => r.path);
  if (!list.length) throw httpErr(409, `${app} has no root folder set up (Settings → Media Management)`);
  if (!wanted) return list[0];
  const norm = (p) => String(p).replace(/[\\/]+$/, "").toLowerCase();
  const hit = list.find((p) => norm(p) === norm(wanted));
  if (!hit) throw httpErr(409, `Root folder "${wanted}" isn't set up in ${app}`);
  return hit;
}

async function addSeries(env, tmdbId, monitor) {
  if (!env.SONARR_URL || !env.SONARR_API_KEY) throw httpErr(501, "Sonarr isn't connected");
  const S = (path, init) => arr(env, env.SONARR_URL, env.SONARR_API_KEY, "Sonarr", path, init);

  // Sonarr identifies shows by TVDB id, so get it from TMDB first
  const show = await tmdbGet(env, `tv/${tmdbId}?append_to_response=external_ids`);
  const tvdbId = show.external_ids && show.external_ids.tvdb_id;
  if (!tvdbId) throw httpErr(404, "This show has no TVDB ID, so Sonarr can't add it");

  const [found, profiles, roots] = await Promise.all([
    S(`/series/lookup?term=${encodeURIComponent(`tvdb:${tvdbId}`)}`),
    S("/qualityprofile"),
    S("/rootfolder"),
  ]);
  const series = (Array.isArray(found) ? found : [])[0];
  if (!series) throw httpErr(404, "Sonarr couldn't find this show");
  if (series.id) return { status: "exists", title: series.title, message: "Already on your server." };

  const anime = (show.genres || []).some((g) => g.id === 16) &&
    (show.original_language === "ja" || (show.origin_country || []).includes("JP"));
  const profile = pickProfile(profiles, env.SONARR_PROFILE || "HD-720p", "Sonarr");
  const rootFolderPath = pickRoot(roots, anime ? env.SONARR_ANIME_ROOT || env.SONARR_ROOT : env.SONARR_ROOT, "Sonarr");

  const added = await S("/series", {
    method: "POST",
    body: JSON.stringify({
      ...series,
      qualityProfileId: profile.id,
      rootFolderPath,
      monitored: true,
      seasonFolder: true,
      seriesType: anime ? "anime" : "standard",
      addOptions: { monitor, searchForMissingEpisodes: true, searchForCutoffUnmetEpisodes: false },
    }),
  });
  return { status: "added", title: added.title || series.title, profile: profile.name, message: `Added. Sonarr is searching for ${profile.name} episodes now.` };
}

async function addMovie(env, tmdbId) {
  if (!env.RADARR_URL || !env.RADARR_API_KEY) throw httpErr(501, "Radarr isn't connected");
  const R = (path, init) => arr(env, env.RADARR_URL, env.RADARR_API_KEY, "Radarr", path, init);

  const [movie, profiles, roots] = await Promise.all([
    R(`/movie/lookup/tmdb?tmdbId=${tmdbId}`),
    R("/qualityprofile"),
    R("/rootfolder"),
  ]);
  if (!movie || !movie.tmdbId) throw httpErr(404, "Radarr couldn't find this movie");
  if (movie.id) return { status: "exists", title: movie.title, message: "Already on your server." };

  const profile = pickProfile(profiles, env.RADARR_PROFILE || "HD-1080p", "Radarr");
  const rootFolderPath = pickRoot(roots, env.RADARR_ROOT, "Radarr");
  const added = await R("/movie", {
    method: "POST",
    body: JSON.stringify({
      ...movie,
      qualityProfileId: profile.id,
      rootFolderPath,
      monitored: true,
      minimumAvailability: "released",
      addOptions: { searchForMovie: true },
    }),
  });
  return { status: "added", title: added.title || movie.title, profile: profile.name, message: `Added. Radarr is searching for a ${profile.name} copy now.` };
}

async function requestMedia(request, env, ctx, cors) {
  if (request.method !== "POST") return json({ error: "Use POST" }, 405, cors);
  if (!(await isLoggedIn(request, env))) return json({ error: "Log in to add things to your server" }, 403, cors);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400, cors); }
  const tmdbId = Number(body && body.tmdbId);
  const type = body && body.type;
  if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !["tv", "movie"].includes(type)) return json({ error: "Bad request" }, 400, cors);

  try {
    const result = type === "tv"
      ? await addSeries(env, tmdbId, MONITOR_OPTIONS.has(body.monitor) ? body.monitor : "all")
      : await addMovie(env, tmdbId);
    // Make My Server show the new title right away instead of after the 5-minute cache
    if (result.status === "added") {
      const key = type === "tv" ? "/__cache/sonarr-library" : "/__cache/radarr-library";
      ctx.waitUntil(caches.default.delete(new Request(new URL(key, request.url).toString())));
    }
    return json(result, 200, cors);
  } catch (e) {
    return json({ error: e.message || "Something went wrong" }, e.status || 502, cors);
  }
}

// ---------- Login ----------
// The whole site is behind one password (LOGIN_PASSWORD secret). Logging in sets a signed,
// HttpOnly session cookie (for the page's API calls, max SESSION_HOURS) plus a one-time ticket
// that only the next page load can use, so every load of the site asks for the password. Changing LOGIN_PASSWORD logs out every device.
// wrangler.jsonc needs "run_worker_first": true so page files go through this check too.

const SESSION_COOKIE = "mournyl_session";
const TICKET_COOKIE = "mournyl_ticket";

// A full page load (typing the address, reload, new tab) rather than a script, style or image
function isPageLoad(request, url) {
  const dest = request.headers.get("sec-fetch-dest");
  if (dest) return dest === "document" || dest === "iframe";
  return url.pathname === "/" || url.pathname.endsWith(".html");
}

// Send to /login and drop the old session so the password is needed again
function toLogin(url) {
  return new Response(null, {
    status: 302,
    headers: {
      location: new URL("/login", url).toString(),
      "cache-control": "no-store",
      "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    },
  });
}
const SESSION_HOURS = 4;
const textEnc = new TextEncoder();

function sameText(given, expected) {
  const a = String(given || ""), b = String(expected || "");
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0 && b.length > 0;
}

async function sign(env, data) {
  const key = await crypto.subtle.importKey("raw", textEnc.encode("mournyl-session:" + env.LOGIN_PASSWORD),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, textEnc.encode(data)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readCookie(request, name) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}

async function isLoggedIn(request, env) {
  if (!env.LOGIN_PASSWORD) return false;
  const [expires, sig] = readCookie(request, SESSION_COOKIE).split(".");
  if (!expires || !sig || !(Number(expires) > Date.now())) return false;
  return sameText(sig, await sign(env, expires));
}

const sessionResponse = (body, status, cookie) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...(cookie ? { "set-cookie": cookie } : {}) },
  });

async function login(request, env) {
  if (request.method !== "POST") return sessionResponse({ error: "Use POST" }, 405);
  if (!env.LOGIN_PASSWORD) return sessionResponse({ error: "Login isn't set up (LOGIN_PASSWORD missing)" }, 501);
  let body;
  try { body = await request.json(); } catch { return sessionResponse({ error: "Bad request" }, 400); }
  if (!sameText(body && body.password, env.LOGIN_PASSWORD)) {
    await new Promise((r) => setTimeout(r, 1000)); // slow down password guessing
    return sessionResponse({ error: "Wrong password" }, 401);
  }
  const expires = String(Date.now() + SESSION_HOURS * 3600000);
  // No Max-Age/Expires: a session cookie, deleted when the browser closes
  const cookie = `${SESSION_COOKIE}=${expires}.${await sign(env, expires)}; Path=/; HttpOnly; Secure; SameSite=Strict`;
  const res = sessionResponse({ ok: true }, 200, cookie);
  // One-time ticket for the page load right after logging in (used up by that load)
  res.headers.append("set-cookie", `${TICKET_COOKIE}=1; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=60`);
  return res;
}

function logout(request) {
  if (request.method !== "POST") return sessionResponse({ error: "Use POST" }, 405);
  return sessionResponse({ ok: true }, 200, `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

function loginPage() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <title>mournyl</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=UnifrakturMaguntia&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px;
      background: #121212; color: #e8e8e8; font: 14px/1.4 "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    main { width: 100%; max-width: 320px; text-align: center; }
    h1 {
      font-family: "UnifrakturMaguntia", "Old English Text MT", serif; font-weight: 400;
      font-size: clamp(56px, 16vw, 96px); line-height: 1; color: #f2f2f2;
      text-shadow: 0 0 40px rgba(255, 255, 255, .08); margin-bottom: 32px;
    }
    form { display: flex; flex-direction: column; gap: 10px; }
    input {
      padding: 11px 14px; border: 0; border-radius: 4px; outline: none;
      background: #1b1b1b; color: #e8e8e8; font: inherit; text-align: center;
    }
    input:focus { background: #262626; }
    input::placeholder { color: #5c5c5c; }
    button {
      padding: 11px 14px; border: 0; border-radius: 4px; cursor: pointer;
      background: #e8e8e8; color: #111; font: inherit; font-weight: 600;
    }
    button:disabled { opacity: .6; cursor: default; }
    p { min-height: 1.4em; margin-top: 6px; font-size: 12px; color: #e07a7a; }
  </style>
</head>
<body>
  <main>
    <h1>mournyl</h1>
    <form id="f">
      <input id="pw" type="password" placeholder="Password" autocomplete="current-password" aria-label="Password" required autofocus>
      <button type="submit">Log in</button>
    </form>
    <p id="msg" role="status"></p>
  </main>
  <script>
    const f = document.getElementById("f"), pw = document.getElementById("pw"), msg = document.getElementById("msg");
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = f.querySelector("button");
      btn.disabled = true; msg.textContent = "";
      try {
        const res = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw.value }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Error " + res.status);
        location.replace("/");
      } catch (err) {
        msg.textContent = err.message; pw.select();
      } finally {
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// ---------- Your Radarr movies ----------
async function movieLibrary(request, env, ctx, cors) {
  if (!env.RADARR_URL || !env.RADARR_API_KEY) {
    return json({ error: "Radarr isn't connected yet (RADARR_URL / RADARR_API_KEY missing)", notConfigured: true }, 501, cors);
  }
  const cache = caches.default;
  const cacheKey = new Request(new URL("/__cache/radarr-library", request.url).toString());
  // ?fresh=1 skips the cached copy (the site asks for that right after a download finishes)
  const hit = new URL(request.url).searchParams.has("fresh") ? null : await cache.match(cacheKey);
  if (hit) return new Response(hit.body, { headers: { ...Object.fromEntries(hit.headers), ...cors } });

  let list;
  try {
    list = await arr(env, env.RADARR_URL, env.RADARR_API_KEY, "Radarr", "/movie");
  } catch (e) {
    return json({ error: e.message }, e.status || 502, cors);
  }
  const movies = (Array.isArray(list) ? list : []).map((m) => {
    const poster = (m.images || []).find((i) => i.coverType === "poster") || {};
    const file = m.movieFile || {};
    return {
      id: m.id,                          // Radarr's own id (downloads use it)
      tmdbId: m.tmdbId || 0,
      title: m.title || "",
      sortTitle: m.sortTitle || (m.title || "").toLowerCase(),
      year: m.year || 0,
      released: (m.digitalRelease || m.physicalRelease || m.inCinemas || "").slice(0, 10),
      monitored: Boolean(m.monitored),
      hasFile: Boolean(m.hasFile),
      available: Boolean(m.isAvailable),
      quality: (file.quality && file.quality.quality && file.quality.quality.name) || "",
      sizeGB: Math.round(((m.sizeOnDisk || file.size || 0) / 1073741824) * 10) / 10,
      poster: /^https:\/\//i.test(poster.remoteUrl || "") ? poster.remoteUrl : "",
    };
  }).sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));

  const out = new Response(JSON.stringify({ updated: new Date().toISOString(), movies }), {
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${LIBRARY_CACHE_SECONDS}` },
  });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return new Response(out.body, { headers: { ...Object.fromEntries(out.headers), ...cors } });
}

// ---------- Episodes of one show (Sonarr) ----------
async function episodes(url, env, cors) {
  if (!env.SONARR_URL || !env.SONARR_API_KEY) return json({ error: "Sonarr isn't connected" }, 501, cors);
  const id = Number(url.searchParams.get("series"));
  if (!Number.isInteger(id) || id <= 0) return json({ error: "Missing series id" }, 400, cors);
  try {
    const list = await arr(env, env.SONARR_URL, env.SONARR_API_KEY, "Sonarr", `/episode?seriesId=${id}&includeEpisodeFile=true`);
    const eps = (Array.isArray(list) ? list : []).map((e) => {
      const file = e.episodeFile || {};
      return {
        id: e.id,
        season: e.seasonNumber || 0,
        number: e.episodeNumber || 0,
        title: e.title || "",
        airDate: e.airDateUtc || e.airDate || "",
        hasFile: Boolean(e.hasFile),
        monitored: Boolean(e.monitored),
        quality: (file.quality && file.quality.quality && file.quality.quality.name) || "",
        sizeMB: Math.round((file.size || 0) / 1048576),
      };
    }).sort((a, b) => a.season - b.season || a.number - b.number);
    return json({ episodes: eps }, 200, cors);
  } catch (e) {
    return json({ error: e.message }, e.status || 502, cors);
  }
}

// ---------- What's downloading now ----------
// Sonarr's and Radarr's queues say WHICH show/episode/movie each download is.
// SABnzbd (optional: SAB_URL + SAB_API_KEY) adds live percent, speed and time left.
// Without SAB it still works using the queues, which Sonarr/Radarr refresh about once a minute.

// "1.02:03:04" / "02:03:04" / "0:05:12" -> seconds
function toSeconds(t) {
  const m = String(t || "").match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+)/);
  return m ? (+(m[1] || 0)) * 86400 + (+m[2]) * 3600 + (+m[3]) * 60 + (+m[4]) : null;
}

async function sabQueue(env) {
  if (!env.SAB_URL || !env.SAB_API_KEY) return null;
  const headers = { accept: "application/json" };
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET;
  }
  const target = new URL(env.SAB_URL.replace(/\/+$/, "") + "/api");
  target.search = new URLSearchParams({ mode: "queue", output: "json", apikey: env.SAB_API_KEY, limit: "200" });
  let res;
  try {
    res = await fetch(target, { headers, redirect: "manual" });
  } catch {
    throw new Error("Couldn't reach SABnzbd (is the tunnel running?)");
  }
  const type = res.headers.get("content-type") || "";
  if (res.status === 403) throw new Error("SABnzbd refused the request (add sab.mournyl.com to SABnzbd's host_whitelist)");
  if ((res.status >= 300 && res.status < 400) || (res.ok && !type.includes("json"))) {
    throw new Error("Cloudflare Access blocked the request to SABnzbd");
  }
  if ([502, 503, 530].includes(res.status)) throw new Error("SABnzbd is offline or the tunnel is down");
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) throw new Error(`SABnzbd error ${res.status}`);
  if (body.status === false || body.error) throw new Error(`SABnzbd: ${body.error || "error"}`);
  return body.queue || {};
}

const arrQueue = (env, base, key, app, extra) =>
  base && key ? arr(env, base, key, app, `/queue?page=1&pageSize=200${extra}`).then((r) => (r && r.records) || []) : Promise.resolve([]);

async function downloads(env, cors) {
  const [tvQ, movieQ, sab] = await Promise.allSettled([
    arrQueue(env, env.SONARR_URL, env.SONARR_API_KEY, "Sonarr", "&includeEpisode=true&includeSeries=true"),
    arrQueue(env, env.RADARR_URL, env.RADARR_API_KEY, "Radarr", "&includeMovie=true"),
    sabQueue(env),
  ]);
  const errors = [tvQ, movieQ, sab].filter((r) => r.status === "rejected").map((r) => r.reason.message);
  const q = sab.status === "fulfilled" ? sab.value : null;

  // SAB slots by nzo_id (Sonarr/Radarr's downloadId)
  const slots = new Map();
  for (const s of (q && q.slots) || []) slots.set(String(s.nzo_id || "").toLowerCase(), s);

  const used = new Set();
  const item = (r, extra) => {
    const slot = slots.get(String(r.downloadId || "").toLowerCase());
    if (slot) used.add(slot);
    const size = r.size || 0, left = r.sizeleft || 0;
    let status = String(r.status || "").toLowerCase();                 // downloading, queued, paused, completed, failed, warning…
    const tracked = String(r.trackedDownloadState || "").toLowerCase(); // downloading, importPending, importing, failedPending…
    if (tracked.startsWith("import")) status = "importing";
    else if (tracked.startsWith("fail")) status = "failed";
    if (slot) status = /paused/i.test(slot.status) ? "paused" : /queued/i.test(slot.status) ? "queued" : "downloading";
    const pct = slot ? Number(slot.percentage) : size ? ((size - left) / size) * 100 : 0;
    return {
      ...extra,
      release: r.title || (slot && slot.filename) || "",
      order: slot ? Number(slot.index) || 0 : 9999,
      status,
      percent: Math.max(0, Math.min(100, Math.round(pct * 10) / 10)),
      sizeMB: Math.round(slot ? Number(slot.mb) : size / 1048576),
      leftMB: Math.round(slot ? Number(slot.mbleft) : left / 1048576),
      secondsLeft: status === "downloading" ? toSeconds(slot ? slot.timeleft : r.timeleft) : null,
      warning: status === "failed" || r.trackedDownloadStatus === "warning"
        ? ((r.statusMessages || [])[0] || {}).messages?.[0] || r.errorMessage || "" : "",
    };
  };

  const items = [];
  if (tvQ.status === "fulfilled") {
    for (const r of tvQ.value) {
      const ep = r.episode || {};
      items.push(item(r, {
        type: "tv", seriesId: r.seriesId, episodeId: r.episodeId, season: ep.seasonNumber, episode: ep.episodeNumber,
        title: (r.series && r.series.title) || "", episodeTitle: ep.title || "",
      }));
    }
  }
  if (movieQ.status === "fulfilled") {
    for (const r of movieQ.value) {
      items.push(item(r, { type: "movie", movieId: r.movieId, title: (r.movie && r.movie.title) || "", year: (r.movie && r.movie.year) || 0 }));
    }
  }
  // Anything else in SABnzbd that Sonarr/Radarr didn't send (added by hand)
  for (const slot of slots.values()) {
    if (used.has(slot)) continue;
    const st = /paused/i.test(slot.status) ? "paused" : /queued/i.test(slot.status) ? "queued" : "downloading";
    items.push({
      type: "other", title: slot.filename || "", release: slot.filename || "", order: Number(slot.index) || 0, status: st,
      percent: Number(slot.percentage) || 0, sizeMB: Math.round(Number(slot.mb) || 0), leftMB: Math.round(Number(slot.mbleft) || 0),
      secondsLeft: st === "downloading" ? toSeconds(slot.timeleft) : null, warning: "",
    });
  }
  items.sort((a, b) => a.order - b.order);

  return json({
    items,
    sab: q ? {
      paused: Boolean(q.paused) || /paused/i.test(q.status || ""),
      speedKBs: Math.round(Number(q.kbpersec) || 0),
      secondsLeft: toSeconds(q.timeleft),
    } : null,
    errors,
  }, 200, cors);
}
