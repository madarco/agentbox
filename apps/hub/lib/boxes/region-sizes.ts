import type { ProviderOption } from './types';

type Choice = { key: string; label: string };

/**
 * The sizes a create form offers once `location` is chosen: the region's own
 * list when it declares one (hetzner's cx line is EU-only, so ash/hil/sin list
 * cpx types; its first entry is that region's default), else the provider's.
 */
export function sizeChoicesFor(
  provider: Pick<ProviderOption, 'sizes' | 'regions'> | undefined,
  location: string,
): { choices: readonly Choice[]; regionDefault?: string } {
  const region = provider?.regions?.find((r) => r.key === location.trim().toLowerCase());
  if (region?.sizes?.length) return { choices: region.sizes, regionDefault: region.sizes[0]?.key };
  return { choices: provider?.sizes ?? [] };
}

/**
 * The size to keep after the location changed: a picked size the new list does
 * not carry would only fail the create, so it falls back to '' (that location's
 * default). '' and a custom value (`customKey`) are left alone.
 */
export function sizeAfterLocationChange(
  size: string,
  choices: readonly Choice[],
  customKey: string,
): string {
  if (size === '' || size === customKey) return size;
  return choices.some((c) => c.key === size) ? size : '';
}
