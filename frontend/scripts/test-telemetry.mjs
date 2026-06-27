import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import url from 'node:url';

const root = path.resolve(url.fileURLToPath(new URL('..', import.meta.url)));
const sourceDir = path.join(root, 'src', 'services');

// Global mock state helper
let mockFetchCallCount = 0;
let mockFetchPayloads = [];
let mockFetchSuccess = true;

let mockBeaconCallCount = 0;
let mockBeaconPayloads = [];
let mockBeaconSuccess = true;

async function loadTelemetryModule(envOverrides = {}) {
  const tempDir = await mkdtemp(path.join(root, '.tmp-telemetry-'));

  // Read and patch telemetry.ts
  const telemetrySource = await readFile(path.join(sourceDir, 'telemetry.ts'), 'utf8');
  // Replace import.meta.env with globalThis.__importMetaEnv
  const patchedSource = telemetrySource.replace(/import\.meta\.env/g, 'globalThis.__importMetaEnv');

  await writeFile(path.join(tempDir, 'telemetry.mts'), patchedSource);

  // Setup basic browser mocks with auto-initialization disabled (VITE_TELEMETRY_ENABLED = '')
  globalThis.__importMetaEnv = {
    VITE_TELEMETRY_ENDPOINT: 'https://telemetry-test.net/v1/collect',
    VITE_TELEMETRY_ENABLED: '',
    VITE_TELEMETRY_DEBUG: '',
    ...envOverrides
  };

  const storage = new Map();
  globalThis.sessionStorage = {
    getItem(key) { return storage.get(key) || null; },
    setItem(key, val) { storage.set(key, String(val)); },
  };

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: 'test-agent',
      language: 'en-US',
      hardwareConcurrency: 4,
      sendBeacon(endpoint, payload) {
        mockBeaconCallCount++;
        mockBeaconPayloads.push({ endpoint, payload });
        return mockBeaconSuccess;
      },
    },
    configurable: true,
    writable: true,
  });

  globalThis.screen = {
    width: 1920,
    height: 1080,
  };

  globalThis.Intl = {
    DateTimeFormat() {
      return {
        resolvedOptions() {
          return { timeZone: 'UTC' };
        }
      };
    }
  };

  const listeners = {};
  globalThis.window = {
    innerWidth: 1024,
    innerHeight: 768,
    location: {
      href: 'https://example.com/page',
      origin: 'https://example.com',
    },
    addEventListener(event, listener) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(listener);
    },
    dispatchEvent(event) {
      const eventName = typeof event === 'string' ? event : event.type;
      if (listeners[eventName]) {
        for (const listener of listeners[eventName]) {
          listener(event);
        }
      }
    },
    setInterval() { return 1; },
    clearInterval() {},
  };

  globalThis.document = {
    referrer: 'https://referrer.com',
    visibilityState: 'visible',
    addEventListener(event, listener) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(listener);
    },
    dispatchEvent(event) {
      const eventName = typeof event === 'string' ? event : event.type;
      if (listeners[eventName]) {
        for (const listener of listeners[eventName]) {
          listener(event);
        }
      }
    },
  };

  globalThis.location = globalThis.window.location;

  globalThis.fetch = async (endpoint, options) => {
    mockFetchCallCount++;
    mockFetchPayloads.push({ endpoint, options });
    return {
      ok: mockFetchSuccess,
      status: mockFetchSuccess ? 200 : 500,
    };
  };

  // Import the temporary module
  const telemetry = await import(`${url.pathToFileURL(path.join(tempDir, 'telemetry.mts')).href}?t=${Date.now()}`);

  return {
    telemetry,
    async cleanup() {
      // Clear globals
      delete globalThis.__importMetaEnv;
      delete globalThis.sessionStorage;
      delete globalThis.navigator;
      delete globalThis.screen;
      delete globalThis.window;
      delete globalThis.document;
      delete globalThis.location;
      delete globalThis.fetch;
      delete globalThis.Intl;
      await rm(tempDir, { recursive: true, force: true });
    },
    triggerWindowUnload() {
      if (listeners['beforeunload']) {
        for (const listener of listeners['beforeunload']) {
          listener({ type: 'beforeunload' });
        }
      }
    },
    triggerVisibilityChange(stateValue) {
      globalThis.document.visibilityState = stateValue;
      if (listeners['visibilitychange']) {
        for (const listener of listeners['visibilitychange']) {
          listener({ type: 'visibilitychange' });
        }
      }
    }
  };
}

test('telemetry init resetting mocks', () => {
  mockFetchCallCount = 0;
  mockFetchPayloads = [];
  mockFetchSuccess = true;
  mockBeaconCallCount = 0;
  mockBeaconPayloads = [];
  mockBeaconSuccess = true;
});

