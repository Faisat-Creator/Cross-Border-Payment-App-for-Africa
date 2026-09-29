const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const StellarSdk = require('@stellar/stellar-sdk');

async function create(req, res, next) {
  try {
    const { recipient_wallet, amount, asset = 'XLM', frequency, memo, execute_at } = req.body;
    const userId = req.user.userId;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than 0' });
    }
    if (!['daily', 'weekly', 'monthly'].includes(frequency)) {
      return res.status(400).json({ error: 'Invalid frequency' });
    }
    if (!recipient_wallet || !StellarSdk.StrKey.isValidEd25519PublicKey(recipient_wallet)) {
      return res.status(400).json({ error: 'Invalid recipient wallet address' });
    }

    const id = uuidv4();
    const executeAt = new Date(execute_at);
    if (Number.isNaN(executeAt.getTime())) {
      return res.status(400).json({ error: 'execute_at must be a valid timestamp' });
    }

    // BE-126: the job reads `run_at` and `status`. We write those authoritative
    // columns and keep the legacy `next_run_at`/`active` columns in sync where
    // they exist, so the list view and the job agree.
    const insert = `
      INSERT INTO scheduled_payments (id, user_id, recipient_wallet, amount, asset, frequency, run_at, status, memo)
      VALUES ($1, $2, $3, $4, $5, $4, $6, 'pending', $7)
    `;
    try {
      await db.query(insert, [id, userId, recipient_wallet, amount, asset, executeAt, memo || null]);
    } catch (err) {
      // Fall back to the legacy schema if BE-126 migration hasn't landed yet.
      if (err.code !== '42703' && err.code !== '42704') throw err;
      await db.query(
        `INSERT INTO scheduled_payments (id, user_id, recipient_wallet, amount, asset, frequency, next_run_at, memo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, userId, recipient_wallet, amount, asset, frequency, executeAt, memo || null]
      );
    }

    res.json({ id, message: 'Scheduled payment created' });
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    const userId = req.user.userId;

    // BE-126: `run_at` is the job's authoritative next-run field. We expose it
    // as `next_run_at` for the UI while also returning the raw columns.
    const result = await db.query(
      `SELECT id, recipient_wallet, amount, asset, frequency,
              COALESCE(next_run_at, run_at) AS next_run_at,
              COALESCE(active, status = 'pending') AS active,
              last_run_at, failed_attempts
       FROM scheduled_payments
       WHERE user_id = $1
       ORDER BY COALESCE(next_run_at, run_at) ASC`,
      [userId]
    );

    res.json({ payments: result.rows });
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const { amount, frequency, active, recipient_wallet } = req.body;
    const userId = req.user.userId;

    if (frequency !== undefined && frequency !== null && !['daily', 'weekly', 'monthly'].includes(frequency)) {
      return res.status(400).json({ error: 'Invalid frequency' });
    }
    if (recipient_wallet !== undefined && recipient_wallet !== null && !StellarSdk.StrKey.isValidEd25519PublicKey(recipient_wallet)) {
      return res.status(400).json({ error: 'Invalid recipient wallet address' });
    }

    const result = await db.query(
      `UPDATE scheduled_payments
       SET amount = COALESCE($1, amount),
           frequency = COALESCE($2, frequency),
           active = COALESCE($3, active),
           recipient_wallet = COALESCE($4, recipient_wallet)
       WHERE id = $5 AND user_id = $6`,
      [amount, frequency, active, recipient_wallet, id, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Scheduled payment not found' });
    }

    res.json({ message: 'Scheduled payment updated' });
  } catch (err) {
    next(err);
  }
}

async function delete_(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const result = await db.query(
      `DELETE FROM scheduled_payments WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Scheduled payment not found' });
    }

    res.json({ message: 'Scheduled payment deleted' });
  } catch (err) {
    next(err);
  }
}

module.exports = { create, list, update, delete: delete_ };
