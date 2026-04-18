import { describe, expect, it } from 'vitest';

import { shouldValidateEnv } from '../../vite.config.js';

describe('vite env validation guard', () => {
  it('validates for dev serve', () => {
    expect(shouldValidateEnv({ command: 'serve', isPreview: false })).toBe(true);
    expect(shouldValidateEnv({ command: 'serve', isPreview: undefined })).toBe(true);
  });

  it('skips validation for preview serve', () => {
    expect(shouldValidateEnv({ command: 'serve', isPreview: true })).toBe(false);
  });

  it('validates for build', () => {
    expect(shouldValidateEnv({ command: 'build', isPreview: false })).toBe(true);
    expect(shouldValidateEnv({ command: 'build', isPreview: true })).toBe(true);
  });
});
