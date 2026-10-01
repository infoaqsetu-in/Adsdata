const express = require("express");

const router = express.Router();

module.exports = (supabase, authenticateToken) => {

  // Get campaigns for logged-in client
  router.get("/", authenticateToken, async (req, res) => {

    try {

      const { data, error } = await supabase
        .from("campaigns")
        .select("*")
        .eq("client_id", req.user.clientId)
        .order("created_at", {
          ascending: false
        });

      if (error) {

        console.error("Campaigns error:", error);

        return res.status(500).json({
          success: false,
          message: "Unable to load campaigns"
        });

      }

      res.json({
        success: true,
        campaigns: data
      });

    } catch (error) {

      console.error("Server error:", error);

      res.status(500).json({
        success: false,
        message: "Server error"
      });

    }

  });

  return router;
};