// FLITO sync — adaptador FAKE del feed de FLIT 2 (HU #13091). Páginas en memoria con datos
// FICTICIOS y deterministas (VIN `9FKTEST…`, placas `ZZZ…`, NIT de ejemplo): sirve para dev y demo
// sin salir a la red. `FLIT2_SYNC_ADAPTER=fake` está prohibido en producción (`config/env.ts`).
//
// `crearFlit2SyncFake(paginas)` acepta páginas a medida (los tests). Cada página se sirve cuando la
// posición pedida es su `desde` (`null` = la primera, pedida con `since`). Registra las llamadas.
//
// HU #13268 `enviarAdjunto`: simulador del endpoint de adjuntos (FLIT 2 aún no lo expone). Por defecto
// responde `enviado` (201) con un `adjuntoId` determinista y el sha256 REAL de los bytes; el mismo
// sha256 otra vez para el mismo trámite → 200 idempotente (`nuevo: false`, AC8); otro sha256 → 201 con
// `reemplazoDe`. `programarRespuestaAdjunto(idFlit2, [...])` encola desenlaces a medida (uno por llamada).

import { createHash } from 'crypto';
import { aItemFlit2 } from './flit2-sync-http.adapter.js';
import { TIPO_LIQUIDACION_IMPUESTO } from './flit2-adjuntos.js';
import type {
  ArchivoAdjuntoFlit2, Flit2SyncPort, ItemFlit2, PaginaFlit2, PosicionLectura, ResultadoEnvioAdjunto, UrlAdjuntoFlit2,
} from './flit2-sync.port.js';

export interface PaginaFake {
  /** Cursor con el que se pide esta página; `null` = primera página (con `since`). */
  desde: string | null;
  items: unknown[];
  nextCursor: string;
  hasMore: boolean;
  /** HU #13094: esta página salió con un pase sin (false) o con (true) el scope de datos personales. */
  conPii?: boolean;
}

const uuidFicticio = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function itemFicticio(n: number, estado: string, familia: string): Record<string, unknown> {
  const sufijo = String(n).padStart(2, '0');
  return {
    id: uuidFicticio(n), radicado: `FT9-00000${sufijo}`, consecutivo: n, syncVersion: 1000 + n,
    fechaUltimoCambio: '2026-09-29T10:00:00-05:00', eliminado: false, estado,
    tramite: { codigo: 'EJEMPLO', nombre: 'Trámite de ejemplo', familia },
    fechaCreacion: '2026-09-01T08:00:00-05:00', fechaRadicacion: '2026-09-01T09:00:00-05:00', fechaAprobacion: null,
    vehiculo: {
      vin: `9FKTEST0000000${sufijo}`.slice(0, 17), placa: `ZZZ0${sufijo}`, clase: 'AUTOMOVIL', marca: 'MARCA EJEMPLO',
      linea: 'LINEA EJEMPLO', modeloAno: 2026, carroceria: 'SEDAN', cilindraje: 1600, cilindrajeTexto: null, capacidad: 5,
      numeroMotor: `MTR${sufijo}`, numeroSerie: `SER${sufijo}`, tipoServicio: { codigo: 'PARTICULAR', nombre: 'Particular' },
    },
    organismo: { codigoTransito: '11001000', nombre: 'SECRETARIA DE EJEMPLO', codigoSecretaria: '11001', ciudad: 'BOGOTA', departamento: 'BOGOTA' },
    compradores: [],
    factura: null,
    companiaGestora: { tenantId: uuidFicticio(900), nit: '900000000', nombre: 'TRAMITADORA EJEMPLO SAS' },
  };
}

/** Dos páginas por defecto: un caso por desenlace (nuevo, tombstone, sin vehículo, revocado, familias). */
function paginasPorDefecto(): PaginaFake[] {
  const sinVehiculo = { ...itemFicticio(3, 'preasignacion', 'MATRICULAS'), vehiculo: null };
  return [
    {
      desde: null, nextCursor: 'fake-c1', hasMore: true,
      items: [itemFicticio(1, 'asignado', 'MATRICULAS'), itemFicticio(2, 'entregado', 'TRASPASO'), sinVehiculo],
    },
    {
      desde: 'fake-c1', nextCursor: 'fake-c2', hasMore: false,
      items: [
        itemFicticio(4, 'revocado', 'OTROS'),
        { id: uuidFicticio(5), radicado: 'FT9-0000005', syncVersion: 1005, eliminado: true, estado: 'anulado', vehiculo: null, organismo: null, factura: null, compradores: [] },
      ],
    },
  ];
}

