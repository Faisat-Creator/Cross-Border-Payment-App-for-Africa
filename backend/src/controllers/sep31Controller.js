const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

const ANCHOR_INFO_TTL = 5 * 60; // 5 minutes in seconds
const anchorUrl = process.env.ANCHOR_URL || 'https://testanchor.stellar.org';

/**
 * Fetch the anchor's SEP-31 /info endpoint and cache for 5 minutes.
 * Returns the parsed JSON response.
 */
async function fetchAnchorInfo(assetCode) {
  const cacheKey = `sep31:anchor_info:${anchorUrl}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const response = await fetch(`${anchorUrl}/sep31/info`);
  if (!response.ok) {
    throw new Error(`Anchor /info returned ${response.status}`);
  }
  const data = await response.json();
  await cache.set(cacheKey, data, ANCHOR_INFO_TTL);
  return data;
}

/**
 * Get required fields for a given asset from the anchor /info response.
 * Returns an array of required field names.
 */
function getRequiredFields(anchorInfo, assetCode) {
  const assetInfo = anchorInfo?.receive?.[assetCode];
  if (!assetInfo) return [];
  const fields = assetInfo.fields || {};
  return Object.entries(fields)
    .filter(([, meta]) => !meta.optional)
    .map(([name]) => name);
}

/**
 * GET /api/sep31/info
 *
 * Returns the supported assets and required SEP-12 fields for cross-border
 * payments. Conforms to the SEP-31 /info response schema.
 */
async function getInfo(req, res, next) {
  try {
    res.json({
      receive: {
        USDC: {
          enabled: true,
          min_amount: parseFloat(process.env.SEP31_MIN_AMOUNT || '1'),
          max_amount: parseFloat(process.env.SEP31_MAX_AMOUNT || '10000'),
          fee_fixed: parseFloat(process.env.SEP31_FEE_FIXED || '0.5'),
          fee_percent: parseFloat(process.env.SEP31_FEE_PERCENT || '0'),
          sep12: {
            sender: {
              types: {
                'sep31-sender': {
                  description: 'Sender of a cross-border USDC payment'
                }
              }
            },
            receiver: {
              types: {
                'sep31-receiver': {
                  description: 'Receiver of a cross-border USDC payment'
                }
              }
            }
          },
          fields: {
            transaction: {
              receiver_routing_number: {
                description: 'Routing number of the receiver\'s bank account',
                optional: true
              },
              receiver_account_number: {
                description: 'Bank account number of the receiver',
                optional: true
              },
              type: {
                description: 'Type of payment (e.g. SWIFT, ACH, mobile_money)',
                choices: ['SWIFT', 'ACH', 'mobile_money'],
                optional: true
              }
            }
          }
        },
        XLM: {
          enabled: true,
          min_amount: parseFloat(process.env.SEP31_XLM_MIN_AMOUNT || '1'),
          max_amount: parseFloat(process.env.SEP31_XLM_MAX_AMOUNT || '50000'),
          fee_fixed: parseFloat(process.env.SEP31_XLM_FEE_FIXED || '0'),
          fee_percent: parseFloat(process.env.SEP31_XLM_FEE_PERCENT || '0'),
          sep12: {
            sender: {
              types: {
                'sep31-sender': {
                  description: 'Sender of a cross-border XLM payment'
                }
              }
            },
            receiver: {
              types: {
                'sep31-receiver': {
                  description: 'Receiver of a cross-border XLM payment'
                }
              }
            }
          },
          fields: {
            transaction: {}
          }
        }
      }
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/sep31/transactions
 *
 * Initiates a new SEP-31 cross-border payment transaction.
 * Validates required fields against the anchor's /info schema when reachable.
 */
async function createTransaction(req, res, next) {
  try {
    const {
      amount,
      asset_code = 'USDC',
      receiver_account,
      fields = {},
      sender_name,
      sender_email
    } = req.body;
    const userId = req.user.userId;

    // Validate fields against anchor /info schema
    let requiredFields = [];
    try {
      const anchorInfo = await fetchAnchorInfo(asset_code);
      requiredFields = getRequiredFields(anchorInfo, asset_code);
    } catch (err) {
      logger.warn('Could not fetch anchor /info for field validation', { error: err.message });
      // Proceed without remote validation if anchor is unreachable
    }

    if (requiredFields.length > 0) {
      const missing = requiredFields.filter((f) => !fields[f]);
      if (missing.length > 0) {
        return res.status(400).json({ error: 'Missing required fields', missing_fields: missing });
      }
    }

    // Check KYC status
    const user = await db.query('SELECT kyc_status FROM users WHERE id = $1', [userId]);
    const kycVerified = user.rows[0]?.kyc_status === 'verified';

    const txId = uuidv4();
    await db.query(
      `INSERT INTO sep31_transactions
         (id, sender_id, receiver_account, amount, asset_code, kyc_verified, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [txId, userId, receiver_account, amount, asset_code, kycVerified]
    );

    logger.info('SEP-31 transaction created', {
      txId,
      userId,
      asset_code,
      amount,
      kyc_verified: kycVerified
    });

    res.status(201).json({
      id: txId,
      status: 'pending',
      amount: parseFloat(amount),
      asset_code,
      receiver_account,
      kyc_verified: kycVerified,
      sender_name: sender_name || null,
      sender_email: sender_email || null
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/sep31/transactions/:id
 *
 * Returns the current status and details of a SEP-31 transaction.
 * Only the transaction's sender may retrieve it.
 */
async function getTransaction(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const result = await db.query(
      `SELECT id, status, amount, asset_code, receiver_account, kyc_verified, created_at, updated_at
       FROM sep31_transactions
       WHERE id = $1 AND sender_id = $2`,
      [id, userId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getInfo,
  createTransaction,
  getTransaction,
  fetchAnchorInfo,
  getRequiredFields,
};
