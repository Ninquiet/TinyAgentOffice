'use strict';

const migrateTasksFromMarkdown = require('./maintenance/migrate-tasks-from-markdown');

if (require.main === module) {
  migrateTasksFromMarkdown.main();
}

module.exports = migrateTasksFromMarkdown;
