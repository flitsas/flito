// HU #14332 (Feature #14324, ADR-0039 §4.1, §4.2 y §7.1) — Crear, editar y consultar proveedores con sus servicios.
// Módulo FLITO `flito-parametrizacion`, montado en `/api/flito/parametrizacion/proveedores`. Habla con la identidad única
// `flito_proveedores` y sus perfiles; las rutas `proveedores-soat` y `proveedores-logistica` conviven hasta F5.
//
// Reglas:
//   · RN-PROVG-1 (R2, R7) — Crear exige al menos un servicio. Los datos de SOAT solo se aceptan si el servicio está pedido
//       o existe, y son opcionales: lo que no viene toma el valor por defecto de la tabla.
//   · RN-PROVG-2 (R8) — NIT y nombre únicos entre vigentes. El NIT se compara sin dígito de verificación y el nombre con
//       la normalización del índice único del padre. Un 23505 se traduce a 409 sin leer el DETAIL, que trae el NIT.
//   · RN-PROVG-3 (R9) — Crear y editar `generales` exigen el bloque completo (lo valida la ruta). La edición vive en
//       `flito-proveedores-edicion.service.ts`.
//   · RN-PROVG-4 — Edición simultánea: `versionEsperada` obligatoria, con `FOR UPDATE` sobre el padre. La versión solo
//       tiene que cambiar: los triggers de transición pueden subirla 2 en una misma baja (ADR-0039 §16.8b).
//   · RN-PROVG-5 (R21) — Padre y perfiles se escriben en la misma transacción y siempre primero el padre: su trigger baja
//       nombre, NIT, contacto y teléfono a los perfiles vigentes.
//   · RN-PROVG-6 (R11) — Selector: activos, vigentes y con el perfil del servicio vivo.
import { and, asc, count, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import {
  CODIGO_PROVEEDOR_EDITADO_POR_OTRO, MENSAJE_PROVEEDOR_EDITADO_POR_OTRO, MENSAJE_SIN_SERVICIO, SERVICIOS_PROVEEDOR,
  type CrearProveedorBody, type ProveedorDetalleDto, type ProveedorGeneralesBody,
  type ProveedorListaItemDto, type ProveedorSelectorItemDto, type ProveedorSoatBody, type ServicioProveedor,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients, flitoProveedores, flitoProveedoresLogistica, flitoProveedoresSoat } from '../../db/schema.js';
import type { ActorAuditoria } from '../../shared/historial/permisos-auditoria.js';
import { clienteVigente } from '../clients/cliente-operable.js';
import { entradasDeCambios, registrarAuditoriaProveedor, type EntradaAuditoriaProveedor } from './flito-proveedores-auditoria.js';

export type TxProveedor = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type EjecutorProveedor = typeof db | TxProveedor;
export type FilaProveedor = typeof flitoProveedores.$inferSelect;

export class ProveedorNoEncontradoError extends Error {
  constructor() { super('Proveedor no encontrado'); this.name = 'ProveedorNoEncontradoError'; }
}
/** 422: la petición no marca ningún servicio, o intenta quitar el último (R2). */
export class ProveedorSinServicioError extends Error {
  constructor() { super(MENSAJE_SIN_SERVICIO); this.name = 'ProveedorSinServicioError'; }
}
/** 422: datos de SOAT sin el servicio (R7). */
export class DatosSoatInvalidosError extends Error {
  constructor(message: string) { super(message); this.name = 'DatosSoatInvalidosError'; }
}
/** 409: otro usuario guardó primero (criterio de edición simultánea). */
export class ProveedorEditadoPorOtroError extends Error {
  readonly code = CODIGO_PROVEEDOR_EDITADO_POR_OTRO;
  constructor() { super(MENSAJE_PROVEEDOR_EDITADO_POR_OTRO); this.name = 'ProveedorEditadoPorOtroError'; }
}
/** 409: el NIT o el nombre ya los tiene otro proveedor vigente (R8). */
export class ProveedorDuplicadoError extends Error {
  constructor(message: string, readonly campo: 'nit' | 'nombre' | null) { super(message); this.name = 'ProveedorDuplicadoError'; }
}

/** 422: faltan datos generales de un proveedor al que se le agrega un servicio (cuenta como editar). */
export class GeneralesIncompletosError extends Error {
  constructor(readonly campos: readonly string[]) {
    super(`Complete los datos generales del proveedor: ${campos.join(', ')}`); this.name = 'GeneralesIncompletosError';
  }
}

export const MENSAJE_SOAT_SIN_SERVICIO = 'Los datos de SOAT solo se aceptan si el proveedor presta ese servicio.';

const mensajeNitDuplicado = (nombre: string) => `Ya existe un proveedor con ese NIT: ${nombre}`;
const mensajeNombreDuplicado = (nombre: string) => `Ya existe un proveedor con ese nombre: ${nombre}`;

const INDICES_DE_NIT: ReadonlySet<string> = new Set(['uq_flito_proveedores_nit_vivo', 'uq_flito_proveedores_logistica_nit']);

const nombreNormalizado = (valor: unknown) => sql`lower(btrim(regexp_replace(${valor}, '\\s+', ' ', 'g')))`;
const nitSinVerificacion = (valor: unknown) => sql`split_part(${valor}, '-', 1)`;

const CAMPOS_GENERALES = ['nombre', 'nit', 'telefono', 'correo', 'direccion', 'ciudad', 'contacto'] as const;
type CampoGeneral = (typeof CAMPOS_GENERALES)[number];

/** R9: un proveedor migrado puede tener los datos generales vacíos hasta que alguien los edite. */
export function generalesFaltantes(p: Pick<FilaProveedor, CampoGeneral>): CampoGeneral[] {
  return CAMPOS_GENERALES.filter((c) => (p[c] ?? '').trim() === '');
}

async function otroConNit(exec: EjecutorProveedor, nit: string, excluirId?: string): Promise<string | null> {
  const [f] = await exec.select({ nombre: flitoProveedores.nombre }).from(flitoProveedores).where(and(
    isNull(flitoProveedores.deletedAt), isNotNull(flitoProveedores.nit),
    sql`${nitSinVerificacion(flitoProveedores.nit)} = ${nitSinVerificacion(sql`${nit}::text`)}`,
    excluirId === undefined ? undefined : ne(flitoProveedores.id, excluirId),
  )).limit(1);
  return f?.nombre ?? null;
}

async function otroConNombre(exec: EjecutorProveedor, nombre: string, excluirId?: string): Promise<string | null> {
  const [f] = await exec.select({ nombre: flitoProveedores.nombre }).from(flitoProveedores).where(and(
    isNull(flitoProveedores.deletedAt),
    sql`${nombreNormalizado(flitoProveedores.nombre)} = ${nombreNormalizado(sql`${nombre}::text`)}`,
    excluirId === undefined ? undefined : ne(flitoProveedores.id, excluirId),
  )).limit(1);
  return f?.nombre ?? null;
}

/** RN-PROVG-2. La validación previa da el mensaje con el nombre; el índice cubre la carrera. */
export async function exigirUnicos(exec: EjecutorProveedor, g: Pick<ProveedorGeneralesBody, 'nit' | 'nombre'>, excluirId?: string): Promise<void> {
  const conNit = await otroConNit(exec, g.nit, excluirId);
  if (conNit !== null) throw new ProveedorDuplicadoError(mensajeNitDuplicado(conNit), 'nit');
  const conNombre = await otroConNombre(exec, g.nombre, excluirId);
  if (conNombre !== null) throw new ProveedorDuplicadoError(mensajeNombreDuplicado(conNombre), 'nombre');
}

/** La restricción de un 23505, si lo es. Nunca lee `detail`, que trae el NIT. `undefined` = no es un 23505. */
function restriccionDeUnicidad(e: unknown): string | null | undefined {
  for (let x: unknown = e, i = 0; x && typeof x === 'object' && i < 3; x = (x as { cause?: unknown }).cause, i++) {
    const pg = x as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
    if (pg.code === '23505') return String(pg.constraint_name ?? pg.constraint ?? '') || null;
  }
  return undefined;
}

/**
 * Ejecuta una escritura y traduce la carrera de unicidad a 409 (RN-PROVG-2). El error original no sale de aquí: su DETAIL
 * trae el NIT y terminaría en el log. Vale para el padre y para los índices de los perfiles a los que baja el trigger.
 */
export async function conUnicidadTraducida<T>(g: Pick<ProveedorGeneralesBody, 'nit' | 'nombre'> | null, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const restriccion = restriccionDeUnicidad(e);
    if (restriccion === undefined) throw e;
    if (g !== null && restriccion !== null && INDICES_DE_NIT.has(restriccion)) {
      const nombre = await otroConNit(db, g.nit);
      throw new ProveedorDuplicadoError(mensajeNitDuplicado(nombre ?? 'otro proveedor'), 'nit');
    }
    if (g !== null) {
      const nombre = await otroConNombre(db, g.nombre);
      throw new ProveedorDuplicadoError(mensajeNombreDuplicado(nombre ?? g.nombre), 'nombre');
    }
    throw new ProveedorDuplicadoError('Ya existe otro proveedor vigente con ese nombre o NIT.', null);
  }
}

