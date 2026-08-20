import { describe, it, expect } from 'vitest';
import {
  normalizarPoliza, polizaParaColumna, POLIZA_MAX_LONGITUD,
} from '../src/flito-conciliacion';

// Normalización del número de póliza (HU #11673, Feature #11623).
//
// Vive en shared-types y no en el backend porque hay TRES sitios que tienen que decir exactamente lo
// mismo sobre qué es «la misma póliza»:
//
//   · el backfill de la migración 0157, en SQL, sobre los SOAT históricos;
//   · `pagarEnTx`, en TypeScript, cada vez que un SOAT llega a `pagado`;
//   · el cruce de una boleta contra la columna, que es donde se decide si sale dinero.
//
// Si dos de ellos discrepan, el síntoma no es un error en ningún log: es una fila del Excel que dice
// «no encontrada» sobre un SOAT que está ahí. Estos tests son el único sitio donde la regla está
// escrita una vez; la paridad con el `.sql` la vigila
// `apps/api/__tests__/services/flito-conciliacion-migracion-0157-paridad.test.ts`.

describe('normalizarPoliza — qué se tira y qué se conserva', () => {
  it('quita espacios y guiones, que es como el portal y el OCR escriben el mismo número', () => {
    expect(normalizarPoliza('  1234-5678 ')).toBe('12345678');
    expect(normalizarPoliza('FLIT-999')).toBe('FLIT999');
    expect(normalizarPoliza('flit 999')).toBe('FLIT999');
  });

  it('pasa a mayúsculas, sin tocar los dígitos parecidos a letras', () => {
    // `0` y `O` NO se unifican a propósito: son caracteres distintos en la póliza, y «arreglar» esa
    // confusión aquí haría cruzar dos pólizas que de verdad son distintas.
    expect(normalizarPoliza('abc0O1')).toBe('ABC0O1');
  });

  it('tira lo que no es ASCII alfanumérico, igual que el `[^A-Za-z0-9]` del SQL', () => {
    expect(normalizarPoliza('Póliza 12')).toBe('PLIZA12');
    expect(normalizarPoliza('#12/34.56')).toBe('123456');
  });

  it('**filtra ANTES de pasar a mayúsculas** — el orden no es estilo, es la paridad con PostgreSQL', () => {
    // Al revés, `'ß'.toUpperCase()` daría `'SS'` y `'ﬁ'.toUpperCase()` daría `'FI'`: dos letras que
    // se quedarían aquí y que el `regexp_replace` del backfill habría tirado. Filtrando primero solo
    // sobreviven ASCII, y sobre ASCII las dos implementaciones coinciden siempre.
    expect(normalizarPoliza('ß')).toBe('');
    expect(normalizarPoliza('ﬁ')).toBe('');
    expect(normalizarPoliza('A1ßB2')).toBe('A1B2');
  });

  it('una cadena sin nada aprovechable devuelve la cadena vacía, no un espacio ni un null', () => {
    expect(normalizarPoliza('   ')).toBe('');
    expect(normalizarPoliza('---')).toBe('');
  });
});

describe('polizaParaColumna — lo que de verdad se escribe en `flito_soat.numero_poliza`', () => {
  it('devuelve la póliza normalizada cuando hay algo legible', () => {
    expect(polizaParaColumna('  1234-5678 ')).toBe('12345678');
  });

  it('**la cadena vacía se guarda como null**, nunca como texto vacío', () => {
    // Un `''` en la columna pasaría por un valor y cruzaría con cualquier otra fila vacía: dos SOAT
    // sin póliza legible se «encontrarían» entre sí, y una boleta descontaría el que no era.
    expect(polizaParaColumna('   ')).toBeNull();
    expect(polizaParaColumna('')).toBeNull();
  });

  it('null y undefined pasan de largo (un SOAT pendiente todavía no tiene póliza)', () => {
    expect(polizaParaColumna(null)).toBeNull();
    expect(polizaParaColumna(undefined)).toBeNull();
  });

  it(`lo que pasa de ${POLIZA_MAX_LONGITUD} caracteres se descarta en vez de reventar el INSERT`, () => {
    // El caso real es un OCR que leyó un párrafo entero donde debía haber un número: sin este
    // guarda sería un `22001 value too long` en mitad de la transacción que marca el SOAT pagado.
    expect(polizaParaColumna('X'.repeat(POLIZA_MAX_LONGITUD + 1))).toBeNull();
    expect(polizaParaColumna('X'.repeat(POLIZA_MAX_LONGITUD))).toHaveLength(POLIZA_MAX_LONGITUD);
  });

  it('cuenta la longitud DESPUÉS de normalizar, no antes', () => {
    // Una póliza con guiones cada cuatro dígitos puede pasarse del tope en crudo y caber de sobra
    // una vez limpia. Descartarla sería perder un dato bueno.
    const conGuiones = Array.from({ length: POLIZA_MAX_LONGITUD / 4 }, () => '1234').join('-');
    expect(conGuiones.length).toBeGreaterThan(POLIZA_MAX_LONGITUD); // 74 caracteres en crudo
    expect(polizaParaColumna(conGuiones)).toHaveLength(POLIZA_MAX_LONGITUD); // 60 ya limpia
  });

  it('lo que devuelve cumple SIEMPRE el CHECK de la base (`^[A-Z0-9]{1,60}$`) o es null', () => {
    const entradas = ['  1234-5678 ', 'abc0O1', 'Póliza 12', '   ', null, 'X'.repeat(70), 'FLIT-999'];
    for (const e of entradas) {
      const v = polizaParaColumna(e);
      if (v === null) continue;
      expect(v, `entrada ${JSON.stringify(e)}`).toMatch(new RegExp(`^[A-Z0-9]{1,${POLIZA_MAX_LONGITUD}}$`));
    }
  });
});
