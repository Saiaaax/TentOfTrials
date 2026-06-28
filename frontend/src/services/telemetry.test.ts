/// <reference types="vite/client" />

// Mock global browser environment before importing telemetry
const beforeUnloadListeners: (() => void)[] = [];
let visibilityChangeListener: any = null;

const mockDocument = {
  addEventListener: (event: string, cb: () => void) => {
    if (event === 'visibilitychange') {
      visibilityChangeListener = cb;
    }
  },
  removeEventListener: () => {},
  title: 'Test Title',
  referrer: '',
  visibilityState: 'visible',
};

const mockWindow = {
  addEventListener: (event: string, cb: () => void) => {
    if (event === 'beforeunload') {
      beforeUnloadListeners.push(cb);
    }
  },
  removeEventListener: () => {},
  location: { href: 'http://localhost/' },
  origin: 'http://localhost',
  setInterval: (cb: () => void, ms: number) => setInterval(cb, ms),
  clearInterval: (id: any) => clearInterval(id),
};

let sendBeaconMock = () => true;

const mockNavigator = {
  userAgent: 'NodeTestAgent',
  language: 'en-US',
  hardwareConcurrency: 4,
  get sendBeacon() {
    return sendBeaconMock;
  }
};

const mockScreen = {
  width: 1920,
  height: 1080,
};

globalThis.window = mockWindow as any;
globalThis.document = mockDocument as any;
globalThis.navigator = mockNavigator as any;
globalThis.screen = mockScreen as any;

// Now import the telemetry service
import {
  initTelemetry,
  track,
  forceFlush,
  getTelemetryStats,
  setTelemetryEnabled,
} from './telemetry';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function expectEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// Helper to reset telemetry state (since it's a module-scoped singleton)
let initialSentCount = 0;
function resetTelemetryState(batchSize = 5) {
  setTelemetryEnabled(false);
  setTelemetryEnabled(true);
  
  // Re-initialize with test config
  initTelemetry({
    endpoint: 'http://localhost/api/telemetry',
    batchSize: batchSize,
    flushInterval: 60000,
    enabled: true,
    debug: false,
  });
  
  initialSentCount = getTelemetryStats().sent;
}

// ---------------------------------------------------------------------------
// TEST 1: Flush triggers at threshold
// ---------------------------------------------------------------------------
console.log('Running Test 1: Flush triggers at threshold...');
resetTelemetryState(5);

const initialStats = getTelemetryStats();
expectEqual(initialStats.queued, 2, 'Session start and page view automatically queued on init'); 
expectEqual(initialStats.sent - initialSentCount, 0, 'No events sent initially');

track('custom_event', { value: 'A' });
track('custom_event', { value: 'B' });

expectEqual(getTelemetryStats().queued, 4, '4 events queued (2 initial + 2 custom)');

// The 5th event will hit the batch size threshold of 5
sendBeaconMock = () => true;
track('custom_event', { value: 'C' });

expectEqual(getTelemetryStats().queued, 0, 'Queue reset to 0 after batch threshold flush');
expectEqual(getTelemetryStats().sent - initialSentCount, 5, '5 events successfully sent');

// ---------------------------------------------------------------------------
// TEST 2: Flush triggers on page unload / visibility hidden
// ---------------------------------------------------------------------------
console.log('Running Test 2: Flush triggers on visibility change / page unload...');
resetTelemetryState(10); // Batch size 10

track('custom_event', { value: 'A' });
track('custom_event', { value: 'B' });
expectEqual(getTelemetryStats().queued, 4, '4 events in queue (2 initial + 2 custom)');

// Trigger page hidden visibility change
mockDocument.visibilityState = 'hidden';
if (visibilityChangeListener) {
  visibilityChangeListener();
}

expectEqual(getTelemetryStats().queued, 0, 'Queue flushed on page visibility hidden');
expectEqual(getTelemetryStats().sent - initialSentCount, 4, '4 events sent via visibility change');

// Reset visibility state
mockDocument.visibilityState = 'visible';

// Test beforeunload trigger
resetTelemetryState(10);
track('custom_event', { value: 'A' });
expectEqual(getTelemetryStats().queued, 3, '3 events in queue (2 initial + 1 custom)');

for (const listener of beforeUnloadListeners) {
  listener();
}

expectEqual(getTelemetryStats().queued, 0, 'Queue flushed on page unload');

// ---------------------------------------------------------------------------
// TEST 3: Partial batches are preserved on failure
// ---------------------------------------------------------------------------
console.log('Running Test 3: Partial batches are preserved on failure...');
resetTelemetryState(5);

track('custom_event', { value: 'A' });
track('custom_event', { value: 'B' });
// 2 initial + 2 custom = 4 queued

// Make transport fail
sendBeaconMock = () => false;

// Trigger threshold flush by adding 5th event
track('custom_event', { value: 'C' });

// Since sendBeacon returned false, the batch of 5 events should be re-queued
expectEqual(getTelemetryStats().queued, 5, '5 events preserved in queue on transport failure');
expectEqual(getTelemetryStats().errors, 1, '1 flush error registered');

// Make transport succeed and flush again
sendBeaconMock = () => true;
forceFlush();

expectEqual(getTelemetryStats().queued, 0, 'Queue successfully flushed after transport recovery');

// ---------------------------------------------------------------------------
// TEST 4: Reset after flush
// ---------------------------------------------------------------------------
console.log('Running Test 4: Reset after flush...');
resetTelemetryState(5);
track('custom_event', { value: 'A' });
expectEqual(getTelemetryStats().queued, 3, '3 events queued');

forceFlush();
expectEqual(getTelemetryStats().queued, 0, 'Queue is 0 after force flush');

track('custom_event', { value: 'B' });
expectEqual(getTelemetryStats().queued, 1, 'Queue correctly starts counting from 0 again (session auto-start does not fire on track, only init)');

// Stop telemetry to clear any active setInterval timers so the test process can exit naturally
setTelemetryEnabled(false);

console.log('\nAll Telemetry tests passed successfully!');
