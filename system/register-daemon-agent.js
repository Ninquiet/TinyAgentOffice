'use strict';

const registerDaemonAgent = require('./daemon/register-daemon-agent');

if (require.main === module) {
  registerDaemonAgent.main();
}

module.exports = registerDaemonAgent;
