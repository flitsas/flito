// HU #12084 (Feature #12072) — Mantenimiento de roles (CF-03, CF-04, CF-05) y guardado del cuadro
// rol × función (CF-02). Lo que la ruta no debe saber: transacciones, candados, invariante y auditoría.
//
// RN-A1 — Marcarle a un rol CON ENLACE funciones de un módulo que la frontera no le abre no lo saca de
//   ella: `guardiaFrontera` corre antes que `exigirFuncion` y no mira el conjunto. Aquí se GUARDA igual
//   (el administrador decide) y se AVISA con `funcionesAlcanzables(enlace)` (HU #12875, ADR-0024).
// RN-A8 — Un rol con usuarios asignados no se borra: 409 con el conteo. Y `es_sistema` (solo `admin`)
//   es candado aunque N = 0. Los dos motivos los produce `motivoNoBorrable`, la MISMA función que
//   alimenta `borrable`/`motivoNoBorrable` del listado: un solo texto para la pantalla y para el 409.
// RN-A10 — Cada escritura deja su lote en `permisos_auditoria` con `rolAfectadoCodigo`: del actor su
//   correo, del rol nada personal. Ni un nombre de usuario viaja en ninguna respuesta de este servicio.
//
// Decisiones del diseño (§2.3) que no están en el AC y conviene tener a la vista:
//   · `codigo` y `esSistema` no se editan por API (ADR-0015 §1 y §5); la ruta los rechaza con `.strict()`.
//   · `tipoEnlace` se cambia SOLO con 0 usuarios: los triggers de la 0178 revalidan al escribir `users`,
//     no al escribir `permisos_roles`, y cambiar el enlace de un rol con usuarios dejaría filas
//     incumplidoras que nadie detecta.
//   · El tipo interno/externo se RETIRÓ (HU #12875, AC6): ni se lee, ni se escribe, ni se devuelve.
//     Como el enlace se cambia solo con 0 usuarios, editar un rol no mueve la población administradora
//     (`tipo_enlace = 'ninguno'`, ADR-0022 modificado por ADR-0024) y `editarRol` no toma el invariante.
//   · `operaciones` está RESERVADO: sigue siendo etiqueta del tipo obsoleto `user_role` y ADR-0015 §2 lo
//     deja fuera de todo lo asignable. Sin esta guarda el panel lo resucitaría.
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  CrearRolInput, CuadroRol, EditarRolInput, RespuestaGuardarCuadro, RolCatalogo, TipoEnlace,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { permisosFunciones, permisosRoles, permisosRolFuncion, users } from '../../db/schema.js';
import {
  diffConjunto, mismoConjunto, registrarCambiosPermisos, type ActorAuditoria, type CambioAuditable,
} from '../../shared/historial/permisos-auditoria.js';
import { funcionesAlcanzables } from '../../shared/middleware/frontera-enlace.js';
import { enlaceConocido } from '../../shared/permisos-efectivos.js';
import { conSeguroAntiBloqueo } from '../../shared/permisos-anti-bloqueo.js';
import { esCodigoPg } from '../../shared/utils/pg-error.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Códigos que no se pueden crear. `operaciones`: ADR-0015 §Decisión 2 lo deja fuera de lo asignable. */
export const RESERVADOS: readonly string[] = ['operaciones'];

export const MENSAJE_FUERA_DEL_ENLACE =
  'El rol tiene enlace: la frontera solo le abre los módulos de ese enlace y estas funciones no tendrán efecto por HTTP';

// ── Errores de dominio: la ruta los mapea a 400 / 404 / 409 ─────────────────────────────────────

export class RolNoEncontradoError extends Error {
  constructor(public readonly codigo: string) { super(`No existe el rol «${codigo}»`); this.name = 'RolNoEncontradoError'; }
}

/** 409: el estado del rol no admite la operación (duplicado, sistema, usuarios asignados). */
export class RolConflictoError extends Error {
  constructor(mensaje: string, public readonly usuarios?: number) { super(mensaje); this.name = 'RolConflictoError'; }
}

