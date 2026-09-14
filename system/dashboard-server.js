'use strict';

const dashboardServer = require('./dashboard/server');

if (require.main === module) {
  dashboardServer.main();
}

module.exports = dashboardServer;
