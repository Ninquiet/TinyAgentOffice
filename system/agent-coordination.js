'use strict';

const { main } = require('./cli/main');

if (require.main === module) {
  main();
}

module.exports = {
  main,
};