/** 400: el código pedido está reservado. */
export class CodigoReservadoError extends Error {
  constructor(public readonly codigo: string) { super(`El código «${codigo}» está reservado`); this.name = 'CodigoReservadoError'; }
}

/** 400 con la lista: ninguna escritura ocurre. */
export class FuncionesInexistentesError extends Error {
  constructor(public readonly funciones: string[]) {
    super('Funciones inexistentes'); this.name = 'FuncionesInexistentesError';
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

/** `count(*)` de `users` con ese rol, activos o no: la FK `ON DELETE RESTRICT` cuenta todos. */
async function usuariosDelRol(ex: Pick<Tx, 'select'>, codigo: string): Promise<number> {
  const [fila] = await ex.select({ n: sql<number>`count(*)::int` }).from(users).where(eq(users.role, codigo));
  return Number(fila?.n ?? 0);
}

/**
 * El motivo por el que un rol NO se puede borrar, o `null` si se puede. Lo consumen el listado
 * (`borrable`/`motivoNoBorrable`) y el 409 de `borrarRol`: el texto es uno solo (RN-A8).
 */
export function motivoNoBorrable(rol: { esSistema: boolean }, usuarios: number): string | null {
  if (rol.esSistema) return 'rol del sistema';
  if (usuarios > 0) return `${usuarios} usuarios lo tienen asignado; reasígnalos primero`;
  return null;
}

type FilaRol = typeof permisosRoles.$inferSelect;

function aRolCatalogo(r: FilaRol, usuarios: number): RolCatalogo {
  const motivo = motivoNoBorrable(r, usuarios);
  return {
    codigo: r.codigo,
    nombre: r.nombre,
    descripcion: r.descripcion,
    tipoEnlace: r.tipoEnlace as TipoEnlace,
    esSistema: r.esSistema,
    activo: r.activo,
    usuarios,
    borrable: motivo === null,
    motivoNoBorrable: motivo,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

/** El cuadro de un rol, ordenado por código. */
async function funcionesDelRol(ex: Pick<Tx, 'select'>, codigo: string): Promise<string[]> {
  const filas = await ex.select({ codigo: permisosRolFuncion.funcionCodigo }).from(permisosRolFuncion)
    .where(eq(permisosRolFuncion.rolCodigo, codigo)).orderBy(asc(permisosRolFuncion.funcionCodigo));
  return filas.map((f) => f.codigo);
}

/** Los códigos de `funciones` que NO existen en `permisos_funciones`. Lectura, fuera de toda tx. */
export async function funcionesInexistentes(codigos: string[]): Promise<string[]> {
  if (codigos.length === 0) return [];
  const filas = await db.select({ codigo: permisosFunciones.codigo }).from(permisosFunciones)
    .where(inArray(permisosFunciones.codigo, codigos));
  const existen = new Set(filas.map((f) => f.codigo));
  return codigos.filter((c) => !existen.has(c));
}

/** Duplicados plegados y orden estable: el orden de llegada no es un cambio. */
const conjunto = (codigos: string[]): string[] => [...new Set(codigos)].sort();

// ── Lecturas ────────────────────────────────────────────────────────────────────────────────────

/** CF-03/CF-05: todos los roles con su conteo de usuarios y si se pueden borrar. `es_sistema` primero. */
export async function listarRoles(): Promise<RolCatalogo[]> {
  const roles = await db.select().from(permisosRoles)
    .orderBy(desc(permisosRoles.esSistema), asc(permisosRoles.codigo));
  const conteos = await db.select({ role: users.role, n: sql<number>`count(*)::int` }).from(users)
    .groupBy(users.role);
  const porRol = new Map(conteos.map((c) => [c.role, Number(c.n)]));
  return roles.map((r) => aRolCatalogo(r, porRol.get(r.codigo) ?? 0));
}

/** CF-02: el cuadro de un rol. */
export async function cuadroDe(codigo: string): Promise<CuadroRol> {
  const [rol] = await db.select({ codigo: permisosRoles.codigo, tipoEnlace: permisosRoles.tipoEnlace })
    .from(permisosRoles).where(eq(permisosRoles.codigo, codigo)).limit(1);
  if (!rol) throw new RolNoEncontradoError(codigo);
  return { codigo: rol.codigo, tipoEnlace: rol.tipoEnlace as TipoEnlace, funciones: await funcionesDelRol(db, codigo) };
}

// ── Escrituras ──────────────────────────────────────────────────────────────────────────────────

/**
 * CF-03. Transaccional: ni el rol ni parte del cuadro quedan escritos si algo falla. El duplicado lo
 * dice la PK (`23505`), no un «consultar y luego insertar»: dos POST simultáneos pasarían los dos la
 * consulta. `es_sistema` nace `false` y `activo` nace `true` (asignable de inmediato).
 */
export async function crearRol(input: CrearRolInput, actor: ActorAuditoria): Promise<RolCatalogo> {
  if (RESERVADOS.includes(input.codigo)) throw new CodigoReservadoError(input.codigo);
  const funciones = conjunto(input.funciones ?? []);
  const inexistentes = await funcionesInexistentes(funciones);
  if (inexistentes.length) throw new FuncionesInexistentesError(inexistentes);

  try {
    return await db.transaction(async (tx) => {
      const [rol] = await tx.insert(permisosRoles).values({
        codigo: input.codigo,
        nombre: input.nombre,
        descripcion: input.descripcion ?? null,
        tipoEnlace: input.tipoEnlace,
      }).returning();
      if (funciones.length) {
        await tx.insert(permisosRolFuncion).values(funciones.map((f) => ({ rolCodigo: input.codigo, funcionCodigo: f })));
      }
      const cambios: CambioAuditable[] = [
        { entidad: 'rol', accion: 'crear', campo: 'nombre', valorAntes: null, valorDespues: input.nombre, rolAfectadoCodigo: input.codigo },
        ...(input.descripcion != null
          ? [{ entidad: 'rol', accion: 'crear', campo: 'descripcion', valorAntes: null, valorDespues: input.descripcion, rolAfectadoCodigo: input.codigo } as CambioAuditable]
          : []),
        { entidad: 'rol', accion: 'crear', campo: 'tipo_enlace', valorAntes: null, valorDespues: input.tipoEnlace, rolAfectadoCodigo: input.codigo },
        { entidad: 'rol', accion: 'crear', campo: 'activo', valorAntes: null, valorDespues: true, rolAfectadoCodigo: input.codigo },
        ...(funciones.length
          ? [{ entidad: 'rol_funcion', accion: 'crear', campo: 'conjunto', valorAntes: null, valorDespues: { conjunto: funciones }, rolAfectadoCodigo: input.codigo } as CambioAuditable]
          : []),
      ];
      await registrarCambiosPermisos(tx, actor, cambios);
      return aRolCatalogo(rol!, 0);
    });
  } catch (e) {
    if (esCodigoPg(e, '23505')) throw new RolConflictoError(`Ya existe un rol con el código «${input.codigo}»`);
    throw e;
  }
}

export type ResultadoEditarRol = { estado: 'sin_cambios' } | { estado: 'ok'; rol: RolCatalogo; campos: string[] };

/** Columna auditable ↔ propiedad del cuerpo. */
const CAMPOS_ROL = [
  ['nombre', 'nombre'], ['descripcion', 'descripcion'], ['tipoEnlace', 'tipo_enlace'], ['activo', 'activo'],
] as const;

/**
 * CF-04. Bloquea la fila del rol, escribe solo lo que cambió y audita un par por campo. `tipoEnlace`
 * exige 0 usuarios (cabecera), así que ningún campo editable mueve la población administradora
 * (usuarios activos de roles con enlace `ninguno`, HU #12875): no hay invariante que comprobar y P no
 * se toma; el `FOR UPDATE` del rol va solo.
 */
export async function editarRol(codigo: string, cambios: EditarRolInput, actor: ActorAuditoria): Promise<ResultadoEditarRol> {
  const cuerpo = async (tx: Tx): Promise<ResultadoEditarRol> => {
    const [antes] = await tx.select().from(permisosRoles).where(eq(permisosRoles.codigo, codigo)).limit(1).for('update');
    if (!antes) throw new RolNoEncontradoError(codigo);

    const set: Partial<FilaRol> = {};
    const filas: CambioAuditable[] = [];
    for (const [prop, columna] of CAMPOS_ROL) {
      const nuevo = cambios[prop];
      if (nuevo === undefined || nuevo === antes[prop]) continue;
      (set as Record<string, unknown>)[prop] = nuevo;
      filas.push({
        entidad: 'rol', accion: 'editar', campo: columna,
        valorAntes: antes[prop] as string | boolean | null, valorDespues: nuevo, rolAfectadoCodigo: codigo,
      });
    }
    if (filas.length === 0) return { estado: 'sin_cambios' };

    const usuarios = await usuariosDelRol(tx, codigo);
    if (set.tipoEnlace !== undefined && usuarios > 0) {
      throw new RolConflictoError(`${usuarios} usuarios lo tienen asignado; el tipo de enlace se cambia sin usuarios`, usuarios);
    }

    set.updatedAt = new Date();
    const [despues] = await tx.update(permisosRoles).set(set).where(eq(permisosRoles.codigo, codigo)).returning();

    await registrarCambiosPermisos(tx, actor, filas);
    return { estado: 'ok', rol: aRolCatalogo(despues!, usuarios), campos: filas.map((f) => f.campo!) };
  };
  return db.transaction(async (tx) => cuerpo(tx));
}

/**
 * CF-05 / RN-A8. Dentro de la transacción y con la fila bloqueada: `es_sistema` → 409; N > 0 → 409
 * con N; luego el `DELETE` (la FK `ON DELETE CASCADE` se lleva el cuadro). TODO dentro del invariante,
 * y el invariante lo primero: la población administradora (P) se bloquea antes que la fila del rol,
 * en el mismo orden que `guardarCuadro` y que el `UPDATE users SET role` (db-review de la HU #12084:
 * `borrarRol('X')` contra `guardarCuadro('X')` con el rol primero era un `40P01` servido como 500).
 * Un `23503` que llegue a pesar del conteo (un alta concurrente tomó `KEY SHARE` sobre la fila) se
 * captura FUERA de la transacción —dentro estaría abortada— y responde el mismo 409 con N releído.
 * La auditoría es un par por campo con `valorDespues = null`: `ValorAuditable` no admite la fila
 * entera y una fila sin campo no respondería «qué se borró» (AC6).
 */
export async function borrarRol(codigo: string, actor: ActorAuditoria): Promise<void> {
  try {
    await db.transaction(async (tx) => conSeguroAntiBloqueo(tx, async () => {
      const [rol] = await tx.select().from(permisosRoles).where(eq(permisosRoles.codigo, codigo)).limit(1).for('update');
      if (!rol) throw new RolNoEncontradoError(codigo);
      const usuarios = await usuariosDelRol(tx, codigo);
      const motivo = motivoNoBorrable(rol, usuarios);
      if (motivo !== null) throw new RolConflictoError(motivo, usuarios);

      const cuadro = await funcionesDelRol(tx, codigo);
      await tx.delete(permisosRoles).where(eq(permisosRoles.codigo, codigo));

      const par = (campo: CambioAuditable['campo'], valorAntes: CambioAuditable['valorAntes']): CambioAuditable =>
        ({ entidad: 'rol', accion: 'borrar', campo, valorAntes, valorDespues: null, rolAfectadoCodigo: codigo });
      await registrarCambiosPermisos(tx, actor, [
        par('nombre', rol.nombre),
        par('descripcion', rol.descripcion),
        par('tipo_enlace', rol.tipoEnlace),
        par('activo', rol.activo),
        // Orden estable por código, como `diffConjunto`: el orden de lectura no es un dato.
        { ...par('conjunto', { conjunto: [...cuadro].sort() }), entidad: 'rol_funcion' },
      ]);
    }));
  } catch (e) {
    if (esCodigoPg(e, '23503')) {
      const n = await usuariosDelRol(db, codigo);
      throw new RolConflictoError(motivoNoBorrable({ esSistema: false }, Math.max(n, 1))!, n);
    }
    throw e;
  }
}

/**
 * CF-02 / RN-A1. Reescritura COMPLETA del cuadro (delete + insert, no diff: el diff ya lo calcula
 * `diffConjunto` para la auditoría). Los códigos se validan antes de abrir la transacción; la FK
 * queda como tercera capa. Todo dentro del invariante: vaciar el cuadro de `admin` con un solo
 * administrador responde 409 y nada queda escrito. Igual conjunto → sin escrituras ni auditoría.
 */
export async function guardarCuadro(codigo: string, pedidas: string[], actor: ActorAuditoria): Promise<RespuestaGuardarCuadro> {
  const despues = conjunto(pedidas);
  const inexistentes = await funcionesInexistentes(despues);
  if (inexistentes.length) throw new FuncionesInexistentesError(inexistentes);

  return db.transaction(async (tx) => conSeguroAntiBloqueo(tx, async (): Promise<RespuestaGuardarCuadro> => {
    const [rol] = await tx.select({ tipoEnlace: permisosRoles.tipoEnlace }).from(permisosRoles)
      .where(eq(permisosRoles.codigo, codigo)).limit(1).for('update');
    if (!rol) throw new RolNoEncontradoError(codigo);
    const antes = await funcionesDelRol(tx, codigo);
    const diff = diffConjunto(antes, despues);
    const d = diff.despues as { conjunto: string[]; concedidas: string[]; revocadas: string[] };

    if (!mismoConjunto(antes, despues)) {
      await tx.delete(permisosRolFuncion).where(eq(permisosRolFuncion.rolCodigo, codigo));
      if (despues.length) {
        await tx.insert(permisosRolFuncion).values(despues.map((f) => ({ rolCodigo: codigo, funcionCodigo: f })));
      }
      await registrarCambiosPermisos(tx, actor, [{
        entidad: 'rol_funcion', accion: 'editar', campo: 'conjunto',
        valorAntes: diff.antes, valorDespues: diff.despues, rolAfectadoCodigo: codigo,
      }]);
    }

    return { codigo, funciones: d.conjunto, concedidas: d.concedidas, revocadas: d.revocadas, aviso: avisoFueraDelEnlace(rol.tipoEnlace, despues) };
  }));
}

/**
 * RN-A1 (HU #12875): para un rol con enlace, las funciones de operación de módulos que la frontera no
 * le abre a ese enlace. Las `pagina.*` no cuentan: la frontera limita la API, no el menú. `ninguno` (o
 * un valor que el CHECK de la 0231 ya no admite) no lleva aviso: el aviso informa, no decide.
 */
export function avisoFueraDelEnlace(tipoEnlace: string, funciones: string[]): RespuestaGuardarCuadro['aviso'] {
  const enlace = enlaceConocido(tipoEnlace);
  if (enlace === null || enlace === 'ninguno') return null;
  const alcanzable = funcionesAlcanzables(enlace);
  const fuera = funciones.filter((f) => !f.startsWith('pagina.') && !alcanzable(f));
  if (fuera.length === 0) return null;
  return { tipo: 'fuera_del_enlace', tipoEnlace: enlace, mensaje: MENSAJE_FUERA_DEL_ENLACE, funciones: fuera };
}
