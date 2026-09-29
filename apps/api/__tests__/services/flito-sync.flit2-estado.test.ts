// HU #13097 (Feature #13060) — servicio del estado de la conexión con FLIT 2.
//
// `componerEstado` es la lógica pura con reloj fijo (umbral de 30 min, precedencia del problema,
// normalización del motivo, sin configurar). `obtenerEstadoConexion` se prueba contra el mock keyed
// por tabla para AC4 (conteo), AC6 ('ambiente') y AC7 (lo que se selecciona y lo que sale).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const { componerEstado, obtenerEstadoConexion, normalizarMotivoRechazo, codigoPublico, UMBRAL_ALERTA_MS } =
  await import('../../src/modules/flito-sync/flit2-estado.service.js');
const { env } = await import('../../src/config/env.js');
type Entrada = Parameters<typeof componerEstado>[0];

const AHORA = new Date('2026-09-29T15:00:00.000Z');
const menos = (min: number) => new Date(AHORA.getTime() - min * 60_000);

const ACCESO = { createdAt: menos(600), rechazadoEn: null, rechazoMotivo: null, bloqueadoHasta: null };
const LECTURA = {
  ultimaExitosaEn: menos(5), ultimoIntentoEn: menos(5), ultimoErrorCodigo: null,
  atrasada: false, piiEnmascaradaDesde: null,
};
const entrada = (e: Partial<Entrada> = {}): Entrada => ({
  ambienteListo: true, acceso: ACCESO, lectura: LECTURA, tramitesEnmascarados: 0, ...e,
});

