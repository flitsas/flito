// HU #14332 y #14333 (Feature #14324, ADR-0039 §4.2) — `PATCH /:id`: datos generales, configuración de SOAT y servicios en
// UNA transacción, con una sola `versionEsperada`. Así un guardado no queda a medias ni choca contra el mismo usuario.
//
// Reglas:
//   · RN-PEDIT-1 (R9) — Editar solo la configuración de SOAT no exige datos generales. Editar `generales` exige el bloque
//       completo (lo valida la ruta).
//   · RN-PEDIT-2 — Agregar un servicio a un proveedor existente cuenta como editar: exige los datos generales completos,
//       incluido el NIT (decisión del humano en F2). Es un solo punto: `exigirGeneralesAlAgregarServicio`.
//   · RN-PEDIT-3 (R2, R4, R7) — `servicios` es la lista FINAL. Vacía → 422. Lo que se retira pasa por los bloqueos de
//       `motivoNoQuitableServicio`. Los datos de SOAT son opcionales, y `soat` se rechaza si la lista final no lo incluye.
//   · RN-PEDIT-4 — Sin ningún cambio real no se escribe nada y la versión se conserva.
//   · El padre se escribe primero (RN-PROVG-5): su trigger baja nombre, NIT, contacto y teléfono a los perfiles vigentes.
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { EditarProveedorBody, ProveedorListaItemDto, ProveedorSoatBody, ServicioProveedor } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoProveedores, flitoProveedoresSoat } from '../../db/schema.js';
import type { ActorAuditoria } from '../../shared/historial/permisos-auditoria.js';
import { entradasDeCambios, registrarAuditoriaProveedor, type EntradaAuditoriaProveedor } from './flito-proveedores-auditoria.js';
import { darPerfil, exigirServicioQuitable, retirarPerfil } from './flito-proveedores-servicios.service.js';
import {
  DatosSoatInvalidosError, GeneralesIncompletosError, MENSAJE_SOAT_SIN_SERVICIO, ProveedorNoEncontradoError,
  ProveedorSinServicioError, bloquearPerfilesDeProveedor, bloquearProveedorVigente, columnasDeSoat, conUnicidadTraducida, entradasDeSoat, exigirUnicos, exigirVersion, generalesDe,
  generalesFaltantes, itemDeProveedor, serviciosDeProveedor, type FilaProveedor, type TxProveedor,
} from './flito-proveedores.service.js';

/** RN-PEDIT-2. `generales` ya viene completo si la petición lo trae; si no, cuenta lo que el proveedor tiene guardado. */
function exigirGeneralesAlAgregarServicio(actual: FilaProveedor, generales: EditarProveedorBody['generales']): void {
  const faltan = generalesFaltantes(generales ?? actual);
  if (faltan.length > 0) throw new GeneralesIncompletosError(faltan);
}

const texto = (v: number | null | undefined) => (v == null ? null : String(v));

/** Lee el perfil vigente y prepara el UPDATE y la auditoría de la configuración de SOAT. */
async function cambiosDeSoat(tx: TxProveedor, id: string, soat: ProveedorSoatBody) {
  const [perfil] = await tx.select().from(flitoProveedoresSoat)
    .where(and(eq(flitoProveedoresSoat.id, id), isNull(flitoProveedoresSoat.deletedAt))).for('no key update').limit(1);
  if (perfil === undefined) throw new DatosSoatInvalidosError(MENSAJE_SOAT_SIN_SERVICIO);
  const set = columnasDeSoat(soat);
  const entradas = entradasDeCambios('editar',
    { estrategia: perfil.estrategia, umbral_ocr: texto(perfil.umbralOcr === null ? null : Number(perfil.umbralOcr)), sla_horas: texto(perfil.slaHoras) },
    {
      ...(soat.estrategia !== undefined ? { estrategia: soat.estrategia } : {}),
      ...(soat.umbralOcr !== undefined ? { umbral_ocr: texto(soat.umbralOcr) } : {}),
      ...(soat.slaHoras !== undefined ? { sla_horas: texto(soat.slaHoras) } : {}),
    });
  return { set, entradas };
}

