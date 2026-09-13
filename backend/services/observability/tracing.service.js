/**
 * RecoverIQ OpenTelemetry Distributed Tracing Service
 * Phase 6 - Step 3: OpenTelemetry Distributed Tracing
 *
 * Provides standardized OpenTelemetry tracing across service boundaries:
 * - W3C TraceContext propagation (HTTP headers & Kafka message headers)
 * - Safe low-cardinality span attributes (no credentials, tokens, PII, raw bodies)
 * - In-memory, console, and OTLP HTTP span exporters
 * - Configurable sampling (always_on, traceidratio, parentbased)
 * - Trace-to-log correlation (traceId & spanId injection into structured logs)
 * - Graceful degradation (exporter outages never alter recovery business logic)
 */

import {
  trace,
  context,
  propagation,
  SpanStatusCode,
  SpanKind,
  ROOT_CONTEXT,
} from '@opentelemetry/api';

export { SpanKind, SpanStatusCode, ROOT_CONTEXT, trace, context, propagation };
import * as sdkTraceBase from '@opentelemetry/sdk-trace-base';
import * as resourcesPkg from '@opentelemetry/resources';
import * as otlpPkg from '@opentelemetry/exporter-trace-otlp-http';
import * as asyncHooksPkg from '@opentelemetry/context-async-hooks';
import * as corePkg from '@opentelemetry/core';
import { config } from '../config/index.js';

const {
  BasicTracerProvider,
  SimpleSpanProcessor,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  InMemorySpanExporter,
  AlwaysOnSampler,
  AlwaysOffSampler,
  TraceIdRatioBasedSampler,
  ParentBasedSampler,
} = sdkTraceBase.default || sdkTraceBase;

const Resource = resourcesPkg.Resource || resourcesPkg.default?.Resource;
const OTLPTraceExporter = otlpPkg.OTLPTraceExporter || otlpPkg.default?.OTLPTraceExporter;
const AsyncLocalStorageContextManager = asyncHooksPkg.AsyncLocalStorageContextManager || asyncHooksPkg.default?.AsyncLocalStorageContextManager;
const W3CTraceContextPropagator = corePkg.W3CTraceContextPropagator || corePkg.default?.W3CTraceContextPropagator;

// Register W3C Trace Context Propagator for distributed traceparent propagation
if (W3CTraceContextPropagator) {
  try {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  } catch (_) {}
}

let contextManager = null;
let tracerProvider = null;
let activeExporter = null;
let isInitialized = false;

export const TRACE_COMPONENTS = {
  HTTP_SERVER: 'http_server',
  KAFKA_PRODUCER: 'kafka_producer',
  RECOVERY_CONSUMER: 'recovery_consumer',
  OUTCOME_CONSUMER: 'outcome_consumer',
  RECOVERY_ORCHESTRATOR: 'recovery_orchestrator',
  ML_CLIENT: 'ml_client',
  AGENT1_CLIENT: 'agent1_analyst_client',
  AGENT2_CLIENT: 'agent2_executor_client',
  POLICY_ENGINE: 'policy_engine',
  TOOL_EXECUTION: 'tool_execution',
  HITL_REVIEW: 'hitl_review',
  REPLAY_SERVICE: 'replay_service',
  DB_RECONCILIATION: 'db_reconciliation',
};

/**
 * TextMap Getter for Kafka Message Headers (supports String and Buffer values)
 */
export const kafkaHeaderGetter = {
  get(carrier, key) {
    if (!carrier || typeof carrier !== 'object') return undefined;
    const lowerKey = key.toLowerCase();
    for (const [k, v] of Object.entries(carrier)) {
      if (k.toLowerCase() === lowerKey) {
        if (v === undefined || v === null) return undefined;
        return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
      }
    }
    return undefined;
  },
  keys(carrier) {
    return carrier && typeof carrier === 'object' ? Object.keys(carrier) : [];
  },
};

/**
 * TextMap Setter for Kafka Message Headers (stores String values)
 */
export const kafkaHeaderSetter = {
  set(carrier, key, value) {
    if (!carrier || typeof carrier !== 'object') return;
    carrier[key] = String(value);
  },
};

/**
 * Creates the appropriate Sampler based on configuration
 */
function createSampler(samplerType = process.env.OTEL_TRACES_SAMPLER || 'always_on', ratioArg = process.env.OTEL_TRACES_SAMPLER_ARG) {
  const type = String(samplerType).toLowerCase();
  const ratio = parseFloat(ratioArg || '1.0');

  switch (type) {
    case 'always_off':
      return new AlwaysOffSampler();
    case 'traceidratio':
      return new TraceIdRatioBasedSampler(isNaN(ratio) ? 1.0 : ratio);
    case 'parentbased_traceidratio':
      return new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(isNaN(ratio) ? 1.0 : ratio),
      });
    case 'parentbased_always_on':
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
    case 'always_on':
    default:
      return new AlwaysOnSampler();
  }
}

/**
 * Initializes the OpenTelemetry Tracing SDK
 *
 * @param {Object} options Custom overrides for testing or initialization
 * @returns {BasicTracerProvider} Configured provider
 */
