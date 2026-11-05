// HU #14333 (Feature #14324, ADR-0039 §3 y §4.3) — Agregar y quitar servicios de un proveedor, con sus bloqueos.
//
// Reglas:
//   · RN-PSERV-1 (R2) — Quitar el último servicio → 422. Se comprueba con `FOR UPDATE` sobre el padre: de dos retiros
//       simultáneos, el segundo espera y relee, y queda como el último (HU #14333 AC8). Por eso `DELETE` no pide
//       `versionEsperada`: con ella el segundo recibiría el aviso de edición simultánea en lugar del 422 del AC.
//   · RN-PSERV-2 (R4) — SOAT se bloquea por compañías vigentes, SOAT en estado distinto de pagado y reglas de enrutamiento.
//       Logística, por compañías vigentes (también las que la tienen apagada), actas generadas o despachadas y licencias sin
//       terminar: `entregado` y `devuelto` cuentan como terminadas y `novedad` bloquea (decisión del humano). Sin el bloqueo de reglas, el motor seguiría enviando SOAT a quien ya no lo presta.
//   · RN-PSERV-3 — Hasta F4.1 `flito_logistica_documentos` no tiene `proveedor_logistica_id`: la licencia se atribuye por su
//       acta. Una licencia sin acta es de quien hoy tiene la compañía (R16), y ese caso ya bloquea por compañías.
//   · RN-PSERV-4 (§3) — Quitar es baja lógica del perfil: la fila se conserva porque el histórico la referencia. El perfil de
//       Logística se vacía de NIT, contacto y teléfono, que siguen en el padre. Agregar reactiva el perfil de baja con el
//       mismo identificador; no crea un segundo perfil. Lo que no venga de SOAT conserva lo que el perfil tenía.
import { and, count, eq, inArray, ne, notInArray } from 'drizzle-orm';
import {
  SERVICIO_PROVEEDOR_LABEL, type BloqueoProveedorDto, type ProveedorListaItemDto, type ProveedorSoatBody, type ServicioProveedor,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  clients, flitoLogisticaActas, flitoLogisticaDocumentos, flitoProveedores, flitoProveedoresLogistica, flitoProveedoresSoat,
  flitoReglasProveedorSoat, flitoSoat,
} from '../../db/schema.js';
import type { ActorAuditoria } from '../../shared/historial/permisos-auditoria.js';
import { clienteVigente } from '../clients/cliente-operable.js';
import { registrarAuditoriaProveedor } from './flito-proveedores-auditoria.js';
import {
  ProveedorSinServicioError, bloquearPerfilesDeProveedor, bloquearProveedorVigente, columnasDeSoat, itemDeProveedor, serviciosDeProveedor,
  type EjecutorProveedor, type FilaProveedor, type TxProveedor,
} from './flito-proveedores.service.js';

/** 409 con el mensaje de la épica: «No puede quitar [servicio]: [motivo y cantidad]». Trae las cantidades por motivo. */
export class ServicioNoQuitableError extends Error {
  constructor(readonly servicio: ServicioProveedor, motivo: string, readonly bloqueos: readonly BloqueoProveedorDto[]) {
    super(`No puede quitar ${SERVICIO_PROVEEDOR_LABEL[servicio]}: ${motivo}`); this.name = 'ServicioNoQuitableError';
  }
}
/** 404: el proveedor no presta el servicio que se quiere quitar. */
export class ServicioNoPrestadoError extends Error {
  constructor(servicio: ServicioProveedor) {
    super(`El proveedor no presta ${SERVICIO_PROVEEDOR_LABEL[servicio]}`); this.name = 'ServicioNoPrestadoError';
  }
}

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

function bloqueos(entradas: readonly [BloqueoProveedorDto['motivo'], number, string, string][]): BloqueoProveedorDto[] {
  return entradas.filter(([, n]) => n > 0).map(([motivo, cantidad, uno, varios]) => ({ motivo, cantidad, texto: plural(cantidad, uno, varios) }));
}

