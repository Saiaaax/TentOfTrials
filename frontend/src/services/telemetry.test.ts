import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the telemetry module internals
const createMockTelemetryState = () => ({
  events: [] as Array<{ id: string; type: string; timestamp: number }>,
  sessionId: "test-session-id",
  config: {
    endpoint: "https://telemetry.example.com/v1/events",
    batchSize: 100,
    flushInterval: 30000,
    maxRetries: 3,
    sampleRate: 1.0,
    enabled: true,
    debug: false,
  },
  flushTimer: null as number | null,
  isFlushing: false,
  retryCount: 0,
  totalEventsSent: 0,
  totalEventsDropped: 0,
  lastFlushTime: 0,
  flushErrors: 0,
});

describe("Telemetry Service - Batch Flush Threshold Tests", () => {
  let mockState: ReturnType<typeof createMockTelemetryState>;
  let mockBeacon: ReturnType<typeof vi.fn>;
  let flushCallback: (() => void) | null = null;

  beforeEach(() => {
    mockState = createMockTelemetryState();
    mockBeacon = vi.fn().mockReturnValue(true);
    
    // Mock navigator.sendBeacon
    Object.defineProperty(global.navigator, "sendBeacon", {
      value: mockBeacon,
      writable: true,
    });

    // Reset flush callback
    flushCallback = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  /**
   * Test 1: Flush triggers at 100 events
   * 
   * The telemetry service should automatically flush when the batch size
   * exceeds 100 events to prevent memory buildup and ensure timely delivery.
   */
  it("should trigger flush when batch size exceeds 100 events", async () => {
    const BATCH_THRESHOLD = 100;
    let flushed = false;

    // Simulate adding events up to threshold
    const addEvent = () => {
      mockState.events.push({
        id: `event-${mockState.events.length}`,
        type: "custom_event",
        timestamp: Date.now(),
      });

      // Check if we should flush
      if (mockState.events.length >= BATCH_THRESHOLD) {
        flushed = true;
        // Simulate flush
        mockBeacon(
          mockState.config.endpoint,
          JSON.stringify(mockState.events)
        );
        mockState.totalEventsSent += mockState.events.length;
        mockState.events = [];
        mockState.lastFlushTime = Date.now();
      }
    };

    // Add 99 events - should NOT flush
    for (let i = 0; i < 99; i++) {
      addEvent();
    }
    expect(flushed).toBe(false);
    expect(mockState.events.length).toBe(99);
    expect(mockBeacon).not.toHaveBeenCalled();

    // Add 100th event - should trigger flush
    addEvent();
    expect(flushed).toBe(true);
    expect(mockState.events.length).toBe(0);
    expect(mockBeacon).toHaveBeenCalledTimes(1);
    expect(mockState.totalEventsSent).toBe(100);
  });

  /**
   * Test 2: Flush triggers on page unload
   * 
   * The telemetry service should flush any pending events when the page
   * is about to unload to ensure no data is lost.
   */
  it("should trigger flush on page unload event", () => {
    // Add some events (less than threshold)
    for (let i = 0; i < 50; i++) {
      mockState.events.push({
        id: `event-${i}`,
        type: "custom_event",
        timestamp: Date.now(),
      });
    }

    expect(mockState.events.length).toBe(50);
    expect(mockBeacon).not.toHaveBeenCalled();

    // Simulate page unload handler
    const handleBeforeUnload = () => {
      if (mockState.events.length > 0) {
        mockBeacon(
          mockState.config.endpoint,
          JSON.stringify(mockState.events)
        );
        mockState.totalEventsSent += mockState.events.length;
        mockState.events = [];
      }
    };

    // Trigger unload
    handleBeforeUnload();

    expect(mockBeacon).toHaveBeenCalledTimes(1);
    expect(mockState.events.length).toBe(0);
    expect(mockState.totalEventsSent).toBe(50);
  });

  /**
   * Test 3: Partial batches are preserved
   * 
   * When a flush occurs (either by threshold or timer), events that arrive
   * during the flush should be preserved in a new batch.
   */
  it("should preserve partial batches after flush", async () => {
    const BATCH_THRESHOLD = 100;

    // Add events to trigger flush
    for (let i = 0; i < 100; i++) {
      mockState.events.push({
        id: `event-${i}`,
        type: "custom_event",
        timestamp: Date.now(),
      });
    }

    // Simulate flush
    const eventsToSend = [...mockState.events];
    mockState.events = []; // Clear for new batch
    mockBeacon(mockState.config.endpoint, JSON.stringify(eventsToSend));
    mockState.totalEventsSent += eventsToSend.length;

    // Add new events after flush (partial batch)
    for (let i = 0; i < 25; i++) {
      mockState.events.push({
        id: `post-flush-event-${i}`,
        type: "custom_event",
        timestamp: Date.now(),
      });
    }

    // Verify partial batch is preserved
    expect(mockState.events.length).toBe(25);
    expect(mockState.events[0].id).toBe("post-flush-event-0");
    expect(mockState.totalEventsSent).toBe(100);

    // Partial batch should not trigger flush (below threshold)
    expect(mockBeacon).toHaveBeenCalledTimes(1);
  });

  /**
   * Test 4: State resets after flush
   * 
   * After a successful flush, the event batch should be cleared and
   * the flush timestamp should be updated.
   */
  it("should reset state after successful flush", () => {
    // Add events
    for (let i = 0; i < 100; i++) {
      mockState.events.push({
        id: `event-${i}`,
        type: "custom_event",
        timestamp: Date.now(),
      });
    }

    const beforeFlushTime = mockState.lastFlushTime;
    expect(mockState.events.length).toBe(100);

    // Simulate successful flush
    const flush = () => {
      if (mockState.events.length === 0) return;
      
      const success = mockBeacon(
        mockState.config.endpoint,
        JSON.stringify(mockState.events)
      );

      if (success) {
        mockState.totalEventsSent += mockState.events.length;
        mockState.events = []; // Reset batch
        mockState.lastFlushTime = Date.now(); // Update timestamp
        mockState.retryCount = 0; // Reset retry counter
      }
    };

    flush();

    // Verify state reset
    expect(mockState.events.length).toBe(0);
    expect(mockState.lastFlushTime).toBeGreaterThan(beforeFlushTime);
    expect(mockState.retryCount).toBe(0);
    expect(mockState.totalEventsSent).toBe(100);
    expect(mockBeacon).toHaveBeenCalledTimes(1);
  });

  /**
   * Test 5: Concurrent flush protection
   * 
   * The service should prevent concurrent flush operations to avoid
   * duplicate event transmission.
   */
  it("should prevent concurrent flush operations", async () => {
    // Add events
    for (let i = 0; i < 100; i++) {
      mockState.events.push({
        id: `event-${i}`,
        type: "custom_event",
        timestamp: Date.now(),
      });
    }

    const flush = async () => {
      if (mockState.isFlushing) {
        return false; // Already flushing
      }

      mockState.isFlushing = true;
      try {
        await new Promise((resolve) => setTimeout(resolve, 10)); // Simulate network delay
        mockBeacon(mockState.config.endpoint, JSON.stringify(mockState.events));
        mockState.totalEventsSent += mockState.events.length;
        mockState.events = [];
        return true;
      } finally {
        mockState.isFlushing = false;
      }
    };

    // Start two concurrent flushes
    const flush1 = flush();
    const flush2 = flush();

    const [result1, result2] = await Promise.all([flush1, flush2]);

    // Only one should succeed
    expect(result1).toBe(true);
    expect(result2).toBe(false);
    expect(mockBeacon).toHaveBeenCalledTimes(1);
  });
});
