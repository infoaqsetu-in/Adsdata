const jwt = require("jsonwebtoken");

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success:false, message:"Authentication required" });
  }

  const token = authHeader.split(" ")[1];
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    console.error("Authentication unavailable: JWT_SECRET is not configured");
    return res.status(503).json({ success:false, message:"Authentication is temporarily unavailable" });
  }

  try {
    const decoded = jwt.verify(token, jwtSecret, { algorithms:["HS256"] });

    if (decoded.purpose || !decoded.userId || !decoded.role || (decoded.role !== "admin" && !decoded.clientId)) {
      return res.status(401).json({ success:false, message:"Invalid or expired token" });
    }

    req.user = decoded;
    next();
  } catch (error) {
    console.warn("JWT rejected:", error.name);
    return res.status(401).json({ success:false, message:"Invalid or expired token" });
  }
}

module.exports = authenticateToken;
