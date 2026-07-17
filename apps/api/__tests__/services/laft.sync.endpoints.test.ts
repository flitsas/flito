import { describe, it, expect } from 'vitest';
import { _internal as unInternal } from '../../src/modules/laft/sync/un.sync.js';
import { _internal as euInternal } from '../../src/modules/laft/sync/eu.sync.js';
import { _internal as retroInternal } from '../../src/modules/laft/sync/retro-match.service.js';

describe('LAFT sync — UN allowlist incluye Azure blob', () => {
  it('acepta scsanctions.un.org y *.un.org', () => {
    expect(unInternal.isAllowedUnHost('scsanctions.un.org')).toBe(true);
    expect(unInternal.isAllowedUnHost('main.un.org')).toBe(true);
  });

  it('acepta el redirect a Azure blob *.blob.core.windows.net', () => {
    expect(unInternal.isAllowedUnHost('unsolprodfiles.blob.core.windows.net')).toBe(true);
    expect(unInternal.isAllowedUnHost('cualquiera.blob.core.windows.net')).toBe(true);
  });

  it('rechaza hosts arbitrarios', () => {
    expect(unInternal.isAllowedUnHost('evil.com')).toBe(false);
    expect(unInternal.isAllowedUnHost('un.org.attacker.com')).toBe(false);
    expect(unInternal.isAllowedUnHost('blob.core.windows.net.evil.com')).toBe(false);
  });

  it('User-Agent declara identidad Mozilla-compatible', () => {
    expect(unInternal.UN_BROWSER_UA).toMatch(/^Mozilla\/5\.0/);
    expect(unInternal.UN_BROWSER_UA).toContain('Kyverum');
  });
});

describe('LAFT sync — EU usa token público y UA Mozilla', () => {
  it('URL incluye query token=dG9rZW4tMjAxNw (token público oficial)', () => {
    expect(euInternal.EU_CONSOLIDATED_URL).toContain('token=dG9rZW4tMjAxNw');
    expect(euInternal.EU_PUBLIC_TOKEN).toBe('dG9rZW4tMjAxNw');
  });

  it('token decodificado base64 es "token-2017"', () => {
    const decoded = Buffer.from(euInternal.EU_PUBLIC_TOKEN, 'base64').toString('utf8');
    expect(decoded).toBe('token-2017');
  });

  it('allowlist acepta webgate.ec.europa.eu y *.europa.eu', () => {
    expect(euInternal.isAllowedEuHost('webgate.ec.europa.eu')).toBe(true);
    expect(euInternal.isAllowedEuHost('data.europa.eu')).toBe(true);
  });

  it('rechaza hosts arbitrarios', () => {
    expect(euInternal.isAllowedEuHost('evil.com')).toBe(false);
    expect(euInternal.isAllowedEuHost('europa.eu.attacker.com')).toBe(false);
  });

  it('User-Agent declara identidad Mozilla-compatible', () => {
    expect(euInternal.EU_BROWSER_UA).toMatch(/^Mozilla\/5\.0/);
    expect(euInternal.EU_BROWSER_UA).toContain('Kyverum');
  });
});

describe('LAFT retro-match — toPgArrayLiteral evita "cannot cast record to text[]"', () => {
  it('formatea array vacío como {}', () => {
    expect(retroInternal.toPgArrayLiteral([])).toBe('{}');
  });

  it('formatea strings simples como {"a","b","c"}', () => {
    expect(retroInternal.toPgArrayLiteral(['a', 'b', 'c'])).toBe('{"a","b","c"}');
  });

  it('escapa comillas dobles', () => {
    expect(retroInternal.toPgArrayLiteral(['va"l'])).toBe('{"va\\"l"}');
  });

  it('escapa backslashes', () => {
    expect(retroInternal.toPgArrayLiteral(['va\\l'])).toBe('{"va\\\\l"}');
  });

  it('soporta UN/EU sourceIds reales (alfanuméricos con guiones)', () => {
    expect(retroInternal.toPgArrayLiteral(['IND-1', 'ENT-456', 'EU-2024.789']))
      .toBe('{"IND-1","ENT-456","EU-2024.789"}');
  });

  it('batch size 1000 está bajo el límite Postgres de 1664', () => {
    expect(retroInternal.RETRO_MATCH_BATCH).toBeLessThan(1664);
    expect(retroInternal.RETRO_MATCH_BATCH).toBeGreaterThanOrEqual(500);
  });
});
