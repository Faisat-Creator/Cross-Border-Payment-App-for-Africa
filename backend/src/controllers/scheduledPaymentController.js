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

    // BE-126: the active scheduled-payments job reads the authoritative
    // `run_at` / `status` columns. Persist the user-supplied first execution
    // time into `run_at` so the job actually fires when the user expects.
    const id = uuidv4();
    const runAt = new Date(execute_at);

    // The job requires a sender wallet to sign the payment. Resolve the
    // user's primary wallet from the wallets table.
    const walletResult = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1',
      [userId]
    );
    const senderWallet = walletResult.rows[0]?.public_key;
    if (!senderWallet) {
      return res.status(400).json({ error: 'No wallet found for user' });
    }

    await db.query(
      `INSERT INTO scheduled_payments
         (id, user_id, sender_wallet, recipient_wallet, amount, asset, frequency, run_at, memo, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')`,
      [id, userId, senderWallet, recipient_wallet, amount, asset, frequency, runAt, memo || null]
    );

    res.json({ id, message: 'Scheduled payment created' });
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    const userId = req.user.userId;

    // BE-126: expose the job's authoritative fields (run_at/status) and
    // alias them to the legacy next_run_at/active names the UI expected,
    // so displayed state matches what the job will actually do.
    const result = await db.query(
      `SELECT id, recipient_wallet, amount, asset, frequency,
              run_at AS next_run_at,
              (status = 'pending') AS active,
              status,
              run_at,
              last_error,
              created_at, updated_at
       FROM scheduled_payments
       WHERE user_id = $1
       ORDER BY run_at ASC`,
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
    const { amount, frequency, active, recipient_wallet, execute_at } = req.body;
    const userId = req.user.userId;

    if (frequency !== undefined && frequency !== null && !['daily', 'weekly', 'monthly'].includes(frequency)) {
      return res.status(400).json({ error: 'Invalid frequency' });
    }
    if (recipient_wallet !== undefined && recipient_wallet !== null && !StellarSdk.StrKey.isValidEd25519PublicKey(recipient_wallet)) {
      return res.status(400).json({ error: 'Invalid recipient wallet address' });
    }

    // Map the legacy `active` boolean onto the job's `status` column.
    const newStatus = active === undefined || active === null
      ? null
      : (active ? 'pending' : 'cancelled');

    const result = await db.query(
      `UPDATE scheduled_payments
       SET amount = COALESCE($1, amount),
           frequency = COALESCE($2, frequency),
           status = COALESCE($3, status),
           recipient_wallet = COALESCE($4, recipient_wallet),
           run_at = COALESCE($5, run_at),
           updated_at = NOW()
       WHERE id = $6 AND user_id = $7`,
      [amount, frequency, newStatus, recipient_wallet, execute_at ? new Date(execute_at) : null, id, userId]
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
