function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to access this resource"
      });
    }
    next();
  };
}

function requireClient(req, res, next) {
  if (!req.user || !req.user.clientId) {
    return res.status(403).json({
      success: false,
      message: "A client account is required for this resource"
    });
  }
  next();
}

module.exports = { requireRole, requireClient };
