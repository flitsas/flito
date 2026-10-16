// HU #13632 (Feature #13613) — servicio de avisos firmados de FLIT 2: firma, agenda (AC5, AC6, AC7), candado
// ocupado, fuente apagada (AC8) y marcas del canal (C2). Timers falsos; `leer` y `sinAplicar` inyectados.
// Diseño: docs/diseno/hu-13632-avisos-flit2.md.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';

const updateMock = vi.fn();
const setMock = vi.fn();
const whereMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { update: updateMock, select: vi.fn(), insert: vi.fn(), delete: vi.fn(), execute: vi.fn(), transaction: vi.fn() },
  getPoolStats: vi.fn(),
}));
const fuenteMock = vi.fn();
vi.mock('../../src/modules/flito-sync/flito-sync-interruptor.service.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>), fuenteHabilitada: fuenteMock,
}));

const svc = await import('../../src/modules/flito-sync/flit2-avisos.service.js');
const { env } = await import('../../src/config/env.js');
const { Flit2LecturaEnCursoError, Flit2SinAccesoError } = await import('../../src/modules/flito-sync/flit2.errors.js');
const { FuenteApagadaError } = await import('../../src/modules/flito-sync/flito-sync-interruptor.service.js');
const { AgendaAvisosFlit2, VENTANA_MS, REINTENTO_MS, enCursoMaxMs, VOLCADO_MS } = svc;

const SECRETO = 'x'.repeat(40);
const firmar = (cuerpo: Buffer, s = SECRETO) => `sha256=${createHmac('sha256', Buffer.from(s, 'utf8')).update(cuerpo).digest('hex')}`;

function aviso(p: Partial<import('../../src/modules/flito-sync/flit2-avisos.service.js').AvisoFlit2> = {}) {
  return {
    eventId: randomUUID(), tipo: 'tramite.cambio', id: randomUUID(), syncVersion: 1,
    fechaUltimoCambio: '2026-10-16T10:00:00Z', eliminado: false, ...p,
  };
}

/** Agenda con dependencias falsas. `aplicadas` simula `flito_tramites` (id → versión guardada). */
function montar() {
  const aplicadas = new Map<string, number>();
  const pedidas: Map<string, number>[] = [];
  const leer = vi.fn(async () => ({}));
  const sinAplicar = vi.fn(async (p: Map<string, number>) => {
    pedidas.push(new Map(p));
    return new Map([...p].filter(([id, v]) => (aplicadas.get(id) ?? -1) < v));
  });
  const agenda = new AgendaAvisosFlit2({ leer, sinAplicar, ahora: () => Date.now() });
  return { agenda, aplicadas, leer, sinAplicar, pedidas };
}

const avanzar = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** Texto del SQL de Drizzle (partes literales y parámetros), sin las columnas. */
const textoSql = (q: { queryChunks: unknown[] }): string => q.queryChunks.map((c) => {
  if (typeof c === 'number' || typeof c === 'string') return String(c);
  const v = (c as { value?: unknown }).value;
  return Array.isArray(v) ? v.join('') : '';
}).join('');

let agendas: InstanceType<typeof AgendaAvisosFlit2>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-16T12:00:00Z'));
  agendas = [];
  updateMock.mockReset(); setMock.mockReset(); whereMock.mockReset(); fuenteMock.mockReset();
  updateMock.mockReturnValue({ set: setMock });
  setMock.mockReturnValue({ where: whereMock });
  whereMock.mockResolvedValue(undefined);
  fuenteMock.mockResolvedValue(true);
  env.FLIT2_SYNC_CRON = true;
});
afterEach(() => {
  for (const a of agendas) a.detener();
  svc.detenerAvisosFlit2();
  vi.useRealTimers();
});
function nueva() { const m = montar(); agendas.push(m.agenda); return m; }