const totalDe = (filas: { total: number }[]) => Number(filas[0]?.total ?? 0);

async function bloqueosDeSoat(exec: EjecutorProveedor, id: string): Promise<BloqueoProveedorDto[]> {
  const [companias, soat, reglas] = await Promise.all([
    exec.select({ total: count() }).from(clients).where(and(eq(clients.flitoProveedorSoatSinTramiteId, id), clienteVigente())),
    exec.select({ total: count() }).from(flitoSoat).where(and(eq(flitoSoat.proveedorSoatId, id), ne(flitoSoat.estado, 'pagado'))),
    exec.select({ total: count() }).from(flitoReglasProveedorSoat).where(eq(flitoReglasProveedorSoat.proveedorSoatId, id)),
  ]);
  return bloqueos([
    ['companias', totalDe(companias), 'compañía asignada', 'compañías asignadas'],
    ['soat_en_curso', totalDe(soat), 'SOAT en curso', 'SOAT en curso'],
    ['reglas', totalDe(reglas), 'regla de enrutamiento', 'reglas de enrutamiento'],
  ]);
}

async function bloqueosDeLogistica(exec: EjecutorProveedor, id: string): Promise<BloqueoProveedorDto[]> {
  const [companias, actas, licencias] = await Promise.all([
    exec.select({ total: count() }).from(clients).where(and(eq(clients.flitoProveedorLogisticaId, id), clienteVigente())),
    exec.select({ total: count() }).from(flitoLogisticaActas).where(and(
      eq(flitoLogisticaActas.proveedorLogisticaId, id), inArray(flitoLogisticaActas.estado, ['generada', 'despachada']),
    )),
    exec.select({ total: count() }).from(flitoLogisticaDocumentos)
      .innerJoin(flitoLogisticaActas, eq(flitoLogisticaActas.id, flitoLogisticaDocumentos.actaId))
      .where(and(
        eq(flitoLogisticaActas.proveedorLogisticaId, id),
        eq(flitoLogisticaDocumentos.tipo, 'licencia_transito'), notInArray(flitoLogisticaDocumentos.estado, ['entregado', 'devuelto']),
      )),
  ]);
  return bloqueos([
    ['companias', totalDe(companias), 'compañía asignada', 'compañías asignadas'],
    ['actas', totalDe(actas), 'acta generada o despachada', 'actas generadas o despachadas'],
    ['licencias', totalDe(licencias), 'licencia no entregada', 'licencias no entregadas'],
  ]);
}

/** RN-PSERV-2. Solo lectura: lo usan el impacto, quitar un servicio y eliminar. */
export function bloqueosDeServicio(exec: EjecutorProveedor, id: string, servicio: ServicioProveedor): Promise<BloqueoProveedorDto[]> {
  return servicio === 'soat' ? bloqueosDeSoat(exec, id) : bloqueosDeLogistica(exec, id);
}

export const textoDeBloqueos = (lista: readonly BloqueoProveedorDto[]): string => lista.map((b) => b.texto).join(', ');

export interface MotivoNoQuitable { texto: string; bloqueos: BloqueoProveedorDto[] }

/**
 * RN-PSERV-2, ADR-0039 §4.3. Misma forma que `motivoNoEliminableProveedor`: el motivo, o `null` si se puede quitar. Bloquea el
 * padre y los perfiles en el orden canónico: una asignación en curso (`FOR SHARE`, F3) espera y relee. Lanza 404 si no existe.
 */
export async function motivoNoQuitableServicio(tx: TxProveedor, proveedorId: string, servicio: ServicioProveedor): Promise<MotivoNoQuitable | null> {
  await bloquearProveedorVigente(tx, proveedorId);
  await bloquearPerfilesDeProveedor(tx, proveedorId);
  const lista = await bloqueosDeServicio(tx, proveedorId, servicio);
  return lista.length === 0 ? null : { texto: textoDeBloqueos(lista), bloqueos: lista };
}

