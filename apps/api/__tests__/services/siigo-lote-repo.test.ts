// Siigo — el lote de facturación y lo que contiene (HU #11327, extracción de la #11323).
//
// El lote existía desde la HU #11323, pero solo guardaba la HUELLA del conjunto: un sha256 que sirve
// para reconocer «esto ya se encoló» y que **no se puede invertir**. Mientras emitía quien acababa de
// elegir los trámites, daba igual — los ids estaban en la mano. El trabajador de la cola toma una
// fila con un `loteId` y nada más, así que esta suite protege lo que cierra ese agujero.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));

const {
  asegurarLote, correoDelLote, ESTRATEGIA_LOTE, lotesDeTramites, purgarDestinatariosDeLotes,
  tramitesDelLote,
} = await import('../../src/modules/siigo/facturacion.lote.repo.js');

const LOTE = 'llllllll-1111-4111-8111-llllllllllll';
const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';

const ENTRADA = { ambiente: 'pruebas' as const, huella: 'h'.repeat(64), tramiteIds: [A, B], creadoPor: 3 };

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  vi.clearAllMocks();
  kdb.when
    .insert('siigo_lotes_facturacion', [{ id: LOTE }])
    .insert('siigo_lote_tramites', [])
    .select('siigo_lotes_facturacion', [{ id: LOTE }])
    .select('siigo_lote_tramites', []);
});

describe('asegurarLote', () => {
  it('crea el lote con la estrategia vigente y devuelve su id', async () => {
    expect(await asegurarLote(ENTRADA)).toBe(LOTE);
    expect(espia.ultimoInsertEn('siigo_lotes_facturacion')).toMatchObject({
      ambiente: 'pruebas', estrategia: ESTRATEGIA_LOTE, huella: ENTRADA.huella, creadoPor: 3,
    });
  });

  it('deja escrito qué contiene, sin duplicados', async () => {
    await asegurarLote({ ...ENTRADA, tramiteIds: [A, B, A] });
    const filas = espia.insertsEn('siigo_lote_tramites')[0]!.datos as unknown as Array<{ tramiteId: string }>;
    expect(filas).toHaveLength(2);
    expect(filas.map((f) => f.tramiteId).sort()).toEqual([A, B].sort());
  });

  it('cuando el lote ya existía, lo recupera y REGISTRA IGUAL la pertenencia', async () => {
    // Un lote creado antes de la migración 0144 no tiene contenido, y este es el único momento en
    // que puede ganarlo sin que nadie se acuerde de rellenarlo a mano.
    kdb.when.insert('siigo_lotes_facturacion', []);

    expect(await asegurarLote(ENTRADA)).toBe(LOTE);
    expect(espia.insertsEn('siigo_lote_tramites')).toHaveLength(1);
  });

  it('devuelve null si el lote desaparece entre el INSERT y el SELECT', async () => {
    // No lanza: este módulo es un repositorio y sus dos llamadores traducen el hueco a errores
    // distintos. Lanzar aquí obligaría a uno de los dos a reinterpretar un error ajeno.
    kdb.when.insert('siigo_lotes_facturacion', []).select('siigo_lotes_facturacion', []);
    expect(await asegurarLote(ENTRADA)).toBeNull();
    expect(espia.insertsEn('siigo_lote_tramites')).toHaveLength(0);
  });

  it('sin trámites no escribe pertenencia vacía', async () => {
    await asegurarLote({ ...ENTRADA, tramiteIds: [] });
    expect(espia.insertsEn('siigo_lote_tramites')).toHaveLength(0);
  });
});

describe('tramitesDelLote', () => {
  it('devuelve los trámites ORDENADOS', async () => {
    // El orden no es cosmético: la clave de idempotencia se deriva de la huella, y la huella se
    // calcula sobre los ids ordenados. Devolverlos en el orden que quiera el planificador haría que
    // el mismo lote produjera claves distintas según el plan de la consulta.
    kdb.when.select('siigo_lote_tramites', [{ tramiteId: A }, { tramiteId: B }]);
    expect(await tramitesDelLote(LOTE)).toEqual([A, B]);
  });

  it('un lote sin contenido devuelve vacío, no explota', async () => {
    expect(await tramitesDelLote(LOTE)).toEqual([]);
  });
});