describe('verificarFirmaAviso (AC2)', () => {
  const cuerpo = Buffer.from('{"a":1}');
  it('firma correcta → ok', () => {
    expect(svc.verificarFirmaAviso(cuerpo, firmar(cuerpo), SECRETO)).toEqual({ ok: true });
  });
  it('un byte del cuerpo cambiado → incorrecta', () => {
    expect(svc.verificarFirmaAviso(Buffer.from('{"a":2}'), firmar(cuerpo), SECRETO)).toEqual({ ok: false, motivo: 'incorrecta' });
  });
  it('ausente, vacía, hex en mayúsculas, sin prefijo, longitud distinta o repetida → motivo propio', () => {
    expect(svc.verificarFirmaAviso(cuerpo, undefined, SECRETO)).toEqual({ ok: false, motivo: 'ausente' });
    expect(svc.verificarFirmaAviso(cuerpo, '', SECRETO)).toEqual({ ok: false, motivo: 'ausente' });
    expect(svc.verificarFirmaAviso(cuerpo, firmar(cuerpo).toUpperCase(), SECRETO)).toMatchObject({ motivo: 'mal_formada' });
    expect(svc.verificarFirmaAviso(cuerpo, firmar(cuerpo).replace('sha256=', 'SHA256='), SECRETO)).toMatchObject({ motivo: 'mal_formada' });
    expect(svc.verificarFirmaAviso(cuerpo, firmar(cuerpo).slice(0, -2), SECRETO)).toMatchObject({ motivo: 'mal_formada' });
    expect(svc.verificarFirmaAviso(cuerpo, [firmar(cuerpo), firmar(cuerpo)], SECRETO)).toMatchObject({ motivo: 'mal_formada' });
  });
  it('la clave son los bytes UTF-8 del secreto tal cual: sin trim', () => {
    expect(svc.claveHmac(' ñ ')).toEqual(Buffer.from(' ñ ', 'utf8'));
    const conEspacio = `${SECRETO} `;
    expect(svc.verificarFirmaAviso(cuerpo, firmar(cuerpo, conEspacio), conEspacio)).toEqual({ ok: true });
    expect(svc.verificarFirmaAviso(cuerpo, firmar(cuerpo, SECRETO), conEspacio)).toMatchObject({ motivo: 'incorrecta' });
  });
});

describe('secretoAvisos (AC3)', () => {
  afterEach(() => { env.FLIT2_AVISOS_HABILITADO = false; env.FLIT2_AVISOS_SECRETO = undefined; });
  it('solo con habilitado y secreto de ≥ 32 caracteres', () => {
    env.FLIT2_AVISOS_HABILITADO = false; env.FLIT2_AVISOS_SECRETO = SECRETO;
    expect(svc.secretoAvisos()).toBeNull();
    env.FLIT2_AVISOS_HABILITADO = true; env.FLIT2_AVISOS_SECRETO = 'x'.repeat(31);
    expect(svc.secretoAvisos()).toBeNull();
    env.FLIT2_AVISOS_SECRETO = undefined;
    expect(svc.secretoAvisos()).toBeNull();
    env.FLIT2_AVISOS_SECRETO = 'x'.repeat(32);
    expect(svc.secretoAvisos()).toBe('x'.repeat(32));
  });
});

describe('agenda — AC5 agrupación', () => {
  it('5 avisos dentro de la ventana → una sola lectura, a los 6 s del primero (ventana fija)', async () => {
    const { agenda, leer, aplicadas } = nueva();
    const cinco = Array.from({ length: 5 }, () => aviso());
    leer.mockImplementation(async () => { for (const x of cinco) aplicadas.set(x.id, 1); return {}; });
    for (const x of cinco) { agenda.agendar(x); await avanzar(1_000); }
    expect(leer).not.toHaveBeenCalled();
    await avanzar(VENTANA_MS - 5_000);
    expect(leer).toHaveBeenCalledTimes(1);
    await avanzar(60_000);
    expect(leer).toHaveBeenCalledTimes(1);
  });

  it('avisos durante una lectura → exactamente una lectura más', async () => {
    const { agenda, leer, aplicadas, pedidas } = nueva();
    const a1 = aviso();
    const b = [aviso(), aviso(), aviso()];
    let soltar!: (v: unknown) => void;
    leer.mockImplementationOnce(() => new Promise((r) => { soltar = r; }));
    // La segunda lectura trae todo lo que se avisó.
    leer.mockImplementation(async () => { for (const x of [a1, ...b]) aplicadas.set(x.id, 1); return {}; });
    agenda.agendar(a1);
    await avanzar(VENTANA_MS);
    expect(leer).toHaveBeenCalledTimes(1);
    for (const x of b) agenda.agendar(x);
    await avanzar(10_000);
    expect(leer).toHaveBeenCalledTimes(1);
    aplicadas.set(a1.id, 1);
    soltar({});
    await avanzar(0);
    expect(leer).toHaveBeenCalledTimes(2);
    expect([...pedidas.at(-1)!.keys()].sort()).toEqual(b.map((x) => x.id).sort());
    await avanzar(60_000);
    expect(leer).toHaveBeenCalledTimes(2);
  });

  it('el lote pendiente respeta los 6 s desde su primer aviso si la lectura termina antes', async () => {
    const { agenda, leer, aplicadas } = nueva();
    let soltar!: (v: unknown) => void;
    leer.mockImplementationOnce(() => new Promise((r) => { soltar = r; }));
    const a1 = aviso();
    agenda.agendar(a1);
    await avanzar(VENTANA_MS);
    const b1 = aviso();
    agenda.agendar(b1);
    await avanzar(1_000);
    aplicadas.set(a1.id, 1);
    soltar({});
    await avanzar(0);
    expect(leer).toHaveBeenCalledTimes(1);
    await avanzar(VENTANA_MS - 1_000);
    expect(leer).toHaveBeenCalledTimes(2);
  });

  it('comprobación previa: si el lote ya está aplicado (otro proceso o el cron), no se lee', async () => {
    const { agenda, leer, aplicadas } = nueva();
    const a = aviso({ syncVersion: 7 });
    aplicadas.set(a.id, 7);
    agenda.agendar(a);
    await avanzar(VENTANA_MS + 1);
    expect(leer).not.toHaveBeenCalled();
  });
});

