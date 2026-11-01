import { expect, it } from 'vitest';
import { learningReleaseProfile } from './release-policy.js';
it('defaults to learning and accepts explicit learning', () => {
  expect(learningReleaseProfile({})).toBe('learning');
  expect(learningReleaseProfile({ profile: 'learning' }, 'learning')).toBe('learning');
});
it('rejects full in both legacy files and startup arguments', () => {
  expect(() => learningReleaseProfile({ profile: 'full' })).toThrow('learning only');
  expect(() => learningReleaseProfile({}, 'full')).toThrow('learning only');
  expect(() => learningReleaseProfile({ profile: 'full' }, 'learning')).toThrow('learning only');
});
