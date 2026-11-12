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
      <div className="min-h-screen bg-ink flex items-center justify-center text-paper/80">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 border-4 border-line border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="text-sm font-medium">Verifying secure recovery token...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-ink flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-ink-raised border border-line rounded-xl p-8 text-center space-y-4">
          <div className="w-12 h-12 bg-stop/10 border border-stop/40 text-stop rounded-full flex items-center justify-center mx-auto text-xl font-bold">
            !
          </div>
          <h2 className="font-display text-3xl tracking-tight text-paper">Recovery link inactive</h2>
          <p className="text-sm text-muted">{error}</p>
          <p className="text-xs text-muted">
            For security, payment recovery links expire after 24 hours or after a single use. Please contact merchant support if you need assistance.
          </p>
        </div>
      </div>
    );
  }

  if (completed) {
    return (
      <div className="min-h-screen bg-ink flex items-center justify-center p-4 font-sans">
        <div className="max-w-lg w-full bg-ink-raised border border-signal/40 rounded-xl p-8 text-center space-y-6">
          <div className="w-16 h-16 bg-signal/10 border border-signal/40 text-signal rounded-full flex items-center justify-center mx-auto text-3xl font-bold">
            ✓
          </div>
          <div>
            <h2 className="font-display text-3xl tracking-tight text-paper">Payment received</h2>
            <p className="text-sm text-muted mt-1">
              Your subscription / order has been successfully reactivated.
            </p>
          </div>

          <div className="p-4 bg-ink rounded-xl border border-line text-left space-y-2 text-xs">
            <div className="flex justify-between text-muted">
              <span>Transaction ID:</span>
              <span className="font-mono text-paper">{receipt.transactionId}</span>
            </div>
            <div className="flex justify-between text-muted">
              <span>Amount Paid:</span>
              <span className="font-bold text-signal">₹{receipt.amount?.toLocaleString()} {receipt.currency}</span>
            </div>
            <div className="flex justify-between text-muted">
              <span>Status:</span>
              <span className="text-signal font-semibold uppercase">Captured / Recovered</span>
            </div>
          </div>

          <p className="text-xs text-muted">
            A confirmation receipt has been sent to your registered email address. This single-use recovery session is now closed.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ink text-paper p-4 md:p-12 font-sans flex items-center justify-center">
      <div className="max-w-xl w-full bg-ink-raised border border-line rounded-xl p-6 md:p-8 space-y-6">
        
        {/* Header */}
        <div className="border-b border-line pb-4">
          <div className="flex justify-between items-center">
            <span className="font-mono text-xs uppercase tracking-[0.14em] text-signal">RecoverIQ Secure Checkout</span>
            <span className="text-xs bg-line/60 text-muted px-2.5 py-0.5 rounded-full border border-line">
              Encrypted SSL
            </span>
          </div>
          <h1 className="mt-3 font-display text-4xl leading-none tracking-tight text-paper">Complete your payment</h1>
          <p className="text-xs text-muted mt-1">
            Hi {details.customerName}, your previous payment could not be processed. Update your payment method below to settle this balance.
          </p>
        </div>

        {/* Invoice Summary */}
        <div className="p-4 bg-ink rounded-xl border border-line space-y-2 text-sm">
          <div className="flex justify-between text-muted text-xs">
            <span>Customer:</span>
            <span className="text-paper font-medium">{details.customerEmail}</span>
          </div>
          <div className="flex justify-between text-muted text-xs">
            <span>Failure Reason:</span>
            <span className="text-hold font-medium">{details.failureReason}</span>
          </div>
          <div className="border-t border-line pt-2 flex justify-between items-center">
            <span className="text-paper/80 font-semibold">Total Due:</span>
            <span className="text-xl font-semibold text-signal">
              ₹{details.amount?.toLocaleString()} {details.currency}
            </span>
          </div>
        </div>

        {/* Payment Options */}
        <form onSubmit={handlePay} className="space-y-4">
          <label className="block text-xs font-semibold text-muted uppercase tracking-wider">
            Select Payment Method
          </label>

          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 'card', label: 'Card' },
              { id: 'upi', label: 'UPI' },
              { id: 'netbanking', label: 'Net banking' },
            ].map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setSelectedMethod(m.id)}
                className={`py-2.5 px-3 rounded-lg text-xs font-bold border transition ${
                  selectedMethod === m.id
                    ? 'border-signal bg-signal/10 text-paper'
                    : 'border-line bg-ink text-muted hover:border-muted'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* Card Mock Input Fields */}
          {selectedMethod === 'card' && (
            <div className="space-y-3 p-4 bg-ink rounded-xl border border-line text-xs">
              <div>
                <label className="block text-muted mb-1">Card Number</label>
                <input
                  type="text"
                  defaultValue="4111 •••• •••• 1111"
                  className="w-full px-3 py-2 bg-ink-raised border border-line rounded-lg text-paper focus:outline-2 focus:outline-offset-1 focus:outline-signal font-mono"
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-muted mb-1">Expiry Date</label>
                  <input
                    type="text"
                    defaultValue="12/28"
                    className="w-full px-3 py-2 bg-ink-raised border border-line rounded-lg text-paper focus:outline-2 focus:outline-offset-1 focus:outline-signal font-mono"
                    required
                  />
                </div>
                <div>
                  <label className="block text-muted mb-1">CVV / CVC</label>
                  <input
                    type="password"
                    defaultValue="888"
                    className="w-full px-3 py-2 bg-ink-raised border border-line rounded-lg text-paper focus:outline-2 focus:outline-offset-1 focus:outline-signal font-mono"
                    required
                  />
                </div>
              </div>
            </div>
          )}

          {selectedMethod === 'upi' && (
            <div className="p-4 bg-ink rounded-xl border border-line text-xs space-y-2">
              <label className="block text-muted">Enter UPI Virtual Payment Address (VPA)</label>
              <input
                type="text"
                defaultValue={`${details.customerEmail.split('@')[0]}@okaxis`}
                className="w-full px-3 py-2 bg-ink-raised border border-line rounded-lg text-paper focus:outline-2 focus:outline-offset-1 focus:outline-signal font-mono"
                required
              />
            </div>
          )}

          {selectedMethod === 'netbanking' && (
            <div className="p-4 bg-ink rounded-xl border border-line text-xs space-y-2">
              <label className="block text-muted">Choose Bank</label>
              <select className="w-full px-3 py-2 bg-ink-raised border border-line rounded-lg text-paper focus:outline-2 focus:outline-offset-1 focus:outline-signal">
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
            className="mt-2 w-full rounded-full bg-signal py-3 text-sm font-semibold text-ink transition-colors hover:bg-paper disabled:opacity-50"
          >
            {submitting ? 'Processing Payment...' : `Pay ₹${details.amount?.toLocaleString()} & Settle`}
          </button>
        </form>

        <p className="text-[11px] text-center text-muted">
          Powered by RecoverIQ Autonomous Recovery & Razorpay Test Integration.
        </p>

      </div>
    </div>
  );
}