describe('agenda — AC6 dedup', () => {
  it('mismo eventId o (id, syncVersion) ≤ máxima vista → duplicado; versión mayor → no', () => {
    const { agenda } = nueva();
    const a = aviso({ syncVersion: 5 });
    agenda.agendar(a);
    expect(agenda.esDuplicado({ ...a })).toBe(true);
    expect(agenda.esDuplicado({ ...a, eventId: randomUUID() })).toBe(true);
    expect(agenda.esDuplicado({ ...a, eventId: randomUUID(), syncVersion: 4 })).toBe(true);
    expect(agenda.esDuplicado({ ...a, eventId: randomUUID(), syncVersion: 6 })).toBe(false);
  });

  it('pasado el TTL de 15 min deja de ser duplicado', async () => {
    const { agenda } = nueva();
    const a = aviso();
    agenda.agendar(a);
    await avanzar(15 * 60_000 + 1);
    expect(agenda.esDuplicado(a)).toBe(false);
  });

  it('recibirAviso: duplicado → 200 sin agendar', async () => {
    const { agenda, leer } = nueva();
    const a = aviso();
    expect(await svc.recibirAviso(a, agenda)).toBe('agendado');
    expect(await svc.recibirAviso(a, agenda)).toBe('duplicado');
    await avanzar(VENTANA_MS);
    expect(leer).toHaveBeenCalledTimes(1);
  });
});

describe('agenda — AC7 verificación y reintentos', () => {
  it('lo que el feed aún no trajo → 2 reintentos a 5 s y después queda para el respaldo', async () => {
    const { agenda, leer, pedidas } = nueva();
    const a = aviso({ syncVersion: 3 });
    agenda.agendar(a);
    await avanzar(VENTANA_MS);
    expect(leer).toHaveBeenCalledTimes(1);
    await avanzar(REINTENTO_MS - 1);
    expect(leer).toHaveBeenCalledTimes(1);
    await avanzar(1);
    expect(leer).toHaveBeenCalledTimes(2);
    await avanzar(REINTENTO_MS);
    expect(leer).toHaveBeenCalledTimes(3);
    await avanzar(60_000);
    expect(leer).toHaveBeenCalledTimes(3);
    expect(pedidas.at(-1)).toEqual(new Map([[a.id, 3]]));
  });

  it('si al reintentar ya está aplicado (lo trajo otra lectura), no vuelve a leer', async () => {
    const { agenda, leer, aplicadas } = nueva();
    const a = aviso({ syncVersion: 3 });
    agenda.agendar(a);
    await avanzar(VENTANA_MS);
    aplicadas.set(a.id, 3);
    await avanzar(60_000);
    expect(leer).toHaveBeenCalledTimes(1);
  });

  it('los eliminado:true disparan la lectura pero no se verifican (sin reintentos)', async () => {
    const { agenda, leer, pedidas } = nueva();
    agenda.agendar(aviso({ eliminado: true }));
    await avanzar(VENTANA_MS);
    expect(leer).toHaveBeenCalledTimes(1);
    await avanzar(60_000);
    expect(leer).toHaveBeenCalledTimes(1);
    expect(pedidas.every((p) => p.size === 0)).toBe(true);
  });
});

