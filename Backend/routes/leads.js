const express = require("express");

const router = express.Router();

module.exports = (supabase, authenticateToken) => {

  // Get leads for logged-in client
  router.get("/", authenticateToken, async (req, res) => {

    try {

      const { data, error } = await supabase
        .from("leads")
        .select("*")
        .eq("client_id", req.user.clientId)
        .order("created_at", {
          ascending: false
        });

      if (error) {

        console.error("Leads error:", error);

        return res.status(500).json({
          success: false,
          message: "Unable to load leads"
        });

      }

      res.json({
        success: true,
        leads: data
      });

    } catch (error) {

      console.error("Server error:", error);

      res.status(500).json({
        success: false,
        message: "Server error"
      });

    }

  });

  // Client-scoped lead status update.
  router.patch("/:id/status", authenticateToken, async (req, res) => {
    try {
      const status = String(req.body?.status || "").toLowerCase();
      if (!["new", "contacted", "qualified", "converted", "lost"].includes(status)) return res.status(400).json({ success: false, message: "Invalid lead status" });
      const { data, error } = await supabase.from("leads").update({ status }).eq("id", req.params.id).eq("client_id", req.user.clientId).select("*").maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ success: false, message: "Lead not found or access denied" });
      res.json({ success: true, lead: data });
    } catch (error) { console.error("Update lead status error:", error?.message || error); res.status(500).json({ success: false, message: "Unable to update lead status" }); }
  });

  return router;
};