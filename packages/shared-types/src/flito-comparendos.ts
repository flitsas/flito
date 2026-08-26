// FLITO — Monitoreo de comparendos: catálogos de parametrización (Feature #11492 17a, HU #11497),
// metadatos del token SIMIT (HU #11498), resultado de la sincronización (HU #11500) y lectura del
// registro consolidado con su timeline (HU #11502). Los filtros de listado por municipio, fuente y
// causal son de 17b (Feature #11495, HU #11555) y se añadieron sobre `ComparendosRegistrosQuery`.
//
// El PATCH de gestión —`ComparendosGestionPatch` y `COMPARENDOS_OBSERVACION_MAX`— es de 17b y se
// publica desde la HU #11557, que es la que expone el endpoint que lo consume.
//
// `ComparendoRegistro.gestionActualizadaPor` cambió de forma en la HU #11562 (de `number` a
// `{ id, nombre }`): el porqué está en su propio comentario, y es el único cambio incompatible que
// este archivo ha tenido.
//
// El export a Excel —`ComparendosExportRequest` y `COMPARENDOS_EXPORT_MAX_FILAS`— es de la HU
// #11558 y está al final del archivo, publicado desde la HU que expone el endpoint que lo consume.
// (`PageSlug` del módulo no está aquí por otro motivo: el catálogo de páginas vive en
// `permissions.ts`, y lo añadió la HU #11559.)
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
 * Qué es la fila HOY ante la autoridad: un comparendo, o la multa en que ese comparendo se
 * convirtió (HU #11712).
 *
 * Los dos endpoints devuelven las dos cosas en la misma lista y lo que las distingue es el número
 * de resolución: sin resolución sigue siendo comparendo, con resolución ya es multa. Lo deriva el
 * merge de lo que dijeron las fuentes; **no lo dice ningún campo del proveedor** y no se puede
 * inferir de `estadoFuente`, que es texto crudo sin normalizar.
 *
 * El tipo se usa siempre junto a su `| null`, y ese `null` es la mitad importante del contrato —ver
 * {@link ComparendoRegistro.tipoRegistro}—.
 */
export type ComparendosTipoRegistro = 'comparendo' | 'multa';

/**
 * Un comparendo consolidado, tal como lo devuelven `GET /registros` y `POST /registros/buscar`
 * (CF-09). Las dos rutas devuelven exactamente esta forma; lo único que cambia entre ellas es por
 * dónde entran los filtros de identidad.
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
  /**
   * `YYYY-MM-DD` (la columna es `date`, sin hora), o `null` si ninguna fuente la trajo.
   *
   * Desde la HU #11794 **`null` también es lo que se publica cuando la fuente mandó el centinela
   * `01/01/1900`**, que significa «no notificado» y no «ocurrió en 1900». Es un cambio de salida:
   * las filas que ya se habían guardado con `1900-01-01` siguen así hasta que un sync las vuelva a
   * visitar, así que el visor tiene que saber pintar las dos cosas mientras dure esa convivencia.
   */
  fechaComparendo: string | null;
  /**
   * `YYYY-MM-DD` de la NOTIFICACIÓN del comparendo, o `null` (HU #11794).
   *
   * `null` significa **«no notificado o no se sabe»**, y las dos cosas caben en el mismo nulo porque
   * ninguna de las dos fuentes las distingue: el proveedor manda el centinela `01/01/1900` tanto
   * cuando el comparendo no se ha notificado como cuando no publica la fecha. Ese centinela **no se
   * persiste**; llega aquí como `null`.
   *
   * Y `null` es además lo que devuelve TODO el histórico anterior a la migración 0164, sin backfill:
   * el dato no está ni en las columnas ni en `payload_*` —la v3 del mapa no lo nombraba y RN-25 lo
   * podaba—, así que solo se llena en el siguiente sync de cada fila. Consecuencia para el visor: la
   * ausencia se pinta como «sin dato», nunca como una fecha por defecto.
   *
   * Dato de FUENTE y de solo lectura (CF-09): no hay endpoint que lo edite.
   */
  fechaNotificacion: string | null;
  organismo: string | null;
  /** `codigoFuente` del municipio donde se vio, o `null` si solo lo reportó SIMIT. */
  municipioFuente: string | null;
  monto: string | null;
  /**
   * Estado que reporta el proveedor, tal cual. Texto libre: no se enumera ni se traduce.
   *
   * Desde el mapa v3 (HU #11712) la cadena de candidatos cruza tres vocabularios del proveedor
   * —comparendo, cartera y pago—, así que dos filas pueden traer estados de vocabularios distintos.
   * Sigue siendo texto crudo y **no sirve para saber si la fila es comparendo o multa**: para eso
   * está {@link ComparendoRegistro.tipoRegistro}.
   */
  estadoFuente: string | null;
  /**
   * Comparendo o multa, o **`null` = «no se sabe»** (HU #11712).
   *
   * `null` NO significa «comparendo» y no se puede pintar como tal: es lo que devuelve todo el
   * histórico anterior a la migración 0160, cuyo dato no está en ninguna parte —los payloads crudos
   * ya se podaron a la lista blanca (RN-25) y ninguna versión anterior del mapa nombraba la
   * resolución, así que tampoco se puede reconstruir—. Y no se va a arreglar solo: las filas
   * `inactivo` ya no las visita ningún sync (CF-10).
   *
   * Consecuencia vinculante para el visor: `null` se muestra como «sin dato», no suma a ningún
   * contador de comparendos y un filtro por tipo no lo incluye en ninguno de los dos valores.
   */
  tipoRegistro: ComparendosTipoRegistro | null;
  /**
   * Número de la resolución que convirtió el comparendo en multa, o `null` mientras sigue siendo
   * comparendo (y en todo el histórico anterior a la 0160).
   *
   * **No es literal de la fuente**: viaja normalizado como los demás códigos del canónico —sin
   * espacios de sobra, en MAYÚSCULAS y recortado a 60 caracteres—, así que no sirve para comparar
   * byte a byte contra el portal del organismo. Se recorta, y se puede, porque no es llave de nada:
   * a diferencia de `numeroComparendo`, ningún join ni unicidad depende de él.
   *
   * Es el dato del que se deriva `tipoRegistro`, así que los dos no pueden contradecirse: la base lo
   * sostiene con un CHECK. Lo que **no** viaja aquí es el `id_resolucion` del proveedor: es un
   * identificador de sistema (`115697134`), no es legible para nadie fuera de él, y publicarlo solo
   * daría una segunda columna que nadie sabría leer.
   */
  numeroResolucion: string | null;
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
  /**
   * Cuándo se gestionó por última vez (HU #11556), o `null` si nadie la ha gestionado — que es lo
   * que devuelve TODO lo anterior a esta HU.
   *
   * No es `actualizadoEn`, y la diferencia importa: aquel lo reescribe el sync en cada corrida, así
   * que una fila gestionada ayer por una persona y una que el sync tocó hace diez minutos tienen el
   * mismo `actualizadoEn`. Este solo se mueve cuando alguien gestiona.
   */
  gestionActualizadaEn: string | null;
  /**
   * Quién la gestionó por última vez: el id **y el nombre** del usuario, o `null` si nadie la ha
   * gestionado.
   *
   * Misma forma que {@link ComparendosTokenSimitMeta.actualizadoPor}, y por la misma razón: el
   * único uso de este campo es escribir «gestionado por X» en una pantalla, y un id suelto no lo
   * permite. La versión anterior publicaba solo el número dando por hecho que la pantalla tenía un
   * directorio de usuarios cargado con el que resolverlo — y no lo hay: no existe hook ni endpoint
   * de directorio consumible desde el visor de comparendos, así que el id se pintaba literalmente
   * («usuario 5»), que no es «quién hizo la última gestión» (HU #11562, AC5). El `JOIN` que esto
   * cuesta es un `LEFT JOIN` por clave primaria contra `users`, una vez por página.
   *
   * **No sigue el criterio de {@link ComparendosSyncRun.iniciadoPor}, que sigue siendo un id**, y la
   * diferencia es deliberada: una corrida de sync la dispara quien administra el módulo y su autor
   * solo se mira para depurar; esto lo lee a diario quien reparte el trabajo del equipo.
   *
   * El nombre es de una persona identificable (personal interno): se publica a quien ya puede ver el
   * comparendo entero, pero no se escribe en logs, ni en el `detail` de `audit_logs`, ni en el
   * `motivo` de `pii_access_log`. El export a Excel sigue llevando el **id** y no el nombre a
   * propósito (`flito-comparendos.export.service.ts`): ahí el archivo sale del perímetro.
   */
  gestionActualizadaPor: { id: number; nombre: string } | null;
  creadoEn: string;
  actualizadoEn: string;
}

