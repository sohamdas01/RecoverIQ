export function errorHandler(err, req, res, next) {
  console.error('[Error Middleware]:', err);
  const status = err.status || err.statusCode || 500;
  const isProduction = process.env.NODE_ENV === 'production';
  // Never expose internal error text (SQL, hostnames, stack) for server errors in production
  const message = status >= 500 && isProduction
    ? 'Internal Server Error'
    : (err.message || 'Internal Server Error');
  return res.status(status).json({
    success: false,
    error: {
      status,
      message,
      ...(process.env.NODE_ENV === 'development' ? { stack: err.stack } : {}),
    },
  });
}
