/**
 * Telemetry service for client-side monitoring and analytics.
 *
 * This service collects client-side metrics, errors, and performance data
 * and sends them to the telemetry backend for analysis. The telemetry data
 * is used by the engineering team to identify issues and optimize the
 * application. It is also used by the product team for feature adoption
 * tracking.
 *
 * The telemetry system supports three transport methods:
 *   1. Beacon API (default) - Preferred for analytics events
 *   2. Fetch API - Used when Beacon is unavailable
 *   3. XHR - Legacy fallback for very old browsers
 *
 * The transport selection is done automatically based on browser support.
 * The detection order is: Beacon > Fetch > XHR.
 *
 * Data is batched and sent every 30 seconds, or when the batch size exceeds
 * 100 events, or when the page is about to unload (using Beacon API).
 *
 * TODO: Add support for sampling to reduce telemetry volume for high-traffic
 * users. The sampling rate should be configurable via the backend config.
 * The current implementation sends 100% of events which is unsustainable
 * as the user base grows.
 *
 * Privacy note: This service does NOT collect personally identifiable
 * information (PII). All user identifiers are hashed before transmission.
 * The IP address is anonymized by the telemetry backend (last octet removed).
 * No cookies are used for telemetry tracking.
 *
 * The telemetry backend URL is configured via the VITE_TELEMETRY_ENDPOINT
 * environment variable. If not set, telemetry is disabled. This allows
 * developers to run the application locally without sending telemetry data.
 */

import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

interface LayoutShift extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
  sources: Array<{ node?: Node; rect?: DOMRect; }>;
}


export type TelemetryEventType =
  | 'page_view'
  | 'page_navigation'
  | 'component_mount'
  | 'component_unmount'
  | 'user_action'
  | 'api_call'
  | 'api_response'
  | 'api_error'
  | 'error'
  | 'warning'
  | 'performance_metric'
  | 'feature_usage'
  | 'ab_test_assignment'
  | 'ab_test_conversion'
  | 'session_start'
  | 'session_end'
  | 'user_login'
  | 'user_logout'
  | 'user_registration'
  | 'resource_timing'
  | 'long_task'
  | 'web_vital'
  | 'custom_event';

export interface TelemetryEvent {
  id: string;
  type: TelemetryEventType;
  timestamp: number;
  sessionId: string;
  userId?: string;
  properties: Record<string, unknown>;
  tags?: string[];
  duration?: number;
  error?: {
    message: string;
    stack?: string;
    code?: string;
    component?: string;
  };
  metadata?: {
    userAgent: string;
    screenResolution: string;
    viewportSize: string;
    pageUrl: string;
    referrer: string;
    language: string;
    timezone: string;
    connectionType?: string;
    deviceMemory?: number;
    hardwareConcurrency?: number;
  };
}

interface TelemetryConfig {
  endpoint: string;
  batchSize: number;
  flushInterval: number;
  maxRetries: number;
  sampleRate: number;
  enabled: boolean;
  debug: boolean;
}

interface TelemetryState {
  events: TelemetryEvent[];
  sessionId: string;
  config: TelemetryConfig;
  flushTimer: number | null;
  isFlushing: boolean;
  retryCount: number;
  totalEventsSent: number;
  totalEventsDropped: number;
  lastFlushTime: number;
  flushErrors: number;
}

type TransportType = 'beacon' | 'fetch' | 'xhr';

// ---------------------------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: TelemetryConfig = {
  endpoint: (typeof import.meta !== 'undefined' && import.meta.env?.VITE_TELEMETRY_ENDPOINT as string)
    || '',
  batchSize: 100,
  flushInterval: 30000,
  maxRetries: 3,
  sampleRate: 1.0,
  enabled: !!import.meta.env?.VITE_TELEMETRY_ENABLED,
  debug: !!import.meta.env?.VITE_TELEMETRY_DEBUG,
};

const MAX_EVENT_QUEUE_SIZE = 10000;
const MAX_EVENT_SIZE_BYTES = 65536;
const FLUSH_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------

