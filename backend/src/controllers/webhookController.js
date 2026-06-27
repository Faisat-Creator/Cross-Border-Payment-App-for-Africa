const crypto = require('crypto');
const db = require('../db');
const { validatePublicUrl } = require('../utils/ssrfValidator');
const { encryptSecret, decryptSecret } = require('../utils/symmetricEncryption');

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

    const plainSecret = crypto.randomBytes(32).toString('hex');
    const encryptedSecret = encryptSecret(plainSecret);

    const { rows } = await db.query(
      `INSERT INTO webhooks (user_id, url, secret, events)
       VALUES ($1, $2, $3, $4)
       RETURNING id, url, events, active, created_at`,
      [req.user.userId, url, encryptedSecret, events || []]
    );

    // Return the plain secret once — it will not be shown again
    res.status(201).json({ ...rows[0], secret: plainSecret });
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, url, events, active, created_at, secret FROM webhooks WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.userId]
    );

    const webhooks = rows.map((wh) => {
      let secretMasked = null;
      if (wh.secret) {
        try {
          const plain = decryptSecret(wh.secret);
          secretMasked = plain.slice(0, 4) + '****';
        } catch {
          secretMasked = '****';
        }
      }
      const { secret: _omit, ...rest } = wh;
      return { ...rest, secret_masked: secretMasked };
    });

    res.json({ webhooks });
  } catch (err) {
    next(err);
  }
}

module.exports = { create, list };
