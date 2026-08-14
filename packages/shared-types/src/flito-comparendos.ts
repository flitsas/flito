// FLITO — Monitoreo de comparendos: catálogos de parametrización (Feature #11492 17a, HU #11497),
// metadatos del token SIMIT (HU #11498), resultado de la sincronización (HU #11500) y lectura del
// registro consolidado con su timeline (HU #11502).
//
// Lo que este archivo NO declara, y es deliberado: `PageSlug` del módulo y los contratos del export
// a Excel son de 17b, y el PATCH de gestión (causal/observación) también. Publicar hoy el tipo de
// algo que ningún endpoint responde invita a que la pantalla se escriba contra una forma que aún
// puede cambiar.
//
// Las fechas viajan como cadena ISO-8601 y no como `Date`: este paquete lo comparten el servidor y
// el navegador, y `JSON.parse` nunca devuelve un `Date`. Tiparlo como `Date` sería mentirle al
// compilador justo del lado que más lo necesita.

/**
 * NIT monitoreado (CF-01).
 *
 * `nit` es la llave con la que se le pregunta a los proveedores, así que se guarda ya normalizado
 * —sin puntos ni espacios— y no se edita: se desactiva. `alias` es solo para reconocerlo en pantalla
 * cuando el número no le dice nada a nadie.
 */
export interface ComparendosNit {
  id: string;
  nit: string;
  alias: string | null;
  activo: boolean;
  creadoEn: string;
  actualizadoEn: string;
}

/**
 * Municipio fuente (CF-02).
 *
 * `codigoFuente` es el valor literal que viaja en `?fuente=` a UTS (mayúsculas sin tildes) y
 * `nombre` es lo que se le enseña a un humano. Son dos columnas y no una porque el proveedor espera
 * `ITAGUI`: corregir la ortografía a «Itagüí» sobre un único campo rompería la integración.
 */
export interface ComparendosMunicipio {
  id: string;
  codigoFuente: string;
  nombre: string;
  activo: boolean;
  creadoEn: string;
  actualizadoEn: string;
}

/**
 * Causal de gestión (CF-04). El catálogo es de 17a; quien la asigna a un comparendo es 17b.
 *
 * `orden` existe para que la lista se presente en la secuencia natural de la gestión y no
 * alfabéticamente, que es lo que pasaría dejándolo al nombre.
 */
export interface ComparendosCausal {
  id: string;
  nombre: string;
  activo: boolean;
  orden: number;
  creadoEn: string;
  actualizadoEn: string;
}

/**
 * Token SIMIT: lo ÚNICO que el API cuenta sobre él (CF-03, ADR-0002).
 *
 * Aquí no hay ni habrá un campo con el token, ni enmascarado ni con un prefijo: un fragmento sigue
 * siendo material de la credencial. El `PUT` lo recibe una vez, lo cifra y responde con esta misma
 * forma; el `GET` responde esto y nada más. Lo que la pantalla necesita saber es si está
 * configurado, quién lo tocó por última vez y cuándo — no cuál es.
 *
 * `actualizadoPor` es `null` cuando no hay token todavía y también cuando la fila no tiene autor
 * conocido (un token sembrado por operación, sin `updated_by`): la pantalla debe saber pintar «—»
 * sin dar por hecho que siempre hay un nombre. `keyVersion` viaja para que, cuando se rote
 * `COMPARENDOS_ENC_KEY`, se vea desde la propia pantalla si el token guardado ya está bajo la nueva.
 */
export interface ComparendosTokenSimitMeta {
  configurado: boolean;
  actualizadoEn: string | null;
  actualizadoPor: { id: number; nombre: string } | null;
  keyVersion: number | null;
}

// ─────────────────────────── Sincronización (CF-05/CF-06, HU #11500) ────────────────────────────

/**
 * Estado de una corrida.
 *
 * `partial` no es un estado de conveniencia: es la respuesta honesta a «hubo datos, pero no de
 * todas las fuentes». La pantalla debe distinguirlo de `completed` porque con cobertura incompleta
 * hay NITs cuyos comparendos NO se inactivaron aunque parezcan ausentes (CF-10).
 */
export type ComparendosSyncEstado = 'running' | 'completed' | 'partial' | 'failed';

/** `mock` = los adapters devolvieron datos fabricados sin tocar la red (`COMPARENDOS_SIMIT_MODE`). */
export type ComparendosSyncModo = 'mock' | 'real';

/**
 * Contadores de la corrida. Se persisten tal cual en `flito_comparendos_sync_runs.resumen`.
 *
 * `modo` viaja aquí y no como un campo suelto para que quede GUARDADO junto a los contadores: dentro
 * de seis meses, mirando una corrida vieja, la primera pregunta ante un número raro es si aquello
 * fue una simulación.
 *
 * `nitsSinInactivacion` es el contador que más se mira cuando algo «no cuadra»: son los NITs que
 * perdieron alguna fuente y a los que, por eso, no se les inactivó nada (CF-10).
 */
