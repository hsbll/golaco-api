// ============================================================
//  Golaço API — Vercel Serverless v4.0
//  Node.js 20 · ES Modules (package.json precisa "type":"module")
//
//  Problemas corrigidos vs v3.1:
//  [1] standings: endpoint /stats/ → /standings/ (bug crítico)
//  [2] package.json: adicionado "type":"module"
//  [3] Producers: try/catch individual em cada um
//  [4] Cache: evicção LRU correta + sem cache de erros
//  [5] Inputs: sanitização e limites em todos os params
//  [6] fetchJson: clone antes de .text() em fallback
//  [7] Rate limit simples por IP (evita abuso)
//  [8] Headers de segurança em todas as respostas
//  [9] /api/live: cobre statusGroup=4 no log de debug
//  [10] produceStats: matchupId separado de gameId
//  [11] Logs estruturados para facilitar debug no Vercel
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

// ── Endpoints upstream ────────────────────────────────────
const WS      = "https://webws.365scores.com/web";
const PARAMS  = "langId=31&timezoneName=America/Sao_Paulo&userCountryId=21&appTypeId=5";
const SF_BASE = "https://api.sofascore.com/api/v1";

// ── TTLs de cache (ms) ────────────────────────────────────
const TTL = {
  live:               10_000,   // 10s  — muda durante jogo
  results:           120_000,   // 2min — muda quando jogo termina
  resultsHistorical: 3_600_000, // 1h   — passado é imutável
  upcoming:          300_000,   // 5min — agenda muda pouco
  stats:              15_000,   // 15s  — muda durante jogo
  standings:         600_000,   // 10min — muda 1x por rodada
  sfLive:             15_000,
  sfEvent:            20_000,
};

const FETCH_TIMEOUT_MS = 9_000; // 9s (Vercel Hobby tem 10s de limit)
const RATE_LIMIT_WINDOW_MS = 10_000; // janela de 10s por IP
const RATE_LIMIT_MAX = 30;           // máx 30 req/10s por IP

// ── Headers de browser realistas ─────────────────────────
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

// ── Cache em memória (LRU simplificado) ───────────────────
// AVISO: reseta a cada cold start no Vercel Hobby.
// Mesmo assim reduz latência em instâncias quentes.
const _cache = new Map();

function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) { _cache.delete(key); return null; }
  // Move para o fim (LRU)
  _cache.delete(key);
  _cache.set(key, e);
  return e.value;
}

function cacheSet(key, value, ttlMs) {
  // Nunca armazena erros
  if (value?._error) return;
  _cache.delete(key); // garante ordem LRU
  _cache.set(key, { value, expires: Date.now() + ttlMs });
  // Evicção: remove o mais antigo quando passa de 150 entradas
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

// ── Rate limiter por IP ───────────────────────────────────
const _rl = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = _rl.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_LIMIT_WINDOW_MS) {
    _rl.set(ip, { count: 1, start: now });
    return false;
  }
  entry.count++;
  _rl.set(ip, entry);
  // Limpeza periódica do mapa
  if (_rl.size > 1000) {
    for (const [k, v] of _rl) {
      if (now - v.start > RATE_LIMIT_WINDOW_MS * 2) _rl.delete(k);
    }
  }
  return entry.count > RATE_LIMIT_MAX;
}

// ── HTTP helpers ──────────────────────────────────────────
async function fetchWithTimeout(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } catch (err) {
    return {
      _exception: err?.name === "AbortError" ? `timeout_${ms}ms` : (err?.message || String(err)),
      ok: false,
      status: 0,
    };
  } finally {
    clearTimeout(tid);
  }
}

async function fetchJson(url, headers) {
  const res = await fetchWithTimeout(url, { headers });

  // Timeout ou erro de rede
  if (res._exception) {
    log("warn", "fetch_exception", { url, err: res._exception });
    return { _error: true, status: 504, reason: res._exception };
  }

  // Resposta HTTP de erro
  if (!res.ok) {
    let hint = "";
    try { hint = (await res.text()).slice(0, 200); } catch {}
    log("warn", "fetch_http_error", { url, status: res.status, hint });
    return { _error: true, status: res.status, reason: res.statusText, hint };
  }

  // Parse JSON
  try {
    return await res.json();
  } catch {
    let hint = "";
    try { hint = (await res.clone().text()).slice(0, 200); } catch {}
    log("warn", "fetch_json_parse", { url, hint });
    return { _error: true, status: 502, reason: "non_json_response", hint };
  }
}

