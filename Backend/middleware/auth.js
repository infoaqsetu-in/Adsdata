const jwt = require("jsonwebtoken");

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Authentication required"
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    // Purpose-scoped tokens (e.g. the Meta OAuth state) are not login tokens.
    if (decoded.purpose || !decoded.clientId) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired token"
      });
    }

    req.user = decoded;

    next();
 } catch (error) {
    // Log only the error name (TokenExpiredError / JsonWebTokenError); never secrets.
    console.warn("JWT rejected:", error.name);

    return res.status(401).json({
      success: false,
      message: "Invalid or expired token"
    });
  }
}

module.exports = authenticateToken;
