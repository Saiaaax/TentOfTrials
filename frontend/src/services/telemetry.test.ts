import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetTelemetryForTests,
  forceFlush,
  getTelemetryStats,
  initTelemetry,
  track,
} from './telemetry';

const endpoint = 'https://telemetry.example.test/events';

function latestBeaconPayload(sendBeacon: ReturnType<typeof vi.fn>) {
  const payload = sendBeacon.mock.calls.at(-1)?.[1] as string;
  return JSON.parse(payload) as { events: Array<{ type: string; properties: Record<string, unknown> }> };
}

function trackEvents(count: number): void {
  for (let index = 0; index < count; index += 1) {
    track('custom_event', { index });
  }
}

describe('telemetry batch flush behavior', () => {
  let sendBeacon: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    __resetTelemetryForTests();
    sendBeacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: sendBeacon,
    });
    initTelemetry({
      enabled: true,
      endpoint,
      batchSize: 100,
      flushInterval: 60_000,
      sampleRate: 1,
    });
    forceFlush();
    sendBeacon.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes automatically when the 100 event batch threshold is reached', () => {
    trackEvents(99);

    expect(sendBeacon).not.toHaveBeenCalled();
    expect(getTelemetryStats().queued).toBe(99);

    track('custom_event', { index: 99 });

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(sendBeacon).toHaveBeenCalledWith(endpoint, expect.any(String));
    expect(latestBeaconPayload(sendBeacon).events).toHaveLength(100);
  });

  it('flushes the queued batch when the page is unloading', () => {
    trackEvents(3);

    window.dispatchEvent(new Event('beforeunload'));

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(latestBeaconPayload(sendBeacon).events).toHaveLength(3);
    expect(getTelemetryStats().queued).toBe(0);
  });

  it('preserves partial batches below the flush threshold', () => {
    trackEvents(98);

    expect(sendBeacon).not.toHaveBeenCalled();
    expect(getTelemetryStats().queued).toBe(98);
  });

  it('resets queue and retry state after a successful forced flush', () => {
    trackEvents(4);

    forceFlush();

    const stats = getTelemetryStats();
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(stats.queued).toBe(0);
    expect(stats.sent).toBe(6);
    expect(stats.errors).toBe(0);
  });
});
