const express = require("express");
const crypto = require("crypto");

module.exports = (supabase) => {
  const router = express.Router();
  const verifyToken = () => process.env.META_INSTAGRAM_WEBHOOK_VERIFY_TOKEN || "";
  const appSecret = () => process.env.META_APP_SECRET || "";

  // Meta webhook verification handshake.
  router.get("/", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token && token === verifyToken() && challenge) {
      return res.status(200).type("text/plain").send(String(challenge));
    }
    return res.sendStatus(403);
  });

  router.post("/", async (req, res) => {
    try {
      const secret = appSecret();
      const signature = String(req.get("x-hub-signature-256") || "");
      const rawBody = req.rawBody;
      if (!secret || !rawBody || !signature.startsWith("sha256=")) return res.sendStatus(401);
      const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
      const a = Buffer.from(signature);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);

      // Acknowledge quickly; only process Instagram messaging events.
      res.sendStatus(200);
      if (!req.body || req.body.object !== "instagram") return;
      for (const entry of (req.body.entry || [])) {
        const instagramAccountId = String(entry.id || "");
        if (!instagramAccountId) continue;
        const { data: assignments, error: assignmentError } = await supabase
          .from("client_social_page_permissions")
          .select("client_id,instagram_account_id,is_allowed")
          .eq("is_allowed", true)
          .eq("instagram_account_id", instagramAccountId);
        if (assignmentError) throw assignmentError;
        const clientIds = [...new Set((assignments || []).map(x => String(x.client_id)))];
        // Never guess a client if the Instagram account is not explicitly assigned
        // to exactly one client.
        if (clientIds.length !== 1) {
          console.warn("Instagram webhook ignored: account has no unique client assignment", instagramAccountId);
          continue;
        }
        const clientId = clientIds[0];
        for (const event of (entry.messaging || [])) {
          const senderId = String(event.sender?.id || "");
          const recipientId = String(event.recipient?.id || "");
          const message = event.message;
          const messageId = String(message?.mid || "");
          if (!senderId || !messageId || message?.is_echo || !message?.text) continue;
          const preview = String(message.text).slice(0, 500);
          const { error: insertError } = await supabase.from("leads").upsert({
            client_id: clientId,
            name: "Instagram user " + senderId.slice(-6),
            source: "instagram_dm",
            source_detail: "Instagram DM",
            status: "new",
            instagram_sender_id: senderId,
            instagram_account_id: recipientId || instagramAccountId,
            message_preview: preview,
            conversation_id: senderId,
            external_message_id: messageId
          }, { onConflict: "external_message_id", ignoreDuplicates: true });
          if (insertError) console.error("Instagram DM lead insert failed:", insertError.message);
        }
      }
    } catch (e) {
      console.error("Instagram webhook processing error:", e?.message || e);
      if (!res.headersSent) res.sendStatus(500);
    }
  });
  return router;
};
