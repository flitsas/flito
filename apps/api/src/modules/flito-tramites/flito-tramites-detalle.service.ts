// ADR-0044 — Detalle de un trámite para la modal de Gestión Trámites (`GET /api/flito/tramites/:id/detalle`)
// y el nombre del ZIP de soportes cuando se pide UNO solo.
//
// Archivo aparte para no engordar `flito-tramites.service.ts` (AGENTS.md §19). La fila sale de la MISMA
// proyección y del MISMO `aFila` que el listado: la modal no puede contar un semáforo o un «listo para
// entregar» distinto del que se lee en la tabla.
//
// RN-0044-1: el alcance por enlace se aplica en el WHERE (igual que el listado). Fuera de alcance e
//            inexistente son el mismo `null` → la ruta responde 404 sin distinguirlos.
// RN-0044-2: solo campos que ya existen en el modelo (decisión del humano 2026-11-18): sin motor ni
//            año-modelo. «Gestora» es la compañía (empresa cliente) del trámite.
// RN-0044-3: el ZIP de UN trámite se llama `[ID del trámite]-DOCS.zip` (el `id_flit` visible, nunca la
//            placa: HU #11910 y #12817). El de varios conserva el nombre de siempre.
import { and, eq, type SQL } from 'drizzle-orm';
import type {
  TramiteDetalle, TramiteDetalleConcepto, TramiteDetallePendiente,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoCompradores, flitoTramites } from '../../db/schema.js';
import type { AlcanceResuelto } from '../../shared/middleware/frontera-enlace.js';
import { condicionAlcanceTramites } from './flito-tramites.alcance.js';
import { aFila, proyeccion, type TramiteFila } from './flito-tramites.service.js';

/** Nombres (nunca valores) de las columnas del titular que proyecta el detalle, para `pii_access_log`. */
export const CAMPOS_PII_DETALLE_TRAMITE = [
  'nombre_completo', 'tipo_documento', 'numero_documento', 'correo', 'celular', 'direccion',
] as const;

function condiciones(id: string, alcance: AlcanceResuelto): SQL {
  const porAlcance = condicionAlcanceTramites(alcance);
  return porAlcance ? and(eq(flitoTramites.id, id), porAlcance)! : eq(flitoTramites.id, id);
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

function costos(f: TramiteFila): TramiteDetalle['costos'] {
  const conceptos: TramiteDetalleConcepto[] = [
    {
      concepto: 'soat', quienCobra: f.soat?.proveedorSoatNombre ?? null, autogestionado: f.soatAutogestionado,
      estado: f.soat?.estado ?? null, valor: f.soat?.valorPagado ?? null, valorLiquidado: null,
    },
    {
      concepto: 'impuesto', quienCobra: f.organismoNombre, autogestionado: f.impuestosAutogestionado,
      estado: f.impuesto?.estado ?? null, valor: f.impuesto?.valorPagado ?? null,
      valorLiquidado: f.impuesto?.valorLiquidado ?? null,
    },
    {
      concepto: 'derecho_transito', quienCobra: f.organismoNombre, autogestionado: false,
      estado: null, valor: f.derechoTramiteValor, valorLiquidado: null,
    },
  ];
  const conValor = conceptos.filter((c) => c.valor !== null);
  return {
    conceptos,
    tieneFacturaVenta: f.facturaVentaFlitId !== null,
    total: conValor.length ? conValor.reduce((s, c) => s + (c.valor ?? 0), 0) : null,
  };
}

/** Proyección de la modal a partir de la fila del listado. Pura: se prueba sin BD. */
export function aDetalle(f: TramiteFila): TramiteDetalle {
  const pendientes: TramiteDetallePendiente[] = [];
  if (!f.soatResuelto) pendientes.push('soat');
  if (!f.impuestosResueltos) pendientes.push('impuestos');
  return {
    id: f.tramiteId,
    idFlit: f.idFlit,
    resumen: {
      estado: f.estado, asignado: f.asignado, tipoTramite: f.tipoTramite, fuente: f.fuente,
      creado: f.fechaCreacion, aprobado: f.fechaAprobacion, ciudad: f.ciudad,
      pendientes, listoParaEntregar: f.listoParaEntregar, semaforo: f.semaforo,
      logisticaEstado: f.logistica?.estado ?? null, sincronizadoEn: f.sincronizadoEn,
    },
    vehiculo: {
      placa: f.vehiculo.placa, vin: f.vehiculo.vin, marca: f.vehiculo.marca,
      linea: f.vehiculo.linea, clase: f.vehiculo.tipoVehiculo,
    },
    propietarios: f.compradores.map((c) => ({
      nombreCompleto: c.nombreCompleto, tipoDocumento: c.tipoDocumento, numeroDocumento: c.numeroDocumento,
      correo: c.correo, celular: c.celular, direccion: c.direccion, orden: c.orden,
      porcentajeParticipacion: num(c.porcentajeParticipacion),
    })),
    gestora: { nombre: f.companiaNombre, nit: f.empresaNit, existe: f.empresaExiste },
    costos: costos(f),
  };
}

/** Detalle de un trámite dentro del alcance; `null` si no existe o no es del alcance (RN-0044-1). */
export async function detalleTramite(id: string, alcance: AlcanceResuelto): Promise<TramiteDetalle | null> {
  const [fila] = await proyeccion().where(condiciones(id, alcance)).limit(1);
  if (!fila) return null;
  const compradores = await db.select({
    nombreCompleto: flitoCompradores.nombreCompleto, numeroDocumento: flitoCompradores.numeroDocumento,
    correo: flitoCompradores.correo, celular: flitoCompradores.celular, direccion: flitoCompradores.direccion,
    orden: flitoCompradores.orden, porcentajeParticipacion: flitoCompradores.porcentajeParticipacion,
  }).from(flitoCompradores).where(eq(flitoCompradores.tramiteId, id));
  return aDetalle(aFila(fila, compradores));
}

/** Lo que se admite del `id_flit` en un nombre de archivo: sin comillas, barras ni saltos. */
const SEGURO = /[^A-Za-z0-9._-]+/g;

/**
 * Nombre del ZIP cuando el pedido es de UN solo trámite (RN-0044-3); `undefined` = varios trámites o
 * sin `id_flit` utilizable → el emisor pone el nombre de siempre (`soportes_AAAAMMDD-HHMM.zip`).
 */
export async function nombreZipDeTramite(ids: readonly string[], alcance: AlcanceResuelto): Promise<string | undefined> {
  const unicos = [...new Set(ids)];
  if (unicos.length !== 1) return undefined;
  const [t] = await db.select({ idFlit: flitoTramites.idFlit }).from(flitoTramites)
    .where(condiciones(unicos[0], alcance)).limit(1);
  const base = (t?.idFlit ?? '').replace(SEGURO, '-').replace(/^-+|-+$/g, '');
  return base ? `${base}-DOCS.zip` : undefined;
}