export interface Flit2SyncFake extends Flit2SyncPort {
  llamadas: { cursor?: string; since?: string; pageSize: number }[];
  /** HU #13094: scope de datos personales del pase simulado (por defecto, concedido). Se puede cambiar. */
  conPii: boolean;
  /**
   * HU #13095: URLs de adjuntos por `${idFlit2}/${adjuntoId}`. Clave ausente = 404 (null). Vacío por
   * defecto: en demo toda factura de FLIT 2 queda «no disponible» sin salir a la red.
   */
  adjuntos: Map<string, UrlAdjuntoFlit2>;
  llamadasAdjunto: { idFlit2: string; adjuntoId: string }[];
  /** HU #13268: envíos recibidos (sin los bytes: solo tamaño, tipo y sha256). */
  llamadasEnvio: { idFlit2: string; contentType: string; nombreArchivo: string; tamano: number; sha256: string }[];
  /** HU #13268: guion por trámite; cada llamada consume el primero. Vacío = comportamiento por defecto. */
  programarRespuestaAdjunto(idFlit2: string, resultados: ResultadoEnvioAdjunto[]): void;
}

/** uuid v4 con forma válida derivado del sha256: el mismo archivo da el mismo `adjuntoId`. */
const uuidDeSha = (h: string): string => `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;

export function crearFlit2SyncFake(paginas: PaginaFake[] = paginasPorDefecto()): Flit2SyncFake {
  const llamadas: Flit2SyncFake['llamadas'] = [];
  const guiones = new Map<string, ResultadoEnvioAdjunto[]>();
  /** Adjunto vigente DE FLITO por trámite (la idempotencia del contrato compara contra él). */
  const vigentes = new Map<string, { adjuntoId: string; sha256: string }>();
  const fake: Flit2SyncFake = {
    llamadas,
    conPii: true,
    adjuntos: new Map(),
    llamadasAdjunto: [],
    llamadasEnvio: [],
    programarRespuestaAdjunto(idFlit2: string, resultados: ResultadoEnvioAdjunto[]): void {
      guiones.set(idFlit2, [...(guiones.get(idFlit2) ?? []), ...resultados]);
    },
    async enviarAdjunto(idFlit2: string, archivo: ArchivoAdjuntoFlit2): Promise<ResultadoEnvioAdjunto> {
      const sha256 = createHash('sha256').update(archivo.bytes).digest('hex');
      fake.llamadasEnvio.push({ idFlit2, contentType: archivo.contentType, nombreArchivo: archivo.nombreArchivo, tamano: archivo.bytes.length, sha256 });
      const guion = guiones.get(idFlit2);
      if (guion && guion.length > 0) return guion.shift()!;
      const previo = vigentes.get(idFlit2);
      if (previo && previo.sha256 === sha256) {
        return { tipo: 'enviado', nuevo: false, recibido: { adjuntoId: previo.adjuntoId, tipo: TIPO_LIQUIDACION_IMPUESTO, sha256, reemplazoDe: null, enMatriz: true, pagadoMarcado: true } };
      }
      const adjuntoId = uuidDeSha(sha256);
      vigentes.set(idFlit2, { adjuntoId, sha256 });
      return {
        tipo: 'enviado', nuevo: true,
        recibido: { adjuntoId, tipo: TIPO_LIQUIDACION_IMPUESTO, sha256, reemplazoDe: previo?.adjuntoId ?? null, enMatriz: true, pagadoMarcado: true },
      };
    },
    async obtenerUrlAdjunto(idFlit2: string, adjuntoId: string): Promise<UrlAdjuntoFlit2 | null> {
      fake.llamadasAdjunto.push({ idFlit2, adjuntoId });
      return fake.adjuntos.get(`${idFlit2}/${adjuntoId}`) ?? null;
    },
    async verificarAcceso() { return { conPii: fake.conPii }; },
    async leerPagina(pos: PosicionLectura, pageSize: number): Promise<PaginaFlit2> {
      const desde = 'cursor' in pos ? pos.cursor : null;
      llamadas.push('cursor' in pos ? { cursor: pos.cursor, pageSize } : { since: pos.since.toISOString(), pageSize });
      const pagina = paginas.find((p) => p.desde === desde);
      // Cursor que el fake no conoce: el feed está al día (contrato §3: página vacía, mismo cursor).
      if (!pagina) return { items: [], invalidos: 0, nextCursor: desde ?? 'fake-c0', hasMore: false, conPii: fake.conPii };
      const items: ItemFlit2[] = [];
      let invalidos = 0;
      for (const crudo of pagina.items) {
        const item = aItemFlit2(crudo);
        if (item) items.push(item);
        else invalidos += 1;
      }
      return { items, invalidos, nextCursor: pagina.nextCursor, hasMore: pagina.hasMore, conPii: pagina.conPii ?? fake.conPii };
    },
  };
  return fake;
}
