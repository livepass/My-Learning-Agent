import type { RuntimeProfile } from './capabilities.js';
/** The public alpha has one runtime mode. Legacy config and CLI flags must not reopen full. */
export function learningReleaseProfile(config: { profile?: RuntimeProfile }, override?: RuntimeProfile): 'learning' {
  if ((config.profile !== undefined && config.profile !== 'learning') || (override !== undefined && override !== 'learning')) {
    throw new Error('This release supports learning only; remove full from the configuration or startup arguments');
  }
  return 'learning';
}
