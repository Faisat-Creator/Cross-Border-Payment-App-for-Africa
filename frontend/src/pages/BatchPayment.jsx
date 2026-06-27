import React, { useEffect, useRef, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Download, FileUp, Loader2, Plus, RotateCcw, Send, Trash2, Upload, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../utils/api';
import { CURRENCIES, truncateAddress } from '../utils/currency';

function createEmptyRecipient() {
  return { recipient_address: '', amount: '' };
}

function splitCsvLine(line) {
  const values = [];
  let current = '';
  let insideQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (insideQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
      continue;
    }

    if (char === ',' && !insideQuotes) {
      values.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

function parseRecipientsCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return [];

  const [headerLine, ...rows] = lines;
  const headers = splitCsvLine(headerLine).map((header) => header.toLowerCase());
  const addressIndex = headers.findIndex((header) =>
    ['recipient_address', 'address', 'wallet_address', 'recipient'].includes(header)
  );
  const amountIndex = headers.findIndex((header) => header === 'amount');

  if (addressIndex === -1 || amountIndex === -1) {
    throw new Error('CSV must include recipient_address and amount columns.');
  }

  return rows.map((row) => {
    const columns = splitCsvLine(row);
    return {
      recipient_address: columns[addressIndex] || '',
      amount: columns[amountIndex] || '',
    };
  }).filter((recipient) => recipient.recipient_address || recipient.amount);
}

export default function BatchPayment() {
  const navigate = useNavigate();
  const [asset, setAsset] = useState('XLM');
  const [memo, setMemo] = useState('');
  const [memoType, setMemoType] = useState('text');
  const [recipients, setRecipients] = useState([createEmptyRecipient()]);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState(null);
  const [batchId, setBatchId] = useState(null);
  const [rowStatuses, setRowStatuses] = useState({}); // { [index]: { status, error, txHash } }
  const [polling, setPolling] = useState(false);
  const stoppedRef = useRef(false);

  // Poll for per-row statuses after batch submission
  useEffect(() => {
    if (!polling || !batchId) return;
    stoppedRef.current = false;

    const pollOnce = async () => {
      if (stoppedRef.current) return;
      try {
        const res = await api.get(`/payments/batch/${batchId}/status`);
        const statuses = res.data.statuses || [];
        setRowStatuses((prev) => {
          const next = { ...prev };
          statuses.forEach((s) => {
            next[s.index] = { status: s.status, error: s.error, txHash: s.tx_hash };
          });
          return next;
        });
        const allTerminal =
          statuses.length > 0 &&
          statuses.every((s) => s.status === 'confirmed' || s.status === 'failed');
        if (allTerminal) {
          stoppedRef.current = true;
          setPolling(false);
        }
      } catch {
        // ignore polling errors
      }
    };

    pollOnce();
    const interval = setInterval(pollOnce, 3000);
    return () => {
      stoppedRef.current = true;
      clearInterval(interval);
    };
  }, [polling, batchId]);

  const batchSummary = useMemo(() => {
    const values = Object.values(rowStatuses);
    return {
      confirmed: values.filter((s) => s.status === 'confirmed').length,
      failed: values.filter((s) => s.status === 'failed').length,
      processing: values.filter((s) => s.status !== 'confirmed' && s.status !== 'failed').length,
    };
  }, [rowStatuses]);

  const handleRetry = async (rowIndex) => {
    setRowStatuses((prev) => ({ ...prev, [rowIndex]: { ...prev[rowIndex], status: 'pending' } }));
    try {
      await api.post(`/payments/batch/${batchId}/retry`, { index: rowIndex });
      if (!polling) setPolling(true);
    } catch (err) {
      setRowStatuses((prev) => ({
        ...prev,
        [rowIndex]: { status: 'failed', error: err.response?.data?.error || 'Retry failed' },
      }));
    }
  };

  const exportBatchCsv = () => {
    const header = 'recipient_address,amount,status,tx_hash,error';
    const rows = (results?.results || []).map((r) => {
      const s = rowStatuses[r.index] || {};
      return [r.recipient_address, r.amount, s.status || r.status || '', s.txHash || '', s.error || r.error || '']
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(',');
    });
    const csv = [header, ...rows].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'batch_results.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const filledRecipients = useMemo(
    () => recipients.filter((recipient) => recipient.recipient_address.trim() || recipient.amount),
    [recipients]
  );

  const totalAmount = useMemo(
    () => filledRecipients.reduce((sum, recipient) => sum + (parseFloat(recipient.amount) || 0), 0),
    [filledRecipients]
  );

  const handleRecipientChange = (index, field, value) => {
    setRecipients((current) =>
      current.map((recipient, currentIndex) =>
        currentIndex === index ? { ...recipient, [field]: value } : recipient
      )
    );
  };

  const handleCsvUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = parseRecipientsCsv(text);
      if (!parsed.length) {
        toast.error('No recipients found in the CSV file');
        return;
      }

      setRecipients(parsed.slice(0, 100));
      setResults(null);
      toast.success(`Imported ${Math.min(parsed.length, 100)} recipients`);
    } catch (error) {
      toast.error(error.message || 'Failed to parse CSV file');
    } finally {
      event.target.value = '';
    }
  };

  const addRecipient = () => {
    setRecipients((current) => [...current, createEmptyRecipient()].slice(0, 100));
  };

  const removeRecipient = (index) => {
    setRecipients((current) => {
      const next = current.filter((_, currentIndex) => currentIndex !== index);
      return next.length ? next : [createEmptyRecipient()];
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!filledRecipients.length) {
      toast.error('Add at least one recipient');
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        asset,
        recipients: filledRecipients.map((recipient) => ({
          recipient_address: recipient.recipient_address.trim(),
          amount: parseFloat(recipient.amount),
        })),
      };

      if (memo.trim()) {
        payload.memo = memo.trim();
        payload.memo_type = memoType;
      }

      const response = await api.post('/payments/batch', payload);
      const data = response.data;
      setResults(data);
      toast.success(data.message || 'Batch payment submitted');

      if (data.batch_id) {
        setBatchId(data.batch_id);
        const initial = {};
        filledRecipients.forEach((_, i) => { initial[i] = { status: 'pending' }; });
        setRowStatuses(initial);
        setPolling(true);
      }
    } catch (error) {
      const responseData = error.response?.data;
      if (responseData?.results) {
        setResults(responseData);
      }
      toast.error(responseData?.error || responseData?.message || 'Batch payment failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="px-4 py-6 max-w-5xl mx-auto space-y-6 pb-24">
      <button onClick={() => navigate(-1)} className="text-gray-400 hover:text-white flex items-center gap-1">
        <ArrowLeft size={18} /> Back
      </button>

      <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6 space-y-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.2em] text-primary-400">Bulk payouts</p>
            <h1 className="text-3xl font-bold text-white">Batch Payments</h1>
            <p className="text-gray-400 mt-2 max-w-2xl">
              Upload a CSV or paste recipients manually to send up to 100 Stellar payments in one transaction.
            </p>
          </div>

          <label className="inline-flex items-center gap-2 bg-primary-500 hover:bg-primary-600 text-white px-4 py-3 rounded-2xl cursor-pointer transition-colors">
            <Upload size={18} />
            <span>Import CSV</span>
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={handleCsvUpload} />
          </label>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <label className="text-sm text-gray-400 mb-2 block">Asset</label>
              <select
                value={asset}
                onChange={(event) => setAsset(event.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-2xl px-4 py-3 text-white"
              >
                {CURRENCIES.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.flag} {currency.code}
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <label className="text-sm text-gray-400 mb-2 block">Transaction memo (optional)</label>
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
                <input
                  type="text"
                  value={memo}
                  onChange={(event) => setMemo(event.target.value)}
                  maxLength={memoType === 'text' ? 28 : 64}
                  placeholder="Payroll for April"
                  className="w-full bg-gray-800 border border-gray-700 rounded-2xl px-4 py-3 text-white placeholder-gray-500"
                />
                <select
                  value={memoType}
                  onChange={(event) => setMemoType(event.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-2xl px-4 py-3 text-white"
                >
                  <option value="text">Text</option>
                  <option value="id">ID</option>
                  <option value="hash">Hash</option>
                  <option value="return">Return</option>
                </select>
              </div>
            </div>
          </div>

          <div className="bg-gray-950 border border-gray-800 rounded-3xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <div>
                <p className="text-sm text-gray-400">Recipients</p>
                <p className="text-xs text-gray-500">{filledRecipients.length}/100 rows ready</p>
              </div>
              <button
                type="button"
                onClick={addRecipient}
                disabled={recipients.length >= 100}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-white text-sm disabled:opacity-50"
              >
                <Plus size={16} /> Add row
              </button>
            </div>

            <div className="hidden md:grid md:grid-cols-[80px_minmax(0,1fr)_180px_72px] gap-3 px-4 py-3 text-xs uppercase tracking-[0.2em] text-gray-500 border-b border-gray-800">
              <span>Row</span>
              <span>Recipient Address</span>
              <span>Amount</span>
              <span>Delete</span>
            </div>

            <div className="divide-y divide-gray-800">
              {recipients.map((recipient, index) => (
                <div key={`${index}-${recipient.recipient_address}`} className="grid gap-3 px-4 py-4 md:grid-cols-[80px_minmax(0,1fr)_180px_72px] md:items-center">
                  <p className="text-xs uppercase tracking-[0.2em] text-gray-500 md:text-sm">{index + 1}</p>
                  <input
                    type="text"
                    value={recipient.recipient_address}
                    onChange={(event) => handleRecipientChange(index, 'recipient_address', event.target.value)}
                    placeholder="G..."
                    className="w-full bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 text-white placeholder-gray-500 font-mono text-sm"
                  />
                  <input
                    type="number"
                    min="0.0000001"
                    step="any"
                    value={recipient.amount}
                    onChange={(event) => handleRecipientChange(index, 'amount', event.target.value)}
                    placeholder="0.00"
                    className="w-full bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 text-white placeholder-gray-500"
                  />
                  <button
                    type="button"
                    onClick={() => removeRecipient(index)}
                    className="inline-flex items-center justify-center h-12 rounded-2xl bg-gray-900 border border-gray-700 text-red-400 hover:text-red-300"
                    aria-label={`Remove recipient ${index + 1}`}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="bg-gray-950 border border-gray-800 rounded-2xl p-4">
              <p className="text-gray-500 text-sm">Recipients</p>
              <p className="text-2xl font-semibold text-white mt-1">{filledRecipients.length}</p>
            </div>
            <div className="bg-gray-950 border border-gray-800 rounded-2xl p-4">
              <p className="text-gray-500 text-sm">Total amount</p>
              <p className="text-2xl font-semibold text-white mt-1">{totalAmount.toFixed(7)} {asset}</p>
            </div>
            <div className="bg-gray-950 border border-gray-800 rounded-2xl p-4">
              <p className="text-gray-500 text-sm">Transaction shape</p>
              <p className="text-white mt-1">One Stellar transaction, up to 100 payment operations.</p>
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting || !filledRecipients.length}
            className="w-full md:w-auto inline-flex items-center justify-center gap-2 bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white px-6 py-3 rounded-2xl font-semibold"
          >
            {submitting ? <FileUp size={18} className="animate-pulse" /> : <Send size={18} />}
            Submit Batch
          </button>
        </form>
      </div>

      {results && (
        <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6 space-y-5">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-2xl font-bold text-white">Batch Results</h2>
              {batchId ? (
                <div className="flex items-center gap-4 mt-1 text-sm">
                  <span className="text-green-400">{batchSummary.confirmed} confirmed</span>
                  <span className="text-red-400">{batchSummary.failed} failed</span>
                  {batchSummary.processing > 0 && (
                    <span className="text-blue-400 flex items-center gap-1">
                      <Loader2 size={13} className="animate-spin" />
                      {batchSummary.processing} processing
                    </span>
                  )}
                </div>
              ) : (
                <p className="text-gray-400 mt-1">
                  {results.summary?.successful || 0} succeeded, {results.summary?.failed || 0} failed.
                </p>
              )}
            </div>
            <div className="flex items-center gap-3">
              {results.transaction?.tx_hash && (
                <div className="text-sm text-gray-400">
                  <p>Ledger {results.transaction.ledger}</p>
                  <p className="font-mono text-xs">{results.transaction.tx_hash}</p>
                </div>
              )}
              {batchId && !polling && (
                <button
                  type="button"
                  onClick={exportBatchCsv}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm transition-colors"
                >
                  <Download size={15} /> Export CSV
                </button>
              )}
            </div>
          </div>

          <div className="space-y-3">
            {(results.results || []).map((result) => {
              const rowStatus = rowStatuses[result.index] || {};
              const displayStatus = rowStatus.status || result.status;
              const displayError = rowStatus.error || result.error;
              const isPending = displayStatus === 'pending';
              const isProcessing = displayStatus === 'processing';
              const isConfirmed = displayStatus === 'confirmed' || displayStatus === 'success';
              const isFailed = displayStatus === 'failed';

              return (
                <div
                  key={`${result.index}-${result.recipient_address}`}
                  className={`rounded-2xl border px-4 py-3 ${
                    isConfirmed
                      ? 'border-green-500/30 bg-green-500/10'
                      : isFailed
                      ? 'border-red-500/30 bg-red-500/10'
                      : 'border-gray-700 bg-gray-800/50'
                  }`}
                >
                  <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="text-white font-medium">
                        Row {result.index + 1}: {truncateAddress(result.recipient_address, 10)}
                      </p>
                      <p className="text-sm text-gray-300">{result.amount} {asset}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {isPending && <Loader2 size={16} className="animate-spin text-yellow-400" />}
                      {isProcessing && <Loader2 size={16} className="animate-spin text-blue-400" />}
                      {isConfirmed && <CheckCircle2 size={16} className="text-green-400" />}
                      {isFailed && <XCircle size={16} className="text-red-400" />}
                      <span className={
                        isConfirmed ? 'text-green-400' :
                        isFailed ? 'text-red-400' :
                        isPending ? 'text-yellow-400' :
                        'text-blue-400'
                      }>
                        {isConfirmed ? 'Confirmed' : isFailed ? 'Failed' : isPending ? 'Pending' : 'Processing'}
                      </span>
                      {isFailed && batchId && (
                        <button
                          type="button"
                          onClick={() => handleRetry(result.index)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs transition-colors"
                        >
                          <RotateCcw size={12} /> Retry
                        </button>
                      )}
                    </div>
                  </div>
                  {displayError && <p className="text-sm text-red-300 mt-2">{displayError}</p>}
                  {rowStatus.txHash && (
                    <p className="text-xs text-gray-500 font-mono mt-1 truncate">{rowStatus.txHash}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
