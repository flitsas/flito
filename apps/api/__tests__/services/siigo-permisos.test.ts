// Siigo — quién puede qué (HU #11342, AC1, AC2 y AC4; motor desde la HU #13423).
//
// Desde la HU #13423 (Épica #13411) no hay tabla de roles por acción: cada acción es la función del
// motor `siigo.factura.<accion>`, y su reparto de partida —el que la 0230 siembra y el que `testToken`
// da por rol— sale de la foto del catálogo. Estos tests fijan ese reparto: es el mismo que tenía la
// tabla retirada (escritura = admin + financiera; lectura añade auditor). Cambiar quién emite es
// repartir `siigo.factura.emitir` desde el panel; aquí se ve si alguien cambia la partida.
//
// La frontera HTTP se prueba aparte, en siigo-permisos.routes.test.ts.

import { describe, it, expect, vi } from 'vitest';
import {
  ACCIONES_SIIGO, esAccionDeOperacion, esAccionSiigo, motivoDenegacion,
} from '../../src/modules/siigo/siigo.permisos.js';
import { catalogoCompleto } from '../../src/modules/permisos/catalogo.js';

// Importar el módulo arrastra la bitácora → db/client. Se mockea para no abrir conexión real.
vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn(), transaction: vi.fn() },
  getPoolStats: vi.fn(),
}));

const ACCIONES_DE_OPERACION = ACCIONES_SIIGO.filter((a) => a !== 'consultar');
const CATALOGO = catalogoCompleto();
/** Los roles de partida de una acción: los de su función `siigo.factura.<accion>` en la foto. */
const rolesDe = (accion: string) => [...(CATALOGO.find((f) => f.codigo === `siigo.factura.${accion}`)?.roles ?? [])].sort();
const puedeDePartida = (rol: string, accion: string) => rolesDe(accion).includes(rol);

describe('AC1 — una función por acción, con el reparto que tenía la tabla retirada', () => {
  it('escritura = admin + financiera; lectura añade auditor', () => {
    // Heredado de finanzas.routes.ts y flito-liquidacion.routes.ts: el dinero de FLITO ya se opera
    // así. Este es el valor conservador mientras la pregunta 16 del diseño sigue abierta.
    for (const accion of ACCIONES_DE_OPERACION) {
      expect(rolesDe(accion), accion).toEqual(['admin', 'financiera']);
    }
    expect(rolesDe('consultar')).toEqual(['admin', 'auditor', 'financiera']);
  });

  it('toda acción declarada tiene su función en el catálogo, con al menos un rol: ninguna queda muerta por descuido', () => {
    for (const accion of ACCIONES_SIIGO) {
      expect(rolesDe(accion).length, accion).toBeGreaterThan(0);
    }
  });

  it('ningún otro rol del sistema entra a facturación electrónica', async () => {
    const { USER_ROLES } = await import('@operaciones/shared-types');
    const permitidos = new Set<string>(['admin', 'financiera', 'auditor']);
    for (const role of USER_ROLES) {
      if (permitidos.has(role)) continue;
      for (const accion of ACCIONES_SIIGO) {
        expect(puedeDePartida(role, accion), `${role} ${accion}`).toBe(false);
      }
    }
  });
});

describe('AC2 — las acciones se declaran aunque su ruta no exista todavía', () => {
  it('emitir, corregir y anular ya tienen rol asignado aunque su flujo sea de otra Feature', () => {
    for (const accion of ['emitir', 'corregir', 'anular'] as const) {
      expect(esAccionSiigo(accion)).toBe(true);
      expect(puedeDePartida('financiera', accion)).toBe(true);
      expect(puedeDePartida('admin', accion)).toBe(true);
    }
  });

  it('el catálogo cubre las siete acciones de la HU más la anulación', () => {
    expect([...ACCIONES_SIIGO].sort()).toEqual([
      'anular', 'consultar', 'corregir', 'emitir',
      'marcar_fallido', 'reactivar', 'reenviar_correo', 'reintentar',
    ]);
  });

  it('una acción NO declarada no tiene función: nadie la tiene, tampoco el admin', () => {
    // Lo importante es que un nombre mal escrito en una ruta futura produzca un 403 evidente en vez
    // de una puerta abierta (el tipo `AccionSiigo` ya lo impide en compilación).
    expect(rolesDe('emitr')).toEqual([]);
    expect(puedeDePartida('admin', 'borrar_todo')).toBe(false);
    expect(esAccionSiigo('emitr')).toBe(false);
  });

  it('las ocho funciones son exactamente las de las ocho acciones', () => {
    const siigoFactura = CATALOGO.filter((f) => f.codigo.startsWith('siigo.factura.')).map((f) => f.codigo).sort();
    expect(siigoFactura).toEqual(ACCIONES_SIIGO.map((a) => `siigo.factura.${a}`).sort());
  });
});

describe('AC4 — ver y operar no son el mismo permiso', () => {
  it('auditor consulta todo pero no ejecuta ninguna acción de operación', () => {
    expect(puedeDePartida('auditor', 'consultar')).toBe(true);
    for (const accion of ACCIONES_DE_OPERACION) {
      expect(puedeDePartida('auditor', accion)).toBe(false);
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
