// FLITO sync — puerto del feed incremental de trámites de FLIT 2 (HU #13091, Feature #13059).
// Contrato: `docs/integraciones/flit2-api.md` v3.1 §3-§4. Adaptadores: `flit2-sync-http.adapter.ts`
// (real) y `flit2-sync-fake.adapter.ts` (páginas en memoria); selector en `flit2-sync.adapter.ts`.
//
// El adaptador normaliza el ítem crudo a `ItemFlit2` (o lo cuenta como inválido) y deja `raw` YA sin
// PII. Los compradores completos viajan solo en memoria para la #13093: nunca van a un log.

export interface VehiculoFlit2 {
  vin: string;
  placa: string | null;
  marca: string | null;
  linea: string | null;
  cilindraje: string | null;
  carroceria: string | null;
  tipoServicio: string | null;
  numMotor: string | null;
  numSerie: string | null;
}

/** Comprador tal como lo entrega FLIT 2. PII: solo en memoria; lo consume la #13093. */
export interface CompradorFlit2 {
  ordinal: number;
  porcentajeParticipacion: number | null;
  rolActor: string;
  tipoPersona: string | null;
  tipoDocumento: string | null;
  numeroDocumento: string | null;
  nombreCompleto: string | null;
  direccion: string | null;
  ciudad: string | null;
  celular: string | null;
  correo: string | null;
}

export interface OrganismoFlit2 {
  codigoSecretaria: string | null;
  ciudad: string | null;
  nombre: string | null;
}

export interface ItemFlit2 {
  idFlit2: string;
  radicado: string;
  syncVersion: number;
  eliminado: boolean;
  /** Código crudo del contrato (minúscula). Se compara exacto. */
  estado: string;
  familia: string | null;
  fechaCreacion: string | null;
  fechaAprobacion: string | null;
  /** null si el bloque o el VIN llegan null/vacíos: «sin vehículo». */
  vehiculo: VehiculoFlit2 | null;
  organismo: OrganismoFlit2 | null;
  companiaNit: string | null;
  /** Adjunto de la factura (#13095). */
  facturaAdjuntoId: string | null;
  compradores: CompradorFlit2[];
  /** Ítem crudo YA sin PII (`rawSinPii`). */
  raw: unknown;
}

/** Posición desde la que se pide la página: cursor XOR since (los dos juntos son un 400 del contrato). */
export type PosicionLectura = { cursor: string } | { since: Date };

export interface PaginaFlit2 {
  items: ItemFlit2[];
  /** Ítems de la página que no cumplen el contrato: se saltan y se cuentan. */
  invalidos: number;
  /** Siempre presente (contrato §3), también con `hasMore=false`. */
  nextCursor: string;
  hasMore: boolean;
  /**
   * HU #13094: si el pase con que se leyó la página traía `external.tramites.pii.read`. Sin él, los
   * compradores llegan enmascarados (contrato §4). Ausente = se toma lo que dijo `verificarAcceso`.
   */
  conPii?: boolean;
}

/** Lo que sabe el acceso antes de leer (HU #13094). Ausente = con permiso de datos personales. */
export interface AccesoLectura {
  conPii: boolean;
}

/**
 * HU #13095. Respuesta de `GET …/tramites/{id}/adjuntos/{adjuntoId}/url` (contrato §3). `url` es una
 * URL firmada de 10 min, de uso inmediato: NUNCA va a un log, a un mensaje de error ni a la base.
 */
export interface UrlAdjuntoFlit2 {
  url: string;
  /** Informativo: el tipo real se saca de los bytes (`tipoPorBytes`), como en FLIT 1. */
  contentType: string | null;
  nombreArchivo: string | null;
  /** Informativo (contrato): no se usa para decidir; la URL se descarga en el acto. */
  expiraEn: string | null;
}

