'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const { APP_ROOT } = require('../core/project-workspace');

const ROOT = APP_ROOT;
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const RETRY_INTERVAL_MS = 15 * 1000;

function parseSemver(value) {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(value || ''));
  if (!match) return null;
  return {
    raw: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

function compareSemver(a, b) {
  if (!a || !b) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  return 0;
}

function commandForPlatform(command) {
  if (process.platform === 'win32' && command === 'npm') return 'npm.cmd';
  return command;
}

function runCommand(command, args, options = {}) {
  const executable = commandForPlatform(command);
  const env = { ...process.env, ...(options.env || {}) };
  if (command === 'opencode') env.OPENCODE_DISABLE_AUTOUPDATE = 'true';
  const result = spawnSync(executable, args, {
    cwd: options.cwd || ROOT,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout || 10000,
  });
  return {
    status: result.status,
    error: result.error || null,
    output: `${result.stdout || ''}\n${result.stderr || ''}`,
  };
}

function requireSuccessfulOutput(command, args, options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = result.output.trim();
    throw new Error(output || `${command} ${args.join(' ')} failed.`);
  }
  return result.output;
}

function commandExists(command) {
  const executable = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(executable, [command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  return result.status === 0;
}

function optionalOutput(command, args, options = {}) {
  try {
    return requireSuccessfulOutput(command, args, options);
  } catch (_) {
    return null;
  }
}

function detectOpencodeBinaryPath() {
  const output = optionalOutput(process.platform === 'win32' ? 'where.exe' : 'which', ['opencode']);
  return output ? output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || null : null;
}

function defaultInstallCommand() {
  if (process.platform === 'win32') {
    if (commandExists('winget')) return 'winget install --id SST.opencode --exact';
    if (commandExists('scoop')) return 'scoop install opencode';
    if (commandExists('choco')) return 'choco install opencode -y';
    return 'npm install -g opencode-ai';
  }
  if (commandExists('brew')) return 'brew install anomalyco/tap/opencode';
  if (commandExists('npm')) return 'npm install -g opencode-ai';
  return 'curl -fsSL https://opencode.ai/install | bash';
}

function packageManagerInfo(binaryPath) {
  const normalizedPath = String(binaryPath || '').toLowerCase();

  if (process.platform === 'win32' && normalizedPath.includes('\\microsoft\\winget\\links\\')) {
    return {
      manager: 'winget',
      updateCommand: 'winget upgrade --id SST.opencode --exact',
      installCommand: 'winget install --id SST.opencode --exact',
      warning: 'Close all OpenCode and agent terminals before updating, otherwise Windows may block replacing opencode.exe.',
    };
  }

  if (process.platform === 'win32' && commandExists('scoop')) {
    const scoopList = optionalOutput('scoop', ['list', 'opencode']);
    if (scoopList && /opencode/i.test(scoopList)) {
      return {
        manager: 'scoop',
        updateCommand: 'scoop update opencode',
        installCommand: 'scoop install opencode',
        warning: 'Close all OpenCode and agent terminals before updating.',
      };
    }
  }

  if (process.platform === 'win32' && commandExists('choco')) {
    const chocoList = optionalOutput('choco', ['list', '--local-only', 'opencode']);
    if (chocoList && /opencode/i.test(chocoList)) {
      return {
        manager: 'chocolatey',
        updateCommand: 'choco upgrade opencode -y',
        installCommand: 'choco install opencode -y',
        warning: 'Run the helper terminal as Administrator if Chocolatey requires elevation.',
      };
    }
  }

  if (commandExists('brew')) {
    const brewList = optionalOutput('brew', ['list', '--formula', 'opencode']);
    if (brewList != null) {
      return {
        manager: 'brew',
        updateCommand: 'brew upgrade anomalyco/tap/opencode',
        installCommand: 'brew install anomalyco/tap/opencode',
        warning: 'The OpenCode tap is preferred for current releases.',
      };
    }
  }

  if (commandExists('npm')) {
    const npmList = optionalOutput('npm', ['list', '-g', 'opencode-ai', '--depth=0']);
    if (npmList && /opencode-ai@/i.test(npmList)) {
      return {
        manager: 'npm',
        updateCommand: 'npm install -g opencode-ai@latest',
        installCommand: 'npm install -g opencode-ai',
        warning: 'Use the same Node/npm installation that is on your PATH.',
      };
    }
  }

  if (commandExists('pnpm')) {
    const pnpmList = optionalOutput('pnpm', ['list', '-g', 'opencode-ai', '--depth=0']);
    if (pnpmList && /opencode-ai/i.test(pnpmList)) {
      return {
        manager: 'pnpm',
        updateCommand: 'pnpm install -g opencode-ai@latest',
        installCommand: 'pnpm install -g opencode-ai',
      };
    }
  }

  if (commandExists('bun')) {
    const bunList = optionalOutput('bun', ['pm', 'ls', '-g']);
    if (bunList && /opencode-ai/i.test(bunList)) {
      return {
        manager: 'bun',
        updateCommand: 'bun install -g opencode-ai@latest',
        installCommand: 'bun install -g opencode-ai',
      };
    }
  }

  return {
    manager: binaryPath ? 'unknown' : 'missing',
    updateCommand: binaryPath ? 'opencode upgrade' : defaultInstallCommand(),
    installCommand: defaultInstallCommand(),
    warning: binaryPath
      ? 'OpenCode is installed, but the package manager could not be detected. Review the command before running it.'
      : 'OpenCode was not found on PATH. Install it, then restart the dashboard.',
  };
}

function currentOpencodeVersion(binaryPath) {
  if (!binaryPath) return null;
  return parseSemver(requireSuccessfulOutput('opencode', ['--version'], { timeout: 8000 }));
}

function parseWingetUpgrade(output) {
  if (/No available upgrade found|No newer package versions are available/i.test(output)) {
    return { updateAvailable: false, latestVersion: null };
  }
  const line = output.split(/\r?\n/).find((entry) => /SST\.opencode/i.test(entry));
  if (!line) return { updateAvailable: null, latestVersion: null };
  const columns = line.trim().split(/\s+/);
  const idIndex = columns.findIndex((entry) => /^SST\.opencode$/i.test(entry));
  const latest = idIndex >= 0 ? columns[idIndex + 2] : null;
  return { updateAvailable: Boolean(latest), latestVersion: parseSemver(latest) };
}

function checkWinget() {
  const result = runCommand('winget', ['upgrade', '--id', 'SST.opencode', '--exact'], { timeout: 12000 });
  const parsed = parseWingetUpgrade(result.output || '');
  if (parsed.updateAvailable !== null) return parsed;
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.output.trim() || 'winget update check failed.');
  return parsed;
}

function checkScoop() {
  const output = optionalOutput('scoop', ['status', 'opencode'], { timeout: 12000 }) || '';
  if (!/opencode/i.test(output) || /Everything is ok|No updates/i.test(output)) {
    return { updateAvailable: false, latestVersion: null };
  }
  const match = output.match(/opencode[^\r\n]*?(\d+\.\d+\.\d+)[^\r\n]*?(?:->|available|latest)[^\r\n]*?(\d+\.\d+\.\d+)/i);
  return { updateAvailable: true, latestVersion: parseSemver(match ? match[2] : null) };
}

function checkChocolatey() {
  const output = optionalOutput('choco', ['outdated', 'opencode', '--limit-output'], { timeout: 15000 }) || '';
  const line = output.split(/\r?\n/).find((entry) => /^opencode\|/i.test(entry));
  if (!line) return { updateAvailable: false, latestVersion: null };
  const [, , latest] = line.split('|');
  return { updateAvailable: true, latestVersion: parseSemver(latest) };
}

function checkBrew() {
  const result = runCommand('brew', ['outdated', '--formula', 'opencode'], { timeout: 15000 });
  const output = result.output || '';
  if (!/opencode/i.test(output)) return { updateAvailable: false, latestVersion: null };
  const versions = output.match(/\d+\.\d+\.\d+/g) || [];
  return { updateAvailable: true, latestVersion: parseSemver(versions[versions.length - 1]) };
}

function packageLatestVersion(command) {
  const output = requireSuccessfulOutput(command, ['view', 'opencode-ai', 'version', '--silent'], { timeout: 12000 });
  return parseSemver(output);
}

function checkPackageRegistry(manager, current) {
  const latest = packageLatestVersion(manager === 'pnpm' ? 'pnpm' : 'npm');
  return {
    updateAvailable: current && latest ? compareSemver(current, latest) < 0 : null,
    latestVersion: latest,
  };
}

function strategyCheck(manager, current) {
  if (manager === 'winget') return checkWinget();
  if (manager === 'scoop') return checkScoop();
  if (manager === 'chocolatey') return checkChocolatey();
  if (manager === 'brew') return checkBrew();
  if (manager === 'npm' || manager === 'bun') return checkPackageRegistry('npm', current);
  if (manager === 'pnpm') return checkPackageRegistry('pnpm', current);
  return { updateAvailable: null, latestVersion: null };
}

function resolveMaintenance() {
  const binaryPath = detectOpencodeBinaryPath();
  const install = packageManagerInfo(binaryPath);
  let current = null;
  let latest = null;
  let updateAvailable = null;
  let checkError = null;

  try {
    current = currentOpencodeVersion(binaryPath);
  } catch (error) {
    checkError = error.message;
  }

  if (binaryPath && install.manager !== 'unknown') {
    try {
      const checked = strategyCheck(install.manager, current);
      updateAvailable = checked.updateAvailable;
      latest = checked.latestVersion || (checked.updateAvailable === false ? current : null);
    } catch (error) {
      if (!checkError) checkError = error.message;
    }
  }

  return {
    installed: Boolean(binaryPath),
    binaryPath,
    manager: install.manager,
    updateCommand: install.updateCommand,
    installCommand: install.installCommand,
    warning: install.warning || null,
    currentVersion: current ? current.raw : null,
    latestVersion: latest ? latest.raw : null,
    updateAvailable,
    checkError,
  };
}

function createOpencodeMaintenanceService() {
  let cache = {
    checkedAt: 0,
    notifications: [],
    error: null,
  };

  function checkUpdates() {
    const now = Date.now();
    const retryable = cache.notifications.some((notification) => (
      notification.type === 'opencode-missing'
      || notification.id === 'opencode-update-check-failed'
    ));
    const cacheInterval = retryable ? RETRY_INTERVAL_MS : UPDATE_CHECK_INTERVAL_MS;
    if (now - cache.checkedAt < cacheInterval) return cache.notifications;

    try {
      const maintenance = resolveMaintenance();
      const notifications = [];
      if (!maintenance.installed) {
        notifications.push({
          id: 'opencode-not-installed',
          type: 'opencode-missing',
          severity: 'error',
          title: 'OpenCode is not installed',
          body: 'OpenCode was not found on PATH. Agent cartridges need OpenCode to launch terminals.',
          actionLabel: 'Fix',
          installCommand: maintenance.installCommand,
        });
      } else if (maintenance.updateAvailable === true) {
        notifications.push({
          id: 'opencode-update-available',
          type: 'opencode-update',
          severity: 'info',
          title: 'OpenCode update available',
          body: maintenance.latestVersion
            ? `OpenCode ${maintenance.latestVersion} is available. Installed version: ${maintenance.currentVersion || 'unknown'}.`
            : `An OpenCode update is available for ${maintenance.manager}.`,
          actionLabel: 'Fix',
          currentVersion: maintenance.currentVersion,
          latestVersion: maintenance.latestVersion,
          manager: maintenance.manager,
          updateCommand: maintenance.updateCommand,
        });
      } else if (maintenance.checkError) {
        notifications.push({
          id: 'opencode-update-check-failed',
          type: 'opencode-update',
          severity: 'warning',
          title: 'OpenCode update check failed',
          body: `Could not fully check OpenCode updates: ${maintenance.checkError}`,
          actionLabel: 'Fix',
          manager: maintenance.manager,
        });
      }

      cache = { checkedAt: now, notifications, error: null };
      return notifications;
    } catch (error) {
      const notifications = [{
        id: 'opencode-update-check-failed',
        type: 'opencode-update',
        severity: 'warning',
        title: 'OpenCode update check failed',
        body: `Could not check OpenCode updates: ${error.message}`,
        actionLabel: 'Fix',
      }];
      cache = { checkedAt: now, notifications, error: error.message };
      return notifications;
    }
  }

  function forceCheck() {
    cache.checkedAt = 0;
    return {
      notifications: checkUpdates(),
      error: cache.error,
      maintenance: resolveMaintenance(),
      checkedAt: cache.checkedAt ? new Date(cache.checkedAt).toISOString() : null,
    };
  }

  // Cache-only read for the render path: never shells out to check versions.
  // The world tick keeps the cache warm by calling checkUpdates.
  function peekNotifications() {
    return cache.notifications;
  }

  return {
    checkUpdates,
    peekNotifications,
    forceCheck,
    resolveMaintenance,
  };
}

module.exports = {
  commandExists,
  createOpencodeMaintenanceService,
  parseSemver,
  compareSemver,
};
