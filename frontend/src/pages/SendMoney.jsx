import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useMemoValidation } from '../hooks/useMemoValidation';
import { useNavigate, useSearchParams, useBeforeUnload } from 'react-router-dom';
import {
  ArrowLeft,
  Send,
  ChevronDown,
  Users,
  Camera,
  Code,
  ArrowRightLeft,
  Wallet,
  AlertTriangle,
  CheckCircle,
} from 'lucide-react';
import api from '../utils/api';
import { useExchangeRates } from '../hooks/useExchangeRates';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '../components/Skeleton';
import QRScanner from '../components/QRScanner';
import PINVerificationModal from '../components/PINVerificationModal';
import XDRInspectorModal from '../components/XDRInspectorModal';
import LedgerSignModal from '../components/LedgerSignModal';

const SLIPPAGE_OPTIONS = [0.5, 1, 2];
const DEFAULT_SLIPPAGE = 1;

const getSavedSlippage = () => {
  const v = parseFloat(localStorage.getItem('afripay_slippage'));
  return SLIPPAGE_OPTIONS.includes(v) ? v : DEFAULT_SLIPPAGE;
};

/** Trims trailing zeros from a Stellar-precision (7dp) amount for display. */
const fmtFee = (n) =>
  parseFloat(Number(n).toFixed(7)).toLocaleString(undefined, { maximumFractionDigits: 7 });

