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
 * Historial de un registro, del cambio más reciente al más antiguo — el orden en que se consulta:
 * lo que se quiere saber es qué pasó ÚLTIMO, y solo después cómo se llegó ahí.
 */
export async function historialDe(concepto: ConceptoHistorial, registroId: string): Promise<ItemHistorial[]> {
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
    usuario: f.usuarioNombre ?? f.usuarioEmail,
    origen: f.origen,
    creadoEn: f.creadoEn.toISOString(),
  }));
}