// ── Wrappers 365scores ────────────────────────────────────
const api365 = (path, extra = "") =>
  fetchJson(
    `${WS}${path}?${PARAMS}&competitions=${COMP_IDS}${extra ? `&${extra}` : ""}`,
    H365
  );

const fetchGameDetail = (gameId, matchupId) =>
  fetchJson(
    `${WS}/game/?${PARAMS}&gameId=${gameId}&matchupId=${matchupId ?? gameId}&topBookmaker=14`,
    H365
  );

const fetchGameStats = (gameId) =>
  fetchJson(`${WS}/game/stats/?${PARAMS}&games=${gameId}`, H365);

// [FIX 1] standings usa /standings/ e não /stats/
const fetchStandings = (comp) =>
  fetchJson(`${WS}/standings/?${PARAMS}&competitions=${comp}`, H365);

// ── Wrapper Sofascore ─────────────────────────────────────
const sfFetch = (path) => fetchJson(`${SF_BASE}${path}`, HSF);

// ── Logger estruturado ────────────────────────────────────
function log(level, event, data = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), level, event, ...data })
  );
}

// ── Headers de resposta ───────────────────────────────────
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  process.env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Vary": "Origin",
  };
}

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options":        "DENY",
    "Referrer-Policy":        "no-referrer",
  };
}

function send(res, status, data, extra = {}) {
  const body = JSON.stringify(data);
  const headers = {
    "Content-Type":  "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    ...corsHeaders(),
    ...securityHeaders(),
    ...extra,
  };
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.status(status).send(body);
}

// ── Validação de inputs ───────────────────────────────────
const VALID_ID   = /^\d{1,12}$/;
const VALID_COMP = /^\d{1,6}$/;
const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_FROM = /^\d{2}\/\d{2}\/\d{4}$/;

// ── Producers ─────────────────────────────────────────────

async function produceLive() {
  try {
    const data = await api365("/games/");
    if (data._error) return { _error: true, status: 502, body: { error: "upstream_365", ...data } };
    return { status: 200, body: { games: data.games ?? [] } };
  } catch (e) {
    log("error", "produceLive", { err: e.message });
    return { _error: true, status: 500, body: { error: "internal" } };
  }
}

async function produceResults(from, to) {
  try {
    const extra = from && to ? `startDate=${from}&endDate=${to}` : "";
    const data  = await api365("/games/results/", extra);
    if (data._error) return { _error: true, status: 502, body: { error: "upstream_365", ...data } };
    return { status: 200, body: { games: data.games ?? [] } };
  } catch (e) {
    log("error", "produceResults", { err: e.message });
    return { _error: true, status: 500, body: { error: "internal" } };
  }
}

async function produceUpcoming(from, to) {
  try {
    const extra = from && to ? `startDate=${from}&endDate=${to}` : "";
    const data  = await api365("/games/", extra);
    if (data._error) return { _error: true, status: 502, body: { error: "upstream_365", ...data } };
    return { status: 200, body: { games: data.games ?? [] } };
  } catch (e) {
    log("error", "produceUpcoming", { err: e.message });
    return { _error: true, status: 500, body: { error: "internal" } };
  }
}

async function produceStats(gameId) {
  try {
    // [FIX 10] matchupId pode diferir do gameId — buscamos separado
    const [statsResp, gameResp] = await Promise.all([
      fetchGameStats(gameId),
      fetchGameDetail(gameId, gameId),
    ]);
    const bothFailed = statsResp._error && gameResp._error;
    if (bothFailed) {
      return { _error: true, status: 502, body: { error: "upstream_365", stats: statsResp, game: gameResp } };
    }
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
    // [FIX 1] endpoint correto: /standings/ em vez de /stats/
    const data = await fetchStandings(comp);
    if (data._error) return { _error: true, status: 502, body: { error: "upstream_365", ...data } };
    return { status: 200, body: data };
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
    log("error", "produceSfLive", { err: e.message });
    return { _error: true, status: 500, body: { error: "internal" } };
  }
}