describe('HU #13097 · componerEstado', () => {
  it('AC1: devuelve la última exitosa y el último intento en ISO', () => {
    const r = componerEstado(entrada({ lectura: { ...LECTURA, ultimaExitosaEn: menos(10), ultimoIntentoEn: menos(2) } }), AHORA);
    expect(r.configurado).toBe(true);
    expect(r.motivoSinConfigurar).toBeNull();
    expect(r.ultimaExitosaEn).toBe('2026-09-29T14:50:00.000Z');
    expect(r.ultimoIntentoEn).toBe('2026-09-29T14:58:00.000Z');
    expect(r.problema).toBeNull();
    expect(r.alerta).toBe(false);
  });

  it('AC2: atrasada sale de la señal guardada por la lectura', () => {
    expect(componerEstado(entrada({ lectura: { ...LECTURA, atrasada: true } }), AHORA).atrasada).toBe(true);
    expect(componerEstado(entrada(), AHORA).atrasada).toBe(false);
  });

  it.each([[29, false], [30, true], [31, true]])('AC5: %i min desde la última exitosa → alerta %s', (min, esperado) => {
    const r = componerEstado(entrada({ lectura: { ...LECTURA, ultimaExitosaEn: menos(min) } }), AHORA);
    expect(r.alerta).toBe(esperado);
  });

  it('AC5: el umbral es exactamente 30 min', () => {
    expect(UMBRAL_ALERTA_MS).toBe(30 * 60_000);
  });

  it.each([[29, false], [30, true], [31, true]])('AC5: sin lectura exitosa nunca, cuenta desde el alta del acceso (%i min) → %s', (min, esperado) => {
    const r = componerEstado(entrada({
      acceso: { ...ACCESO, createdAt: menos(min) },
      lectura: { ...LECTURA, ultimaExitosaEn: null },
    }), AHORA);
    expect(r.alerta).toBe(esperado);
  });

  it('AC5: sin fila de lectura, también cuenta desde el alta del acceso', () => {
    expect(componerEstado(entrada({ acceso: { ...ACCESO, createdAt: menos(29) }, lectura: null }), AHORA).alerta).toBe(false);
    expect(componerEstado(entrada({ acceso: { ...ACCESO, createdAt: menos(30) }, lectura: null }), AHORA).alerta).toBe(true);
  });

  it('AC3/AC5: rechazo reciente → problema rechazado con motivo normalizado y hora; alerta aunque la lectura sea fresca', () => {
    const r = componerEstado(entrada({
      acceso: { ...ACCESO, rechazadoEn: menos(3), rechazoMotivo: 'secret_rotation_required' },
    }), AHORA);
    expect(r.problema).toEqual({ tipo: 'rechazado', codigo: null, motivo: 'cambio_clave', en: menos(3).toISOString(), hasta: null });
    expect(r.alerta).toBe(true);
  });

  it('AC3/AC5: bloqueo vigente → problema bloqueado con hasta; alerta con lectura fresca', () => {
    const hasta = new Date(AHORA.getTime() + 15 * 60_000);
    const r = componerEstado(entrada({
      acceso: { ...ACCESO, bloqueadoHasta: hasta },
      lectura: { ...LECTURA, ultimoIntentoEn: menos(1) },
    }), AHORA);
    expect(r.problema).toEqual({ tipo: 'bloqueado', codigo: null, motivo: null, en: menos(1).toISOString(), hasta: hasta.toISOString() });
    expect(r.alerta).toBe(true);
  });

  it('AC3: un bloqueo cuyo hasta ya pasó no es problema ni enciende la alerta', () => {
    const r = componerEstado(entrada({ acceso: { ...ACCESO, bloqueadoHasta: menos(1) } }), AHORA);
    expect(r.problema).toBeNull();
    expect(r.alerta).toBe(false);
  });

  it('AC3: precedencia rechazado > bloqueado > lectura', () => {
    const futuro = new Date(AHORA.getTime() + 60_000);
    const lecturaConError = { ...LECTURA, ultimoErrorCodigo: 'no_responde' };
    const todo = componerEstado(entrada({
      acceso: { ...ACCESO, rechazadoEn: menos(2), rechazoMotivo: 'invalid_client', bloqueadoHasta: futuro },
      lectura: lecturaConError,
    }), AHORA);
    expect(todo.problema?.tipo).toBe('rechazado');
    const sinRechazo = componerEstado(entrada({ acceso: { ...ACCESO, bloqueadoHasta: futuro }, lectura: lecturaConError }), AHORA);
    expect(sinRechazo.problema?.tipo).toBe('bloqueado');
    const soloLectura = componerEstado(entrada({ lectura: lecturaConError }), AHORA);
    expect(soloLectura.problema).toEqual({ tipo: 'lectura', codigo: 'no_responde', motivo: null, en: LECTURA.ultimoIntentoEn.toISOString(), hasta: null });
  });

  it('AC5: un problema de lectura con la última exitosa fresca no enciende la alerta por sí solo', () => {
    expect(componerEstado(entrada({ lectura: { ...LECTURA, ultimoErrorCodigo: 'no_responde' } }), AHORA).alerta).toBe(false);
  });

  it.each(['lectura_concurrente', 'sin_acceso'])('%s no es problema de estado', (codigo) => {
    expect(componerEstado(entrada({ lectura: { ...LECTURA, ultimoErrorCodigo: codigo } }), AHORA).problema).toBeNull();
  });

  it('AC3: normalización del motivo de rechazo a la lista cerrada', () => {
    expect(normalizarMotivoRechazo('invalid_client')).toBe('credenciales');
    expect(normalizarMotivoRechazo('secret_rotation_required')).toBe('cambio_clave');
    expect(normalizarMotivoRechazo('lo_que_sea')).toBe('otro');
    expect(normalizarMotivoRechazo(null)).toBe('otro');
  });

  it('AC7: el código de lectura solo pasa con forma de código; el texto crudo se sustituye', () => {
    expect(codigoPublico('invalid_cursor')).toBe('invalid_cursor');
    expect(codigoPublico('The cursor 123 is invalid for client abc')).toBe('flit2_respuesta');
    const r = componerEstado(entrada({ lectura: { ...LECTURA, ultimoErrorCodigo: 'Error: juan@x.com' } }), AHORA);
    expect(r.problema?.codigo).toBe('flit2_respuesta');
  });

  it('AC6: sin fila de acceso → sin_acceso, alerta false y problema null aunque la lectura tenga error', () => {
    const r = componerEstado(entrada({ acceso: null, lectura: { ...LECTURA, ultimaExitosaEn: null, ultimoErrorCodigo: 'no_responde' } }), AHORA);
    expect(r.configurado).toBe(false);
    expect(r.motivoSinConfigurar).toBe('sin_acceso');
    expect(r.alerta).toBe(false);
    expect(r.problema).toBeNull();
  });

  it('AC6: sin ambiente → ambiente (manda sobre sin_acceso), alerta false aun con rechazo y horas sin leer', () => {
    const r = componerEstado(entrada({
      ambienteListo: false,
      acceso: { ...ACCESO, rechazadoEn: menos(2), rechazoMotivo: 'invalid_client' },
      lectura: { ...LECTURA, ultimaExitosaEn: menos(600) },
    }), AHORA);
    expect(r.configurado).toBe(false);
    expect(r.motivoSinConfigurar).toBe('ambiente');
    expect(r.alerta).toBe(false);
    expect(r.problema).toBeNull();
    expect(componerEstado(entrada({ ambienteListo: false, acceso: null }), AHORA).motivoSinConfigurar).toBe('ambiente');
  });

  it('AC4: piiEnmascarada con el conteo y el desde', () => {
    const r = componerEstado(entrada({ tramitesEnmascarados: 7, lectura: { ...LECTURA, piiEnmascaradaDesde: menos(90) } }), AHORA);
    expect(r.piiEnmascarada).toEqual({ tramites: 7, desde: menos(90).toISOString() });
  });
});

