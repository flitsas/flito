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
   * true → el actor sale como `AUTOR_INTERNO_ANONIMO` en vez de con su nombre o su correo.
   *
   * Lo enciende `GET /flito/soat/:id/historial` cuando quien pregunta es el rol `cliente`: cada fila
   * llevaba el nombre —o, si el usuario ya no existe, el CORREO CORPORATIVO— del empleado de FLIT
   * que tocó el registro, y eso es dato personal de trabajadores entregado a una empresa tercera.
   * Los 11 roles internos no pasan por aquí y ven exactamente lo de siempre.
   *
   * Cuando la HU #11914 deje al `cliente` radicar, sus PROPIAS acciones aparecerán en este historial
   * y habrá que distinguirlas: la fila guarda `usuario_id`, así que se resuelve ahí, no aquí.
   */
  omitirUsuario?: boolean;
}

/**
 * Historial de un registro, del cambio más reciente al más antiguo — el orden en que se consulta:
 * lo que se quiere saber es qué pasó ÚLTIMO, y solo después cómo se llegó ahí.
 *
 * La consulta es la MISMA para todos y lo que cambia es la proyección: el `leftJoin` con `users` se
 * conserva porque esta función también sirve a impuestos y partirla en dos daría dos consultas que
 * mantener. El nombre no sale del proceso — que es lo que el art. 17 de la Ley 1581 protege.
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
    motivo: f.motivo,
    usuario: opciones.omitirUsuario ? AUTOR_INTERNO_ANONIMO : (f.usuarioNombre ?? f.usuarioEmail),
    origen: f.origen,
    creadoEn: f.creadoEn.toISOString(),
  }));
}
