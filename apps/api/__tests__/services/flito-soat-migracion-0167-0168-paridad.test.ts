// Feature #11912 / HU #11913 — paridad entre las migraciones 0167 + 0168 y `schema.ts`, y guarda
// del reparto entre las dos.
//
// La capa de datos de esta HU está escrita DOS veces y en dos lenguajes: los `.sql`, que es lo que
// corre en `db:apply` y en el CD, y `schema.ts`, que es lo que lee quien escribe una consulta. Nada
// vigila que digan lo mismo, y las divergencias de esta familia no fallan: cuelan.
//
// Qué mutaciones se cazan aquí, todas ellas capaces de dejar el esquema VÁLIDO y la promesa ROTA:
//
//   · **El CHECK del AC2 fusionado dentro de la 0167.** Es el motivo por el que hay dos archivos:
//     PostgreSQL prohíbe USAR un valor de enum en la misma transacción en la que se añade (55P04) y
//     el runner envuelve cada archivo en una. Fusionarlos funciona en la máquina de quien ya aplicó
//     la 0167 y ABORTA el despliegue en un entorno limpio — el peor sitio para enterarse.
//
//   · **El CHECK de `flito_compradores` relajado a un OR.** Un «uno u otro, o los dos» permite que
//     una fila cuelgue de dos padres y desaparezca con el CASCADE del que no la creó.
//
//   · **El índice de la factura de venta sin `descartado = false`.** Con esa condición fuera, una
//     factura descartada bloquea para siempre la subsanación de esa solicitud (HU #11915).
//
//   · **El slug del UPDATE de `allowed_pages` mal tecleado.** No falla: concede en silencio un
//     permiso que no existe, y nadie se entera hasta que alguien abre la pantalla y no la ve.
//
//   · **`users.compania_id` con otro `ON DELETE`.** `SET NULL` crearía por la puerta de atrás el
//     `cliente` sin compañía que el AC2 declara imposible.
//
// Las migraciones no se reescriben una vez aplicadas (regla del repo): si este test se pone rojo, lo
// que toca es una migración NUEVA o corregir el otro lado, según de qué lado esté el error.
//
// Análisis estático puro: NO toca la base.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { PAGES } from '@operaciones/shared-types';
import { clients, flitoCompradores, flitoSoat, roleEnum, flitoSoatEstadoEnum, users } from '../../src/db/schema.js';
// El guarda de ADR-DB-001 tal como lo aplica el runner, no una reimplementación: así lo que este
// test comprueba es LITERALMENTE lo que abortaría el `db:apply`.
import { scanForTxControl } from '../../src/scripts/db-apply.js';

const A_0167 = '0167_flito_soat_canal_cliente.sql';
const A_0168 = '0168_flito_soat_cliente_check_compania.sql';
const ruta = (f: string) => fileURLToPath(new URL(`../../src/db/migrations/${f}`, import.meta.url));
const CRUDO_0167 = readFileSync(ruta(A_0167), 'utf8');
const CRUDO_0168 = readFileSync(ruta(A_0168), 'utf8');

/**
 * Quita los comentarios `--` conservando los saltos de línea, sin entrar en las cadenas: los cuerpos
 * de los `COMMENT ON` son literales SQL y ahí un `--` es texto.
 *
 * No es cosmético: las cabeceras de las dos migraciones explican en prosa —y con ejemplos de SQL—
 * cómo NO son los archivos. Sin podarlas, la explicación de lo que se descartó alimentaría las
 * comprobaciones de lo que se hizo.
 */
function podarComentarios(texto: string): string {
  let salida = '';
  let enCadena = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (!enCadena && c === '-' && texto[i + 1] === '-') {
      while (i < texto.length && texto[i] !== '\n') i++;
      salida += '\n';
      continue;
    }
    if (c === "'") enCadena = !enCadena;
    salida += c;
  }
  return salida;
}

/** Sentencias del archivo, normalizadas a una línea. El separador es el `;` fuera de cadena. */
function sentenciasDe(texto: string): string[] {
  const trozos: string[] = [];
  let actual = '';
  let enCadena = false;
  for (const c of texto) {
    if (c === "'") enCadena = !enCadena;
    if (c === ';' && !enCadena) { trozos.push(actual); actual = ''; continue; }
    actual += c;
  }
  trozos.push(actual);
  return trozos.map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length > 0);
}

const CUERPO_0167 = podarComentarios(CRUDO_0167);
const CUERPO_0168 = podarComentarios(CRUDO_0168);
const SENT_0167 = sentenciasDe(CUERPO_0167);
const SENT_0168 = sentenciasDe(CUERPO_0168);
/** Las sentencias que hacen algo, sin los `COMMENT ON` (que son documentación en la base). */
const efectivas = (s: string[]) => s.filter((x) => !/^COMMENT ON/i.test(x));

