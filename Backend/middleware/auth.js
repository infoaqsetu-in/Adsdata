const jwt = require("jsonwebtoken");

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success:false, message:"Authentication required" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

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