describe('lotesDeTramites', () => {
  it('sin trámites no pregunta nada', async () => {
    expect(await lotesDeTramites('pruebas', [])).toEqual([]);
    expect(kdb.select).not.toHaveBeenCalled();
  });

  it('filtra por ambiente: pruebas y producción son empresas distintas de Siigo', async () => {
    kdb.when.select('siigo_lote_tramites', [{ loteId: LOTE, tramiteId: A }]);
    expect(await lotesDeTramites('produccion', [A])).toEqual([{ loteId: LOTE, tramiteId: A }]);
    expect(espia.filtrosUsados()).toContain('produccion');
  });
});

// ── HU #11708 — la elección del correo viaja con el lote ────────────────────

describe('el correo elegido en el envío', () => {
  const CARTERA = { correo: 'cartera@cliente.test', origen: 'manual' as const };

  it('se guarda con el lote: el envío encola y la emisión ocurre después, en otro proceso', async () => {
    // Sin el snapshot habría que deducirlo en el cron, y deducirlo es la regla fija del ambiente que
    // esta historia quitó: la factura saldría sin el correo que alguien pidió.
    await asegurarLote({ ...ENTRADA, correo: { solicitado: true, destinatarios: [CARTERA] } });

    expect(espia.ultimoInsertEn('siigo_lotes_facturacion')).toMatchObject({
      correoSolicitado: true, correoDestinatarios: [CARTERA],
    });
  });

  it('un envío que no eligió nada deja el lote sin correo y sin direcciones', async () => {
    await asegurarLote(ENTRADA);

    expect(espia.ultimoInsertEn('siigo_lotes_facturacion')).toMatchObject({
      correoSolicitado: false, correoDestinatarios: [],
    });
  });

  it('se lee tal cual se guardó', async () => {
    kdb.when.select('siigo_lotes_facturacion', [{ solicitado: true, destinatarios: [CARTERA] }]);

    expect(await correoDelLote(LOTE)).toEqual({ solicitado: true, destinatarios: [CARTERA] });
  });

  it('un lote anterior a la migración 0161 se lee como «no se pidió», no como «sin decidir»', async () => {
    // La columna nace con `false`, y ese valor significa exactamente lo mismo para un lote viejo que
    // para uno nuevo: no sale correo, y la emisión lo deja escrito. No hay tercer estado que
    // interpretar, que es lo que evita que alguien invente un respaldo «como antes».
    kdb.when.select('siigo_lotes_facturacion', []);

    expect(await correoDelLote(LOTE)).toEqual({ solicitado: false, destinatarios: [] });
  });
});

describe('purgarDestinatariosDeLotes (Ley 1581)', () => {
  it('vacía las direcciones de los lotes encontrados y cuenta cuántos', async () => {
    // Desde la HU #11708 esta tabla guarda datos personales. Una copia fuera del alcance de la purga
    // convertiría la respuesta al titular en una mentira.
    kdb.when
      .select('siigo_lotes_facturacion', [{ id: LOTE }])
      .update('siigo_lotes_facturacion', [{ id: LOTE }]);

    expect(await purgarDestinatariosDeLotes([7], ['cartera@cliente.test'])).toBe(1);
    expect(espia.updatesEn('siigo_lotes_facturacion')[0]!.datos)
      .toMatchObject({ correoDestinatarios: [] });
  });

  it('sin compañías y sin correos no toca nada: un olvido vacío no puede vaciar la tabla', async () => {
    // Es la avería que importa: si los dos filtros degradaran a «verdadero», este UPDATE borraría las
    // direcciones de TODOS los lotes del sistema por una llamada sin argumentos.
    expect(await purgarDestinatariosDeLotes([], [])).toBe(0);
    expect(kdb.update).not.toHaveBeenCalled();
    expect(kdb.select).not.toHaveBeenCalled();
  });

  it('busca por dirección aunque no haya compañía: el titular puede no ser el cliente del trámite', async () => {
    kdb.when
      .select('siigo_lotes_facturacion', [{ id: LOTE }])
      .update('siigo_lotes_facturacion', [{ id: LOTE }]);

    expect(await purgarDestinatariosDeLotes([], ['tercero@otra.test'])).toBe(1);
  });

  it('no cuenta lotes que no tenían nada que borrar', async () => {
    kdb.when.select('siigo_lotes_facturacion', []);

    expect(await purgarDestinatariosDeLotes([7], [])).toBe(0);
    expect(kdb.update).not.toHaveBeenCalled();
  });
});
