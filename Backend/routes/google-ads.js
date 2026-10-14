const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { encryptToken, decryptToken } = require("../services/crypto");

const router = express.Router();
const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v25";

const fail = (res, status, message, code) =>
  res.status(status).json({ success: false, message, ...(code ? { code } : {}) });

function config() {
  return {
    clientId: process.env.GOOGLE_ADS_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET || "",
    redirectUri: process.env.GOOGLE_ADS_REDIRECT_URI || "",
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "",
    managerCustomerId: String(process.env.GOOGLE_ADS_MANAGER_CUSTOMER_ID || "").replace(/\D/g, "")
  };
}

function normalizeCustomerId(value) {
  return String(value || "").replace(/\D/g, "");
}

async function refreshAccessToken(refreshToken) {
  const c = config();
  if (!c.clientId || !c.clientSecret) throw new Error("Google Ads OAuth client credentials are not configured");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    }),
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    const err = new Error(body.error_description || body.error || "Google OAuth token refresh failed");
    err.oauth = true;
    throw err;
  }
  return body.access_token;
}

async function getConnection(supabase) {
  const { data, error } = await supabase.from("google_ads_connections")
    .select("*").eq("id", 1).maybeSingle();
  if (error) throw error;
  if (!data?.refresh_token) return null;
  return { ...data, refreshToken: decryptToken(data.refresh_token) };
}

async function googleAdsRequest(accessToken, customerId, method, body) {
  const c = config();
  if (!c.developerToken) throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN is not configured");
  const headers = {
    Authorization: "Bearer " + accessToken,
    "developer-token": c.developerToken,
    "Content-Type": "application/json"
  };
  if (c.managerCustomerId) headers["login-customer-id"] = c.managerCustomerId;
  // Google Ads Search REST endpoint is /customers/{customerId}/googleAds:search.
  const apiMethod = String(method || "").endsWith(":search") ? "googleAds:search" : String(method || "");
  const response = await fetch(
    `https://googleads.googleapis.com/${API_VERSION}/customers/${normalizeCustomerId(customerId)}/${apiMethod}`,
    { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }
  );
  const responseText = await response.text();
  let result;
  try {
    result = responseText ? JSON.parse(responseText) : {};
  } catch {
    const err = new Error(`Google Ads endpoint returned non-JSON content (HTTP ${response.status}). Check API URL/version and Hostinger proxy response.`);
    err.httpStatus = response.status;
    err.googleAds = true;
    throw err;
  }
  if (!response.ok) {
    const detail = result?.error?.details?.[0]?.errors?.[0]?.message || result?.error?.message || "Google Ads API request failed";
    const err = new Error(detail);
    err.httpStatus = response.status;
    err.googleAds = true;
    throw err;
  }
  return result;
}