describe('0167/0168 — el reparto entre los dos archivos (la trampa del 55P04)', () => {
  it('ninguna de las dos declara control de transacción propio (ADR-DB-001)', () => {
    expect(scanForTxControl(A_0167, CRUDO_0167)).toEqual([]);
    expect(scanForTxControl(A_0168, CRUDO_0168)).toEqual([]);
  });

  it('la 0167 añade los tres valores de enum, y con IF NOT EXISTS', () => {
    for (const [tipo, valor] of [
      ['user_role', 'cliente'],
      ['flito_soat_estado', 'pendiente_revision'],
      ['flito_soat_estado', 'rechazada'],
    ]) {
      const add = SENT_0167.find((s) => new RegExp(`ALTER TYPE ${tipo} ADD VALUE .*'${valor}'`, 'i').test(s));
      expect(add, `falta el ADD VALUE de '${valor}'`).toBeDefined();
      // Sin `IF NOT EXISTS` la segunda pasada muere con 42710 y para la cadena entera.
      expect(add).toMatch(/IF NOT EXISTS/i);
    }
  });

  it('la 0167 NO usa el valor nuevo del enum `user_role` en ninguna parte', () => {
    // Esta es la afirmación que impide fusionar las dos migraciones. Las ÚNICAS menciones legítimas
    // de 'cliente' en la 0167 son el propio ADD VALUE y el CHECK del varchar `origen`, que no tiene
    // nada que ver con el enum. Cualquier otra —un CHECK sobre `role`, un DEFAULT, un UPDATE— es un
    // `55P04 unsafe use of new value` en el primer entorno que aplique las dos migraciones seguidas.
    const conCliente = efectivas(SENT_0167).filter((s) => s.includes("'cliente'"));
    expect(conCliente).toHaveLength(2);
    expect(conCliente[0]).toMatch(/^ALTER TYPE user_role ADD VALUE/i);
    expect(conCliente[1]).toMatch(/CHECK \(origen IN \('tramite', 'cliente'\)\)/i);
    expect(efectivas(SENT_0167).some((s) => /role\s*(<>|=|!=)\s*'cliente'/i.test(s))).toBe(false);
  });

  it('la 0168 lleva el CHECK del AC2 y NO se basta sola (depende de la 0167)', () => {
    const add = SENT_0168.find((s) => /ADD CONSTRAINT users_cliente_compania_chk/i.test(s));
    expect(add).toBeDefined();
    // La implicación va en UN sentido: exige compañía cuando el rol es cliente, y no prohíbe que
    // otro rol la tenga (eso lo rechaza Zod, que sí puede explicar por qué).
    expect(add).toMatch(/CHECK \(role <> 'cliente' OR compania_id IS NOT NULL\)/i);
    // Idempotente: sin el DROP previo, la segunda pasada aborta con 42710.
    expect(SENT_0168.some((s) => /DROP CONSTRAINT IF EXISTS users_cliente_compania_chk/i.test(s))).toBe(true);
    // Y no trae el ADD VALUE: si lo trajera, el CHECK volvería a estar en la misma transacción que
    // el valor que nombra, que es exactamente lo que este reparto evita.
    expect(efectivas(SENT_0168).some((s) => /ALTER TYPE/i.test(s))).toBe(false);
  });
});

