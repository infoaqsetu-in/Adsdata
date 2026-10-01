const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const router = express.Router();

module.exports = (supabase, authenticateToken) => {
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
        { expiresIn:"8h" }
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