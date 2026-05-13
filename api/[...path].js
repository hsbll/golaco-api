// ============================================================
//  Golaço API — Vercel Serverless v5.0

// ============================================================

// ── Competições ───────────────────────────────────────────
const COMPETITIONS = {
  113:  "Brasileirão Série A",
  116:  "Brasileirão Série B",
  5518: "Brasileirão Série C",
  115:  "Copa do Brasil",
  102:  "Copa Libertadores",
  389:  "Copa Sul-Americana",
};
const COMP_IDS = Object.keys(COMPETITIONS).join(",");

// ── Endpoints upstream (fallback) ─────────────────────────
const WS      = "https://webws.365scores.com/web";
const PARAMS  = "langId=31&timezoneName=America/Sao_Paulo&userCountryId=21&appTypeId=5";
const SF_BASE = "https://api.sofascore.com/api/v1";

// ── TTLs de cache em memória (ms) ────────────────────────
const TTL = {
  live:               10_000,
  results:           120_000,
  resultsHistorical: 3_600_000,
  upcoming:          300_000,
  stats:              15_000,
  standings:         300_000,  // 5min — banco atualiza 1x/dia
  sfLive:             15_000,
  sfEvent:            20_000,
};

const FETCH_TIMEOUT_MS = 9_000;
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 30;

