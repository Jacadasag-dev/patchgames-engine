import { describe, expect, it, vi } from 'vitest';
import { ObjectPool } from '../../src/sandbox/objectPool.ts';

describe('bounded engine object reuse', () => {
  it('reuses reset objects across effect lifetimes and rejects foreign or repeated releases', () => {
    const create = vi.fn(() => ({ position: { x: 0 }, visible: false }));
    const reset = vi.fn((item: ReturnType<typeof create>) => { item.position.x = 0; item.visible = false; });
    const pool = new ObjectPool({ create, reset });
    const first = pool.acquire(), position = first.position;
    first.position.x = 42; first.visible = true;
    pool.release(first);
    const next = pool.acquire();
    expect(next).toBe(first); expect(next.position).toBe(position);
    expect(next).toEqual({ position: { x: 0 }, visible: false });
    expect(create).toHaveBeenCalledTimes(1);
    expect(pool.activeCount).toBe(1); expect(pool.retainedCount).toBe(0);
    expect(() => pool.release({ position: { x: 0 }, visible: false })).toThrow('not checked out');
    pool.release(next);
    expect(() => pool.release(next)).toThrow('not checked out');
  });

  it('bounds retained storage, disposes excess and cleans active objects only on terminal disposal', () => {
    const dispose = vi.fn(), pool = new ObjectPool({ create: () => ({}), reset: () => {}, dispose, maxRetained: 2 });
    const crowd = Array.from({ length: 32 }, () => pool.acquire());
    for (const item of crowd) pool.release(item);
    expect(pool.retainedCount).toBe(2); expect(pool.activeCount).toBe(0);
    expect(dispose).toHaveBeenCalledTimes(30);
    const active = pool.acquire(); pool.clear();
    expect(dispose).toHaveBeenCalledTimes(31); expect(pool.activeCount).toBe(1);
    expect(dispose.mock.calls.some(([item]) => item === active)).toBe(false);
    pool.dispose(); pool.dispose();
    expect(dispose).toHaveBeenCalledTimes(32);
    expect(pool.activeCount).toBe(0); expect(pool.retainedCount).toBe(0);
    expect(() => pool.acquire()).toThrow('after disposal');
  });

  it('discards an object when reset fails and validates retention limits', () => {
    const dispose = vi.fn(), pool = new ObjectPool({ create: () => ({}), reset() { throw new Error('reset failed'); }, dispose });
    expect(() => pool.release(pool.acquire())).toThrow('reset failed');
    expect(pool.activeCount).toBe(0); expect(pool.retainedCount).toBe(0);
    expect(dispose).toHaveBeenCalledTimes(1);
    for (const maxRetained of [-1, .5, Infinity, 65537])
      expect(() => new ObjectPool({ create: () => ({}), reset: () => {}, maxRetained })).toThrow('integer');
  });

  it('clears every retained object after a cleanup failure while preserving active leases', () => {
    let id = 0;
    const error = new Error('first cleanup failed'), cleaned: number[] = [];
    const pool = new ObjectPool({ create: () => ({ id: id++ }), reset: () => {}, dispose(item) {
      cleaned.push(item.id);
      if (item.id === 0) throw error;
      if (item.id === 1) throw new Error('later cleanup failed');
    } });
    const items = Array.from({ length: 4 }, () => pool.acquire());
    for (const item of items.slice(0, 3)) pool.release(item);
    expect(() => pool.clear()).toThrow(error);
    expect(cleaned).toEqual([0, 1, 2]);
    expect(pool.retainedCount).toBe(0); expect(pool.activeCount).toBe(1);
    pool.release(items[3]);
    expect(pool.acquire()).toBe(items[3]);
    pool.dispose();
    expect(cleaned).toEqual([0, 1, 2, 3]);
  });

  it('attempts every idle and active cleanup before rethrowing the first terminal failure', () => {
    let id = 0;
    const error = new Error('idle cleanup failed'), cleaned: number[] = [];
    const pool = new ObjectPool({ create: () => ({ id: id++ }), reset: () => {}, dispose(item) {
      cleaned.push(item.id);
      if (item.id === 0) throw error;
      if (item.id === 2) throw new Error('active cleanup failed');
    } });
    const items = Array.from({ length: 4 }, () => pool.acquire());
    pool.release(items[0]); pool.release(items[1]);
    expect(() => pool.dispose()).toThrow(error);
    expect(cleaned).toEqual([0, 1, 2, 3]);
    expect(pool.activeCount).toBe(0); expect(pool.retainedCount).toBe(0);
    pool.dispose();
    expect(cleaned).toEqual([0, 1, 2, 3]);
    expect(() => pool.acquire()).toThrow('after disposal');
  });

  it('preserves the original reset failure even if disposal also fails', () => {
    const error = new Error('reset failed'), dispose = vi.fn(() => { throw new Error('cleanup failed'); });
    const pool = new ObjectPool({ create: () => ({}), reset() { throw error; }, dispose });
    const item = pool.acquire();
    expect(() => pool.release(item)).toThrow(error);
    expect(dispose).toHaveBeenCalledOnce();
    expect(pool.activeCount).toBe(0); expect(pool.retainedCount).toBe(0);
    expect(() => pool.release(item)).toThrow('not checked out');
  });
});
