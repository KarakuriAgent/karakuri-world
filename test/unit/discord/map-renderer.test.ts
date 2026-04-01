import { describe, expect, it } from 'vitest';

import { generateMapSvg } from '../../../src/discord/map-renderer.js';
import { createTestMapConfig } from '../../helpers/test-map.js';

describe('generateMapSvg', () => {
  it('renders cells and labels with node-type colors', () => {
    const map = createTestMapConfig();
    map.nodes['3-1'] = { type: 'normal', label: 'Town & Plaza' };

    const svg = generateMapSvg(map);

    expect(svg).toContain('<svg');
    expect(svg).toContain('fill="#f8fafc"');
    expect(svg).toContain('fill="#334155"');
    expect(svg).toContain('fill="#b45309"');
    expect(svg).toContain('fill="#fde68a"');
    expect(svg).toContain('Workshop Interior');
    expect(svg).toContain('Town &amp; Plaza');
  });
});
