// Historial de cambios de estado de SOAT e impuestos.
//
// Los trámites tienen `flito_tramite_historial` desde el principio. SOAT e impuestos no tenían nada
// equivalente: su rastro vivía en `audit_logs`, en texto libre, con la transición metida dentro de
// una frase —«Envío al gestor (pendiente→solicitado).»— y sin campos que consultar. Eso servía para
// una auditoría de cumplimiento, pero no para responder «¿por qué este impuesto sigue solicitado?»,
// que es la pregunta que se hace a diario.
//
// Vive en `shared/` y no dentro de un módulo porque lo escriben tres (`flito-soat`,
// `flito-impuestos` y el conciliador de recibos) y colgarlo de cualquiera de ellos crearía una
// dependencia entre módulos hermanos.

import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoEstadoHistorial, users } from '../../db/schema.js';

/** Los dos conceptos que comparten los cuatro estados de `EstadoSoat`/`EstadoImpuesto`. */
export const ConceptoHistorial = { SOAT: 'soat', IMPUESTO: 'impuesto' } as const;
export type ConceptoHistorial = (typeof ConceptoHistorial)[keyof typeof ConceptoHistorial];

/**
 * Quién hizo el cambio. `sistema` es para lo que ocurre sin persona detrás —el sync que da de alta,
 * el cron que concilia— y no es lo mismo que «no se sabe»: distinguirlos evita que un cambio
 * automático parezca un descuido de alguien.
 */
export type OrigenCambio = 'usuario' | 'sistema';

export interface Cambio {
  concepto: ConceptoHistorial;
  registroId: string;
  /** Null solo en el alta. En un cambio, omitirlo esconde justo lo que se quiere ver. */
  estadoAnterior: string | null;
  estadoNuevo: string;
  /** El motivo del rechazo, la reversa o el detalle de la conciliación. */
  motivo?: string | null;
  usuarioId?: number | null;
  usuarioEmail?: string | null;
  origen?: OrigenCambio;
}

/** Cualquier cosa con `.insert()`: la conexión o una transacción abierta. */
type Ejecutor = Pick<typeof db, 'insert'>;

/**
 * Registra un cambio. Recibe el ejecutor para poder participar de la transacción que ya cambió el
 * estado: el historial y el estado tienen que entrar o quedarse fuera juntos, porque un estado sin
 * su fila de historial es exactamente el agujero que esto viene a tapar.
 *
 * Por eso NO lleva try/catch. `audit()` se traga sus errores —una auditoría caída no debe tumbar la
 * petición— pero aquí el criterio es el contrario: si el historial no se puede escribir, el cambio
 * de estado tampoco debe confirmarse.
 */
export async function registrarCambio(ex: Ejecutor, c: Cambio): Promise<void> {
  await ex.insert(flitoEstadoHistorial).values({
    concepto: c.concepto,
    registroId: c.registroId,
    estadoAnterior: c.estadoAnterior,
    estadoNuevo: c.estadoNuevo,
    motivo: c.motivo ?? null,
    usuarioId: c.usuarioId ?? null,
    usuarioEmail: c.usuarioEmail ?? null,
    origen: c.origen ?? 'usuario',
  });
}

/**
 * Varios cambios de una vez, para las operaciones en lote. Un solo INSERT y no N: enviar cincuenta
 * impuestos al gestor no debe costar cincuenta viajes a la base.
 */
export async function registrarCambios(ex: Ejecutor, cambios: Cambio[]): Promise<void> {
  if (cambios.length === 0) return;
  await ex.insert(flitoEstadoHistorial).values(cambios.map((c) => ({
    concepto: c.concepto,
    registroId: c.registroId,
    estadoAnterior: c.estadoAnterior,
    estadoNuevo: c.estadoNuevo,
    motivo: c.motivo ?? null,
    usuarioId: c.usuarioId ?? null,
    usuarioEmail: c.usuarioEmail ?? null,
    origen: c.origen ?? 'usuario',
  })));
}

export interface ItemHistorial {
  id: number;
  estadoAnterior: string | null;
  estadoNuevo: string;
  motivo: string | null;
  usuario: string | null;
  origen: string;
  creadoEn: string;
}

/**
 * Cómo se nombra al actor cuando quien lee no tiene derecho a su identidad (Feature #11912).
 *
 * Es el NOMBRE DE LA EMPRESA, no un `null`. Un null habría hecho que la interfaz pintara «Usuario
 * desconocido» (`HistorialEstados.tsx`), que es falso: el usuario se conoce y está registrado, lo
 * que pasa es que quien mira no tiene por qué saber cuál. «FLITO» dice la verdad completa que le
 * corresponde a una empresa cliente: esto lo movió su proveedor de servicio.
 */
export const AUTOR_INTERNO_ANONIMO = 'FLITO';

