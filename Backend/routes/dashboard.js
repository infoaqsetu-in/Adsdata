const express = require("express");

const router = express.Router();

const n = v => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v))) ? null : Number(v);
const round = (v, d = 2) => v === null ? null : Number(v.toFixed(d));

module.exports = (supabase, authenticateToken) => {

  router.get("/", authenticateToken, async (req, res) => {
    try {
      const clientId = req.user.clientId;   // from the verified JWT only

      const { data: allRows, error: campaignsError } = await supabase
        .from("campaigns").select("*").eq("client_id", clientId);
      if (campaignsError) {
        console.error("Campaigns error:", campaignsError.message);
        return res.status(500).json({ success: false, message: "Unable to load campaign data" });
      }

      const { data: leads, error: leadsError } = await supabase
        .from("leads").select("*").eq("client_id", clientId);
      if (leadsError) {
        console.error("Leads error:", leadsError.message);
        return res.status(500).json({ success: false, message: "Unable to load lead data" });
      }

      const { data: conn } = await supabase
        .from("meta_connections")
        .select("ad_account_id, ad_account_name, currency, status, last_synced_at")
        .eq("client_id", clientId).maybeSingle();

      // Real synced Meta data wins. Rows without a meta_campaign_id are
      // manual/demo rows and are only used when nothing has been synced.
      let metaRows = (allRows || []).filter(r => r.meta_campaign_id);
      if (conn?.status === "active" && conn.ad_account_id) {
        metaRows = metaRows.filter(r => r.meta_ad_account_id === conn.ad_account_id);
      }
      const dataSource = metaRows.length ? "meta" : ((allRows || []).length ? "manual" : "none");
      const campaigns = dataSource === "meta" ? metaRows : (allRows || []);

      const sum = k => campaigns.reduce((t, c) => t + (n(c[k]) || 0), 0);
      const totalSpend = sum("spend");
      const totalImpressions = sum("impressions");
      const totalClicks = sum("clicks");
      const totalLeads = sum("leads");
      const totalConversions = sum("conversions");

      // ROAS only over campaigns that actually report it (spend-weighted).
      const withRoas = campaigns.filter(c => n(c.roas) !== null && n(c.spend) > 0);
      const roasSpend = withRoas.reduce((t, c) => t + Number(c.spend), 0);
      const roasRevenue = withRoas.reduce((t, c) => t + Number(c.spend) * Number(c.roas), 0);

      const starts = campaigns.map(c => c.date_start).filter(Boolean).sort();
      const stops = campaigns.map(c => c.date_stop).filter(Boolean).sort();

      res.json({
        success: true,
        clientId,
        dataSource,
        currency: campaigns.find(c => c.currency)?.currency || conn?.currency || null,
        dateRange: starts.length ? { start: starts[0], stop: stops[stops.length - 1] } : null,
        meta: {
          connected: conn?.status === "active",
          expired: conn?.status === "expired",
          adAccountName: conn?.ad_account_name || null,
          lastSyncedAt: conn?.last_synced_at || null
        },
        // Metrics that cannot be computed are null (not 0) so the UI can show "—".
        metrics: {
          totalSpend: round(totalSpend),
          totalImpressions,
          totalClicks,
          totalLeads,
          totalConversions,
          cpl: totalLeads > 0 ? round(totalSpend / totalLeads) : null,
          roas: roasSpend > 0 ? round(roasRevenue / roasSpend) : null,
          conversionRate: totalClicks > 0 && totalConversions > 0 ? round(totalConversions / totalClicks * 100) : null,
          ctr: totalImpressions > 0 ? round(totalClicks / totalImpressions * 100) : null,
          cpc: totalClicks > 0 ? round(totalSpend / totalClicks) : null,
          cpm: totalImpressions > 0 ? round(totalSpend / totalImpressions * 1000) : null
        },
        campaigns,
        leads
      });
    } catch (error) {
      console.error("Dashboard error:", error?.message || error);
      res.status(500).json({ success: false, message: "Server error" });
    }
  });

  return router;
};
