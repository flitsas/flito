// HU #12171 / ADR-0014 — El ESCRITOR del historial (`shared/historial/permisos-auditoria.ts`).
//
// Lo que se afirma aquí es el contrato del escritor, sin base y sin HTTP:
//   · una fila por cambio, todas con el MISMO `lote_id`, en la tabla `permisos_auditoria`;
//   · del ACTOR el correo, el rol, la IP y el agente; del TITULAR solo id y rol (AC4, RN-A10);
//   · `password` va SIEMPRE sin valores; `userId: null` ⇒ `origen: 'sistema'`;
//   · con la lista vacía no viaja a la base;
//   · NO se traga errores (mutación 5 del diseño): el rechazo del INSERT sube tal cual, y el fichero
//     no contiene `try` (comprobación estática: un `try/catch` añadido después se vería aquí).
//   · `CAMPOS_AUDITABLES` es EXACTAMENTE la lista del ADR: meter `email`, `name` o `password_hash`
//     pone esto en rojo antes que el CHECK de la base.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableName } from 'drizzle-orm';
import { CAMPOS_AUDITABLES, ENTIDADES_AUDITABLES, ACCIONES_AUDITABLES } from '@operaciones/shared-types';
import {
  actorDeRequest, diffConjunto, mismoConjunto, registrarCambioPermisos, registrarCambiosPermisos,
  type ActorAuditoria, type CambioAuditable, type Ejecutor,
} from '../../src/shared/historial/permisos-auditoria.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ACTOR: ActorAuditoria = { userId: 1, email: 'admin@flit.test', rol: 'admin', ip: '10.0.0.1', userAgent: 'vitest' };

/** Un ejecutor de mentira que recuerda a qué tabla y con qué filas se llamó a `insert().values()`. */
function ejecutorEspia(fallo?: Error) {
  const llamadas: { tabla: string; filas: Record<string, unknown>[] }[] = [];
  const insert = vi.fn((tabla: unknown) => ({
    values: (filas: Record<string, unknown>[]) => {
      llamadas.push({ tabla: getTableName(tabla as never), filas });
      return fallo ? Promise.reject(fallo) : Promise.resolve([]);
    },
  }));
  return { ex: { insert } as unknown as Ejecutor, llamadas, insert };
}

const cambioRol: CambioAuditable = {
  entidad: 'usuario', accion: 'editar', campo: 'role', valorAntes: 'proveedor', valorDespues: 'auditor',
  usuarioAfectado: { id: 47, rol: 'proveedor' },
};

describe('registrarCambiosPermisos — un acto, un lote, N filas', () => {
  it('escribe en permisos_auditoria una fila por cambio, todas con el mismo lote_id y el mismo actor', async () => {
    const { ex, llamadas } = ejecutorEspia();
    const d = diffConjunto(['soat'], ['soat', 'clients']);
    await registrarCambiosPermisos(ex, ACTOR, [
      cambioRol,
      { entidad: 'usuario', accion: 'editar', campo: 'allowed_pages', valorAntes: d.antes, valorDespues: d.despues, usuarioAfectado: { id: 47, rol: 'proveedor' } },
    ]);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.tabla).toBe('permisos_auditoria');
    const filas = llamadas[0]!.filas;
    expect(filas).toHaveLength(2);
    expect(new Set(filas.map((f) => f.loteId)).size).toBe(1);
    expect(filas[0]!.loteId).toMatch(/^[0-9a-f-]{36}$/);
    expect(filas[0]).toMatchObject({
      entidad: 'usuario', accion: 'editar', campo: 'role', valorAntes: 'proveedor', valorDespues: 'auditor',
      usuarioAfectadoId: 47, usuarioAfectadoRol: 'proveedor', rolAfectadoCodigo: null,
      actorUserId: 1, actorEmail: 'admin@flit.test', actorRol: 'admin', ipAddress: '10.0.0.1', userAgent: 'vitest',
      origen: 'usuario', motivo: null,
    });
    expect(filas[1]).toMatchObject({
      campo: 'allowed_pages',
      valorAntes: { conjunto: ['soat'] },
      valorDespues: { conjunto: ['clients', 'soat'], concedidas: ['clients'], revocadas: [] },
    });
  });

  it('AC4: de la fila no sale ni el correo, ni el nombre, ni el documento ni el hash del TITULAR; solo id y rol', async () => {
    const { ex, llamadas } = ejecutorEspia();
    await registrarCambioPermisos(ex, ACTOR, cambioRol);
    const fila = llamadas[0]!.filas[0]!;
    const claves = Object.keys(fila);
    // Lista CERRADA de columnas que el escritor rellena: cualquier columna nueva se declara aquí.
    expect(claves.sort()).toEqual([
      'accion', 'actorEmail', 'actorRol', 'actorUserId', 'campo', 'entidad', 'ipAddress', 'loteId', 'motivo',
      'origen', 'rolAfectadoCodigo', 'userAgent', 'usuarioAfectadoId', 'usuarioAfectadoRol', 'valorAntes', 'valorDespues',
    ]);
    for (const prohibida of ['email', 'name', 'username', 'documento', 'telefono', 'passwordHash', 'password_hash']) {
      expect(claves).not.toContain(prohibida);
    }
    // El correo que hay es el del ACTOR, y solo ese.
    expect(fila.actorEmail).toBe(ACTOR.email);
    expect(JSON.stringify(fila)).not.toContain('titular@');
  });

  it('`password` es un hecho sin valor: los dos lados en null', async () => {
    const { ex, llamadas } = ejecutorEspia();
    await registrarCambioPermisos(ex, ACTOR, {
      entidad: 'usuario', accion: 'editar', campo: 'password', valorAntes: null, valorDespues: null,
      usuarioAfectado: { id: 47, rol: 'proveedor' },
    });
    expect(llamadas[0]!.filas[0]).toMatchObject({ campo: 'password', valorAntes: null, valorDespues: null });
  });

  it('actor sin userId ⇒ origen `sistema` (un seed o un cron), no «se desconoce»', async () => {
    const { ex, llamadas } = ejecutorEspia();
    await registrarCambioPermisos(ex, { userId: null, email: null, rol: null }, {
      entidad: 'rol', accion: 'crear', campo: 'nombre', valorAntes: null, valorDespues: 'Gestor', rolAfectadoCodigo: 'gestor',
    });
    expect(llamadas[0]!.filas[0]).toMatchObject({
      origen: 'sistema', actorUserId: null, actorEmail: null, rolAfectadoCodigo: 'gestor', usuarioAfectadoId: null, usuarioAfectadoRol: null,
    });
  });

  it('con la lista vacía no viaja a la base', async () => {
    const { ex, insert } = ejecutorEspia();
    await registrarCambiosPermisos(ex, ACTOR, []);
    expect(insert).not.toHaveBeenCalled();
  });

  it('recorta el actor a los anchos de columna (correo 150, rol 40, ip 45, agente 500) sin fallar', async () => {
    const { ex, llamadas } = ejecutorEspia();
    await registrarCambioPermisos(ex, { userId: 1, email: 'a'.repeat(200), rol: 'r'.repeat(60), ip: '1'.repeat(60), userAgent: 'u'.repeat(600) }, cambioRol);
    const f = llamadas[0]!.filas[0]!;
    expect((f.actorEmail as string).length).toBe(150);
    expect((f.actorRol as string).length).toBe(40);
    expect((f.ipAddress as string).length).toBe(45);
    expect((f.userAgent as string).length).toBe(500);
  });
});