export interface Flit2SyncPort {
  /** Lanza si no hay acceso utilizable (sin acceso, rechazado, bloqueado, no configurado). */
  verificarAcceso(): Promise<AccesoLectura | void>;
  leerPagina(pos: PosicionLectura, pageSize: number): Promise<PaginaFlit2>;
  /**
   * HU #13095. URL firmada de un adjunto del trámite. null = 404 (trámite o adjunto inexistente, o no es
   * de ese trámite): CUALQUIER 404, sin mirar `code`. Otros fallos lanzan `Flit2Error`.
   */
  obtenerUrlAdjunto(idFlit2: string, adjuntoId: string): Promise<UrlAdjuntoFlit2 | null>;
  /**
   * HU #13268. `POST /api/v1/external/tramites/{idFlit2}/adjuntos`, `tipo=liquidacion_impuesto`.
   * No lanza por respuestas de FLIT 2 (las devuelve clasificadas). Lanza solo los `Flit2Error` del
   * pase (`NoConfigurado`, `SinAcceso`, `Rechazado`, `Bloqueado`…), que el cron trata como pausa global.
   */
  enviarAdjunto(idFlit2: string, archivo: ArchivoAdjuntoFlit2): Promise<ResultadoEnvioAdjunto>;
}

// ── HU #13268: envío del comprobante de pago a FLIT 2 (diseño feature-13267 §5) ──────────────────

/** Lo que FLITO envía. Los bytes ya leídos de S3; nunca van a un log. */
export interface ArchivoAdjuntoFlit2 {
  bytes: Buffer;
  /**
   * Tipo real por bytes: application/pdf | image/jpeg | image/png | image/webp. Va como Content-Type
   * de la parte `file`: es lo que FLIT 2 usa para decidir el MIME.
   */
  contentType: string;
  /** Nombre genérico (`comprobante-impuesto.pdf`): el original puede llevar placa o nombre. */
  nombreArchivo: string;
}

/** `AdjuntoRecibido` del contrato (201 y 200 tienen el mismo cuerpo). */
export interface AdjuntoRecibidoFlit2 {
  adjuntoId: string;
  tipo: string;
  sha256: string;
  /** No nulo cuando FLIT 2 reemplazó el adjunto vigente de FLITO. */
  reemplazoDe: string | null;
  enMatriz: boolean;
  /** Solo se guarda. FLITO NO decide nada con este valor (D-5). */
  pagadoMarcado: boolean;
}

export type ResultadoEnvioAdjunto =
  /** 201 (nuevo: true) o 200 idempotente (nuevo: false; mismo sha256 que el adjunto vigente DE FLITO) — AC1, AC8. */
  | { tipo: 'enviado'; nuevo: boolean; recibido: AdjuntoRecibidoFlit2 }
  /** Consume intento (AC5): red/timeout, 5xx, 401 tras la renovación, 200 ilegible, 4xx no listado. */
  | { tipo: 'reintentable'; codigo: string; status: number | null }
  /** NO consume intento (AC7): 429. `segundos` = Retry-After. Corta el ciclo. */
  | { tipo: 'espera'; segundos: number }
  /** NO consume intento: 409 not_allowed_in_state terminal:false. La fila pasa a `en_espera`. No corta el ciclo. */
  | { tipo: 'estacionar'; estadoFlit2: string }
  /** NO consume intento, pausa TODA la cola: 403 insufficient_scope, 404 sin cuerpo, 400 invalid_tipo. Corta el ciclo. */
  | { tipo: 'pausa'; codigo: 'insufficient_scope' | 'no_disponible' | 'invalid_tipo'; status: number }
  /**
   * Final del ítem, sin reintento (AC6). `status` null solo cuando no se llamó (id de FLIT 2 que no es
   * un segmento de ruta seguro → `procedure_not_found` sin red).
   */
  | {
    tipo: 'definitivo';
    motivo: 'attachment_exists' | 'not_allowed_in_state' | 'procedure_not_found' | 'missing_file' | 'invalid_mime' | 'file_too_large';
    status: number | null;
    estadoFlit2?: string;
  };
