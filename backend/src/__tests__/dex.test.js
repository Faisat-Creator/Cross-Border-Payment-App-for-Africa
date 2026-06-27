const request = require('supertest');
const express = require('express');

jest.mock('../db');
jest.mock('../middleware/auth', () => (req, res, next) => {
  req.user = { userId: 'user-123' };
  next();
});
jest.mock('../services/dex');

const db = require('../db');
const dex = require('../services/dex');
const dexRouter = require('../routes/dex');

const app = express();
app.use(express.json());
app.use('/dex', dexRouter);
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

const WALLET = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// GET /dex/orderbook
// ---------------------------------------------------------------------------
describe('GET /dex/orderbook', () => {
  test('returns orderbook data for valid asset pair', async () => {
    dex.getOrderbook.mockResolvedValue({ bids: [], asks: [], midPrice: 1.5 });

    const res = await request(app).get('/dex/orderbook?selling=XLM&buying=USDC');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bids: [], asks: [], midPrice: 1.5 });
    expect(dex.getOrderbook).toHaveBeenCalledWith('XLM', 'USDC');
  });

  test('returns 400 when selling param is missing', async () => {
    const res = await request(app).get('/dex/orderbook?buying=USDC');
    expect(res.status).toBe(400);
  });

  test('returns 400 when buying param is missing', async () => {
    const res = await request(app).get('/dex/orderbook?selling=XLM');
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid asset code with special characters', async () => {
    const res = await request(app).get('/dex/orderbook?selling=XL%24&buying=USDC');
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /dex/swap
// ---------------------------------------------------------------------------
describe('POST /dex/swap', () => {
  const validBody = { sell_asset: 'XLM', sell_amount: 100, buy_asset: 'USDC' };

  test('returns swap result for valid input', async () => {
    db.query.mockResolvedValue({ rows: [{ public_key: WALLET, encrypted_secret_key: 'enc' }] });
    dex.executeSwap.mockResolvedValue({ transactionHash: 'abc123', soldAmount: 100 });

    const res = await request(app).post('/dex/swap').send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.transactionHash).toBe('abc123');
    expect(dex.executeSwap).toHaveBeenCalledWith(expect.objectContaining({
      publicKey: WALLET,
      sellAsset: 'XLM',
      sellAmount: 100,
      buyAsset: 'USDC',
    }));
  });

  test('passes slippage_pct to executeSwap when provided', async () => {
    db.query.mockResolvedValue({ rows: [{ public_key: WALLET, encrypted_secret_key: 'enc' }] });
    dex.executeSwap.mockResolvedValue({ transactionHash: 'def456' });

    await request(app).post('/dex/swap').send({ ...validBody, slippage_pct: 2.5 });

    expect(dex.executeSwap).toHaveBeenCalledWith(expect.objectContaining({ slippagePct: 2.5 }));
  });

  test('returns 400 when sell_amount is zero', async () => {
    const res = await request(app).post('/dex/swap').send({ ...validBody, sell_amount: 0 });
    expect(res.status).toBe(400);
  });

  test('returns 400 when sell_amount is negative', async () => {
    const res = await request(app).post('/dex/swap').send({ ...validBody, sell_amount: -5 });
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid sell_asset', async () => {
    const res = await request(app).post('/dex/swap').send({ ...validBody, sell_asset: 'bad!' });
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid buy_asset', async () => {
    const res = await request(app).post('/dex/swap').send({ ...validBody, buy_asset: 'bad!' });
    expect(res.status).toBe(400);
  });

  test('returns 400 when slippage_pct exceeds 50', async () => {
    const res = await request(app).post('/dex/swap').send({ ...validBody, slippage_pct: 51 });
    expect(res.status).toBe(400);
  });

  test('returns 404 when wallet not found', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).post('/dex/swap').send(validBody);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Wallet not found');
  });
});

// ---------------------------------------------------------------------------
// GET /dex/trades
// ---------------------------------------------------------------------------
describe('GET /dex/trades', () => {
  test('returns trades with defaults (no cursor, limit 50)', async () => {
    db.query.mockResolvedValue({ rows: [{ public_key: WALLET }] });
    dex.getTradeHistory.mockResolvedValue([{ id: 'trade-1' }]);

    const res = await request(app).get('/dex/trades');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ trades: [{ id: 'trade-1' }] });
    expect(dex.getTradeHistory).toHaveBeenCalledWith(WALLET, null, 50);
  });

  test('passes cursor and limit to getTradeHistory', async () => {
    db.query.mockResolvedValue({ rows: [{ public_key: WALLET }] });
    dex.getTradeHistory.mockResolvedValue([]);

    const res = await request(app).get('/dex/trades?cursor=abc&limit=10');

    expect(res.status).toBe(200);
    expect(dex.getTradeHistory).toHaveBeenCalledWith(WALLET, 'abc', 10);
  });

  test('returns 400 when limit is 0', async () => {
    const res = await request(app).get('/dex/trades?limit=0');
    expect(res.status).toBe(400);
  });

  test('returns 400 when limit exceeds 200', async () => {
    const res = await request(app).get('/dex/trades?limit=201');
    expect(res.status).toBe(400);
  });

  test('returns 400 when cursor is an empty string', async () => {
    const res = await request(app).get('/dex/trades?cursor=');
    expect(res.status).toBe(400);
  });

  test('returns 404 when wallet not found', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).get('/dex/trades');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Wallet not found');
  });

  test('propagates service errors', async () => {
    db.query.mockResolvedValue({ rows: [{ public_key: WALLET }] });
    dex.getTradeHistory.mockRejectedValue(Object.assign(new Error('Horizon error'), { status: 503 }));

    const res = await request(app).get('/dex/trades');
    expect(res.status).toBe(503);
  });
});
