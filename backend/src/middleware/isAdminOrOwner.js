module.exports = function isAdminOrOwner(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  // Admins have unrestricted access; authenticated users are owners of their own resources.
  // Controllers enforce ownership scope via req.user.userId.
  if (req.user.role === 'admin' || req.user.userId) {
    return next();
  }
  return res.status(403).json({ error: 'Forbidden: admin or account owner required' });
};
