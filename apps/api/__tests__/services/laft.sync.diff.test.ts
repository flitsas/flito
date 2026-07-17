import { describe, it, expect } from 'vitest';
import { _computeDiff, _internal as diffInternal } from '../../src/modules/laft/sync/diff.service.js';
import type { NormalizedEntry } from '../../src/modules/laft/sync/types.js';

const baseEntry = (overrides: Partial<NormalizedEntry>): NormalizedEntry => ({
  sourceId: 'X',
  fullName: 'Foo Bar',
  aliases: null,
  docType: null,
  docNumber: null,
  country: null,
  birthDate: null,
  remarks: null,
  ...overrides,
});

describe('laft/sync/diff — _computeDiff (pura, sin BD)', () => {
  it('detecta added cuando llega un sourceId no existente', () => {
    const existing = [{ sourceId: 'A', sourceHash: 'h1' }];
    const entries = [
      baseEntry({ sourceId: 'A', fullName: 'Vladimir Aleman' }),
      baseEntry({ sourceId: 'B', fullName: 'Carlos Rincon' }),
    ];
    // Forzar el hash de A a coincidir con 'h1' (no es la conducta real, pero el helper
    // _computeDiff compara hash con entryHash(e); si entryHash difiere se marca modified.
    // Aquí lo más simple: el hash 'h1' de A no coincidirá con entryHash(A) → modified.
    const r = _computeDiff({ existing, entries });
    expect(r.added).toEqual(['B']);
    expect(r.modified).toEqual(['A']);
    expect(r.removed).toEqual([]);
  });

  it('detecta removed cuando el sourceId existente no llega', () => {
    const existing = [
      { sourceId: 'A', sourceHash: diffInternal.entryHash(baseEntry({ sourceId: 'A', fullName: 'X' })) },
      { sourceId: 'B', sourceHash: 'old' },
    ];
    const entries = [baseEntry({ sourceId: 'A', fullName: 'X' })];
    const r = _computeDiff({ existing, entries });
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual(['B']);
    expect(r.modified).toEqual([]);
  });

  it('detecta modified cuando el sourceHash cambia', () => {
    const oldHash = diffInternal.entryHash(baseEntry({ sourceId: 'A', fullName: 'X' }));
    const existing = [{ sourceId: 'A', sourceHash: oldHash }];
    const entries = [baseEntry({ sourceId: 'A', fullName: 'Y nuevo nombre' })]; // hash distinto
    const r = _computeDiff({ existing, entries });
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(r.modified).toEqual(['A']);
  });

  it('no marca modified si hash idéntico', () => {
    const e = baseEntry({ sourceId: 'A', fullName: 'X', docNumber: '123' });
    const existing = [{ sourceId: 'A', sourceHash: diffInternal.entryHash(e) }];
    const r = _computeDiff({ existing, entries: [e] });
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(r.modified).toEqual([]);
  });

  it('lista vacía contra existing pobla todos como removed', () => {
    const existing = [
      { sourceId: 'A', sourceHash: 'h1' },
      { sourceId: 'B', sourceHash: 'h2' },
      { sourceId: 'C', sourceHash: 'h3' },
    ];
    const r = _computeDiff({ existing, entries: [] });
    expect(r.added).toEqual([]);
    expect(r.modified).toEqual([]);
    expect(r.removed.sort()).toEqual(['A', 'B', 'C']);
  });

  it('existing vacío contra lista nueva pobla todos como added', () => {
    const entries = [
      baseEntry({ sourceId: 'A' }),
      baseEntry({ sourceId: 'B' }),
    ];
    const r = _computeDiff({ existing: [], entries });
    expect(r.added.sort()).toEqual(['A', 'B']);
    expect(r.removed).toEqual([]);
    expect(r.modified).toEqual([]);
  });

  it('ignora existing rows con sourceId null', () => {
    const existing = [
      { sourceId: null, sourceHash: 'orphan' },
      { sourceId: 'A', sourceHash: 'h1' },
    ];
    const entries = [baseEntry({ sourceId: 'A', fullName: 'X' })];
    const r = _computeDiff({ existing, entries });
    // Solo A se considera; 'A' tiene hash que no coincide con entryHash(entries[0]) → modified
    expect(r.removed).toEqual([]);
    expect(r.modified).toEqual(['A']);
  });
});

describe('laft/sync/diff — entryHash determinismo', () => {
  it('mismo input → mismo hash', () => {
    const e = baseEntry({ sourceId: 'X', fullName: 'Foo', docNumber: '123', aliases: ['Foo Bar', 'F.B.'] });
    expect(diffInternal.entryHash(e)).toEqual(diffInternal.entryHash(e));
  });

  it('cambiar nombre cambia hash', () => {
    const a = baseEntry({ sourceId: 'X', fullName: 'Foo' });
    const b = baseEntry({ sourceId: 'X', fullName: 'Bar' });
    expect(diffInternal.entryHash(a)).not.toEqual(diffInternal.entryHash(b));
  });

  it('hash es <= 64 chars', () => {
    const h = diffInternal.entryHash(baseEntry({ sourceId: 'X', fullName: 'Foo' }));
    expect(h.length).toBeLessThanOrEqual(64);
  });
});
