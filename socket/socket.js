var wget = require('../wget');

var MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_DOWNLOADS) || 5;
var activeJobs = 0;
var sockets = new Set();

module.exports = (io) => {
  io.on('connection', function (socket) {
    sockets.add(socket);

    socket.on('disconnect', function () {
      sockets.delete(socket);
      if (socket.job) {
        socket.job.cancel();
        socket.job = null;
      }
    });

    socket.on('error', function (err) {
      console.error('socket error:', err && err.message);
    });

    socket.on('cancel', function () {
      if (socket.job) {
        socket.job.cancel();
        socket.job = null;
      }
    });

    socket.on('request', function (data) {
      if (!data || typeof data.token !== 'string' || !data.token) return;

      if (socket.job) {
        socket.emit(data.token, { error: 'A download is already running on this connection.' });
        return;
      }

      if (activeJobs >= MAX_CONCURRENT) {
        socket.emit(data.token, { error: 'Too many downloads are running right now. Please try again in a moment.' });
        return;
      }

      activeJobs++;
      socket.emit(data.token, { progress: 'Starting' });

      socket.job = wget(socket, data, function () {
        socket.job = null;
        activeJobs = Math.max(0, activeJobs - 1);
      });
    });
  });

  return {
    cancelAll: function () {
      sockets.forEach(function (s) {
        if (s.job) { s.job.cancel(); s.job = null; }
      });
      activeJobs = 0;
    }
  };
};