describe('mutación 5 — el escritor NO se traga el error: el cambio no se confirma', () => {
  it('si el INSERT rechaza, la promesa rechaza con ese mismo error', async () => {
    const { ex } = ejecutorEspia(new Error('permisos_auditoria: fuera de servicio'));
    await expect(registrarCambioPermisos(ex, ACTOR, cambioRol)).rejects.toThrow('permisos_auditoria: fuera de servicio');
  });

  it('el fichero no contiene try/catch ni una bandera de entorno que lo apague (a diferencia de la bitácora de 403)', () => {
    const src = readFileSync(path.resolve(__dirname, '../../src/shared/historial/permisos-auditoria.ts'), 'utf8')
      .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/\btry\s*\{/);
    expect(src).not.toMatch(/\.catch\(/);
    expect(src).not.toMatch(/process\.env/);
  });
});

describe('diffConjunto / mismoConjunto', () => {
  it('el después trae el conjunto completo, lo concedido y lo revocado, ordenados', () => {
    expect(diffConjunto(['b', 'a', 'c'], ['c', 'd'])).toEqual({
      antes: { conjunto: ['a', 'b', 'c'] },
      despues: { conjunto: ['c', 'd'], concedidas: ['d'], revocadas: ['a', 'b'] },
    });
  });

  it('el orden no es un cambio; el largo y el contenido sí', () => {
    expect(mismoConjunto(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(mismoConjunto(['a'], ['a', 'a'])).toBe(false);
    expect(mismoConjunto(['a', 'b'], ['a', 'c'])).toBe(false);
  });
});

describe('actorDeRequest — el actor sale del JWT verificado, la IP del primer salto', () => {
  it('copia sub/username/role de req.user; x-forwarded-for manda sobre req.ip', () => {
    const req = {
      user: { sub: 7, username: 'ana@flit.test', role: 'admin' },
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'UA' },
      ip: '10.0.0.1',
    } as never;
    expect(actorDeRequest(req)).toEqual({ userId: 7, email: 'ana@flit.test', rol: 'admin', ip: '203.0.113.9', userAgent: 'UA' });
  });

  it('sin usuario autenticado el actor es «sistema» (userId null)', () => {
    const req = { headers: {}, ip: undefined } as never;
    expect(actorDeRequest(req)).toEqual({ userId: null, email: null, rol: null, ip: null, userAgent: null });
  });
});

describe('la lista blanca de shared-types es EXACTAMENTE la del ADR-0014 (RN-A10)', () => {
  it('CAMPOS_AUDITABLES, ENTIDADES y ACCIONES: fijadas; ningún dato personal del titular es un campo', () => {
    expect(CAMPOS_AUDITABLES).toEqual({
      usuario: ['role', 'active', 'deleted_at', 'password', 'funciones', 'allowed_pages',
        'organismos_codigos', 'compania_id', 'flito_proveedor_soat_id', 'transito_codigo'],
      rol: ['nombre', 'descripcion', 'tipo_enlace', 'tipo_principal', 'activo'],
      rol_funcion: ['conjunto'],
      usuario_funcion: ['conjunto'],
    });
    expect(ENTIDADES_AUDITABLES).toEqual(['usuario', 'rol', 'rol_funcion', 'usuario_funcion']);
    expect(ACCIONES_AUDITABLES).toEqual(['crear', 'editar', 'borrar', 'baja', 'reactivar', 'activar', 'desactivar']);
    const todos = Object.values(CAMPOS_AUDITABLES).flat() as string[];
    for (const pii of ['email', 'name', 'username', 'password_hash', 'passwordHash', 'documento', 'telefono', 'phone']) {
      expect(todos).not.toContain(pii);
    }
  });
});
