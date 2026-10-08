// HU #12083 — La VALLA de los módulos que NO se reconducen (AC4, AC5).
//
// Once directorios legacy (205 `requireRole` medidos en el enunciado) siguen con su guarda de rol
// cableada hasta que haya decisión de producto; `soat/` (AC5) es uno más de la misma tabla. Este
// test falla si alguno los reconduce «de paso»: dos asertos por directorio.
//
//   1. `requireRole(` fuera de comentarios ≥ el medido el día en que se escribió esto. No exacto: a
//      `pesv/` le llegan merges de otras sesiones y un número exacto convertiría cada HU legacy en un
//      rojo de esta valla. Lo que el AC pide es que nadie PIERDA guardas, y «≥ por directorio» lo
//      cubre sin que el crecimiento de uno tape la pérdida de otro.
//   2. Ningún fichero del directorio importa `exigir-funcion.js`. Esta es la valla real: reconducir
//      «de paso» es exactamente cambiar un import, y se ve aunque el conteo no baje.
//
// Medido el 10/09/2026 con `sinComentarios` del lector (misma poda de comentarios que usa el catálogo):
//   for d in <dirs>; do grep -rho "requireRole(" apps/api/src/modules/$d | wc -l; done — y restados
//   los que están en comentarios. Quien vuelva a medir, cambia el número aquí y lo dice en el PR.
//
// Una segunda lista, rotulada «fuera del enunciado», cubre los 7 directorios con `requireRole` que el
// AC4 no nombra ni la HU reconduce (decisión del 10/09/2026): misma regla, para que tampoco se muevan
// sin decisión. `permisos/` estuvo aquí (1 guarda) hasta la HU #12084, que lo reconduce y lo lleva a
// `DIRECTORIOS_RECONDUCIDOS` (permisos.reconduccion-cierre.test.ts). `siigo/` conserva además su `puedeEjecutar` compilado (AC4: «referencia, no se mueve»).

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RAIZ_MODULOS, sinComentarios } from '../../src/modules/permisos/inventario-guardas.js';

/** Los 11 del AC4 (con `soat/` del AC5) y el número medido el día de la valla. */
// HU #13421 (ADR-0023): `pesv/` (48), `drivers/` (24) y `jornadas/` (3) salen de la valla y pasan a
// `DIRECTORIOS_RECONDUCIDOS` (permisos.reconduccion-cierre.test.ts), igual que `rum/` (1) de la otra lista.
// HU #13422: `maintenance/` (33), `rutas/` (16), `vehicles/` (10), `fleet/` (10) y `rndc/` (3) salen
// también, con `clients/` (3), `liquidacion/` (1) y `finanzas/` (1) de la otra lista.
export const VALLA_AC4: Record<string, number> = {
  laft: 27, siigo: 16, soat: 11,
};

/** Fuera del enunciado: ni en el AC4 ni en los 20 reconducidos. Misma regla. */
export const VALLA_FUERA_DEL_ENUNCIADO: Record<string, number> = {
  privacy: 3, firma: 2, drive: 2,
};

function ficherosTs(dir: string): string[] {
  const salida: string[] = [];
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) salida.push(...ficherosTs(ruta));
    else if (ruta.endsWith('.ts')) salida.push(ruta);
  }
  return salida;
}

function medir(directorio: string): { guardas: number; importanElMotor: string[] } {
  let guardas = 0;
  const importanElMotor: string[] = [];
  for (const f of ficherosTs(join(RAIZ_MODULOS, directorio))) {
    const fuente = readFileSync(f, 'utf8');
    guardas += (sinComentarios(fuente).match(/requireRole\(/g) ?? []).length;
    if (/exigir-funcion\.js/.test(sinComentarios(fuente))) importanElMotor.push(f.replace(RAIZ_MODULOS, ''));
  }
  return { guardas, importanElMotor };
}

function valla(titulo: string, tabla: Record<string, number>) {
  describe(titulo, () => {
    for (const [directorio, medido] of Object.entries(tabla)) {
      it(`${directorio}/ conserva sus ${medido} requireRole( (o más) y ningún fichero importa exigir-funcion.js`, () => {
        const { guardas, importanElMotor } = medir(directorio);
        expect(guardas, `${directorio}/ perdió guardas requireRole: ${guardas} < ${medido}`).toBeGreaterThanOrEqual(medido);
        expect(importanElMotor, `${directorio}/ importa el motor; reconducirlo exige decisión de producto`).toEqual([]);
      });
    }
  });
}

valla('AC4/AC5 — los once directorios fuera de alcance quedan vallados, no reconducidos', VALLA_AC4);
valla('fuera del enunciado — los siete directorios que ni el AC4 nombra ni la HU reconduce', VALLA_FUERA_DEL_ENUNCIADO);

describe('AC4 — siigo/ se toma como referencia y no se mueve', () => {
  it('`exigirAccionSiigo` sigue decidiendo con el `puedeEjecutar` / `ROLES_POR_ACCION` compilados de shared-types, no con el motor', () => {
    const fuente = sinComentarios(readFileSync(join(RAIZ_MODULOS, 'siigo/siigo.permisos.ts'), 'utf8'));
    expect(fuente).toMatch(/puedeEjecutar\(req\.user\.role, accion\)/);
    expect(fuente).toMatch(/ROLES_POR_ACCION/);
    expect(fuente).not.toMatch(/exigirFuncion|resolverPermisos|tieneFuncion/);
  });

  it('la medición cubre exactamente 6 directorios (3 + 3; `permisos/` salió con la HU #12084; `pesv/`, `drivers/`, `jornadas/` y `rum/` con la HU #13421; los ocho de operación con la HU #13422) y ninguno de los reconducidos', () => {
    const todos = { ...VALLA_AC4, ...VALLA_FUERA_DEL_ENUNCIADO };
    expect(Object.keys(todos)).toHaveLength(6);
    for (const d of ['pesv', 'drivers', 'jornadas', 'rum', 'maintenance', 'vehicles', 'fleet', 'rndc', 'rutas', 'liquidacion', 'finanzas', 'clients']) {
      expect(todos, d).not.toHaveProperty(d);
    }
    for (const d of Object.keys(todos)) {
      expect(d.startsWith('flito-') || d === 'tramites' || d === 'users' || d === 'permisos', d).toBe(false);
    }
  });
});