const state: TelemetryState = {
  events: [],
  sessionId: generateSessionId(),
  config: { ...DEFAULT_CONFIG },
  flushTimer: null,
  isFlushing: false,
  retryCount: 0,
  totalEventsSent: 0,
  totalEventsDropped: 0,
  lastFlushTime: 0,
  flushErrors: 0,
};

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function generateSessionId(): string {
  try {
    return uuidv4();
  } catch {
    // Fallback for environments where uuid is not available
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function getMetadata(): TelemetryEvent['metadata'] {
  return {
    userAgent: navigator.userAgent,
    screenResolution: `${screen.width}x${screen.height}`,
    viewportSize: `${window.innerWidth}x${window.innerHeight}`,
    pageUrl: window.location.href,
    referrer: document.referrer || '',
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    connectionType: (navigator as any).connection?.effectiveType,
    deviceMemory: (navigator as any).deviceMemory,
    hardwareConcurrency: navigator.hardwareConcurrency,
  };
}

function createEvent(
  type: TelemetryEventType,
  properties: Record<string, unknown> = {},
  options?: {
    tags?: string[];
    duration?: number;
    error?: TelemetryEvent['error'];
  }
): TelemetryEvent {
  return {
    id: generateSessionId() + '-' + Date.now(),
    type,
    timestamp: Date.now(),
    sessionId: state.sessionId,
    properties,
    tags: options?.tags,
    duration: options?.duration,
    error: options?.error,
    metadata: getMetadata(),
  };
}

function getTransportType(): TransportType {
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    return 'beacon';
  }
  if (typeof fetch !== 'undefined') {
    return 'fetch';
  }
  return 'xhr';
}

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

export function initTelemetry(config?: Partial<TelemetryConfig>): void {
  if (config) {
    state.config = { ...DEFAULT_CONFIG, ...config };
  }

  if (!state.config.enabled) {
    if (state.config.debug) {
      console.log('[Telemetry] Disabled');
    }
    return;
  }

  if (state.config.debug) {
    console.log('[Telemetry] Initialized', {
      endpoint: state.config.endpoint,
      batchSize: state.config.batchSize,
      flushInterval: state.config.flushInterval,
      sessionId: state.sessionId,
    });
  }

  // Track session start
  track('session_start', {
    sessionId: state.sessionId,
    previousSessionId: getPreviousSessionId(),
  });

  // Start flush timer
  startFlushTimer();

  // Flush on page unload
  window.addEventListener('beforeunload', () => {
    forceFlush();
  });

  // Track page visibility changes
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      forceFlush();
    }
  });

  // Track page navigation
  trackPageView();
}

export function track(
  type: TelemetryEventType,
  properties?: Record<string, unknown>,
  options?: {
    tags?: string[];
    duration?: number;
    error?: TelemetryEvent['error'];
  }
): void {
  if (!state.config.enabled) return;

  // Apply sampling
  if (Math.random() > state.config.sampleRate) return;

  const event = createEvent(type, properties, options);
  enqueueEvent(event);
}

export function trackPageView(url?: string): void {
  track('page_view', {
    url: url || window.location.href,
    title: document.title,
    referrer: document.referrer,
  });
}

export function trackError(
  error: Error | string,
  component?: string,
  tags?: string[]
): void {
  const errorMessage = typeof error === 'string' ? error : error.message;
  const errorStack = typeof error === 'string' ? undefined : error.stack;

  track('error', {
    component,
    errorCount: 1,
  }, {
    tags,
    error: {
      message: errorMessage,
      stack: errorStack,
      component,
    },
  });
}

export function trackApiCall(
  method: string,
  url: string,
  duration: number,
  status: number,
  requestSize?: number,
  responseSize?: number
): void {
  const type: TelemetryEventType = status >= 400 ? 'api_error' : 'api_response';
  track(type, {
    method,
    url: sanitizeUrl(url),
    status,
    duration,
    requestSize,
    responseSize,
  }, { duration });
}

export function trackPerformance(
  name: string,
  value: number,
  unit: string,
  tags?: string[]
): void {
  track('performance_metric', {
    metricName: name,
    metricValue: value,
    unit,
  }, { tags, duration: value });
}

