import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, PiggyBank, Clock, Unlock, RefreshCw } from 'lucide-react';
import api from '../utils/api';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

/** Calculate remaining seconds from now until unlockTimestamp (unix seconds). */
function secondsUntil(unlockTimestamp) {
  return Math.max(0, unlockTimestamp - Math.floor(Date.now() / 1000));
}

/** Format a seconds value as "14d 6h 32m 18s". */
function formatCountdown(secs) {
  if (secs <= 0) return null;
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0 || d > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

/**
 * Per-vault countdown component.
 * Ticks every second; cleans up on unmount.
 */
function VaultCountdown({ unlockTimestamp, balance }) {
  const [secs, setSecs] = useState(() => secondsUntil(unlockTimestamp));

  useEffect(() => {
    if (secs <= 0) return;
    const id = setInterval(() => {
      setSecs(secondsUntil(unlockTimestamp));
    }, 1000);
    return () => clearInterval(id);
  }, [unlockTimestamp]); // eslint-disable-line react-hooks/exhaustive-deps

  const unlocked = secs <= 0;
  const penalty = (parseFloat(balance) * 0.1).toFixed(7);
  const label = formatCountdown(secs);

  if (unlocked) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 text-xs font-semibold">
        <Unlock size={11} aria-hidden="true" />
        Ready to withdraw
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span
        aria-live="polite"
        aria-atomic="true"
        aria-label={`${label} remaining until unlock`}
        className="inline-flex items-center gap-1 text-xs font-mono text-amber-400"
      >
        <Clock size={11} aria-hidden="true" />
        {label} remaining
      </span>
      {/* Withdraw button with early-penalty tooltip */}
      <div className="relative group inline-block">
        <button
          type="button"
          className="text-xs px-2 py-0.5 rounded border border-gray-600 text-gray-400 cursor-not-allowed"
          aria-disabled="true"
          tabIndex={-1}
        >
          Withdraw
        </button>
        <div
          role="tooltip"
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-52 bg-gray-900 border border-yellow-500/40 text-yellow-300 text-xs rounded-lg px-3 py-2 opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-10"
        >
          Early withdrawal incurs a 10% penalty ({penalty} XLM)
        </div>
      </div>
    </div>
  );
}

/** Demo vault list – replace with real API data once the Soroban contract is live. */
const DEMO_VAULTS = [
  {
    id: 1,
    label: 'Emergency Fund',
    balance: '100.0000000',
    unlockTimestamp: Math.floor(Date.now() / 1000) + 14 * 86400 + 6 * 3600 + 32 * 60 + 18,
  },
  {
    id: 2,
    label: 'Holiday Savings',
    balance: '250.0000000',
    unlockTimestamp: Math.floor(Date.now() / 1000) - 60, // already unlocked
  },
];

export default function SaveMoney() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [form, setForm] = useState({ amount: '', lock_period_days: '30' });
  const [loading, setLoading] = useState(false);
  const [wallet, setWallet] = useState(null);

  useEffect(() => {
    api.get('/wallet/balance').then(r => setWallet(r.data)).catch(() => {});
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.amount || parseFloat(form.amount) <= 0) {
      toast.error('Please enter a valid amount');
      return;
    }

    const amountXLM = parseFloat(form.amount);
    const xlmBalance = wallet?.balances?.find(b => b.asset === 'XLM')?.balance || 0;

    if (amountXLM > parseFloat(xlmBalance)) {
      toast.error('Insufficient balance');
      return;
    }

    setLoading(true);
    try {
      const lockPeriodSeconds = parseInt(form.lock_period_days) * 24 * 60 * 60;
      const unlockTime = Math.floor(Date.now() / 1000) + lockPeriodSeconds;
      // TODO: Integrate with Soroban savings-vault contract
      toast.success(`Savings vault feature coming soon! Amount: ${form.amount} XLM, Unlock in ${form.lock_period_days} days`);
      navigate('/dashboard');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save funds');
    } finally {
      setLoading(false);
    }
  };

  const xlmBalance = wallet?.balances?.find(b => b.asset === 'XLM')?.balance || '0';

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 transition-colors duration-200">
      <div className="px-4 py-6 max-w-lg mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate('/dashboard')}
            className="p-2 -m-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
            aria-label="Back to dashboard"
          >
            <ArrowLeft size={24} />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Save Money</h1>
            <p className="text-gray-600 dark:text-gray-400 text-sm">Lock funds for future goals</p>
          </div>
        </div>

        {/* Balance Card */}
        <div className="bg-gradient-to-br from-green-600 to-green-700 rounded-2xl p-5 shadow-lg shadow-green-500/20">
          <p className="text-green-100 text-sm mb-1">Available Balance</p>
          <div className="flex items-end gap-2 mb-4">
            <span className="text-4xl font-bold text-white">{parseFloat(xlmBalance).toFixed(2)}</span>
            <span className="text-green-200 mb-1">XLM</span>
          </div>
        </div>

        {/* Active Vaults */}
        {DEMO_VAULTS.length > 0 && (
          <section aria-label="Active savings vaults">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Your Vaults</h2>
            <div className="space-y-3">
              {DEMO_VAULTS.map(vault => (
                <div
                  key={vault.id}
                  className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-gray-900 dark:text-white text-sm">{vault.label}</span>
                    <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                      {parseFloat(vault.balance).toFixed(2)} XLM
                    </span>
                  </div>
                  <VaultCountdown
                    unlockTimestamp={vault.unlockTimestamp}
                    balance={vault.balance}
                  />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* New Vault Form */}
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Amount to Save (XLM)
            </label>
            <input
              type="number"
              step="0.0000001"
              min="0"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              className="w-full px-4 py-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent transition-colors"
              placeholder="0.00"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Lock Period
            </label>
            <select
              value={form.lock_period_days}
              onChange={(e) => setForm({ ...form, lock_period_days: e.target.value })}
              className="w-full px-4 py-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent transition-colors"
            >
              <option value="7">1 Week</option>
              <option value="30">1 Month</option>
              <option value="90">3 Months</option>
              <option value="180">6 Months</option>
              <option value="365">1 Year</option>
            </select>
          </div>

          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <Clock className="text-blue-500 mt-0.5" size={20} />
              <div>
                <h3 className="font-medium text-blue-900 dark:text-blue-100">Time-Locked Savings</h3>
                <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
                  Your funds will be locked until the selected date. Early withdrawal incurs a 10% penalty.
                  Earn yield from liquidity pools while locked.
                </p>
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || !form.amount}
            className="w-full bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-4 px-6 rounded-xl transition-colors flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <PiggyBank size={20} />
                Save Funds
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