describe('0167 — lo que la migración promete, sentencia a sentencia', () => {
  it('`users.compania_id` es nullable, con FK a clients y ON DELETE RESTRICT', () => {
    const add = SENT_0167.find((s) => /ALTER TABLE users ADD COLUMN IF NOT EXISTS compania_id/i.test(s));
    expect(add).toBeDefined();
    expect(add).toMatch(/integer REFERENCES clients\(id\) ON DELETE RESTRICT/i);
    // NOT NULL aquí obligaría a inventarle compañía a los 11 roles que no la tienen; y `SET NULL` en
    // el borrado crearía el `cliente` sin compañía que el AC2 declara imposible.
    expect(add).not.toMatch(/NOT NULL/i);
    expect(add).not.toMatch(/ON DELETE (SET NULL|CASCADE)/i);
  });

  it('`clients.soat_sin_tramite` nace apagado (AC3) y es NOT NULL', () => {
    const add = SENT_0167.find((s) => /ALTER TABLE clients ADD COLUMN IF NOT EXISTS soat_sin_tramite/i.test(s));
    expect(add).toMatch(/boolean NOT NULL DEFAULT false/i);
  });

  it('`flito_soat.origen` tiene DEFAULT `tramite`: las filas de hoy no cambian de significado', () => {
    const add = SENT_0167.find((s) => /ALTER TABLE flito_soat ADD COLUMN IF NOT EXISTS origen/i.test(s));
    expect(add).toMatch(/varchar\(10\) NOT NULL DEFAULT 'tramite'/i);
  });

  it('`flito_compradores` admite DOS padres y exige EXACTAMENTE uno', () => {
    expect(SENT_0167.some((s) => /ALTER TABLE flito_compradores ALTER COLUMN tramite_id DROP NOT NULL/i.test(s))).toBe(true);
    const chk = SENT_0167.find((s) => /ADD CONSTRAINT flito_compradores_padre_chk/i.test(s));
    // `<>` entre los dos predicados = XOR. Un `OR` dejaría pasar la fila con los dos padres, que
    // desaparecería con el CASCADE del que no la creó.
    expect(chk).toMatch(/CHECK \(\(tramite_id IS NOT NULL\) <> \(soat_id IS NOT NULL\)\)/i);
    expect(chk).not.toMatch(/IS NOT NULL\) OR \(/i);
  });

  it('el índice de la factura de venta lleva `descartado = false`', () => {
    const idx = SENT_0167.find((s) => /idx_flito_soportes_soat_factura_venta/i.test(s));
    expect(idx).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS/i);
    expect(idx).toMatch(/descartado = false/i);
    expect(idx).toMatch(/tipo = 'factura_venta'/i);
  });

  it('el UPDATE de `allowed_pages` es aditivo, idempotente y con un slug que EXISTE', () => {
    const upd = SENT_0167.find((s) => /^UPDATE users/i.test(s));
    expect(upd).toBeDefined();
    // El slug literal tiene que ser una clave real del catálogo. Un error de tecleo no falla:
    // concede en silencio un permiso que no existe.
    const slug = upd!.match(/array_append\(.*?, '([a-z_]+)'\)/)![1];
    expect(Object.keys(PAGES)).toContain(slug);
    expect(slug).toBe('flito_soat');
    // Aditivo: `array_append` sobre lo que ya hay, no un ARRAY[...] que borraría los permisos a mano.
    expect(upd).toMatch(/array_append/i);
    expect(upd).not.toMatch(/SET allowed_pages = ARRAY\[/i);
    // Idempotente de verdad: en la segunda pasada el WHERE no selecciona a nadie.
    expect(upd).toMatch(/AND NOT \('flito_soat' = ANY/i);
    // Y NO se le quita `soat` a nadie: conserva exactamente lo que hoy puede hacer.
    expect(upd).not.toMatch(/array_remove/i);
  });
});

describe('paridad `.sql` ↔ `schema.ts` — que las dos verdades sean la misma', () => {
  const columnas = (t: Parameters<typeof getTableConfig>[0]) =>
    new Map(getTableConfig(t).columns.map((c) => [c.name, c]));

  it('los enums de Drizzle traen los mismos valores que la 0167 añade', () => {
    expect(roleEnum.enumValues).toContain('cliente');
    expect(flitoSoatEstadoEnum.enumValues).toContain('pendiente_revision');
    expect(flitoSoatEstadoEnum.enumValues).toContain('rechazada');
    // `operaciones` sigue en el enum de Postgres (quitarlo obligaría a recrear el tipo) y se omite
    // del literal a propósito: no es un incumplimiento del AC4, es deuda declarada.
    expect(roleEnum.enumValues).not.toContain('operaciones');
  });

  it('las tres columnas nuevas existen en `schema.ts` con el mismo nombre y nulabilidad', () => {
    const u = columnas(users).get('compania_id');
    expect(u, 'users.compania_id no está en schema.ts').toBeDefined();
    expect(u!.notNull).toBe(false);

    const c = columnas(clients).get('soat_sin_tramite');
    expect(c, 'clients.soat_sin_tramite no está en schema.ts').toBeDefined();
    expect(c!.notNull).toBe(true);
    expect(c!.default).toBe(false);

    const o = columnas(flitoSoat).get('origen');
    expect(o, 'flito_soat.origen no está en schema.ts').toBeDefined();
    expect(o!.notNull).toBe(true);
    expect(o!.default).toBe('tramite');
  });

  it('`flito_compradores.tramite_id` es nullable también en Drizzle', () => {
    // Si aquí siguiera `notNull`, el compilador dejaría de avisar a quien agrupa por trámite y el
    // canal Cliente escribiría filas que el tipo dice que no existen.
    expect(columnas(flitoCompradores).get('tramite_id')!.notNull).toBe(false);
    expect(columnas(flitoCompradores).get('soat_id')).toBeDefined();
    expect(columnas(flitoCompradores).get('tipo_documento')).toBeDefined();
  });

  it('los CHECK que la 0167 crea están declarados también en `schema.ts`', () => {
    // La lección de la 0157: un CHECK que solo vive en la base convence a quien lee `schema.ts` de
    // que añadir un valor no necesita migración, y el primer INSERT muere con 23514.
    const chkSoat = getTableConfig(flitoSoat).checks.map((c) => c.name);
    expect(chkSoat).toContain('flito_soat_origen_chk');
    const chkComp = getTableConfig(flitoCompradores).checks.map((c) => c.name);
    expect(chkComp).toContain('flito_compradores_padre_chk');
  });
});
