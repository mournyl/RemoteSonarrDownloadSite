// Serves the static site from /public and proxies /api/* to TMDB,
// adding your secret token server-side so it never reaches the browser.
const TMDB = "https://api.themoviedb.org/3";
const ALLOWED = /^\/(movie|tv|trending|search)\//;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const cors = { "Access-Control-Allow-Origin": "*" };
      if (request.method === "OPTIONS") return new Response(null, { headers: cors });
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: cors });

      const path = url.pathname.slice(4); // "/movie/now_playing"
      if (!ALLOWED.test(path)) return new Response("Not allowed", { status: 403, headers: cors });
      if (!env.TMDB_TOKEN) return new Response("TMDB_TOKEN secret is not set", { status: 500, headers: cors });

      const target = new URL(TMDB + path);
      url.searchParams.forEach((v, k) => target.searchParams.set(k, v));

      const res = await fetch(target, {
        headers: { Authorization: `Bearer ${env.TMDB_TOKEN}`, accept: "application/json" },
        cf: { cacheTtl: 1800, cacheEverything: true },
      });
      return new Response(res.body, {
        status: res.status,
        headers: { "content-type": "application/json", "cache-control": "public, max-age=600", ...cors },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