/**
 * Qué le pasó al registro.
 *
 * Los tres primeros los escribe el SYNC y ninguno se crea a mano (CF-11): son lo que las fuentes
 * dijeron del comparendo. `gestion` (HU #11556) es el primero que escribe una PERSONA —cuando
 * cambia la causal o la observación desde el visor— y por eso es también el único cuyo `syncRunId`
 * es `null` por construcción y no por antigüedad de la fila.
 *
 * El orden de esta unión es el de `pg_enum` en la base (migración 0154), y el valor nuevo va al
 * final: el orden de un enum de PostgreSQL es su orden de comparación, y reordenarlo es un cambio
 * de datos disfrazado de cambio de tipo.
 */
export type ComparendosEventoTipo = 'primera_llegada' | 'inactivacion' | 'reaparicion' | 'gestion';

/**
 * Una entrada del timeline (CF-11).
 *
 * `detalle` es el contexto mínimo del evento —`{ origen }` en el alta y la reaparición,
 * `{ motivo }` en la inactivación— y por RN-20 no lleva NIT, placa ni nada del proveedor: el
 * registro al que apunta ya tiene esos datos.
 *
 * El API lo devuelve por LISTA BLANCA de esas dos claves (RN-35): la columna es JSONB y lo que se
 * guardó ahí es lo único de la respuesta del módulo que no está enumerado campo a campo, así que
 * enumerarlo también aquí es lo que impide que cualquier cosa escrita en esa columna —hoy o por un
 * proceso futuro— salga por el API sin que nadie lo decidiera.
 */
