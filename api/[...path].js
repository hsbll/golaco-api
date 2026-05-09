// ============================================================
//  Golaço API — Vercel Serverless (Node.js runtime)
//  Substituto do Cloudflare Worker. Mesmas rotas que o app.min.js
//  já consome. Roda em AWS Lambda, evitando o bloqueio cross-zone
//  da Cloudflare ao chamar 365scores/Sofascore.
// ============================================================

// ── Config ─────────────────────────────────────────────────
const COMPETITIONS = {
  113:  "Brasileirão Série A",
  116:  "Brasileirão Série B",
  5518: "Brasileirão Série C",
  115:  "Copa do Brasil",
  102:  "Copa Libertadores",
  389:  "Copa Sul-Americana",
};
const COMP_IDS = Object.keys(COMPETITIONS).join(",");

const WS      = "https://webws.365scores.com/web";
const PARAMS  = "langId=31&timezoneName=America/Sao_Paulo&userCountryId=21&appTypeId=5";
const SF_BASE = "https://api.sofascore.com/api/v1";

const TTL_MS = {
  live:      10_000,
  results:   120_000,
  upcoming:  300_000,
  stats:     15_000,
  standings: 600_000,
  sfLive:    15_000,
  sfEvent:   20_000,
  resultsHistorical: 3_600_000,
};

const FETCH_TIMEOUT_MS = 9000;

const BROWSER_HEADERS_365 = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
  "Referer": "https://www.365scores.com/",
  "Origin":  "https://www.365scores.com",
  "Sec-Fetch-Site": "same-site",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
};

const BROWSER_HEADERS_SF = {
  ...BROWSER_HEADERS_365,
  "Referer": "https://www.sofascore.com/",
  "Origin":  "https://www.sofascore.com",
};

// ── Cache em memória ─────────────────────────────────────
const cache = new Map();

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) { cache.delete(key); return null; }
  return e.value;
}

function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expires: Date.now() + ttlMs });
  if (cache.size > 200) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
}

// ── HTTP helpers ──────────────────────────────────────────
async function fetchWithTimeout(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } catch (err) {
    return {
      _exception: err?.name === "AbortError" ? `timeout after ${ms}ms` : (err?.message || String(err)),
      ok: false,
      status: 0,
    };
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, headers) {
  const res = await fetchWithTimeout(url, { headers });
  if (res._exception) {
    return { _error: true, status: 504, statusText: res._exception };
  }
  if (!res.ok) {
    let bodyHint = "";
    try { bodyHint = (await res.text()).slice(0, 240); } catch {}
    return { _error: true, status: res.status, statusText: res.statusText, bodyHint };
  }
  try {
    return await res.json();
  } catch {
    let bodyHint = "";
    try { bodyHint = (await res.clone().text()).slice(0, 240); } catch {}
    return {
      _error: true,
      status: 502,
      statusText: "upstream returned non-JSON (provavelmente challenge HTML)",
      bodyHint,
    };
  }
}

// ── Upstream wrappers ─────────────────────────────────────
const apiFetch = (path, extra = "") =>
  fetchJson(
    `${WS}${path}?${PARAMS}&competitions=${COMP_IDS}${extra ? `&${extra}` : ""}`,
    BROWSER_HEADERS_365
  );

const fetchGame = (gameId, matchupId) =>
  fetchJson(
    `${WS}/game/?${PARAMS}&gameId=${gameId}&matchupId=${matchupId || gameId}&topBookmaker=14`,
    BROWSER_HEADERS_365
  );

const fetchStats = (gameId) =>
  fetchJson(`${WS}/game/stats/?${PARAMS}&games=${gameId}`, BROWSER_HEADERS_365);

const sfFetch = (path) => fetchJson(`${SF_BASE}${path}`, BROWSER_HEADERS_SF);

// ── CORS / response helpers ───────────────────────────────
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  process.env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Vary": "Origin",
  };
}

function send(res, status, data, extra = {}) {
  const headers = {
    "Content-Type":  "application/json; charset=utf-8",
    "Cache-Control": "private, max-age=0, must-revalidate",
    ...corsHeaders(),
    ...extra,
  };
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.status(status).send(JSON.stringify(data));
}

