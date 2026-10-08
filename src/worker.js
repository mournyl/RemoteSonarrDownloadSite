// Serves the static site from /public and proxies /api/* to TMDB,
// adding your secret token server-side so it never reaches the browser.
//   /api/showtimes?zip=12345&radius=10&date=2026-10-04  movies + showtimes near a ZIP (needs GRACENOTE_KEY)
//   /api/theaters?zip=12345&radius=10                   nearby theaters only (OpenStreetMap, no key)
//   /api/library                                        your Sonarr shows (needs SONARR_URL + SONARR_API_KEY)
//   /api/server                                         what's connected (no secrets)
//   /api/request   POST {type, tmdbId, monitor}         add to Sonarr/Radarr in 720p (local copy only, until login exists)
const TMDB = "https://api.themoviedb.org/3";
const GRACENOTE = "https://data.tmsapi.com/v1.1";
const ALLOWED = /^\/(movie|tv|trending|search|discover)\//;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const cors = { "Access-Control-Allow-Origin": "*" };
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" } });
      }
      if (url.pathname === "/api/request") return requestMedia(request, env, ctx, cors);
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: cors });
      if (url.pathname === "/api/server") return json(serverInfo(env, url), 200, cors);

      if (url.pathname === "/api/showtimes") return showtimes(url, env, cors);
      if (url.pathname === "/api/theaters") return theaters(url, cors);
      if (url.pathname === "/api/library") return library(request, env, ctx, cors);

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
  const hit = await cache.match(cacheKey);
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
// For now adding only works on your local copy (npx wrangler dev at localhost), so nobody can
// add downloads through the public site. Replace isLocal() with a real login check later.
// Uses the "HD-720p" quality profile (720p only, never upgrades past 720p) unless
// SONARR_PROFILE / RADARR_PROFILE say otherwise.

const MONITOR_OPTIONS = new Set(["all", "lastSeason", "firstSeason", "future"]);

const isLocal = (url) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

function serverInfo(env, url) {
  return {
    tv: Boolean(env.SONARR_URL && env.SONARR_API_KEY),
    movie: Boolean(env.RADARR_URL && env.RADARR_API_KEY),
    add: isLocal(url),
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

  const profile = pickProfile(profiles, env.RADARR_PROFILE || "HD-720p", "Radarr");
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
  if (!isLocal(new URL(request.url))) return json({ error: "Adding only works on your local copy for now" }, 403, cors);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400, cors); }
  const tmdbId = Number(body && body.tmdbId);
  const type = body && body.type;
  if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !["tv", "movie"].includes(type)) return json({ error: "Bad request" }, 400, cors);

  try {
    const result = type === "tv"
      ? await addSeries(env, tmdbId, MONITOR_OPTIONS.has(body.monitor) ? body.monitor : "all")
      : await addMovie(env, tmdbId);
    // Make My Server show the new show right away instead of after the 5-minute cache
    if (type === "tv" && result.status === "added") {
      ctx.waitUntil(caches.default.delete(new Request(new URL("/__cache/sonarr-library", request.url).toString())));
    }
    return json(result, 200, cors);
  } catch (e) {
    return json({ error: e.message || "Something went wrong" }, e.status || 502, cors);
  }
}
