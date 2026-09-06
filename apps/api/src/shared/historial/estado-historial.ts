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

/**
 * La imagen ESPEJO del anterior (HU #12078): cómo se nombra al actor cuando la fila la movió un
 * empleado de la COMPAÑÍA CLIENTE y quien lee no es de esa compañía.
 *
 * Mismo criterio que `AUTOR_INTERNO_ANONIMO` y por eso mismo no es `null`: la fila la movió alguien
 * y se sabe quién; lo que pasa es que a este lector no le corresponde el nombre de un trabajador de
 * otra empresa. Decirlo así conserva la única parte que sí le sirve —de qué lado vino el cambio— sin
 * entregar a la persona.
 */
export const AUTOR_COMPANIA_ANONIMO = 'La compañía';

/**
 * El único rol de `USER_ROLES` que pertenece a una COMPAÑÍA CLIENTE (Feature #11912).
 *
 * No es «el único rol externo a FLIT»: `proveedor` —el gestor— también es de otra empresa, y es
 * justamente quien LEE en el caso que motiva este recorte. Lo que distingue a `cliente` es de qué
 * lado del encargo está: el gestor y FLIT trabajan la solicitud, la compañía la radica.
 */
const ROL_COMPANIA_CLIENTE = 'cliente';

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
   * descarta porque codificar los ~8 puntos de llamada de `registrarCambio` para una audiencia que
   * hoy no lee ninguno es trabajo a cuenta de una necesidad que nadie ha expresado — y porque el
   * motivo, tal como se escribe, no es un código: es una frase que un empleado redacta sobre un caso.
   *
   * **Aquí decía otra cosa hasta la HU #12080**, y conviene dejar dicho qué se cayó: el argumento
   * era «ese catálogo ya existe y no es este — lo que el cliente tiene que poder leer es la causal de
   * rechazo de SU solicitud, en `flito_soat_causales_rechazo` + `flito_soat_solicitud.
   * observacion_rechazo`». Esas dos cosas ya no existen (Feature #12074, migración 0176): el canal no
   * tiene revisión, así que no hay ningún rechazo de Operaciones que rotular. El corte se mantiene
   * por su primera razón, que nunca dependió de aquel catálogo: el motivo es texto libre interno.
   *
   * Lo que el cliente conserva es la línea de tiempo entera: qué estado, desde cuál, cuándo y que lo
   * movió FLITO.
   *
   * ── `flito_soat.motivo_rechazo` es del GESTOR, y sigue siéndolo ─────────────────────────────────
   *
   * Merece decirse porque la confusión ya costó una corrección: esa columna es el rechazo del GESTOR,
   * el que lleva a `con_novedad` (`rechazar()` en `flito-soat.service.ts`), y no tiene nada que ver
   * con el rechazo del ADMIN que hubo entre la #11915 y la #12080. Aquel se escribía en
   * `flito_soat_solicitud` y hoy no se escribe en ninguna parte. `POST /:id/rechazar` no cambia.
   *
   * Desde la HU #11914 el `cliente` radica, así que sus PROPIAS acciones ya aparecen en este
   * historial y habrá que distinguirlas cuando la pantalla quiera hacerlo: la fila guarda
   * `usuario_id`, así que se resuelve ahí, no aquí.
   */
  lectorExterno?: boolean;

  /**
   * true → el actor se NOMBRA solo si consta que NO es de la compañía cliente. El resto de la fila
   * —el estado, el motivo, la fecha— no se toca: esto NO es `lectorExterno` en pequeño.
   *
   * ── El agujero que cierra (HU #12078, segunda puerta del bloqueante) ────────────────────────────
   *
   * `GET /flito/soat/:id/historial` es la MISMA respuesta para el admin y para el gestor del
   * proveedor. Antes de la #12078 eso no entregaba nada de nadie: una solicitud del canal Cliente
   * nacía en `pendiente_revision`, estado que no está en `ESTADOS_SOAT_VISIBLES_GESTOR`, así que
   * `buscarConAcceso` le devolvía 404 y la fila de historial que escribe el RADICADOR —con su
   * `usuarioId` y su `usuarioEmail`— era inalcanzable para él. Desde la #12078 la solicitud nace en
   * `solicitado` y entra derecha a su cola: **la HU no creó el endpoint, le quitó el cerrojo**. Por
   * ahí salía el mismo nombre que el DTO acababa de recortar (`enviadoPorNombreVisible`), un endpoint
   * más allá, y con el CORREO CORPORATIVO como alternativa cuando el usuario ya no existe, que es
   * peor: un identificador con el que se puede escribir a la persona.
   *
   * ── Por qué NO se resolvió encendiendo `lectorExterno` para el rol `proveedor` ──────────────────
   *
   * Porque ese interruptor recorta por ROL y vale para la respuesta entera, y el gestor no es un
   * lector externo en el mismo sentido que el `cliente`: FLIT le encarga el trabajo, y saber QUÉ
   * PERSONA de FLIT le devolvió un SOAT o se lo reasignó es su interlocutor legítimo. Encenderlo le
   * dejaría todas las filas de trámite —el 100 % de lo que hay hoy— con «FLITO» y sin motivo. Sería
   * una amputación, no una proyección.
   *
   * Este recorte es POR FILA y mira quién la escribió, no quién la lee. Lo enciende
   * `historialConAcceso` solo para el gestor Y solo sobre una solicitud de `origen = 'cliente'`: la
   * misma condición doble de `enviadoPorNombreVisible`, y por eso el historial de un SOAT de trámite
   * le llega byte a byte como antes.
   *
   * ── Los cuatro desenlaces, y ninguno es un descuido ────────────────────────────────────────────
   *
   *   · Actor con rol conocido distinto de `cliente` → se nombra. Es de FLIT o del propio proveedor
   *     que lee: en los dos casos, alguien de su lado del encargo.
   *   · Actor `cliente` → `AUTOR_COMPANIA_ANONIMO`.
   *   · Actor con nombre o correo pero SIN rol → tampoco se nombra, y sale `null`. `usuario_id` es
   *     `ON DELETE SET NULL`, así que borrar al usuario deja la fila con el `usuario_email` copiado y
   *     sin forma de saber de qué lado estaba: si se emitiera «por si acaso es de FLIT», bastaría
   *     dar de baja al radicador para que su correo volviera a salir. `null` —«Usuario desconocido»
   *     en la pantalla— es lo que esa fila puede afirmar de verdad, y no se disfraza de compañía
   *     porque eso sí sería inventarse un lado.
   *   · Fila SIN actor (`origen: 'sistema'`, o un `usuario_id` que nunca hubo) → `null`, que es
   *     exactamente lo que devuelve hoy. Un cron no se etiqueta como «La compañía».
   */
  ocultarActoresDelCliente?: boolean;
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
    // De qué LADO estaba quien movió la fila. No se emite nunca —no es un campo del DTO— y solo se
    // consulta para decidir `ocultarActoresDelCliente`. Sale del mismo `leftJoin` que ya estaba, así
    // que no añade ni una consulta ni cambia el plan; `null` cuando el usuario ya no existe.
    usuarioRol: users.role,
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
    usuario: actorVisible(f, opciones),
    origen: f.origen,
    creadoEn: f.creadoEn.toISOString(),
  }));
}