export interface OpcionesHistorial {
  /**
   * true → quien lee esta respuesta NO es de FLIT, así que la fila se sirve recortada: el actor sale
   * como `AUTOR_INTERNO_ANONIMO` y `motivo` sale `null`.
   *
   * Lo enciende `GET /flito/soat/:id/historial` cuando quien pregunta es el rol `cliente`. Es UN
   * interruptor y no dos porque la pregunta que responde es una sola —«¿esto lo lee alguien de
   * fuera?»— y el día que se añada un tercer campo interno a `ItemHistorial` conviene que se recorte
   * por el mismo sitio, sin que nadie tenga que acordarse de encender un flag nuevo.
   *
   * ── Por qué el ACTOR se sustituye y el MOTIVO se calla ──────────────────────────────────────────
   *
   * `usuario` traía el nombre —o, si el usuario ya no existe, el CORREO CORPORATIVO— del empleado de
   * FLIT que tocó el registro: dato personal de un trabajador entregado a una empresa tercera. Se
   * sustituye porque el hueco tiene respuesta honesta: lo movió FLITO.
   *
   * `motivo` no la tiene. Es TEXTO LIBRE escrito por un empleado para lectores internos, y además lo
   * componen las plantillas de `flito-soat.service.ts`, que hasta esta corrección metían ahí el
   * importe pagado y el uuid del proveedor —tres de los cinco campos que el DTO del cliente quita—.
   * Vaciar las plantillas era necesario pero no suficiente: lo que un gestor escribe a mano en un
   * rechazo o en una reversa («se lo quitamos a X porque no responde») no lo sanea ninguna plantilla.
   *
   * ── La alternativa que se descartó, y por qué ───────────────────────────────────────────────────
   *
   * Se valoró servirle al cliente un motivo ACOTADO A UN CATÁLOGO de códigos en vez de callarlo. Se
   * descarta porque ese catálogo ya existe y no es este: lo que el cliente tiene que poder leer es
   * la causal de rechazo de SU solicitud, y eso vive en `flito_soat_causales_rechazo` +
   * `flito_soat_solicitud.observacion_rechazo`, que sirve la HU #11915 por su propia ruta. Inventar
   * aquí un segundo catálogo daría dos maneras de responder la misma pregunta y ninguna completa;
   * además obligaría a codificar los ~8 puntos de llamada de `registrarCambio` para una audiencia
   * que hoy no lee ninguno.
   *
   * Lo que el cliente conserva es la línea de tiempo entera: qué estado, desde cuál, cuándo y que lo
   * movió FLITO.
   *
   * ── Corrección de una frase que estuvo aquí y era FALSA (HU #11915) ─────────────────────────────
   *
   * Decía que «el motivo del rechazo del gestor le sigue llegando por `motivoRechazo` en el DTO del
   * detalle … lo necesita la #11915 para subsanar». **No lo necesita, y creerlo lleva a escribir el
   * rechazo del canal en la columna equivocada.** `flito_soat.motivo_rechazo` es el rechazo del
   * GESTOR, el que lleva a `con_novedad` (`rechazar()` en `flito-soat.service.ts`): otro actor, otro
   * estado destino y otra audiencia. El rechazo del ADMIN sobre una solicitud del canal va a
   * `flito_soat_solicitud` —causal del catálogo general + observación— y le llega al Cliente por el
   * bloque `solicitud` del detalle, con su propia proyección por rol. La HU #11915 no lee ni escribe
   * `motivo_rechazo` en ninguna parte.
   *
   * Desde la HU #11914 el `cliente` radica, así que sus PROPIAS acciones ya aparecen en este
   * historial y habrá que distinguirlas cuando la pantalla quiera hacerlo: la fila guarda
   * `usuario_id`, así que se resuelve ahí, no aquí.
   */
  lectorExterno?: boolean;
}

/**
 * Historial de un registro, del cambio más reciente al más antiguo — el orden en que se consulta:
 * lo que se quiere saber es qué pasó ÚLTIMO, y solo después cómo se llegó ahí.
 *
 * La consulta es la MISMA para todos y lo que cambia es la proyección: el `leftJoin` con `users` se
 * conserva porque esta función también sirve a impuestos y partirla en dos daría dos consultas que
 * mantener. Ni el nombre ni el motivo salen del proceso cuando quien lee es de fuera — ver
 * `OpcionesHistorial`.
 */
export async function historialDe(
  concepto: ConceptoHistorial, registroId: string, opciones: OpcionesHistorial = {},
): Promise<ItemHistorial[]> {
  const filas = await db.select({
    id: flitoEstadoHistorial.id,
    estadoAnterior: flitoEstadoHistorial.estadoAnterior,
    estadoNuevo: flitoEstadoHistorial.estadoNuevo,
    motivo: flitoEstadoHistorial.motivo,
    origen: flitoEstadoHistorial.origen,
    // El nombre del usuario si sigue existiendo; si no, el correo copiado en su momento.
    usuarioNombre: users.name,
    usuarioEmail: flitoEstadoHistorial.usuarioEmail,
    creadoEn: flitoEstadoHistorial.createdAt,
  }).from(flitoEstadoHistorial)
    .leftJoin(users, eq(flitoEstadoHistorial.usuarioId, users.id))
    .where(and(
      eq(flitoEstadoHistorial.concepto, concepto),
      eq(flitoEstadoHistorial.registroId, registroId),
    ))
    .orderBy(desc(flitoEstadoHistorial.createdAt), desc(flitoEstadoHistorial.id));

  return filas.map((f) => ({
    id: f.id,
    estadoAnterior: f.estadoAnterior,
    estadoNuevo: f.estadoNuevo,
    // Los dos recortes van juntos y a la vista, no repartidos: son la misma decisión.
    motivo: opciones.lectorExterno ? null : f.motivo,
    usuario: opciones.lectorExterno ? AUTOR_INTERNO_ANONIMO : (f.usuarioNombre ?? f.usuarioEmail),
    origen: f.origen,
    creadoEn: f.creadoEn.toISOString(),
  }));
}
