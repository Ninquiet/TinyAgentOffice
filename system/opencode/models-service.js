'use strict';

const { spawn } = require('child_process');

const OPENCODE_MODELS_CACHE_MS = 30000;

function stripAnsi(value) {
  return String(value || '').replace(/\x1B\[[0-9;]*m/g, '');
}

function parseOpencodeModelsOutput(raw) {
  return Array.from(new Set(
    stripAnsi(raw)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(line))
  )).sort((a, b) => a.localeCompare(b));
}

function runOpencodeModelsCommand({ cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn('opencode', ['models'], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out while loading OpenCode models.'));
    }, 20000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stripAnsi(stderr || stdout || 'Could not load OpenCode models.').trim()));
        return;
      }
      resolve(parseOpencodeModelsOutput(stdout));
    });
  });
}

function createOpencodeModelsService({ cwd }) {
  const cache = {
    loadedAt: null,
    models: [],
    lastError: null,
    inFlight: null,
  };

  async function getModels(options = {}) {
    const forceRefresh = Boolean(options.forceRefresh);
    const cacheAge = cache.loadedAt ? (Date.now() - cache.loadedAt) : Number.POSITIVE_INFINITY;
    const cacheValid = !forceRefresh && cacheAge < OPENCODE_MODELS_CACHE_MS && cache.models.length > 0;

    if (cacheValid) {
      return {
        models: cache.models,
        loadedAt: new Date(cache.loadedAt).toISOString(),
        lastError: cache.lastError,
        cached: true,
      };
    }

    if (!forceRefresh && cache.inFlight) {
      return cache.inFlight;
    }

    const request = runOpencodeModelsCommand({ cwd })
      .then((models) => {
        cache.models = models;
        cache.loadedAt = Date.now();
        cache.lastError = null;
        return {
          models,
          loadedAt: new Date(cache.loadedAt).toISOString(),
          lastError: null,
          cached: false,
        };
      })
      .catch((error) => {
        cache.lastError = error.message;
        return {
          models: cache.models || [],
          loadedAt: cache.loadedAt ? new Date(cache.loadedAt).toISOString() : null,
          lastError: error.message,
          cached: false,
        };
      })
      .finally(() => {
        cache.inFlight = null;
      });

    cache.inFlight = request;
    return request;
  }

  // Cache-only read for the render path: never spawns `opencode models`.
  // Callers that need fresh data must go through getModels from the world tick.
  function peekModels() {
    return {
      models: cache.models || [],
      loadedAt: cache.loadedAt ? new Date(cache.loadedAt).toISOString() : null,
      lastError: cache.lastError,
      cached: true,
    };
  }

  return {
    getModels,
    peekModels,
  };
}

module.exports = {
  createOpencodeModelsService,
  parseOpencodeModelsOutput,
  stripAnsi,
};
