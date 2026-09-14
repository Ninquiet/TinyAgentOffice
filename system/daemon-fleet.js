'use strict';

const daemonFleet = require('./daemon/daemon-fleet');

if (require.main === module) {
  daemonFleet.main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = daemonFleet;
