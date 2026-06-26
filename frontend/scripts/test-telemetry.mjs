import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import url from 'node:url';

const root = path.resolve(url.fileURLToPath(new URL('..', import.meta.url)));
const sourceDir = path.join(root, 'src', 'services');

/**
 * Creates mock implementations of required browser and environment globals.
 */
function setupMockGlobals(options = {}) {
  const listeners = {
    window: {},
    document: {},
  };

  const sendBeaconCalls = [];
  const fetchCalls = [];

  // Mock navigator using Object.defineProperty to bypass Node's read-only getter
  const mockNavigator = {
    userAgent: 'Mozilla/5.0 (Test)',
    language: 'en-US',
    hardwareConcurrency: 4,
    connection: { effectiveType: '4g' },
    deviceMemory: 8,
    sendBeacon(url, data) {
      sendBeaconCalls.push({ url, data });
      if (options.sendBeaconResult !== undefined) {
        return options.sendBeaconResult;
      }
      return true; // default success
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: mockNavigator,
    configurable: true,
    writable: true,
  });

  // Mock screen
  globalThis.screen = {
    width: 1920,
    height: 1080,
  };

  // Mock window
  globalThis.window = {
    innerWidth: 1024,
    innerHeight: 768,
    location: {
      href: 'http://localhost/test',
      origin: 'http://localhost',
    },
    addEventListener(event, listener) {
      listeners.window[event] = listener;
    },
    setInterval(fn, interval) {
      if (options.onSetInterval) {
        options.onSetInterval(fn, interval);
      }
      return 999; // timer ID mock
    },
    clearInterval(id) {
      if (options.onClearInterval) {
        options.onClearInterval(id);
      }
    },
  };

  // Mock document
  globalThis.document = {
    referrer: 'http://google.com',
    title: 'Test Page',
    visibilityState: options.visibilityState || 'visible',
    addEventListener(event, listener) {
      listeners.document[event] = listener;
    },
  };

  // Mock sessionStorage
  globalThis.sessionStorage = {
    getItem(key) {
      return null;
    },
  };

  // Mock fetch API
  globalThis.fetch = async (url, fetchOptions) => {
    fetchCalls.push({ url, fetchOptions });
    if (options.fetchResult !== undefined) {
      return options.fetchResult;
    }
    return { ok: true, status: 200 };
  };

  // Mock performance API/observers
  globalThis.PerformanceObserver = class {
    observe() {}
    disconnect() {}
  };

  return {
    listeners,
    sendBeaconCalls,
    fetchCalls,
    cleanup() {
      delete globalThis.navigator;
      delete globalThis.screen;
      delete globalThis.window;
      delete globalThis.document;
      delete globalThis.sessionStorage;
      delete globalThis.fetch;
      delete globalThis.PerformanceObserver;
    },
  };
}

/**
 * Dynamically loads a fresh instance of the telemetry module to avoid shared state pollution.
 */
async function loadTelemetryModule(tempDir) {
  const telemetrySource = await readFile(path.join(sourceDir, 'telemetry.ts'), 'utf8');
  // Write to a temporary file in a temp directory
  const filename = `telemetry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mts`;
  const filePath = path.join(tempDir, filename);
  await writeFile(filePath, telemetrySource);

  // Dynamically import the module
  const telemetryUrl = url.pathToFileURL(filePath).href;
  const telemetry = await import(telemetryUrl);

  return {
    telemetry,
    filePath,
  };
}

// ---------------------------------------------------------------------------
// TEST SUITE
// ---------------------------------------------------------------------------