// ── Headers browser ───────────────────────────────────────
const H365 = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":          "application/json, text/plain, */*",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
  "Referer":         "https://www.365scores.com/",
  "Origin":          "https://www.365scores.com",
  "Sec-Fetch-Site":  "same-site",
  "Sec-Fetch-Mode":  "cors",
  "Sec-Fetch-Dest":  "empty",
};

const HSF = {
  ...H365,
  "Referer": "https://www.sofascore.com/",
  "Origin":  "https://www.sofascore.com",
};

// ── Cache em memória ──────────────────────────────────────
const _cache = new Map();

function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) { _cache.delete(key); return null; }
  _cache.delete(key);
  _cache.set(key, e);
  return e.value;
}

function cacheSet(key, value, ttlMs) {
  if (value?._error) return;
  _cache.delete(key);
  _cache.set(key, { value, expires: Date.now() + ttlMs });
  if (_cache.size > 150) {
    const oldest = _cache.keys().next().value;
    if (oldest) _cache.delete(oldest);
  }
}

async function withCache(key, ttlMs, producer) {
  const hit = cacheGet(key);
  if (hit) return { ...hit, _cache: "HIT" };
  const fresh = await producer();
  if (!fresh._error) cacheSet(key, fresh, ttlMs);
  return { ...fresh, _cache: "MISS" };
}

// ── Rate limiter ──────────────────────────────────────────
const _rl = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const e = _rl.get(ip) || { count: 0, start: now };
  if (now - e.start > RATE_LIMIT_WINDOW_MS) {
    _rl.set(ip, { count: 1, start: now });
    return false;
  }
  e.count++;
  _rl.set(ip, e);
  if (_rl.size > 1000) {
    for (const [k, v] of _rl)
      if (now - v.start > RATE_LIMIT_WINDOW_MS * 2) _rl.delete(k);
  }
  return e.count > RATE_LIMIT_MAX;
}

// ── HTTP helpers ──────────────────────────────────────────
async function fetchWithTimeout(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } catch (err) {
    return { _exception: err?.name === "AbortError" ? `timeout_${ms}ms` : (err?.message || String(err)), ok: false, status: 0 };
  } finally {
    clearTimeout(tid);
  }
}

async function fetchJson(url, headers) {
  const res = await fetchWithTimeout(url, { headers });
  if (res._exception) return { _error: true, status: 504, reason: res._exception };
  if (!res.ok) {
    let hint = "";
    try { hint = (await res.text()).slice(0, 200); } catch {}
    return { _error: true, status: res.status, reason: res.statusText, hint };
  }
  try { return await res.json(); }
  catch {
    let hint = "";
    try { hint = (await res.clone().text()).slice(0, 200); } catch {}
    return { _error: true, status: 502, reason: "non_json_response", hint };
  }
}

// ── Supabase client simples (sem SDK, evita cold start pesado) ──
function sbHeaders() {
  return {
    "apikey":        process.env.SUPABASE_SERVICE_KEY || "",
    "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_KEY || ""}`,
    "Content-Type":  "application/json",
  };
}

async function sbQuery(path) {
  const base = process.env.SUPABASE_URL;
  if (!base || !process.env.SUPABASE_SERVICE_KEY) return null;
  const res = await fetchWithTimeout(`${base}/rest/v1${path}`, { headers: sbHeaders() }, 5000);
  if (!res.ok) return null;
  try { return await res.json(); } catch { return null; }
}

// ── Patch de jogos: sobrescreve score/status do banco no raw ─
// O raw pode estar desatualizado — o banco tem o valor mais recente
function patchGame(row) {
  const g = { ...(row.raw || {}) };

  // Score: usa banco só se >= 0 (-1 = jogo não iniciado na 365scores)
  const hScore = (row.home_score !== null && row.home_score >= 0) ? row.home_score : null;
  const aScore = (row.away_score !== null && row.away_score >= 0) ? row.away_score : null;
  if (hScore !== null && g.homeCompetitor) g.homeCompetitor = { ...g.homeCompetitor, score: hScore };
  if (aScore !== null && g.awayCompetitor) g.awayCompetitor = { ...g.awayCompetitor, score: aScore };

  // Minuto: ignora valores inválidos
  if (row.minute && row.minute !== 'INTERVALO' && row.minute !== "-1'") {
    const m = parseInt(row.minute);
    if (!isNaN(m) && m >= 0) g.gameTime = m;
  }

  // Status: só corrige se raw estiver desatualizado (scheduled mas banco diz finished)
  if (row.status === 'finished' && Number(g.statusGroup) === 2) g.statusGroup = 4;

  return g;
}

// ── Wrappers 365scores (fallback) ─────────────────────────
const api365 = (path, extra = "") =>
  fetchJson(`${WS}${path}?${PARAMS}&competitions=${COMP_IDS}${extra ? `&${extra}` : ""}`, H365);

const fetchGameDetail = (gameId, matchupId) =>
  fetchJson(`${WS}/game/?${PARAMS}&gameId=${gameId}&matchupId=${matchupId ?? gameId}&topBookmaker=14`, H365);

const fetchGameStats = (gameId) =>
  fetchJson(`${WS}/game/stats/?${PARAMS}&games=${gameId}`, H365);

const fetchStandings365 = (comp) =>
  fetchJson(`${WS}/standings/?${PARAMS}&competitions=${comp}`, H365);

const sfFetch = (path) => fetchJson(`${SF_BASE}${path}`, HSF);

// ── Helpers ───────────────────────────────────────────────
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  process.env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Vary": "Origin",
  };
}

function secHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options":        "DENY",
    "Referrer-Policy":        "no-referrer",
  };
}

function send(res, status, data, extra = {}) {
  const headers = {
    "Content-Type":  "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    ...corsHeaders(),
    ...secHeaders(),
    ...extra,
  };
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.status(status).send(JSON.stringify(data));
}

function log(level, event, data = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), level, event, ...data })
  );
}

function todayBR() {
  return new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
}

function dateBR(offsetDays = 0) {
  const ms = Date.now() - 3 * 3_600_000 + offsetDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

const VALID_ID   = /^\d{1,12}$/;
const VALID_COMP = /^\d{1,6}$/;
const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_FROM = /^\d{2}\/\d{2}\/\d{4}$/;

// ── Producers com banco + fallback ────────────────────────

async function produceLive() {
  try {
    // Tenta banco primeiro
    const rows = await sbQuery(
      "/games?status=eq.live&select=id,home_score,away_score,minute,status,raw&order=start_time.asc"
    );

    if (rows?.length) {
      const games = rows.filter(r => r.raw).map(patchGame);
      log("info", "live_from_db", { count: games.length });
      return { status: 200, body: { games, _source: "db" } };
    }

    // Fallback: 365scores
    log("info", "live_fallback_365");
    const data = await api365("/games/");
    if (data._error) return { _error: true, status: 502, body: { error: "upstream_365", ...data } };
    return { status: 200, body: { games: data.games ?? [], _source: "365" } };
  } catch (e) {
    log("error", "produceLive", { err: e.message });
    return { _error: true, status: 500, body: { error: "internal" } };
  }
}

async function produceResults(from, to) {
  try {
    // Banco: últimos 7 dias se sem filtro, ou filtro de data convertido
    let dbFilter = "/games?status=eq.finished&select=id,home_score,away_score,minute,status,raw&order=start_time.desc&limit=200";

    if (from && to) {
      // Converter DD/MM/YYYY para ISO
      const [df, mf, yf] = from.split("/");
      const [dt, mt, yt] = to.split("/");
      const isoFrom = `${yf}-${mf}-${df}T00:00:00`;
      const isoTo   = `${yt}-${mt}-${dt}T23:59:59`;
      dbFilter += `&start_time=gte.${isoFrom}&start_time=lte.${isoTo}`;
    } else {
      // Sem filtro: últimos 7 dias
      const since = dateBR(-7) + "T00:00:00";
      dbFilter += `&start_time=gte.${since}`;
    }

    const rows = await sbQuery(dbFilter);

    if (rows?.length) {
      const games = rows.filter(r => r.raw).map(patchGame);
      log("info", "results_from_db", { count: games.length });
      return { status: 200, body: { games, _source: "db" } };
    }

    // Fallback: 365scores
    log("info", "results_fallback_365");
    const extra = from && to ? `startDate=${from}&endDate=${to}` : "";
    const data  = await api365("/games/results/", extra);
    if (data._error) return { _error: true, status: 502, body: { error: "upstream_365", ...data } };
    return { status: 200, body: { games: data.games ?? [], _source: "365" } };
  } catch (e) {
    log("error", "produceResults", { err: e.message });
    return { _error: true, status: 500, body: { error: "internal" } };
  }
}

async function produceUpcoming(from, to) {
  try {
    let dbFilter = "/games?status=eq.scheduled&select=id,home_score,away_score,minute,status,raw&order=start_time.asc&limit=200";

    if (from && to) {
      const [df, mf, yf] = from.split("/");
      const [dt, mt, yt] = to.split("/");
      const isoFrom = `${yf}-${mf}-${df}T00:00:00`;
      const isoTo   = `${yt}-${mt}-${dt}T23:59:59`;
      dbFilter += `&start_time=gte.${isoFrom}&start_time=lte.${isoTo}`;
    } else {
      const since = dateBR(0) + "T00:00:00";
      const until = dateBR(7) + "T23:59:59";
      dbFilter += `&start_time=gte.${since}&start_time=lte.${until}`;
    }

    const rows = await sbQuery(dbFilter);

    if (rows?.length) {
      const games = rows.filter(r => r.raw).map(patchGame);
      log("info", "upcoming_from_db", { count: games.length });
      return { status: 200, body: { games, _source: "db" } };
    }

    // Fallback: 365scores
    log("info", "upcoming_fallback_365");
    const extra = from && to ? `startDate=${from}&endDate=${to}` : "";
    const data  = await api365("/games/", extra);
    if (data._error) return { _error: true, status: 502, body: { error: "upstream_365", ...data } };
    return { status: 200, body: { games: data.games ?? [], _source: "365" } };
  } catch (e) {
    log("error", "produceUpcoming", { err: e.message });
    return { _error: true, status: 500, body: { error: "internal" } };
  }
}

async function produceStats(gameId) {
  try {
    const [statsResp, gameResp] = await Promise.all([
      fetchGameStats(gameId),
      fetchGameDetail(gameId, gameId),
    ]);
    const bothFailed = statsResp._error && gameResp._error;
    if (bothFailed) return { _error: true, status: 502, body: { error: "upstream_365" } };
    return {
      status: 200,
      body: {
        ...(statsResp._error ? {} : statsResp),
        homeCompetitor: gameResp._error ? null : (gameResp.game?.homeCompetitor ?? null),
        awayCompetitor: gameResp._error ? null : (gameResp.game?.awayCompetitor ?? null),
      },
    };
  } catch (e) {
    log("error", "produceStats", { gameId, err: e.message });
    return { _error: true, status: 500, body: { error: "internal" } };
  }
}

async function produceStandings(comp) {
  try {
    // Banco: snapshot mais recente para essa competição
    const rows = await sbQuery(
      `/standings_snapshots?competition_id=eq.${comp}&select=raw,snapshot_date&order=snapshot_date.desc&limit=1`
    );

    if (rows?.[0]?.raw) {
      log("info", "standings_from_db", { comp, date: rows[0].snapshot_date });
      return { status: 200, body: { ...rows[0].raw, _source: "db", _date: rows[0].snapshot_date } };
    }

    // Fallback: 365scores
    log("info", "standings_fallback_365", { comp });
    const data = await fetchStandings365(comp);
    if (data._error) return { _error: true, status: 502, body: { error: "upstream_365", ...data } };
    return { status: 200, body: { ...data, _source: "365" } };
  } catch (e) {
    log("error", "produceStandings", { comp, err: e.message });
    return { _error: true, status: 500, body: { error: "internal" } };
  }
}

async function produceSfLive() {
  try {
    const data = await sfFetch("/sport/football/events/live");
    if (data._error) return { _error: true, status: 502, body: { error: "upstream_sf", ...data } };
    return { status: 200, body: data };
  } catch (e) {
    return { _error: true, status: 500, body: { error: "internal" } };
  }
}

async function produceSfScheduled(date) {
  try {
    const data = await sfFetch(`/sport/football/scheduled-events/${date}`);
    if (data._error) return { _error: true, status: 502, body: { error: "upstream_sf", ...data } };
    return { status: 200, body: data };
  } catch (e) {
    return { _error: true, status: 500, body: { error: "internal" } };
  }
}

async function produceSfEvent(sfId, sub) {
  try {
    if (sub) {
      const data = await sfFetch(`/event/${sfId}/${sub}`);
      if (data._error) return { _error: true, status: 502, body: { error: "upstream_sf", ...data } };
      return { status: 200, body: data };
    }
    const [event, stats, momentum, odds, h2h] = await Promise.allSettled([
      sfFetch(`/event/${sfId}`),
      sfFetch(`/event/${sfId}/statistics`),
      sfFetch(`/event/${sfId}/momentum`),
      sfFetch(`/event/${sfId}/featured-odds`),
      sfFetch(`/event/${sfId}/h2h`),
    ]);
    const val = (r) => r.status === "fulfilled" && !r.value?._error ? r.value : null;
    return { status: 200, body: { event: val(event), stats: val(stats), momentum: val(momentum), odds: val(odds), h2h: val(h2h) } };
  } catch (e) {
    return { _error: true, status: 500, body: { error: "internal" } };
  }
}

async function produceDebug(targetUrl) {
  try {
    const url = targetUrl || `${WS}/games/?${PARAMS}&competitions=${COMP_IDS}`;
    const isSf = url.includes("sofascore.com");
    const headers = isSf ? HSF : H365;
    const res = await fetchWithTimeout(url, { headers });
    if (res._exception) return { status: 200, body: { url, fetchFailed: true, error: res._exception } };
    let body = "";
    try { body = await res.text(); } catch (e) { body = `<read_error: ${e.message}>`; }

    // Também mostrar status do banco
    const dbStatus = {
      supabase_url: process.env.SUPABASE_URL ? "✅ configurado" : "❌ não configurado",
      supabase_key:  process.env.SUPABASE_SERVICE_KEY ? "✅ configurado" : "❌ não configurado",
    };

    return {
      status: 200,
      body: {
        url, httpStatus: res.status, bodyLength: body.length,
        bodyIsHtml: body.trim().startsWith("<"),
        bodyIsJson: (() => { try { JSON.parse(body); return true; } catch { return false; } })(),
        bodyHead: body.slice(0, 600),
        db: dbStatus,
      },
    };
  } catch (e) {
    return { status: 200, body: { error: e.message } };
  }
}

// ── Router ────────────────────────────────────────────────
export default async function handler(req, res) {
  const t0 = Date.now();

  if (req.method === "OPTIONS") {
    for (const [k, v] of Object.entries({ ...corsHeaders(), ...secHeaders() })) res.setHeader(k, v);
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });

  const ip = (req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  if (isRateLimited(ip)) return send(res, 429, { error: "rate_limit_exceeded" });

  let urlObj;
  try { urlObj = new URL(req.url, `https://${req.headers.host || "localhost"}`); }
  catch { return send(res, 400, { error: "invalid_url" }); }

  const apiPath  = urlObj.pathname.replace(/^\/api/, "") || "/";
  const segs     = apiPath.split("/").filter(Boolean);
  const route    = "/" + segs.join("/");
  const q        = Object.fromEntries(urlObj.searchParams);
  const cacheKey = urlObj.pathname + urlObj.search;

  log("info", "req", { route, ip });

  try {
    if (route === "/" || route === "/health") {
      return send(res, 200, {
        ok: true, service: "golaco-api", version: "5.0",
        runtime: "node20-esm", ts: new Date().toISOString(),
        db: process.env.SUPABASE_URL ? "connected" : "not_configured",
        endpoints: [
          "GET /api/health", "GET /api/live",
          "GET /api/results?from=DD/MM/YYYY&to=DD/MM/YYYY",
          "GET /api/upcoming?from=DD/MM/YYYY&to=DD/MM/YYYY",
          "GET /api/stats/:gameId",
          "GET /api/standings?comp=113|116|5518|115|102|389",
          "GET /api/sf/live", "GET /api/sf/scheduled?date=YYYY-MM-DD",
          "GET /api/sf/event/:id[/:sub]", "GET /api/_debug?u=<url>",
        ],
      });
    }

    if (route === "/_debug") {
      const r = await produceDebug(q.u ? decodeURIComponent(q.u).slice(0, 500) : "");
      return send(res, r.status, r.body);
    }

    if (route === "/live") {
      const r = await withCache(cacheKey, TTL.live, produceLive);
      return send(res, r.status ?? 200, r.body, { "X-Cache": r._cache });
    }

    if (route === "/results") {
      const from = q.from || "", to = q.to || "";
      if ((from && !VALID_FROM.test(from)) || (to && !VALID_FROM.test(to)))
        return send(res, 400, { error: "invalid_date_format", expected: "DD/MM/YYYY" });
      const ttl = (from && to) ? TTL.resultsHistorical : TTL.results;
      const r = await withCache(cacheKey, ttl, () => produceResults(from, to));
      return send(res, r.status ?? 200, r.body, { "X-Cache": r._cache });
    }

    if (route === "/upcoming") {
      const from = q.from || "", to = q.to || "";
      if ((from && !VALID_FROM.test(from)) || (to && !VALID_FROM.test(to)))
        return send(res, 400, { error: "invalid_date_format", expected: "DD/MM/YYYY" });
      const r = await withCache(cacheKey, TTL.upcoming, () => produceUpcoming(from, to));
      return send(res, r.status ?? 200, r.body, { "X-Cache": r._cache });
    }

    if (segs[0] === "stats" && segs[1]) {
      const gameId = segs[1];
      if (!VALID_ID.test(gameId)) return send(res, 400, { error: "invalid_game_id" });
      const r = await withCache(cacheKey, TTL.stats, () => produceStats(gameId));
      return send(res, r.status ?? 200, r.body, { "X-Cache": r._cache });
    }

    if (route === "/standings") {
      const comp = String(q.comp || "113");
      if (!VALID_COMP.test(comp)) return send(res, 400, { error: "invalid_comp_id" });
      if (!COMPETITIONS[Number(comp)]) return send(res, 400, { error: "unknown_competition" });
      const r = await withCache(cacheKey, TTL.standings, () => produceStandings(comp));
      return send(res, r.status ?? 200, r.body, { "X-Cache": r._cache });
    }

    if (route === "/sf/live") {
      const r = await withCache(cacheKey, TTL.sfLive, produceSfLive);
      return send(res, r.status ?? 200, r.body, { "X-Cache": r._cache });
    }

    if (route === "/sf/scheduled") {
      const date = String(q.date || todayBR());
      if (!VALID_DATE.test(date)) return send(res, 400, { error: "invalid_date", expected: "YYYY-MM-DD" });
      const r = await withCache(cacheKey, TTL.upcoming, () => produceSfScheduled(date));
      return send(res, r.status ?? 200, r.body, { "X-Cache": r._cache });
    }

    if (segs[0] === "sf" && segs[1] === "event" && segs[2]) {
      const sfId = segs[2], sub = segs[3] || "";
      if (!VALID_ID.test(sfId)) return send(res, 400, { error: "invalid_event_id" });
      const VALID_SUBS = ["", "statistics", "momentum", "featured-odds", "h2h", "lineups", "incidents"];
      if (sub && !VALID_SUBS.includes(sub)) return send(res, 400, { error: "invalid_sub_resource" });
      const r = await withCache(cacheKey, TTL.sfEvent, () => produceSfEvent(sfId, sub));
      return send(res, r.status ?? 200, r.body, { "X-Cache": r._cache });
    }

    return send(res, 404, { error: "not_found", route, hint: "Ver /api/health" });

  } catch (err) {
    log("error", "handler_crash", { route, err: err?.message });
    return send(res, 500, { error: "internal_error" });
  } finally {
    log("info", "res", { route, ms: Date.now() - t0 });
  }
}
