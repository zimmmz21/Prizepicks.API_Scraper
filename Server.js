/**
 * PrizePicks NFL API
 * - Uses ZenRows (preferred) OR ScraperAPI OR residential proxy OR direct
 * - Endpoints: GET / and GET /nfl
 * - Caches results for CACHE_TTL seconds (default 60)
 * - Expects env vars: ZENROWS_API_KEY, SCRAPERAPI_KEY, RESIDENTIAL_PROXY (one or none)
 *
 * Important: Never commit API keys. Set keys in Render environment variables.
 */

import express from "express";
import axios from "axios";
import NodeCache from "node-cache";
import helmet from "helmet";
import compression from "compression";
import { HttpsProxyAgent } from "https-proxy-agent";

const app = express();
app.use(helmet());
app.use(compression());

const PORT = process.env.PORT || 8080;
const ZENROWS_API_KEY = process.env.ZENROWS_API_KEY || "";
const SCRAPERAPI_KEY = process.env.SCRAPERAPI_KEY || "";
const RESIDENTIAL_PROXY = process.env.RESIDENTIAL_PROXY || "";
const CACHE_TTL = Number(process.env.CACHE_TTL || 60); // seconds
const BACKOFF_ATTEMPTS = Number(process.env.BACKOFF_ATTEMPTS || 4);

const TARGET_URL = "https://api.prizepicks.com/projections?league_id=7&per_page=250";

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://app.prizepicks.com",
  "Referer": "https://app.prizepicks.com/"
};

const cache = new NodeCache({ stdTTL: CACHE_TTL, checkperiod: Math.max(5, Math.floor(CACHE_TTL / 2)) });

async function backoff(fn) {
  let attempt = 0;
  while (attempt < BACKOFF_ATTEMPTS) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.response?.status || 0;
      const retryable = status === 429 || status >= 500;
      attempt++;
      if (!retryable || attempt >= BACKOFF_ATTEMPTS) throw err;
      const wait = Math.min(30000, Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500));
      console.log(`[backoff] attempt ${attempt} waiting ${wait}ms (status=${status})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// Provider implementations
async function fetchViaZenRows() {
  if (!ZENROWS_API_KEY) throw new Error("ZENROWS_API_KEY not set");
  const zenUrl =
    `https://api.zenrows.com/v1/?apikey=${encodeURIComponent(ZENROWS_API_KEY)}` +
    `&url=${encodeURIComponent(TARGET_URL)}` +
    `&js_render=true&smart_proxy=true&premium_proxy=true`;
  const resp = await axios.get(zenUrl, { headers: DEFAULT_HEADERS, timeout: 25000 });
  return resp.data;
}

async function fetchViaScraperAPI() {
  if (!SCRAPERAPI_KEY) throw new Error("SCRAPERAPI_KEY not set");
  const url = `http://api.scraperapi.com?api_key=${encodeURIComponent(SCRAPERAPI_KEY)}&url=${encodeURIComponent(TARGET_URL)}&render=true&country=us&keep_headers=true`;
  const resp = await axios.get(url, { headers: DEFAULT_HEADERS, timeout: 25000 });
  return resp.data;
}

async function fetchViaResidentialProxy() {
  if (!RESIDENTIAL_PROXY) throw new Error("RESIDENTIAL_PROXY not set");
  const agent = new HttpsProxyAgent(RESIDENTIAL_PROXY);
  const resp = await axios.get(TARGET_URL, {
    headers: DEFAULT_HEADERS,
    httpsAgent: agent,
    httpAgent: agent,
    timeout: 20000
  });
  return resp.data;
}

async function fetchDirect() {
  const resp = await axios.get(TARGET_URL, { headers: DEFAULT_HEADERS, timeout: 15000 });
  return resp.data;
}

async function fetchNFLRaw() {
  // priority: ZenRows, ScraperAPI, Residential Proxy, Direct
  if (ZENROWS_API_KEY) return fetchViaZenRows();
  if (SCRAPERAPI_KEY) return fetchViaScraperAPI();
  if (RESIDENTIAL_PROXY) return fetchViaResidentialProxy();
  return fetchDirect();
}

function parseProps(json) {
  const included = json?.included || [];
  const data = json?.data || [];

  const players = {};
  const stats = {};
  for (const item of included) {
    if (item.type === "new_player") players[item.id] = item.attributes?.name;
    if (item.type === "stat_type") stats[item.id] = item.attributes?.name;
  }

  const out = [];
  for (const p of data) {
    const attrs = p.attributes || {};
    const rel = p.relationships || {};
    const playerId = rel?.new_player?.data?.id;
    const statId = rel?.stat_type?.data?.id;
    const player = players[playerId];
    const stat = stats[statId];
    if (player && stat) {
      out.push({
        Player: player,
        Stat: stat,
        Line: attrs.line_score ?? null,
        id: p.id
      });
    }
  }
  return out;
}

async function getNFLProps() {
  const cached = cache.get("nfl_props");
  if (cached) return cached;
  const raw = await backoff(() => fetchNFLRaw());
  const props = parseProps(raw);
  cache.set("nfl_props", props);
  return props;
}

// Routes
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    endpoint: "/nfl",
    cache_ttl_sec: CACHE_TTL,
    priority: ZENROWS_API_KEY ? "zenrows" : SCRAPERAPI_KEY ? "scraperapi" : RESIDENTIAL_PROXY ? "residential_proxy" : "direct"
  });
});

app.get("/nfl", async (req, res) => {
  try {
    const props = await getNFLProps();
    res.json(props);
  } catch (err) {
    const status = err?.response?.status || 500;
    console.error("[/nfl] error:", status, err.message || err);
    if (status === 429) return res.status(429).json({ error: "Too Many Requests - provider or target rate limited" });
    res.status(500).json({ error: err.message || "unknown error" });
  }
});

app.listen(PORT, () => console.log(`listening on ${PORT}`));
