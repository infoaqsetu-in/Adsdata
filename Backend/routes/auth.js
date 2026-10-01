const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const router = express.Router();

module.exports = (supabase) => {
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

  return router;
};