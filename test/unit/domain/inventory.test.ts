import { describe, expect, it } from 'vitest';

import { consumeItems, countInventorySlots, grantItems, hasRequiredItems } from '../../../src/domain/inventory.js';

describe('inventory domain', () => {
  const items = [
    { item_id: 'bread', name: 'パン', description: '焼きたて', stackable: true, max_stack: 2 },
    { item_id: 'book', name: '本', description: '古書', stackable: false },
  ];

  it('checks and consumes required items', () => {
    expect(hasRequiredItems([{ item_id: 'bread', quantity: 2 }], [{ item_id: 'bread', quantity: 1 }])).toBe(true);
    expect(consumeItems([{ item_id: 'bread', quantity: 2 }], [{ item_id: 'bread', quantity: 1 }])).toEqual([
      { item_id: 'bread', quantity: 1 },
    ]);
  });

  it('counts inventory slots with stack rules', () => {
    expect(countInventorySlots([
      { item_id: 'bread', quantity: 3 },
      { item_id: 'book', quantity: 2 },
    ], items)).toBe(3);
  });

  it('grants items and drops overflow when inventory is full', () => {
    const result = grantItems(
      [{ item_id: 'book', quantity: 1 }],
      [{ item_id: 'bread', quantity: 2 }, { item_id: 'book', quantity: 1 }],
      items,
      2,
    );

    expect(result.granted).toEqual([{ item_id: 'bread', quantity: 2 }]);
    expect(result.dropped).toEqual([{ item_id: 'book', quantity: 1 }]);
  });

  it('drops overflow when a stackable item exceeds max_stack', () => {
    const result = grantItems(
      [{ item_id: 'bread', quantity: 2 }],
      [{ item_id: 'bread', quantity: 1 }],
      items,
    );

    expect(result.granted).toEqual([]);
    expect(result.dropped).toEqual([{ item_id: 'bread', quantity: 1 }]);
    expect(result.items).toEqual([{ item_id: 'bread', quantity: 2 }]);
  });

  it('counts unlimited stackable items as one slot', () => {
    expect(countInventorySlots(
      [{ item_id: 'coin', quantity: 3 }],
      [{ item_id: 'coin', name: 'コイン', description: '通貨', stackable: true }],
    )).toBe(1);
  });
});
