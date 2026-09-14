'use strict';

const path = require('path');
const { configureProjectWorkspace } = require('../core/project-workspace');

function parseArgs(argv) {
  const options = {
    projectRoot: process.cwd(),
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project' && i + 1 < argv.length) {
      options.projectRoot = argv[++i];
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log('Usage: node system/project/init-project.js --project <path>');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return null;
  }

  const workspace = configureProjectWorkspace(path.resolve(options.projectRoot));
  const result = {
    message: 'TinyAgentOffice project initialized.',
    projectRoot: workspace.projectRoot,
    officeRoot: workspace.paths.officeRoot,
    tasksPath: workspace.paths.tasksFile,
    registryPath: workspace.paths.registryFile,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.message);
    console.log(`Project: ${result.projectRoot}`);
    console.log(`Office: ${result.officeRoot}`);
  }

  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  main,
  parseArgs,
};
