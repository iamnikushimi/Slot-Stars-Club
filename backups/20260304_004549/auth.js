const db = require('../db');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  // Re-sync role from DB if missing (happens after server restart)
  if (!req.session.role) {
    try {
      const user = db.prepare('SELECT role FROM users WHERE id=?').get(req.session.userId);
      if (user) req.session.role = user.role;
    } catch(e) {}
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    // Re-sync role from DB if missing (happens after server restart)
    if (!req.session.role) {
      try {
        const user = db.prepare('SELECT role FROM users WHERE id=?').get(req.session.userId);
        if (user) req.session.role = user.role;
      } catch(e) {}
    }
    if (!roles.includes(req.session.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

module.exports = { requireAuth, requireRole };
