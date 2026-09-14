'use strict';

const assert = require('assert');
const { displayRole, roleClass } = require('../../app/src/components/bot-cartridge/utils.ts');

assert.equal(displayRole('SS'), 'SS');
assert.equal(roleClass('Senior Pro'), 'senior-pro');
assert.equal(displayRole(undefined), 'Agent');
assert.equal(roleClass(undefined), 'agent');
assert.equal(displayRole('   '), 'Agent');
assert.equal(roleClass('   '), 'agent');

console.log('Cartridge label: missing roles render with a stable fallback.');