export interface ComparendosSyncResumen {
  modo: ComparendosSyncModo;
  nitsProcesados: number;
  llamadasSimitOk: number;
  llamadasSimitError: number;
  llamadasMunicipalOk: number;
  llamadasMunicipalError: number;
  /** Registros insertados o actualizados por el merge. */
  upserts: number;
  inactivados: number;
  reactivados: number;
  primeraLlegada: number;
  /** Ítems descartados por no traer un número de comparendo reconocible (pista para el spike). */
  itemsIgnorados: number;
  nitsSinInactivacion: number;
  /**
   * La corrida se cortó en su deadline y quedaron NITs del alcance sin consultar.
   *
   * No es un fallo del proveedor: es el corte que garantiza que la corrida no sobreviva a su propio
   * lock (una corrida más larga que su lock deja entrar a una segunda, y dos corridas simultáneas se
   * inactivan comparendos la una a la otra). Con esto en `true`, los ceros de la corrida no
   * significan «no había nada», significan «no se llegó a mirar».
   */
  abortadaPorTiempo: boolean;
  /**
   * Por qué NO se ejecutó el barrido de inactivación, o `null` si sí se ejecutó.
   *
   * `'deadline'` — la corrida se cortó por tiempo y no se apaga nada a medias.
   * `'umbral'`   — el barrido superaba el tope de filas o de porcentaje de activos configurado
   *                (`COMPARENDOS_INACTIVACION_MAX_FILAS` / `_MAX_RATIO`): es el freno contra el
   *                proveedor que responde 200 con lista vacía y apagaría el histórico entero.
   *
   * Distinto de `nitsSinInactivacion`, que cuenta NITs sin cobertura completa: aquí no se inactivó
   * NADA de NINGÚN NIT.
   */
  inactivacionOmitida: 'deadline' | 'umbral' | null;
}

/**
 * Un paso = una llamada a una fuente para un NIT. Es la unidad de fallo parcial del CF-10.
 *
 * `mensaje` viene de los errores tipados del módulo, que se construyen sin token, sin cabeceras y
 * sin PII: esta cadena se persiste y se muestra.
 */
export interface ComparendosSyncStep {
  nit: string;
  /** `'simit'` o el `codigoFuente` del municipio. */
  fuente: string;
  ok: boolean;
  /** Código HTTP del PROVEEDOR. `null` en modo simulado o cuando no hubo respuesta. */
  httpStatus: number | null;
  errorCode: string | null;
  mensaje: string | null;
  itemsLeidos: number | null;
  duracionMs: number | null;
}

/** Corrida sin sus pasos: lo que devuelve el listado `GET /sync/runs`. */
export interface ComparendosSyncRun {
  runId: string;
  estado: ComparendosSyncEstado;
  iniciadoEn: string;
  /** `null` mientras la corrida está en marcha. */
  finalizadoEn: string | null;
  scopeNits: string[];
  /** `null` en una corrida que aún no terminó (o que murió sin cerrarse). */
  resumen: ComparendosSyncResumen | null;
  iniciadoPor: number | null;
}

/** Respuesta de `POST /sync` y de `GET /sync/runs/:id`: la corrida con el detalle por fuente. */
export interface ComparendosSyncResultado extends ComparendosSyncRun {
  steps: ComparendosSyncStep[];
}

/** Cuerpo de `POST /sync`. Sin `nits` (u omitido) = todos los NITs activos del catálogo. */
export interface ComparendosSyncRequest {
  nits?: string[];
}

// ─────────────────────── Registro consolidado y timeline (CF-09/CF-11, HU #11502) ────────────────

/**
 * Estado de MONITOREO del registro, que no es su estado ante la autoridad.
 *
 * `inactivo` significa «las fuentes dejaron de reportarlo con cobertura completa» (CF-10), no
 * «pagado» ni «resuelto»: lo que el proveedor dice del comparendo viaja en `estadoFuente`, que es
 * texto libre del proveedor y por eso no está enumerado.
 */
export type ComparendosRegistroEstado = 'activo' | 'inactivo';

/** Qué fuentes han visto el comparendo alguna vez. Lo calcula el merge, no el proveedor (CF-08). */
export type ComparendosOrigenMerge = 'simit' | 'municipal' | 'ambos';