/** Un proveedor eliminado conserva su historial: solo el inexistente responde 404 al consultarlo. */
export async function existeProveedor(id: string): Promise<boolean> {
  const [p] = await db.select({ id: flitoProveedores.id }).from(flitoProveedores).where(eq(flitoProveedores.id, id)).limit(1);
  return p !== undefined;
}

/** Bloquea el padre vigente: toda escritura de proveedor pasa por aquí antes de leer nada más. */
export async function bloquearProveedorVigente(tx: TxProveedor, id: string): Promise<FilaProveedor> {
  const [p] = await tx.select().from(flitoProveedores)
    .where(and(eq(flitoProveedores.id, id), isNull(flitoProveedores.deletedAt))).for('update').limit(1);
  if (p === undefined) throw new ProveedorNoEncontradoError();
  return p;
}

export function exigirVersion(p: Pick<FilaProveedor, 'version'>, versionEsperada: number): void {
  if (p.version !== versionEsperada) throw new ProveedorEditadoPorOtroError();
}

/** Lo que la lista necesita de los perfiles vivos y las compañías, por proveedor. */
interface ContextoLista {
  servicios: Map<string, ServicioProveedor[]>;
  soat: Map<string, { umbralOcr: string | null; slaHoras: number | null }>;
  companias: Record<ServicioProveedor, Map<string, number>>;
}

