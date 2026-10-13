const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const router = express.Router();

module.exports = (supabase, authenticateToken) => {
  router.get("/google-config", (req, res) => {
    const clientId = process.env.GOOGLE_CLIENT_ID || "";
    res.set("Cache-Control", "no-store");
    res.json({ success: true, enabled: Boolean(clientId), clientId: clientId || null });
  });

  router.post("/google", async (req, res) => {
    try {
      const credential = req.body?.credential;
      if (typeof credential !== "string" || credential.length < 100) {
        return res.status(400).json({ success:false, message:"Google credential is missing" });
      }
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) {
        return res.status(503).json({ success:false, message:"Google sign-in is not configured on the server yet" });
      }

      const verifyResponse = await fetch(
        "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential),
        { signal: AbortSignal.timeout(10000) }
      );
      const claims = await verifyResponse.json();
      if (!verifyResponse.ok || claims.aud !== clientId || claims.email_verified !== "true" || !claims.sub || !claims.email) {
        return res.status(401).json({ success:false, message:"Google account verification failed" });
      }

      const email = String(claims.email).toLowerCase().trim();
      const { data:user, error } = await supabase.from("users").select(`
        id, client_id, name, email, role, status,
        clients (id, client_code, company_name, display_name, website)
      `).eq("email", email).maybeSingle();

      if (error) throw error;
      if (!user) {
        return res.status(403).json({ success:false, message:"This Google account is not registered in AQ Setu. Ask your administrator to create your portal account using this email." });
      }
      if (user.status !== "active") {
        return res.status(403).json({ success:false, message:"This account is inactive" });
      }

      const role = user.role === "client_admin" ? "admin" : user.role;
      const clientIdForToken = role === "admin" ? null : user.client_id;
      if (role !== "admin" && !clientIdForToken) {
        return res.status(403).json({ success:false, message:"This account is not assigned to a client" });
      }

      const token = jwt.sign(
        { userId:user.id, clientId:clientIdForToken, role },
        process.env.JWT_SECRET,
        { expiresIn:"8h", algorithm:"HS256" }
      );

      return res.json({
        success:true,
        message:"Google sign-in successful",
        token,
        user:{ id:user.id, name:user.name || claims.name || email, email:user.email, role, client:user.clients || null }
      });
    } catch(error) {
      // Log the network failure reason without logging the Google credential.
      console.error("Google sign-in error object:", error);
      console.error("Google sign-in error diagnostics:", {
        message: String(error),
        stack: error?.stack || null,
        causeString: error?.cause ? String(error.cause) : null,
        causeStack: error?.cause?.stack || null,
        causeCode: error?.cause?.code || null,
        causeName: error?.cause?.name || null,
        causeType: typeof error?.cause,
        ownProperties: error && Object.getOwnPropertyNames(error)
      });
      return res.status(502).json({ success:false, message:"The server could not verify your Google sign-in with Google. Please retry; if this continues, check the backend logs." });
    }
  });

  router.post("/login", async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ success:false, message:"Email and password are required" });

      const { data:user, error } = await supabase.from("users").select(`
        id, client_id, name, email, password_hash, role, status,
        clients (id, client_code, company_name, display_name, website)
      `).eq("email", email.toLowerCase().trim()).single();

      if (error || !user) return res.status(401).json({ success:false, message:"Invalid email or password" });
      if (user.status !== "active") return res.status(403).json({ success:false, message:"This account is inactive" });
      if (!user.password_hash) return res.status(401).json({ success:false, message:"Password has not been configured" });

      const passwordValid = await bcrypt.compare(password, user.password_hash);
      if (!passwordValid) return res.status(401).json({ success:false, message:"Invalid email or password" });

      const role = user.role === "client_admin" ? "admin" : user.role;
      const clientId = role === "admin" ? null : user.client_id;

      if (role !== "admin" && !clientId) {
        return res.status(403).json({ success:false, message:"This account is not assigned to a client" });
      }

      const token = jwt.sign(
        { userId:user.id, clientId, role },
        process.env.JWT_SECRET,
        { expiresIn:"8h", algorithm:"HS256" }
      );

      res.json({
        success:true,
        message:"Login successful",
        token,
        user:{ id:user.id, name:user.name, email:user.email, role, client:user.clients || null }
      });
    } catch(error) {
      console.error("Login error:", error);
      res.status(500).json({ success:false, message:"Server error" });
    }
  });

  router.patch("/profile", authenticateToken, async (req, res) => {
    try {
      const { name, email } = req.body;
      if (!name || !email) return res.status(400).json({ success:false, message:"Name and email are required" });

      const normalizedEmail = email.toLowerCase().trim();
      const { data:existing } = await supabase.from("users").select("id").eq("email", normalizedEmail).neq("id", req.user.userId).maybeSingle();
      if (existing) return res.status(409).json({ success:false, message:"That email is already in use" });

      const { data:user, error } = await supabase.from("users").update({
        name: name.trim(),
        email: normalizedEmail
      }).eq("id", req.user.userId).select("id,name,email,role").single();

      if (error) throw error;
      res.json({ success:true, user });
    } catch(error) {
      console.error("Profile update error:", error);
      res.status(500).json({ success:false, message:"Unable to update profile" });
    }
  });

  router.post("/password", authenticateToken, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      if (!currentPassword || !newPassword) return res.status(400).json({ success:false, message:"Current and new passwords are required" });
      if (newPassword.length < 8) return res.status(400).json({ success:false, message:"New password must be at least 8 characters" });

      const { data:user, error } = await supabase.from("users").select("password_hash").eq("id", req.user.userId).single();
      if (error || !user) return res.status(404).json({ success:false, message:"User not found" });

      const valid = await bcrypt.compare(currentPassword, user.password_hash || "");
      if (!valid) return res.status(401).json({ success:false, message:"Current password is incorrect" });

      const password_hash = await bcrypt.hash(newPassword, 12);
      const { error:updateError } = await supabase.from("users").update({ password_hash }).eq("id", req.user.userId);
      if (updateError) throw updateError;

      res.json({ success:true, message:"Password changed successfully" });
    } catch(error) {
      console.error("Password change error:", error);
      res.status(500).json({ success:false, message:"Unable to change password" });
    }
  });

  return router;
};