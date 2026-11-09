/**
 * Socket.IO job lifecycle tests (node --test).
 *
 * Verifies the production fix:
 *  - a completed archive produces a completed job status with a download URL;
 *  - a temporary socket disconnect does NOT cancel a running download;
 *  - a reconnected socket recovers the job status via the `sync` handshake;
 *  - archive errors become a failed status;
 *  - cancel still works.
 *
 * The engine is injected as a controllable stub so the tests are deterministic
 * and never shell out to a real wget.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const jobStoreFactory = require('../socket/job-store');
const createSocketModule = require('../socket/socket');

function FakeSocket() {
  this.connected = true;
  this.busyToken = null;
  this.listeners = {};
  this.emitted = [];
}
FakeSocket.prototype.on = function (ev, fn) { this.listeners[ev] = fn; };
FakeSocket.prototype.emit = function (ev, payload) { this.emitted.push({ ev: ev, payload: payload }); };
FakeSocket.prototype.trigger = function (ev, arg) {
  if (this.listeners[ev]) this.listeners[ev](arg);
};
FakeSocket.prototype.emittedFor = function (ev) {
  return this.emitted.filter(function (e) { return e.ev === ev; }).map(function (e) { return e.payload; });
};

function FakeIO() {
  this.onConnection = null;
}
FakeIO.prototype.on = function (ev, fn) {
  if (ev === 'connection') this.onConnection = fn;
};
FakeIO.prototype.connect = function () {
  const s = new FakeSocket();
  if (this.onConnection) this.onConnection(s);
  return s;
};

/** Engine stub that records invocation and lets the test drive events later. */
function controlledEngine() {
  const state = {
    calls: 0, emitter: null, data: null, onFinished: null, cancelled: 0,
    handle: { cancel: () => { state.cancelled++; } },
  };
  state.fn = function (emitter, data, onFinished) {
    state.calls++;
    state.emitter = emitter;
    state.data = data;
    state.onFinished = onFinished;
    return state.handle;
  };
  return state;
}

/* ============ Job store unit tests ============ */

test('job store: completed event produces completed status and snapshot with URL', () => {
  const store = jobStoreFactory.create();
  store.create('t1');
  store.applyEvent('t1', { progress: 'Converting' });
  store.applyEvent('t1', { progress: 'Completed', file: 'a.com.zip', files: 7, url: '/download/a.com.zip' });

  const job = store.get('t1');
  assert.strictEqual(job.status, 'completed');
  assert.strictEqual(job.file, 'a.com.zip');
  assert.deepStrictEqual(store.snapshot(job), {
    progress: 'Completed', file: 'a.com.zip', files: 7, url: '/download/a.com.zip',
  });
});

test('job store: error event produces failed status and error snapshot', () => {
  const store = jobStoreFactory.create();
  store.create('t2');
  store.applyEvent('t2', { error: 'archive failed' });
  assert.strictEqual(store.get('t2').status, 'failed');
  assert.deepStrictEqual(store.snapshot(store.get('t2')), { error: 'archive failed' });
});

test('job store: detaching a subscriber never deletes or finishes the job', () => {
  const store = jobStoreFactory.create();
  const subscriber = new FakeSocket();
  store.create('t3', { subscriber: subscriber });
  store.detachBySubscriber(subscriber);
  const job = store.get('t3');
  assert.ok(job, 'job survives detach');
  assert.strictEqual(job.subscriber, null);
  assert.strictEqual(job.status, 'starting');
});

test('job store: sweep removes expired jobs', () => {
  const store = jobStoreFactory.create({ ttlMs: 1000 });
  store.create('old');
  store.applyEvent('old', { progress: 'Completed', file: 'x.zip', files: 1 });
  store.get('old').createdAt = Date.now() - 5000; // age it beyond TTL
  store.sweep();
  assert.strictEqual(store.get('old'), null);
});

/* ============ Socket wiring tests ============ */

