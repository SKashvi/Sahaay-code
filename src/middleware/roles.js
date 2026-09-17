/* Two roles, not a permission system.
 *
 * 'operator' is the agency running the deployment. 'client' is the store
 * owner it was sold to. A client runs their own shop: products, orders,
 * returns, branding, offers, conversations. An operator additionally sees
 * the things that are about the SYSTEM rather than the shop, and is the only
 * role that can create accounts.
 *
 * Deliberately not a capabilities table. Two roles that a human can hold in
 * their head are safer than a flexible scheme nobody audits.
 */

function requireOperator(req, res, next) {
  if (!req.admin) return res.status(401).json({ error: 'Not signed in' });
  if (req.admin.role !== 'operator') {
    return res.status(403).json({ error: 'This area is limited to the operator account.' });
  }
  next();
}

module.exports = { requireOperator };
