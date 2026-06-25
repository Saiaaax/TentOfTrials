import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(__dirname, '..');
const telemetrySource = resolve(frontendRoot, 'src/services/telemetry.ts');
const scratchDir = resolve(frontendRoot, '.telemetry-test');
const compiledTelemetry = resolve(scratchDir, 'telemetry-test-module.mjs');

async function compileTelemetryModule() {
  await mkdir(scratchDir, { recursive: true });
  const source = await readFile(telemetrySource, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    fileName: telemetrySource,
  });
  await writeFile(compiledTelemetry, output.outputText, 'utf8');
}

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

function createBrowserHarness() {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const beacons = [];
  let timerId = 0;

  const addListener = (listeners, type, callback) => {
    const callbacks = listeners.get(type) ?? [];
    callbacks.push(callback);
    listeners.set(type, callbacks);
  };
  const dispatch = (listeners, type) => {
    for (const callback of listeners.get(type) ?? []) {
      callback({ type });
    }
  };

  const windowObject = {
    innerWidth: 1280,
    innerHeight: 720,
    location: {
      href: 'https://example.test/dashboard?token=secret',
      origin: 'https://example.test',
    },
    addEventListener(type, callback) {
      addListener(windowListeners, type, callback);
    },
    setInterval() {
      timerId += 1;
      return timerId;
    },
  };

  const documentObject = {
    title: 'Telemetry Test Dashboard',
    referrer: 'https://example.test/login',
    visibilityState: 'visible',
    addEventListener(type, callback) {
      addListener(documentListeners, type, callback);
    },
  };

  const navigatorObject = {
    userAgent: 'node-telemetry-test',
    language: 'en-US',
    hardwareConcurrency: 8,
    sendBeacon(endpoint, payload) {
      beacons.push({
        endpoint,
        payload: JSON.parse(payload),
      });
      return true;
    },
  };

  setGlobal('window', windowObject);
  setGlobal('document', documentObject);
  setGlobal('navigator', navigatorObject);
  setGlobal('screen', { width: 1920, height: 1080 });
  setGlobal('sessionStorage', {
    getItem() {
      return null;
    },
  });

  return {
    beacons,
    dispatchBeforeUnload() {
      dispatch(windowListeners, 'beforeunload');
    },
    dispatchHiddenVisibility() {
      documentObject.visibilityState = 'hidden';
      dispatch(documentListeners, 'visibilitychange');
    },
  };
}

async function loadTelemetry(testName) {
  const harness = createBrowserHarness();
  const moduleUrl = `${pathToFileURL(compiledTelemetry).href}?case=${encodeURIComponent(testName)}-${Date.now()}-${Math.random()}`;
  const telemetry = await import(moduleUrl);
  return { harness, telemetry };
}

function initTelemetry(telemetry, overrides = {}) {
  telemetry.initTelemetry({
    endpoint: '/telemetry',
    batchSize: 100,
    flushInterval: 60000,
    maxRetries: 3,
    sampleRate: 1,
    enabled: true,
    debug: false,
    ...overrides,
  });
}

const tests = [
  async function flushesAtConfiguredThreshold() {
    const { harness, telemetry } = await loadTelemetry('threshold');
    initTelemetry(telemetry);

    assert.equal(telemetry.getTelemetryStats().queued, 2, 'init queues session_start and page_view');

    for (let index = 0; index < 98; index += 1) {
      telemetry.track('custom_event', { index });
    }

    assert.equal(harness.beacons.length, 1, 'one beacon is sent when the 100-event threshold is reached');
    assert.equal(harness.beacons[0].endpoint, '/telemetry');
    assert.equal(harness.beacons[0].payload.events.length, 100);
    assert.equal(telemetry.getTelemetryStats().queued, 0);
    assert.equal(telemetry.getTelemetryStats().sent, 100);
  },

  async function flushesOnPageUnload() {
    const { harness, telemetry } = await loadTelemetry('unload');
    initTelemetry(telemetry);
    telemetry.track('custom_event', { action: 'queued-before-unload' });

    assert.equal(telemetry.getTelemetryStats().queued, 3);
    harness.dispatchBeforeUnload();

    assert.equal(harness.beacons.length, 1, 'beforeunload flushes queued telemetry');
    assert.equal(harness.beacons[0].payload.events.length, 3);
    assert.equal(telemetry.getTelemetryStats().queued, 0);
    assert.equal(telemetry.getTelemetryStats().sent, 3);
  },

  async function preservesPartialBatchAfterThresholdFlush() {
    const { harness, telemetry } = await loadTelemetry('partial-batch');
    initTelemetry(telemetry);

    for (let index = 0; index < 100; index += 1) {
      telemetry.track('custom_event', { index });
    }

    assert.equal(harness.beacons.length, 1);
    assert.equal(harness.beacons[0].payload.events.length, 100);
    assert.equal(telemetry.getTelemetryStats().queued, 2, 'events after the flushed batch stay queued');
    assert.equal(telemetry.getTelemetryStats().sent, 100);
  },

  async function resetsFlushStateAfterSuccessfulFlush() {
    const { harness, telemetry } = await loadTelemetry('reset');
    initTelemetry(telemetry, { batchSize: 3 });

    telemetry.track('custom_event', { action: 'threshold-flush' });

    assert.equal(harness.beacons.length, 1);
    assert.equal(telemetry.getTelemetryStats().queued, 0);
    assert.equal(telemetry.getTelemetryStats().sent, 3);

    telemetry.track('custom_event', { action: 'fresh-batch' });

    assert.equal(harness.beacons.length, 1, 'a new partial batch does not reuse the old threshold');
    assert.equal(telemetry.getTelemetryStats().queued, 1);

    telemetry.forceFlush();

    assert.equal(harness.beacons.length, 2, 'manual flush works after the threshold flush completed');
    assert.equal(harness.beacons[1].payload.events.length, 1);
    assert.equal(telemetry.getTelemetryStats().queued, 0);
    assert.equal(telemetry.getTelemetryStats().sent, 4);
  },

  async function flushesWhenPageBecomesHidden() {
    const { harness, telemetry } = await loadTelemetry('visibility');
    initTelemetry(telemetry);

    assert.equal(telemetry.getTelemetryStats().queued, 2);
    harness.dispatchHiddenVisibility();

    assert.equal(harness.beacons.length, 1, 'hidden visibility state flushes queued telemetry');
    assert.equal(harness.beacons[0].payload.events.length, 2);
    assert.equal(telemetry.getTelemetryStats().queued, 0);
  },
];

await compileTelemetryModule();

try {
  for (const test of tests) {
    await test();
    console.log(`ok - ${test.name}`);
  }
  console.log(`${tests.length} telemetry batch tests passed`);
} finally {
  await rm(scratchDir, { recursive: true, force: true });
}