test('telemetry batch flush: flush triggers exactly at 100 events threshold', async () => {
  const tempDir = await mkdtemp(path.join(root, '.tmp-telemetry-test-'));
  const mocks = setupMockGlobals();

  try {
    const { telemetry } = await loadTelemetryModule(tempDir);

    // Initialize telemetry
    telemetry.initTelemetry({
      enabled: true,
      endpoint: 'https://telemetry.example.com/v1/events',
      batchSize: 100,
    });
    telemetry.setTelemetryEnabled(false);
    telemetry.setTelemetryEnabled(true);

    // Enqueue 99 events
    for (let i = 0; i < 99; i++) {
      telemetry.track('user_action', { index: i });
    }

    // Assert that no flush has occurred yet
    assert.equal(mocks.sendBeaconCalls.length, 0, 'Should not flush with 99 events');
    assert.equal(telemetry.getTelemetryStats().queued, 99, 'Queue should have 99 events');

    // Enqueue the 100th event (reaches batch size threshold)
    telemetry.track('user_action', { index: 99 });

    // Assert that a flush was triggered and the queue was reset
    assert.equal(mocks.sendBeaconCalls.length, 1, 'Should flush immediately on 100th event');
    assert.equal(telemetry.getTelemetryStats().queued, 0, 'Queue should be empty after flush');
    assert.equal(telemetry.getTelemetryStats().sent, 100, 'Stats should record 100 sent events');

    // Verify payload contents
    const payload = JSON.parse(mocks.sendBeaconCalls[0].data);
    assert.equal(payload.events.length, 100, 'Payload should contain exactly 100 events');
    assert.equal(payload.events[0].properties.index, 0);
    assert.equal(payload.events[99].properties.index, 99);
  } finally {
    mocks.cleanup();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('telemetry batch flush: flush triggers immediately on page unload', async () => {
  const tempDir = await mkdtemp(path.join(root, '.tmp-telemetry-test-'));
  const mocks = setupMockGlobals();

  try {
    const { telemetry } = await loadTelemetryModule(tempDir);

    telemetry.initTelemetry({
      enabled: true,
      endpoint: 'https://telemetry.example.com/v1/events',
      batchSize: 100,
    });
    telemetry.setTelemetryEnabled(false);
    telemetry.setTelemetryEnabled(true);

    // Track 25 events (partial batch)
    for (let i = 0; i < 25; i++) {
      telemetry.track('user_action', { index: i });
    }

    assert.equal(mocks.sendBeaconCalls.length, 0, 'No flush before unload');
    assert.equal(telemetry.getTelemetryStats().queued, 25, '25 events in queue');

    // Simulate page unload
    assert.ok(mocks.listeners.window.beforeunload, 'beforeunload listener should be registered');
    mocks.listeners.window.beforeunload();

    // Assert flush triggered
    assert.equal(mocks.sendBeaconCalls.length, 1, 'Flush should trigger on beforeunload');
    assert.equal(telemetry.getTelemetryStats().queued, 0, 'Queue should be cleared');
    assert.equal(telemetry.getTelemetryStats().sent, 25, 'Stats should record 25 sent events');

    const payload = JSON.parse(mocks.sendBeaconCalls[0].data);
    assert.equal(payload.events.length, 25, 'Payload should contain 25 events');
  } finally {
    mocks.cleanup();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('telemetry batch flush: flush triggers when page becomes hidden (visibilitychange)', async () => {
  const tempDir = await mkdtemp(path.join(root, '.tmp-telemetry-test-'));
  const mocks = setupMockGlobals();

  try {
    const { telemetry } = await loadTelemetryModule(tempDir);

    telemetry.initTelemetry({
      enabled: true,
      endpoint: 'https://telemetry.example.com/v1/events',
      batchSize: 100,
    });
    telemetry.setTelemetryEnabled(false);
    telemetry.setTelemetryEnabled(true);

    // Track 10 events
    for (let i = 0; i < 10; i++) {
      telemetry.track('user_action', { index: i });
    }

    assert.equal(mocks.sendBeaconCalls.length, 0);

    // Simulate visibility change to hidden
    assert.ok(mocks.listeners.document.visibilitychange, 'visibilitychange listener should be registered');
    globalThis.document.visibilityState = 'hidden';
    mocks.listeners.document.visibilitychange();

    // Assert flush triggered
    assert.equal(mocks.sendBeaconCalls.length, 1, 'Flush should trigger when page is hidden');
    assert.equal(telemetry.getTelemetryStats().queued, 0);
    assert.equal(telemetry.getTelemetryStats().sent, 10);
  } finally {
    mocks.cleanup();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('telemetry batch flush: partial batches are preserved before threshold or trigger', async () => {
  const tempDir = await mkdtemp(path.join(root, '.tmp-telemetry-test-'));
  const mocks = setupMockGlobals();

  try {
    const { telemetry } = await loadTelemetryModule(tempDir);

    telemetry.initTelemetry({
      enabled: true,
      endpoint: 'https://telemetry.example.com/v1/events',
      batchSize: 100,
    });
    telemetry.setTelemetryEnabled(false);
    telemetry.setTelemetryEnabled(true);

    // Enqueue 50 events
    for (let i = 0; i < 50; i++) {
      telemetry.track('user_action', { index: i });
    }

    // Verify no flush occurred and partial batch is preserved in the queue
    assert.equal(mocks.sendBeaconCalls.length, 0, 'Should not flush partial batch');
    assert.equal(telemetry.getTelemetryStats().queued, 50, 'Queue should preserve 50 events');

    // Add another 40 events (total 90)
    for (let i = 0; i < 40; i++) {
      telemetry.track('user_action', { index: 50 + i });
    }

    assert.equal(mocks.sendBeaconCalls.length, 0, 'Should not flush 90 events');
    assert.equal(telemetry.getTelemetryStats().queued, 90, 'Queue should preserve 90 events');

    // Call forceFlush manually
    telemetry.forceFlush();

    assert.equal(mocks.sendBeaconCalls.length, 1, 'Manual forceFlush should flush partial batch');
    assert.equal(telemetry.getTelemetryStats().queued, 0, 'Queue should be empty');
  } finally {
    mocks.cleanup();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('telemetry batch flush: reset and preserve remaining events when batch size is exceeded', async () => {
  const tempDir = await mkdtemp(path.join(root, '.tmp-telemetry-test-'));
  const mocks = setupMockGlobals();

  try {
    const { telemetry } = await loadTelemetryModule(tempDir);

    telemetry.initTelemetry({
      enabled: true,
      endpoint: 'https://telemetry.example.com/v1/events',
      batchSize: 100,
    });
    telemetry.setTelemetryEnabled(false);
    telemetry.setTelemetryEnabled(true);

    // Track 150 events. The 100th event triggers a flush.
    // The remaining 50 events should be preserved.
    for (let i = 0; i < 150; i++) {
      telemetry.track('user_action', { index: i });
    }

    // Flush should be triggered once (for the first 100 events)
    assert.equal(mocks.sendBeaconCalls.length, 1, 'One flush should trigger');
    assert.equal(telemetry.getTelemetryStats().sent, 100, '100 events sent');
    assert.equal(telemetry.getTelemetryStats().queued, 50, 'Remaining 50 events should be preserved in queue');

    // Force flush again to verify remaining events can be sent
    telemetry.forceFlush();
    assert.equal(mocks.sendBeaconCalls.length, 2, 'Second flush should trigger');
    assert.equal(telemetry.getTelemetryStats().sent, 150, '150 events sent total');
    assert.equal(telemetry.getTelemetryStats().queued, 0, 'Queue should now be empty');
  } finally {
    mocks.cleanup();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('telemetry batch flush: retry logic preserves queue on failure and drops after max retries', async () => {
  const tempDir = await mkdtemp(path.join(root, '.tmp-telemetry-test-'));

  // Configure navigator.sendBeacon to return false (indicating failure)
  const mocks = setupMockGlobals({ sendBeaconResult: false });

  try {
    const { telemetry } = await loadTelemetryModule(tempDir);

    telemetry.initTelemetry({
      enabled: true,
      endpoint: 'https://telemetry.example.com/v1/events',
      batchSize: 10,
      maxRetries: 3,
    });
    telemetry.setTelemetryEnabled(false);
    telemetry.setTelemetryEnabled(true);

    // Enqueue 10 events (triggers flush)
    for (let i = 0; i < 10; i++) {
      telemetry.track('user_action', { index: i });
    }

    // Flush fails. Events should be re-queued, not dropped yet.
    assert.equal(mocks.sendBeaconCalls.length, 1, 'Flush should have been attempted');
    assert.equal(telemetry.getTelemetryStats().sent, 0, 'No events sent');
    assert.equal(telemetry.getTelemetryStats().queued, 10, 'All 10 events preserved in queue');
    assert.equal(telemetry.getTelemetryStats().errors, 1, 'Errors counter incremented');

    // Attempt second flush manually
    telemetry.forceFlush();
    assert.equal(mocks.sendBeaconCalls.length, 2, 'Second flush attempted');
    assert.equal(telemetry.getTelemetryStats().queued, 10, 'Events still in queue');
    assert.equal(telemetry.getTelemetryStats().errors, 2, 'Errors counter is 2');

    // Attempt third flush manually. This reaches/exceeds maxRetries (3), so events should be dropped.
    telemetry.forceFlush();
    assert.equal(mocks.sendBeaconCalls.length, 3, 'Third flush attempted');
    assert.equal(telemetry.getTelemetryStats().queued, 0, 'Old events dropped');
    assert.equal(telemetry.getTelemetryStats().dropped, 10, 'Stats show 10 events dropped');
    assert.equal(telemetry.getTelemetryStats().errors, 3, 'Errors counter is 3');
  } finally {
    mocks.cleanup();
    await rm(tempDir, { recursive: true, force: true });
  }
});
