const { verifyToken } = require('../lib/auth');

function requireAdmin(req, res, next) {
  const token = req.cookies && req.cookies.admin_session;
  if (!token) {
    return res.status(401).json({ error: 'Not signed in' });
  }
  try {
    const payload = verifyToken(token);
    if (payload.role !== 'admin') throw new Error('wrong role');
    req.admin = { ...payload, role: payload.adminRole || 'operator' };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired or invalid, please sign in again' });
  }
}

module.exports = { requireAdmin };
