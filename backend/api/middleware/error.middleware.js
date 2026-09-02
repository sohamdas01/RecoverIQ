export function errorHandler(err, req, res, next) {
  console.error('[Error Middleware]:', err);
  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';
  return res.status(status).json({
    success: false,
    error: {
      status,
      message,
      ...(process.env.NODE_ENV === 'development' ? { stack: err.stack } : {}),
    },
  });
}
