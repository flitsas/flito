/**
 * HU #13626 — formateador y diferencias de la Bitácora del sync (`bitacora-sync.ts`), puro, sin BD.
 * Diseño: `docs/diseno/hu-13626-bitacora-cambios-sync.md`. Datos sintéticos.
 */
import { describe, it, expect } from 'vitest';
import {
  CAMPOS_PII, detalleBitacora, diferenciasCompradores, diferenciasTramite, vistaHistorial, vistaTramite,
  type CompradorComparable, type Diferencia, type FuenteBitacora,
} from '../../src/modules/flito-sync/bitacora-sync.js';

const DOC = '1000013626'; const NOMBRE = 'PERSONA SINTETICA'; const CORREO = 'persona@ejemplo.test';
const CEL = '3000013626'; const DIR = 'CALLE 1 # 2-3'; const PLACA = 'ZZZ626';

const tramite = (over: Record<string, unknown> = {}) => ({
  flitEstado: 'Asignado', facturaVentaFlitId: 'F-1', fechaAprobacion: null, companiaId: 7, organismoCodigo: '25286',
  tipoTramite: 'Otros', ciudad: 'Medellín', plateComplete: PLACA, ...over,
});
const comprador = (over: Partial<CompradorComparable> = {}): CompradorComparable => ({
  orden: 0, numeroDocumento: DOC, nombreCompleto: NOMBRE, correo: CORREO, celular: CEL, direccion: DIR,
  porcentajeParticipacion: 60, ...over,
});
const detalle = (fuente: FuenteBitacora, diferencias: Diferencia[], esNuevo = false) =>
  detalleBitacora({ fuente, radicado: 'R-5512', esNuevo, diferencias });

describe('HU #13626 · clasificación PII', () => {
  it('la placa y los datos de persona del comprador son PII; estado, ciudad, participación y conteo no', () => {
    expect([...CAMPOS_PII].sort()).toEqual(['celular', 'correo', 'direccion', 'nombre_completo', 'numero_documento', 'plate_complete']);
  });
});