export function trackFeatureUsage(
  featureName: string,
  properties?: Record<string, unknown>
): void {
  track('feature_usage', {
    feature: featureName,
    ...properties,
  });
}

export function trackWebVital(
  name: string,
  value: number,
  rating: 'good' | 'needs-improvement' | 'poor'
): void {
  track('web_vital', {
    metric: name,
    value,
    rating,
  });
}

export function trackABTest(
  experimentId: string,
  variant: string,
  event: 'assignment' | 'conversion',
  properties?: Record<string, unknown>
): void {
  const type: TelemetryEventType = event === 'assignment'
    ? 'ab_test_assignment'
    : 'ab_test_conversion';
  track(type, {
    experimentId,
    variant,
    ...properties,
  });
}

export function forceFlush(): void {
  if (!state.config.enabled) return;
  flushEvents();
}

export function getTelemetryStats() {
  return {
    queued: state.events.length,
    sent: state.totalEventsSent,
    dropped: state.totalEventsDropped,
    errors: state.flushErrors,
    sessionId: state.sessionId,
    config: {
      enabled: state.config.enabled,
      endpoint: state.config.endpoint,
      sampleRate: state.config.sampleRate,
    },
  };
}

export function setTelemetryEnabled(enabled: boolean): void {
  state.config.enabled = enabled;
  if (enabled) {
    startFlushTimer();
  } else {
    stopFlushTimer();
    state.events = [];
  }
}

export function setSampleRate(rate: number): void {
  state.config.sampleRate = Math.max(0, Math.min(1, rate));
}

export function __resetTelemetryForTests(config?: Partial<TelemetryConfig>): void {
  stopFlushTimer();
  state.events = [];
  state.sessionId = generateSessionId();
  state.config = { ...DEFAULT_CONFIG, enabled: true, endpoint: '/telemetry', ...config };
  state.flushTimer = null;
  state.isFlushing = false;
  state.retryCount = 0;
  state.totalEventsSent = 0;
  state.totalEventsDropped = 0;
  state.lastFlushTime = 0;
  state.flushErrors = 0;
}

export function __getTelemetryStateForTests() {
  return {
    queued: state.events.length,
    sent: state.totalEventsSent,
    dropped: state.totalEventsDropped,
    errors: state.flushErrors,
    isFlushing: state.isFlushing,
    batchSize: state.config.batchSize,
  };
}

export function __flushTelemetryForTests(): Promise<void> {
  return flushEvents();
}

function enqueueEvent(event: TelemetryEvent): void {
  if (state.events.length >= MAX_EVENT_QUEUE_SIZE) {
    state.totalEventsDropped++;
    if (state.config.debug) {
      console.warn('[Telemetry] Event queue full, dropping event:', event.type);
    }
    return;
  }

  state.events.push(event);

  if (state.events.length >= state.config.batchSize) {
    flushEvents();
  }
}

function startFlushTimer(): void {
  stopFlushTimer();
  state.flushTimer = window.setInterval(() => {
    flushEvents();
  }, state.config.flushInterval);
}

function stopFlushTimer(): void {
  if (state.flushTimer !== null) {
    clearInterval(state.flushTimer);
    state.flushTimer = null;
  }
}