const COLUMNA_COMPANIA_POR_SERVICIO = {
  soat: clients.flitoProveedorSoatSinTramiteId,
  logistica: clients.flitoProveedorLogisticaId,
} as const;

async function companiasPorProveedor(exec: EjecutorProveedor, servicio: ServicioProveedor, id?: string): Promise<Map<string, number>> {
  const columna = COLUMNA_COMPANIA_POR_SERVICIO[servicio];
  const filas = await exec.select({ id: columna, total: count() }).from(clients)
    .where(and(isNotNull(columna), clienteVigente(), id === undefined ? undefined : eq(columna, id))).groupBy(columna);
  return new Map(filas.map((f) => [f.id as string, Number(f.total)]));
}

/** Con `id`, solo ese proveedor; sin `id`, todos. Los servicios salen en el orden de `SERVICIOS_PROVEEDOR`. */
async function contextoLista(exec: EjecutorProveedor, id?: string): Promise<ContextoLista> {
  const [soat, logistica, companiasSoat, companiasLogistica] = await Promise.all([
    exec.select({ id: flitoProveedoresSoat.id, umbralOcr: flitoProveedoresSoat.umbralOcr, slaHoras: flitoProveedoresSoat.slaHoras })
      .from(flitoProveedoresSoat)
      .where(and(isNull(flitoProveedoresSoat.deletedAt), id === undefined ? undefined : eq(flitoProveedoresSoat.id, id))),
    exec.select({ id: flitoProveedoresLogistica.id }).from(flitoProveedoresLogistica)
      .where(and(isNull(flitoProveedoresLogistica.deletedAt), id === undefined ? undefined : eq(flitoProveedoresLogistica.id, id))),
    companiasPorProveedor(exec, 'soat', id),
    companiasPorProveedor(exec, 'logistica', id),
  ]);
  const conSoat = new Set(soat.map((f) => f.id));
  const conLogistica = new Set(logistica.map((f) => f.id));
  const servicios = new Map<string, ServicioProveedor[]>();
  for (const pid of new Set([...conSoat, ...conLogistica])) {
    servicios.set(pid, SERVICIOS_PROVEEDOR.filter((s) => (s === 'soat' ? conSoat : conLogistica).has(pid)));
  }
  return {
    servicios,
    soat: new Map(soat.map((f) => [f.id, { umbralOcr: f.umbralOcr, slaHoras: f.slaHoras }])),
    companias: { soat: companiasSoat, logistica: companiasLogistica },
  };
}