export function initTracing(options = {}) {
  if (isInitialized && !options.forceReinit) {
    return tracerProvider;
  }

  if (isInitialized && options.forceReinit) {
    if (tracerProvider) {
      try { tracerProvider.shutdown().catch(() => {}); } catch (_) {}
    }
    trace.disable();
    tracerProvider = null;
    activeExporter = null;
    isInitialized = false;
  }

  const serviceName = options.serviceName || process.env.OTEL_SERVICE_NAME || 'recoveriq-backend';
  const exporterType = (options.exporterType || process.env.OTEL_TRACES_EXPORTER || 'none').toLowerCase();

  const customAttrs = {
    'service.name': serviceName,
    'service.version': '1.0.0',
    'deployment.environment': config.env || 'development',
    ...(options.resourceAttributes || {}),
  };

  let resource;
  if (typeof resourcesPkg.resourceFromAttributes === 'function') {
    const defaultRes = typeof resourcesPkg.defaultResource === 'function' ? resourcesPkg.defaultResource() : null;
    const customRes = resourcesPkg.resourceFromAttributes(customAttrs);
    resource = defaultRes && defaultRes.merge ? defaultRes.merge(customRes) : customRes;
  } else if (typeof Resource === 'function') {
    resource = new Resource(customAttrs);
  }

  const spanProcessors = [];
  if (options.exporter) {
    activeExporter = options.exporter;
    spanProcessors.push(new SimpleSpanProcessor(activeExporter));
  } else if (exporterType === 'memory' || options.inMemory) {
    activeExporter = new InMemorySpanExporter();
    spanProcessors.push(new SimpleSpanProcessor(activeExporter));
  } else if (exporterType === 'console') {
    activeExporter = new ConsoleSpanExporter();
    spanProcessors.push(new SimpleSpanProcessor(activeExporter));
  } else if (exporterType === 'otlp' || process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    try {
      const endpoint = options.otlpEndpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces';
      activeExporter = new OTLPTraceExporter({
        url: endpoint,
        headers: options.otlpHeaders || {},
      });
      spanProcessors.push(new BatchSpanProcessor(activeExporter, {
        maxQueueSize: 2048,
        scheduledDelayMillis: 500,
      }));
    } catch (err) {
      console.warn(`[Tracing] Failed to initialize OTLP exporter, continuing without remote export: ${err.message}`);
    }
  }

  const sampler = options.sampler || createSampler(options.samplerType, options.samplerArg);

  tracerProvider = new BasicTracerProvider({
    resource,
    sampler,
    spanProcessors,
  });

  if (!contextManager && AsyncLocalStorageContextManager) {
    try {
      contextManager = new AsyncLocalStorageContextManager();
      contextManager.enable();
      context.setGlobalContextManager(contextManager);
    } catch (_) {}
  }

  trace.setGlobalTracerProvider(tracerProvider);
  isInitialized = true;
  return tracerProvider;
}

/**
 * Retrieves the configured Tracer instance
 *
 * @param {string} name Tracer name
 * @returns {Tracer}
 */
export function getTracer(name = 'recoveriq-tracer') {
  return trace.getTracer(name);
}

/**
 * Returns the active InMemorySpanExporter if active (useful for testing)
 */
export function getActiveExporter() {
  return activeExporter;
}

/**
 * Shuts down tracing and cleans up processors
 */
export async function shutdownTracing() {
  if (tracerProvider) {
    await tracerProvider.shutdown().catch(() => {});
    trace.disable();
    tracerProvider = null;
    activeExporter = null;
    isInitialized = false;
  }
}

/**
 * Retrieves the currently active OpenTelemetry span
 */
export function getActiveSpan() {
  return trace.getSpan(context.active());
}

/**
 * Returns active traceId, spanId, and traceFlags if a span is active
 */
export function getCurrentTraceContext() {
  const span = trace.getSpan(context.active());
  if (!span) {
    return { traceId: null, spanId: null, traceFlags: null };
  }
  const spanContext = span.spanContext();
  return {
    traceId: spanContext.traceId || null,
    spanId: spanContext.spanId || null,
    traceFlags: spanContext.traceFlags !== undefined ? spanContext.traceFlags : null,
  };
}

/**
 * Injects W3C trace context into an outbound carrier (HTTP headers or Kafka message headers)
 *
 * @param {Object} carrier Headers object to mutate
 * @param {Object} [ctx] Optional context (defaults to active context)
 * @param {Object} [setter] Optional setter
 */
export function injectTraceContext(carrier = {}, ctx = context.active(), setter = undefined) {
  if (!carrier || typeof carrier !== 'object') return carrier;
  propagation.inject(ctx, carrier, setter);
  return carrier;
}

/**
 * Extracts W3C trace context from an inbound carrier (HTTP headers or Kafka message headers)
 *
 * @param {Object} carrier Inbound headers
 * @param {Object} [getter] Optional getter
 * @returns {Context} Extracted OpenTelemetry context
 */
export function extractTraceContext(carrier = {}, getter = undefined) {
  if (!carrier || typeof carrier !== 'object') return ROOT_CONTEXT;
  return propagation.extract(context.active(), carrier, getter);
}

/**
 * Executes a function inside an OpenTelemetry Span with automatic completion and error status recording
 *
 * @param {string} spanName Name of the span (e.g. 'recovery.pipeline', 'policy.evaluation')
 * @param {Object} options Span creation options (kind, attributes, parentContext)
 * @param {Function} fn Async or sync callback to execute: (span) => Promise<any> | any
 * @returns {Promise<any>} Result of fn
 */
export async function withSpan(spanName, options = {}, fn) {
  const tracer = getTracer(options.tracerName || 'recoveriq-tracer');
  const parentCtx = options.parentContext || context.active();

  const spanOptions = {
    kind: options.kind || SpanKind.INTERNAL,
    attributes: options.attributes || {},
  };

  const span = tracer.startSpan(spanName, spanOptions, parentCtx);
  const spanCtx = trace.setSpan(parentCtx, span);

  return context.with(spanCtx, async () => {
    try {
      const result = await fn(span);
      if (options.recordResult !== false && result !== undefined && result !== null) {
        if (typeof result === 'object' && result.status) {
          span.setAttribute('operation.result', String(result.status));
        }
      }
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message || 'Operation failed',
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

// Ensure default tracer is initialized safely on module load
initTracing();
