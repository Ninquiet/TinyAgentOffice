'use strict';

const assert = require('assert');
const {
  alignConnectedCartridgePlacements,
  materializeCartridgePlacement,
} = require('../../app/src/cartridges/placement.ts');

{
  const result = materializeCartridgePlacement({
    id: 'cart-1',
    templateId: 'blueprint-1',
    role: undefined,
    name: undefined,
    model: undefined,
    definition: {
      name: 'Iron Runner',
      role: 'SS',
      model: 'opencode-go/gpt-5.6-luna',
    },
    x: 120,
    y: 80,
    slotId: null,
  });

  assert.equal(result.name, 'Iron Runner');
  assert.equal(result.role, 'SS');
  assert.equal(result.model, 'opencode-go/gpt-5.6-luna');
  assert.equal(result.x, 120);
  assert.equal(result.y, 80);
  console.log('Cartridge placement: resolved definition survives undefined transport fields.');
}

{
  const result = materializeCartridgePlacement(
    {
      id: 'cart-2',
      role: undefined,
      definition: null,
      x: 300,
      y: 180,
    },
    {
      id: 'cart-2',
      name: 'Local Cartridge',
      role: 'Jr',
      model: 'opencode-go/gpt-5.6-luna',
      definition: null,
      x: 0,
      y: 0,
    },
  );

  assert.equal(result.name, 'Local Cartridge');
  assert.equal(result.role, 'Jr');
  assert.equal(result.model, 'opencode-go/gpt-5.6-luna');
  assert.equal(result.x, 300);
  assert.equal(result.y, 180);
  console.log('Cartridge placement: undefined incoming fields do not erase local identity.');
}

{
  const staleConnected = {
    id: 'cart-restored',
    role: 'SS',
    x: 610,
    y: 48,
    slotId: 'slot-2',
  };
  const loose = {
    id: 'cart-loose',
    role: 'Jr',
    x: 420,
    y: 260,
    slotId: null,
  };
  const result = alignConnectedCartridgePlacements(
    [staleConnected, loose],
    (_cartridge, slotId) => (slotId === 'slot-2' ? { x: 520, y: 48 } : null),
  );

  assert.deepEqual(
    result[0],
    { ...staleConnected, x: 520, y: 48 },
    'a restored connection must be recomputed from its live socket instead of keeping stale coordinates',
  );
  assert.strictEqual(result[1], loose, 'loose cartridges must not be moved during restored-slot alignment');
  assert.strictEqual(
    alignConnectedCartridgePlacements(result, () => ({ x: 520, y: 48 })),
    result,
    'an already aligned collection must retain its identity and avoid a render loop',
  );
  console.log('Cartridge placement: restored connections realign while loose cartridges remain untouched.');
}