export interface ComparendoEvento {
  id: string;
  tipo: ComparendosEventoTipo;
  /** Corrida que lo produjo. `null` solo en filas anteriores a que se registrara la corrida. */
  syncRunId: string | null;
  /** `{ origen }`, `{ motivo }`, o `null` si el evento no trae ninguno de los dos. */
  detalle: Record<string, unknown> | null;
  ocurridoEn: string;
}

/** `GET /registros/:id`: el registro con su timeline completo, del evento más reciente al más viejo. */
export interface ComparendoRegistroDetalle extends ComparendoRegistro {
  eventos: ComparendoEvento[];
}

// ─────────────────────── Gestión del comparendo (HU #11557, 17b) ─────────────────────────────────

/**
 * Cuerpo de `PATCH /registros/:id/gestion`: **lo ÚNICO editable de un comparendo**.
 *
 * Los dos campos son opcionales por separado y el cuerpo **no puede venir vacío**: se manda solo lo
 * que cambió (`{ causalId }`, `{ observacion }` o los dos), que es lo que impide que dos personas
 * trabajando el mismo comparendo se pisen el campo que la otra no tocó. Un cuerpo sin ninguna de
 * las dos claves es un 400 y no un no-op silencioso: quien lo manda cree que cambió algo.
 *
 * `null` **no** significa «no lo mandes», significa «déjalo vacío»: `{ "causalId": null }` retira la
 * causal y `{ "observacion": null }` borra la observación. La diferencia entre `null` y ausente es
 * todo el contrato de este endpoint, así que la pantalla no puede serializar un campo que no tocó.
 *
 * **Nada más entra por aquí.** La placa, el monto, el organismo y el resto del canónico son dato de
 * FUENTE y no se editan (RN-04, CF-09): el esquema del servidor es estricto y una clave que no sea
 * una de estas dos es un 400, no un campo que se ignora en silencio.
 *
 * La respuesta del PATCH es un {@link ComparendoRegistroDetalle} —el registro entero con su
 * timeline ya actualizado—, para que el panel del visor se refresque sin una segunda petición.
 */
export interface ComparendosGestionPatch {
  /** Id de una causal del catálogo (CF-04), o `null` para dejar el comparendo sin causal. */
  causalId?: string | null;
  /** Texto libre de hasta {@link COMPARENDOS_OBSERVACION_MAX}, o `null` para borrarla. */
  observacion?: string | null;
}

