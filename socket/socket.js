/**
 * socket/socket.js — classic Socket.IO wiring for the Wget engine.
 *
 * The job lifecycle is decoupled from the live socket via a job store
 * (./job-store). A temporary browser/proxy disconnect must NOT cancel a running
 * download; instead the job keeps running server-side, and a reconnected client
 * recovers its current status through the `sync` handshake:
 *
 *   client --request(token)--> server creates job, starts Wget
 *   ... transport drop ...
 *   server                       job continues (not cancelled)
 *   client --sync(token)-->      server replays snapshot (running/converting/
 *                               completed/failed/cancelled)
 *
 * The engine is injectable for tests (defaults to ../wget).
 */
'use strict';

var wgetReal = require('../wget');
var jobStoreFactory = require('./job-store');

module.exports = function createSocketModule(io, opts) {
  var engine = (opts && opts.engine) || wgetReal;
  var store = (opts && opts.store) || jobStoreFactory.create();

  var MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_DOWNLOADS) || 5;
  var activeJobs = 0;

  io.on('connection', function (socket) {
    socket.on('request', function (data) {
      if (!data || typeof data.token !== 'string' || !data.token) return;

      if (socket.busyToken) {
        socket.emit(data.token, { error: 'A download is already running on this connection.' });
        return;
      }

      if (activeJobs >= MAX_CONCURRENT) {
        socket.emit(data.token, { error: 'Too many downloads are running right now. Please try again in a moment.' });
        return;
      }

      var token = data.token;
      var job = store.create(token, { subscriber: socket });
      socket.busyToken = token;
      activeJobs++;

      // Forward the engine's events to the store (authoritative state) and to
      // whichever socket is currently attached (may be null while offline).
      var emitter = {
        emit: function (t, payload) {
          store.applyEvent(t, payload);
          var current = store.get(t);
          if (current && current.subscriber && current.subscriber.connected !== false) {
            current.subscriber.emit(t, payload);
          }
        },
      };

      var release = function () {
        socket.busyToken = null;
        activeJobs = Math.max(0, activeJobs - 1);
      };

      var handle;
      try {
        handle = engine(emitter, data, release);
      } catch (err) {
        // Never leak the slot: an engine that throws synchronously must still
        // settle the job and release the activeJobs budget.
        store.applyEvent(token, { error: 'Could not start the download: ' + (err && err.message) });
        emitter.emit(token, { error: 'Could not start the download: ' + (err && err.message) });
        release();
        return;
      }
      store.attach(token, handle);
    });

    // Recovery handshake: a (re)connected client asks for the current state of
    // its existing job. Attach this socket so future events reach it.
    socket.on('sync', function (data) {
      if (!data || typeof data.token !== 'string') return;
      var job = store.get(data.token);
      if (!job) {
        socket.emit(data.token, { error: 'This download session is no longer available.' });
        return;
      }
      job.subscriber = socket;
      socket.busyToken = job.token;
      console.log('[job ' + data.token + '] socket sync status=' + job.status);
      socket.emit(data.token, store.snapshot(job));
    });

    socket.on('cancel', function (data) {
      var token = data && data.token;
      if (!token) {
        // Legacy: cancel whatever this socket is running.
        if (socket.busyToken) token = socket.busyToken;
      }
      if (!token) return;
      var job = store.get(token);
      if (job && job.handle) {
        console.log('[job ' + token + '] cancel requested by client');
        store.markCancelled(token);
        job.handle.cancel();
      }
    });

    socket.on('disconnect', function () {
      // Do NOT cancel the running job. Detach as subscriber so the job can be
      // recovered on reconnect via `sync`. Only clean up the socket refs.
      store.detachBySubscriber(socket);
      if (socket.busyToken) {
        console.log('[job ' + socket.busyToken + '] socket disconnected; job continues (recovery available)');
      }
    });

    socket.on('error', function (err) {
      console.error('socket error:', err && err.message);
    });
  });

  return {
    cancelAll: function () {
      store.all().forEach(function (job) {
        if (job.handle) job.handle.cancel();
      });
      activeJobs = 0;
    },
    // Exposed for tests.
    _store: store,
  };
};
