// Meta Graph API client + normalisation. Server-side only.
// The access token is always sent in the Authorization header, never in a URL,
// and never logged.

const graphBase = () => process.env.META_GRAPH_BASE_URL || "https://graph.facebook.com";
const apiVersion = () => process.env.META_API_VERSION || "v26.0";

class MetaApiError extends Error {
  constructor(message, { status, code, subcode, type } = {}) {
    super(message);
    this.name = "MetaApiError";
    this.httpStatus = status;
    this.metaCode = code;
    this.metaSubcode = subcode;
    this.metaType = type;
  }
  get isTokenError() { return this.metaCode === 190 || this.metaType === "OAuthException" && [102, 190].includes(this.metaCode); }
  get isRateLimit() { return [4, 17, 32, 613].includes(this.metaCode); }
  get isFieldError() { return this.metaCode === 100; }
}

async function graphRequest(path, params, token) {
  const url = new URL(`${graphBase()}/${apiVersion()}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  let res;
  try {
    res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(30000)
    });
  } catch (e) {
    throw new MetaApiError("Unable to reach Meta (network error or timeout)", { status: 504 });
  }
  let body;
  try { body = await res.json(); } catch { body = {}; }
  if (!res.ok || body.error) {
    const e = body.error || {};
    throw new MetaApiError(e.message || `Meta request failed (${res.status})`, {
      status: res.status, code: e.code, subcode: e.error_subcode, type: e.type
    });
  }
  return body;
}

// Follows cursor pagination using our own base URL (never a URL supplied by Meta).
async function graphGetAll(path, params, token, maxPages = 20) {
  const out = [];
  let after;
  for (let page = 0; page < maxPages; page++) {
    const body = await graphRequest(path, { ...params, ...(after ? { after } : {}) }, token);
    out.push(...(body.data || []));
    after = body.paging?.next ? body.paging?.cursors?.after : undefined;
    if (!after) break;
  }
  return out;
}

const AD_ACCOUNT_ID = /^act_\d+$/;
const isValidAdAccountId = id => typeof id === "string" && AD_ACCOUNT_ID.test(id);

const listAdAccounts = token =>
  graphGetAll("me/adaccounts", {
    fields: "id,account_id,name,account_status,currency,timezone_name",
    limit: 100
  }, token);

const getMe = token => graphRequest("me", { fields: "id,name" }, token);

const listCampaigns = (token, act) =>
  graphGetAll(`${act}/campaigns`, {
    fields: "id,name,status,effective_status,objective,start_time,stop_time",
    limit: 200
  }, token);

// ---------- date range ----------
const PRESETS = ["today", "yesterday", "last_7d", "last_14d", "last_28d", "last_30d", "last_90d", "this_month", "last_month", "this_quarter"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function resolveDateRange(src = {}) {
  const { since, until, datePreset } = src;
  if (since || until) {
    if (!DATE_RE.test(since || "") || !DATE_RE.test(until || "") ||
        isNaN(Date.parse(since)) || isNaN(Date.parse(until))) {
      throw Object.assign(new Error("since and until must both be valid YYYY-MM-DD dates"), { badRequest: true });
    }
    if (since > until) throw Object.assign(new Error("since must not be after until"), { badRequest: true });
    return { params: { time_range: JSON.stringify({ since, until }) }, label: { since, until } };
  }
  const preset = datePreset || process.env.META_DEFAULT_DATE_PRESET || "last_30d";
  if (!PRESETS.includes(preset)) {
    throw Object.assign(new Error(`datePreset must be one of: ${PRESETS.join(", ")}`), { badRequest: true });
  }
  return { params: { date_preset: preset }, label: { datePreset: preset } };
}

const INSIGHT_FIELDS = "campaign_id,campaign_name,impressions,reach,clicks,spend,ctr,cpc,cpm,actions,purchase_roas,date_start,date_stop";

async function listCampaignInsights(token, act, range) {
  const base = { level: "campaign", limit: 200, ...range.params };
  try {
    return await graphGetAll(`${act}/insights`, { ...base, fields: INSIGHT_FIELDS }, token);
  } catch (e) {
    // If purchase_roas is rejected for this account/version, retry without it
    // rather than failing the whole sync (ROAS then stays null, never invented).
    if (e.isFieldError && /purchase_roas/i.test(e.message)) {
      return graphGetAll(`${act}/insights`, { ...base, fields: INSIGHT_FIELDS.replace(",purchase_roas", "") }, token);
    }
    throw e;
  }
}

// ---------- normalisation ----------
const num = v => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Meta reports overlapping action types for one event (e.g. `lead` plus
// `onsite_conversion.lead_grouped`). Take the first present type in priority
// order so nothing is double counted.
const LEAD_TYPES = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"];
const PURCHASE_TYPES = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];

function pickAction(actions, priority) {
  if (!Array.isArray(actions)) return 0;
  for (const type of priority) {
    const a = actions.find(x => x.action_type === type);
    if (a && num(a.value) !== null) return num(a.value);
  }
  return 0;
}

function normalizeCampaign({ campaign, insight, clientId, adAccountId, currency, syncedAt }) {
  const actions = Array.isArray(insight?.actions) ? insight.actions : [];
  const spend = num(insight?.spend) ?? 0;
  const leads = pickAction(actions, LEAD_TYPES);
  const conversions = pickAction(actions, PURCHASE_TYPES);
  const roasEntry = Array.isArray(insight?.purchase_roas) ? insight.purchase_roas[0] : null;

  return {
    client_id: clientId,
    platform: "meta",
    meta_ad_account_id: adAccountId,
    meta_campaign_id: campaign.id,
    campaign_name: campaign.name,
    status: String(campaign.effective_status || campaign.status || "unknown").toLowerCase(),
    objective: campaign.objective || null,
    spend,
    impressions: num(insight?.impressions) ?? 0,
    reach: num(insight?.reach) ?? 0,
    clicks: num(insight?.clicks) ?? 0,
    ctr: num(insight?.ctr),
    cpc: num(insight?.cpc),
    cpm: num(insight?.cpm),
    leads,
    conversions,
    cpl: leads > 0 ? Number((spend / leads).toFixed(2)) : null,
    roas: num(roasEntry?.value),
    actions,
    currency: currency || null,
    date_start: insight?.date_start || null,
    date_stop: insight?.date_stop || null,
    last_synced_at: syncedAt
  };
}

module.exports = {
  MetaApiError, graphRequest, graphGetAll, isValidAdAccountId,
  listAdAccounts, getMe, listCampaigns, listCampaignInsights,
  resolveDateRange, normalizeCampaign, PRESETS
};