export async function serviciosDeProveedor(exec: EjecutorProveedor, id: string): Promise<ServicioProveedor[]> {
  const [soat, logistica] = await Promise.all([
    exec.select({ id: flitoProveedoresSoat.id }).from(flitoProveedoresSoat)
      .where(and(eq(flitoProveedoresSoat.id, id), isNull(flitoProveedoresSoat.deletedAt))),
    exec.select({ id: flitoProveedoresLogistica.id }).from(flitoProveedoresLogistica)
      .where(and(eq(flitoProveedoresLogistica.id, id), isNull(flitoProveedoresLogistica.deletedAt))),
  ]);
  return SERVICIOS_PROVEEDOR.filter((s) => (s === 'soat' ? soat : logistica).length > 0);
}

function itemDeLista(p: FilaProveedor, c: ContextoLista): ProveedorListaItemDto {
  const servicios = c.servicios.get(p.id) ?? [];
  const soat = c.soat.get(p.id);
  return {
    id: p.id,
    nombre: p.nombre,
    nit: p.nit,
    servicios,
    activo: p.activo,
    companiasPorServicio: Object.fromEntries(servicios.map((s) => [s, c.companias[s].get(p.id) ?? 0])),
    datosCompletos: generalesFaltantes(p).length === 0,
    umbralOcr: soat?.umbralOcr == null ? null : Number(soat.umbralOcr),
    slaHoras: soat?.slaHoras ?? null,
    version: p.version,
  };
}

export interface FiltroListaProveedores { servicio?: ServicioProveedor; activo?: boolean }

/** ADR-0039 §7.1. Sin teléfono, correo, dirección ni contacto. */
export async function listarProveedores(filtro: FiltroListaProveedores = {}): Promise<ProveedorListaItemDto[]> {
  const [padres, contexto] = await Promise.all([
    db.select().from(flitoProveedores).where(and(
      isNull(flitoProveedores.deletedAt),
      filtro.activo === undefined ? undefined : eq(flitoProveedores.activo, filtro.activo),
    )).orderBy(asc(flitoProveedores.nombre)),
    contextoLista(db),
  ]);
  return padres
    .map((p) => itemDeLista(p, contexto))
    .filter((p) => filtro.servicio === undefined || p.servicios.includes(filtro.servicio));
}

export async function itemDeProveedor(exec: EjecutorProveedor, p: FilaProveedor): Promise<ProveedorListaItemDto> {
  return itemDeLista(p, await contextoLista(exec, p.id));
}

/** RN-PROVG-6. */
export async function selectorProveedores(servicio: ServicioProveedor): Promise<ProveedorSelectorItemDto[]> {
  const base = { id: flitoProveedores.id, nombre: flitoProveedores.nombre };
  const vigenteYActivo = and(isNull(flitoProveedores.deletedAt), eq(flitoProveedores.activo, true));
  if (servicio === 'soat') {
    return db.select(base).from(flitoProveedores)
      .innerJoin(flitoProveedoresSoat, and(eq(flitoProveedoresSoat.id, flitoProveedores.id), isNull(flitoProveedoresSoat.deletedAt)))
      .where(vigenteYActivo).orderBy(asc(flitoProveedores.nombre));
  }
  return db.select(base).from(flitoProveedores)
    .innerJoin(flitoProveedoresLogistica, and(eq(flitoProveedoresLogistica.id, flitoProveedores.id), isNull(flitoProveedoresLogistica.deletedAt)))
    .where(vigenteYActivo).orderBy(asc(flitoProveedores.nombre));
}

/** Para atar usuarios a un proveedor: activos y vigentes, con cualquier servicio. */
export async function proveedoresAsignablesAUsuario(): Promise<ProveedorSelectorItemDto[]> {
  return db.select({ id: flitoProveedores.id, nombre: flitoProveedores.nombre }).from(flitoProveedores)
    .where(and(
      isNull(flitoProveedores.deletedAt), eq(flitoProveedores.activo, true),
      sql`EXISTS (SELECT 1 FROM flito_proveedor_servicios_v v WHERE v.proveedor_id = ${flitoProveedores.id})`,
    )).orderBy(asc(flitoProveedores.nombre));
}

