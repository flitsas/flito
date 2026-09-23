// Tipos y constantes de la cola SOAT (HU #12819, fase 0): movidos TAL CUAL desde `pages/FlitoSoat.tsx`
// para bajar la página del techo de 800 líneas. Sus comentarios son el porqué y viajan con ellos.

import { EstadoSoat } from '@operaciones/shared-types';
import type { VigenciaSoatCola } from '../../../lib/vigenciaSoatCola';

export interface SoatItem {
  id: string; vin: string; placa: string | null; marca: string | null; linea: string | null;
  /** Datos técnicos que FLIT trae del vehículo (HU #11906). `string` a propósito y NO number: la
      fuente es texto siempre, `"0"` significa eléctrico (`vehicles/ocr.routes.ts:76`) y un futuro
      «220 CC» se rompería en silencio al parsearlo. Llegan `null` cuando FLIT no los mandó; el «—»
      lo pinta esta página, no el backend. */
  cilindraje: string | null; carroceria: string | null; tipoServicio: string | null;
  estado: EstadoSoat; esMultiplePropietario: boolean; companiaNombre: string;
  organismoNombre: string | null;
  /** Los cinco campos OPCIONALES son los que el backend NO le manda al rol `cliente` (Feature
      #11912): con qué proveedor tiene FLITO contratada la adquisición, si el caso lo retomó
      Operaciones, qué empleado lo despachó y cuánto pagó FLITO por la póliza. `?` y no `| null`
      porque la diferencia es real y conviene que se note: no llegan vacíos, no llegan. Lo que los
      pinta va detrás de `!esCliente`; el `?` es la red por si alguna vez se olvida una guarda. */
  proveedorSoatId?: string | null; proveedorSoatNombre?: string | null;
  gestionOperaciones?: boolean;
  /**
   * `tipoDocumento` es el CÓDIGO ya resuelto por el API (`'CC' | 'NIT' | 'PP' | 'CE'`) o null, no el
   * `tipo` crudo de FLIT: la traducción vive en el backend y aquí no hay copia (HU #11947, AC6/AC7).
   */
  compradores: Array<{ nombreCompleto: string; numeroDocumento: string; tipoDocumento: string | null; orden: number; porcentajeParticipacion: number | null }>;
  tramitesFlit: string[];
  /** Datos del trámite. Null cuando el SOAT sirve a varios que no coinciden (es por VIN, RN-01). */
  tipoTramite: string | null; fechaAprobacion: string | null; fechaCreacion: string | null;
  enviadoPorNombre?: string | null; enviadoEn: string | null; pagadoEn: string | null;
  valorPagado?: number | null; estancado: boolean; motivoRechazo: string | null; creadoEn: string;
  /**
   * Vigencia frente al RUNT, tal como la dejó la corrida de las 00:10 (Feature #12075).
   *
   * Los DOS huecos significan cosas distintas y ninguno se puede colapsar en el otro:
   *   · `undefined` — el API no lo manda. Al `cliente` nunca (es el sexto de `CAMPOS_SOLO_INTERNOS`)
   *     y a nadie si el bundle va por delante del API, que en DEV no es teórico: el merge es el
   *     deploy. La fila se pinta EXACTAMENTE como antes de esta HU.
   *   · `null` — la fila no tiene comprobante cargado y por tanto no entra en la verificación
   *     diaria. Tampoco se pinta nada: la ausencia es correcta y muda, y un «—» en la mayoría de
   *     las filas sería un hueco que hay que explicar.
   *
   * `verificadaEn` puede ser `null` CON el bloque presente, y no significa «hoy falló» sino «de
   * este SOAT no consta ninguna respuesta del registro». Leerlo sin guarda pinta «Invalid Date».
   */
  vigencia?: VigenciaSoatCola | null;
}
export interface Proveedor { id: string; nombre: string; activo: boolean }
export interface ColaSoat { items: SoatItem[]; total: number; page: number; pageSize: number }
export interface FacetasSoat {
  companias: { id: number; nombre: string }[];
  organismos: { codigo: string; nombre: string | null }[];
  proveedores: { id: string; nombre: string }[];
}

