import React, { useEffect, useState, useCallback, useRef } from 'react';
import { ArrowUpDown, AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import api from '../utils/api';
import toast from 'react-hot-toast';

const REFRESH_INTERVAL = 15; // seconds
const HIGH_IMPACT_PCT = 2;
const PRICE_CHANGE_TOAST_THRESHOLD = 0.005; // 0.5%

export default function Swap() {
  const [sellAsset, setSellAsset] = useState('XLM');
  const [buyAsset, setBuyAsset] = useState('USDC');
  const [sellAmount, setSellAmount] = useState('');
  const [quote, setQuote] = useState(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState(null);

  // Auto-refresh countdown (counts down from REFRESH_INTERVAL to 0)
  const [refreshCountdown, setRefreshCountdown] = useState(REFRESH_INTERVAL);
  const prevMidPriceRef = useRef(null);
  const countdownRef = useRef(null);
  const refreshIntervalRef = useRef(null);

  const flipPair = () => {
    setSellAsset(buyAsset);
    setBuyAsset(sellAsset);
    setSellAmount('');
    setQuote(null);
    setResult(null);
    prevMidPriceRef.current = null;
  };

  const fetchQuote = useCallback(async (isAutoRefresh = false) => {
    if (!sellAmount || parseFloat(sellAmount) <= 0) { setQuote(null); return; }
    setQuoteLoading(true);
    try {
      const bookRes = await api.get(`/dex/orderbook?selling=${sellAsset}&buying=${buyAsset}`);
      const { midPrice, asks } = bookRes.data;

      const bestAsk = asks[0] ? parseFloat(asks[0].price) : null;
      const estimatedReceived = bestAsk ? (parseFloat(sellAmount) / bestAsk).toFixed(7) : null;
      const bestAskVolume = asks[0] ? parseFloat(asks[0].amount) : Infinity;
      const priceImpactPct = bestAskVolume > 0
        ? Math.min(((parseFloat(sellAmount) / bestAskVolume) * 100), 100)
        : 0;

      setQuote({ midPrice, estimatedReceived, priceImpactPct });

      // Notify on significant price change during auto-refresh
      if (isAutoRefresh && prevMidPriceRef.current !== null && midPrice) {
        const change = Math.abs((midPrice - prevMidPriceRef.current) / prevMidPriceRef.current);
        if (change > PRICE_CHANGE_TOAST_THRESHOLD) {
          toast('Price updated', {
            icon: '🔄',
            style: { background: '#1e293b', color: '#e2e8f0' },
            duration: 2500,
          });
        }
      }
      if (midPrice) prevMidPriceRef.current = midPrice;
    } catch {
      setQuote(null);
    } finally {
      setQuoteLoading(false);
    }
  }, [sellAsset, buyAsset, sellAmount]);

  // Debounce on user input
  useEffect(() => {
    const t = setTimeout(() => fetchQuote(false), 500);
    return () => clearTimeout(t);
  }, [fetchQuote]);

  // Start/stop the 15s auto-refresh cycle; pause when confirm modal is open
  useEffect(() => {
    if (confirmOpen) {
      clearInterval(refreshIntervalRef.current);
      clearInterval(countdownRef.current);
      return;
    }

    setRefreshCountdown(REFRESH_INTERVAL);

    // Countdown ticker (1s)
    countdownRef.current = setInterval(() => {
      setRefreshCountdown(prev => (prev <= 1 ? REFRESH_INTERVAL : prev - 1));
    }, 1000);

    // Auto-refresh trigger
    refreshIntervalRef.current = setInterval(() => {
      fetchQuote(true);
      setRefreshCountdown(REFRESH_INTERVAL);
    }, REFRESH_INTERVAL * 1000);

    return () => {
      clearInterval(refreshIntervalRef.current);
      clearInterval(countdownRef.current);
    };
  }, [confirmOpen, fetchQuote]);

  const handleManualRefresh = () => {
    fetchQuote(false);
    setRefreshCountdown(REFRESH_INTERVAL);
    // Reset the auto-refresh interval so it restarts from now
    clearInterval(refreshIntervalRef.current);
    clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setRefreshCountdown(prev => (prev <= 1 ? REFRESH_INTERVAL : prev - 1));
    }, 1000);
    refreshIntervalRef.current = setInterval(() => {
      fetchQuote(true);
      setRefreshCountdown(REFRESH_INTERVAL);
    }, REFRESH_INTERVAL * 1000);
  };

  const handleSwap = async (e) => {
    e.preventDefault();
    if (!confirmOpen) { setConfirmOpen(true); return; }
    setSubmitting(true);
    setResult(null);
    try {
      const res = await api.post('/dex/swap', {
        sell_asset: sellAsset,
        sell_amount: parseFloat(sellAmount),
        buy_asset: buyAsset,
      });
      setResult(res.data);
      setSellAmount('');
      setQuote(null);
      prevMidPriceRef.current = null;
      toast.success('Swap executed successfully');
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.errors?.[0]?.msg || 'Swap failed');
    } finally {
      setSubmitting(false);
      setConfirmOpen(false);
    }
  };

  const highImpact = quote && quote.priceImpactPct >= HIGH_IMPACT_PCT;
  const progressPct = ((REFRESH_INTERVAL - refreshCountdown) / REFRESH_INTERVAL) * 100;

  return (
    <div className="px-4 py-6 max-w-lg mx-auto space-y-5">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Swap</h2>

      {/* Rate display + refresh controls */}
      {quote?.midPrice && (
        <div className="bg-primary-500/10 border border-primary-500/20 rounded-xl px-4 py-2.5 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500 dark:text-gray-400">DEX rate</span>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-gray-900 dark:text-white">
                1 {sellAsset} ≈ {(1 / quote.midPrice).toFixed(6)} {buyAsset}
              </span>
              <button
                type="button"
                onClick={handleManualRefresh}
                disabled={quoteLoading}
                className="text-gray-400 hover:text-primary-500 transition-colors disabled:opacity-40"
                aria-label="Refresh price"
              >
                <RefreshCw size={13} className={quoteLoading ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>
          {/* Countdown progress bar */}
          {!confirmOpen && (
            <div className="space-y-0.5">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={REFRESH_INTERVAL}
                aria-valuenow={REFRESH_INTERVAL - refreshCountdown}
                aria-label={`Next price refresh in ${refreshCountdown}s`}
                className="h-1 bg-primary-500/20 rounded-full overflow-hidden"
              >
                <div
                  className="h-full bg-primary-500 transition-all duration-1000 ease-linear rounded-full"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <p className="text-xs text-gray-500 text-right">refreshes in {refreshCountdown}s</p>
            </div>
          )}
        </div>
      )}

      <form onSubmit={handleSwap} className="space-y-3">
        {/* Sell */}
        <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-2xl p-4 space-y-2">
          <label className="text-xs text-gray-500 uppercase tracking-wide">You sell</label>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min="0"
              step="any"
              required
              placeholder="0.00"
              value={sellAmount}
              onChange={e => { setSellAmount(e.target.value); setResult(null); }}
              className="flex-1 bg-transparent text-2xl font-bold text-gray-900 dark:text-white outline-none placeholder-gray-300 dark:placeholder-gray-700"
            />
            <span className="text-lg font-semibold text-gray-700 dark:text-gray-300 shrink-0">{sellAsset}</span>
          </div>
        </div>

        {/* Flip button */}
        <div className="flex justify-center">
          <button
            type="button"
            onClick={flipPair}
            className="w-9 h-9 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-full flex items-center justify-center text-gray-500 hover:text-primary-500 transition-colors shadow-sm"
            aria-label="Flip pair"
          >
            <ArrowUpDown size={16} />
          </button>
        </div>

        {/* Buy */}
        <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-2xl p-4 space-y-2">
          <label className="text-xs text-gray-500 uppercase tracking-wide">You receive (est.)</label>
          <div className="flex items-center gap-3">
            <span className="flex-1 text-2xl font-bold text-gray-400 dark:text-gray-600">
              {quoteLoading ? '…' : quote?.estimatedReceived ?? '0.00'}
            </span>
            <span className="text-lg font-semibold text-gray-700 dark:text-gray-300 shrink-0">{buyAsset}</span>
          </div>
        </div>

        {highImpact && (
          <div className="flex items-start gap-2 bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3 text-sm text-yellow-500">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <span>
              High price impact ({quote.priceImpactPct.toFixed(1)}%). Your order is large relative to
              available liquidity — you may receive significantly less than the quoted amount.
            </span>
          </div>
        )}

        {/* Confirm step */}
        {confirmOpen && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3 text-sm text-yellow-400">
            <p className="font-semibold mb-1">Confirm swap</p>
            <p>Sell <span className="font-semibold">{sellAmount} {sellAsset}</span> for approximately{' '}
              <span className="font-semibold">{quote?.estimatedReceived} {buyAsset}</span>?
            </p>
            <p className="text-xs text-gray-400 mt-1">Price is locked — auto-refresh paused.</p>
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || !sellAmount || parseFloat(sellAmount) <= 0}
          className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold py-3.5 rounded-2xl transition-colors"
        >
          {submitting ? 'Swapping…' : confirmOpen ? 'Confirm Swap' : `Swap ${sellAsset} → ${buyAsset}`}
        </button>

        {confirmOpen && (
          <button
            type="button"
            onClick={() => setConfirmOpen(false)}
            className="w-full text-gray-400 hover:text-white text-sm py-2 transition-colors"
          >
            Cancel
          </button>
        )}
      </form>

      {/* Success result */}
      {result && (
        <div className="bg-green-500/10 border border-green-500/30 rounded-2xl p-4 space-y-1">
          <div className="flex items-center gap-2 text-green-400 font-semibold text-sm mb-2">
            <CheckCircle2 size={16} /> Swap complete
          </div>
          <p className="text-sm text-gray-700 dark:text-gray-300">
            Sold <span className="font-semibold">{result.soldAmount} {result.soldAsset}</span>
          </p>
          <p className="text-sm text-gray-700 dark:text-gray-300">
            Est. received <span className="font-semibold">{result.estimatedReceived} {result.buyAsset}</span>
          </p>
          <a
            href={`https://stellar.expert/explorer/testnet/tx/${result.transactionHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary-400 hover:underline break-all"
          >
            {result.transactionHash}
          </a>
        </div>
      )}
    </div>
  );
}
