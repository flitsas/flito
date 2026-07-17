import { describe, it, expect } from 'vitest';
import {
  extractPartesTraspasoFromTramite,
  mensajePartesTraspasoDuplicadas,
  parteTraspasoRequiereReenvio,
  partesTraspasoDuplicadas,
  resolverValidacionTraspasoParte,
  resolverValidacionVigentePorDocumento,
  validacionesVigentesPorDocumento,
} from '../src/traspaso-partes.js';

describe('traspaso-partes', () => {
  it('detecta mismo email', () => {
    const dup = partesTraspasoDuplicadas(
      { documento: '1000445469', email: 'a@x.co' },
      { documento: '1018232363', email: 'A@X.CO' },
    );
    expect(dup.mismoEmail).toBe(true);
    expect(dup.mismoDocumento).toBe(false);
    expect(mensajePartesTraspasoDuplicadas(dup)).toMatch(/mismo correo/i);
  });

  it('detecta mismo documento normalizado', () => {
    const dup = partesTraspasoDuplicadas(
      { documento: '1.000.445.469', email: 'v@x.co' },
      { documento: '1000445469', email: 'c@x.co' },
    );
    expect(dup.mismoDocumento).toBe(true);
    expect(mensajePartesTraspasoDuplicadas(dup)).toMatch(/mismo número de documento/i);
  });

  it('partes distintas → null', () => {
    const dup = partesTraspasoDuplicadas(
      { documento: '111', email: 'v@x.co' },
      { documento: '222', email: 'c@x.co' },
    );
    expect(mensajePartesTraspasoDuplicadas(dup)).toBeNull();
  });

  it('resolver prioriza aprobado sobre rechazado anterior', () => {
    const rows = [
      { id: 1, parte: 'vendedor', documento: '100', estado: 'rechazado' },
      { id: 2, parte: 'vendedor', documento: '100', estado: 'aprobado', score: 85 },
    ];
    const v = resolverValidacionTraspasoParte(rows, { parte: 'vendedor', documento: '100' });
    expect(v?.estado).toBe('aprobado');
    expect(v?.score).toBe(85);
  });

  it('resolver ignora filas de un documento anterior (comprador corregido al volver atrás)', () => {
    const rows = [
      // comprador equivocado: aprobado pero con documento viejo
      { id: 1, parte: 'comprador', documento: '999', estado: 'aprobado', score: 90 },
      // comprador corregido: aún enviado, documento nuevo
      { id: 2, parte: 'comprador', documento: '100', estado: 'enviado' },
    ];
    const v = resolverValidacionTraspasoParte(rows, { parte: 'comprador', documento: '100' });
    // No debe agarrar la fila vieja (id 1) pese a estar 'aprobado' y matchear el rol.
    expect(v?.id).toBe(2);
    expect(v?.documento).toBe('100');
  });

  it('resolver con documento sin match exacto no devuelve fila stale por rol', () => {
    const rows = [
      { id: 1, parte: 'comprador', documento: '999', estado: 'aprobado' },
    ];
    const v = resolverValidacionTraspasoParte(rows, { parte: 'comprador', documento: '100' });
    expect(v).toBeUndefined();
  });

  it('resolver acepta fila legacy sin documento por rol', () => {
    const rows = [
      { id: 1, parte: 'comprador', documento: null, estado: 'aprobado' },
    ];
    const v = resolverValidacionTraspasoParte(rows, { parte: 'comprador', documento: '100' });
    expect(v?.id).toBe(1);
  });

  it('parteTraspasoRequiereReenvio respeta estados vigentes', () => {
    expect(parteTraspasoRequiereReenvio(undefined)).toBe(true);
    expect(parteTraspasoRequiereReenvio({ id: 1, estado: 'aprobado' })).toBe(false);
    expect(parteTraspasoRequiereReenvio({ id: 1, estado: 'enviado' })).toBe(false);
    expect(parteTraspasoRequiereReenvio({ id: 1, estado: 'en_proceso' })).toBe(false);
    expect(parteTraspasoRequiereReenvio({ id: 1, estado: 'rechazado' })).toBe(true);
    expect(parteTraspasoRequiereReenvio({ id: 1, estado: 'expirado' })).toBe(true);
  });

  it('extractPartesTraspasoFromTramite fusiona comprador columna y vehiculo', () => {
    const { vendedor, comprador } = extractPartesTraspasoFromTramite({
      vehiculo: { _vendedor: { nombre: 'V', documento: '1', email: 'v@x.co' }, _comprador: { email: 'c@x.co' } },
      comprador: { nombre: 'C', documento: '2' },
    });
    expect(vendedor.email).toBe('v@x.co');
    expect(comprador.documento).toBe('2');
    expect(comprador.email).toBe('c@x.co');
  });
});

describe('resolverValidacionVigentePorDocumento', () => {
  // Caso real trámite 31: comprador equivocado rechazado + correcto aprobado + reenvío enviado.
  const rows = [
    { id: 29, documento: '1000445469', estado: 'enviado' },
    { id: 28, documento: '1000445469', estado: 'aprobado' },
    { id: 27, documento: '1193552679', estado: 'rechazado' },
  ];

  it('elige la APROBADA del documento aunque exista un reenvío posterior', () => {
    const v = resolverValidacionVigentePorDocumento(rows, '1000445469');
    expect(v?.id).toBe(28);
    expect(v?.estado).toBe('aprobado');
  });

  it('con documento conocido NO devuelve la validación de otra persona', () => {
    const v = resolverValidacionVigentePorDocumento(rows, '999999');
    expect(v).toBeUndefined();
  });

  it('normaliza el documento (puntos/espacios/guiones)', () => {
    const v = resolverValidacionVigentePorDocumento(rows, '1.000.445.469');
    expect(v?.id).toBe(28);
  });

  it('sin documento: devuelve la de mayor estado (no la más reciente por id)', () => {
    const v = resolverValidacionVigentePorDocumento(rows);
    expect(v?.id).toBe(28); // aprobado gana sobre enviado(29) y rechazado(27)
  });

  it('lista vacía → undefined', () => {
    expect(resolverValidacionVigentePorDocumento([], '1')).toBeUndefined();
    expect(resolverValidacionVigentePorDocumento(null)).toBeUndefined();
  });
});

describe('validacionesVigentesPorDocumento', () => {
  const rows = [
    { id: 29, documento: '1000445469', estado: 'rechazado' }, // reenvío invalidado, sin valor
    { id: 28, documento: '1000445469', estado: 'aprobado' },
    { id: 27, documento: '1193552679', estado: 'rechazado' },
  ];

  it('colapsa por documento a la vigente (1 fila por persona)', () => {
    const out = validacionesVigentesPorDocumento(rows);
    expect(out).toHaveLength(2);
    const comp = out.find((r) => r.documento === '1000445469');
    expect(comp?.id).toBe(28); // aprobado gana sobre el rechazado posterior
  });

  it('soloDocumento limita al titular indicado (matrícula = solo comprador)', () => {
    const out = validacionesVigentesPorDocumento(rows, { documento: '1000445469', soloDocumento: true });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(28);
  });

  it('sin soloDocumento incluye todas las personas', () => {
    const out = validacionesVigentesPorDocumento(rows, { documento: '1000445469' });
    expect(out).toHaveLength(2);
  });
});