/**
 * Tope de la observación de gestión, en caracteres.
 *
 * Vive aquí por lo mismo que {@link COMPARENDOS_REGISTROS_LIMIT_MAX}: es el número con el que el
 * formulario pinta su contador, y sin él la pantalla lo inventaría y el usuario descubriría el tope
 * real en un 400 después de haber escrito. El esquema `zod` del endpoint lo importa de aquí, así que
 * hay una sola fuente y no dos que puedan separarse.
 *
 * **No sale de la columna: la columna es `TEXT` y no tiene tope** (migración 0150). El límite es de
 * PRODUCTO y esta constante es dónde vive. 1 000 caracteres son unas quince líneas de prosa —de
 * sobra para dejar dicho qué se decidió sobre una deuda y por qué— y acotan tres cosas que sin tope
 * no tendrían ninguna: el tamaño de una página del listado (hasta 50 observaciones en la misma
 * respuesta), lo que la purga por retención arrastra, y lo que alguien puede pegar en la única
 * columna de texto libre que este módulo expone a escritura.
 */
export const COMPARENDOS_OBSERVACION_MAX = 1000;

/**
 * Tamaño máximo —y por defecto— de una página de registros.
 *
 * Vive aquí y no solo en el router para que la pantalla no lo adivine ni pida 200 y reciba un 400.
 * El número sale de multiplicarlo por el limitador de la lectura (60 peticiones por minuto y
 * usuario): 50 filas × 60 = 3 000 NITs y placas por minuto, que es el techo de extracción de **la
 * ruta interactiva**.
 *
 * **Desde la HU #11558 ese ya no es el techo del MÓDULO, y decirlo importa.** El export a Excel
 * entrega en una sola petición hasta {@link COMPARENDOS_EXPORT_MAX_FILAS} filas con su propia cuota
 * (5 por minuto y usuario), así que quien lea este número como «lo máximo que alguien se lleva de
 * aquí por minuto» se equivocaría por 8,3×. Los dos techos —el de la lectura paginada y el del
 * export— y por qué se aceptan están razonados juntos en `docs/adr/ADR-0004-flito-comparendos-export-excel-tope.md`,
 * que **complementa** a ADR-0001: no lo enmienda ni lo supersede.
 */
export const COMPARENDOS_REGISTROS_LIMIT_MAX = 50;

/**
 * Parámetros de LISTA. Viajan en la query, y pueden hacerlo porque ninguno identifica a una persona.
 *
 * Son los mismos en `GET /registros` y en `POST /registros/buscar`: la paginación no cambia porque
 * la búsqueda lleve filtros de identidad, y definirla una sola vez evita que las dos rutas se
 * separen. `q` es parcial pero solo sobre el NÚMERO de comparendo —un consecutivo del Estado— y por
 * eso no es un identificador de persona.
 *
 * Los tres filtros de la HU #11555 —`municipio`, `fuente` y la causal— están aquí y no en
 * {@link ComparendosRegistrosBusqueda} por esa misma razón y no por comodidad: un código de
 * municipio, un origen de merge y el id de una causal describen al COMPARENDO y a cómo se gestiona,
 * no a su titular, así que verlos en un access log del proxy no cuenta nada de nadie. La línea de
 * AGENTS.md §14 pasa exactamente por ahí, y por eso el NIT y la placa siguen sin poder cruzarla.
 */
export interface ComparendosRegistrosQuery {
  estado?: ComparendosRegistroEstado;
  /** Fragmento del número de comparendo (mínimo 3 caracteres). */
  q?: string;
  /**
   * `codigoFuente` del municipio donde se vio el comparendo. Coincidencia EXACTA.
   *
   * Es el valor literal de {@link ComparendosMunicipio.codigoFuente} —«ITAGUI», no «Itagüí»—, que
   * es lo que el sync guarda en el registro: el código con el que se le preguntó al proveedor, no
   * el nombre que se le enseña a un humano. La pantalla debe mandar el `codigoFuente` de la opción
   * elegida en el catálogo, no lo que esa opción muestra.
   *
   * Un municipio DESACTIVADO en el catálogo sigue siendo un filtro legítimo: dar de baja la fuente
   * deja de consultarla, no borra los comparendos que ya trajo, y no poder mirarlos sería perder de
   * vista deuda viva por un cambio de parametrización.
   */
  municipio?: string;
  /**
   * Qué fuentes han visto el comparendo (`origen_merge`), que NO es de qué municipio es.
   *
   * `fuente=simit` son los que solo ha reportado el SIMIT —esos tienen `municipioFuente` en `null`,
   * así que combinarlo con `municipio` devuelve una página vacía por construcción, no por error—;
   * `municipal`, los que solo ha visto el municipio; `ambos`, los que confirman las dos. Es el
   * filtro con el que se responde «¿qué tiene el SIMIT que el municipio todavía no?».
   */
  fuente?: ComparendosOrigenMerge;
  /** Id de la causal de gestión asignada (CF-04). Excluyente con {@link sinCausal}. */
  causalId?: string;
  /**
   * Solo los comparendos SIN causal asignada. Excluyente con {@link causalId}.
   *
   * Existe como parámetro propio y no como un `causalId` vacío porque «sin clasificar» es la cola de
   * trabajo real de la pantalla de gestión —lo que falta por mirar— y un valor ausente ya significa
   * «no filtres por causal». Mandar los dos a la vez es un 400: la intersección siempre estaría
   * vacía, y responder una lista vacía a una pregunta contradictoria se lee como «no hay nada».
   */
  sinCausal?: boolean;
  /** 1..{@link COMPARENDOS_REGISTROS_LIMIT_MAX}. Ausente = el máximo. */
  limit?: number;
  /** El `nextCursor` de la página anterior, tal cual llegó. Opaco: no se construye en el cliente. */
  cursor?: string;
}