export default function SendMoney() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const submitButtonRef = React.useRef(null);
  const [form, setForm] = useState({
    recipient_address: searchParams.get('to') || '',
    amount: searchParams.get('amount') || '',
    asset: searchParams.get('asset') || 'XLM',
    memo: searchParams.get('memo') || '',
    destination_asset: '',
    slippage: getSavedSlippage(),
    memo_type: 'text',
    fee_priority: 'standard',
  });
  const [feeStats, setFeeStats] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [showContacts, setShowContacts] = useState(false);
  const [contactSearch, setContactSearch] = useState('');
  const [selectedContactIndex, setSelectedContactIndex] = useState(-1);
  const contactSearchRef = useRef(null);
  const contactListRef = useRef(null);
  const [showScanner, setShowScanner] = useState(false);
  const [showPINVerification, setShowPINVerification] = useState(false);
  const [showXDRInspector, setShowXDRInspector] = useState(false);
  const [transactionXDR, setTransactionXDR] = useState(null);
  const [loading, setLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [feeXLM, setFeeXLM] = useState(null);
  // Issue #641: pre-submission fee estimation preview
  const [feeEstimate, setFeeEstimate] = useState(null);
  const [feeEstimateLoading, setFeeEstimateLoading] = useState(false);
  const [feeEstimateError, setFeeEstimateError] = useState(false);
  const [contractSimData, setContractSimData] = useState(null);
  const [contractSimLoading, setContractSimLoading] = useState(false);
  const [requestId] = useState(searchParams.get('request'));
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  // Pre-fill form from payment request when only requestId is in the URL
  useEffect(() => {
    if (!requestId || form.recipient_address || form.amount) return;
    api
      .get(`/payment-requests/${requestId}`)
      .then((r) => {
        const { requester_wallet, amount, asset, memo } = r.data;
        setForm((f) => ({
          ...f,
          recipient_address: requester_wallet || f.recipient_address,
          amount: amount ? String(amount) : f.amount,
          asset: asset || f.asset,
          memo: memo || f.memo,
        }));
      })
      .catch(() => {});
  }, [requestId]); // eslint-disable-line react-hooks/exhaustive-deps
  const { currencies, convertFromXLM, usingApproximateRates } = useExchangeRates();
  const [pathResult, setPathResult] = useState(null);
  const [pathLoading, setPathLoading] = useState(false);
  const [memoRequired, setMemoRequired] = useState(false);
  const [memoError, setMemoError] = useState(false);
  const { memoError: hashMemoError, validateMemo, getMemoPlaceholder, isMemoValid } = useMemoValidation();
  const memoRef = useRef(null);
  const [addressError, setAddressError] = useState(false);
  // 'send' = strict send (sender specifies exact amount), 'receive' = strict receive (recipient gets exact amount)
  const [sendMode, setSendMode] = useState('send');

  // Trustline check state
  const [trustlineWarning, setTrustlineWarning] = useState(null); // null | string (asset code)

  // Path payment toggle — when enabled the user can pick a destination asset and
  // the payment is routed via Stellar DEX path payment instead of a direct transfer.
  const [usePathPayment, setUsePathPayment] = useState(false);

  // Ledger hardware wallet state
  const [showLedgerModal, setShowLedgerModal] = useState(false);
  const [unsignedXDR, setUnsignedXDR] = useState(null);
  const [ledgerNetworkPassphrase, setLedgerNetworkPassphrase] = useState(null);

  const isCrossAsset = usePathPayment && form.destination_asset && form.destination_asset !== form.asset;

  /** Returns true for a valid Ed25519 public key or a federation address */
  const isValidStellarAddress = (addr) =>
    (addr.startsWith('G') && addr.length === 56) || addr.includes('*');

  // Initial/clean state used for reset and dirty-check
  const cleanForm = {
    recipient_address: searchParams.get('to') || '',
    amount: searchParams.get('amount') || '',
    asset: searchParams.get('asset') || 'XLM',
    memo: searchParams.get('memo') || '',
    destination_asset: '',
    slippage: getSavedSlippage(),
    memo_type: 'text',
    fee_priority: 'standard',
    private_note: '',
  };

  /** Clears all user-entered fields back to their URL-seeded defaults. */
  const resetForm = () => {
    setForm(cleanForm);
    setConfirmed(false);
    setFeeXLM(null);
    setPathResult(null);
    setMemoRequired(false);
    setMemoError(false);
    setAddressError(false);
    setContractSimData(null);
    setUsePathPayment(false);
    setSendMode('send');
  };

  /** True when the user has entered data beyond the URL-seeded defaults. */
  const formIsDirty =
    form.recipient_address !== cleanForm.recipient_address ||
    form.amount !== cleanForm.amount ||
    form.memo !== cleanForm.memo ||
    (form.private_note || '') !== '';

  // Multi-wallet state
  const [wallets, setWallets] = useState([]);
  const [selectedWalletId, setSelectedWalletId] = useState(searchParams.get('wallet_id') || null);
  const [showWalletDropdown, setShowWalletDropdown] = useState(false);

  const selectedWallet = wallets.find((w) => w.id === selectedWalletId) || wallets[0] || null;

  // Available XLM balance for the selected wallet (after minimum reserve)
  const selectedWalletXlmEntry = selectedWallet?.balances?.find((b) => b.asset === 'XLM');
  const availableXlm = selectedWalletXlmEntry?.available_balance
    ? parseFloat(selectedWalletXlmEntry.available_balance)
    : null;
  const belowMinBalance =
    form.asset === 'XLM' &&
    availableXlm !== null &&
    form.amount &&
    parseFloat(form.amount) > availableXlm;

  useEffect(() => {
    api
      .get('/payments/fee-stats')
      .then((r) => setFeeStats(r.data))
      .catch(() => {});
  }, []);

  // Issue #641: debounced fee estimation preview as the user types an amount.
  useEffect(() => {
    const gross = parseFloat(form.amount);
    if (!form.amount || !Number.isFinite(gross) || gross <= 0) {
      setFeeEstimate(null);
      setFeeEstimateError(false);
      setFeeEstimateLoading(false);
      return;
    }

    let cancelled = false;
    setFeeEstimateLoading(true);
    setFeeEstimateError(false);

    const timer = setTimeout(async () => {
      try {
        const [rateRes, networkRes] = await Promise.all([
          api.get('/payments/fee-rate'),
          api.get('/payments/estimate-fee'),
        ]);
        if (cancelled) return;
        const feeBps = rateRes.data?.fee_bps;
        if (feeBps == null || Number.isNaN(Number(feeBps))) {
          throw new Error('Fee rate unavailable');
        }
        const platformFee = gross * (Number(feeBps) / 10000);
        setFeeEstimate({
          gross,
          asset: form.asset,
          feePct: Number(feeBps) / 100,
          platformFee,
          networkFeeXLM: networkRes.data?.fee_xlm ?? null,
          netAmount: gross - platformFee,
        });
      } catch {
        if (cancelled) return;
        setFeeEstimate(null);
        setFeeEstimateError(true);
      } finally {
        if (!cancelled) setFeeEstimateLoading(false);
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  // Fee estimation preview (Issue #641)
  const [feePreview, setFeePreview] = useState(null);
  const [feePreviewLoading, setFeePreviewLoading] = useState(false);
  const [feePreviewError, setFeePreviewError] = useState(false);
  useEffect(() => {
    const amount = parseFloat(form.amount);
    if (!amount || amount <= 0) {
      setFeePreview(null);
      setFeePreviewError(false);
      return;
    }
    setFeePreviewLoading(true);
    setFeePreviewError(false);
    const timer = setTimeout(() => {
      api
        .get('/payments/fee-stats')
        .then((r) => {
          const feeBps = r.data?.fee_bps ?? 50;
          const networkFeeXlm = r.data?.fee_xlm ?? 0.00001;
          const platformFee = (amount * feeBps) / 10000;
          const net = amount - platformFee;
          setFeePreview({ amount, platformFee, feeBps, networkFeeXlm, net, asset: form.asset });
        })
        .catch(() => setFeePreviewError(true))
        .finally(() => setFeePreviewLoading(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [form.amount, form.asset]);

  // Warn the user before closing/refreshing the tab when the form has data
  useBeforeUnload(
    React.useCallback(
      (e) => {
        if (formIsDirty) e.preventDefault();
      },
      [formIsDirty]
    )
  );

  useEffect(() => {
    api
      .get('/wallet/list')
      .then((r) => {
        setWallets(r.data.wallets || []);
        // If no wallet_id in URL, default to the user's default wallet
        if (!selectedWalletId && r.data.wallets?.length) {
          const def = r.data.wallets.find((w) => w.is_default) || r.data.wallets[0];
          setSelectedWalletId(def.id);
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api
      .get('/wallet/contacts')
      .then((r) => setContacts(r.data.contacts || []))
      .catch(() => {});
  }, []);

  // Filter contacts based on search term
  const filteredContacts = useMemo(() => {
    if (!contactSearch.trim()) return contacts;
    const searchLower = contactSearch.toLowerCase();
    return contacts.filter(
      (contact) =>
        contact.name.toLowerCase().includes(searchLower) ||
        contact.wallet_address.toLowerCase().includes(searchLower)
    );
  }, [contacts, contactSearch]);

  // Reset selected index when search changes
  useEffect(() => {
    setSelectedContactIndex(-1);
  }, [contactSearch]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (showContacts && contactSearchRef.current) {
      contactSearchRef.current.focus();
    }
  }, [showContacts]);

  // Click-outside + Escape to close contacts dropdown
  const contactsDropdownRef = useRef(null);
  useEffect(() => {
    if (!showContacts) return;

    const onMouseDown = (e) => {
      if (!contactsDropdownRef.current) return;
      if (!contactsDropdownRef.current.contains(e.target)) {
        setShowContacts(false);
        setContactSearch('');
      }
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        setShowContacts(false);
        setContactSearch('');
      }
    };

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [showContacts]);

  // Handle keyboard navigation in contacts dropdown
  const handleContactKeyDown = (e) => {
    if (!showContacts) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedContactIndex((prev) => (prev < filteredContacts.length - 1 ? prev + 1 : prev));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedContactIndex((prev) => (prev > 0 ? prev - 1 : 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedContactIndex >= 0 && selectedContactIndex < filteredContacts.length) {
          const contact = filteredContacts[selectedContactIndex];
          setForm({
            ...form,
            recipient_address: contact.wallet_address,
            memo: contact.default_memo || form.memo,
          });
          if (contact.memo_required) setMemoRequired(true);
          setShowContacts(false);
          setContactSearch('');
        }
        break;
      case 'Escape':
        e.preventDefault();
        setShowContacts(false);
        setContactSearch('');
        break;
    }
  };

  // Scroll selected contact into view
  useEffect(() => {
    if (selectedContactIndex >= 0 && contactListRef.current) {
      const selectedElement = contactListRef.current.children[selectedContactIndex];
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedContactIndex]);

  useEffect(() => {
    const handleResize = () => {
      if (window.visualViewport) {
        const isOpen = window.visualViewport.height < window.innerHeight * 0.75;
        setKeyboardOpen(isOpen);
        if (isOpen && submitButtonRef.current) {
          setTimeout(
            () => submitButtonRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
            100
          );
        }
      }
    };
    window.visualViewport?.addEventListener('resize', handleResize);
    return () => window.visualViewport?.removeEventListener('resize', handleResize);
  }, []);
  // Ref to abort any in-flight path request when form values change
  const pathAbortRef = useRef(null);

  // Debounced path finding
  const findPath = useCallback(async () => {
    // Abort any previous in-flight request
    pathAbortRef.current?.abort();
    const controller = new AbortController();
    pathAbortRef.current = controller;

    if (!isCrossAsset || !form.amount || !form.recipient_address) {
      setPathResult(null);
      setPathLoading(false);
      return;
    }
    setPathLoading(true);
    try {
      if (sendMode === 'receive') {
        // Strict receive: user specifies destination amount, we find source amount
        const res = await api.post(
          '/payments/find-receive-path',
          {
            source_asset: form.asset,
            destination_asset: form.destination_asset,
            destination_amount: parseFloat(form.amount),
            recipient_address: form.recipient_address,
          },
          { signal: controller.signal }
        );
        setPathResult(res.data);
      } else {
        // Strict send: user specifies source amount, we find destination amount
        const res = await api.post(
          '/payments/find-path',
          {
            source_asset: form.asset,
            source_amount: parseFloat(form.amount),
            destination_asset: form.destination_asset,
            recipient_address: form.recipient_address,
          },
          { signal: controller.signal }
        );
        setPathResult(res.data);
      }
    } catch (err) {
      // Ignore abort errors — they are intentional cancellations
      if (err.name !== 'CanceledError' && err.name !== 'AbortError') {
        setPathResult(null);
      }
    } finally {
      // Only clear loading state if this request was not superseded
      if (!controller.signal.aborted) {
        setPathLoading(false);
      }
    }
  }, [
    form.amount,
    form.asset,
    form.destination_asset,
    form.recipient_address,
    isCrossAsset,
    sendMode,
  ]);

  useEffect(() => {
    // Clear stale result immediately so the UI never shows data for old inputs
    setPathResult(null);
    const timer = setTimeout(findPath, 600);
    return () => {
      clearTimeout(timer);
      pathAbortRef.current?.abort();
    };
  }, [findPath]);

  const checkMemoRequired = useCallback(async (address) => {
    if (!address || address.length < 56) {
      setMemoRequired(false);
      return;
    }
    try {
      const res = await api.get('/payments/memo-required', { params: { address } });
      setMemoRequired(res.data.memo_required === true);
    } catch {
      setMemoRequired(false);
    }
  }, []);

  // Debounced trustline check: warn when recipient may not hold the selected non-XLM asset
  useEffect(() => {
    const address = form.recipient_address;
    const asset = form.asset;

    // Only check for non-XLM assets with a plausible Stellar address
    if (asset === 'XLM' || !address || address.length < 56 || !address.startsWith('G')) {
      setTrustlineWarning(null);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const res = await api.get('/wallet/check-trustline', {
          params: { address, asset },
        });
        if (res.data.has_trustline === false) {
          setTrustlineWarning(asset);
        } else {
          setTrustlineWarning(null);
        }
      } catch {
        // Silently ignore — don't block the user on a failed check
        setTrustlineWarning(null);
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [form.recipient_address, form.asset]);

  const estimatedValue =
    form.amount && form.asset === 'XLM' ? `≈ ${convertFromXLM(form.amount, 'USD')} USD` : '';

  // Minimum destination amount after slippage
  const destMin = pathResult
    ? (parseFloat(pathResult.destinationAmount) * (1 - form.slippage / 100)).toFixed(7)
    : null;
  const memoTrimmed = form.memo.trim();
  const memoMaxLen = form.memo_type === 'id' ? 20 : form.memo_type === 'text' ? 28 : 64;

  const handleSubmit = async (e) => {
    e.preventDefault();

    // First call: show confirmation preview with fresh fee estimate and optional contract simulation.
    if (!confirmed) {
      try {
        const r = await api.get('/payments/estimate-fee');
        setFeeXLM(r.data.fee_xlm);
      } catch {
        setFeeXLM(null);
      }

      if (form.recipient_address.startsWith('C')) {
        setContractSimLoading(true);
        setContractSimData(null);
        try {
          const payload = {
            recipient_address: form.recipient_address,
            amount: parseFloat(form.amount),
            asset: form.asset,
            wallet_id: selectedWallet?.id || undefined,
            fee_priority: form.fee_priority,
          };
          if (form.memo) {
            payload.memo = form.memo;
            payload.memo_type = form.memo_type;
          }
          const buildRes = await api.post('/payments/build', payload);
          if (buildRes.data.xdr) {
            const simRes = await api.post('/contracts/simulate', {
              transaction: buildRes.data.xdr,
            });
            setContractSimData(simRes.data);
          }
        } catch (simErr) {
          setContractSimData({ error: simErr.response?.data?.error || simErr.message });
        } finally {
          setContractSimLoading(false);
        }
      }

      setConfirmed(true);
      return;
    }

    // Second call: user confirmed the preview — open PIN modal to authorise the payment.
    setShowPINVerification(true);
  };

  const handleSignWithLedger = async () => {
    setLoading(true);
    try {
      const res = await api.post('/payments/build-transaction', {
        recipient_address: form.recipient_address,
        amount: parseFloat(form.amount),
        asset: form.asset,
        memo: form.memo.trim() || undefined,
        memo_type: form.memo_type,
        wallet_id: selectedWallet?.id || undefined,
      });
      setUnsignedXDR(res.data.xdr);
      setLedgerNetworkPassphrase(res.data.network_passphrase);
      setShowLedgerModal(true);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to build transaction');
    } finally {
      setLoading(false);
    }
  };

  const handleLedgerSigned = async (signedXDR) => {
    setShowLedgerModal(false);
    setLoading(true);
    try {
      await api.post('/payments/submit-signed', {
        xdr: signedXDR,
        recipient_address: form.recipient_address,
        amount: parseFloat(form.amount),
        asset: form.asset,
        wallet_id: selectedWallet?.id || undefined,
      });
      toast.success('Payment sent via Ledger!');
      resetForm();
      navigate('/dashboard');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to submit Ledger transaction');
    } finally {
      setLoading(false);
    }
  };

  const handlePINVerified = async () => {
    setLoading(true);
    try {
      let res;
      if (isCrossAsset && pathResult) {
        if (sendMode === 'receive') {
          // Strict receive: recipient gets exact destination_amount
          const sourceMax = (
            parseFloat(pathResult.sourceAmount) *
            (1 + form.slippage / 100)
          ).toFixed(7);
          res = await api.post('/payments/send-strict-receive', {
            recipient_address: form.recipient_address,
            source_asset: form.asset,
            source_max_amount: parseFloat(sourceMax),
            destination_asset: form.destination_asset,
            destination_amount: parseFloat(form.amount),
            path: pathResult.path,
            memo: form.memo || undefined,
            wallet_id: selectedWallet?.id || undefined,
          });
        } else {
          res = await api.post('/payments/send-path', {
            recipient_address: form.recipient_address,
            source_asset: form.asset,
            source_amount: parseFloat(form.amount),
            destination_asset: form.destination_asset,
            destination_min_amount: parseFloat(destMin),
            path: pathResult.path,
            memo: form.memo || undefined,
            wallet_id: selectedWallet?.id || undefined,
          });
        }
        toast.success(t('send.success'));
        if (requestId) {
          await api
            .post(`/payment-requests/${requestId}/claim`, {
              txHash: res.data.transaction.tx_hash,
            })
            .catch(() => {});
        }
        resetForm();
        navigate('/dashboard');
      } else {
        const m = form.memo.trim();
        let recipientAddress = form.recipient_address;

        // Resolve federation address if needed
        if (recipientAddress.includes('*')) {
          const fedRes = await api.get('/payments/resolve-federation', {
            params: { address: recipientAddress },
          });
          recipientAddress = fedRes.data.public_key;
        }

        const payload = {
          recipient_address: recipientAddress,
          amount: parseFloat(form.amount),
          asset: form.asset,
          wallet_id: selectedWallet?.id || undefined,
          fee_priority: form.fee_priority,
        };
        if (m) {
          payload.memo = m;
          payload.memo_type = form.memo_type;
        }
        res = await api.post('/payments/send', payload);
      }

      // Offline queue — the api interceptor returns { queued: true }
      if (res.data?.queued) {
        toast.success(
          "You're offline. Payment queued — it will send automatically when you reconnect.",
          { duration: 5000 }
        );
        resetForm();
        navigate('/dashboard');
        return;
      }

      // Mark payment request as claimed if applicable
      if (requestId) {
        await api
          .post(`/payment-requests/${requestId}/claim`, {
            txHash: res.data?.transaction?.tx_hash,
          })
          .catch(() => {});
      }

      toast.success(t('send.success'));
      resetForm();
      navigate('/dashboard');
    } catch (err) {
      if (err.response?.data?.code === 'MEMO_REQUIRED') {
        setMemoError(true);
        setConfirmed(false);
        setShowPINVerification(false);
        setTimeout(() => {
          memoRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          memoRef.current?.focus();
        }, 50);
      } else {
        toast.error(err.response?.data?.error || t('send.error'));
        setConfirmed(false);
        setShowPINVerification(false);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="px-4 py-6 max-w-lg mx-auto pb-safe"
      style={{
        paddingBottom: keyboardOpen ? 'max(1.5rem, env(safe-area-inset-bottom))' : '1.5rem',
      }}
    >
      <button
        onClick={() => {
          if (formIsDirty && !window.confirm('You have unsaved changes. Leave this page?')) return;
          navigate(-1);
        }}
        className="text-gray-400 hover:text-white mb-6 flex items-center gap-1"
      >
        <ArrowLeft size={18} /> {t('common.back')}
      </button>

      <h2 className="text-2xl font-bold text-white mb-6">{t('send.title')}</h2>

      <form
        onSubmit={handleSubmit}
        className="space-y-4 overflow-y-auto"
        style={{ maxHeight: keyboardOpen ? 'calc(100vh - 200px)' : 'auto' }}
      >
        {/* Wallet selector */}
        {wallets.length > 1 && (
          <div>
            <label className="text-sm text-gray-400 mb-1 block">Send from</label>
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowWalletDropdown((v) => !v)}
                className="w-full flex items-center justify-between bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white hover:border-primary-500 transition-colors"
                aria-haspopup="listbox"
                aria-expanded={showWalletDropdown}
              >
                <div className="flex items-center gap-2">
                  <Wallet size={15} className="text-primary-400" />
                  <span className="text-sm">{selectedWallet?.label || 'Select wallet'}</span>
                  {selectedWallet && (
                    <span className="text-xs text-gray-500 font-mono">
                      ({selectedWallet.balances?.find((b) => b.asset === 'XLM')?.balance || '0'}{' '}
                      XLM)
                    </span>
                  )}
                </div>
                <ChevronDown
                  size={14}
                  className={`text-gray-400 transition-transform ${showWalletDropdown ? 'rotate-180' : ''}`}
                />
              </button>

              {showWalletDropdown && (
                <div
                  className="absolute z-20 mt-1 w-full bg-gray-800 border border-gray-700 rounded-xl shadow-xl overflow-hidden"
                  role="listbox"
                >
                  {wallets.map((w) => {
                    const xlm = w.balances?.find((b) => b.asset === 'XLM')?.balance || '0';
                    return (
                      <button
                        key={w.id}
                        type="button"
                        role="option"
                        aria-selected={w.id === selectedWalletId}
                        onClick={() => {
                          setSelectedWalletId(w.id);
                          setShowWalletDropdown(false);
                        }}
                        className={`w-full flex items-center justify-between px-4 py-3 text-left transition-colors ${
                          w.id === selectedWalletId
                            ? 'bg-primary-500/20 text-primary-400'
                            : 'hover:bg-gray-700 text-white'
                        }`}
                      >
                        <div>
                          <p className="text-sm font-medium">{w.label}</p>
                          <p className="text-xs text-gray-500 font-mono">
                            {w.public_key.slice(0, 16)}…
                          </p>
                        </div>
                        <p className="text-sm font-semibold">
                          {parseFloat(xlm).toLocaleString()} XLM
                        </p>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Recipient */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm text-gray-400">{t('send.recipient_label')}</label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowScanner(true)}
                className="text-primary-500 hover:text-primary-400 p-1.5 rounded-lg hover:bg-primary-500/10 transition-colors"
                title={t('send.scan_qr')}
                aria-label={t('send.scan_qr')}
              >
                <Camera size={16} />
              </button>
              {contacts.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowContacts(!showContacts)}
                  className="text-primary-500 text-xs flex items-center gap-1"
                >
                  <Users size={12} /> {t('send.contacts')}
                </button>
              )}
            </div>
          </div>
          <input
            type="text"
            required
            placeholder={t('send.recipient_placeholder') || 'Wallet address or username*domain'}
            value={form.recipient_address}
            onChange={(e) => {
              setForm({ ...form, recipient_address: e.target.value });
              setMemoRequired(false);
              setAddressError(false);
            }}
            onBlur={(e) => {
              const val = e.target.value.trim();
              if (val && !isValidStellarAddress(val)) setAddressError(true);
              checkMemoRequired(val);
            }}
            aria-invalid={addressError}
            aria-describedby={addressError ? 'address-error' : undefined}
            className={`w-full bg-gray-800 border rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none transition-colors font-mono text-sm ${
              addressError
                ? 'border-red-500 focus:border-red-400'
                : 'border-gray-700 focus:border-primary-500'
            }`}
          />
          {addressError && (
            <p id="address-error" className="mt-1 text-xs text-red-400">
              Invalid address. Enter a Stellar public key (G…, 56 chars) or federation address
              (name*domain).
            </p>
          )}
          {!addressError &&
            form.recipient_address &&
            isValidStellarAddress(form.recipient_address) && (
              <p className="mt-1 flex items-center gap-1 text-xs text-green-400">
                <CheckCircle size={12} aria-hidden="true" /> Valid address
              </p>
            )}
          {showContacts && contacts.length > 0 && (
            <div
              ref={contactsDropdownRef}
              className="mt-1 bg-gray-800 border border-gray-700 rounded-xl overflow-hidden"
              onKeyDown={handleContactKeyDown}
            >
              {/* Search input */}
              <div className="p-2 border-b border-gray-700">
                <input
                  ref={contactSearchRef}
                  type="text"
                  placeholder="Search contacts..."
                  value={contactSearch}
                  onChange={(e) => setContactSearch(e.target.value)}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-400 focus:outline-none focus:border-primary-500"
                  aria-label="Search contacts"
                />
              </div>

              {/* Contact list */}
              <div ref={contactListRef} className="max-h-60 overflow-y-auto">
                {filteredContacts.length > 0 ? (
                  filteredContacts.map((c, index) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setForm({
                          ...form,
                          recipient_address: c.wallet_address,
                          memo: c.default_memo || form.memo,
                        });
                        if (c.memo_required) setMemoRequired(true);
                        setShowContacts(false);
                        setContactSearch('');
                      }}
                      className={`w-full px-4 py-2.5 text-left transition-colors ${
                        index === selectedContactIndex
                          ? 'bg-primary-500/20 text-primary-400'
                          : 'hover:bg-gray-700'
                      }`}
                    >
                      <p className="text-sm text-white">{c.name}</p>
                      <p className="text-xs text-gray-500 font-mono">
                        {c.wallet_address.slice(0, 20)}...
                      </p>
                    </button>
                  ))
                ) : (
                  <div className="px-4 py-6 text-center text-gray-400">
                    <p className="text-sm">No contacts match</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {memoRequired && !form.memo.trim() && (
          <div className="bg-yellow-500/10 border border-yellow-500/40 rounded-xl px-4 py-3 text-yellow-400 text-sm">
            ⚠️ This address requires a memo. Payments without a memo may be lost.
          </div>
        )}

        {/* Trustline warning — advisory only, does not block submission */}
        {trustlineWarning && (
          <div
            role="alert"
            className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/40 rounded-xl px-4 py-3 text-amber-400 text-sm"
          >
            <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              ⚠️ Recipient may not be able to receive {trustlineWarning}. Verify their wallet
              supports this asset.
            </span>
          </div>
        )}

        {/* Amount + Source Asset */}
        <div>
          <label className="text-sm text-gray-400 mb-1 block">
            {isCrossAsset && sendMode === 'receive'
              ? `Recipient receives (${form.destination_asset || form.asset})`
              : t('send.amount')}
          </label>
          <div className="flex gap-2">
            <input
              type="number"
              required
              min="0.0000001"
              step="any"
              placeholder="0.00"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors"
            />
            <div className="relative">
              <select
                value={form.asset}
                onChange={(e) => setForm({ ...form, asset: e.target.value })}
                className="appearance-none bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-primary-500 pr-8 transition-colors"
              >
                {currencies.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.flag} {c.code}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={14}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
              />
            </div>
          </div>
          {estimatedValue && (
            <div className="mt-1 space-y-1">
              <p className="text-xs text-gray-500">{estimatedValue}</p>
              {usingApproximateRates && (
                <p className="text-xs text-amber-500/90">{t('common.rates_disclaimer')}</p>
              )}
            </div>
          )}
          {availableXlm !== null && form.asset === 'XLM' && (
            <p className="text-xs text-gray-500 mt-1">
              Available to send: {availableXlm.toLocaleString()} XLM
            </p>
          )}
          {feeXLM && form.asset !== 'XLM' && availableXlm !== null && availableXlm < feeXLM && (
            <div className="mt-2 bg-yellow-500/10 border border-yellow-500/40 rounded-xl px-4 py-3 text-yellow-300 text-sm">
              ⚠️ Low XLM balance. You need at least {feeXLM} XLM to cover the network fee.
            </div>
          )}
          {/* Fee estimation preview (Issue #641) */}
          {(feePreviewLoading || feePreview || feePreviewError) && (
            <div className="mt-3 bg-gray-800/60 border border-gray-700 rounded-xl px-4 py-3 text-sm space-y-1.5">
              {feePreviewLoading ? (
                <>
                  <div className="skeleton h-3 w-32 rounded" />
                  <div className="skeleton h-3 w-24 rounded" />
                  <div className="skeleton h-3 w-28 rounded" />
                </>
              ) : feePreviewError ? (
                <p className="text-gray-400 text-xs">
                  Fee estimate unavailable — final fee will be shown at confirmation.
                </p>
              ) : feePreview ? (
                <>
                  <div className="flex justify-between text-gray-400">
                    <span>Gross amount</span>
                    <span className="text-white">{feePreview.amount.toFixed(7)} {feePreview.asset}</span>
                  </div>
                  <div className="flex justify-between text-gray-400">
                    <span>Platform fee ({(feePreview.feeBps / 100).toFixed(2)}%)</span>
                    <span className="text-red-400">− {feePreview.platformFee.toFixed(7)} {feePreview.asset}</span>
                  </div>
                  <div className="flex justify-between text-gray-400">
                    <span>Network fee (est.)</span>
                    <span className="text-red-400">~ {feePreview.networkFeeXlm} XLM</span>
                  </div>
                  <div className="flex justify-between font-semibold border-t border-gray-700 pt-1.5">
                    <span className="text-gray-300">Recipient receives</span>
                    <span className="text-green-400">{feePreview.net.toFixed(7)} {feePreview.asset}</span>
                  </div>
                </>
              ) : null}
            </div>
          )}
          {belowMinBalance && (
            <div className="mt-2 bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3 text-red-400 text-sm">
              ⚠️ This amount exceeds your available balance ({availableXlm.toLocaleString()} XLM).
              Sending it would drop your account below the Stellar minimum reserve.
            </div>
          )}
        </div>

        {/* Fee estimation preview (issue #641) */}
        {(feeEstimateLoading || feeEstimate || feeEstimateError) && (
          <div
            data-testid="fee-estimate"
            className="bg-gray-800 border border-gray-700 rounded-xl p-4"
          >
            <p className="text-sm font-semibold text-gray-300 mb-2">Fee breakdown</p>
            {feeEstimateLoading ? (
              <div className="space-y-2" data-testid="fee-estimate-skeleton" aria-hidden="true">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : feeEstimateError ? (
              <p className="text-sm text-yellow-400">
                Fee estimate unavailable — final fee will be shown at confirmation.
              </p>
            ) : feeEstimate ? (
              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <dt className="text-gray-400">Gross amount</dt>
                  <dd className="text-white">
                    {fmtFee(feeEstimate.gross)} {feeEstimate.asset}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-400">
                    Platform fee ({feeEstimate.feePct}%)
                  </dt>
                  <dd className="text-white">
                    {fmtFee(feeEstimate.platformFee)} {feeEstimate.asset}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-400">Est. network fee</dt>
                  <dd className="text-white">
                    {feeEstimate.networkFeeXLM != null ? `${feeEstimate.networkFeeXLM} XLM` : '—'}
                  </dd>
                </div>
                <div className="flex justify-between border-t border-gray-700 pt-1.5 font-semibold">
                  <dt className="text-gray-300">Recipient receives</dt>
                  <dd className="text-green-400">
                    {fmtFee(feeEstimate.netAmount)} {feeEstimate.asset}
                  </dd>
                </div>
              </dl>
            ) : null}
          </div>
        )}

        {/* Path payment toggle (issue #458) */}
        <div>
          <div className="flex items-center justify-between">
            <label className="text-sm text-gray-400 flex items-center gap-1.5">
              <ArrowRightLeft size={13} />
              Path payment{' '}
              <span className="text-gray-600 text-xs">(swap via Stellar DEX)</span>
            </label>
            <button
              type="button"
              role="switch"
              aria-checked={usePathPayment}
              onClick={() => {
                const next = !usePathPayment;
                setUsePathPayment(next);
                if (!next) {
                  setForm((f) => ({ ...f, destination_asset: '' }));
                  setPathResult(null);
                  setSendMode('send');
                }
              }}
              className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                usePathPayment ? 'bg-primary-500' : 'bg-gray-700'
              }`}
              aria-label="Enable path payment"
            >
              <span
                className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                  usePathPayment ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
          <p className="text-xs text-gray-600 mt-0.5">
            Route through the Stellar DEX when a direct payment path is unavailable.
          </p>

          {usePathPayment && (
            <div className="mt-3 space-y-3">
              {/* Send-mode toggle: strict-send vs strict-receive */}
              <div className="flex items-center gap-1 bg-gray-800 rounded-lg p-0.5 w-fit">
                <button
                  type="button"
                  onClick={() => { setSendMode('send'); setPathResult(null); }}
                  className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
                    sendMode === 'send' ? 'bg-primary-500 text-white' : 'text-gray-400 hover:text-white'
                  }`}
                >
                  I send exact
                </button>
                <button
                  type="button"
                  onClick={() => { setSendMode('receive'); setPathResult(null); }}
                  className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
                    sendMode === 'receive' ? 'bg-primary-500 text-white' : 'text-gray-400 hover:text-white'
                  }`}
                >
                  They receive exact
                </button>
              </div>

              {/* Destination asset selector */}
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Recipient receives</label>
                <div className="relative">
                  <select
                    value={form.destination_asset}
                    onChange={(e) => setForm({ ...form, destination_asset: e.target.value })}
                    className="appearance-none w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-primary-500 pr-8 transition-colors"
                  >
                    <option value="">Same as sent ({form.asset})</option>
                    {currencies
                      .filter((c) => c.code !== form.asset)
                      .map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.flag} {c.code}
                        </option>
                      ))}
                  </select>
                  <ChevronDown
                    size={14}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
                  />
                </div>
              </div>

              {/* Path result / loading */}
              {isCrossAsset && (
                <div className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-xl text-sm">
                  {pathLoading && <p className="text-gray-400 animate-pulse">Finding best rate...</p>}
                  {!pathLoading && pathResult && sendMode === 'send' && (
                    <div className="space-y-1">
                      <p className="text-green-400">
                        Recipient receives ≈{' '}
                        <span className="font-semibold">
                          {pathResult.destinationAmount} {form.destination_asset}
                        </span>
                      </p>
                      {(() => {
                        const srcAmt = parseFloat(form.amount);
                        const dstAmt = parseFloat(pathResult.destinationAmount);
                        if (!srcAmt || !dstAmt) return null;
                        const rate = (dstAmt / srcAmt).toPrecision(6);
                        return (
                          <>
                            <p className="text-xs text-gray-400">
                              Rate: 1 {form.asset} ≈ {rate} {form.destination_asset}
                            </p>
                            {form.slippage > 1 && (
                              <p className="text-xs text-yellow-400">
                                ⚠️ High price impact ({form.slippage}%). Consider splitting into
                                smaller transactions.
                              </p>
                            )}
                          </>
                        );
                      })()}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-gray-500">Slippage tolerance:</span>
                        {SLIPPAGE_OPTIONS.map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => {
                              localStorage.setItem('afripay_slippage', s);
                              setForm({ ...form, slippage: s });
                            }}
                            className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                              form.slippage === s
                                ? 'border-primary-500 text-primary-400'
                                : 'border-gray-600 text-gray-400 hover:border-gray-400'
                            }`}
                          >
                            {s}%
                          </button>
                        ))}
                      </div>
                      <p className="text-xs text-gray-500">
                        Min received: {destMin} {form.destination_asset}
                      </p>
                    </div>
                  )}
                  {!pathLoading && pathResult && sendMode === 'receive' && (
                    <div className="space-y-1">
                      <p className="text-green-400">
                        Recipient receives exactly{' '}
                        <span className="font-semibold">
                          {form.amount} {form.destination_asset}
                        </span>
                      </p>
                      <p className="text-yellow-300 text-xs">
                        You pay approximately{' '}
                        <span className="font-semibold">
                          {pathResult.sourceAmount} {form.asset}
                        </span>
                      </p>
                      {(() => {
                        const srcAmt = parseFloat(pathResult.sourceAmount);
                        const dstAmt = parseFloat(form.amount);
                        if (!srcAmt || !dstAmt) return null;
                        const rate = (dstAmt / srcAmt).toPrecision(6);
                        return (
                          <>
                            <p className="text-xs text-gray-400">
                              Rate: 1 {form.asset} ≈ {rate} {form.destination_asset}
                            </p>
                            {form.slippage > 1 && (
                              <p className="text-xs text-yellow-400">
                                ⚠️ High price impact ({form.slippage}%). Consider splitting into
                                smaller transactions.
                              </p>
                            )}
                          </>
                        );
                      })()}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-gray-500">Max slippage:</span>
                        {SLIPPAGE_OPTIONS.map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => {
                              localStorage.setItem('afripay_slippage', s);
                              setForm({ ...form, slippage: s });
                            }}
                            className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                              form.slippage === s
                                ? 'border-primary-500 text-primary-400'
                                : 'border-gray-600 text-gray-400 hover:border-gray-400'
                            }`}
                          >
                            {s}%
                          </button>
                        ))}
                      </div>
                      <p className="text-xs text-gray-500">
                        Max you pay:{' '}
                        {(parseFloat(pathResult.sourceAmount) * (1 + form.slippage / 100)).toFixed(7)}{' '}
                        {form.asset}
                      </p>
                    </div>
                  )}
                  {!pathLoading && !pathResult && form.amount && form.recipient_address && (
                    <p className="text-yellow-500 text-xs">
                      No conversion path found for these assets
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Fee Priority */}
        <div>
          <label className="text-sm text-gray-400 mb-1 block">Network fee priority</label>
          <div className="flex gap-2">
            {[
              { key: 'economy', label: 'Economy', desc: 'Slower' },
              { key: 'standard', label: 'Standard', desc: 'Normal' },
              { key: 'priority', label: 'Priority', desc: 'Faster' },
            ].map(({ key, label, desc }) => (
              <button
                key={key}
                type="button"
                onClick={() => setForm({ ...form, fee_priority: key })}
                className={`flex-1 rounded-xl border py-2 px-2 text-center transition-colors ${
                  form.fee_priority === key
                    ? 'border-primary-500 bg-primary-500/10 text-primary-400'
                    : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-500'
                }`}
              >
                <p className="text-xs font-semibold">{label}</p>
                <p className="text-xs text-gray-500">{desc}</p>
                {feeStats?.priorities && (
                  <p className="text-xs text-gray-500 mt-0.5">
                    {(feeStats.priorities[key] / 1e7).toFixed(5)} XLM
                  </p>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Memo */}
        <div>
          <label className="text-sm text-gray-400 mb-1 block">{t('send.memo')}</label>
          <input
            ref={memoRef}
            type="text"
            maxLength={memoMaxLen}
            placeholder={t('send.memo_placeholder')}
            value={form.memo}
            onChange={(e) => {
              setForm({ ...form, memo: e.target.value });
              setMemoError(false);
              validateMemo(form.memo_type, e.target.value);
            }}
            placeholder={getMemoPlaceholder(form.memo_type)}
            className={`w-full bg-gray-800 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none transition-colors font-mono text-sm border ${
              memoError || hashMemoError
                ? 'border-red-500 focus:border-red-400'
                : 'border-gray-700 focus:border-primary-500'
            }`}
          />
          {memoError && (
            <p className="mt-1 text-xs text-red-400" role="alert">
              A memo is required for this recipient. Please add one before sending.
            </p>
          )}
          {hashMemoError && !memoError && (
            <p className="mt-1 text-xs text-red-400" role="alert">
              {hashMemoError}
            </p>
          )}
          {memoTrimmed ? (
            <div className="mt-2">
              <label className="text-sm text-gray-400 mb-1 block" htmlFor="memo-type">
                {t('send.memo_type_label')}
              </label>
              <select
                id="memo-type"
                value={form.memo_type}
                onChange={(e) => {
                  setForm({ ...form, memo_type: e.target.value });
                  validateMemo(e.target.value, form.memo);
                }}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-primary-500 transition-colors"
              >
                <option value="text">{t('send.memo_type_text')}</option>
                <option value="id">{t('send.memo_type_id')}</option>
                <option value="hash">{t('send.memo_type_hash')}</option>
                <option value="return">{t('send.memo_type_return')}</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">{t(`send.memo_hint_${form.memo_type}`)}</p>
            </div>
          ) : null}
        </div>

        {/* Private Note */}
        <div>
          <label className="text-sm text-gray-400 mb-1 block">
            Private note <span className="text-gray-600">(only visible to you)</span>
          </label>
          <input
            type="text"
            maxLength={500}
            placeholder="Invoice #, project code, personal reminder…"
            value={form.private_note}
            onChange={(e) => setForm({ ...form, private_note: e.target.value })}
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors"
          />
        </div>

        {/* Confirmation preview */}
        {confirmed && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 space-y-2">
            <p className="text-yellow-400 font-semibold text-sm">{t('send.confirm_title')}</p>
            <div className="text-sm text-gray-300 space-y-1">
              <p>
                {t('send.confirm_to')}{' '}
                <span
                  className="font-mono text-xs cursor-help border-b border-dotted border-gray-500"
                  title={form.recipient_address}
                  aria-label={`Full address: ${form.recipient_address}`}
                >
                  {form.recipient_address.slice(0, 10)}…{form.recipient_address.slice(-10)}
                </span>{' '}
                <a
                  href={`https://stellar.expert/explorer/${process.env.REACT_APP_STELLAR_NETWORK === 'mainnet' ? 'public' : 'testnet'}/account/${form.recipient_address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary-400 hover:text-primary-300 text-xs underline"
                  aria-label="Verify address on Stellar Expert Explorer"
                >
                  Verify address ↗
                </a>
              </p>
              <p>
                {t('send.confirm_amount')}{' '}
                <span className="text-white font-semibold">
                  {form.amount} {form.asset}
                </span>
              </p>
              {feeXLM && (
                <>
                  {form.asset !== 'XLM' ? (
                    <p>
                      <span className="font-semibold">Network fee:</span>{' '}
                      <span className="text-white">{feeXLM} XLM</span>{' '}
                      <span className="text-gray-400 text-xs">
                        (paid separately from your XLM balance)
                      </span>
                    </p>
                  ) : (
                    <p>
                      {t('send.confirm_fee', 'Network fee:')}{' '}
                      <span className="text-white">{feeXLM} XLM</span>
                    </p>
                  )}
                  {form.recipient_address.startsWith('C') && (
                    <div className="mt-4 p-3 bg-gray-800 rounded-lg text-sm border border-gray-700">
                      <p className="text-gray-400 font-semibold mb-1">Contract Simulation</p>
                      {contractSimLoading ? (
                        <p className="text-gray-500 animate-pulse">Simulating...</p>
                      ) : contractSimData?.error ? (
                        <p className="text-red-400 font-mono text-xs">{contractSimData.error}</p>
                      ) : contractSimData ? (
                        <div className="font-mono text-xs text-gray-300">
                          <p>Fee: {contractSimData.fee || 'N/A'}</p>
                          <p>Results: {contractSimData.results?.length ? 'Yes' : 'No'}</p>
                        </div>
                      ) : null}
                    </div>
                  )}
                  {form.asset === 'XLM' && (
                    <p className="text-yellow-300 font-semibold">
                      {t('send.confirm_total', 'Total:')}{' '}
                      {(parseFloat(form.amount) + parseFloat(feeXLM)).toFixed(7)} XLM
                    </p>
                  )}
                </>
              )}
              {/* Net amount recipient receives (issue #457) */}
              <p>
                Recipient receives:{' '}
                <span className="text-green-400 font-semibold">
                  {isCrossAsset && pathResult && sendMode === 'send'
                    ? `≈ ${pathResult.destinationAmount} ${form.destination_asset} (min ${destMin})`
                    : isCrossAsset && pathResult && sendMode === 'receive'
                    ? `${form.amount} ${form.destination_asset} (exact)`
                    : `${form.amount} ${form.asset}`}
                </span>
              </p>
              {isCrossAsset && pathResult && sendMode === 'receive' && (
                <p>
                  You pay approximately{' '}
                  <span className="text-white font-semibold">
                    {pathResult.sourceAmount} {form.asset}
                  </span>
                </p>
              )}
              {form.memo.trim() ? (
                <>
                  <p>
                    {t('send.confirm_memo')} {form.memo.trim()}
                  </p>
                  <p className="text-gray-400 text-xs">
                    {t('send.confirm_memo_type')} {t(`send.memo_type_${form.memo_type}`)}
                  </p>
                </>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setShowXDRInspector(true)}
              className="w-full mt-2 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm flex items-center justify-center gap-2 transition-colors"
            >
              <Code size={16} /> View Raw Transaction (XDR)
            </button>
          </div>
        )}

        <button
          ref={submitButtonRef}
          type="submit"
          disabled={
            loading ||
            (isCrossAsset && !pathResult) ||
            (memoRequired && !form.memo.trim()) ||
            !isMemoValid(form.memo_type, form.memo) ||
            addressError ||
            (!!form.recipient_address && !isValidStellarAddress(form.recipient_address))
          }
          className={`w-full font-semibold py-3.5 rounded-xl flex items-center justify-center gap-2 transition-colors ${
            confirmed
              ? 'bg-yellow-500 hover:bg-yellow-600 text-black'
              : 'bg-primary-500 hover:bg-primary-600 text-white'
          } disabled:opacity-50`}
        >
          {loading ? (
            <div
              className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin"
              role="status"
              aria-label="Loading"
            />
          ) : (
            <>
              <Send size={18} /> {confirmed ? t('send.confirm_send') : t('send.review')}
            </>
          )}
        </button>

        {confirmed && (
          <button
            type="button"
            onClick={() => {
              setConfirmed(false);
              setFeeXLM(null);
            }}
            className="w-full text-gray-400 hover:text-white text-sm py-2 transition-colors"
          >
            {t('common.cancel')}
          </button>
        )}

        {/* Ledger hardware wallet signing option — shown at confirmation step */}
        {confirmed && !isCrossAsset && (
          <button
            type="button"
            onClick={handleSignWithLedger}
            disabled={loading}
            className="w-full bg-gray-800 hover:bg-gray-700 border border-gray-600 text-white font-semibold py-3 rounded-xl flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
          >
            🔐 Sign with Ledger
          </button>
        )}
      </form>

      <LedgerSignModal
        show={showLedgerModal}
        onClose={() => setShowLedgerModal(false)}
        xdr={unsignedXDR}
        networkPassphrase={ledgerNetworkPassphrase}
        onSigned={handleLedgerSigned}
      />

      <QRScanner
        isOpen={showScanner}
        onClose={() => setShowScanner(false)}
        onScan={(address) => setForm({ ...form, recipient_address: address })}
      />

      <PINVerificationModal
        isOpen={showPINVerification}
        onClose={() => setShowPINVerification(false)}
        onSuccess={handlePINVerified}
        amount={`${form.amount} ${form.asset}`}
        recipient={form.recipient_address}
      />

      {/* XDR Inspector Modal */}
      <XDRInspectorModal
        isOpen={showXDRInspector}
        onClose={() => setShowXDRInspector(false)}
        xdr={transactionXDR}
      />
    </div>
  );
}
