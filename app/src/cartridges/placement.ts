function withoutUndefined(value: object | null | undefined): Record<string, unknown> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

export function materializeCartridgePlacement<T extends object>(
  entry: T & { definition?: Partial<T> | null },
  local?: Partial<T> | null,
): T {
  return {
    ...withoutUndefined(local || null),
    ...withoutUndefined(entry),
    ...withoutUndefined(entry.definition || null),
  } as T;
}

export function alignConnectedCartridgePlacements<
  T extends { x: number; y: number; slotId?: string | null },
>(
  cartridges: T[],
  positionForSlot: (cartridge: T, slotId: string) => { x: number; y: number } | null,
): T[] {
  let changed = false;
  const aligned = cartridges.map((cartridge) => {
    if (!cartridge.slotId) return cartridge;
    const position = positionForSlot(cartridge, cartridge.slotId);
    if (!position) return cartridge;
    if (Math.abs(cartridge.x - position.x) < 0.5 && Math.abs(cartridge.y - position.y) < 0.5) {
      return cartridge;
    }
    changed = true;
    return { ...cartridge, ...position };
  });

  return changed ? aligned : cartridges;
}
