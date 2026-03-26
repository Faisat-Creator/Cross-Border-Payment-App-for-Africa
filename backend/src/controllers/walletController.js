const bcrypt = require('bcryptjs');
const db = require('../db');
const { getBalance, getTransactions, decryptPrivateKey } = require('../services/stellar');
const QRCode = require('qrcode');
const cache = require('../utils/cache');

async function getWallet(req, res, next) {
  try {
    const result = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1',
      [req.user.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Wallet not found' });

    const { public_key } = result.rows[0];
    const cacheKey = `balance:${public_key}`;

    // Try cache first
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json({ public_key, balances: cached, cached: true });
    }

    // Cache miss — hit Horizon
    const balances = await getBalance(public_key);
    await cache.set(cacheKey, balances, cache.BALANCE_TTL);

    res.json({ public_key, balances, cached: false });
  } catch (err) {
    next(err);
  }
}

async function getQRCode(req, res, next) {
  try {
    const result = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1',
      [req.user.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Wallet not found' });

    const qrDataUrl = await QRCode.toDataURL(result.rows[0].public_key);
    res.json({ qr_code: qrDataUrl, public_key: result.rows[0].public_key });
  } catch (err) {
    next(err);
  }
}

async function getWalletTransactions(req, res, next) {
  try {
    const result = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1',
      [req.user.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Wallet not found' });

    // Get from local DB first
    const txResult = await db.query(
      `SELECT * FROM transactions
       WHERE sender_wallet = $1 OR recipient_wallet = $1
       ORDER BY created_at DESC LIMIT 50`,
      [result.rows[0].public_key]
    );

    res.json({ transactions: txResult.rows });
  } catch (err) {
    next(err);
  }
}

async function exportKey(req, res, next) {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password is required' });

    const userResult = await db.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(password, userResult.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    const walletResult = await db.query(
      'SELECT encrypted_secret_key FROM wallets WHERE user_id = $1',
      [req.user.userId]
    );
    if (!walletResult.rows[0]) return res.status(404).json({ error: 'Wallet not found' });

    const secretKey = decryptPrivateKey(walletResult.rows[0].encrypted_secret_key);
    res.json({ secret_key: secretKey });
  } catch (err) {
    next(err);
  }
}

module.exports = { getWallet, getQRCode, getWalletTransactions, exportKey };
