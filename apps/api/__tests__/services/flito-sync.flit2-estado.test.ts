// HU #13097 (Feature #13060) — servicio del estado de la conexión con FLIT 2.
//
// `componerEstado` es la lógica pura con reloj fijo (umbral 2·R + 5 min de la HU #13633, precedencia del problema,
// normalización del motivo, sin configurar). `obtenerEstadoConexion` se prueba contra el mock keyed
// por tabla para AC4 (conteo), AC6 ('ambiente') y AC7 (lo que se selecciona y lo que sale).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const { componerEstado, obtenerEstadoConexion, normalizarMotivoRechazo, codigoPublico, umbralAlertaMs } =
  await import('../../src/modules/flito-sync/flit2-estado.service.js');
const { env } = await import('../../src/config/env.js');
const { marcarProgramaEncendido, marcarLecturaIniciada, reiniciarProgramaParaTest } =
  await import('../../src/modules/flito-sync/flit2-programa.js');
type Entrada = Parameters<typeof componerEstado>[0];

const AHORA = new Date('2026-09-29T15:00:00.000Z');
const menos = (min: number) => new Date(AHORA.getTime() - min * 60_000);

const ACCESO = { createdAt: menos(600), rechazadoEn: null, rechazoMotivo: null, bloqueadoHasta: null };
const LECTURA = {
  ultimaExitosaEn: menos(5), ultimoIntentoEn: menos(5), ultimoErrorCodigo: null,
  atrasada: false, piiEnmascaradaDesde: null,
};
const PROGRAMA_APAGADO = { activa: false, intervaloMs: null, proximaEn: null, enCurso: false };
const PROGRAMA_ENCENDIDO = { activa: true, intervaloMs: 300_000, proximaEn: new Date('2026-09-29T15:05:00.000Z'), enCurso: false };
const entrada = (e: Partial<Entrada> = {}): Entrada => ({
  ambienteListo: true, acceso: ACCESO, lectura: LECTURA, tramitesEnmascarados: 0, programa: PROGRAMA_APAGADO, ...e,
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

  // HU #13633: sin `respaldoMs` el umbral es el del respaldo por defecto (R=5 → 15 min).
  it.each([[14, false], [15, true], [16, true]])('AC5: %i min desde la última exitosa → alerta %s', (min, esperado) => {
    const r = componerEstado(entrada({ lectura: { ...LECTURA, ultimaExitosaEn: menos(min) } }), AHORA);
    expect(r.alerta).toBe(esperado);
  });

  it.each([[14, false], [15, true], [16, true]])('AC5: sin lectura exitosa nunca, cuenta desde el alta del acceso (%i min) → %s', (min, esperado) => {
    const r = componerEstado(entrada({
      acceso: { ...ACCESO, createdAt: menos(min) },
      lectura: { ...LECTURA, ultimaExitosaEn: null },
    }), AHORA);
    expect(r.alerta).toBe(esperado);
  });

  it('AC5: sin fila de lectura, también cuenta desde el alta del acceso', () => {
    expect(componerEstado(entrada({ acceso: { ...ACCESO, createdAt: menos(14) }, lectura: null }), AHORA).alerta).toBe(false);
    expect(componerEstado(entrada({ acceso: { ...ACCESO, createdAt: menos(15) }, lectura: null }), AHORA).alerta).toBe(true);
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

describe('HU #13188 · componerEstado · bloque automatica', () => {
  it('AC1: con el programa encendido trae activa, intervalo, próxima futura ≤ 5 min y generadoEn = ahora', () => {
    const a = componerEstado(entrada({ programa: PROGRAMA_ENCENDIDO }), AHORA).automatica;
    expect(a).toEqual({
      activa: true, intervaloMs: 300_000, proximaEn: '2026-09-29T15:05:00.000Z', enCurso: false,
      generadoEn: '2026-09-29T15:00:00.000Z',
    });
  });

  it('AC3: con el programa apagado, intervaloMs y proximaEn en null aunque la foto traiga valores', () => {
    const a = componerEstado(entrada({ programa: { ...PROGRAMA_ENCENDIDO, activa: false } }), AHORA).automatica;
    expect(a).toMatchObject({ activa: false, intervaloMs: null, proximaEn: null });
  });

  it('AC4: enCurso pasa tal cual de la foto del programa', () => {
    expect(componerEstado(entrada({ programa: { ...PROGRAMA_APAGADO, enCurso: true } }), AHORA).automatica.enCurso).toBe(true);
  });

  it.each([
    ['sin acceso', { acceso: null }],
    ['sin ambiente', { ambienteListo: false }],
    ['sin ambiente ni acceso', { ambienteListo: false, acceso: null, lectura: null }],
  ] as const)('AC5: configurado=false (%s) → el bloque automatica viene igual', (_n, extra) => {
    const r = componerEstado(entrada({ ...extra, programa: PROGRAMA_ENCENDIDO }), AHORA);
    expect(r.configurado).toBe(false);
    expect(r.automatica).toEqual(componerEstado(entrada({ programa: PROGRAMA_ENCENDIDO }), AHORA).automatica);
  });

  it('AC6: el bloque automatica trae exactamente cinco claves, sin nada sensible', () => {
    const a = componerEstado(entrada({ programa: PROGRAMA_ENCENDIDO }), AHORA).automatica;
    expect(Object.keys(a).sort()).toEqual(['activa', 'enCurso', 'generadoEn', 'intervaloMs', 'proximaEn']);
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
    rechazosFirmaSeguidos: 0, ultimoAvisoEn: null,
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
      ['alerta', 'atrasada', 'automatica', 'configurado', 'habilitada', 'motivoDeshabilitada', 'motivoSinConfigurar', 'piiEnmascarada', 'problema', 'ultimaExitosaEn', 'ultimoAvisoEn', 'ultimoIntentoEn'],
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

  it('HU #13188 AC1/AC4/AC6: el GET lee el programa del proceso; generadoEn sale del mismo reloj', async () => {
    reiniciarProgramaParaTest();
    marcarProgramaEncendido(300_000, AHORA);
    marcarLecturaIniciada();
    kdb.when.scenario({ flito_sync_flit2_acceso: [filaAcceso], flito_sync_flit2_lectura: [filaLectura], flito_tramites: [{ n: 0 }] });
    const r = await obtenerEstadoConexion(() => AHORA);
    reiniciarProgramaParaTest();
    expect(r.automatica).toEqual({
      activa: true, intervaloMs: 300_000, proximaEn: '2026-09-29T15:05:00.000Z', enCurso: true,
      generadoEn: AHORA.toISOString(),
    });
    expect(Object.keys(r.automatica).sort()).toEqual(['activa', 'enCurso', 'generadoEn', 'intervaloMs', 'proximaEn']);
  });

  it('AC6: sin fila de acceso activa → sin_acceso; conteo vacío → 0', async () => {
    kdb.when.scenario({ flito_sync_flit2_acceso: [], flito_sync_flit2_lectura: [filaLectura], flito_tramites: [] });
    const r = await obtenerEstadoConexion(() => AHORA);
    expect(r).toMatchObject({ configurado: false, motivoSinConfigurar: 'sin_acceso', alerta: false, problema: null });
    expect(r.piiEnmascarada.tramites).toBe(0);
  });
});

// ── HU #13237 — habilitación de FLIT 2 en el estado (AC8, AC9; decisión del hilo: apagada → sin alerta) ──
describe('HU #13237 · componerEstado · habilitada y motivo', () => {
  // Sin lectura exitosa hace 2 h: con la fuente habilitada esto SÍ levanta la alerta (control positivo).
  const viejo = entrada({ lectura: { ...LECTURA, ultimaExitosaEn: menos(120) } });

  it('AC9: maestro e interruptor encendidos → habilitada, sin motivo; la alerta por tiempo sigue viva', () => {
    const r = componerEstado({ ...viejo, maestro: true, interruptorFlit2: true }, AHORA);
    expect(r.habilitada).toBe(true);
    expect(r.motivoDeshabilitada).toBeNull();
    expect(r.alerta).toBe(true);
  });

  it('AC8/AC9: maestro en false → motivo «maestro», y gana aunque el interruptor también esté apagado', () => {
    expect(componerEstado({ ...viejo, maestro: false, interruptorFlit2: true }, AHORA))
      .toMatchObject({ habilitada: false, motivoDeshabilitada: 'maestro' });
    expect(componerEstado({ ...viejo, maestro: false, interruptorFlit2: false }, AHORA))
      .toMatchObject({ habilitada: false, motivoDeshabilitada: 'maestro' });
  });

  it('AC9: maestro encendido e interruptor apagado → motivo «interruptor»', () => {
    expect(componerEstado({ ...viejo, maestro: true, interruptorFlit2: false }, AHORA))
      .toMatchObject({ habilitada: false, motivoDeshabilitada: 'interruptor' });
  });

  it('decisión del hilo (riesgo 1): apagada a propósito no levanta alerta, ni por tiempo ni por rechazo; el problema se sigue informando', () => {
    const rechazado = { ...viejo, acceso: { ...ACCESO, rechazadoEn: menos(3), rechazoMotivo: 'invalid_client' } };
    for (const apagado of [{ maestro: false }, { interruptorFlit2: false }]) {
      expect(componerEstado({ ...viejo, ...apagado }, AHORA).alerta).toBe(false);
      const r = componerEstado({ ...rechazado, ...apagado }, AHORA);
      expect(r.alerta).toBe(false);
      expect(r.problema?.tipo).toBe('rechazado');
    }
    // Control: la misma entrada habilitada sí alerta.
    expect(componerEstado(rechazado, AHORA).alerta).toBe(true);
  });
});

describe('HU #13237 · obtenerEstadoConexion · lee el interruptor y el maestro', () => {
  const envAntes = { base: env.FLIT2_BASE_URL, llave: env.FLIT2_ENC_KEY, cron: env.FLIT2_SYNC_CRON };
  beforeEach(() => {
    kdb.reset();
    (env as Record<string, unknown>).FLIT2_BASE_URL = 'https://flit2.test';
    (env as Record<string, unknown>).FLIT2_ENC_KEY = 'a'.repeat(64);
    (env as Record<string, unknown>).FLIT2_SYNC_CRON = true;
    kdb.when.scenario({ flito_sync_flit2_acceso: [ACCESO], flito_sync_flit2_lectura: [LECTURA], flito_tramites: [{ n: 0 }] });
  });
  afterEach(() => {
    (env as Record<string, unknown>).FLIT2_BASE_URL = envAntes.base;
    (env as Record<string, unknown>).FLIT2_ENC_KEY = envAntes.llave;
    (env as Record<string, unknown>).FLIT2_SYNC_CRON = envAntes.cron;
  });

  it('AC9: la fila flit2 apagada → habilitada=false por interruptor', async () => {
    kdb.when.select('flito_sync_interruptor', [{ encendido: false }]);
    expect(await obtenerEstadoConexion(() => AHORA)).toMatchObject({ habilitada: false, motivoDeshabilitada: 'interruptor' });
  });

  it('AC8: FLIT2_SYNC_CRON=false → motivo maestro aunque la fila esté encendida', async () => {
    kdb.when.select('flito_sync_interruptor', [{ encendido: true }]);
    (env as Record<string, unknown>).FLIT2_SYNC_CRON = false;
    expect(await obtenerEstadoConexion(() => AHORA)).toMatchObject({ habilitada: false, motivoDeshabilitada: 'maestro' });
  });

  it('fila ausente → se informa habilitada (sembrada encendida)', async () => {
    expect(await obtenerEstadoConexion(() => AHORA)).toMatchObject({ habilitada: true, motivoDeshabilitada: null });
  });

  it('un error de base al leer el interruptor se propaga (no se traga como «encendida»)', async () => {
    kdb.when.selectThrow('flito_sync_interruptor', new Error('db caída'));
    await expect(obtenerEstadoConexion(() => AHORA)).rejects.toThrow('db caída');
  });
});

// ── HU #13633 — respaldo configurable y alerta por respaldos fallidos o firmas rechazadas ────────────
describe('HU #13633 · componerEstado · umbral 2·R + 5 min (AC4)', () => {
  const R5 = 5 * 60_000;
  const R60 = 60 * 60_000;
  const conExitosa = (min: number, respaldoMs: number) =>
    componerEstado(entrada({ lectura: { ...LECTURA, ultimaExitosaEn: menos(min) }, respaldoMs }), AHORA);

  it('AC4: el umbral es 2·R + 5 min (R=5 → 15 min; R=60 → 125 min)', () => {
    expect(umbralAlertaMs(R5)).toBe(15 * 60_000);
    expect(umbralAlertaMs(R60)).toBe(125 * 60_000);
  });

  it.each([[14, false], [15, true]])('AC4: R=5, %i min sin lectura exitosa → alerta %s', (min, esperado) => {
    expect(conExitosa(min, R5).alerta).toBe(esperado);
  });

  it.each([[124, false], [125, true]])('AC4: R=60, %i min sin lectura exitosa → alerta %s', (min, esperado) => {
    expect(conExitosa(min, R60).alerta).toBe(esperado);
  });

  it('AC4: un solo respaldo fallido no alerta (R + tope de corrida de 4 min < 2R + 5)', () => {
    expect(conExitosa(5 + 4, R5).alerta).toBe(false);
    expect(conExitosa(60 + 4, R60).alerta).toBe(false);
    // Con el código de error del respaldo fallido en la fila, sigue sin alertar.
    const r = componerEstado(entrada({
      lectura: { ...LECTURA, ultimaExitosaEn: menos(64), ultimoErrorCodigo: 'no_responde' }, respaldoMs: R60,
    }), AHORA);
    expect(r.problema?.tipo).toBe('lectura');
    expect(r.alerta).toBe(false);
  });

  it('AC4: dos respaldos fallidos seguidos sí alertan (R=5)', () => {
    expect(conExitosa(2 * 5 + 5, R5).alerta).toBe(true);
  });

  it('AC4: un aviso válido reciente NO cuenta como lectura exitosa', () => {
    const r = componerEstado(entrada({
      lectura: { ...LECTURA, ultimaExitosaEn: menos(20), ultimoAvisoEn: menos(1) }, respaldoMs: R5,
    }), AHORA);
    expect(r.alerta).toBe(true);
  });
});

describe('HU #13633 · componerEstado · avisos_firma (AC5)', () => {
  const conRechazos = (n: number, extra: Partial<Entrada> = {}) => componerEstado(entrada({
    lectura: { ...LECTURA, rechazosFirmaSeguidos: n }, avisosHabilitados: true, ...extra,
  }), AHORA);

  it('AC5: ≥ 3 firmas rechazadas seguidas → problema avisos_firma sin hora y alerta con lectura fresca', () => {
    for (const n of [3, 4, 50]) {
      const r = conRechazos(n);
      expect(r.problema).toEqual({ tipo: 'avisos_firma', codigo: null, motivo: null, en: null, hasta: null });
      expect(r.alerta).toBe(true);
    }
  });

  it('AC5: 2 rechazos no son problema ni alerta', () => {
    const r = conRechazos(2);
    expect(r.problema).toBeNull();
    expect(r.alerta).toBe(false);
  });

  it('AC5: tras un aviso válido el contador queda en 0 y la alerta se retira', () => {
    const r = conRechazos(0, { lectura: { ...LECTURA, rechazosFirmaSeguidos: 0, ultimoAvisoEn: menos(1) } });
    expect(r.problema).toBeNull();
    expect(r.alerta).toBe(false);
  });

  it('AC5: con el canal de avisos apagado, el contador de la base no cuenta', () => {
    for (const extra of [{ avisosHabilitados: false }, { avisosHabilitados: undefined }]) {
      const r = conRechazos(9, extra);
      expect(r.problema).toBeNull();
      expect(r.alerta).toBe(false);
    }
  });

  it('AC5: precedencia rechazado > bloqueado > avisos_firma > lectura', () => {
    const futuro = new Date(AHORA.getTime() + 60_000);
    const lectura = { ...LECTURA, rechazosFirmaSeguidos: 5, ultimoErrorCodigo: 'no_responde' };
    expect(conRechazos(5, { lectura, acceso: { ...ACCESO, rechazadoEn: menos(2), bloqueadoHasta: futuro } }).problema?.tipo)
      .toBe('rechazado');
    expect(conRechazos(5, { lectura, acceso: { ...ACCESO, bloqueadoHasta: futuro } }).problema?.tipo).toBe('bloqueado');
    expect(conRechazos(5, { lectura }).problema?.tipo).toBe('avisos_firma');
    expect(conRechazos(0, { lectura: { ...lectura, rechazosFirmaSeguidos: 0 } }).problema?.tipo).toBe('lectura');
  });
});

describe('HU #13633 · componerEstado · ultimoAvisoEn (AC6) y apagado (AC7)', () => {
  it('AC6: ultimoAvisoEn null sin aviso (y con llamadores previos que no lo pasan)', () => {
    expect(componerEstado(entrada(), AHORA).ultimoAvisoEn).toBeNull();
    expect(componerEstado(entrada({ lectura: { ...LECTURA, ultimoAvisoEn: null } }), AHORA).ultimoAvisoEn).toBeNull();
    expect(componerEstado(entrada({ lectura: null }), AHORA).ultimoAvisoEn).toBeNull();
  });

  it('AC6: ultimoAvisoEn en ISO junto a ultimaExitosaEn', () => {
    const r = componerEstado(entrada({ lectura: { ...LECTURA, ultimoAvisoEn: menos(2) } }), AHORA);
    expect(r.ultimoAvisoEn).toBe(menos(2).toISOString());
    expect(r.ultimaExitosaEn).toBe(LECTURA.ultimaExitosaEn.toISOString());
  });

  it('AC7: interruptor apagado o FLIT2_SYNC_CRON=false → alerta false por tiempo y por firmas', () => {
    const malo = entrada({
      lectura: { ...LECTURA, ultimaExitosaEn: menos(600), rechazosFirmaSeguidos: 7 }, avisosHabilitados: true, respaldoMs: 5 * 60_000,
    });
    expect(componerEstado(malo, AHORA).alerta).toBe(true); // control
    for (const apagado of [{ maestro: false }, { interruptorFlit2: false }]) {
      const r = componerEstado({ ...malo, ...apagado }, AHORA);
      expect(r.alerta).toBe(false);
      expect(r.problema?.tipo).toBe('avisos_firma');
    }
  });
});

describe('HU #13633 · obtenerEstadoConexion · lee R, el canal y las columnas de la 0244', () => {
  const antes = {
    base: env.FLIT2_BASE_URL, llave: env.FLIT2_ENC_KEY, cron: env.FLIT2_SYNC_CRON,
    respaldo: env.FLIT2_RESPALDO_MIN, avisos: env.FLIT2_AVISOS_HABILITADO,
  };
  const fijar = (k: string, v: unknown) => { (env as Record<string, unknown>)[k] = v; };
  beforeEach(() => {
    kdb.reset();
    fijar('FLIT2_BASE_URL', 'https://flit2.test');
    fijar('FLIT2_ENC_KEY', 'a'.repeat(64));
    fijar('FLIT2_SYNC_CRON', true);
  });
  afterEach(() => {
    fijar('FLIT2_BASE_URL', antes.base);
    fijar('FLIT2_ENC_KEY', antes.llave);
    fijar('FLIT2_SYNC_CRON', antes.cron);
    fijar('FLIT2_RESPALDO_MIN', antes.respaldo);
    fijar('FLIT2_AVISOS_HABILITADO', antes.avisos);
  });
  const escenario = (lectura: Record<string, unknown>) => kdb.when.scenario({
    flito_sync_flit2_acceso: [ACCESO], flito_sync_flit2_lectura: [{ ...LECTURA, ...lectura }], flito_tramites: [{ n: 0 }],
  });

  it('AC4: el umbral sale de FLIT2_RESPALDO_MIN (R=60: 100 min sin leer no alerta; R=5 sí)', async () => {
    escenario({ ultimaExitosaEn: menos(100) });
    fijar('FLIT2_RESPALDO_MIN', 60);
    expect((await obtenerEstadoConexion(() => AHORA)).alerta).toBe(false);
    fijar('FLIT2_RESPALDO_MIN', 5);
    expect((await obtenerEstadoConexion(() => AHORA)).alerta).toBe(true);
  });

  it('AC5/AC6: rechazos y último aviso de la fila; avisos_firma solo con FLIT2_AVISOS_HABILITADO', async () => {
    escenario({ rechazosFirmaSeguidos: 3, ultimoAvisoEn: menos(7) });
    fijar('FLIT2_AVISOS_HABILITADO', true);
    const r = await obtenerEstadoConexion(() => AHORA);
    expect(r).toMatchObject({ alerta: true, ultimoAvisoEn: menos(7).toISOString() });
    expect(r.problema).toEqual({ tipo: 'avisos_firma', codigo: null, motivo: null, en: null, hasta: null });
    expect(JSON.stringify(r)).not.toContain('rechazosFirmaSeguidos');

    fijar('FLIT2_AVISOS_HABILITADO', false);
    expect(await obtenerEstadoConexion(() => AHORA)).toMatchObject({ alerta: false, problema: null });
  });
});
