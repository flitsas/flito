// HU #14354 (Feature F5 #14327, ADR-0039 §3, R21) — Centinela de la contracción de los perfiles de proveedor (AC1).
//
// Desde F5 el nombre, el estado, el NIT, el contacto, el teléfono y la estrategia de logística de un proveedor se LEEN
// del padre `flito_proveedores`, unido por el mismo UUID que el perfil; y la pertenencia de un usuario, de
// `users.flito_proveedor_id`. Las columnas viejas de los perfiles y `users.flito_proveedor_soat_id` siguen existiendo y
// se siguen ESCRIBIENDO (AC4: la imagen anterior se puede restaurar), pero nadie en `src/modules` ni en `src/scripts`
// las lee. Este barrido lo vuelve una regla: una lectura nueva de cualquiera de ellas pone el test en rojo. (Desde la
// 0314, HU #14355, esas columnas ya no existen en la BD; el barrido se conserva para que nadie las vuelva a nombrar.)
//
// Qué cuenta como lectura y por qué no hace falta lista blanca: las escrituras de AC4 (altas de perfil en
// `crearProveedor` y `darPerfil`, `retirarPerfil`, las bajas de `eliminarProveedor`) escriben esas columnas como CLAVES
// de un objeto (`.values({ nombre, … })`, `.set({ deletedAt, … })`) o vía el trigger del padre, nunca como
// `flitoProveedoresSoat.nombre`. La referencia a la COLUMNA (`tabla.columna`, o el nombre SQL en una consulta cruda)
// solo aparece para leer, filtrar, ordenar o unir: eso es exactamente lo prohibido. La configuración SOAT del perfil
// (`estrategia` de SOAT, `umbralOcr`, `slaHoras`) y su `deletedAt` NO están en AC1 y se siguen leyendo del perfil.
//
// Los comentarios se quitan antes de buscar: documentar la columna vieja (como hace esta cabecera) no es leerla.
//
// Mutante que mata: devolver cualquier lectura migrada a la columna vieja (p. ej. `proveedorSoatNombre:
// flitoProveedoresSoat.nombre` en la cola SOAT, o `userSelect.flitoProveedorSoatId: users.flitoProveedorSoatId`).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { db } from '../../src/db/client.js';
import { flitoProveedoresLogistica, flitoProveedoresSoat, users } from '../../src/db/schema.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const DIRECTORIOS = ['modules', 'scripts'] as const;

/** Lecturas prohibidas desde F5. Cada una con el motivo, para que el rojo diga qué migrar. */
const PROHIBIDAS: readonly { patron: RegExp; motivo: string }[] = [
  { patron: /\bflitoProveedoresSoat\.(nombre|activo)\b/, motivo: 'nombre/activo del perfil SOAT: leer `flitoProveedores`' },
  {
    patron: /\bflitoProveedoresLogistica\.(nombre|activo|nit|contacto|telefono|estrategia)\b/,
    motivo: 'datos generales o estrategia del perfil de logística: leer `flitoProveedores`',
  },
  { patron: /\busers\.flitoProveedorSoatId\b/, motivo: 'pertenencia vieja del usuario: leer `users.flitoProveedorId`' },
  { patron: /\bflito_proveedor_soat_id\b/, motivo: 'columna vieja `users.flito_proveedor_soat_id` en SQL crudo: usar `flito_proveedor_id`' },
];

function ficherosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = path.join(dir, nombre);
    if (statSync(ruta).isDirectory()) return ficherosTs(ruta);
    return nombre.endsWith('.ts') ? [ruta] : [];
  });
}

