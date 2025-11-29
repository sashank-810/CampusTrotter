import { describe, test, expect } from '@jest/globals';

describe('Backend CI smoke test', () => {
  test('basic arithmetic works', () => {
    const result = 1 + 1;
    expect(result).toBe(2);
  });
});
