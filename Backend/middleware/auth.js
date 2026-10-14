const jwt = require("jsonwebtoken");

function normalizeRole(role) {
  return ["client_admin", "client_user"].includes(role) ? "client" : role;
}

module.exports = function createAuthenticateToken(supabase) {
  return async function authenticateToken(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const token = authHeader.split(" ")[1];
    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret) {
      console.error("Authentication unavailable: JWT_SECRET is not configured");
      return res.status(503).json({ success: false, message: "Authentication is temporarily unavailable" });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, jwtSecret, { algorithms: ["HS256"] });
    } catch (error) {
      console.warn("JWT rejected:", error.name);
      return res.status(401).json({ success: false, message: "Invalid or expired token" });
    }

    if (decoded.purpose || !decoded.userId || !decoded.role) {
      return res.status(401).json({ success: false, message: "Invalid or expired token" });
    }

    // Re-check the account on each authenticated request. This immediately
    // applies role changes, disabled accounts, and deleted users to existing JWTs.
    try {
      const { data: account, error } = await supabase
        .from("users")
        .select("id, client_id, role, status")
        .eq("id", decoded.userId)
        .maybeSingle();

      if (error) {
        console.error("Authentication account lookup failed:", error.code || "database_error");
        return res.status(503).json({ success: false, message: "Authentication is temporarily unavailable" });
      }
      if (!account || account.status !== "active") {
        return res.status(401).json({ success: false, message: "Invalid or inactive account" });
      }

      const role = normalizeRole(account.role);
      const clientId = role === "admin" ? null : account.client_id;
      if (!["admin", "client"].includes(role) || (role !== "admin" && !clientId)) {
        return res.status(403).json({ success: false, message: "This account is not assigned a valid portal role" });
      }

      // Reject stale tokens if a user's role or client assignment changed.
      if (decoded.role !== role || String(decoded.clientId || "") !== String(clientId || "")) {
        return res.status(401).json({ success: false, message: "Your account permissions changed. Please sign in again." });
      }

      req.user = { ...decoded, role, clientId };
      return next();
    } catch (error) {
      console.error("Authentication account lookup failed:", error?.code || error?.name || "Error");
      return res.status(503).json({ success: false, message: "Authentication is temporarily unavailable" });
    }
  };
};
