/**
 * RecoverIQ HTTP OpenTelemetry Tracing Middleware
 * Phase 6 - Step 3: OpenTelemetry Distributed Tracing
 *
 * Instruments incoming HTTP requests with OpenTelemetry Server Spans:
 * - Extracts W3C trace context from incoming HTTP request headers
 * - Enforces strictly normalized route templates to prevent cardinality explosion
 * - Sets standard semantic HTTP attributes (method, route, status code)
 * - Safely scrubbed: zero headers, tokens, cookies, or sensitive PII
 */

import { trace, context, SpanStatusCode, SpanKind } from '@opentelemetry/api';
import { extractTraceContext, getTracer, getCurrentTraceContext } from '../../services/observability/tracing.service.js';
import { MetricsService } from '../../services/metrics/index.js';

export function tracingMiddleware(req, res, next) {
  const parentContext = extractTraceContext(req.headers);
  const tracer = getTracer('recoveriq-http');
  const normalizedRoute = MetricsService.normalizeRoute(req);
  const spanName = `HTTP ${req.method} ${normalizedRoute}`;

  const span = tracer.startSpan(
    spanName,
    {
      kind: SpanKind.SERVER,
      attributes: {
        'http.request.method': req.method,
        'http.route': normalizedRoute,
        'service.name': 'recoveriq-backend',
        'component': 'http_server',
      },
    },
    parentContext
  );

  const spanContext = trace.setSpan(parentContext, span);

  // Set traceId in response headers for client tracing correlation
  const traceCtx = span.spanContext();
  if (traceCtx?.traceId) {
    res.setHeader('x-trace-id', traceCtx.traceId);
  }

  res.on('finish', () => {
    const statusCode = res.statusCode || 200;
    span.setAttribute('http.response.status_code', statusCode);

    // Update span name if route resolved after matching
    const finalRoute = MetricsService.normalizeRoute(req);
    if (finalRoute !== normalizedRoute) {
      span.updateName(`HTTP ${req.method} ${finalRoute}`);
      span.setAttribute('http.route', finalRoute);
    }

    if (statusCode >= 500) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: `HTTP ${statusCode}`,
      });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }

    span.end();
  });

  context.with(spanContext, () => {
    next();
  });
}
