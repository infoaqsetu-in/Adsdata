const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const router = express.Router();

module.exports = (supabase) => {

  // Login
  router.post("/login", async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({
          success: false,
          message: "Email and password are required"
        });
      }

      const { data: user, error } = await supabase
        .from("users")
        .select(`
          id,
          client_id,
          name,
          email,
          password_hash,
          role,
          status,
          clients (
            id,
            client_code,
            company_name,
            display_name,
            website
          )
        `)
        .eq("email", email.toLowerCase().trim())
        .single();

      if (error || !user) {
        return res.status(401).json({
          success: false,
          message: "Invalid email or password"
        });
      }

      if (user.status !== "active") {
        return res.status(403).json({
          success: false,
          message: "This account is inactive"
        });
      }

      if (!user.password_hash) {
        return res.status(401).json({
          success: false,
          message: "Password has not been configured"
        });
      }

      const passwordValid = await bcrypt.compare(
        password,
        user.password_hash
      );

      if (!passwordValid) {
        return res.status(401).json({
          success: false,
          message: "Invalid email or password"
        });
      }

      const token = jwt.sign(
        {
          userId: user.id,
          clientId: user.client_id,
          role: user.role
        },
        process.env.JWT_SECRET,
        {
          expiresIn: "8h"
        }
      );

      res.json({
        success: true,
        message: "Login successful",
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          client: user.clients
        }
      });

    } catch (error) {
      console.error("Login error:", error);

      res.status(500).json({
        success: false,
        message: "Server error"
      });
    }
  });

  return router;
};