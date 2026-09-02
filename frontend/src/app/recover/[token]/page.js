'use client';

import React, { useEffect, useState, use } from 'react';
import { getRecoveryDetails, submitRecoveryPayment } from '../../../lib/api';

export default function CustomerRecoveryPage({ params }) {
  const unwrappedParams = use(params);
  const { token } = unwrappedParams;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [details, setDetails] = useState(null);
  const [selectedMethod, setSelectedMethod] = useState('card');
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [receipt, setReceipt] = useState(null);

  useEffect(() => {
    async function loadDetails() {
      try {
        setLoading(true);
        const res = await getRecoveryDetails(token);
        if (res.success) {
          setDetails(res.data);
        } else {
          setError(res.message || 'Invalid or expired recovery link');
        }
      } catch (err) {
        setError(err.message || 'Failed to retrieve invoice information');
      } finally {
        setLoading(false);
      }
    }
    if (token) {
      loadDetails();
    }
  }, [token]);

  const handlePay = async (e) => {
    e?.preventDefault();
    setSubmitting(true);
    try {
      const res = await submitRecoveryPayment(token, {
        paymentMethod: selectedMethod,
      });
      if (res.success) {
        setReceipt(res);
        setCompleted(true);
      } else {
        alert(res.message || 'Payment processing failed');
      }
    } catch (err) {
      alert('Payment failed: ' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-300">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="text-sm font-medium">Verifying secure recovery token...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center space-y-4 shadow-2xl">
          <div className="w-12 h-12 bg-rose-950 border border-rose-800 text-rose-400 rounded-full flex items-center justify-center mx-auto text-xl font-bold">
            !
          </div>
          <h2 className="text-xl font-bold text-white">Recovery Link Inactive</h2>
          <p className="text-sm text-slate-400">{error}</p>
          <p className="text-xs text-slate-500">
            For security, payment recovery links expire after 24 hours or after a single use. Please contact merchant support if you need assistance.
          </p>
        </div>
      </div>
    );
  }

  if (completed) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4 font-sans">
        <div className="max-w-lg w-full bg-slate-900 border border-emerald-800/60 rounded-2xl p-8 text-center space-y-6 shadow-2xl">
          <div className="w-16 h-16 bg-emerald-950 border border-emerald-700 text-emerald-400 rounded-full flex items-center justify-center mx-auto text-3xl font-bold">
            ✓
          </div>
          <div>
            <h2 className="text-2xl font-bold text-white">Payment Recovered & Confirmed!</h2>
            <p className="text-sm text-slate-400 mt-1">
              Your subscription / order has been successfully reactivated.
            </p>
          </div>

          <div className="p-4 bg-slate-950 rounded-xl border border-slate-800 text-left space-y-2 text-xs">
            <div className="flex justify-between text-slate-400">
              <span>Transaction ID:</span>
              <span className="font-mono text-slate-200">{receipt.transactionId}</span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>Amount Paid:</span>
              <span className="font-bold text-emerald-400">₹{receipt.amount?.toLocaleString()} {receipt.currency}</span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>Status:</span>
              <span className="text-emerald-400 font-semibold uppercase">Captured / Recovered</span>
            </div>
          </div>

          <p className="text-xs text-slate-500">
            A confirmation receipt has been sent to your registered email address. This single-use recovery session is now closed.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-12 font-sans flex items-center justify-center">
      <div className="max-w-xl w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 md:p-8 shadow-2xl space-y-6">
        
        {/* Header */}
        <div className="border-b border-slate-800 pb-4">
          <div className="flex justify-between items-center">
            <span className="text-xs font-bold uppercase tracking-wider text-indigo-400">RecoverIQ Secure Checkout</span>
            <span className="text-xs bg-slate-800 text-slate-400 px-2.5 py-0.5 rounded-full border border-slate-700">
              Encrypted SSL
            </span>
          </div>
          <h1 className="text-2xl font-extrabold text-white mt-2">Complete Your Payment</h1>
          <p className="text-xs text-slate-400 mt-1">
            Hi {details.customerName}, your previous payment could not be processed. Update your payment method below to settle this balance.
          </p>
        </div>

        {/* Invoice Summary */}
        <div className="p-4 bg-slate-950 rounded-xl border border-slate-800 space-y-2 text-sm">
          <div className="flex justify-between text-slate-400 text-xs">
            <span>Customer:</span>
            <span className="text-slate-200 font-medium">{details.customerEmail}</span>
          </div>
          <div className="flex justify-between text-slate-400 text-xs">
            <span>Failure Reason:</span>
            <span className="text-amber-400 font-medium">{details.failureReason}</span>
          </div>
          <div className="border-t border-slate-800 pt-2 flex justify-between items-center">
            <span className="text-slate-300 font-semibold">Total Due:</span>
            <span className="text-xl font-extrabold text-emerald-400">
              ₹{details.amount?.toLocaleString()} {details.currency}
            </span>
          </div>
        </div>

        {/* Payment Options */}
        <form onSubmit={handlePay} className="space-y-4">
          <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
            Select Payment Method
          </label>

          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 'card', label: '💳 New Card' },
              { id: 'upi', label: '⚡ UPI' },
              { id: 'netbanking', label: '🏦 Net Banking' },
            ].map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setSelectedMethod(m.id)}
                className={`py-2.5 px-3 rounded-lg text-xs font-bold border transition ${
                  selectedMethod === m.id
                    ? 'bg-indigo-600/20 border-indigo-500 text-white'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* Card Mock Input Fields */}
          {selectedMethod === 'card' && (
            <div className="space-y-3 p-4 bg-slate-950 rounded-xl border border-slate-800 text-xs">
              <div>
                <label className="block text-slate-400 mb-1">Card Number</label>
                <input
                  type="text"
                  defaultValue="4111 •••• •••• 1111"
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Expiry Date</label>
                  <input
                    type="text"
                    defaultValue="12/28"
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                    required
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">CVV / CVC</label>
                  <input
                    type="password"
                    defaultValue="888"
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                    required
                  />
                </div>
              </div>
            </div>
          )}

          {selectedMethod === 'upi' && (
            <div className="p-4 bg-slate-950 rounded-xl border border-slate-800 text-xs space-y-2">
              <label className="block text-slate-400">Enter UPI Virtual Payment Address (VPA)</label>
              <input
                type="text"
                defaultValue={`${details.customerEmail.split('@')[0]}@okaxis`}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                required
              />
            </div>
          )}

          {selectedMethod === 'netbanking' && (
            <div className="p-4 bg-slate-950 rounded-xl border border-slate-800 text-xs space-y-2">
              <label className="block text-slate-400">Choose Bank</label>
              <select className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-indigo-500">
                <option>HDFC Bank</option>
                <option>ICICI Bank</option>
                <option>State Bank of India (SBI)</option>
                <option>Axis Bank</option>
              </select>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-3 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold rounded-xl shadow-lg shadow-emerald-500/20 transition disabled:opacity-50 text-sm mt-2"
          >
            {submitting ? 'Processing Payment...' : `Pay ₹${details.amount?.toLocaleString()} & Settle`}
          </button>
        </form>

        <p className="text-[11px] text-center text-slate-500">
          Powered by RecoverIQ Autonomous Recovery & Razorpay Test Integration.
        </p>

      </div>
    </div>
  );
}
