import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(url.fileURLToPath(new URL('..', import.meta.url)));

// Set up globals before importing the telemetry module
const eventListeners = {};
let sendBeaconCalled = false;
let sendBeaconPayload = null;
let sendBeaconSuccess = true;

let fetchCalled = false;
let fetchPayload = null;
let fetchSuccess = true;

globalThis.window = {
  location: { origin: 'http://localhost', href: 'http://localhost/' },
  addEventListener(event, listener) {
    eventListeners[event] = listener;
  },
  setInterval() { return 1; },
  clearInterval() {},
};

// Use Object.defineProperty to bypass read-only navigator getter in Node.js
Object.defineProperty(globalThis, 'navigator', {
  value: {
    userAgent: 'TestUserAgent',
    language: 'en-US',
    sendBeacon(endpoint, data) {
      sendBeaconCalled = true;
      sendBeaconPayload = data;
      return sendBeaconSuccess;
    },
  },
  configurable: true,
  writable: true,
});

globalThis.screen = {
  width: 1920,
  height: 1080,
};

globalThis.document = {
  referrer: '',
  title: 'Test Title',
  addEventListener(event, listener) {
    eventListeners[event] = listener;
  },
};

globalThis.sessionStorage = {
  getItem: () => null,
  setItem: () => {},
};

globalThis.PerformanceObserver = class {
  observe() {}
};

globalThis.fetch = async (endpoint, options) => {
  fetchCalled = true;
  fetchPayload = options.body;
  return {
    ok: fetchSuccess,
    status: fetchSuccess ? 200 : 500,
  };
};

// Get fresh module helper for isolation
async function getFreshTelemetry(testId) {
  const telemetryPath = url.pathToFileURL(path.join(root, 'src', 'services', 'telemetry.ts')).href;
  return await import(`${telemetryPath}?t=${testId}`);
}

// Reset state helper
function resetMocks() {
  sendBeaconCalled = false;
  sendBeaconPayload = null;
  sendBeaconSuccess = true;
  fetchCalled = false;
  fetchPayload = null;
  fetchSuccess = true;
  for (const k of Object.keys(eventListeners)) {
    delete eventListeners[k];
  }
}

// Wrap all tests in a serial suite to prevent global state conflicts
test('Telemetry Service Batch Flush Tests', { concurrency: 1 }, async (t) => {
  
  await t.test('1. flush triggers at 100 events', async () => {
    resetMocks();
    const telemetry = await getFreshTelemetry('1');
    
    telemetry.initTelemetry({
      enabled: true,
      endpoint: 'http://test-endpoint/telemetry',
      batchSize: 100,
    });

    const initialStats = telemetry.getTelemetryStats();
    
    // Track custom events up to 99 total events (including initial 2)
    const needed = 99 - initialStats.queued;
    for (let i = 0; i < needed; i++) {
      telemetry.track('custom_event', { index: i });
    }

    assert.equal(telemetry.getTelemetryStats().queued, 99);
    assert.equal(sendBeaconCalled, false);

    // Track the 100th event
    telemetry.track('custom_event', { index: 99 });

    // It should trigger flush immediately
    assert.equal(sendBeaconCalled, true);
    assert.equal(telemetry.getTelemetryStats().queued, 0);

    const payload = JSON.parse(sendBeaconPayload);
    assert.equal(payload.events.length, 100);
  });

  await t.test('2. flush triggers on page unload', async () => {
    resetMocks();
    const telemetry = await getFreshTelemetry('2');
    
    telemetry.initTelemetry({
      enabled: true,
      endpoint: 'http://test-endpoint/telemetry',
      batchSize: 100,
    });

    // Track some events (fewer than 100)
    telemetry.track('custom_event', { val: 'unload-test-1' });
    telemetry.track('custom_event', { val: 'unload-test-2' });

    const currentQueued = telemetry.getTelemetryStats().queued;
    assert.equal(currentQueued, 4); // 2 initial + 2 custom
    assert.equal(sendBeaconCalled, false);

    // Trigger beforeunload event listener
    if (eventListeners['beforeunload']) {
      eventListeners['beforeunload']();
    } else {
      throw new Error('beforeunload listener not registered');
    }

    // It should flush immediately
    assert.equal(sendBeaconCalled, true);
    assert.equal(telemetry.getTelemetryStats().queued, 0);

    const payload = JSON.parse(sendBeaconPayload);
    assert.equal(payload.events.length, 4);
    assert.equal(payload.events[2].properties.val, 'unload-test-1');
  });

  await t.test('3. partial batches are preserved on flush failure', async () => {
    resetMocks();
    sendBeaconSuccess = false; // Simulate beacon failure
    const telemetry = await getFreshTelemetry('3');

    telemetry.initTelemetry({
      enabled: true,
      endpoint: 'http://test-endpoint/telemetry',
      batchSize: 10,
      maxRetries: 3,
    });

    const initialStats = telemetry.getTelemetryStats();
    
    // Track events to hit exactly the batch size of 10
    const needed = 10 - initialStats.queued;
    for (let i = 0; i < needed; i++) {
      telemetry.track('custom_event', { id: i });
    }

    // Beacon will return false, so flush will fail.
    // Events should be preserved (put back in the queue)
    assert.equal(sendBeaconCalled, true);
    
    // Let the microtask queue run so async operations finish
    await new Promise(resolve => setTimeout(resolve, 10));

    const stats = telemetry.getTelemetryStats();
    assert.equal(stats.queued, 10);
    assert.equal(stats.errors, 1);
  });

  await t.test('4. reset after successful flush', async () => {
    resetMocks();
    const telemetry = await getFreshTelemetry('4');

    telemetry.initTelemetry({
      enabled: true,
      endpoint: 'http://test-endpoint/telemetry',
      batchSize: 5,
    });

    const initialStats = telemetry.getTelemetryStats();
    
    // Track events to hit exactly the batch size of 5
    const needed = 5 - initialStats.queued;
    for (let i = 0; i < needed; i++) {
      telemetry.track('custom_event', { id: i });
    }

    await new Promise(resolve => setTimeout(resolve, 10));

    const stats = telemetry.getTelemetryStats();
    assert.equal(stats.queued, 0);
    assert.equal(stats.errors, 0);
  });
});
