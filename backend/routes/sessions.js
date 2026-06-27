import express from 'express';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

/**
 * GET /api/auth/sessions
 * Returns all active sessions for the authenticated user (metadata only — no token hashes).
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    // TODO: replace with your DB query, e.g.:
    // const sessions = await Session.findAll({
    //   where: { userId, revokedAt: null },
    //   attributes: ['id', 'device', 'ipAddress', 'lastActiveAt', 'createdAt'],
    // });
    res.json({ sessions: [] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve sessions' });
  }
});

/**
 * DELETE /api/auth/sessions/:id
 * Revoke a specific session. User may only revoke their own sessions.
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    // TODO: validate ownership + set revokedAt, e.g.:
    // const session = await Session.findOne({ where: { id, userId } });
    // if (!session) return res.status(404).json({ error: 'Session not found' });
    // await session.update({ revokedAt: new Date() });
    res.json({ success: true, message: `Session ${id} revoked` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to revoke session' });
  }
});

/**
 * DELETE /api/auth/sessions?except=current
 * Revoke all sessions except the caller's current one.
 */
router.delete('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const currentSessionId = req.user.sessionId;
    // TODO: bulk revoke, e.g.:
    // await Session.update(
    //   { revokedAt: new Date() },
    //   { where: { userId, id: { [Op.ne]: currentSessionId }, revokedAt: null } }
    // );
    res.json({ success: true, message: 'All other sessions revoked' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to revoke sessions' });
  }
});

export default router;
