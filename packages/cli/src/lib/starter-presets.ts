import { resolveCapabilities } from './capability-definitions.js';

/** Shared starter profiles used by CLI scaffolds and the builder. */
export type StarterPreset = 'standalone' | 'connected';

export const STARTER_PRESETS: Record<
  StarterPreset,
  { capabilities: string[]; requiresAuth: boolean }
> = {
  standalone: { capabilities: ['pwa'], requiresAuth: false },
  connected: { capabilities: ['pwa', 'cloud-data'], requiresAuth: true },
};

export function resolveStarterPreset(preset: StarterPreset, additions: string[] = []) {
  return resolveCapabilities([...STARTER_PRESETS[preset].capabilities, ...additions]);
}
