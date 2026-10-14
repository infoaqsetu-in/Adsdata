const express = require("express");
const cors = require("cors");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const createAuthenticateToken = require("./middleware/auth");

require("dotenv").config({
  path: path.join(__dirname, ".env")
});
console.log(
  "JWT_SECRET loaded:",
  !!process.env.JWT_SECRET
);

const app = express();
const PORT = process.env.PORT || 5000;

// ======================================================
// Supabase
// ======================================================

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const authenticateToken = createAuthenticateToken(supabase);

// ======================================================
// Middleware
// ======================================================

// Restrict cross-origin API access. Same-origin portal requests do not need CORS;
// add any approved custom frontend origins to CORS_ORIGINS (comma-separated) in Hostinger.
const allowedOrigins = new Set([
  "https://darkgray-beaver-562547.hostingersite.com",
  "http://localhost:5000",
  "http://localhost:3000",
  "http://127.0.0.1:5000",
  ...(process.env.CORS_ORIGINS || "").split(",").map(origin => origin.trim()).filter(Boolean)
]);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by CORS"));
  },
  credentials: false
}));
// CSV rows are sent as JSON during admin imports (up to 1,000 rows / 5 MB file).
app.use(express.json({ limit: "8mb" }));

// Serve frontend from aqsetu_app folder
// Only the two public frontend files are served. (Serving the whole app folder
// exposed Backend/*.js source and package.json.)
app.get("/logo.jpg", (req, res) =>
  res.sendFile(path.join(__dirname, "..", "logo.jpg"))
);

// ======================================================
// Authentication Routes
// ======================================================

const authRoutes = require("./routes/auth");

app.use("/api/auth", authRoutes(supabase, authenticateToken));
const campaignRoutes = require("./routes/campaigns");
const leadRoutes = require("./routes/leads");
const dashboardRoutes = require("./routes/dashboard");
const metaRoutes = require("./routes/meta");
const adminRoutes = require("./routes/admin");
const socialRoutes = require("./routes/social");
const seoRoutes = require("./routes/seo");
const googleAdsRoutes = require("./routes/google-ads");


app.use(
  "/api/dashboard",
  dashboardRoutes(supabase, authenticateToken)
);

app.use(
  "/api/campaigns",
  campaignRoutes(supabase, authenticateToken)
);

app.use(
  "/api/leads",
  leadRoutes(supabase, authenticateToken)
);
app.use(
  "/api/meta",
  metaRoutes(supabase, authenticateToken)
);
app.use(
  "/api/admin",
  adminRoutes(supabase, authenticateToken)
);
app.use("/api/social-posts", socialRoutes(supabase, authenticateToken));
app.use("/api/seo", seoRoutes(supabase, authenticateToken));
app.use("/api/google-ads", googleAdsRoutes(supabase, authenticateToken));
// ======================================================
// Health Check
// ======================================================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "AQ Setu Backend is running",
    version: "1.0.0"
  });
});

// ======================================================
// Get Logged-in Client
// ======================================================

app.get(
  "/api/clients",
  authenticateToken,
  async (req, res) => {

    try {

      const { data, error } = await supabase
        .from("clients")
        .select("*")
        .eq("id", req.user.clientId)
        .single();

      if (error) {

        console.error(
          "Supabase error:",
          error
        );

        return res.status(404).json({
          success: false,
          message: "Client not found"
        });

      }

      res.json({
        success: true,
        client: data
      });

    } catch (error) {

      console.error(
        "Server error:",
        error
      );

      res.status(500).json({
        success: false,
        message: "Server error"
      });

    }

  }
);

// ======================================================
// Frontend
// ======================================================

app.get("/", (req, res) => {

  res.sendFile(
    path.join(__dirname, "..", "index.html")
  );

});

// ======================================================
// Start Server
// ======================================================

app.listen(PORT, () => {

  console.log(
    `AQ Setu Backend running on http://localhost:${PORT}`
  );

});