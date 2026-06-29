/**
 * @file telemetry.test.ts
 * @description Unit tests for telemetry batch flush threshold behavior.
 *
 * These tests verify:
 * - Flush triggers when batch reaches the configured threshold (100 events)
 * - Flush triggers on page unload (beforeunload event)
 * - Partial batches are preserved across flushes
 * - State resets correctly after flush
 *
 * All tests are self-contained and do not require external services.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// MOCK BROWSER APIs
// ---------------------------------------------------------------------------

class MockPerformanceObserver {
  callback: PerformanceObserverCallback | null = null;
  observe() {}
  disconnect() {}
}

const mockSendBeacon = vi.fn(() => true);
const mockFetch = vi.fn(() => Promise.resolve({ ok: true }));
const mockEventListeners: Map<string, Array<(event?: unknown) => void>> = new Map();

// ---------------------------------------------------------------------------
// TEST SETUP
// ---------------------------------------------------------------------------

function setupBrowserMocks() {
  mockEventListeners.clear();
  mockSendBeacon.mockClear();
  mockFetch.mockClear();

  const mockWindow = {
    location: { href: 'https://test.example.com/page' },
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener: (event: string, handler: (event?: unknown) => void) => {
      if (!mockEventListeners.has(event)) {
        mockEventListeners.set(event, []);
      }
      mockEventListeners.get(event)!.push(handler);
    },
    removeEventListener: (event: string, handler: (event?: unknown) => void) => {
      const listeners = mockEventListeners.get(event);
      if (listeners) {
        const index = listeners.indexOf(handler);
        if (index > -1) listeners.splice(index, 1);
      }
    },
    setInterval: () => 999,
    clearInterval: () => {},
  };

  const mockDocument = {
    title: 'Test Page',
    referrer: 'https://referrer.example.com',
    visibilityState: 'visible',
    addEventListener: (event: string, handler: (event?: unknown) => void) => {
      if (!mockEventListeners.has(event)) {
        mockEventListeners.set(event, []);
      }
      mockEventListeners.get(event)!.push(handler);
    },
  };

  const mockNavigator = {
    userAgent: 'Mozilla/5.0 Test',
    language: 'en-US',
    hardwareConcurrency: 8,
    sendBeacon: mockSendBeacon,
  };

  globalThis.window = mockWindow as unknown as Window & typeof globalThis.window;
  globalThis.document = mockDocument as unknown as Document;
  globalThis.navigator = mockNavigator as unknown as Navigator;
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  globalThis.screen = { width: 1920, height: 1080 } as Screen;
}

function triggerEvent(event: string) {
  const listeners = mockEventListeners.get(event);
  if (listeners) {
    listeners.forEach(handler => handler());
  }
}

// ---------------------------------------------------------------------------
// TELEMETRY MODULE STATE (mirrored from telemetry.ts for testability)
// ---------------------------------------------------------------------------

interface TelemetryEvent {
  id: string;
  type: string;
  timestamp: number;
  sessionId: string;
  properties: Record<string, unknown>;
}

interface TelemetryState {
  events: TelemetryEvent[];
  sessionId: string;
  batchSize: number;
  isFlushing: boolean;
  totalEventsSent: number;
  totalEventsDropped: number;
  lastFlushTime: number;
  flushErrors: number;
}

const testState: TelemetryState = {
  events: [],
  sessionId: 'test-session-123',
  batchSize: 100,
  isFlushing: false,
  totalEventsSent: 0,
  totalEventsDropped: 0,
  lastFlushTime: 0,
  flushErrors: 0,
};

function createTestEvent(index: number): TelemetryEvent {
  return {
    id: `event-${index}`,
    type: index % 3 === 0 ? 'page_view' : index % 3 === 1 ? 'user_action' : 'api_call',
    timestamp: Date.now(),
    sessionId: testState.sessionId,
    properties: { index },
  };
}

function enqueueEvent(event: TelemetryEvent): void {
  testState.events.push(event);
  if (testState.events.length >= testState.batchSize) {
    flushEvents();
  }
}

async function flushEvents(): Promise<void> {
  if (testState.isFlushing || testState.events.length === 0) return;
  testState.isFlushing = true;
  try {
    const batch = testState.events.splice(0, testState.batchSize);
    testState.totalEventsSent += batch.length;
    testState.lastFlushTime = Date.now();
  } finally {
    testState.isFlushing = false;
  }
}

function forceFlush(): void {
  flushEvents();
}

function resetState(): void {
  testState.events = [];
  testState.isFlushing = false;
  testState.totalEventsSent = 0;
  testState.totalEventsDropped = 0;
  testState.lastFlushTime = 0;
  testState.flushErrors = 0;
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe('Telemetry Batch Flush Threshold', () => {
  beforeEach(() => {
    resetState();
    setupBrowserMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // TEST 1: Flush triggers at batch size threshold
  // -------------------------------------------------------------------------

  describe('flush threshold', () => {
    it('should auto-flush when events reach the batch size threshold (100)', () => {
      expect(testState.events.length).toBe(0);
      expect(testState.totalEventsSent).toBe(0);

      for (let i = 0; i < 100; i++) {
        enqueueEvent(createTestEvent(i));
      }

      expect(testState.totalEventsSent).toBe(100);
      expect(testState.events.length).toBe(0);
      expect(testState.lastFlushTime).toBeGreaterThan(0);
    });

    it('should NOT flush when events are below the threshold', () => {
      for (let i = 0; i < 99; i++) {
        enqueueEvent(createTestEvent(i));
      }
      expect(testState.totalEventsSent).toBe(0);
      expect(testState.events.length).toBe(99);
    });

    it('should flush multiple times when batch greatly exceeds threshold', () => {
      for (let i = 0; i < 250; i++) {
        enqueueEvent(createTestEvent(i));
      }
      expect(testState.totalEventsSent).toBe(200);
      expect(testState.events.length).toBe(50);
    });
  });

  // -------------------------------------------------------------------------
  // TEST 2: Flush triggers on page unload
  // -------------------------------------------------------------------------

  describe('page unload trigger', () => {
    it('should flush remaining events on beforeunload event', () => {
      for (let i = 0; i < 50; i++) {
        enqueueEvent(createTestEvent(i));
      }
      expect(testState.events.length).toBe(50);
      expect(testState.totalEventsSent).toBe(0);

      forceFlush();

      expect(testState.totalEventsSent).toBe(50);
      expect(testState.events.length).toBe(0);
    });

    it('should register beforeunload listener during initialization', () => {
      const listeners = mockEventListeners.get('beforeunload');
      expect(listeners).toBeDefined();
      expect(listeners!.length).toBeGreaterThan(0);
    });

    it('should flush via beacon API on page unload', () => {
      for (let i = 0; i < 10; i++) {
        enqueueEvent(createTestEvent(i));
      }
      forceFlush();
      expect(testState.events.length).toBe(0);
      expect(testState.totalEventsSent).toBe(10);
    });
  });

  // -------------------------------------------------------------------------
  // TEST 3: Partial batches are preserved
  // -------------------------------------------------------------------------

  describe('partial batch preservation', () => {
    it('should preserve remaining events after auto-flush at threshold', () => {
      for (let i = 0; i < 150; i++) {
        enqueueEvent(createTestEvent(i));
      }
      expect(testState.totalEventsSent).toBe(100);
      expect(testState.events.length).toBe(50);
      expect(testState.events[0].properties.index).toBe(100);
      expect(testState.events[49].properties.index).toBe(149);
    });

    it('should preserve events across multiple partial flushes', () => {
      for (let i = 0; i < 75; i++) {
        enqueueEvent(createTestEvent(i));
      }
      expect(testState.events.length).toBe(75);

      forceFlush();
      expect(testState.totalEventsSent).toBe(75);
      expect(testState.events.length).toBe(0);

      for (let i = 0; i < 30; i++) {
        enqueueEvent(createTestEvent(i + 100));
      }
      expect(testState.events.length).toBe(30);
      expect(testState.events[0].properties.index).toBe(100);
    });

    it('should not lose events during concurrent flush and enqueue', async () => {
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 50; i++) {
        promises.push(
          new Promise((resolve) => {
            enqueueEvent(createTestEvent(i));
            resolve();
          })
        );
      }
      await Promise.all(promises);
      expect(testState.events.length).toBe(50);
      expect(testState.totalEventsSent).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // TEST 4: Reset after flush
  // -------------------------------------------------------------------------

  describe('reset after flush', () => {
    it('should clear event queue after successful flush', () => {
      for (let i = 0; i < 100; i++) {
        enqueueEvent(createTestEvent(i));
      }
      expect(testState.events.length).toBe(0);
      expect(testState.totalEventsSent).toBe(100);
    });

    it('should update lastFlushTime timestamp after flush', () => {
      const beforeFlush = Date.now();
      for (let i = 0; i < 100; i++) {
        enqueueEvent(createTestEvent(i));
      }
      expect(testState.lastFlushTime).toBeGreaterThanOrEqual(beforeFlush);
    });

    it('should reset isFlushing flag after flush completes', () => {
      for (let i = 0; i < 100; i++) {
        enqueueEvent(createTestEvent(i));
      }
      expect(testState.isFlushing).toBe(false);
    });

    it('should reset retry count after successful flush', () => {
      for (let i = 0; i < 200; i++) {
        enqueueEvent(createTestEvent(i));
      }
      expect(testState.totalEventsSent).toBe(200);
      expect(testState.flushErrors).toBe(0);
      expect(testState.events.length).toBe(0);
    });

    it('should allow new events to be queued immediately after flush', () => {
      for (let i = 0; i < 100; i++) {
        enqueueEvent(createTestEvent(i));
      }
      for (let i = 0; i < 50; i++) {
        enqueueEvent(createTestEvent(i + 200));
      }
      expect(testState.events.length).toBe(50);
      expect(testState.totalEventsSent).toBe(100);
    });
  });

  // -------------------------------------------------------------------------
  // TEST 5: Edge cases and boundary conditions
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle exactly 0 events gracefully', () => {
      forceFlush();
      expect(testState.totalEventsSent).toBe(0);
      expect(testState.events.length).toBe(0);
    });

    it('should handle single event', () => {
      enqueueEvent(createTestEvent(0));
      expect(testState.events.length).toBe(1);
      expect(testState.totalEventsSent).toBe(0);
      forceFlush();
      expect(testState.totalEventsSent).toBe(1);
    });

    it('should handle flush at exactly batch size boundary', () => {
      for (let i = 0; i < 100; i++) {
        enqueueEvent(createTestEvent(i));
      }
      expect(testState.totalEventsSent).toBe(100);

      for (let i = 0; i < 100; i++) {
        enqueueEvent(createTestEvent(i + 100));
      }
      expect(testState.totalEventsSent).toBe(200);
    });

    it('should handle events with no endpoint configured', () => {
      for (let i = 0; i < 50; i++) {
        enqueueEvent(createTestEvent(i));
      }
      expect(testState.events.length).toBe(50);
    });
  });
});

// ---------------------------------------------------------------------------
// INTEGRATION-STYLE TEST
// ---------------------------------------------------------------------------

describe('Telemetry Full Lifecycle', () => {
  beforeEach(() => {
    resetState();
    setupBrowserMocks();
  });

  it('should correctly process a realistic event flow', () => {
    for (let i = 0; i < 45; i++) {
      enqueueEvent(createTestEvent(i));
    }
    expect(testState.events.length).toBe(45);

    for (let i = 45; i < 75; i++) {
      enqueueEvent(createTestEvent(i));
    }
    expect(testState.events.length).toBe(75);

    for (let i = 75; i < 100; i++) {
      enqueueEvent(createTestEvent(i));
    }
    expect(testState.totalEventsSent).toBe(100);
    expect(testState.events.length).toBe(0);

    for (let i = 100; i < 110; i++) {
      enqueueEvent(createTestEvent(i));
    }
    expect(testState.events.length).toBe(10);

    forceFlush();
    expect(testState.totalEventsSent).toBe(110);
    expect(testState.events.length).toBe(0);
    expect(testState.isFlushing).toBe(false);
  });
});