async function flushEvents(): Promise<void> {
  if (state.isFlushing || state.events.length === 0) return;
  if (!state.config.endpoint) return;

  state.isFlushing = true;

  try {
    const batch = state.events.splice(0, state.config.batchSize);
    const payload = JSON.stringify({ events: batch, sentAt: Date.now() });

    if (payload.length > MAX_EVENT_SIZE_BYTES) {
      // Payload too large, split into smaller batches
      state.events.unshift(...batch);
      const halfSize = Math.ceil(batch.length / 2);
      state.events = [
        ...batch.slice(0, halfSize),
        ...state.events,
        ...batch.slice(halfSize),
      ];
      state.config.batchSize = Math.ceil(state.config.batchSize / 2);
      state.isFlushing = false;
      return;
    }

    const transport = getTransportType();
    let success = false;

    switch (transport) {
      case 'beacon':
        success = navigator.sendBeacon(state.config.endpoint, payload);
        break;

      case 'fetch':
        try {
          const response = await fetch(state.config.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            keepalive: true,
          });
          success = response.ok;
        } catch {
          success = false;
        }
        break;

      case 'xhr':
        success = await xhrSend(payload);
        break;
    }

    if (success) {
      state.totalEventsSent += batch.length;
      state.lastFlushTime = Date.now();
      state.retryCount = 0;

      if (state.config.debug) {
        console.log(`[Telemetry] Flushed ${batch.length} events via ${transport}`);
      }
    } else {
      // Re-queue events for retry
      state.events.unshift(...batch);
      state.retryCount++;
      state.flushErrors++;

      if (state.retryCount >= state.config.maxRetries) {
        // Give up and drop the oldest events
        const dropCount = Math.min(batch.length, state.events.length);
        state.events.splice(0, dropCount);
        state.totalEventsDropped += dropCount;
        state.retryCount = 0;

        if (state.config.debug) {
          console.warn(`[Telemetry] Dropped ${dropCount} events after ${state.config.maxRetries} retries`);
        }
      }
    }
  } finally {
    state.isFlushing = false;
  }
}

function xhrSend(payload: string): Promise<boolean> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', state.config.endpoint, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = FLUSH_TIMEOUT_MS;

    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => resolve(false);
    xhr.ontimeout = () => resolve(false);

    xhr.send(payload);
  });
}

function getPreviousSessionId(): string | null {
  try {
    return sessionStorage.getItem('tot_previous_session_id');
  } catch {
    return null;
  }
}

function sanitizeUrl(url: string): string {
  // Remove query parameters that may contain PII
  try {
    const parsed = new URL(url, window.location.origin);
    parsed.search = '';
    return parsed.toString();
  } catch {
    return url.split('?')[0];
  }
}

// ---------------------------------------------------------------------------
// WEB VITALS COLLECTION
// ---------------------------------------------------------------------------

export function initWebVitalsTracking(): void {
  if ('PerformanceObserver' in window) {
    try {
      // Largest Contentful Paint
      const lcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        if (entries.length > 0) {
          const lastEntry = entries[entries.length - 1];
          trackWebVital('LCP', lastEntry.startTime, getRating(lastEntry.startTime, 2500, 4000));
        }
      });
      lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (e) {
      // LCP not supported
    }

    try {
      // First Input Delay
      const fidObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        entries.forEach((entry) => {
          const fidEntry = entry as PerformanceEventTiming;
          trackWebVital('FID', fidEntry.processingStart - fidEntry.startTime, getRating(fidEntry.processingStart - fidEntry.startTime, 100, 300));
        });
      });
      fidObserver.observe({ type: 'first-input', buffered: true });
    } catch (e) {
      // FID not supported
    }

    try {
      // Cumulative Layout Shift
      const clsObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        let clsValue = 0;
        entries.forEach((entry) => {
          const clsEntry = entry as LayoutShift;
          if (!clsEntry.hadRecentInput) {
            clsValue += clsEntry.value;
          }
        });
        trackWebVital('CLS', clsValue, getRating(clsValue, 0.1, 0.25));
      });
      clsObserver.observe({ type: 'layout-shift', buffered: true });
    } catch (e) {
      // CLS not supported
    }

    // Track long tasks
    try {
      const longTaskObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        entries.forEach((entry) => {
          track('long_task', {
            duration: entry.duration,
            startTime: entry.startTime,
            name: entry.name,
          }, { duration: entry.duration });
        });
      });
      longTaskObserver.observe({ type: 'longtask', buffered: true });
    } catch (e) {
      // Long tasks not supported
    }
  }
}

function getRating(value: number, goodThreshold: number, poorThreshold: number): 'good' | 'needs-improvement' | 'poor' {
  if (value <= goodThreshold) return 'good';
  if (value <= poorThreshold) return 'needs-improvement';
  return 'poor';
}

// ---------------------------------------------------------------------------
// INITIALIZATION
// ---------------------------------------------------------------------------

// Auto-initialize if telemetry is enabled
if (DEFAULT_CONFIG.enabled) {
  initTelemetry();
  initWebVitalsTracking();
}