/** RN-PEDIT-1 a RN-PEDIT-4. Lanza 404, 409 (versión, duplicado, bloqueos) o 422 (servicios, SOAT, datos generales). */
export async function editarProveedor(id: string, datos: EditarProveedorBody, actor: ActorAuditoria): Promise<ProveedorListaItemDto> {
  const { generales: g, soat, versionEsperada } = datos;
  return conUnicidadTraducida(g ?? null, () => db.transaction(async (tx) => {
    const actual = await bloquearProveedorVigente(tx, id);
    exigirVersion(actual, versionEsperada);

    const previos = await serviciosDeProveedor(tx, id);
    const finales = datos.servicios === undefined ? previos : [...new Set(datos.servicios)];
    if (finales.length === 0) throw new ProveedorSinServicioError();
    const agregados: ServicioProveedor[] = finales.filter((s) => !previos.includes(s));
    const quitados: ServicioProveedor[] = previos.filter((s) => !finales.includes(s));
    if (quitados.length > 0) await bloquearPerfilesDeProveedor(tx, id);

    if (soat !== undefined && !finales.includes('soat')) throw new DatosSoatInvalidosError(MENSAJE_SOAT_SIN_SERVICIO);
    if (agregados.length > 0) exigirGeneralesAlAgregarServicio(actual, g);
    const soatNuevo = agregados.includes('soat') ? (soat ?? {}) : undefined;
    for (const s of quitados) await exigirServicioQuitable(tx, id, s);

    const entradas: EntradaAuditoriaProveedor[] = [];
    let setSoat: Partial<typeof flitoProveedoresSoat.$inferInsert> = {};
    if (soat !== undefined && soatNuevo === undefined) {
      const cambios = await cambiosDeSoat(tx, id, soat);
      setSoat = cambios.set;
      entradas.push(...cambios.entradas);
    }
    if (g !== undefined) {
      await exigirUnicos(tx, g, id);
      entradas.push(...entradasDeCambios('editar', generalesDe(actual), generalesDe(g)));
    }
    entradas.push(...agregados.map((s): EntradaAuditoriaProveedor => ({ accion: 'servicio_agregado', campo: 'servicio', despues: s })));
    if (soatNuevo !== undefined) entradas.push(...entradasDeSoat('servicio_agregado', soatNuevo));
    entradas.push(...quitados.map((s): EntradaAuditoriaProveedor => ({ accion: 'servicio_quitado', campo: 'servicio', antes: s })));
    if (entradas.length === 0) return itemDeProveedor(tx, actual);

    const ahora = new Date();
    const [padre] = await tx.update(flitoProveedores)
      .set({ ...(g ?? {}), updatedAt: ahora, version: sql`${flitoProveedores.version} + 1` })
      .where(eq(flitoProveedores.id, id)).returning();
    if (padre === undefined) throw new ProveedorNoEncontradoError();

    // Primero se da y después se retira: si el proveedor se quedara sin perfil vigente aunque sea un instante, el trigger
    // `perfil_a_padre` lo daría de baja. `padre` es la fila ya guardada: el perfil entrante no copia datos obsoletos.
    for (const s of agregados) await darPerfil(tx, padre, s, s === 'soat' ? soatNuevo : undefined);
    for (const s of quitados) await retirarPerfil(tx, id, s, actor.userId, ahora);
    if (Object.keys(setSoat).length > 0) {
      await tx.update(flitoProveedoresSoat).set(setSoat).where(eq(flitoProveedoresSoat.id, id));
    }
    await registrarAuditoriaProveedor(tx, id, actor.userId, entradas);
    return itemDeProveedor(tx, padre);
  }));
}
