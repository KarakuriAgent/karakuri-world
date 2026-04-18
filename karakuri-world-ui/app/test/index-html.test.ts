import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('index.html', () => {
  it('enables viewport-fit cover so safe-area env vars resolve on iOS', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../../index.html'), 'utf8');

    expect(html).toContain('viewport-fit=cover');
  });
});
