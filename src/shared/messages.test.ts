import { describe, expect, it } from 'vitest';
import { isRequest } from './messages.ts';

describe('isRequest (AC-005)', () => {
  it('should accept a message if its type is in the contract', () => {
    expect(isRequest({ type: 'status/get' })).toBe(true);
    expect(isRequest({ type: 'seen/lookup', fingerprints: [] })).toBe(true);
  });

  it('should reject a message if its type is not in the contract', () => {
    expect(isRequest({ type: 'offscreen/decode' })).toBe(false);
    expect(isRequest({ type: 'toString' })).toBe(false);
    expect(isRequest({ type: 42 })).toBe(false);
  });

  it('should reject a message if it is not an object with a type', () => {
    expect(isRequest(null)).toBe(false);
    expect(isRequest('status/get')).toBe(false);
    expect(isRequest({ kind: 'status/get' })).toBe(false);
  });
});
