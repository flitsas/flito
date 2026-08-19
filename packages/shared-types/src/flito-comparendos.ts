// FLITO — Monitoreo de comparendos: catálogos de parametrización (Feature #11492 17a, HU #11497),
// metadatos del token SIMIT (HU #11498), resultado de la sincronización (HU #11500) y lectura del
// registro consolidado con su timeline (HU #11502). Los filtros de listado por municipio, fuente y
// causal son de 17b (Feature #11495, HU #11555) y se añadieron sobre `ComparendosRegistrosQuery`.
//
// El PATCH de gestión —`ComparendosGestionPatch` y `COMPARENDOS_OBSERVACION_MAX`— es de 17b y se
// publica desde la HU #11557, que es la que expone el endpoint que lo consume.
//
// Lo que este archivo sigue SIN declarar, y es deliberado: los contratos del export a Excel, que son
// de la HU #11558. Publicar hoy el tipo de algo que ningún endpoint responde invita a que la
// pantalla se escriba contra una forma que aún puede cambiar. (`PageSlug` del módulo no está aquí
// por otro motivo: el catálogo de páginas vive en `permissions.ts`, y lo añadió la HU #11559.)
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
   * Quién la gestionó por última vez: el **id** del usuario, no su nombre.
   *
   * Igual que {@link ComparendosSyncRun.iniciadoPor}, y por lo mismo: resolver el id a un nombre es
   * cosa de la pantalla, que ya tiene el directorio de usuarios cargado. Devolverlo aquí obligaría
   * a un `JOIN` en cada página del listado para un dato que en la mayoría de las filas es `null`.
   */
  gestionActualizadaPor: number | null;
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
 * usuario): 50 filas × 60 = 3 000 NITs y placas por minuto, que es el techo de exfiltración que el
 * módulo acepta para un administrador con sesión válida.
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