async function cached(key, ttlMs, producer) {
  const hit = cacheGet(key);
  if (hit) return { ...hit, _cache: "HIT" };
  const fresh = await producer();
  if (fresh.status === 200) cacheSet(key, fresh, ttlMs);
  return { ...fresh, _cache: "MISS" };
}

function todayBR() {
  const br = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return br.toISOString().slice(0, 10);
}

// ── Producers ─────────────────────────────────────────────
async function produceLive() {
  const data = await apiFetch("/games/");
  if (data._error) return { status: 502, body: { error: "upstream_365", ...data } };
  return { status: 200, body: { games: data.games ?? [] } };
}

async function produceResults(from, to) {
  const extra = from && to ? `startDate=${from}&endDate=${to}` : "";
  const data  = await apiFetch("/games/results/", extra);
  if (data._error) return { status: 502, body: { error: "upstream_365", ...data } };
  return { status: 200, body: { games: data.games ?? [] } };
}

async function produceUpcoming(from, to) {
  const extra = from && to ? `startDate=${from}&endDate=${to}` : "";
  const data  = await apiFetch("/games/", extra);
  if (data._error) return { status: 502, body: { error: "upstream_365", ...data } };
  return { status: 200, body: { games: data.games ?? [] } };
}

async function produceStats(gameId) {
  const [statsResp, gameResp] = await Promise.all([
    fetchStats(gameId),
    fetchGame(gameId, gameId),
  ]);
  if (statsResp._error && gameResp._error) {
    return {
      status: 502,
      body: { error: "upstream_365", stats: statsResp, game: gameResp },
    };
  }
  return {
    status: 200,
    body: {
      ...(statsResp._error ? {} : statsResp),
      homeCompetitor: gameResp._error ? null : (gameResp.game?.homeCompetitor || null),
      awayCompetitor: gameResp._error ? null : (gameResp.game?.awayCompetitor || null),
    },
  };
}

async function produceStandings(comp) {
  const data = await fetchJson(
    `${WS}/stats/?${PARAMS}&competitions=${comp}&withSeasons=true`,
    BROWSER_HEADERS_365
  );
  if (data._error) return { status: 502, body: { error: "upstream_365", ...data } };
  return { status: 200, body: data };
}

async function produceSfLive() {
  const data = await sfFetch("/sport/football/events/live");
  if (data._error) return { status: 502, body: { error: "upstream_sf", ...data } };
  return { status: 200, body: data };
}

async function produceSfScheduled(date) {
  const data = await sfFetch(`/sport/football/scheduled-events/${date}`);
  if (data._error) return { status: 502, body: { error: "upstream_sf", ...data } };
  return { status: 200, body: data };
}

async function produceSfEvent(sfId, sub) {
  if (sub) {
    const data = await sfFetch(`/event/${sfId}/${sub}`);
    if (data._error) return { status: 502, body: { error: "upstream_sf", ...data } };
    return { status: 200, body: data };
  }
  const [event, stats, momentum, odds, h2h] = await Promise.all([
    sfFetch(`/event/${sfId}`),
    sfFetch(`/event/${sfId}/statistics`),
    sfFetch(`/event/${sfId}/momentum`),
    sfFetch(`/event/${sfId}/featured-odds`),
    sfFetch(`/event/${sfId}/h2h`),
  ]);
  return {
    status: 200,
    body: {
      event:    event._error    ? null : event,
      stats:    stats._error    ? null : stats,
      momentum: momentum._error ? null : momentum,
      odds:     odds._error     ? null : odds,
      h2h:      h2h._error      ? null : h2h,
    },
  };
}

async function produceDebug(targetUrl) {
  const url = targetUrl || `${WS}/games/?${PARAMS}&competitions=${COMP_IDS}`;
  const isSf = url.includes("sofascore.com");
  const headers = isSf ? BROWSER_HEADERS_SF : BROWSER_HEADERS_365;

  const res = await fetchWithTimeout(url, { headers });
  if (res._exception) {
    return {
      status: 200,
      body: { upstream: url, fetchFailed: true, error: res._exception },
    };
  }
  let body = "";
  try { body = await res.text(); } catch (e) { body = `<read error: ${e.message}>`; }

  return {
    status: 200,
    body: {
      upstream:      url,
      status:        res.status,
      statusText:    res.statusText,
      headers:       Object.fromEntries(res.headers),
      bodyLength:    body.length,
      bodyLooksHtml: body.trim().startsWith("<"),
      bodyHead:      body.slice(0, 1000),
    },
  };
}