module.exports = (supabase, authenticateToken) => {
  // OAuth callback must be reachable by Google and therefore is intentionally public.
  router.get("/oauth/callback", async (req, res) => {
    const c = config();
    try {
      if (!c.clientId || !c.clientSecret || !c.redirectUri) {
        return res.status(503).send("Google Ads OAuth is not fully configured. Set GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, and GOOGLE_ADS_REDIRECT_URI in Hostinger.");
      }
      if (req.query.error) return res.status(400).send("Google Ads authorization was cancelled or denied. Return to AQ Setu and try again.");
      if (!req.query.code || !req.query.state) return res.status(400).send("Missing Google Ads OAuth code or state.");
      const state = jwt.verify(String(req.query.state), process.env.JWT_SECRET, { audience: "aqsetu-google-ads-oauth" });
      if (state.role !== "admin" || !state.nonce) return res.status(403).send("Administrator authorization required.");
      const { data: pending, error: pendingError } = await supabase.from("google_ads_oauth_states")
        .select("nonce,created_at").eq("nonce", state.nonce).maybeSingle();
      if (pendingError) throw pendingError;
      if (!pending || Date.now() - new Date(pending.created_at).getTime() > 10 * 60 * 1000) {
        return res.status(400).send("This Google Ads authorization link has expired. Return to AQ Setu and reconnect.");
      }
      await supabase.from("google_ads_oauth_states").delete().eq("nonce", state.nonce);
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: String(req.query.code),
          client_id: c.clientId,
          client_secret: c.clientSecret,
          redirect_uri: c.redirectUri,
          grant_type: "authorization_code"
        }),
        signal: AbortSignal.timeout(15000)
      });
      const tokens = await tokenResponse.json();
      if (!tokenResponse.ok || !tokens.access_token) {
        console.error("Google Ads OAuth exchange failed:", tokens.error || tokenResponse.status);
        return res.status(502).send("Google could not complete authorization. Check the OAuth client and redirect URI in Hostinger and Google Cloud.");
      }
      if (!tokens.refresh_token) {
        return res.status(400).send("Google did not return a refresh token. Revoke AQ Setu's existing Google Ads authorization in your Google Account, then reconnect and grant access again.");
      }
      const row = {
        id: 1,
        refresh_token: encryptToken(tokens.refresh_token),
        manager_customer_id: c.managerCustomerId || null,
        connected_by: state.userId,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "active",
        last_error: null
      };
      const { error } = await supabase.from("google_ads_connections").upsert(row, { onConflict: "id" });
      if (error) throw error;
      res.status(200).send("<!doctype html><html><head><meta charset=\"utf-8\"><title>AQ Setu Google Ads</title></head><body style=\"font-family:Arial;text-align:center;padding:60px\"><h2>Google Ads connected</h2><p>Authorization was saved securely. Return to the AQ Setu Client Portal and refresh Integrations.</p><script>if(window.opener){window.opener.postMessage({type:'aqsetu-google-ads-connected'},location.origin)}</script></body></html>");
    } catch (e) {
      console.error("Google Ads OAuth callback:", e.message);
      res.status(500).send("Unable to finish Google Ads authorization. Check the backend logs and database migration.");
    }
  });

  router.use(authenticateToken);

  router.get("/status", async (req, res) => {
    if (req.user.role !== "admin") return fail(res, 403, "Admin role required");
    try {
      const c = config();
      const conn = await getConnection(supabase);
      res.json({
        success: true,
        configured: Boolean(c.clientId && c.clientSecret && c.redirectUri && c.developerToken),
        oauthConfigured: Boolean(c.clientId && c.clientSecret && c.redirectUri),
        developerTokenConfigured: Boolean(c.developerToken),
        managerCustomerId: c.managerCustomerId || conn?.manager_customer_id || null,
        connected: Boolean(conn),
        connectedAt: conn?.connected_at || null,
        apiVersion: API_VERSION
      });
    } catch (e) {
      console.error("Google Ads status:", e.message);
      fail(res, 500, "Unable to load Google Ads connection status. Confirm migration 007 has been run.");
    }
  });

  router.post("/connect", async (req, res) => {
    if (req.user.role !== "admin") return fail(res, 403, "Admin role required");
    const c = config();
    if (!c.clientId || !c.clientSecret || !c.redirectUri) return fail(res, 503, "Configure GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, and GOOGLE_ADS_REDIRECT_URI in Hostinger first.");
    if (!process.env.JWT_SECRET) return fail(res, 503, "JWT_SECRET is not configured");
    try {
      const nonce = crypto.randomBytes(24).toString("hex");
      const { error } = await supabase.from("google_ads_oauth_states").insert({ nonce, created_at: new Date().toISOString() });
      if (error) throw error;
      const state = jwt.sign({ nonce, userId: req.user.userId, role: req.user.role, aud: "aqsetu-google-ads-oauth" }, process.env.JWT_SECRET, { expiresIn: "10m" });
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: c.clientId,
        redirect_uri: c.redirectUri,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/adwords",
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state
      }).toString();
      res.json({ success: true, authorizationUrl: url.toString() });
    } catch (e) {
      console.error("Google Ads connect start:", e.message);
      fail(res, 500, "Unable to start Google Ads authorization. Confirm migration 007 has been run.");
    }
  });

  router.get("/accounts", async (req, res) => {
    if (req.user.role !== "admin") return fail(res, 403, "Admin role required");
    try {
      const conn = await getConnection(supabase);
      if (!conn) return fail(res, 409, "Connect Google Ads first", "GOOGLE_ADS_NOT_CONNECTED");
      const managerId = config().managerCustomerId || conn.manager_customer_id;
      if (!managerId) return fail(res, 400, "Set GOOGLE_ADS_MANAGER_CUSTOMER_ID in Hostinger without hyphens");
      const accessToken = await refreshAccessToken(conn.refreshToken);
      const result = await googleAdsRequest(accessToken, managerId, "googleAds:search", {
        query: "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.status = 'ENABLED' ORDER BY customer_client.descriptive_name"
      });
      const accounts = (result.results || []).map(r => ({
        customerId: String(r.customerClient.id),
        name: r.customerClient.descriptiveName || String(r.customerClient.id),
        currency: r.customerClient.currencyCode || null,
        isManager: Boolean(r.customerClient.manager),
        status: r.customerClient.status
      }));
      res.json({ success: true, accounts });
    } catch (e) {
      console.error("Google Ads account listing:", e.message);
      if (e.googleAds) return fail(res, e.httpStatus === 401 ? 401 : 502, "Google Ads API rejected the account request: " + e.message, "GOOGLE_ADS_API_ERROR");
      if (e.oauth) return fail(res, 409, "Google Ads authorization has expired or was revoked. Reconnect Google Ads.", "GOOGLE_ADS_REAUTH_REQUIRED");
      fail(res, 500, "Unable to list Google Ads accounts. Confirm the manager customer ID and API credentials.");
    }
  });

  router.get("/client-accounts", async (req, res) => {
    if (req.user.role !== "admin") return fail(res, 403, "Admin role required");
    try {
      const [{ data: clients, error: ce }, { data: mappings, error: me }] = await Promise.all([
        supabase.from("clients").select("id,display_name,client_code").order("display_name"),
        supabase.from("google_ads_client_accounts").select("*")
      ]);
      if (ce) throw ce;
      if (me) throw me;
      res.json({ success: true, clients: (clients || []).map(c => ({
        ...c, accounts: (mappings || []).filter(m => m.client_id === c.id).map(m => ({
          customerId: m.customer_id, name: m.customer_name, currency: m.currency_code
        }))
      })) });
    } catch (e) {
      console.error("Google Ads client account mappings:", e.message);
      fail(res, 500, "Unable to load account assignments. Confirm migration 007 has been run.");
    }
  });

  router.put("/client-accounts/:clientId", async (req, res) => {
    if (req.user.role !== "admin") return fail(res, 403, "Admin role required");
    const clientId = String(req.params.clientId || "");
    const ids = Array.isArray(req.body?.customerIds) ? [...new Set(req.body.customerIds.map(normalizeCustomerId))] : null;
    if (!clientId || !ids || ids.some(id => !/^\d{10}$/.test(id))) {
      return fail(res, 400, "clientId and an array of 10-digit customerIds are required");
    }

    try {
      const { data: client, error: ce } = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
      if (ce) throw ce;
      if (!client) return fail(res, 404, "Client not found");

      // Validate requested accounts before deleting existing assignments, so a bad request
      // can never wipe the client's current mapping.
      let found = new Map();
      if (ids.length) {
        const { data: available, error: ae } = await supabase.from("google_ads_available_accounts")
          .select("customer_id,customer_name,currency_code").in("customer_id", ids);
        if (ae) throw ae;
        found = new Map((available || []).map(a => [normalizeCustomerId(a.customer_id), a]));
        if (ids.some(id => !found.has(id))) {
          return fail(res, 400, "One or more accounts are not in the synced account list. Click Sync accounts and try again.");
        }

        const { data: existing, error: ee } = await supabase.from("google_ads_client_accounts")
          .select("customer_id,client_id").neq("client_id", clientId).in("customer_id", ids);
        if (ee) throw ee;
        if ((existing || []).length) {
          return fail(res, 409, "One or more selected Google Ads accounts are already assigned to another client. Remove that assignment first.");
        }
      }

      const { error: de } = await supabase.from("google_ads_client_accounts").delete().eq("client_id", clientId);
      if (de) throw de;

      if (ids.length) {
        const rows = ids.map(id => {
          const account = found.get(id);
          return {
            client_id: clientId,
            customer_id: id,
            customer_name: account.customer_name,
            currency_code: account.currency_code,
            updated_at: new Date().toISOString()
          };
        });
        const { error: ie } = await supabase.from("google_ads_client_accounts").insert(rows);
        if (ie) {
          if (ie.code === "23505") {
            return fail(res, 409, "A selected Google Ads account is already assigned elsewhere. Refresh assignments and try again.");
          }
          throw ie;
        }
      }

      return res.json({ success: true, assigned: ids.length });
    } catch (e) {
      console.error("Google Ads assign client account:", { message: e.message, code: e.code, details: e.details, hint: e.hint });
      return fail(res, 500, "Unable to save Google Ads assignments" + (e.code ? " (database error " + e.code + ")" : "") + ". Check the server logs if this continues.", "GOOGLE_ADS_ASSIGNMENT_SAVE_FAILED");
    }
  });

  router.post("/sync-accounts", async (req, res) => {
    if (req.user.role !== "admin") return fail(res, 403, "Admin role required");
    try {
      const conn = await getConnection(supabase);
      if (!conn) return fail(res, 409, "Connect Google Ads first", "GOOGLE_ADS_NOT_CONNECTED");
      const managerId = config().managerCustomerId || conn.manager_customer_id;
      if (!managerId) return fail(res, 400, "Set GOOGLE_ADS_MANAGER_CUSTOMER_ID in Hostinger without hyphens");
      const accessToken = await refreshAccessToken(conn.refreshToken);
      const result = await googleAdsRequest(accessToken, managerId, "googleAds:search", {
        query: "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.status = 'ENABLED' ORDER BY customer_client.descriptive_name"
      });
      const accounts = (result.results || []).map(r => ({
        customer_id: normalizeCustomerId(r.customerClient.id),
        customer_name: r.customerClient.descriptiveName || String(r.customerClient.id),
        currency_code: r.customerClient.currencyCode || null,
        is_manager: Boolean(r.customerClient.manager),
        status: r.customerClient.status,
        updated_at: new Date().toISOString()
      }));
      if (accounts.length) {
        const { error } = await supabase.from("google_ads_available_accounts")
          .upsert(accounts, { onConflict: "customer_id" });
        if (error) throw error;
      }
      res.json({ success: true, synced: accounts.length, accounts });
    } catch (e) {
      console.error("Google Ads account sync:", {
        message: e.message,
        code: e.code,
        details: e.details,
        hint: e.hint,
        httpStatus: e.httpStatus
      });
      if (e.googleAds) return fail(res, 502, "Google Ads API rejected account sync: " + e.message, "GOOGLE_ADS_API_ERROR");
      if (e.oauth) return fail(res, 409, "Google Ads authorization needs reconnecting: " + e.message, "GOOGLE_ADS_REAUTH_REQUIRED");
      const dbCode = e.code ? " (database code " + e.code + ")" : "";
      const detail = e.message && !/fetch failed|timeout|aborted/i.test(e.message)
        ? ": " + String(e.message).slice(0, 240)
        : "";
      return fail(res, 500, "Google Ads account sync failed" + dbCode + detail + ". Check Hostinger backend logs for the full error.", "GOOGLE_ADS_SYNC_FAILED");
    }
  });

  router.get("/campaigns", async (req, res) => {
    try {
      const clientId = req.user.role === "admin" ? String(req.query.clientId || "") : String(req.user.clientId || "");
      if (!clientId) return fail(res, 400, "clientId is required");
      if (req.user.role !== "admin" && clientId !== String(req.user.clientId)) return fail(res, 403, "You cannot access another client's Google Ads data");
      const startDate = String(req.query.startDate || "");
      const endDate = String(req.query.endDate || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
        return fail(res, 400, "Valid startDate and endDate (YYYY-MM-DD) are required");
      }
      const { data: mappings, error } = await supabase.from("google_ads_client_accounts").select("customer_id,customer_name,currency_code").eq("client_id", clientId);
      if (error) throw error;
      if (!mappings?.length) return res.json({ success: true, connected: false, campaigns: [], message: "No Google Ads account is assigned to this client." });
      const conn = await getConnection(supabase);
      if (!conn) return fail(res, 409, "Google Ads is not connected by the agency administrator", "GOOGLE_ADS_NOT_CONNECTED");
      const accessToken = await refreshAccessToken(conn.refreshToken);
      const all = [];
      for (const account of mappings) {
        const result = await googleAdsRequest(accessToken, account.customer_id, "googleAds:search", {
          query: `SELECT customer.id, customer.descriptive_name, customer.currency_code, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.ctr, metrics.average_cpc FROM campaign WHERE segments.date BETWEEN '${startDate}' AND '${endDate}' ORDER BY segments.date DESC`
        });
        for (const row of result.results || []) {
          const m = row.metrics || {};
          const impressions = Number(m.impressions || 0);
          const clicks = Number(m.clicks || 0);
          const spend = Number(m.costMicros || 0) / 1000000;
          all.push({
            customerId: String(row.customer?.id || account.customer_id),
            customerName: row.customer?.descriptiveName || account.customer_name,
            currency: row.customer?.currencyCode || account.currency_code,
            campaignId: String(row.campaign.id),
            campaignName: row.campaign.name,
            campaignStatus: row.campaign.status,
            channel: row.campaign.advertisingChannelType,
            date: row.segments.date,
            impressions,
            clicks,
            spend: Number(spend.toFixed(2)),
            conversions: Number(m.conversions || 0),
            conversionValue: Number(m.conversionsValue || 0),
            conversionValuePerCost: spend ? Number((Number(m.conversionsValue || 0) / spend).toFixed(4)) : 0,
            ctr: Number(m.ctr || 0) * 100,
            averageCpc: Number(m.averageCpc || 0) / 1000000
          });
        }
      }
      res.json({ success: true, connected: true, startDate, endDate, campaigns: all, source: "Google Ads API" });
    } catch (e) {
      console.error("Google Ads campaigns:", e.message);
      if (e.googleAds) return fail(res, 502, "Google Ads API error: " + e.message, "GOOGLE_ADS_API_ERROR");
      if (e.oauth) return fail(res, 409, "Google Ads authorization has expired or was revoked. Reconnect Google Ads.", "GOOGLE_ADS_REAUTH_REQUIRED");
      fail(res, 500, "Unable to load Google Ads campaign data.");
    }
  });


  router.get("/assets", async (req, res) => {
    try {
      const clientId = req.user.role === "admin" ? String(req.query.clientId || "") : String(req.user.clientId || "");
      if (!clientId) return fail(res, 400, "clientId is required");
      if (req.user.role !== "admin" && clientId !== String(req.user.clientId)) return fail(res, 403, "You cannot access another client's Google Ads data");
      const startDate = String(req.query.startDate || "");
      const endDate = String(req.query.endDate || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
        return fail(res, 400, "Valid startDate and endDate (YYYY-MM-DD) are required");
      }
      const { data: mappings, error } = await supabase.from("google_ads_client_accounts")
        .select("customer_id,customer_name,currency_code").eq("client_id", clientId);
      if (error) throw error;
      if (!mappings?.length) return res.json({ success: true, connected: false, assets: [], message: "No Google Ads account is assigned to this client." });
      const conn = await getConnection(supabase);
      if (!conn) return fail(res, 409, "Google Ads is not connected by the agency administrator", "GOOGLE_ADS_NOT_CONNECTED");
      const accessToken = await refreshAccessToken(conn.refreshToken);
      const all = [], warnings = [];
      for (const account of mappings) {
        try {
          const result = await googleAdsRequest(accessToken, account.customer_id, "googleAds:search", {
            query: `SELECT customer.id, customer.descriptive_name, customer.currency_code, campaign.id, campaign.name, asset_group.id, asset_group.name, asset_group_asset.asset, asset_group_asset.field_type, asset_group_asset.status, asset_group_asset.performance_label, asset.type, asset.text_asset.text, asset.image_asset.full_size.url, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.ctr FROM asset_group_asset WHERE segments.date BETWEEN '${startDate}' AND '${endDate}' ORDER BY segments.date DESC`
          });
          for (const row of result.results || []) {
            const m = row.metrics || {}, asset = row.asset || {}, ag = row.assetGroupAsset || {};
            all.push({
              customerId: String(row.customer?.id || account.customer_id),
              customerName: row.customer?.descriptiveName || account.customer_name,
              campaignName: row.campaign?.name || "—",
              assetGroupName: row.assetGroup?.name || "—",
              assetId: String(asset.id || ""),
              assetType: asset.type || ag.fieldType || "—",
              fieldType: ag.fieldType || "—",
              performanceLabel: ag.performanceLabel || "—",
              status: ag.status || "—",
              text: asset.textAsset?.text || "",
              imageUrl: asset.imageAsset?.fullSize?.url || "",
              date: row.segments?.date || "",
              impressions: Number(m.impressions || 0),
              clicks: Number(m.clicks || 0),
              spend: Number((Number(m.costMicros || 0) / 1000000).toFixed(2)),
              conversions: Number(m.conversions || 0),
              ctr: Number(m.ctr || 0) * 100
            });
          }
        } catch (assetError) {
          warnings.push((account.customer_name || account.customer_id) + ": " + assetError.message);
        }
      }
      res.json({ success: true, connected: true, startDate, endDate, assets: all, warnings, source: "Google Ads API" });
    } catch (e) {
      console.error("Google Ads assets:", e.message);
      if (e.googleAds) return fail(res, 502, "Google Ads asset report error: " + e.message, "GOOGLE_ADS_ASSET_API_ERROR");
      if (e.oauth) return fail(res, 409, "Google Ads authorization has expired or was revoked. Reconnect Google Ads.", "GOOGLE_ADS_REAUTH_REQUIRED");
      fail(res, 500, "Unable to load Google Ads asset data.");
    }
  });

  return router;
};