describe('HU #13626 · diferencias', () => {
  it('AC2: cada dato de persona del comprador → «cambió <campo> (comprador N)», sin valores, ni en la diferencia ni en el detail', () => {
    const casos: [Partial<CompradorComparable>, string][] = [
      [{ celular: '3999999999' }, 'cambió celular (comprador 1)'],
      [{ numeroDocumento: '1999999999' }, 'cambió documento (comprador 1)'],
      [{ nombreCompleto: 'OTRA PERSONA' }, 'cambió nombre (comprador 1)'],
      [{ correo: 'otro@ejemplo.test' }, 'cambió correo (comprador 1)'],
      [{ direccion: 'CARRERA 9' }, 'cambió dirección (comprador 1)'],
    ];
    for (const [cambio, esperado] of casos) {
      const d = diferenciasCompradores([comprador()], [comprador(cambio)]);
      expect(d).toHaveLength(1);
      expect(d[0]).not.toHaveProperty('antes');
      expect(d[0]).not.toHaveProperty('despues');
      const txt = detalle('FLIT 2', d)!;
      expect(txt).toBe(`[FLIT 2] cambio de datos · radicado R-5512 · ${esperado} · aplicado`);
      for (const pii of [DOC, NOMBRE, CORREO, CEL, DIR, ...Object.values(cambio)]) expect(txt).not.toContain(String(pii));
    }
  });

  it('AC2: la placa → «cambió placa», sin la placa vieja ni la nueva', () => {
    const d = diferenciasTramite(vistaTramite(tramite()), vistaTramite(tramite({ plateComplete: 'YYY111' })));
    expect(d).toEqual([{ campo: 'plate_complete' }]);
    const txt = detalle('FLIT 1', d)!;
    expect(txt).toBe('[FLIT 1] cambio de datos · radicado R-5512 · cambió placa · aplicado');
    expect(txt).not.toContain(PLACA);
    expect(txt).not.toContain('YYY111');
  });

  it('el formateador no escribe el valor de un campo PII aunque una diferencia lo trajera', () => {
    const txt = detalle('FLIT 1', [{ campo: 'celular', comprador: 2, antes: CEL, despues: '3999999999' }])!;
    expect(txt).toBe('[FLIT 1] cambio de datos · radicado R-5512 · cambió celular (comprador 2) · aplicado');
  });

  it('AC3: ciudad → «ciudad: Medellín → Bogotá», tipo «cambio de datos»; null se escribe «—»', () => {
    const d = diferenciasTramite(vistaTramite(tramite()), vistaTramite(tramite({ ciudad: 'Bogotá', facturaVentaFlitId: null })));
    expect(detalle('FLIT 2', d)).toBe('[FLIT 2] cambio de datos · radicado R-5512 · factura: F-1 → —; ciudad: Medellín → Bogotá · aplicado');
  });

  it('AC1 + combinado: si cambia el estado el tipo es «cambio de estado» y el orden es estado → trámite → placa → compradores', () => {
    const dT = diferenciasTramite(
      vistaTramite(tramite()),
      vistaTramite(tramite({ flitEstado: 'Aprobado', ciudad: 'Bogotá', plateComplete: 'YYY111' })),
    );
    const dC = diferenciasCompradores(
      [comprador(), comprador({ orden: 1, correo: 'a@ejemplo.test', porcentajeParticipacion: '40.00' })],
      [comprador({ porcentajeParticipacion: 50 }), comprador({ orden: 1, correo: 'b@ejemplo.test', porcentajeParticipacion: 50 })],
    );
    expect(detalle('FLIT 1', [...dT, ...dC])).toBe(
      '[FLIT 1] cambio de estado · radicado R-5512 · estado: Asignado → Aprobado; ciudad: Medellín → Bogotá; cambió placa; '
      + 'participación (comprador 1): 60 → 50; cambió correo (comprador 2); participación (comprador 2): 40 → 50 · aplicado',
    );
  });

  it('un comprador que entra o sale solo cambia el conteo, sin sus datos', () => {
    const d = diferenciasCompradores([comprador()], [comprador(), comprador({ orden: 1, numeroDocumento: '1888888888', porcentajeParticipacion: 40 })]);
    const txt = detalle('FLIT 2', d)!;
    expect(txt).toBe('[FLIT 2] cambio de datos · radicado R-5512 · compradores: 1 → 2 · aplicado');
    expect(txt).not.toContain('1888888888');
  });

  it('riesgo de normalización: «60.00» = 60 y «» = null → sin diferencias (sin falso «cambió»)', () => {
    const guardado = comprador({ porcentajeParticipacion: '60.00', correo: '', direccion: '' });
    const nuevo = comprador({ porcentajeParticipacion: 60, correo: null, direccion: null });
    expect(diferenciasCompradores([guardado], [nuevo])).toEqual([]);
    expect(diferenciasCompradores([comprador({ porcentajeParticipacion: null })], [comprador({ porcentajeParticipacion: null })])).toEqual([]);
  });

  it('AC6: campos fuera de la lista cerrada no se comparan; una actualización sin diferencias → null (no se escribe)', () => {
    const antes = vistaTramite({ ...tramite(), sincronizadoEn: new Date('2026-01-01'), flitRaw: { a: 1 } } as never);
    const despues = vistaTramite({ ...tramite(), sincronizadoEn: new Date('2026-02-01'), flitRaw: { a: 2 } } as never);
    expect(diferenciasTramite(antes, despues)).toEqual([]);
    expect(detalle('FLIT 1', [])).toBeNull();
  });

  it('AC4: la creación → «creación» con fuente, radicado y «aplicado», sin diferencias ni PII', () => {
    expect(detalle('FLIT 1', [], true)).toBe('[FLIT 1] creación · radicado R-5512 · aplicado');
    expect(detalle('FLIT 2', [{ campo: 'celular', comprador: 1 }], true)).toBe('[FLIT 2] creación · radicado R-5512 · aplicado');
  });

  it('AC7: las dos fuentes producen la misma forma; solo cambia la etiqueta', () => {
    const d = [...diferenciasTramite(vistaTramite(tramite()), vistaTramite(tramite({ flitEstado: 'Aprobado' }))),
      ...diferenciasCompradores([comprador()], [comprador({ celular: '3111111111' })])];
    const f1 = detalle('FLIT 1', d)!;
    const f2 = detalle('FLIT 2', d)!;
    expect(f1.replace('[FLIT 1]', '')).toBe(f2.replace('[FLIT 2]', ''));
    expect(f1.startsWith('[FLIT 1] ')).toBe(true);
  });

  it('AC8: la vista del historial lleva las 7 claves de siempre, en su orden, sin la placa', () => {
    expect(Object.keys(vistaHistorial(vistaTramite(tramite())))).toEqual([
      'flit_estado', 'factura_venta_flit_id', 'fecha_aprobacion', 'compania_id', 'organismo_codigo', 'tipo_tramite', 'ciudad',
    ]);
  });
});
