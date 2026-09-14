'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', '..', 'app', 'src');
const app = fs.readFileSync(path.join(APP, 'App.tsx'), 'utf8');
const cartridge = fs.readFileSync(path.join(APP, 'components', 'bot-cartridge', 'BotCartridge.tsx'), 'utf8');
const options = fs.readFileSync(path.join(APP, 'components', 'bot-cartridge', 'parts', 'CartridgeOptions.tsx'), 'utf8');
const types = fs.readFileSync(path.join(APP, 'components', 'bot-cartridge', 'types.ts'), 'utf8');
const tray = fs.readFileSync(path.join(APP, 'components', 'BlueprintTray.tsx'), 'utf8');

function assertLinkedEditCannotBypassConfirmation() {
  assert.ok(app.includes('BreakTheLinkPrompt'), 'App does not mount the built linked-instance edit prompt');
  assert.ok(types.includes('onEditRequest?'), 'a cartridge has no way to hand an edit request to App');
  assert.ok(cartridge.includes('onEditRequest'), 'BotCartridge does not route Edit through the linked-instance decision');
  assert.ok(options.includes('onEditRequest'), 'the visible Edit button still opens its form directly');
  assert.ok(
    /await\s+unlinkCartridgeById\([^)]*\)[\s\S]*setCartridgeEditRequests/.test(app),
    'the confirmation must await the existing unlink transition before opening the edit form',
  );

  console.log('Blueprint UI: linked cartridge Edit waits for confirmation and successful unlinking.');
}

function assertTrayBlueprintPromptsReachTheApi() {
  for (const prompt of ['BlueprintEditPrompt', 'RunningInstancesPrompt', 'DeleteBlueprintPrompt']) {
    assert.ok(app.includes(prompt), `App does not mount ${prompt}`);
  }
  for (const apiCall of ['findBlueprintInstances', 'applyBlueprintEdit', 'deleteBlueprint']) {
    assert.ok(app.includes(apiCall), `App never calls the built ${apiCall} API`);
  }
  assert.ok(tray.includes('onEditBlueprint'), 'tray blueprints expose no Edit trigger');
  assert.ok(tray.includes('onDeleteBlueprint'), 'tray blueprints expose no Delete trigger');
  assert.ok(
    /findBlueprintInstances\([^)]*\)[\s\S]*running[\s\S]*applyBlueprintEdit/.test(app),
    'editing must inspect instances, branch on running agents, and apply only after that decision',
  );
  assert.ok(
    /await\s+deleteBlueprint[^;]+;[\s\S]*setBlueprintDelete/.test(app),
    'delete success must not be shown or dismissed before the server operation resolves',
  );

  console.log('Blueprint UI: tray Edit/Delete controls reach the existing prompts and API routes.');
}

assertLinkedEditCannotBypassConfirmation();
assertTrayBlueprintPromptsReachTheApi();
console.log('Blueprint UI wiring validation passed.');
