const express = require("express");
const router = express.Router();

module.exports = (supabase, authenticateToken) => {
  // Build notifications from real portal events, then persist them so read state survives refreshes.
  router.get("/", authenticateToken, async (req, res) => {
    try {
      const isAdmin = req.user.role === "admin";
      const clientId = String(req.user.clientId || "");
      const generated = [];

      const { data: leads, error: leadsError } = await supabase
        .from("leads").select("id,client_id,name,source,created_at")
        .order("created_at", { ascending: false }).limit(50);
      if (leadsError) throw leadsError;
      for (const lead of leads || []) {
        const when = lead.created_at || new Date().toISOString();
        const label = lead.name ? String(lead.name) : "A new lead";
        generated.push({
          client_id: lead.client_id, recipient_role: "admin",
          event_key: "lead:" + lead.id + ":admin",
          title: "New lead received", message: label + " submitted a lead" + (lead.source ? " via " + lead.source : "") + ".",
          target_url: "Leads", created_at: when
        });
        if (lead.client_id) generated.push({
          client_id: lead.client_id, recipient_role: "client",
          event_key: "lead:" + lead.id + ":client",
          title: "New lead received", message: label + " submitted a new lead.",
          target_url: "Leads", created_at: when
        });
      }

      const { data: posts, error: postsError } = await supabase
        .from("social_posts").select("id,client_id,caption,status,updated_at,created_at")
        .in("status", ["pending_approval", "approved", "rejected", "failed"])
        .order("updated_at", { ascending: false }).limit(100);
      if (postsError) throw postsError;
      for (const post of posts || []) {
        const status = String(post.status || "");
        const when = post.updated_at || post.created_at || new Date().toISOString();
        const caption = String(post.caption || "Social post").slice(0, 90);
        if (status === "pending_approval") generated.push({
          client_id: post.client_id, recipient_role: "admin",
          event_key: "social:" + post.id + ":pending_approval",
          title: "Post needs approval", message: caption,
          target_url: "Social Media", created_at: when
        });
        if (["approved", "rejected", "failed"].includes(status) && post.client_id) generated.push({
          client_id: post.client_id, recipient_role: "client",
          event_key: "social:" + post.id + ":" + status,
          title: status === "approved" ? "Post approved" : status === "rejected" ? "Post rejected" : "Post failed",
          message: caption, target_url: "Social Media", created_at: when
        });
      }

      // Ignore duplicate events; never reset is_read on existing notifications.
      for (let i = 0; i < generated.length; i += 100) {
        const { error } = await supabase.from("notifications").upsert(generated.slice(i, i + 100), {
          onConflict: "recipient_role,client_id,event_key", ignoreDuplicates: true
        });
        if (error) throw error;
      }

      let query = supabase.from("notifications").select("*").order("created_at", { ascending: false }).limit(100);
      query = isAdmin ? query.eq("recipient_role", "admin") : query.eq("recipient_role", "client").eq("client_id", clientId);
      const { data, error } = await query;
      if (error) throw error;
      res.json({ success: true, notifications: data || [], unreadCount: (data || []).filter(n => !n.is_read).length });
    } catch (error) {
      console.error("Notifications error:", error?.message || error);
      res.status(500).json({ success: false, message: "Unable to load notifications. Run the notifications database migration and redeploy the backend." });
    }
  });

  router.patch("/:id/read", authenticateToken, async (req, res) => {
    try {
      const isAdmin = req.user.role === "admin";
      let query = supabase.from("notifications").update({ is_read: true }).eq("id", req.params.id);
      query = isAdmin ? query.eq("recipient_role", "admin") : query.eq("recipient_role", "client").eq("client_id", req.user.clientId);
      const { data, error } = await query.select("*").maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ success: false, message: "Notification not found or access denied" });
      res.json({ success: true, notification: data });
    } catch (error) {
      console.error("Mark notification read error:", error?.message || error);
      res.status(500).json({ success: false, message: "Unable to update notification" });
    }
  });

  router.post("/read-all", authenticateToken, async (req, res) => {
    try {
      const isAdmin = req.user.role === "admin";
      let query = supabase.from("notifications").update({ is_read: true }).eq("is_read", false);
      query = isAdmin ? query.eq("recipient_role", "admin") : query.eq("recipient_role", "client").eq("client_id", req.user.clientId);
      const { error } = await query;
      if (error) throw error;
      res.json({ success: true });
    } catch (error) {
      console.error("Mark all notifications read error:", error?.message || error);
      res.status(500).json({ success: false, message: "Unable to mark notifications as read" });
    }
  });

  return router;
};
