'use strict';

const validateAssignContention = require('./validation/validate-assign-contention');

if (require.main === module) {
  validateAssignContention.main().catch((error) => {
    console.error(`Atomic assign validation failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = validateAssignContention;
