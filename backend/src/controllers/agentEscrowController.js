/**
 * Agent Escrow Controller
 *
 * Handles trustless agent payout escrow via the Soroban agent-escrow contract.
 *
 * Routes:
 *   GET  /api/escrow                 — list escrows for the caller (sender|agent)
 *   POST /api/escrow/create          — sender creates escrow
 *   POST /api/escrow/:id/confirm     — agent confirms payout
 *   POST /api/escrow/:id/cancel      — sender cancels after 48 h
 *   GET  /api/escrow/:id             — fetch escrow record from DB
 */

const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { createEscrow, confirmPayout, cancelEscrow } = require("../services/agentEscrow");
const { enqueueEmail } = require("../services/email");
const audit = require("../services/audit");

const DEFAULT_FEE_BPS = parseInt(process.env.ESCROW_FEE_BPS || "250", 10);

// The agent-escrow contract only ever locks its configured USDC token, so any
// other client-supplied asset would diverge from on-chain state.
const ESCROW_ASSET = "USDC";

const ESCROW_STATUSES = ["pending", "completed", "cancelled"];
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Convert a decimal amount string to stroops (1e7 base units) without
 * floating-point error. Rejects non-decimal strings and more than 7 places.
 * Returns null when the input is not a valid amount.
 */
function amountToStroops(amount) {
  if (typeof amount !== "string") return null;
  const trimmed = amount.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) return null;

  const [whole, fraction = ""] = trimmed.split(".");
  const paddedFraction = (fraction + "0000000").slice(0, 7);
  const stroops = BigInt(whole) * 10000000n + BigInt(paddedFraction);
  if (stroops <= 0n) return null;
  return stroops;
}

/**
 * GET /api/escrow?role=sender|agent&status=…&page=1&limit=20
 *
 * Lists escrows scoped to the authenticated caller's wallets. `role=sender`
 * returns escrows the caller funded; `role=agent` returns escrows assigned to
 * the caller's agent wallet. Results are paginated.
 */
async function list(req, res, next) {
  try {
    const role = req.query.role === "agent" ? "agent" : "sender";
    const status = req.query.status;

    if (status && !ESCROW_STATUSES.includes(status)) {
      return res.status(400).json({ error: "Invalid status filter" });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE
    );
    const offset = (page - 1) * limit;

    // Resolve the caller's wallets so results stay scoped to their own escrows.
    const walletResult = await db.query(
      "SELECT public_key FROM wallets WHERE user_id = $1",
      [req.user.userId]
    );
    const walletAddresses = walletResult.rows.map((row) => row.public_key);

    if (walletAddresses.length === 0) {
      return res.json({ escrows: [], page, limit, total: 0 });
    }

    const column = role === "agent" ? "agent_wallet" : "sender_wallet";
    const params = [walletAddresses];
    let where = `WHERE ${column} = ANY($1)`;

    if (status) {
      params.push(status);
      where += ` AND status = $${params.length}`;
    }

    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total FROM agent_escrows ${where}`,
      params
    );
    const total = countResult.rows[0] ? countResult.rows[0].total : 0;

    params.push(limit, offset);
    const listResult = await db.query(
      `SELECT id, contract_escrow_id, sender_wallet, recipient_wallet, agent_wallet,
              amount, asset, fee_bps, status, tx_hash, confirm_tx_hash,
              created_at, confirmed_at
         FROM agent_escrows
         ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ escrows: listResult.rows, page, limit, total });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/escrow/create
 * Body: { agent_wallet, recipient_wallet, amount, asset }
 */
