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

export interface Flit2SyncPort {
  /** Lanza si no hay acceso utilizable (sin acceso, rechazado, bloqueado, no configurado). */
  verificarAcceso(): Promise<AccesoLectura | void>;
  leerPagina(pos: PosicionLectura, pageSize: number): Promise<PaginaFlit2>;
}