/** Lanza si el servicio no se puede quitar ahora mismo. El padre ya debe estar escrito o bloqueado por quien llama. */
export async function exigirServicioQuitable(tx: TxProveedor, id: string, servicio: ServicioProveedor): Promise<void> {
  const motivo = await motivoNoQuitableServicio(tx, id, servicio);
  if (motivo !== null) throw new ServicioNoQuitableError(servicio, motivo.texto, motivo.bloqueos);
}

/** RN-PSERV-4. Baja lógica del perfil, sin tocar el padre: la 0290 impide que este UPDATE le suba los datos vaciados. */
export async function retirarPerfil(tx: TxProveedor, id: string, servicio: ServicioProveedor, actorId: number | null, ahora: Date): Promise<void> {
  if (servicio === 'soat') {
    await tx.update(flitoProveedoresSoat).set({ deletedAt: ahora, deletedBy: actorId }).where(eq(flitoProveedoresSoat.id, id));
    return;
  }
  await tx.update(flitoProveedoresLogistica)
    .set({ deletedAt: ahora, deletedBy: actorId, nit: null, contacto: null, telefono: null })
    .where(eq(flitoProveedoresLogistica.id, id));
}

/** RN-PSERV-4. Reactiva el perfil de baja o crea el que nunca existió, con los datos del padre ya guardado. */
export async function darPerfil(tx: TxProveedor, padre: FilaProveedor, servicio: ServicioProveedor, soat: ProveedorSoatBody | undefined): Promise<void> {
  const base = { nombre: padre.nombre, activo: padre.activo };
  if (servicio === 'soat') {
    const datos = { ...base, ...columnasDeSoat(soat ?? {}) };
    const reactivado = await tx.update(flitoProveedoresSoat).set({ ...datos, deletedAt: null, deletedBy: null })
      .where(eq(flitoProveedoresSoat.id, padre.id)).returning({ id: flitoProveedoresSoat.id });
    if (reactivado.length === 0) await tx.insert(flitoProveedoresSoat).values({ id: padre.id, ...datos });
    return;
  }
  const datos = { ...base, nit: padre.nit, contacto: padre.contacto, telefono: padre.telefono };
  const reactivado = await tx.update(flitoProveedoresLogistica).set({ ...datos, deletedAt: null, deletedBy: null })
    .where(eq(flitoProveedoresLogistica.id, padre.id)).returning({ id: flitoProveedoresLogistica.id });
  if (reactivado.length === 0) await tx.insert(flitoProveedoresLogistica).values({ id: padre.id, ...datos });
}

/** RN-PSERV-1, RN-PSERV-2. El orden importa: el último servicio responde 422 aunque también tenga bloqueos. */
export async function quitarServicio(id: string, servicio: ServicioProveedor, actor: ActorAuditoria): Promise<ProveedorListaItemDto> {
  return db.transaction(async (tx) => {
    const padre = await bloquearProveedorVigente(tx, id);
    const servicios = await serviciosDeProveedor(tx, id);
    if (!servicios.includes(servicio)) throw new ServicioNoPrestadoError(servicio);
    if (servicios.length === 1) throw new ProveedorSinServicioError();
    await exigirServicioQuitable(tx, id, servicio);

    const ahora = new Date();
    const [act] = await tx.update(flitoProveedores)
      .set({ updatedAt: ahora, version: padre.version + 1 }).where(eq(flitoProveedores.id, id)).returning();
    await retirarPerfil(tx, id, servicio, actor.userId, ahora);
    await registrarAuditoriaProveedor(tx, id, actor.userId, [{ accion: 'servicio_quitado', campo: 'servicio', antes: servicio }]);
    return itemDeProveedor(tx, act!);
  });
}