test('socket: successful completion delivers a completed status with download file', () => {
  const io = new FakeIO();
  const store = jobStoreFactory.create();
  createSocketModule(io, { store: store, engine: function (emitter, data, onFinished) {
    emitter.emit(data.token, { progress: 'Completed', file: 'site.com.zip', files: 3 });
    onFinished();
    return { cancel: function () {} };
  } });

  const socket = io.connect();
  socket.trigger('request', { website: 'https://site.com', token: 'tA' });

  assert.strictEqual(store.get('tA').status, 'completed');
  const delivered = socket.emittedFor('tA').pop();
  assert.deepStrictEqual(delivered, { progress: 'Completed', file: 'site.com.zip', files: 3 });
  assert.ok(socket.busyToken === null, 'busy token cleared after completion');
});

test('socket: disconnect does NOT cancel the running download and sync recovers it', () => {
  const io = new FakeIO();
  const store = jobStoreFactory.create();
  const engine = controlledEngine();
  createSocketModule(io, { store: store, engine: engine.fn });

  const socketA = io.connect();
  socketA.trigger('request', { website: 'https://example.com', token: 'tR' });
  assert.strictEqual(engine.calls, 1);

  // Transport drop.
  socketA.trigger('disconnect');

  // The job must NOT have been cancelled.
  assert.strictEqual(engine.cancelled, 0, 'cancel() must not be called on disconnect');
  assert.strictEqual(store.get('tR').subscriber, null, 'subscriber detached but job alive');
  assert.strictEqual(store.get('tR').status, 'starting');

  // Meanwhile the engine finishes successfully (independent of the socket).
  engine.emitter.emit('tR', { progress: 'Converting' });
  engine.emitter.emit('tR', { progress: 'Completed', file: 'example.com.zip', files: 5, url: '/download/example.com.zip' });
  assert.strictEqual(store.get('tR').status, 'completed');

  // Client reconnects on a new socket and recovers.
  const socketB = io.connect();
  socketB.trigger('sync', { token: 'tR' });
  const recovered = socketB.emittedFor('tR').pop();
  assert.deepStrictEqual(recovered, {
    progress: 'Completed', file: 'example.com.zip', files: 5, url: '/download/example.com.zip',
  });
  assert.strictEqual(store.get('tR').subscriber, socketB);
  assert.strictEqual(socketB.busyToken, 'tR');
});

test('socket: cancel stops the job and marks it cancelled', () => {
  const io = new FakeIO();
  const store = jobStoreFactory.create();
  const engine = controlledEngine();
  createSocketModule(io, { store: store, engine: engine.fn });

  const socket = io.connect();
  socket.trigger('request', { website: 'https://example.com', token: 'tC' });
  socket.trigger('cancel', { token: 'tC' });

  assert.strictEqual(engine.cancelled, 1, 'cancel() invoked');
  assert.strictEqual(store.get('tC').status, 'cancelled');
});

test('socket: archive error becomes a failed status delivered to the client', () => {
  const io = new FakeIO();
  const store = jobStoreFactory.create();
  createSocketModule(io, { store: store, engine: function (emitter, data, onFinished) {
    emitter.emit(data.token, { error: 'The site downloaded but could not be compressed: boom' });
    onFinished();
    return { cancel: function () {} };
  } });

  const socket = io.connect();
  socket.trigger('request', { website: 'https://x.com', token: 'tE' });
  assert.strictEqual(store.get('tE').status, 'failed');
  const delivered = socket.emittedFor('tE').pop();
  assert.ok(delivered.error && delivered.error.includes('could not be compressed'));
});

test('socket: synchronous engine failure settles the job and frees the slot', () => {
  const io = new FakeIO();
  const store = jobStoreFactory.create();
  createSocketModule(io, {
    store: store,
    engine: function () { throw new Error('boom'); },
  });

  const socket = io.connect();
  socket.trigger('request', { website: 'https://e.com', token: 'tF' });
  const delivered = socket.emittedFor('tF').pop();
  assert.ok(delivered.error && delivered.error.includes('Could not start'));
  assert.strictEqual(store.get('tF').status, 'failed');
  assert.strictEqual(socket.busyToken, null, 'busy token released after start failure');
});