/** Lo que el historial guarda del actor, antes de decidir si se nombra. */
type ActorFila = { usuarioNombre: string | null; usuarioEmail: string | null; usuarioRol: string | null };

/**
 * Cómo se nombra al actor de UNA fila para ESTE lector. Los dos recortes conviven aquí y no se
 * anidan: `lectorExterno` mira a quién LEE y vale para toda la respuesta;
 * `ocultarActoresDelCliente` mira quién ESCRIBIÓ cada fila. El porqué de cada uno, en
 * `OpcionesHistorial`.
 */
function actorVisible(f: ActorFila, opciones: OpcionesHistorial): string | null {
  // El nombre del usuario si sigue existiendo; si no, el correo copiado en su momento. Es el valor
  // de siempre, y el que los dos recortes tapan.
  const actor = f.usuarioNombre ?? f.usuarioEmail;
  if (opciones.lectorExterno) return AUTOR_INTERNO_ANONIMO;
  if (!opciones.ocultarActoresDelCliente) return actor;
  // Una fila sin actor no tiene a quién ocultar: `origen: 'sistema'` sigue saliendo `null`, y no se
  // convierte en «La compañía» por pasar por aquí.
  if (actor === null) return null;
  if (f.usuarioRol === ROL_COMPANIA_CLIENTE) return AUTOR_COMPANIA_ANONIMO;
  // Rol desconocido = usuario dado de baja (`ON DELETE SET NULL`). No consta de qué lado estaba, así
  // que no se nombra: lo contrario haría del borrado de un usuario la forma de sacar su correo.
  return f.usuarioRol ? actor : null;
}
