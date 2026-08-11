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

const { asegurarLote, ESTRATEGIA_LOTE, lotesDeTramites, tramitesDelLote } = await import(
  '../../src/modules/siigo/facturacion.lote.repo.js');

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
