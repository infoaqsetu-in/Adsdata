const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const meta = require("../services/meta");
const { encryptToken, decryptToken } = require("../services/crypto");

const syncLocks = new Set();

const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const page = (title, body, status = 200) => ({
  status,
  html: `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="font-family:Arial;text-align:center;padding:60px"><h2>${esc(title)}</h2>${body}
<p>You can close this window and return to AQ Setu.</p></body></html>`
});

module.exports = (supabase, authenticateToken) => {
  const router = express.Router();

  // ---------------- helpers ----------------
  const fail = (res, status, message, code) =>
    res.status(status).json({ success: false, message, ...(code ? { code } : {}) });

  // Server-side only: returns the row including the decrypted token.
  async function getConnection(clientId) {
    const { data, error } = await supabase
      .from("meta_connections")
      .select("*")
      .eq("client_id", clientId)
      .eq("status", "active")
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { ...data, token: decryptToken(data.access_token) };
  }

  async function requireConnection(req, res) {
    const conn = await getConnection(req.user.clientId);
    if (!conn) {
      fail(res, 404, "No Meta account is connected for this client", "META_NOT_CONNECTED");
      return null;
    }
    return conn;
  }

  async function handleError(req, res, err, label) {
    if (err instanceof meta.MetaApiError) {
      console.error(`${label}: Meta error code=${err.metaCode} sub=${err.metaSubcode} http=${err.httpStatus}: ${err.message}`);
      if (err.isTokenError) {
        await supabase.from("meta_connections")
          .update({ status: "expired", last_sync_error: "Meta access token expired or revoked" })
          .eq("client_id", req.user.clientId);
        return fail(res, 409, "The Meta connection has expired. Please reconnect Meta.", "META_TOKEN_EXPIRED");
      }
      if (err.isRateLimit) return fail(res, 429, "Meta rate limit reached. Try again in a few minutes.", "META_RATE_LIMIT");
      return fail(res, 502, `Meta API error: ${err.message}`, "META_API_ERROR");
    }
    if (err?.badRequest) return fail(res, 400, err.message);
    // PostgREST/Postgres errors that mean the migration has not been applied
    if (err && ["PGRST204", "42703", "42P10", "42P01", "PGRST205"].includes(err.code)) {
      console.error(`${label}: database schema mismatch:`, err.code, err.message);
      return fail(res, 500, "Database is missing the Meta integration columns. Run Backend/sql/001_meta_integration.sql in Supabase.", "DB_MIGRATION_REQUIRED");
    }
    console.error(`${label}:`, err?.code || "", err?.message || err);
    return fail(res, 500, "Server error");
  }

  async function saveConnection(clientId, { metaUserId, token, expiresIn, accounts, keepAccountId }) {
    const keep = accounts.find(a => a.id === keepAccountId);
    const selected = keep || accounts[0];
    const row = {
      client_id: clientId,
      meta_user_id: metaUserId,
      ad_account_id: selected?.id || null,
      ad_account_name: selected?.name || null,
      currency: selected?.currency || null,
      access_token: encryptToken(token),
      token_expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      status: "active",
      last_sync_error: null,
      updated_at: new Date().toISOString()
    };
    const { error } = await supabase.from("meta_connections").upsert(row, { onConflict: "client_id" });
    if (error) throw error;
    return selected;
  }

  // ---------------- OAuth ----------------
  router.get("/connect", authenticateToken, (req, res) => {
    if (!process.env.META_APP_ID || !process.env.META_REDIRECT_URI) {
      return fail(res, 500, "Meta app is not configured on the server");
    }
    // Signed, short-lived state: the callback can only be completed for the
    // client that started the flow. (Previously state was the raw clientId.)
    const state = jwt.sign(
      { purpose: "meta_oauth", clientId: req.user.clientId, userId: req.user.userId, nonce: crypto.randomBytes(8).toString("hex") },
      process.env.JWT_SECRET,
      { expiresIn: "10m" }
    );
    const params = new URLSearchParams({
      client_id: process.env.META_APP_ID,
      redirect_uri: process.env.META_REDIRECT_URI,
      response_type: "code",
      state,
      scope: "ads_read,ads_management"
    });
    res.json({ success: true, authUrl: `https://www.facebook.com/${process.env.META_API_VERSION || "v26.0"}/dialog/oauth?${params}` });
  });

  router.get("/callback", async (req, res) => {
    const send = p => res.status(p.status).send(p.html);
    try {
      const { code, state, error, error_description } = req.query;
      if (error) return send(page("Meta connection cancelled", `<p>${esc(error_description || error)}</p>`, 400));
      if (!code || !state) return send(page("Missing authorization code", "", 400));

      let st;
      try {
        st = jwt.verify(String(state), process.env.JWT_SECRET);
        if (st.purpose !== "meta_oauth" || !st.clientId) throw new Error("bad state");
      } catch {
        return send(page("Invalid or expired connection request", "<p>Please start again from the portal.</p>", 400));
      }
      const clientId = st.clientId;

      // code -> short-lived token
      const tokenUrl = new URL(`${process.env.META_GRAPH_BASE_URL || "https://graph.facebook.com"}/${process.env.META_API_VERSION || "v26.0"}/oauth/access_token`);
      tokenUrl.search = new URLSearchParams({
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: process.env.META_REDIRECT_URI,
        code: String(code)
      });
      const tr = await fetch(tokenUrl, { signal: AbortSignal.timeout(30000) });
      const td = await tr.json();
      if (!tr.ok || td.error) {
        console.error("Meta token exchange failed:", td.error?.code, td.error?.message);
        return send(page("Unable to connect to Meta", "", 502));
      }
      let token = td.access_token, expiresIn = td.expires_in;

      // short-lived -> long-lived (~60 days); keep the short one if this fails
      try {
        const lu = new URL(tokenUrl);
        lu.search = new URLSearchParams({
          grant_type: "fb_exchange_token",
          client_id: process.env.META_APP_ID,
          client_secret: process.env.META_APP_SECRET,
          fb_exchange_token: token
        });
        const lr = await fetch(lu, { signal: AbortSignal.timeout(30000) });
        const ld = await lr.json();
        if (lr.ok && ld.access_token) { token = ld.access_token; expiresIn = ld.expires_in || expiresIn; }
      } catch { /* keep short-lived token */ }

      const me = await meta.getMe(token);
      const accounts = await meta.listAdAccounts(token);
      if (!accounts.length) return send(page("No ad accounts found", "<p>Your Meta account has no accessible ad account.</p>", 400));

      const existing = await supabase.from("meta_connections").select("ad_account_id").eq("client_id", clientId).maybeSingle();
      const selected = await saveConnection(clientId, {
        metaUserId: me.id, token, expiresIn, accounts, keepAccountId: existing.data?.ad_account_id
      });
      return send(page("Meta connected ✓", `<p>Ad account: <strong>${esc(selected.name)}</strong></p>`));
    } catch (err) {
      console.error("Meta callback error:", err?.message || err);
      return send(page("Meta connection failed", "", 500));
    }
  });

  // Admin-only: attach a Meta token (e.g. a System User token) to the caller's client.
  router.post("/connect-token", authenticateToken, async (req, res) => {
    if (req.user.role !== "admin") return fail(res, 403, "Admin role required");
    const token = req.body?.accessToken;
    if (typeof token !== "string" || token.length < 20) return fail(res, 400, "accessToken is required");
    try {
      const me = await meta.getMe(token);
      const accounts = await meta.listAdAccounts(token);
      if (!accounts.length) return fail(res, 400, "That token has no accessible ad accounts");
      const selected = await saveConnection(req.user.clientId, { metaUserId: me.id, token, accounts, keepAccountId: req.body?.adAccountId });
      res.json({ success: true, adAccount: { id: selected.id, name: selected.name } });
    } catch (err) { await handleError(req, res, err, "connect-token"); }
  });

  // ---------------- status / accounts ----------------
  router.get("/status", authenticateToken, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("meta_connections")
        .select("id, meta_user_id, ad_account_id, ad_account_name, currency, status, token_expires_at, last_synced_at, last_sync_error, created_at, updated_at")
        .eq("client_id", req.user.clientId)
        .maybeSingle();
      if (error) throw error;
      res.json({
        success: true,
        connected: data?.status === "active",
        expired: data?.status === "expired",
        connection: data || null
      });
    } catch (err) { await handleError(req, res, err, "status"); }
  });

  router.get("/accounts", authenticateToken, async (req, res) => {
    try {
      const conn = await requireConnection(req, res); if (!conn) return;
      const accounts = await meta.listAdAccounts(conn.token);
      res.json({ success: true, selectedAdAccountId: conn.ad_account_id, accounts });
    } catch (err) { await handleError(req, res, err, "accounts"); }
  });

  router.post("/account", authenticateToken, async (req, res) => {
    try {
      const id = req.body?.adAccountId;
      if (!meta.isValidAdAccountId(id)) return fail(res, 400, "adAccountId must look like act_1234567890");
      const conn = await requireConnection(req, res); if (!conn) return;
      const accounts = await meta.listAdAccounts(conn.token);
      const acct = accounts.find(a => a.id === id);
      if (!acct) return fail(res, 403, "That ad account is not accessible with this Meta connection");
      const { error } = await supabase.from("meta_connections")
        .update({ ad_account_id: acct.id, ad_account_name: acct.name, currency: acct.currency || null, updated_at: new Date().toISOString() })
        .eq("client_id", req.user.clientId);
      if (error) throw error;
      res.json({ success: true, adAccount: { id: acct.id, name: acct.name, currency: acct.currency } });
    } catch (err) { await handleError(req, res, err, "select-account"); }
  });

  // ---------------- live reads (straight from Meta, not stored) ----------------
  router.get("/campaigns", authenticateToken, async (req, res) => {
    try {
      const conn = await requireConnection(req, res); if (!conn) return;
      if (!conn.ad_account_id) return fail(res, 400, "No ad account selected", "META_NO_AD_ACCOUNT");
      const campaigns = await meta.listCampaigns(conn.token, conn.ad_account_id);
      res.json({ success: true, adAccountId: conn.ad_account_id, campaigns });
    } catch (err) { await handleError(req, res, err, "campaigns"); }
  });

  router.get("/insights", authenticateToken, async (req, res) => {
    try {
      const range = meta.resolveDateRange(req.query);
      const conn = await requireConnection(req, res); if (!conn) return;
      if (!conn.ad_account_id) return fail(res, 400, "No ad account selected", "META_NO_AD_ACCOUNT");
      const insights = await meta.listCampaignInsights(conn.token, conn.ad_account_id, range);
      res.json({ success: true, adAccountId: conn.ad_account_id, range: range.label, insights });
    } catch (err) { await handleError(req, res, err, "insights"); }
  });

  // ---------------- sync: Meta -> Supabase ----------------
  router.post("/sync", authenticateToken, async (req, res) => {
    const clientId = req.user.clientId;           // never taken from the request
    if (syncLocks.has(clientId)) return fail(res, 409, "A sync is already running", "SYNC_IN_PROGRESS");
    syncLocks.add(clientId);
    try {
      const range = meta.resolveDateRange(req.body || {});
      const conn = await requireConnection(req, res); if (!conn) return;
      if (!conn.ad_account_id) return fail(res, 400, "No ad account selected", "META_NO_AD_ACCOUNT");

      const [campaigns, insights] = await Promise.all([
        meta.listCampaigns(conn.token, conn.ad_account_id),
        meta.listCampaignInsights(conn.token, conn.ad_account_id, range)
      ]);
      const byCampaign = new Map(insights.map(i => [i.campaign_id, i]));
      const syncedAt = new Date().toISOString();

      const rows = campaigns.map(c => meta.normalizeCampaign({
        campaign: c, insight: byCampaign.get(c.id), clientId,
        adAccountId: conn.ad_account_id, currency: conn.currency, syncedAt
      }));

      if (rows.length) {
        const { error } = await supabase.from("campaigns")
          .upsert(rows, { onConflict: "client_id,meta_campaign_id" });
        if (error) throw error;
      }
      await supabase.from("meta_connections")
        .update({ last_synced_at: syncedAt, last_sync_error: null })
        .eq("client_id", clientId);

      res.json({
        success: true,
        adAccountId: conn.ad_account_id,
        range: range.label,
        campaignsSynced: rows.length,
        campaignsWithInsights: rows.filter(r => byCampaign.has(r.meta_campaign_id)).length,
        syncedAt
      });
    } catch (err) {
      if (!res.headersSent) await handleError(req, res, err, "sync");
    } finally {
      syncLocks.delete(clientId);
    }
  });

  return router;
};