// ── Router ────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    for (const [k, v] of Object.entries(corsHeaders())) res.setHeader(k, v);
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    return send(res, 405, { error: "method not allowed" });
  }

  // Parseia path e query direto da URL — req.query.path do catch-all
  // não é confiável no Node runtime do Vercel.
  const urlObj  = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const apiPath = urlObj.pathname.replace(/^\/api/, "") || "/";
  const segs    = apiPath.split("/").filter(Boolean);
  const route   = "/" + segs.join("/");
  const q       = Object.fromEntries(urlObj.searchParams);
  const cacheKey = req.url;

  try {
    if (route === "/" || route === "/health") {
      return send(res, 200, {
        ok: true,
        service: "golaco-api",
        version: "3.1-vercel",
        runtime: "node",
        debugRoute: route,
        debugSegs: segs,
        endpoints: [
          "/api/health",
          "/api/live",
          "/api/results?from=DD/MM/YYYY&to=DD/MM/YYYY",
          "/api/upcoming?from=&to=",
          "/api/stats/:gameId",
          "/api/standings?comp=113|116|5518",
          "/api/sf/live",
          "/api/sf/scheduled?date=YYYY-MM-DD",
          "/api/sf/event/:id[/:sub]",
          "/api/_debug?u=<url-opcional>",
        ],
      });
    }

    if (route === "/_debug") {
      const r = await produceDebug(q.u || "");
      return send(res, r.status, r.body);
    }

    if (route === "/live") {
      const r = await cached(cacheKey, TTL_MS.live, produceLive);
      return send(res, r.status, r.body, { "X-Cache": r._cache });
    }

    if (route === "/results") {
      const from = q.from || "";
      const to   = q.to   || "";
      const ttl  = (from && to) ? TTL_MS.resultsHistorical : TTL_MS.results;
      const r = await cached(cacheKey, ttl, () => produceResults(from, to));
      return send(res, r.status, r.body, { "X-Cache": r._cache });
    }

    if (route === "/upcoming") {
      const from = q.from || "";
      const to   = q.to   || "";
      const r = await cached(cacheKey, TTL_MS.upcoming, () => produceUpcoming(from, to));
      return send(res, r.status, r.body, { "X-Cache": r._cache });
    }

    if (segs[0] === "stats" && segs[1]) {
      const gameId = segs[1];
      if (!/^\d+$/.test(gameId)) return send(res, 400, { error: "invalid id" });
      const r = await cached(cacheKey, TTL_MS.stats, () => produceStats(gameId));
      return send(res, r.status, r.body, { "X-Cache": r._cache });
    }

    if (route === "/standings") {
      const comp = String(q.comp || "113");
      if (!/^\d+$/.test(comp)) return send(res, 400, { error: "invalid comp" });
      const r = await cached(cacheKey, TTL_MS.standings, () => produceStandings(comp));
      return send(res, r.status, r.body, { "X-Cache": r._cache });
    }

    if (route === "/sf/live") {
      const r = await cached(cacheKey, TTL_MS.sfLive, produceSfLive);
      return send(res, r.status, r.body, { "X-Cache": r._cache });
    }

    if (route === "/sf/scheduled") {
      const date = String(q.date || todayBR());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(res, 400, { error: "invalid date" });
      const r = await cached(cacheKey, TTL_MS.upcoming, () => produceSfScheduled(date));
      return send(res, r.status, r.body, { "X-Cache": r._cache });
    }

    if (segs[0] === "sf" && segs[1] === "event" && segs[2]) {
      const sfId = segs[2];
      const sub  = segs[3] || "";
      if (!/^\d+$/.test(sfId)) return send(res, 400, { error: "invalid id" });
      const r = await cached(cacheKey, TTL_MS.sfEvent, () => produceSfEvent(sfId, sub));
      return send(res, r.status, r.body, { "X-Cache": r._cache });
    }

    return send(res, 404, { error: "not found", route, segs });
  } catch (err) {
    return send(res, 500, { error: "internal", message: err?.message || String(err) });
  }
}
