'use strict';

const agentDaemon = require('./daemon/agent-daemon');

if (require.main === module) {
  agentDaemon.main().catch((error) => {
    console.error(`Daemon failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = agentDaemon;
