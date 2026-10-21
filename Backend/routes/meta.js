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
      if (err.metaCode === 10 || /pages_read_engagement|Page Public Content Access/i.test(err.message || "")) {
        return fail(res, 502, "Meta permission required: reconnect the Facebook account and approve pages_read_engagement. If it is still denied, enable/obtain Meta's Page Public Content Access feature for this app. Then retry the calendar sync.", "META_PERMISSION_REQUIRED");
      }
      return fail(res, 502, `Meta API error: ${err.message}`, "META_API_ERROR");
    }
    if (err?.badRequest) return fail(res, 400, err.message);
    // PostgREST/Postgres errors that mean the migration has not been applied
    if (err && ["PGRST204", "42703", "42P10", "42P01", "PGRST205"].includes(err.code)) {
      console.error(`${label}: database schema mismatch:`, err.code, err.message);
      return fail(res, 500, `Database schema error (${err.code}): ${String(err.message || "missing column or constraint").slice(0, 260)}. Confirm the migration was run on the same Supabase project used by the deployed backend.`, "DB_MIGRATION_REQUIRED");
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


  async function allowedAccountIds(clientId, fallbackAccountId) {
    const { data, error } = await supabase.from("meta_account_permissions")
      .select("ad_account_id,is_allowed").eq("client_id", clientId);
    if (error) throw error;
    if (!data || data.length === 0) return fallbackAccountId ? [fallbackAccountId] : [];
    return data.filter(x => x.is_allowed).map(x => x.ad_account_id);
  }

  // Admin: inspect accounts available through a client's Meta connection.
  router.get("/admin/accounts", authenticateToken, async (req, res) => {
    if (req.user.role !== "admin") return fail(res, 403, "Admin role required");
    const clientId = String(req.query.clientId || "");
    if (!clientId) return fail(res, 400, "clientId is required");
    try {
      // Use the agency's existing active Meta connection as the account directory.
      // The admin can assign those accounts to a target client without reconnecting Meta.
      let conn = await getConnection(clientId);
      if (!conn) {
        const { data: source, error: sourceError } = await supabase.from("meta_connections")
          .select("*").eq("status", "active").not("access_token", "is", null)
          .order("updated_at", { ascending: false }).limit(1).maybeSingle();
        if (sourceError) throw sourceError;
        if (!source) return fail(res, 404, "No active Meta connection exists. Connect Meta to the agency account first.");
        conn = { ...source, token: decryptToken(source.access_token) };
      }
      const [accounts, permissionResult] = await Promise.all([
        meta.listAdAccounts(conn.token),
        supabase.from("meta_account_permissions").select("ad_account_id,is_allowed")
          .eq("client_id", clientId)
      ]);
      if (permissionResult.error) throw permissionResult.error;
      const explicit = permissionResult.data || [];
      const hasExplicit = explicit.length > 0;
      const allowed = new Set(hasExplicit
        ? explicit.filter(x => x.is_allowed).map(x => x.ad_account_id)
        : [conn.ad_account_id].filter(Boolean));
      res.json({ success: true, selectedAdAccountId: conn.ad_account_id, hasExplicitPermissions: hasExplicit,
        accounts: accounts.map(a => ({...a, allowed: allowed.has(a.id)})) });
    } catch (err) { await handleError(req, res, err, "admin-account-permissions"); }
  });

  router.put("/admin/permissions", authenticateToken, async (req, res) => {
    if (req.user.role !== "admin") return fail(res, 403, "Admin role required");
    const clientId = String(req.body?.clientId || "");
    const ids = req.body?.allowedAccountIds;
    if (!clientId || !Array.isArray(ids) || ids.some(id => typeof id !== "string" || !meta.isValidAdAccountId(id))) {
      return fail(res, 400, "clientId and valid allowedAccountIds are required");
    }
    try {
      // Prefer the target client's connection; otherwise use the agency's existing connection.
      let conn = await getConnection(clientId);
      if (!conn) {
        const { data: source, error: sourceError } = await supabase.from("meta_connections")
          .select("*").eq("status", "active").not("access_token", "is", null)
          .order("updated_at", { ascending: false }).limit(1).maybeSingle();
        if (sourceError) throw sourceError;
        if (!source) return fail(res, 404, "No active Meta connection exists. Connect Meta to the agency account first.");
        conn = { ...source, token: decryptToken(source.access_token) };
      }
      const accounts = await meta.listAdAccounts(conn.token);
      const validIds = new Set(accounts.map(a => a.id));
      if (ids.some(id => !validIds.has(id))) return fail(res, 400, "One or more accounts are not accessible through this Meta connection");
      const { error: deleteError } = await supabase.from("meta_account_permissions").delete().eq("client_id", clientId);
      if (deleteError) throw deleteError;
      const rows = accounts.map(a => ({
        client_id: clientId, ad_account_id: a.id, ad_account_name: a.name || null,
        is_allowed: ids.includes(a.id), updated_at: new Date().toISOString()
      }));
      if (rows.length) {
        const { error } = await supabase.from("meta_account_permissions").insert(rows);
        if (error) throw error;
      }
      // Attach the existing agency token to this client so the client's normal
      // campaign/insights/sync endpoints can use the approved account list.
      if (conn.client_id !== clientId) {
        const next = accounts.find(a => ids.includes(a.id));
        const { error: attachError } = await supabase.from("meta_connections").upsert({
          client_id: clientId,
          meta_user_id: conn.meta_user_id,
          ad_account_id: next?.id || null,
          ad_account_name: next?.name || null,
          currency: next?.currency || null,
          access_token: conn.access_token,
          token_expires_at: conn.token_expires_at,
          status: "active",
          last_sync_error: null,
          updated_at: new Date().toISOString()
        }, { onConflict: "client_id" });
        if (attachError) throw attachError;
      }
      // If the currently selected account was revoked, switch to the first allowed account.
      if (!ids.includes(conn.ad_account_id)) {
        const next = accounts.find(a => ids.includes(a.id));
        const { error } = await supabase.from("meta_connections").update({
          ad_account_id: next?.id || null, ad_account_name: next?.name || null,
          currency: next?.currency || null, updated_at: new Date().toISOString()
        }).eq("client_id", clientId);
        if (error) throw error;
      }
      res.json({ success: true, allowedAccountIds: ids });
    } catch (err) { await handleError(req, res, err, "save-account-permissions"); }
  });

  // ---------------- OAuth ----------------
  router.get("/connect", authenticateToken, async (req, res) => {
    if (!process.env.META_APP_ID || !process.env.META_REDIRECT_URI) {
      return fail(res, 500, "Meta app is not configured on the server");
    }
    const requestedClientId = typeof req.query.clientId === "string" ? req.query.clientId : null;
    const clientId = req.user.role === "admin" ? requestedClientId : req.user.clientId;
    if (!clientId) return fail(res, 400, "Select a client before connecting Meta");
    if (req.user.role !== "admin" && requestedClientId && requestedClientId !== req.user.clientId) {
      return fail(res, 403, "You can only connect Meta for your own client");
    }
    if (req.user.role === "admin") {
      const { data: client, error } = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
      if (error) return fail(res, 500, "Unable to verify selected client");
      if (!client) return fail(res, 404, "Selected client was not found");
    }
    const state = jwt.sign(
      { purpose: "meta_oauth", clientId, userId: req.user.userId, role: req.user.role, nonce: crypto.randomBytes(8).toString("hex") },
      process.env.JWT_SECRET,
      { expiresIn: "10m" }
    );
    const params = new URLSearchParams({
      client_id: process.env.META_APP_ID,
      redirect_uri: process.env.META_REDIRECT_URI,
      response_type: "code",
      state,
      scope: "ads_read,ads_management,business_management,pages_show_list,pages_read_engagement,pages_read_user_content,pages_manage_posts,instagram_basic,instagram_manage_insights,instagram_content_publish",
      auth_type: "rerequest"
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

  // Admin-only: attach a Meta token to an explicitly selected client.
  router.post("/connect-token", authenticateToken, async (req, res) => {
    if (req.user.role !== "admin") return fail(res, 403, "Admin role required");
    const clientId = req.body?.clientId;
    if (typeof clientId !== "string" || !clientId) return fail(res, 400, "clientId is required");
    const token = req.body?.accessToken;
    if (typeof token !== "string" || token.length < 20) return fail(res, 400, "accessToken is required");
    try {
      const { data: client, error } = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
      if (error) return fail(res, 500, "Unable to verify selected client");
      if (!client) return fail(res, 404, "Selected client was not found");
      const me = await meta.getMe(token);
      const accounts = await meta.listAdAccounts(token);
      if (!accounts.length) return fail(res, 400, "That token has no accessible ad accounts");
      const selected = await saveConnection(clientId, { metaUserId: me.id, token, accounts, keepAccountId: req.body?.adAccountId });
      res.json({ success: true, adAccount: { id: selected.id, name: selected.name } });
    } catch (err) { await handleError(req, res, err, "connect-token"); }
  });


  // Organic Page assignments are independent of Meta ad-account permissions.
  async function getOrganicDirectoryPages() {
    const { data, error } = await supabase.from("meta_connections")
      .select("*").eq("status", "active").not("access_token", "is", null)
      .order("updated_at", { ascending: false });
    if (error) throw error;
    const byId = new Map();
    const diagnostics = [];
    if (!data?.length) diagnostics.push({ clientId: null, issue: "No active Meta connection rows with saved access tokens were found in the deployed database." });
    for (const row of data || []) {
      try {
        const token = decryptToken(row.access_token);
        const pages = await meta.listPages(token);
        if (!pages.length) {
          let granted = [];
          let permissionDiagnostic = "";
          try {
            granted = await meta.listGrantedPermissions(token);
            const relevant = granted.filter(p => [
              "pages_show_list", "pages_read_engagement", "pages_read_user_content",
              "pages_manage_posts", "instagram_basic", "instagram_manage_insights",
              "instagram_content_publish", "business_management"
            ].includes(p.permission));
            permissionDiagnostic = relevant.length
              ? " Granted permissions: " + relevant.map(p => p.permission + "=" + p.status).join(", ") + "."
              : " Meta did not report any of the expected Page/Instagram permissions as granted.";
          } catch (permissionError) {
            permissionDiagnostic = " Could not inspect granted permissions (" + (permissionError?.message || "Meta API error") + ").";
          }
          diagnostics.push({
            clientId: row.client_id,
            issue: "Meta returned zero Facebook Pages for this connection." + permissionDiagnostic +
              " Reconnect using the Facebook profile that has Facebook Page access, and approve Page access in the consent screen. Selecting a Page in the consent screen alone does not guarantee the saved token has the required granted permissions."
          });
        }
        for (const page of pages) {
          const key = String(page.id);
          if (!byId.has(key)) byId.set(key, { ...page, _accessToken: token });
        }
      } catch (err) {
        const message = err?.message || "Unknown Meta API error";
        console.warn("Unable to enumerate organic Pages for a Meta connection:", err?.metaCode || err?.code || message);
        diagnostics.push({
          clientId: row.client_id,
          issue: err?.metaCode ? `Meta API error ${err.metaCode}: ${message}` : message
        });
      }
    }
    const pages = Array.from(byId.values());
    pages.diagnostics = diagnostics;
    return pages;
  }

  router.get("/social/accounts", authenticateToken, async (req, res) => {
    if (req.user.role !== "admin") return fail(res, 403, "Admin role required");
    const clientId = String(req.query.clientId || "");
    if (!clientId) return fail(res, 400, "clientId is required");
    try {
      const [pages, assignedResult] = await Promise.all([
        getOrganicDirectoryPages(),
        supabase.from("client_social_page_permissions").select("page_id,is_allowed").eq("client_id", clientId)
      ]);
      if (!pages.length) { const details = (pages.diagnostics || []).map(d => d.clientId ? `${d.clientId}: ${d.issue}` : d.issue); return res.status(404).json({ success: false, message: "No Facebook Pages are accessible from the active Meta connections." + (details.length ? " Details: " + details.join(" | ") : " No diagnostic details were returned; verify the deployed backend version and database connection."), diagnostics: pages.diagnostics || [], nextStep: "Reconnect the Meta account that has access to the Facebook Pages and approve the requested Page permissions." }); }
      if (assignedResult.error) throw assignedResult.error;
      const rows = assignedResult.data || [];
      const hasExplicitPermissions = rows.length > 0;
      const assigned = new Set(rows.filter(x => x.is_allowed).map(x => String(x.page_id)));
      res.json({ success: true, hasExplicitPermissions, diagnostics: pages.diagnostics || [], pages: pages.map(p => ({
        id: p.id, name: p.name,
        instagramAccount: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username } : null,
        allowed: assigned.has(String(p.id))
      })) });
    } catch (err) { await handleError(req, res, err, "meta-social-accounts"); }
  });

  router.put("/social/permissions", authenticateToken, async (req, res) => {
    if (req.user.role !== "admin") return fail(res, 403, "Admin role required");
    const clientId = String(req.body?.clientId || "");
    const pageIds = req.body?.allowedPageIds;
    if (!clientId || !Array.isArray(pageIds) || pageIds.some(id => typeof id !== "string" || !/^\\d+$/.test(id))) {
      return fail(res, 400, "clientId and valid allowedPageIds are required");
    }
    try {
      const { data: client, error: clientError } = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
      if (clientError) throw clientError;
      if (!client) return fail(res, 404, "Selected client was not found");
      const pages = await getOrganicDirectoryPages();
      if (!pages.length) { const details = (pages.diagnostics || []).map(d => d.clientId ? `${d.clientId}: ${d.issue}` : d.issue); return res.status(404).json({ success: false, message: "No Facebook Pages are accessible from the active Meta connections." + (details.length ? " Details: " + details.join(" | ") : " No diagnostic details were returned; verify the deployed backend version and database connection."), diagnostics: pages.diagnostics || [], nextStep: "Reconnect the Meta account that has access to the Facebook Pages and approve the requested Page permissions." }); }
      const pageById = new Map(pages.map(p => [String(p.id), p]));
      if (pageIds.some(id => !pageById.has(id))) return fail(res, 400, "One or more Pages are not accessible through the connected Meta account");
      const { error: deleteError } = await supabase.from("client_social_page_permissions").delete().eq("client_id", clientId);
      if (deleteError) throw deleteError;
      const rows = pages.map(p => ({
        client_id: clientId, page_id: String(p.id), page_name: p.name || null,
        instagram_account_id: p.instagram_business_account?.id || null,
        instagram_username: p.instagram_business_account?.username || null,
        is_allowed: pageIds.includes(String(p.id)), updated_at: new Date().toISOString()
      }));
      if (rows.length) {
        const { error } = await supabase.from("client_social_page_permissions").insert(rows);
        if (error) throw error;
      }
      res.json({ success: true, clientId, allowedPageIds: pageIds, diagnostics: pages.diagnostics || [] });
    } catch (err) { await handleError(req, res, err, "save-social-page-permissions"); }
  });

  // Sync only Pages explicitly assigned to the target client. No implicit all-Pages fallback.
  router.post("/social/sync", authenticateToken, async (req, res) => {
    const isAdmin = req.user.role === "admin";
    const clientId = isAdmin ? String(req.body?.clientId || "") : String(req.user.clientId || "");
    if (!clientId) return fail(res, 400, "clientId is required");
    try {
      const pages = await getOrganicDirectoryPages();
      if (!pages.length) { const details = (pages.diagnostics || []).map(d => d.clientId ? `${d.clientId}: ${d.issue}` : d.issue); return res.status(404).json({ success: false, message: "No Facebook Pages are accessible from the active Meta connections." + (details.length ? " Details: " + details.join(" | ") : " No diagnostic details were returned; verify the deployed backend version and database connection."), diagnostics: pages.diagnostics || [], nextStep: "Reconnect the Meta account that has access to the Facebook Pages and approve the requested Page permissions." }); }
      const { data: permissions, error: permissionError } = await supabase.from("client_social_page_permissions")
        .select("page_id").eq("client_id", clientId).eq("is_allowed", true);
      if (permissionError) throw permissionError;
      const allowedIds = new Set((permissions || []).map(x => String(x.page_id)));
      const requested = Array.isArray(req.body?.pageIds) ? req.body.pageIds.map(String) : [];
      if (isAdmin && requested.some(id => !allowedIds.has(id))) return fail(res, 403, "Select only Pages assigned to this client. Save Page permissions first.");
      if (!allowedIds.size) return fail(res, 409, "No organic Pages are assigned to this client. Ask the agency admin to assign Pages in Integrations.");
      const selected = pages.filter(p => allowedIds.has(String(p.id)) && (!isAdmin || requested.length === 0 || requested.includes(String(p.id))));
      if (selected.length !== allowedIds.size) return fail(res, 409, "Some assigned Pages are no longer accessible through Meta. Review Page permissions in Integrations.");
      let synced = 0;
      const warnings = [];
      for (const p of selected) {
        const rows = [];
        try {
          const published = await meta.listPagePublishedPosts(p.id, p.access_token || p._accessToken);
          rows.push(...published.map(x => ({client_id:clientId,platform:"facebook",caption:x.message||"(No caption)",media_url:x.full_picture||null,post_url:x.permalink_url||null,platform_post_id:x.id,status:"published",published_at:x.created_time||null,scheduled_at:x.created_time||null,likes_count:x.likes?.summary?.total_count??null,comments_count:x.comments?.summary?.total_count??null,updated_at:new Date().toISOString()})));
        } catch (e) {
          if (e.metaCode === 10 || /pages_read_engagement|Page Public Content Access/i.test(e.message || "")) warnings.push("Facebook published posts unavailable: grant pages_read_engagement or Page Public Content Access, then reconnect.");
          else throw e;
        }
        try {
          const scheduled = await meta.listPageScheduledPosts(p.id, p.access_token || p._accessToken);
          rows.push(...scheduled.map(x => ({client_id:clientId,platform:"facebook",caption:x.message||"(No caption)",media_url:x.full_picture||null,post_url:x.permalink_url||null,platform_post_id:x.id,status:"scheduled",scheduled_at:x.scheduled_publish_time?new Date(Number(x.scheduled_publish_time)*1000).toISOString():null,updated_at:new Date().toISOString()})));
        } catch (e) {
          if (e.metaCode === 100 || e.metaCode === 10) warnings.push("Scheduled Facebook posts are not accessible for at least one assigned Page.");
          else throw e;
        }
        const igId = p.instagram_business_account?.id;
        if (igId) {
          try {
            const media = await meta.listInstagramMedia(igId, p.access_token || p._accessToken);
            rows.push(...media.map(x => ({client_id:clientId,platform:"instagram",caption:x.caption||"(No caption)",media_url:x.media_url||null,post_url:x.permalink||null,platform_post_id:x.id,status:"published",published_at:x.timestamp||null,scheduled_at:x.timestamp||null,likes_count:x.like_count??null,comments_count:x.comments_count??null,updated_at:new Date().toISOString()})));
          } catch (e) {
            if (e.metaCode === 10 || e.metaCode === 100) warnings.push("Instagram media unavailable: verify the linked professional account and Meta permissions.");
            else throw e;
          }
        }
        for (let i=0; i<rows.length; i+=100) {
          const batch = rows.slice(i,i+100);
          const { error } = await supabase.from("social_posts").upsert(batch,{onConflict:"client_id,platform,platform_post_id"});
          if (error) throw error;
          synced += batch.length;
        }
      }
      res.json({success:true,pagesSynced:selected.length,postsSynced:synced,warnings:[...(pages.diagnostics || []).map(d => `${d.clientId}: ${d.issue}`), ...warnings]});
    } catch (err) { await handleError(req, res, err, "meta-social-sync"); }
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
      const allowed = new Set(await allowedAccountIds(req.user.clientId, conn.ad_account_id));
      res.json({ success: true, selectedAdAccountId: conn.ad_account_id, accounts: accounts.filter(a => allowed.has(a.id)) });
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
      const allowed = new Set(await allowedAccountIds(req.user.clientId, conn.ad_account_id));
      if (!allowed.has(id)) return fail(res, 403, "This ad account has not been approved for your client");
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
      if (!(await allowedAccountIds(req.user.clientId, conn.ad_account_id)).includes(conn.ad_account_id)) return fail(res, 403, "This ad account has not been approved for your client");
      const campaigns = await meta.listCampaigns(conn.token, conn.ad_account_id);
      res.json({ success: true, adAccountId: conn.ad_account_id, campaigns });
    } catch (err) { await handleError(req, res, err, "campaigns"); }
  });

  router.get("/insights", authenticateToken, async (req, res) => {
    try {
      const range = meta.resolveDateRange(req.query);
      const conn = await requireConnection(req, res); if (!conn) return;
      if (!conn.ad_account_id) return fail(res, 400, "No ad account selected", "META_NO_AD_ACCOUNT");
      if (!(await allowedAccountIds(req.user.clientId, conn.ad_account_id)).includes(conn.ad_account_id)) return fail(res, 403, "This ad account has not been approved for your client");
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
      if (!(await allowedAccountIds(clientId, conn.ad_account_id)).includes(conn.ad_account_id)) return fail(res, 403, "This ad account has not been approved for your client");

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
