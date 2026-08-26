import { describe, expect, it } from 'vitest';
import { parseCreateosSize } from '../src/backend.js';

describe('parseCreateosSize', () => {
  it('uses the default CreateOS shape when unset', () => {
    expect(parseCreateosSize(undefined)).toEqual({
      shape: 's-2vcpu-2gb',
      resources: { cpu: 2, memory: 2, disk: 20 },
    });
  });

  it('passes native shape slugs through unchanged', () => {
    expect(parseCreateosSize('s-4vcpu-8gb')).toEqual({ shape: 's-4vcpu-8gb' });
  });

  it('maps compact cpu-memory-disk specs to shape plus resource metadata', () => {
    expect(parseCreateosSize('4-8-40')).toEqual({
      shape: 's-4vcpu-8gb',
      resources: { cpu: 4, memory: 8, disk: 40 },
    });
  });

  it('defaults the disk slot for compact cpu-memory specs', () => {
    expect(parseCreateosSize('2-4')).toEqual({
      shape: 's-2vcpu-4gb',
      resources: { cpu: 2, memory: 4, disk: 20 },
    });
  });
});