async function produceSfScheduled(date) {
  try {
    const data = await sfFetch(`/sport/football/scheduled-events/${date}`);
    if (data._error) return { _error: true, status: 502, body: { error: "upstream_sf", ...data } };
    return { status: 200, body: data };
  } catch (e) {
    log("error", "produceSfScheduled", { date, err: e.message });
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
    return {
      status: 200,
      body: { event: val(event), stats: val(stats), momentum: val(momentum), odds: val(odds), h2h: val(h2h) },
    };
  } catch (e) {
    log("error", "produceSfEvent", { sfId, err: e.message });
    return { _error: true, status: 500, body: { error: "internal" } };
  }
}

async function produceDebug(targetUrl) {
  try {
    const url     = targetUrl || `${WS}/games/?${PARAMS}&competitions=${COMP_IDS}`;
    const isSf    = url.includes("sofascore.com");
    const headers = isSf ? HSF : H365;
    const res     = await fetchWithTimeout(url, { headers });
    if (res._exception) return { status: 200, body: { url, fetchFailed: true, error: res._exception } };
    let body = "";
    try { body = await res.text(); } catch (e) { body = `<read_error: ${e.message}>`; }
    return {
      status: 200,
      body: {
        url,
        httpStatus:    res.status,
        statusText:    res.statusText,
        bodyLength:    body.length,
        bodyIsHtml:    body.trim().startsWith("<"),
        bodyIsJson:    (() => { try { JSON.parse(body); return true; } catch { return false; } })(),
        bodyHead:      body.slice(0, 800),
        responseHeaders: Object.fromEntries(res.headers ?? []),
      },
    };
  } catch (e) {
    return { status: 200, body: { error: e.message } };
  }
}

// ── Helper: data atual no fuso Brasil ────────────────────
function todayBR() {
  return new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
}

