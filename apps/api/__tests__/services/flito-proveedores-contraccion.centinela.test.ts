// HU #14354 (Feature F5 #14327, ADR-0039 §3, R21) — Centinela de la contracción de los perfiles de proveedor (AC1).
//
// Desde F5 el nombre, el estado, el NIT, el contacto, el teléfono y la estrategia de logística de un proveedor se LEEN
// del padre `flito_proveedores`, unido por el mismo UUID que el perfil; y la pertenencia de un usuario, de
// `users.flito_proveedor_id`. Las columnas viejas de los perfiles y `users.flito_proveedor_soat_id` siguen existiendo y
// se siguen ESCRIBIENDO (AC4: la imagen anterior se puede restaurar), pero nadie en `src/modules` ni en `src/scripts`
// las lee. Este barrido lo vuelve una regla: una lectura nueva de cualquiera de ellas pone el test en rojo.
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

  it('AC3: los routers y servicios de las rutas antiguas de logística ya no existen', () => {
    const PAR = path.join(RAIZ, 'modules', 'flito-parametrizacion');
    for (const f of [
      'flito-proveedores-logistica.routes.ts',
      'flito-proveedores-logistica.service.ts',
      'flito-proveedores-logistica-gestion.service.ts',
    ]) expect(existsSync(path.join(PAR, f)), f).toBe(false);
    expect(readFileSync(path.join(RAIZ, 'app.ts'), 'utf8')).not.toMatch(/proveedores-logistica/);
  });
});
