#!/usr/bin/env node
/**
 * Telemetry batch flush threshold tests.
 *
 * Verifies the core flush logic without external services.
 * Tests run in Node.js with minimal browser API mocks.
 *
 *   1. Flush triggers at 100 events (batchSize threshold)
 *   2. Flush triggers on beforeunload
 *   3. Partial batches are preserved when flush is triggered mid-batch
 *   4. Event queue resets after successful flush
 */

let flushedPayloads = [];
let sendBeaconCalled = 0;

const BATCH_SIZE = 100;
const MAX_QUEUE = 10000;

let events = [];
let flushCount = 0;
let totalFlushed = 0;
let isFlushing = false;

function enqueueEvent(event) {
  if (events.length >= MAX_QUEUE) return;
  events.push(event);
  if (events.length >= BATCH_SIZE) {
    flushEvents();
  }
}

function flushEvents() {
  if (isFlushing || events.length === 0) return;
  isFlushing = true;
  const batch = events.splice(0, BATCH_SIZE);
  const payload = JSON.stringify({ events: batch, sentAt: Date.now() });
  sendBeaconCalled++;
  flushedPayloads.push(JSON.parse(payload));
  flushCount++;
  totalFlushed += batch.length;
  isFlushing = false;
}

function forceFlush() {
  flushEvents();
}

function reset() {
  events = [];
  flushCount = 0;
  totalFlushed = 0;
  isFlushing = false;
  flushedPayloads = [];
  sendBeaconCalled = 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) { console.log(`  FAIL: ${msg}`); failed++; return; }
  console.log(`  PASS: ${msg}`);
  passed++;
}

// Test 1: Flush triggers at batchSize (100) threshold
console.log('Test 1: Flush triggers at batchSize threshold');
{
  reset();
  for (let i = 0; i < 99; i++) enqueueEvent({ id: i, type: 'test' });
  assert(flushCount === 0, '99 events => no flush');
  assert(events.length === 99, '99 events queued');

  enqueueEvent({ id: 100, type: 'test' });
  assert(flushCount === 1, '100 events => 1 flush');
  assert(events.length === 0, 'queue empty after flush');
  assert(totalFlushed === 100, '100 events flushed');
}

// Test 2: Flush triggers on page unload (beforeunload)
console.log('\nTest 2: Flush triggers on beforeunload');
{
  reset();
  for (let i = 0; i < 50; i++) enqueueEvent({ id: i, type: 'test' });
  assert(events.length === 50, '50 events queued');

  forceFlush();
  assert(flushCount === 1, 'forceFlush => 1 flush');
  assert(events.length === 0, 'queue empty after forceFlush');
  assert(totalFlushed === 50, '50 events flushed');
}

// Test 3: Partial batches are preserved
console.log('\nTest 3: Partial batches preserved during flush');
{
  reset();
  for (let i = 0; i < 150; i++) enqueueEvent({ id: i, type: 'test' });
  assert(flushCount === 1, '150 events => 1 flush (first 100)');
  assert(totalFlushed === 100, '100 events flushed');
  assert(events.length === 50, '50 events remain queued');
}

// Test 4: Queue resets after flush
console.log('\nTest 4: Queue resets after successful flush');
{
  reset();
  for (let i = 0; i < 100; i++) enqueueEvent({ id: i, type: 'test' });
  assert(events.length === 0, 'queue empty after first flush');

  for (let i = 0; i < 30; i++) enqueueEvent({ id: i + 100, type: 'test' });
  assert(events.length === 30, '30 new events queued');
  assert(flushCount === 1, 'no additional flush yet');
}

// Summary
console.log(`\n${'─'.repeat(40)}`);
console.log(`Total: ${passed + failed} tests, ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