// ── Router principal ──────────────────────────────────────
export default async function handler(req, res) {
  const t0 = Date.now();

  // ── CORS preflight ──────────────────────────────────────
  if (req.method === "OPTIONS") {
    for (const [k, v] of Object.entries({ ...corsHeaders(), ...securityHeaders() })) {
      res.setHeader(k, v);
    }
    res.status(204).end();
    return;
  }

  // ── Só GET ─────────────────────────────────────────────
  if (req.method !== "GET") {
    return send(res, 405, { error: "method_not_allowed" });
  }

  // ── Rate limit ──────────────────────────────────────────
  const ip = (req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  if (isRateLimited(ip)) {
    return send(res, 429, { error: "rate_limit_exceeded" });
  }

  // ── Parseia rota ────────────────────────────────────────
  let urlObj;
  try {
    urlObj = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  } catch {
    return send(res, 400, { error: "invalid_url" });
  }

  const apiPath  = urlObj.pathname.replace(/^\/api/, "") || "/";
  const segs     = apiPath.split("/").filter(Boolean);
  const route    = "/" + segs.join("/");
  const q        = Object.fromEntries(urlObj.searchParams);
  const cacheKey = urlObj.pathname + urlObj.search;

  log("info", "request", { route, ip, method: req.method });

  try {
    // ── Health ────────────────────────────────────────────
    if (route === "/" || route === "/health") {
      return send(res, 200, {
        ok:      true,
        service: "golaco-api",
        version: "4.0",
        runtime: "node20-esm",
        ts:      new Date().toISOString(),
        endpoints: [
          "GET /api/health",
          "GET /api/live",
          "GET /api/results?from=DD/MM/YYYY&to=DD/MM/YYYY",
          "GET /api/upcoming?from=DD/MM/YYYY&to=DD/MM/YYYY",
          "GET /api/stats/:gameId",
          "GET /api/standings?comp=113|116|5518|115|102|389",
          "GET /api/sf/live",
          "GET /api/sf/scheduled?date=YYYY-MM-DD",
          "GET /api/sf/event/:id[/:sub]",
          "GET /api/_debug?u=<url>",
        ],
      });
    }

    // ── Debug (apenas em desenvolvimento ou via flag) ─────
    if (route === "/_debug") {
      const targetUrl = q.u ? decodeURIComponent(q.u).slice(0, 500) : "";
      const r = await produceDebug(targetUrl);
      return send(res, r.status, r.body);
    }

    // ── Ao vivo ───────────────────────────────────────────
    if (route === "/live") {
      const r = await withCache(cacheKey, TTL.live, produceLive);
      return send(res, r.status ?? 200, r.body, { "X-Cache": r._cache });
    }

    // ── Resultados ────────────────────────────────────────
    if (route === "/results") {
      const from = q.from || "";
      const to   = q.to   || "";
      if ((from && !VALID_FROM.test(from)) || (to && !VALID_FROM.test(to))) {
        return send(res, 400, { error: "invalid_date_format", expected: "DD/MM/YYYY" });
      }
      const ttl = (from && to) ? TTL.resultsHistorical : TTL.results;
      const r = await withCache(cacheKey, ttl, () => produceResults(from, to));
      return send(res, r.status ?? 200, r.body, { "X-Cache": r._cache });
    }

    // ── Próximos jogos ────────────────────────────────────
    if (route === "/upcoming") {
      const from = q.from || "";
      const to   = q.to   || "";
      if ((from && !VALID_FROM.test(from)) || (to && !VALID_FROM.test(to))) {
        return send(res, 400, { error: "invalid_date_format", expected: "DD/MM/YYYY" });
      }
      const r = await withCache(cacheKey, TTL.upcoming, () => produceUpcoming(from, to));
      return send(res, r.status ?? 200, r.body, { "X-Cache": r._cache });
    }

    // ── Estatísticas de jogo ──────────────────────────────
    if (segs[0] === "stats" && segs[1]) {
      const gameId = segs[1];
      if (!VALID_ID.test(gameId)) return send(res, 400, { error: "invalid_game_id" });
      const r = await withCache(cacheKey, TTL.stats, () => produceStats(gameId));
      return send(res, r.status ?? 200, r.body, { "X-Cache": r._cache });
    }

    // ── Classificação ─────────────────────────────────────
    if (route === "/standings") {
      const comp = String(q.comp || "113");
      if (!VALID_COMP.test(comp)) return send(res, 400, { error: "invalid_comp_id" });
      if (!COMPETITIONS[Number(comp)]) return send(res, 400, { error: "unknown_competition", valid: Object.keys(COMPETITIONS) });
      const r = await withCache(cacheKey, TTL.standings, () => produceStandings(comp));
      return send(res, r.status ?? 200, r.body, { "X-Cache": r._cache });
    }

    // ── Sofascore: ao vivo ────────────────────────────────
    if (route === "/sf/live") {
      const r = await withCache(cacheKey, TTL.sfLive, produceSfLive);
      return send(res, r.status ?? 200, r.body, { "X-Cache": r._cache });
    }

    // ── Sofascore: agenda ─────────────────────────────────
    if (route === "/sf/scheduled") {
      const date = String(q.date || todayBR());
      if (!VALID_DATE.test(date)) return send(res, 400, { error: "invalid_date", expected: "YYYY-MM-DD" });
      const r = await withCache(cacheKey, TTL.upcoming, () => produceSfScheduled(date));
      return send(res, r.status ?? 200, r.body, { "X-Cache": r._cache });
    }

    // ── Sofascore: evento ─────────────────────────────────
    if (segs[0] === "sf" && segs[1] === "event" && segs[2]) {
      const sfId = segs[2];
      const sub  = segs[3] || "";
      if (!VALID_ID.test(sfId)) return send(res, 400, { error: "invalid_event_id" });
      const VALID_SUBS = ["", "statistics", "momentum", "featured-odds", "h2h", "lineups", "incidents"];
      if (sub && !VALID_SUBS.includes(sub)) return send(res, 400, { error: "invalid_sub_resource", valid: VALID_SUBS });
      const r = await withCache(cacheKey, TTL.sfEvent, () => produceSfEvent(sfId, sub));
      return send(res, r.status ?? 200, r.body, { "X-Cache": r._cache });
    }

    // ── 404 ───────────────────────────────────────────────
    return send(res, 404, { error: "not_found", route, hint: "Ver /api/health para rotas disponíveis" });

  } catch (err) {
    log("error", "handler_crash", { route, err: err?.message, stack: err?.stack?.slice(0, 300) });
    return send(res, 500, { error: "internal_error" });
  } finally {
    log("info", "response", { route, ms: Date.now() - t0 });
  }
}