describe('HU #13097 · obtenerEstadoConexion (mock keyed)', () => {
  const envAntes = { base: env.FLIT2_BASE_URL, llave: env.FLIT2_ENC_KEY };
  beforeEach(() => {
    kdb.reset();
    (env as Record<string, unknown>).FLIT2_BASE_URL = 'https://flit2.test';
    (env as Record<string, unknown>).FLIT2_ENC_KEY = 'a'.repeat(64);
  });
  afterEach(() => {
    (env as Record<string, unknown>).FLIT2_BASE_URL = envAntes.base;
    (env as Record<string, unknown>).FLIT2_ENC_KEY = envAntes.llave;
  });

  // Filas «como en la base», con TODAS las columnas sensibles: el servicio debe proyectar, no reenviar.
  const filaAcceso = {
    id: 1, clientId: 'svc-flito', secretCipher: Buffer.from('x'), secretIv: Buffer.from('y'), secretAuthTag: Buffer.from('z'),
    createdAt: menos(600), rechazadoEn: menos(4), rechazoMotivo: 'invalid_client', bloqueadoHasta: null,
    bloqueoMotivo: 'client_locked', descifradoFallidoMotivo: 'texto crudo',
  };
  const filaLectura = {
    id: 1, cursor: 'CURSOR-SECRETO', cursorRelectura: 'RELECTURA-SECRETA', sinceArranque: menos(9000),
    ultimaExitosaEn: menos(5), ultimoIntentoEn: menos(4), ultimoErrorCodigo: null, atrasada: true, piiEnmascaradaDesde: menos(60),
  };

  it('AC1/AC2/AC4/AC7: compone desde las tres consultas y la respuesta no lleva nada sensible', async () => {
    kdb.when.scenario({
      flito_sync_flit2_acceso: [filaAcceso],
      flito_sync_flit2_lectura: [filaLectura],
      flito_tramites: [{ n: '3' }],
    });
    const r = await obtenerEstadoConexion(() => AHORA);
    expect(r.configurado).toBe(true);
    expect(r.atrasada).toBe(true);
    expect(r.ultimaExitosaEn).toBe(menos(5).toISOString());
    expect(r.piiEnmascarada).toEqual({ tramites: 3, desde: menos(60).toISOString() });
    expect(r.problema).toMatchObject({ tipo: 'rechazado', motivo: 'credenciales' });

    expect(Object.keys(r).sort()).toEqual(
      ['alerta', 'atrasada', 'configurado', 'motivoSinConfigurar', 'piiEnmascarada', 'problema', 'ultimaExitosaEn', 'ultimoIntentoEn'],
    );
    expect(Object.keys(r.problema!).sort()).toEqual(['codigo', 'en', 'hasta', 'motivo', 'tipo']);
    const json = JSON.stringify(r);
    for (const prohibido of ['svc-flito', 'clientId', 'CURSOR-SECRETO', 'RELECTURA-SECRETA', 'cursor', 'secret', 'invalid_client', 'client_locked', 'texto crudo']) {
      expect(json).not.toContain(prohibido);
    }
  });

  it('AC6: faltan FLIT2_BASE_URL o FLIT2_ENC_KEY → configurado=false por ambiente', async () => {
    kdb.when.scenario({ flito_sync_flit2_acceso: [filaAcceso], flito_sync_flit2_lectura: [filaLectura], flito_tramites: [{ n: 0 }] });
    (env as Record<string, unknown>).FLIT2_ENC_KEY = undefined;
    const r = await obtenerEstadoConexion(() => AHORA);
    expect(r).toMatchObject({ configurado: false, motivoSinConfigurar: 'ambiente', alerta: false, problema: null });
    (env as Record<string, unknown>).FLIT2_ENC_KEY = 'a'.repeat(64);
    (env as Record<string, unknown>).FLIT2_BASE_URL = undefined;
    expect((await obtenerEstadoConexion(() => AHORA)).motivoSinConfigurar).toBe('ambiente');
  });

  it('AC6: sin fila de acceso activa → sin_acceso; conteo vacío → 0', async () => {
    kdb.when.scenario({ flito_sync_flit2_acceso: [], flito_sync_flit2_lectura: [filaLectura], flito_tramites: [] });
    const r = await obtenerEstadoConexion(() => AHORA);
    expect(r).toMatchObject({ configurado: false, motivoSinConfigurar: 'sin_acceso', alerta: false, problema: null });
    expect(r.piiEnmascarada.tramites).toBe(0);
  });
});