/** Con datos personales: la ruta registra el acceso en `pii_access_log`. Lanza 404 si no existe o está eliminado. */
export async function detalleProveedor(id: string): Promise<ProveedorDetalleDto> {
  const [p] = await db.select().from(flitoProveedores)
    .where(and(eq(flitoProveedores.id, id), isNull(flitoProveedores.deletedAt))).limit(1);
  if (p === undefined) throw new ProveedorNoEncontradoError();
  const [item, [soat]] = await Promise.all([
    itemDeProveedor(db, p),
    db.select().from(flitoProveedoresSoat)
      .where(and(eq(flitoProveedoresSoat.id, id), isNull(flitoProveedoresSoat.deletedAt))).limit(1),
  ]);
  return {
    ...item,
    telefono: p.telefono, correo: p.correo, direccion: p.direccion, ciudad: p.ciudad, contacto: p.contacto,
    soat: soat === undefined ? null : {
      estrategia: soat.estrategia,
      umbralOcr: soat.umbralOcr === null ? null : Number(soat.umbralOcr),
      slaHoras: soat.slaHoras,
    },
  };
}

/** Los siete datos como los compara la auditoría. */
export const generalesDe = (p: Pick<FilaProveedor, CampoGeneral>): Record<CampoGeneral, string | null> => ({
  nombre: p.nombre, nit: p.nit, telefono: p.telefono, correo: p.correo, direccion: p.direccion, ciudad: p.ciudad, contacto: p.contacto,
});

/** Solo lo que vino en la petición: lo demás queda con el valor por defecto o el que el perfil ya tenía. */
export function entradasDeSoat(accion: 'crear' | 'servicio_agregado', s: ProveedorSoatBody): EntradaAuditoriaProveedor[] {
  return [
    ...(s.estrategia !== undefined ? [{ accion, campo: 'estrategia' as const, despues: s.estrategia }] : []),
    ...(s.umbralOcr != null ? [{ accion, campo: 'umbral_ocr' as const, despues: String(s.umbralOcr) }] : []),
    ...(s.slaHoras != null ? [{ accion, campo: 'sla_horas' as const, despues: String(s.slaHoras) }] : []),
  ];
}

/** Las columnas del perfil de SOAT que trae la petición. `undefined` no se escribe. */
export function columnasDeSoat(s: ProveedorSoatBody): Partial<typeof flitoProveedoresSoat.$inferInsert> {
  return {
    ...(s.estrategia !== undefined ? { estrategia: s.estrategia } : {}),
    ...(s.umbralOcr !== undefined ? { umbralOcr: s.umbralOcr === null ? null : String(s.umbralOcr) } : {}),
    ...(s.slaHoras !== undefined ? { slaHoras: s.slaHoras } : {}),
  };
}

/** RN-PROVG-1, RN-PROVG-5. Una identidad, un perfil por servicio, y los datos de SOAT solo en su perfil. */
export async function crearProveedor(datos: CrearProveedorBody, actor: ActorAuditoria): Promise<ProveedorListaItemDto> {
  const { generales: g, soat } = datos;
  const servicios = [...new Set(datos.servicios)];
  if (servicios.length === 0) throw new ProveedorSinServicioError();
  if (!servicios.includes('soat') && soat !== undefined) throw new DatosSoatInvalidosError(MENSAJE_SOAT_SIN_SERVICIO);

  return conUnicidadTraducida(g, () => db.transaction(async (tx) => {
    await exigirUnicos(tx, g);
    const [padre] = await tx.insert(flitoProveedores).values({ ...g }).returning();
    if (padre === undefined) throw new Error('El alta del proveedor no devolvió la fila');
    if (servicios.includes('soat')) {
      await tx.insert(flitoProveedoresSoat).values({
        id: padre.id, nombre: g.nombre, ...columnasDeSoat(soat ?? {}),
      });
    }
    if (servicios.includes('logistica')) {
      await tx.insert(flitoProveedoresLogistica).values({
        id: padre.id, nombre: g.nombre, nit: g.nit, contacto: g.contacto, telefono: g.telefono,
      });
    }
    await registrarAuditoriaProveedor(tx, padre.id, actor.userId, [
      ...entradasDeCambios('crear', {}, generalesDe(g)),
      ...(soat === undefined ? [] : entradasDeSoat('crear', soat)),
      ...servicios.map((s): EntradaAuditoriaProveedor => ({ accion: 'servicio_agregado', campo: 'servicio', despues: s })),
    ]);
    return itemDeProveedor(tx, padre);
  }));
}