/**
 * Un comparendo consolidado, tal como lo devuelve `GET /registros` (CF-09).
 *
 * **Todo lo de arriba de `estado` es dato de FUENTE y es de solo lectura**: lo escribe el sync y no
 * hay endpoint que lo edite (RN-04). Lo único que 17b podrá tocar es `causalId` y `observacion`.
 *
 * Aquí NO viajan `payload_simit` ni `payload_municipal`. Son la materia prima del spike de
 * homologación y viven en la base (podados a la lista blanca del `field_map` desde la HU #11511);
 * sacarlos por el API sería devolver la respuesta cruda de un tercero sobre un tercero sin que
 * ninguna pantalla lo necesite.
 *
 * `monto` es una CADENA decimal y no un `number`: la columna es `numeric(14,2)` y pasarla por el
 * `double` de JavaScript es exactamente cómo un importe pierde el último centavo. Se formatea para
 * mostrar; no se suma en el cliente.
 */
export interface ComparendoRegistro {
  id: string;
  /** Llave de negocio: única en el país (CF-07). Normalizada en mayúsculas y sin espacios. */
  numeroComparendo: string;
  /** El NIT con el que se PREGUNTÓ, no el del infractor. */
  nitMonitoreado: string;
  placa: string | null;
  codigoInfraccion: string | null;
  descripcionInfraccion: string | null;
  /** `YYYY-MM-DD` (la columna es `date`, sin hora), o `null` si ninguna fuente la trajo. */
  fechaComparendo: string | null;
  organismo: string | null;
  /** `codigoFuente` del municipio donde se vio, o `null` si solo lo reportó SIMIT. */
  municipioFuente: string | null;
  monto: string | null;
  /** Estado que reporta el proveedor, tal cual. Texto libre: no se enumera ni se traduce. */
  estadoFuente: string | null;
  origenMerge: ComparendosOrigenMerge;
  vistoEnSimit: boolean;
  vistoEnMunicipal: boolean;
  estado: ComparendosRegistroEstado;
  primeraVistoEn: string;
  ultimoVistoEn: string;
  /** Cuándo se apagó por ausencia. `null` mientras está activo. */
  inactivadoEn: string | null;
  /** Corrida que lo tocó por última vez: el puente al detalle de `GET /sync/runs/:id`. */
  ultimoSyncRunId: string | null;
  /** Gestión de 17b. En 17a siempre llegan como los dejó el alta, porque nadie los escribe todavía. */
  causalId: string | null;
  observacion: string | null;
  creadoEn: string;
  actualizadoEn: string;
}

/** Qué le pasó al registro. Los tres los escribe el sync; ninguno se crea a mano (CF-11). */
export type ComparendosEventoTipo = 'primera_llegada' | 'inactivacion' | 'reaparicion';

/**
 * Una entrada del timeline (CF-11).
 *
 * `detalle` es el contexto mínimo del evento —`{ origen }` en el alta y la reaparición,
 * `{ motivo }` en la inactivación— y por RN-20 no lleva NIT, placa ni nada del proveedor: el
 * registro al que apunta ya tiene esos datos.
 */
export interface ComparendoEvento {
  id: string;
  tipo: ComparendosEventoTipo;
  /** Corrida que lo produjo. `null` solo en filas anteriores a que se registrara la corrida. */
  syncRunId: string | null;
  detalle: Record<string, unknown> | null;
  ocurridoEn: string;
}

/** `GET /registros/:id`: el registro con su timeline completo, del evento más reciente al más viejo. */
export interface ComparendoRegistroDetalle extends ComparendoRegistro {
  eventos: ComparendoEvento[];
}

/**
 * Filtros de `GET /registros` (CF-09).
 *
 * `nit` y `placa` son coincidencia EXACTA sobre el valor normalizado (el NIT sin puntos, la placa
 * en mayúsculas y sin guiones): son identificadores, y una búsqueda parcial sobre un identificador
 * es una forma de barrer datos personales de a poco. `q` sí es parcial, pero solo sobre el NÚMERO
 * de comparendo, que no identifica a una persona.
 */
export interface ComparendosRegistrosFiltro {
  estado?: ComparendosRegistroEstado;
  nit?: string;
  placa?: string;
  /** Fragmento del número de comparendo (mínimo 3 caracteres). */
  q?: string;
  limit?: number;
  cursor?: string;
}

/**
 * Página de registros. Paginación por CURSOR, no por `offset`.
 *
 * El motivo es el sync: entre dos páginas puede entrar una corrida e insertar filas, y con `offset`
 * eso desplaza la ventana y hace que un registro se repita —o, peor, que se salte— sin que nadie lo
 * note. El cursor es opaco a propósito: se manda tal cual llegó y no se construye en el cliente.
 *
 * `nextCursor` en `null` significa que no hay más páginas; es `null` y no ausente para que la
 * pantalla no tenga que distinguir «no vino» de «se acabó».
 */
export interface ComparendosRegistrosPagina {
  items: ComparendoRegistro[];
  nextCursor: string | null;
}
