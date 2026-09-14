// What a drag into or out of the tray produces.
//
// The prefab model: a blueprint lives in the tray and never leaves it, an
// instance lives in a project and references the blueprint by id, and the
// definition belongs to the blueprint for as long as the link holds.
//
// Everything that decides anything is here and pure, so the component is left
// with the gesture and the rendering. That split is what let the merge and the
// commit plan be tested at all, and this is the same shape.

import type { Blueprint, BlueprintDefinition, CartridgePlacementView } from '../types';

export interface DraggedCartridge {
  id: string;
  templateId?: string | null;
  definition?: BlueprintDefinition | null;
  live?: boolean;
  name?: string;
  role?: string;
  model?: string;
  adapter?: string | null;
  cli?: string | null;
  startupInstructions?: string | null;
}

// --- the ghost --------------------------------------------------------------

// The blueprint never leaves the tray, so there is nothing to record: the ghost
// is the affordance that says the tray slot is still occupied while a copy is
// being pulled out of it. Derived at render time, never stored.
//
// Storing it is the bug waiting to happen. A stored ghost can disagree with the
// blueprint list -- and the first symptom is a ghost with no blueprint behind it,
// which is a rendering problem with no data to explain it.
export interface TrayGhost {
  blueprintId: string;
  /** The tray slot the ghost occupies, so the column does not close up. */
  trayIndex: number;
}

export function ghostFor(
  blueprints: Blueprint[],
  draggingBlueprintId: string | null | undefined,
): TrayGhost | null {
  if (!draggingBlueprintId) return null;
  const blueprint = blueprints.find((entry) => entry.id === draggingBlueprintId);
  // A ghost for a blueprint that is not there is exactly what persisting this
  // would eventually produce, so it is refused rather than drawn.
  if (!blueprint) return null;
  return { blueprintId: blueprint.id, trayIndex: blueprint.trayIndex };
}

export function ghostsFor(input: {
  blueprints: Blueprint[];
  draggingBlueprintId?: string | null;
  draggingGesture?: 'instance' | 'reorder';
  usedBlueprintIds?: ReadonlySet<string>;
}): TrayGhost[] {
  const {
    blueprints,
    draggingBlueprintId = null,
    usedBlueprintIds,
  } = input;

  return blueprints
    .filter((blueprint) => {
      if (blueprint.id === draggingBlueprintId) {
        return true;
      }
      return Boolean(usedBlueprintIds?.has(blueprint.id));
    })
    .map((blueprint) => ({ blueprintId: blueprint.id, trayIndex: blueprint.trayIndex }));
}

// --- dragging a blueprint out: instancing -----------------------------------

export type InstanceRefusal = 'already-instanced' | 'unknown-blueprint';

export interface InstanceResult {
  created: boolean;
  reason?: InstanceRefusal;
  /** The instance that already holds the blueprint, when refusing. */
  existingId?: string;
  cartridge?: {
    id: string;
    templateId: string;
    /** Null: the definition belongs to the blueprint while the link holds. */
    definition: null;
    x: number;
    y: number;
    slotId: null;
    activated: false;
    sessionId: null;
  };
}

// One instance per blueprint per project (user decision Q2). Across projects is
// the entire point of the feature; within one project it is refused with a hint
// rather than silently creating a second or replacing the first.
//
// The database enforces this too, with a partial unique index. This exists to
// give the refusal a name before a request is made, not to be the rule.
export function instanceFromBlueprint(input: {
  blueprint: Blueprint | undefined;
  cartridges: CartridgePlacementView[];
  at: { x: number; y: number };
  newId: () => string;
}): InstanceResult {
  const { blueprint, cartridges, at, newId } = input;
  if (!blueprint) return { created: false, reason: 'unknown-blueprint' };

  const existing = cartridges.find((entry) => entry.templateId === blueprint.id);
  if (existing) {
    return { created: false, reason: 'already-instanced', existingId: existing.id };
  }

  return {
    created: true,
    cartridge: {
      id: newId(),
      templateId: blueprint.id,
      definition: null,
      x: at.x,
      y: at.y,
      slotId: null,
      activated: false,
      sessionId: null,
    },
  };
}

// --- dragging a cartridge in: saving as a blueprint -------------------------

export type BlueprintRefusal = 'already-a-blueprint' | 'nothing-to-save' | 'running';

export interface SaveAsBlueprintResult {
  saved: boolean;
  reason?: BlueprintRefusal;
  existingId?: string;
  blueprint?: { definition: BlueprintDefinition; trayIndex: number };
}

function definitionOf(cartridge: DraggedCartridge): BlueprintDefinition | null {
  if (cartridge.definition) return cartridge.definition;
  if (!cartridge.name || !cartridge.role) return null;
  return {
    name: cartridge.name,
    role: cartridge.role,
    model: cartridge.model || '',
    adapter: cartridge.adapter || null,
    cli: cartridge.cli || null,
    startupInstructions: cartridge.startupInstructions || null,
  };
}