/** Quita comentarios de bloque y de línea. `//` precedido de `:` (una URL dentro de una cadena) se respeta. */
function sinComentarios(fuente: string): string {
  return fuente
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('HU #14354 — AC1: nadie en apps/api lee las columnas viejas de los perfiles ni `users.flito_proveedor_soat_id`', () => {
  const ficheros = DIRECTORIOS.flatMap((d) => ficherosTs(path.join(RAIZ, d)));

  it('el barrido cubre los módulos y los scripts (no pasa en vacío)', () => {
    expect(ficheros.length).toBeGreaterThan(100);
    expect(ficheros.some((f) => f.endsWith(path.join('flito-soat', 'flito-soat.service.ts')))).toBe(true);
    expect(ficheros.some((f) => f.endsWith(path.join('scripts', 'flito-seed.ts')))).toBe(true);
  });

  it('ninguna lectura prohibida en src/modules ni en src/scripts', () => {
    const hallazgos: string[] = [];
    for (const fichero of ficheros) {
      const lineas = sinComentarios(readFileSync(fichero, 'utf8')).split('\n');
      lineas.forEach((linea, i) => {
        for (const { patron, motivo } of PROHIBIDAS) {
          if (patron.test(linea)) hallazgos.push(`${path.relative(RAIZ, fichero)}:${i + 1} — ${motivo}`);
        }
      });
    }
    expect(hallazgos).toEqual([]);
  });

  it('el barrido detecta una lectura vieja (el patrón no está muerto)', () => {
    const muestra = sinComentarios([
      '// flitoProveedoresSoat.nombre en un comentario no cuenta',
      'const x = { proveedorSoatNombre: flitoProveedoresSoat.nombre };',
      'sql`u.flito_proveedor_soat_id IS NULL`;',
      'const y = { nit: flitoProveedoresLogistica.nit, s: users.flitoProveedorSoatId };',
      'const z = { umbral: flitoProveedoresSoat.umbralOcr, sla: flitoProveedoresSoat.slaHoras };',
    ].join('\n')).split('\n');
    const marcadas = muestra.map((l) => PROHIBIDAS.filter(({ patron }) => patron.test(l)).length);
    expect(marcadas).toEqual([0, 1, 1, 2, 0]);
  });

  it('AC3 (#14354): los routers y servicios de las rutas antiguas de logística ya no existen', () => {
    const PAR = path.join(RAIZ, 'modules', 'flito-parametrizacion');
    for (const f of [
      'flito-proveedores-logistica.routes.ts',
      'flito-proveedores-logistica.service.ts',
      'flito-proveedores-logistica-gestion.service.ts',
    ]) expect(existsSync(path.join(PAR, f)), f).toBe(false);
    expect(readFileSync(path.join(RAIZ, 'app.ts'), 'utf8')).not.toMatch(/proveedores-logistica/);
  });
});

// HU #14673 (F5 E1) — Drizzle nombra TODAS las columnas declaradas en `select()`, `insert` y `returning`, aunque la
// consulta no las pida. Si el código las declarara, la imagen no sobreviviría al DROP de la #14355. Siguen en la BD
// como espejo del padre que llenan los triggers de la 0313.
//
// Mutante que mata: volver a declarar cualquiera de ellas en `src/db/schema/` (el `toSQL()` la nombraría).
describe('HU #14673 — AC1/AC2: el código ya no declara las columnas viejas', () => {
  const nombresSql = (t: Parameters<typeof getTableColumns>[0]) => Object.values(getTableColumns(t)).map((c) => c.name).sort();

  it('AC1: el perfil SOAT conserva solo su configuración (sin nombre ni activo)', () => {
    expect(nombresSql(flitoProveedoresSoat)).toEqual(
      ['created_at', 'deleted_at', 'deleted_by', 'estrategia', 'id', 'sla_horas', 'umbral_ocr'],
    );
  });

  it('AC1: el perfil de logística no declara nombre, estrategia, activo, nit, contacto ni teléfono', () => {
    expect(nombresSql(flitoProveedoresLogistica)).toEqual(['created_at', 'deleted_at', 'deleted_by', 'id']);
  });

  it('AC1: users no declara flito_proveedor_soat_id ni su índice; sí flito_proveedor_id', () => {
    const columnas = nombresSql(users);
    expect(columnas).not.toContain('flito_proveedor_soat_id');
    expect(columnas).toContain('flito_proveedor_id');
    expect(getTableConfig(users).indexes.map((i) => i.config.name)).not.toContain('idx_users_flito_proveedor_soat');
  });

  it('AC2: el SQL de las escrituras de perfil no nombra las columnas viejas', () => {
    const VIEJAS = /"(nombre|activo|nit|contacto|telefono)"/;
    const consultas = [
      db.insert(flitoProveedoresSoat).values({ id: '00000000-0000-0000-0000-000000000001', estrategia: 'portal' }).returning(),
      db.insert(flitoProveedoresLogistica).values({ id: '00000000-0000-0000-0000-000000000001' }).returning(),
      db.update(flitoProveedoresLogistica).set({ deletedAt: null, deletedBy: null }).where(eq(flitoProveedoresLogistica.id, 'x')).returning(),
      db.select().from(flitoProveedoresSoat),
      db.select().from(users),
    ];
    for (const q of consultas) expect(q.toSQL().sql).not.toMatch(VIEJAS);
    expect(db.select().from(users).toSQL().sql).not.toMatch(/flito_proveedor_soat_id/);
    // Logística tampoco nombra `estrategia`: su valor lo pone el DEFAULT de la BD.
    expect(db.insert(flitoProveedoresLogistica).values({ id: 'x' }).toSQL().sql).not.toMatch(/"estrategia"/);
  });
});

// HU #14355 (F5 E2) — la 0314 retiró la sincronización y las columnas viejas. Desde entonces ningún archivo de `src/`
// (código ni comentarios) nombra un trigger o una función retirada: quien la nombre está describiendo un mecanismo que
// ya no existe. Y la comprobación previa manual lista exactamente lo que detiene la 0314.
//
// Mutantes que mata: volver a nombrar un trigger retirado en un comentario o en código de `src/`; cambiar una
// comparación de la guarda de la 0314 sin cambiar la del preflight (o al revés).
describe('HU #14355 — AC4: nada en src/ nombra la sincronización retirada; el preflight es la guarda de la 0314', () => {
  const RETIRADOS = [
    'perfil_crea_padre', 'perfil_a_padre', 'padre_a_perfil', 'perfil_borrado', 'perfil_espejo_baja',
    'users_proveedor_sync', 'users_proveedor_sincroniza', 'flito_proveedor_restriccion_del_perfil',
  ] as const;
  const PATRON = new RegExp(`\\b(${RETIRADOS.join('|')})\\b`);
  const todos = ficherosTs(RAIZ);

  it('el barrido recorre todo src/ (no pasa en vacío) y el patrón no está muerto', () => {
    expect(todos.length).toBeGreaterThan(ficherosTs(path.join(RAIZ, 'modules')).length);
    expect(todos.some((f) => f.endsWith(path.join('db', 'schema', 'nucleo.ts')))).toBe(true);
    for (const nombre of RETIRADOS) expect(PATRON.test(`el trigger \`${nombre}\` (0313)`), nombre).toBe(true);
    expect(PATRON.test('users_ambito_trg y flito_proveedor_servicios_v siguen')).toBe(false);
  });

  it('ningún .ts de src/ nombra un trigger o una función retirada, tampoco en comentarios', () => {
    const hallazgos: string[] = [];
    for (const fichero of todos) {
      readFileSync(fichero, 'utf8').split('\n').forEach((linea, i) => {
        if (PATRON.test(linea)) hallazgos.push(`${path.relative(RAIZ, fichero)}:${i + 1}`);
      });
    }
    expect(hallazgos).toEqual([]);
  });

  it('AC3: el bloque DIFERENCIAS del preflight es idéntico al de la guarda de la 0314', () => {
    const bloque = (archivo: string) => {
      const texto = readFileSync(path.join(RAIZ, 'db', archivo), 'utf8');
      const a = texto.indexOf('-- >>> DIFERENCIAS');
      const b = texto.indexOf('-- <<< DIFERENCIAS');
      expect(a, archivo).toBeGreaterThanOrEqual(0);
      expect(b, archivo).toBeGreaterThan(a);
      return texto.slice(a, b);
    };
    const migracion = bloque(path.join('migrations', '0314_flito_proveedores_contraccion.sql'));
    expect(bloque(path.join('manual', 'flito-proveedores-contraccion-preflight.sql'))).toBe(migracion);
    expect(migracion).toMatch(/PERFIL DISTINTO/);
    expect(migracion).toMatch(/USUARIO DISTINTO/);
  });

  it('AC3: el preflight es de solo lectura y no crea ni escribe nada', () => {
    const sinComentarios = readFileSync(path.join(RAIZ, 'db', 'manual', 'flito-proveedores-contraccion-preflight.sql'), 'utf8')
      .replace(/--[^\n]*/g, '');
    expect(sinComentarios).toMatch(/set_config\('transaction_read_only', 'on', true\)/);
    expect(sinComentarios).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
  });

  it('el preflight de la 0292 se declara obsoleto tras la 0314 y remite al nuevo', () => {
    const viejo = readFileSync(path.join(RAIZ, 'db', 'manual', 'flito-proveedores-preflight.sql'), 'utf8');
    expect(viejo.split('\n').slice(0, 8).join('\n')).toMatch(/OBSOLETA TRAS LA 0314[\s\S]*flito-proveedores-contraccion-preflight\.sql/);
  });
});
