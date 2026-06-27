const StellarSdk = require('@stellar/stellar-sdk');
const { withFallback } = require('./stellar');
const logger = require('../utils/logger');
const cache = require('../utils/cache');

const SDEX_CACHE_TTL_MS = 60_000;        // XLM/USD refreshes every 60 s
const SDEX_REDIS_KEY = 'sdex:xlm_price';
const SDEX_REDIS_TTL_S = 60;
const FIAT_CACHE_TTL_MS = 60 * 60_000;  // USD→fiat refreshes every 60 min

// Fallback multipliers used when the exchange-rate API is unreachable
const FALLBACK_USD_TO_FIAT = {
  NGN: 1600,
  GHS: 15.5,
  KES: 129,
};

let sdexCache = { price: null, fetchedAt: 0 };
let fiatCache = { rates: null, fetchedAt: 0 };

// ---------------------------------------------------------------------------
// XLM/USD — Stellar SDEX order book
// ---------------------------------------------------------------------------

async function fetchSdexPrice() {
  const usdcIssuer = process.env.USDC_ISSUER;
  if (!usdcIssuer) throw new Error('USDC_ISSUER is not configured');

  const xlm = StellarSdk.Asset.native();
  const usdc = new StellarSdk.Asset('USDC', usdcIssuer);
  const book = await withFallback(s => s.orderbook(xlm, usdc).call());

  const bestBid = parseFloat(book.bids?.[0]?.price ?? '0');
  const bestAsk = parseFloat(book.asks?.[0]?.price ?? '0');

  if (!bestBid && !bestAsk) throw new Error('Empty SDEX order book');
  if (bestBid && bestAsk) return (bestBid + bestAsk) / 2;
  return bestBid || bestAsk;
}

async function getXlmPrice() {
  // Redis is the primary cache — shared across all instances, reduces Horizon load
  const redisPrice = await cache.get(SDEX_REDIS_KEY);
  if (redisPrice !== null) return redisPrice;

  const now = Date.now();
  if (sdexCache.price !== null && now - sdexCache.fetchedAt < SDEX_CACHE_TTL_MS) {
    return sdexCache.price;
  }
  try {
    const price = await fetchSdexPrice();
    sdexCache = { price, fetchedAt: now };
    await cache.set(SDEX_REDIS_KEY, price, SDEX_REDIS_TTL_S);
    return price;
  } catch (err) {
    logger.warn('SDEX price fetch failed, using last known price', { error: err.message });
    if (sdexCache.price !== null) return sdexCache.price;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// USD → fiat — open.er-api.com (free, no key required)
// Set EXCHANGE_RATE_API_KEY for the authenticated tier (higher rate limits).
// ---------------------------------------------------------------------------

async function fetchFiatRates() {
  const apiKey = process.env.EXCHANGE_RATE_API_KEY;
  const url = apiKey
    ? `https://v6.exchangerate-api.com/v6/${apiKey}/latest/USD`
    : 'https://open.er-api.com/v6/latest/USD';

  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`Exchange rate API HTTP ${res.status}`);

  const data = await res.json();
  const r = data?.rates;
  if (!r || typeof r.NGN !== 'number') throw new Error('Invalid exchange rate payload');

  return {
    NGN: r.NGN,
    GHS: r.GHS ?? FALLBACK_USD_TO_FIAT.GHS,
    KES: r.KES ?? FALLBACK_USD_TO_FIAT.KES,
  };
}

async function getUsdToFiat() {
  const now = Date.now();
  if (fiatCache.rates !== null && now - fiatCache.fetchedAt < FIAT_CACHE_TTL_MS) {
    return fiatCache.rates;
  }
  try {
    const rates = await fetchFiatRates();
    fiatCache = { rates, fetchedAt: now };
    logger.info('Fiat rates refreshed', { NGN: rates.NGN, GHS: rates.GHS, KES: rates.KES });
    return rates;
  } catch (err) {
    logger.warn('Fiat rate fetch failed, using fallback', { error: err.message });
    return fiatCache.rates ?? FALLBACK_USD_TO_FIAT;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns XLM price in USD, NGN, GHS, KES.
 * XLM/USD comes from the SDEX; USD→fiat comes from open.er-api.com.
 */
async function getXlmRates() {
  const [usd, fiat] = await Promise.all([getXlmPrice(), getUsdToFiat()]);
  return {
    USD: parseFloat(usd.toFixed(6)),
    NGN: parseFloat((usd * fiat.NGN).toFixed(4)),
    GHS: parseFloat((usd * fiat.GHS).toFixed(4)),
    KES: parseFloat((usd * fiat.KES).toFixed(4)),
  };
}

module.exports = { getXlmRates };