// Dropping a cartridge into the tray makes a blueprint of it, and the caller
// then consumes the source placement after the blueprint exists.
//
// A cartridge that already follows a blueprint is refused. The path to a variant
// is explicit: duplicate, edit the copy, drag it in. Nothing changes parent
// implicitly.
export function saveAsBlueprint(input: {
  cartridge: DraggedCartridge;
  trayIndex: number;
}): SaveAsBlueprintResult {
  const { cartridge, trayIndex } = input;

  if (cartridge.live) {
    return { saved: false, reason: 'running' };
  }

  if (cartridge.templateId) {
    return { saved: false, reason: 'already-a-blueprint', existingId: cartridge.templateId };
  }

  const definition = definitionOf(cartridge);
  if (!definition) return { saved: false, reason: 'nothing-to-save' };

  return { saved: true, blueprint: { definition, trayIndex } };
}

// --- duplicate: the way to get a variant (user decision Q6) -----------------

// A duplicate is a clean, unlinked copy with the definition resolved at this
// moment. It is what replaced re-parenting: the path to "I want a variant of this
// blueprint" is duplicate, edit the copy, drag it in. Three explicit steps, and
// nothing changes parent implicitly -- a cartridge can never start following a
// blueprint the user did not choose.

// The name is not cosmetic, and this is the part that would look optional.
//
// Agent names appear in task claims (`task.claim.agentName`). Two cartridges
// called "Neon Hammer" in one project make a claim ambiguous -- which is exactly
// what Q2 avoided by forbidding duplicate instances. Being unlinked does not
// help: the LINKED tag separates them on screen, not in the claim.
//
// So a duplicate gets a distinct name automatically, with no prompt. A numeric
// suffix rather than a fresh random name, because "Neon Hammer 2" says what it
// came from and a new random name does not.
export function uniqueCartridgeName(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((name) => String(name).trim().toLowerCase()));
  const trimmed = String(base || '').trim() || 'Cartridge';

  // "Neon Hammer 2" duplicated again should be "Neon Hammer 3", not
  // "Neon Hammer 2 2".
  const match = /^(.*?)\s+(\d+)$/.exec(trimmed);
  const stem = match ? match[1] : trimmed;
  const start = match ? Number(match[2]) + 1 : 2;

  for (let suffix = start; suffix < start + 1000; suffix += 1) {
    const candidate = `${stem} ${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  // Unreachable in practice; a name is still better than a collision.
  return `${stem} ${Date.now()}`;
}

export interface DuplicateResult {
  created: boolean;
  reason?: 'nothing-to-duplicate';
  cartridge?: {
    id: string;
    templateId: null;
    definition: BlueprintDefinition;
    x: number;
    y: number;
    slotId: null;
    activated: false;
    sessionId: null;
  };
}

export function duplicateCartridge(input: {
  cartridge: CartridgePlacementView;
  /** Resolved definitions of everything in the project, for the name check. */
  takenNames: Iterable<string>;
  at: { x: number; y: number };
  newId: () => string;
}): DuplicateResult {
  const { cartridge, takenNames, at, newId } = input;

  // The definition is resolved at this moment: a duplicate of an instance takes
  // what the blueprint says right now and then stops following it. The view
  // already resolved it, which is why this takes the view model.
  const source = cartridge.definition;
  if (!source || !source.name) return { created: false, reason: 'nothing-to-duplicate' };

  return {
    created: true,
    cartridge: {
      id: newId(),
      // Clean and unlinked, always. This copy is what can then be dropped into
      // the tray to become a blueprint.
      templateId: null,
      definition: { ...source, name: uniqueCartridgeName(source.name, takenNames) },
      x: at.x,
      y: at.y,
      slotId: null,
      activated: false,
      sessionId: null,
    },
  };
}

// --- unlink: one operation, three triggers ----------------------------------

// Editing an instance, choosing "unlink them" when a blueprint changes, and
// deleting a blueprint all converge here (Q1, Q4, and the consolidation the
// user's answers produced). Three implementations of one transition is how they
// drift apart, so there is one.
//
// The instance copies the definition in, drops the reference, and loses the
// LINKED tag -- the tag being absent is the entire visual for an unlinked
// cartridge (Q3), so nothing extra has to be drawn.
export function unlink(
  cartridge: CartridgePlacementView,
  blueprints: Blueprint[],
): CartridgePlacementView {
  if (!cartridge.templateId) return cartridge;

  const blueprint = blueprints.find((entry) => entry.id === cartridge.templateId);
  // The definition has to come from somewhere. If the blueprint is already gone,
  // whatever snapshot the instance has is all there is -- better an unlinked
  // cartridge with a stale definition than one with none.
  const definition = blueprint ? blueprint.definition : cartridge.definition;

  return {
    ...cartridge,
    templateId: null,
    linked: false,
    definition,
  };
}
