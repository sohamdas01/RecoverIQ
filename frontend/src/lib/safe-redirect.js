/**
 * Only same-origin, absolute-path redirects are honoured after sign-in. Anything else
 * (other hosts, protocol-relative `//evil`, `javascript:`, backslash tricks, control
 * characters) falls back to the dashboard, so the `?next=` parameter cannot be used as
 * an open redirect.
 */
export function safeNextPath(next, fallback = '/dashboard') {
  if (typeof next !== 'string' || next.length === 0) return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return fallback;
  for (let i = 0; i < next.length; i++) {
    const code = next.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return fallback;
  }
  return next;
}