describe('agenda — candado ocupado y errores', () => {
  it('Flit2LecturaEnCursoError → reintento cada 5 s; si la otra lectura lo trajo, termina', async () => {
    const { agenda, leer, aplicadas } = nueva();
    leer.mockRejectedValueOnce(new Flit2LecturaEnCursoError());
    const a = aviso();
    agenda.agendar(a);
    await avanzar(VENTANA_MS);
    expect(leer).toHaveBeenCalledTimes(1);
    aplicadas.set(a.id, 1);
    await avanzar(REINTENTO_MS);
    expect(leer).toHaveBeenCalledTimes(1);
  });

  it('Flit2LecturaEnCursoError sostenido → se rinde a los LIMITE_CRON_MS + 30 s', async () => {
    const { agenda, leer } = nueva();
    leer.mockRejectedValue(new Flit2LecturaEnCursoError());
    agenda.agendar(aviso());
    await avanzar(VENTANA_MS + enCursoMaxMs() + REINTENTO_MS);
    const n = leer.mock.calls.length;
    expect(n).toBe(Math.ceil(enCursoMaxMs() / REINTENTO_MS) + 1);
    await avanzar(10 * 60_000);
    expect(leer).toHaveBeenCalledTimes(n);
  });

  it.each([
    ['FuenteApagadaError', new FuenteApagadaError('flit2')],
    ['Flit2Error', new Flit2SinAccesoError()],
    ['Error cualquiera', new Error('x')],
  ])('%s al leer → se descarta el lote, sin reintentos y sin lanzar', async (_n, err) => {
    const { agenda, leer } = nueva();
    leer.mockRejectedValueOnce(err);
    agenda.agendar(aviso());
    await avanzar(VENTANA_MS);
    await avanzar(60_000);
    expect(leer).toHaveBeenCalledTimes(1);
  });

  it('detener() limpia timers: nada se lee después', async () => {
    const { agenda, leer } = nueva();
    agenda.agendar(aviso());
    agenda.detener();
    await avanzar(60_000);
    expect(leer).not.toHaveBeenCalled();
  });
});

describe('recibirAviso — AC8', () => {
  it('FLIT2_SYNC_CRON apagado → fuente_apagada, sin lectura', async () => {
    const { agenda, leer } = nueva();
    env.FLIT2_SYNC_CRON = false;
    expect(await svc.recibirAviso(aviso(), agenda)).toBe('fuente_apagada');
    await avanzar(60_000);
    expect(leer).not.toHaveBeenCalled();
  });
  it('interruptor flit2 apagado → fuente_apagada, sin lectura', async () => {
    const { agenda, leer } = nueva();
    fuenteMock.mockResolvedValue(false);
    expect(await svc.recibirAviso(aviso(), agenda)).toBe('fuente_apagada');
    await avanzar(60_000);
    expect(leer).not.toHaveBeenCalled();
  });
  it('si la consulta del interruptor falla, se agenda igual', async () => {
    const { agenda } = nueva();
    fuenteMock.mockRejectedValue(new Error('db'));
    expect(await svc.recibirAviso(aviso(), agenda)).toBe('agendado');
  });
});

describe('marcas del canal (C2)', () => {
  it('rechazos se acumulan y salen en UN update tras 5 s; nada antes', async () => {
    svc.anotarRechazo(); svc.anotarRechazo(); svc.anotarRechazo();
    expect(updateMock).not.toHaveBeenCalled();
    await avanzar(VOLCADO_MS);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const valores = setMock.mock.calls[0]![0];
    expect(Object.keys(valores)).toEqual(['rechazosFirmaSeguidos']);
    expect(textoSql(valores.rechazosFirmaSeguidos)).toMatch(/LEAST/);
    await avanzar(60_000);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('firma válida reinicia el contador y un cuerpo válido fija ultimo_aviso_en', async () => {
    svc.anotarRechazo();
    svc.anotarFirmaValida();
    svc.anotarAvisoValido(new Date('2026-10-16T12:00:01Z'));
    await avanzar(VOLCADO_MS);
    const valores = setMock.mock.calls[0]![0];
    expect(Object.keys(valores).sort()).toEqual(['rechazosFirmaSeguidos', 'ultimoAvisoEn']);
    expect(textoSql(valores.rechazosFirmaSeguidos)).not.toMatch(/LEAST/);
    expect(textoSql(valores.rechazosFirmaSeguidos)).toBe('0::int');
  });

  it('si el volcado falla, conserva lo acumulado y reintenta', async () => {
    whereMock.mockRejectedValueOnce(new Error('lock'));
    svc.anotarRechazo();
    await avanzar(VOLCADO_MS);
    svc.anotarRechazo();
    await avanzar(VOLCADO_MS);
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(textoSql(setMock.mock.calls[1]![0].rechazosFirmaSeguidos)).toMatch(/\+ 2::bigint/);
  });
});