/**
 * Cuerpo de `POST /registros/buscar` (CF-09): los filtros que SÍ identifican.
 *
 * Van en el cuerpo y no en la query por la norma de datos personales del proyecto (AGENTS.md §14):
 * un NIT o una placa en una URL acaba en el access log del proxy, en el historial del navegador y
 * en el `Referer` de la siguiente petición, y ninguno de esos tres sitios está bajo la retención ni
 * el registro de acceso que la Ley 1581 exige para este módulo.
 *
 * Los dos son coincidencia EXACTA sobre el valor normalizado (el NIT sin puntos, la placa en
 * mayúsculas y sin guiones): una búsqueda parcial sobre un identificador es una forma de barrer
 * datos personales de a poco.
 */
export interface ComparendosRegistrosBusqueda {
  nit?: string;
  placa?: string;
}

/** Filtro resuelto que consume el servicio: la query más el cuerpo, ya validados. */
export interface ComparendosRegistrosFiltro
  extends ComparendosRegistrosQuery, ComparendosRegistrosBusqueda {}

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

// ─────────────────────── Export a Excel del consolidado (HU #11558, 17b) ─────────────────────────

/**
 * Tope duro de filas de un export, y la mitad del techo de extracción del módulo (ADR-0004 §2).
 *
 * Vive aquí por lo mismo que {@link COMPARENDOS_REGISTROS_LIMIT_MAX}: la pantalla necesita el número
 * para explicar el 422 («tu filtro supera las N filas, acótalo») sin inventárselo ni descubrirlo
 * probando. El servidor **no lo lee de aquí**: lo lee de `COMPARENDOS_EXPORT_MAX_FILAS` en el
 * entorno, cuyo valor por defecto ES esta constante, para poder recalibrarlo con datos reales del
 * `pii_access_log` sin desplegar código.
 *
 * De ahí el matiz que hay que tener presente al usarlo en la interfaz: es el tope **por defecto**,
 * no una garantía del servidor. Un despliegue que lo baje hará que el 422 aparezca antes de lo que
 * diga la pantalla; por eso el mensaje de error del API viene con su propio número dentro y es ese
 * el que conviene mostrar cuando llega.
 *
 * ── Por qué 2 000 y no 5 000 (HU #11651, medido el 2026-08-22) ───────────────────────────────────
 *
 * Valía 5 000 —la Opción C del ADR-0004—, y el propio ADR lo aceptó **con la condición de medirlo**,
 * porque `sendExcel` construye el workbook ENTERO en memoria y el API corre en una sola instancia
 * fork con `max_memory_restart: '512M'` (`ecosystem.config.cjs:22`). Ya está medido, en el peor caso
 * del archivo (la observación al máximo en todas las filas) y en el escenario que el limitador
 * permite. Ese escenario NO es «varios administradores coordinándose»: `exportLimiter` acota
 * peticiones **por minuto, no peticiones en vuelo** (`max: 5` por usuario, `keyGenerator:
 * userOrIpKey(…)`, sin ninguna cota global ni semáforo), así que **una sola cuenta** —una sesión de
 * administrador comprometida, un script, o alguien con prisa pulsando cinco veces— pone sus cinco
 * exports a construirse a la vez en el mismo proceso:
 *
 *     filas | 1 export | 2 simult. | 3 simult. | 4 simult. | 5 simult.
 *     ------|----------|-----------|-----------|-----------|----------
 *     5 000 |  +152 MB |  +247 MB  |  +365 MB  |     —     |     —
 *     3 000 |  + 58 MB |  +116 MB  |  +203 MB  |     —     |     —
 *     2 000 |  + 93 MB |  +106 MB  |  +124 MB  |  +169 MB  |  +239 MB
 *
 * (Delta de RSS sobre el reposo del proceso. El instrumento es
 * `apps/api/__tests__/helpers/export-coste.ts`; los tests que quedan en el repo fijan UNO y DOS
 * exports simultáneos al tope vigente —`flito-comparendos-export-coste.test.ts` y
 * `flito-comparendos-export-concurrencia.test.ts`—, y las demás celdas salen de corridas puntuales
 * del mismo instrumento durante la HU, variando el tope y el número de lotes a mano.)
 *
 * Sobre un API en régimen de 250 MB quedan 262 MB hasta el techo de PM2 — y ese 250 es una
 * **estimación heredada del PR #153, no una medida del proceso de hoy** (`REGIMEN_API_MB` en
 * `apps/api/__tests__/helpers/export-coste.ts`), de la que cuelga todo el presupuesto. Con 5 000,
 * dos exports simultáneos se comen 247 de esos 262: el proceso se queda a 15 MB del reinicio, y con
 * tres lo cruza. Con 2 000 caben **los cinco** que el limitador deja pasar en un minuto (+239 MB de
 * los 262, con 23 MB de margen); el **sexto no está medido** —extrapolando la pendiente de la tabla
 * cruzaría el techo, pero eso es proyección, no medición—. Además, un solo export de 5 000 filas ya
 * llegaba a los ~150 MB de delta que ADR-0004 §Coste fijó como **señal de reapertura de la
 * decisión**.
 *
 * **Qué distingue la medición y qué no.** Descarta 5 000 con holgura: 247 MB frente a 106 MB con dos
 * simultáneos es un factor 2,3 que ningún ruido explica. Lo que NO hace es separar 2 000 de 3 000:
 * 3 000 filas miden +58 MB y 2 000, +93 MB (con dos simultáneos, 116 frente a 106), y un archivo más
 * pequeño costando más RSS significa que a esa escala manda el ruido del allocator y del GC, no el
 * número de filas. 2 000 se elige por ser la Opción B del ADR-0004 —la que allí se descartó «por
 * poco», con la nota de que bajar a ella es un cambio de una línea que no necesita otro ADR—, por
 * ser el extremo conservador de esa banda y por dejar margen; no porque la tabla lo distinga de
 * 3 000. Lo que se paga está en la tabla de contras de esa opción (un NIT grande con varios años de
 * histórico puede no caber en un solo archivo y obliga a trocear por filtro); lo que se compra es
 * que el techo de extracción por minuto baje de 25 000 a 10 000 filas y que el par simultáneo deje
 * de rozar el techo de PM2. Lo que NO se compra es que exportar no pueda reiniciar el API: eso no lo
 * arregla ningún valor del tope, porque nada acota la concurrencia (ADR-0004, «Lo que esto NO
 * resuelve»).
 */
