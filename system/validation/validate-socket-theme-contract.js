'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'app', 'src');
const CONTRACT = path.join(APP, 'themes', 'socketCompositionTypes.ts');
const REGISTRY = path.join(APP, 'themes', 'socketCompositions.ts');
const CYBERPUNK = path.join(APP, 'themes', 'cyberpunk', 'socketComposition.ts');
const DEFAULT = path.join(APP, 'themes', 'default', 'socketComposition.ts');
const SPEC = path.join(ROOT, 'TEMP', 'socket-theme-contract.md');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function assertExists(file) {
  assert.ok(fs.existsSync(file), `${path.relative(ROOT, file)} is missing`);
}

function main() {
  for (const file of [CONTRACT, REGISTRY, CYBERPUNK, DEFAULT, SPEC]) assertExists(file);

  const contract = read(CONTRACT);
  for (const typeName of [
    'ThemeSocketComposition',
    'ThemeSocketFormFactorComposition',
    'ThemeSocketStateComposition',
    'socketCompositionToStyle',
  ]) {
    assert.ok(contract.includes(typeName), `socket contract must declare ${typeName}`);
  }

  for (const field of [
    'regular',
    'projectManager',
    'seniorPro',
    'empty',
    'connected',
    'active',
    'attention',
    'focus',
  ]) {
    assert.ok(contract.includes(`${field}?`), `socket contract must expose optional ${field}`);
  }

  for (const variable of [
    'width',
    'height',
    'clipPath',
    'outlinePath',
    'background',
    'borderColor',
    'gateColor',
    'jawColor',
    'railColor',
    'portBackground',
    'controlInset',
  ]) {
    assert.ok(contract.includes(`${variable}?`), `socket contract must expose ${variable}`);
  }

  const registry = read(REGISTRY);
  assert.ok(registry.includes('defaultSocketComposition'), 'default installed theme must declare a socket composition');
  assert.ok(registry.includes('cyberpunkSocketComposition'), 'socket registry must include cyberpunk composition');

  const defaultComposition = read(DEFAULT);
  assert.ok(defaultComposition.includes("variantId: 'default-classic'"), 'default theme must name its socket variant');

  const cyberpunk = read(CYBERPUNK);
  assert.ok(cyberpunk.includes("variantId: 'luminous-jaw'"), 'cyberpunk socket composition must record the selected Luminous Jaw variant');
  assert.ok(cyberpunk.includes("width: '244px'"), 'Luminous Jaw regular socket must keep prototype width');
  assert.ok(cyberpunk.includes("height: '84px'"), 'Luminous Jaw regular socket must keep prototype height');
  assert.ok(cyberpunk.includes("width: '300px'"), 'Luminous Jaw Project Manager socket must keep prototype width');
  assert.ok(cyberpunk.includes("height: '110px'"), 'Luminous Jaw Project Manager socket must keep prototype height');
  assert.ok(cyberpunk.includes("width: '88px'"), 'Luminous Jaw Senior Pro socket must keep prototype width');
  assert.ok(cyberpunk.includes("height: '248px'"), 'Luminous Jaw Senior Pro socket must keep prototype height');
  for (const form of ['regular', 'projectManager', 'seniorPro']) {
    assert.ok(cyberpunk.includes(`${form}:`), `cyberpunk composition must define ${form}`);
  }
  assert.ok(!cyberpunk.includes('ERASEME'), 'production socket composition must not depend on disposable prototypes');

  const spec = read(SPEC);
  for (const phrase of [
    'Variant 10 - Luminous Jaw',
    'Who writes',
    'Who reads',
    'TASK-004.3',
    'theme.css',
    'AgentSlots.tsx',
    'ProjectManagerSlot.tsx',
    'SeniorProSlot.tsx',
  ]) {
    assert.ok(spec.includes(phrase), `socket contract spec must mention ${phrase}`);
  }

  console.log('Socket theme contract validation passed.');
}

main();
