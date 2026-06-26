import {
  forceFlush,
  getTelemetryStats,
  initTelemetry,
  setTelemetryEnabled,
  track,
} from './telemetry.ts';

type Listener = () => void;

const windowListeners: Record<string, Listener[]> = {};
const documentListeners: Record<string, Listener[]> = {};
const fetchBodies: string[] = [];

function expectEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function expectTrue(value: unknown, message: string): void {
  if (!value) {
    throw new Error(`${message}: expected truthy value`);
  }
}

function installBrowserMocks(): void {
  fetchBodies.length = 0;
  for (const key of Object.keys(windowListeners)) delete windowListeners[key];
  for (const key of Object.keys(documentListeners)) delete documentListeners[key];

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      innerWidth: 1280,
      innerHeight: 720,
      location: { href: 'https://example.test/dashboard', origin: 'https://example.test' },
      addEventListener(type: string, listener: Listener): void {
        windowListeners[type] ??= [];
        windowListeners[type].push(listener);
      },
      setInterval(): number {
        return 1;
      },
      clearInterval(): void {},
    },
  });

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      title: 'Telemetry Test',
      referrer: '',
      visibilityState: 'visible',
      addEventListener(type: string, listener: Listener): void {
        documentListeners[type] ??= [];
        documentListeners[type].push(listener);
      },
    },
  });

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: 'telemetry-test',
      language: 'en-US',
      hardwareConcurrency: 4,
    },
  });

  Object.defineProperty(globalThis, 'screen', {
    configurable: true,
    value: { width: 1280, height: 720 },
  });

  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (_url: string, init?: { body?: string }) => {
      if (init?.body) {
        fetchBodies.push(init.body);
      }
      return { ok: true };
    },
  });
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

function dispatchWindowEvent(type: string): void {
  for (const listener of windowListeners[type] ?? []) {
    listener();
  }
}

function parsedBatch(index: number): { events: unknown[]; sentAt: number } {
  return JSON.parse(fetchBodies[index]) as { events: unknown[]; sentAt: number };
}

async function resetTelemetry(batchSize: number): Promise<number> {
  installBrowserMocks();
  setTelemetryEnabled(false);
  initTelemetry({
    enabled: true,
    endpoint: 'https://telemetry.example.test/events',
    batchSize,
    flushInterval: 60_000,
    sampleRate: 1,
  });

  forceFlush();
  await waitFor(() => getTelemetryStats().queued === 0, 'initial telemetry events should flush');
  fetchBodies.length = 0;

  return getTelemetryStats().sent;
}

async function testFlushesAtBatchThreshold(): Promise<void> {
  const sentBefore = await resetTelemetry(3);

  track('custom_event', { sequence: 1 });
  track('custom_event', { sequence: 2 });
  track('custom_event', { sequence: 3 });

  await waitFor(() => fetchBodies.length === 1, 'batch threshold should trigger a fetch');
  expectEqual(parsedBatch(0).events.length, 3, 'threshold flush sends exactly one full batch');
  expectEqual(getTelemetryStats().queued, 0, 'threshold flush clears the queue');
  expectEqual(getTelemetryStats().sent, sentBefore + 3, 'threshold flush increments sent count');
}

async function testPageUnloadFlushesQueuedEvents(): Promise<void> {
  await resetTelemetry(100);

  track('custom_event', { sequence: 1 });
  track('custom_event', { sequence: 2 });
  dispatchWindowEvent('beforeunload');

  await waitFor(() => fetchBodies.length === 1, 'beforeunload should flush queued telemetry');
  expectEqual(parsedBatch(0).events.length, 2, 'beforeunload sends queued events below threshold');
  expectEqual(getTelemetryStats().queued, 0, 'beforeunload flush clears the queue');
}

async function testPartialBatchIsPreserved(): Promise<void> {
  await resetTelemetry(3);

  track('custom_event', { sequence: 1 });
  track('custom_event', { sequence: 2 });
  track('custom_event', { sequence: 3 });
  track('custom_event', { sequence: 4 });

  await waitFor(() => fetchBodies.length === 1, 'full batch should flush once');
  expectEqual(parsedBatch(0).events.length, 3, 'full batch sends only batchSize events');
  expectEqual(getTelemetryStats().queued, 1, 'event beyond threshold remains queued');
}

async function testFlushStateResetsAfterSuccessfulFlush(): Promise<void> {
  await resetTelemetry(2);

  track('custom_event', { batch: 1, sequence: 1 });
  track('custom_event', { batch: 1, sequence: 2 });
  await waitFor(() => fetchBodies.length === 1, 'first batch should flush');

  track('custom_event', { batch: 2, sequence: 1 });
  track('custom_event', { batch: 2, sequence: 2 });
  await waitFor(() => fetchBodies.length === 2, 'second batch should flush after state reset');

  expectEqual(parsedBatch(0).events.length, 2, 'first batch has expected size');
  expectEqual(parsedBatch(1).events.length, 2, 'second batch has expected size');
  expectEqual(getTelemetryStats().queued, 0, 'queue is empty after repeated flushes');
  expectTrue(getTelemetryStats().errors === 0, 'successful flushes do not record errors');
}

await testFlushesAtBatchThreshold();
await testPageUnloadFlushesQueuedEvents();
await testPartialBatchIsPreserved();
await testFlushStateResetsAfterSuccessfulFlush();