export const COMPARENDOS_EXPORT_MAX_FILAS = 2000;

/**
 * El filtro completo de `POST /registros/export`: **el mismo del visor, sin paginación**.
 *
 * Es {@link ComparendosRegistrosFiltro} menos `limit` y `cursor`, y esa resta es el contrato: un
 * export no pagina —entrega el conjunto entero o no entrega nada—, así que mandar cualquiera de los
 * dos es un 400 y no un parámetro que se ignora. La pantalla puede pasar su estado de filtros tal
 * cual, que es justo lo que hace que el archivo contenga lo que el usuario está viendo (AC1).
 *
 * **Se parte en dos al enviarlo, y no es un detalle de transporte:** lo que no identifica a nadie
 * —`estado`, `q`, `municipio`, `fuente`, la causal— viaja en la query, y `nit` y `placa` van en el
 * CUERPO del POST (AGENTS.md §14). No hay variante `GET` de este endpoint: un `<a download>` con
 * `?nit=…` dejaría el NIT en el access log del proxy, en el historial y en el `Referer`, que son los
 * tres sitios que el diseño de 17a sacó de en medio. La descarga se hace con `fetch` + `blob` +
 * `createObjectURL`/`revokeObjectURL`.
 */
export interface ComparendosExportRequest
  extends Omit<ComparendosRegistrosQuery, 'limit' | 'cursor'>, ComparendosRegistrosBusqueda {}
