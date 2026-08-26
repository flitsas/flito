// Siigo — la tabla de quién puede qué (HU #11342, AC1, AC2 y AC4).
//
// Estos tests son la MITAD del punto de extensión: la HU promete que cambiar quién emite es editar
// `ROLES_POR_ACCION` y su prueba. Esa prueba es esta. Si mañana se decide que solo `admin` emite,
// aquí se ve el cambio completo y no hace falta abrir ningún router.
//
// La frontera HTTP se prueba aparte, en siigo-permisos.routes.test.ts.

import { describe, it, expect, vi } from 'vitest';
import {
  ACCIONES_SIIGO, ROLES_POR_ACCION, esAccionDeOperacion, esAccionSiigo,
  motivoDenegacion, puedeEjecutar, rolesDe,
} from '../../src/modules/siigo/siigo.permisos.js';
import type { UserRole } from '@operaciones/shared-types';

// Importar el módulo arrastra la bitácora → db/client. Se mockea para no abrir conexión real.
vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn(), transaction: vi.fn() },
  getPoolStats: vi.fn(),
}));

const ACCIONES_DE_OPERACION = ACCIONES_SIIGO.filter((a) => a !== 'consultar');

describe('AC1 — una sola tabla decide, y su contenido es el de hoy', () => {
  it('escritura = admin + financiera; lectura añade auditor', () => {
    // Heredado de finanzas.routes.ts y flito-liquidacion.routes.ts: el dinero de FLITO ya se opera
    // así. Este es el valor conservador mientras la pregunta 16 del diseño sigue abierta.
    for (const accion of ACCIONES_DE_OPERACION) {
      expect([...ROLES_POR_ACCION[accion]].sort()).toEqual(['admin', 'financiera']);
    }
    expect([...ROLES_POR_ACCION.consultar].sort()).toEqual(['admin', 'auditor', 'financiera']);
  });

  it('toda acción declarada tiene al menos un rol: ninguna queda muerta por descuido', () => {
    for (const accion of ACCIONES_SIIGO) {
      expect(ROLES_POR_ACCION[accion].length).toBeGreaterThan(0);
    }
  });

  it('ningún otro rol del sistema entra a facturación electrónica', async () => {
    const { USER_ROLES } = await import('@operaciones/shared-types');
    const permitidos = new Set<UserRole>(['admin', 'financiera', 'auditor']);
    for (const role of USER_ROLES) {
      if (permitidos.has(role)) continue;
      for (const accion of ACCIONES_SIIGO) {
        expect(puedeEjecutar(role, accion)).toBe(false);
      }
    }
  });
});

describe('AC2 — las acciones se declaran aunque su ruta no exista todavía', () => {
  it('emitir, corregir y anular ya tienen rol asignado aunque su flujo sea de otra Feature', () => {
    for (const accion of ['emitir', 'corregir', 'anular'] as const) {
      expect(esAccionSiigo(accion)).toBe(true);
      expect(puedeEjecutar('financiera', accion)).toBe(true);
      expect(puedeEjecutar('admin', accion)).toBe(true);
    }
  });

  it('el catálogo cubre las siete acciones de la HU más la anulación', () => {
    expect([...ACCIONES_SIIGO].sort()).toEqual([
      'anular', 'consultar', 'corregir', 'emitir',
      'marcar_fallido', 'reactivar', 'reenviar_correo', 'reintentar',
    ]);
  });

  it('una acción NO declarada se niega por defecto, también al admin', () => {
    // Lo importante no es que «devuelva false»: es que un nombre mal escrito en una ruta futura
    // produzca un 403 evidente en vez de una puerta abierta.
    expect(rolesDe('emitr')).toEqual([]);
    expect(puedeEjecutar('admin', 'emitr')).toBe(false);
    expect(puedeEjecutar('admin', 'borrar_todo')).toBe(false);
    expect(puedeEjecutar('admin', '')).toBe(false);
  });

  it('sin rol —petición sin autenticar— no se puede nada', () => {
    expect(puedeEjecutar(undefined, 'consultar')).toBe(false);
    expect(puedeEjecutar(null, 'emitir')).toBe(false);
  });
});

describe('AC4 — ver y operar no son el mismo permiso', () => {
  it('auditor consulta todo pero no ejecuta ninguna acción de operación', () => {
    expect(puedeEjecutar('auditor', 'consultar')).toBe(true);
    for (const accion of ACCIONES_DE_OPERACION) {
      expect(puedeEjecutar('auditor', accion)).toBe(false);
    }
  });

  it('la negativa explica que es una acción de operación, no un fallo', () => {
    const motivo = motivoDenegacion('reintentar');
    expect(motivo).toContain('acción de operación');
    expect(motivo).toContain('historial');
  });

  it('una acción desconocida se explica distinto: es un error de la aplicación que llama', () => {
    expect(motivoDenegacion('emitr')).toContain('no reconocida');
  });

  it('`consultar` no cuenta como operación y lo desconocido tampoco', () => {
    expect(esAccionDeOperacion('consultar')).toBe(false);
    expect(esAccionDeOperacion('emitir')).toBe(true);
    expect(esAccionDeOperacion('emitr')).toBe(false);
  });
});