async function create(req, res, next) {
  const escrowDbId = uuidv4();
  try {
    const { agent_wallet, recipient_wallet, amount, asset = ESCROW_ASSET } = req.body;

    // The contract only locks its configured USDC token; reject anything else
    // so the DB record cannot diverge from on-chain state.
    if (asset !== ESCROW_ASSET) {
      return res.status(400).json({
        error: `Unsupported asset. Only ${ESCROW_ASSET} is accepted.`,
        code: "UNSUPPORTED_ASSET",
      });
    }

    // Validate the amount as a decimal string with at most 7 places and convert
    // to stroops without floating-point error.
    const amountStroops = amountToStroops(amount);
    if (amountStroops === null) {
      return res.status(400).json({
        error: "Invalid amount. Provide a positive decimal string with at most 7 decimal places.",
        code: "INVALID_AMOUNT",
      });
    }

    // Validate that the agent is a registered, approved AfriPay agent
    const agentResult = await db.query(
      "SELECT id FROM agents WHERE wallet_address = $1 AND status = 'approved'",
      [agent_wallet]
    );
    if (!agentResult.rows[0]) {
      return res.status(400).json({ error: "Agent is not registered in the AfriPay network" });
    }

    const walletResult = await db.query(
      "SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1",
      [req.user.userId]
    );
    if (!walletResult.rows[0]) {
      return res.status(404).json({ error: "Wallet not found" });
    }
    const { public_key, encrypted_secret_key } = walletResult.rows[0];

    // Issue #1156: Apply compliance checks to escrow creation (value-moving endpoint)
    const { ensureKycIfNeeded, amlRescreenForPayment, dailyLimitExceeded, checkFraud, logFraudBlock } = require("./paymentController");
    const { estimateUSDValue } = require("./paymentController");
    
    await ensureKycIfNeeded(req.user.userId, amount, asset);
    
    const estimatedUSD = estimateUSDValue(amount, asset);
    await amlRescreenForPayment(req.user.userId, public_key, estimatedUSD);
    
    const overLimit = await dailyLimitExceeded(public_key, amount);
    if (overLimit) {
      return res.status(400).json({
        error: 'Daily send limit reached. Try again tomorrow.',
        code: 'DAILY_LIMIT_EXCEEDED',
      });
    }
    
    const fraudCheck = await checkFraud(public_key, amount, asset);
    if (fraudCheck.blocked) {
      await logFraudBlock(public_key, fraudCheck.reason, amount, asset);
      return res.status(429).json({ error: fraudCheck.reason });
    }

    const { escrowId, txHash } = await createEscrow({
      encryptedSecretKey: encrypted_secret_key,
      recipient: recipient_wallet,
      agent: agent_wallet,
      amount: amountStroops.toString(), // stroops, converted without float error
      feeBps: DEFAULT_FEE_BPS,
    });

    await db.query(
      `INSERT INTO agent_escrows
         (id, contract_escrow_id, sender_wallet, recipient_wallet, agent_wallet,
          amount, asset, fee_bps, status, tx_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)`,
      [
        escrowDbId,
        escrowId,
        public_key,
        recipient_wallet,
        agent_wallet,
        amount,
        asset,
        DEFAULT_FEE_BPS,
        txHash,
      ]
    );

    res.status(201).json({
      message: "Escrow created",
      escrow: { id: escrowDbId, contract_escrow_id: escrowId, tx_hash: txHash, status: "pending" },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/agent-escrow/:id/confirm-payout
 * Agent confirms off-chain fiat delivery. Requires role: 'agent'.
 */
async function confirm(req, res, next) {
  try {
    if (req.user.role !== "agent") {
      return res.status(403).json({ error: "Only agents can confirm payouts" });
    }

    const { id } = req.params;

    const escrowResult = await db.query(
      "SELECT * FROM agent_escrows WHERE id = $1",
      [id]
    );
    if (!escrowResult.rows[0]) {
      return res.status(404).json({ error: "Escrow not found" });
    }
    const escrow = escrowResult.rows[0];

    if (escrow.status !== "pending") {
      return res.status(400).json({ error: "Escrow is not pending" });
    }

    // Verify the authenticated agent is the assigned agent for this escrow
    const agentWalletResult = await db.query(
      "SELECT public_key FROM wallets WHERE user_id = $1",
      [req.user.userId]
    );
    if (!agentWalletResult.rows[0] || agentWalletResult.rows[0].public_key !== escrow.agent_wallet) {
      return res.status(403).json({ error: "You are not the assigned agent for this escrow" });
    }

    // Fetch the service account key — the backend signs the on-chain tx
    const walletResult = await db.query(
      "SELECT encrypted_secret_key FROM wallets WHERE public_key = $1",
      [escrow.agent_wallet]
    );
    if (!walletResult.rows[0]) {
      return res.status(403).json({ error: "Agent wallet not registered on this platform" });
    }

    // Call Soroban confirm_payout — only update DB if this succeeds
    let txHash;
    try {
      ({ txHash } = await confirmPayout({
        encryptedSecretKey: walletResult.rows[0].encrypted_secret_key,
        escrowId: escrow.contract_escrow_id,
      }));
    } catch (stellarErr) {
      return res.status(502).json({ error: "On-chain confirmation failed", detail: stellarErr.message });
    }

    await db.query(
      "UPDATE agent_escrows SET status = 'completed', confirm_tx_hash = $1, confirmed_at = NOW() WHERE id = $2",
      [txHash, id]

/* … truncated 4758 chars — edit only what you need near the top … */
