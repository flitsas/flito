// HU #12083 nació como la VALLA de los módulos que NO se reconducían (AC4, AC5): once directorios
// legacy con su `requireRole` cableado, y un test que fallaba si alguno se reconducía «de paso».
//
// HU #13423 (Épica #13411, ADR-0023, AC9) — CIERRE de la valla. #13421 movió pesv/, drivers/,
// jornadas/ y rum/; #13422, los ocho de operación; esta HU, los seis últimos (laft/, siigo/, soat/,
// privacy/, firma/, drive/). La valla queda VACÍA y se retira: lo que este fichero vigila ahora es lo
// contrario — que NINGÚN directorio de `apps/api/src/modules` vuelva a decidir por el nombre del rol.
//
//   1. Cero `requireRole(` fuera de comentarios en todo `modules/` (todos los ficheros `.ts`, no solo
//      los de rutas) y cero import de `requireRole`.
//   2. En los seis directorios de esta HU no aparece ninguna comparación del nombre del rol (`role ===
//      '…'`, `[…].includes(req.user.role)`, `eq(users.role, '…')`) fuera de las 4 de ámbito medidas.
//   3. Siigo decide con el motor (`tieneFuncion`), no con una tabla compilada: la tabla de roles por
//      acción no existe ni en el API ni en shared-types ni en la web (AC2).
//
// Mutación del AC9: devolver `requireRole('admin')` a cualquier ruta de cualquier módulo → rojo en (1).

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RAIZ_MODULOS, sinComentarios } from '../../src/modules/permisos/inventario-guardas.js';

/** La valla de la #12083, vacía desde la HU #13423. Se conserva el nombre para que su reaparición se note. */
export const VALLA_AC4: Record<string, number> = {};
export const VALLA_FUERA_DEL_ENUNCIADO: Record<string, number> = {};

const DIRECTORIOS_13423 = ['laft', 'privacy', 'firma', 'drive', 'soat', 'siigo'] as const;

function ficherosTs(dir: string, extension = /\.ts$/): string[] {
  const salida: string[] = [];
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) salida.push(...ficherosTs(ruta, extension));
    else if (extension.test(ruta)) salida.push(ruta);
  }
  return salida;
}

const rel = (f: string) => f.replace(`${RAIZ_MODULOS}/`, '');

describe('AC9 — la valla legacy queda vacía: ningún módulo decide por requireRole', () => {
  it('la valla de la #12083 está vacía (sus 6 últimos directorios los movió la HU #13423)', () => {
    expect({ ...VALLA_AC4, ...VALLA_FUERA_DEL_ENUNCIADO }).toEqual({});
  });

  it('cero `requireRole(` fuera de comentarios en TODO apps/api/src/modules', () => {
    const medidas: Record<string, number> = {};
    for (const f of ficherosTs(RAIZ_MODULOS)) {
      const n = (sinComentarios(readFileSync(f, 'utf8')).match(/requireRole\(/g) ?? []).length;
      if (n) medidas[rel(f)] = n;
    }
    expect(medidas).toEqual({});
  });

  it('ningún fichero de modules/ importa requireRole', () => {
    const importan = ficherosTs(RAIZ_MODULOS)
      .filter((f) => /import\s*\{[^}]*\brequireRole\b[^}]*\}\s*from/.test(sinComentarios(readFileSync(f, 'utf8'))))
      .map(rel);
    expect(importan).toEqual([]);
  });

  // Lo que queda medido el día del cierre NO decide quién entra a una ruta: es ÁMBITO de filas (el
  // proveedor del SOAT antiguo ve solo lo asignado a él) y DESTINATARIOS de un cron (el aviso AROS va a
  // los usuarios `admin`). Cambiarlos es decisión de producto fuera de esta HU; el test se pone rojo si
  // aparece una comparación más (o en otro fichero).
  const AMBITO_13423: Record<string, number> = {
    'laft/cash/aros.cron.ts': 2, // destinatarios y autor del AROS trimestral: usuarios con rol `admin`
    'soat/soat.routes.ts': 2, // ámbito: el proveedor solo ve y compra lo asignado a él
  };

  it('los seis directorios de la HU #13423 no comparan el nombre del rol fuera del ámbito medido', () => {
    const COMPARACION = /\brole\s*(?:===|!==)\s*'[a-z_]+'|\]\.includes\(req\.user[!?]?\.role\)|eq\(users\.role,\s*'[a-z_]+'\)/g;
    const medidas: Record<string, number> = {};
    for (const d of DIRECTORIOS_13423) {
      for (const f of ficherosTs(join(RAIZ_MODULOS, d))) {
        const n = (sinComentarios(readFileSync(f, 'utf8')).match(COMPARACION) ?? []).length;
        if (n) medidas[rel(f)] = n;
      }
    }
    expect(medidas).toEqual(AMBITO_13423);
  });
});

describe('AC2 — Siigo decide con el motor y la tabla de roles por acción ya no existe', () => {
  it('`exigirAccionSiigo` pregunta al motor (`tieneFuncion`) por `siigo.factura.<accion>`, no por el rol', () => {
    const fuente = sinComentarios(readFileSync(join(RAIZ_MODULOS, 'siigo/siigo.permisos.ts'), 'utf8'));
    expect(fuente).toMatch(/tieneFuncion\(req, 'siigo\.factura\.emitir'\)/);
    expect(fuente).not.toMatch(/puedeEjecutar|rolesDe\(|req\.user\.role\s*,\s*accion/);
  });

  it('`ROLES_POR_ACCION`, `puedeEjecutar` y `rolesDe` no aparecen en el API, en shared-types ni en la web', () => {
    const raices = [
      RAIZ_MODULOS,
      join(RAIZ_MODULOS, '..', '..', '..', '..', 'packages', 'shared-types', 'src'),
      join(RAIZ_MODULOS, '..', '..', '..', 'web', 'src'),
    ];
    const hallados = raices
      .flatMap((r) => ficherosTs(r, /\.tsx?$/))
      .filter((f) => /ROLES_POR_ACCION|\bpuedeEjecutar\b|\brolesDe\b/.test(readFileSync(f, 'utf8')));
    expect(hallados).toEqual([]);
  });
});