export const pesos = (v: number | null | undefined) => v === null || v === undefined ? '—'
  : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v);
/** Solo el día (HU #12819): las fechas del trámite en FLIT, que pasaron de la tabla al detalle. */
export const fechaDia = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('es-CO', { dateStyle: 'medium' }) : '—';
export const fecha = (iso: string | null) => iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '—';

/**
 * Los estados a los que el admin puede REVERSAR un SOAT, y NADA MÁS.
 *
 * **Sigue siendo una lista aparte aunque su contenido coincida con el de las pastillas del admin, y
 * eso es una decisión, no un descuido.** La razón por la que nació separada —no ofrecer
 * `pendiente_revision` ni `rechazada` como destino de reversa (ADR-0008 §8)— se evaporó del todo con
 * la HU #12080, que retira los dos estados del enum. Pero las dos listas responden a preguntas
 * distintas: «por qué se puede filtrar» y «a dónde se puede devolver un SOAT». Fundirlas porque hoy
 * son iguales le regalaría a la siguiente pastilla que alguien añada un destino de reversa que nadie
 * decidió — que es exactamente lo que acaba de pasar y de deshacerse.
 */
export const ESTADOS_DESTINO_REVERSA: EstadoSoat[] = [EstadoSoat.PENDIENTE, EstadoSoat.SOLICITADO, EstadoSoat.PAGADO, EstadoSoat.CON_NOVEDAD];
export const ESTADOS_GESTOR: EstadoSoat[] = [EstadoSoat.SOLICITADO, EstadoSoat.PAGADO];
/**
 * Las pastillas del admin, en orden de RECORRIDO del ciclo (HU #12079).
 *
 * `pendiente_revision` y `rechazada` salieron de aquí porque el circuito que los creaba se retiró:
 * una solicitud del canal nace en `solicitado` y sale al gestor de su compañía sin pasar por
 * revisión. Una pastilla que filtra por un estado en el que ya no entra ninguna fila es una pantalla
 * vacía prometida — y desde la HU #12080 sería además un 500: el filtro viaja al API, que ya no
 * acepta esos valores (`ESTADOS` de `flito-soat.routes.ts`).
 */
export const ESTADOS_ADMIN: EstadoSoat[] = [
  EstadoSoat.PENDIENTE, EstadoSoat.SOLICITADO, EstadoSoat.PAGADO, EstadoSoat.CON_NOVEDAD,
];
/**
 * Las pastillas del Cliente: **las mismas cuatro, en el orden de SU recorrido** (HU #12079).
 *
 * Son las mismas y no un subconjunto: el aislamiento del Cliente es **por compañía, no por origen**
 * (`condicionesCola`), así que en su cola conviven los SOAT nacidos de trámites de FLIT con los que
 * él radica. `con_novedad` va antes que `pagado` porque es lo único de esta lista que puede estar
 * esperando algo, aunque no sea él quien lo resuelva.
 *
 * ⚠ **Lo que murió con la HU #12079 y sigue muerto:** aquí se leía que «no hace falta una columna
 * Origen porque `pendiente_revision` y `rechazada` solo existen en el canal Cliente, así que el
 * estado ya dice de dónde viene cada fila». Retirados los dos estados —de la pantalla entonces, del
 * enum con la #12080—, **nada distingue en pantalla una solicitud del canal de un SOAT nacido de un
 * trámite**. No se añade columna —la cola ya es densa, el gestor las trabaja igual y ningún AC la
 * pide—; queda preguntado al PO, con `tramitesFlit` vacío como señal ya disponible si algún día se
 * decide.
 */
export const ESTADOS_CLIENTE: EstadoSoat[] = [
  EstadoSoat.PENDIENTE, EstadoSoat.SOLICITADO, EstadoSoat.CON_NOVEDAD, EstadoSoat.PAGADO,
];
