const crypto = require('crypto');
const db = require('../db');
const { validatePublicUrl } = require('../utils/ssrfValidator');
const { retryDelivery } = require('../services/webhook');

const VALID_EVENTS = ['payment.sent', 'payment.received', 'payment.failed'];

async function create(req, res, next) {
  try {
    const { url, events } = req.body;

    if (!await validatePublicUrl(url)) {
      return res.status(400).json({ error: 'Webhook URL must point to a public HTTPS endpoint' });
    }

    const invalidEvents = (events || []).filter((e) => !VALID_EVENTS.includes(e));
    if (invalidEvents.length) {
      return res.status(400).json({ error: `Invalid events: ${invalidEvents.join(', ')}` });
    }

    const secret = crypto.randomBytes(32).toString('hex');
    const { rows } = await db.query(
      `INSERT INTO webhooks (user_id, url, secret, events)
       VALUES ($1, $2, $3, $4)
       RETURNING id, url, events, active, created_at`,
      [req.user.userId, url, secret, events || []]
    );

    res.status(201).json({ ...rows[0], secret });
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, url, events, active, created_at FROM webhooks WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.userId]
    );
    res.json({ webhooks: rows });
  } catch (err) {
    next(err);
  }
}

async function listDeliveries(req, res, next) {
  try {
    const { webhook_id } = req.query;
    let query = `
      SELECT wd.id, wd.webhook_id, wd.event_type, wd.target_url, wd.status_code,
             wd.response_time_ms, wd.status, wd.attempt, wd.max_attempts, wd.error_message,
             wd.created_at, wd.completed_at
      FROM webhook_deliveries wd
      JOIN webhooks w ON w.id = wd.webhook_id
      WHERE w.user_id = $1
    `;
    const params = [req.user.userId];
    if (webhook_id) {
      params.push(webhook_id);
      query += ` AND wd.webhook_id = $${params.length}`;
    }
    query += ` ORDER BY wd.created_at DESC LIMIT 100`;
    const { rows } = await db.query(query, params);
    res.json({ deliveries: rows });
  } catch (err) {
    next(err);
  }
}

async function retry(req, res, next) {
  try {
    const { id } = req.params;
    // Verify ownership
    const { rows } = await db.query(
      `SELECT wd.id FROM webhook_deliveries wd
       JOIN webhooks w ON w.id = wd.webhook_id
       WHERE wd.id = $1 AND w.user_id = $2`,
      [id, req.user.userId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Delivery not found or not owned by user' });
    }
    await retryDelivery(id);
    res.json({ message: 'Retry initiated' });
  } catch (err) {
    next(err);
  }
}

module.exports = { create, list, listDeliveries, retry };