test('flush triggers automatically when batch size reaches 100 (or custom threshold)', async () => {
  mockFetchCallCount = 0;
  mockFetchPayloads = [];
  mockBeaconCallCount = 0;
  mockBeaconPayloads = [];
  mockBeaconSuccess = true;

  const { telemetry, cleanup } = await loadTelemetryModule();
  
  try {
    // Init with enabled: true so listeners register, then clear the queue to empty
    telemetry.initTelemetry({ batchSize: 5, enabled: true });
    telemetry.setTelemetryEnabled(false);
    telemetry.setTelemetryEnabled(true);

    // Track 4 events
    for (let i = 0; i < 4; i++) {
      telemetry.track('custom_event', { index: i });
    }
    
    let stats = telemetry.getTelemetryStats();
    assert.equal(stats.queued, 4);
    assert.equal(stats.sent, 0);
    assert.equal(mockBeaconCallCount, 0);

    // Track 5th event (reaches batchSize threshold of 5)
    telemetry.track('custom_event', { index: 4 });

    stats = telemetry.getTelemetryStats();
    assert.equal(stats.queued, 0);
    assert.equal(stats.sent, 5);
    assert.equal(mockBeaconCallCount, 1);
    
    const sentData = JSON.parse(mockBeaconPayloads[0].payload);
    assert.equal(sentData.events.length, 5);
  } finally {
    await cleanup();
  }
});

test('flush triggers on page unload (beforeunload and visibilitychange hidden)', async () => {
  mockFetchCallCount = 0;
  mockFetchPayloads = [];
  mockBeaconCallCount = 0;
  mockBeaconPayloads = [];
  mockBeaconSuccess = true;

  const { telemetry, cleanup, triggerWindowUnload, triggerVisibilityChange } = await loadTelemetryModule();

  try {
    // Init with enabled: true so listeners register, then clear the queue to empty
    telemetry.initTelemetry({ batchSize: 10, enabled: true });
    telemetry.setTelemetryEnabled(false);
    telemetry.setTelemetryEnabled(true);

    // Queue 3 events
    for (let i = 0; i < 3; i++) {
      telemetry.track('custom_event', { index: i });
    }

    let stats = telemetry.getTelemetryStats();
    assert.equal(stats.queued, 3);
    assert.equal(stats.sent, 0);

    // Trigger beforeunload
    triggerWindowUnload();

    stats = telemetry.getTelemetryStats();
    assert.equal(stats.queued, 0);
    assert.equal(stats.sent, 3);
    assert.equal(mockBeaconCallCount, 1);

    // Queue 2 more events
    for (let i = 0; i < 2; i++) {
      telemetry.track('custom_event', { index: i + 10 });
    }

    stats = telemetry.getTelemetryStats();
    assert.equal(stats.queued, 2);

    // Trigger visibilityState to hidden
    triggerVisibilityChange('hidden');

    stats = telemetry.getTelemetryStats();
    assert.equal(stats.queued, 0);
    assert.equal(stats.sent, 5); // 3 original + 2 new
    assert.equal(mockBeaconCallCount, 2);
  } finally {
    await cleanup();
  }
});

test('partial batches are preserved when a flush fails', async () => {
  mockFetchCallCount = 0;
  mockFetchPayloads = [];
  mockBeaconCallCount = 0;
  mockBeaconPayloads = [];
  mockBeaconSuccess = false; // Simulate Beacon failure

  const { telemetry, cleanup } = await loadTelemetryModule();

  try {
    // Init with enabled: true so listeners register, then clear the queue to empty
    telemetry.initTelemetry({ batchSize: 3, enabled: true });
    telemetry.setTelemetryEnabled(false);
    telemetry.setTelemetryEnabled(true);

    // Track 3 events (triggers flush but fails)
    for (let i = 0; i < 3; i++) {
      telemetry.track('custom_event', { index: i });
    }

    const stats = telemetry.getTelemetryStats();
    // Failed events should be re-queued back
    assert.equal(stats.queued, 3);
    assert.equal(stats.sent, 0);
    assert.equal(stats.errors, 1);
    assert.equal(mockBeaconCallCount, 1);
  } finally {
    await cleanup();
  }
});

test('reset queue after successful flush enables subsequent tracking from empty', async () => {
  mockFetchCallCount = 0;
  mockFetchPayloads = [];
  mockBeaconCallCount = 0;
  mockBeaconPayloads = [];
  mockBeaconSuccess = true;

  const { telemetry, cleanup } = await loadTelemetryModule();

  try {
    // Init with enabled: true so listeners register, then clear the queue to empty
    telemetry.initTelemetry({ batchSize: 2, enabled: true });
    telemetry.setTelemetryEnabled(false);
    telemetry.setTelemetryEnabled(true);

    // Track 2 events (trigger flush and succeeds)
    telemetry.track('custom_event', { index: 1 });
    telemetry.track('custom_event', { index: 2 });

    let stats = telemetry.getTelemetryStats();
    assert.equal(stats.queued, 0);
    assert.equal(stats.sent, 4);

    // Queue 1 more event
    telemetry.track('custom_event', { index: 3 });

    stats = telemetry.getTelemetryStats();
    assert.equal(stats.queued, 1);
    assert.equal(stats.sent, 4);
  } finally {
    await cleanup();
  }
});
