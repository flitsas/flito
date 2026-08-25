// FLITO Conciliación — boletas de pago externo cruzadas contra los SOAT (Feature #11623).
//
// Módulo PURO (sin zod ni side-effects): lo consumen API y web. En esta HU (#11673) solo vive aquí
// el vocabulario que la capa de datos necesita afirmar —los estados de una boleta, los desenlaces
// del cruce y la normalización del número de póliza—. Los DTO de carga, cruce y conciliación
// llegan con las HU siguientes, cuando existan los endpoints que los devuelven.
//
// Qué es una boleta: Financiera paga en un portal externo un lote de SOAT de UNA compañía, descarga
// el Excel del portal y lo carga en FLITO. Cada fila del Excel es una línea, y una línea cruza por
// NÚMERO DE PÓLIZA contra un SOAT ya pagado. Si todas cuadran, el dinero sale de las dos bolsas en
// ese momento (CF-03), sin esperar al sellado de la liquidación.
//
// Diseño y tradeoffs: docs/adr/ADR-0006-flito-conciliacion-boletas-soat.md

/**
 * Estado de una boleta.
 *
 *   cargada     — el Excel ya se leyó y cruzó, pero no ha salido un peso de ninguna bolsa
 *   conciliada  — el descuento se asentó. Es terminal: una boleta conciliada no se deshace, y por
 *                 eso tampoco se borra (descartar es un UPDATE, no un DELETE)
 *   descartada  — carga abandonada. Libera el hash del archivo para poder rehacer la boleta sin
 *                 tener que renombrar el .xlsx
 *
 * Espejo del CHECK `flito_concil_boleta_estado_chk` de la migración 0157.
 */
export const EstadoBoleta = {
  CARGADA: 'cargada',
  CONCILIADA: 'conciliada',
  DESCARTADA: 'descartada',
} as const;

export type EstadoBoleta = (typeof EstadoBoleta)[keyof typeof EstadoBoleta];

/**
 * Concepto que agrupa una boleta. Una boleta es de UN solo concepto y de UNA sola compañía (RN-01).
 *
 * El MVP solo admite `soat`; el módulo se llama Conciliación —y no «Conciliación de SOAT»— porque
 * impuestos entra después por la misma puerta. Espejo del CHECK `flito_concil_boleta_concepto_chk`.
 */
export const ConceptoBoleta = {
  SOAT: 'soat',
} as const;

export type ConceptoBoleta = (typeof ConceptoBoleta)[keyof typeof ConceptoBoleta];

/**
 * Desenlace del cruce de UNA línea contra los SOAT de la compañía.
 *
 * Solo `ok` deja conciliar, y basta con que una línea no lo sea para que la boleta entera se quede
 * quieta (CF-02): no hay conciliación parcial, porque media boleta conciliada obligaría a llevar dos
 * verdades sobre el mismo pago externo.
 *
 *   ok               — cruzó con un SOAT pagado de la compañía y el valor coincide
 *   no_encontrada    — ninguna póliza de la compañía coincide
 *   no_pagado        — el SOAT existe pero todavía no está en `pagado`
 *   valor_distinto   — cruzó, pero el valor del portal no es el que FLITO tiene registrado
 *   poliza_duplicada — la póliza aparece en más de un SOAT: hay que corregir el número antes
 *   otra_compania         — la póliza es de un SOAT de otra compañía
 *   ya_conciliada         — ese SOAT ya salió de la bolsa en otra boleta
 *   cobrado_otro_cliente  — la llave `salida:soat:<id>` ya está en el libro de OTRO cliente
 *                           (Bug #11773). No se concilia ni se adopta ese asiento.
 *
 * Espejo del CHECK `flito_concil_linea_resultado_chk`. La 0157 lo congeló con siete valores; el
 * octavo lo añade la 0162. No igualar este tipo al CHECK de 0157.
 */
export const ResultadoCruce = {
  OK: 'ok',
  NO_ENCONTRADA: 'no_encontrada',
  NO_PAGADO: 'no_pagado',
  VALOR_DISTINTO: 'valor_distinto',
  POLIZA_DUPLICADA: 'poliza_duplicada',
  OTRA_COMPANIA: 'otra_compania',
  YA_CONCILIADA: 'ya_conciliada',
  COBRADO_OTRO_CLIENTE: 'cobrado_otro_cliente',
} as const;

export type ResultadoCruce = (typeof ResultadoCruce)[keyof typeof ResultadoCruce];

/**
 * Longitud máxima de una póliza normalizada. Es el `varchar(60)` de `flito_soat.numero_poliza` y de
 * `flito_conciliacion_lineas.numero_poliza_norm`, y el tope del CHECK de formato de las dos.
 *
 * No es un límite de negocio —una póliza SOAT real ronda los 10-12 dígitos— sino un guarda contra la
 * otra clase de entrada: un OCR que leyó un párrafo entero donde debía haber un número. Sin él, ese
 * párrafo sería un `22001 value too long` en mitad de la transacción que marca el SOAT como pagado.
 */
export const POLIZA_MAX_LONGITUD = 60;

/**
 * Normaliza un número de póliza: se queda solo con A-Z y 0-9, en mayúsculas.
 *
 * Vive aquí, y no en el backend, porque tiene que ser BIT A BIT lo mismo que hace el backfill de la
 * migración 0157 (`upper(regexp_replace(valor, '[^A-Za-z0-9]', '', 'g'))`) y lo que la pantalla
 * enseña. Si el SQL y esto divergen, el síntoma no es un error: es una póliza que «no aparece».
 *
 * **El orden importa y es el del SQL: primero se filtra, después se pasa a mayúsculas.** Al revés
 * —`toUpperCase()` y luego filtrar— no es lo mismo: en JavaScript `'ß'.toUpperCase()` es `'SS'` y
 * `'ﬁ'.toUpperCase()` es `'FI'`, así que un carácter que PostgreSQL habría tirado se convertiría
 * aquí en dos letras que se quedan. Filtrando primero solo sobreviven ASCII, y sobre ASCII
 * `toUpperCase()` de JS y `upper()` de PostgreSQL coinciden siempre.
 */
export function normalizarPoliza(valor: string): string {
  return valor.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/**
 * La póliza tal como debe quedar en la COLUMNA `numero_poliza`, o `null` si no hay nada usable.
 *
 * Es el mismo predicado del backfill de la 0157 (`length(...) BETWEEN 1 AND 60`), y existe para que
 * los dos caminos que escriben la columna —el backfill una vez, y `pagarEnTx` en cada pago— no
 * puedan discrepar sobre qué es una póliza legible:
 *
 *   · la cadena vacía se guarda como `null` y NO como `''`. Un `''` pasaría por un valor y cruzaría
 *     con cualquier otra fila vacía: dos SOAT sin póliza legible se «encontrarían» entre sí.
 *   · lo que excede el tope se guarda como `null` en vez de reventar la transacción con un 22001.
 *
 * Un `null` aquí no es un fallo silencioso: es un SOAT que no se podrá conciliar hasta que alguien
 * corrija el número, y la pantalla del cruce lo dice con esas palabras (`no_encontrada`).
 */
export function polizaParaColumna(valor: string | null | undefined): string | null {
  if (valor === null || valor === undefined) return null;
  const norm = normalizarPoliza(valor);
  if (norm.length < 1 || norm.length > POLIZA_MAX_LONGITUD) return null;
  return norm;
}

// ─────────────────── Carga y cruce del Excel del portal (HU #11676) ──────────────────────────────

/**
 * Tope duro de líneas de una boleta.
 *
 * Vive aquí —y no solo en el backend— porque la pantalla de carga lo anuncia ANTES de subir el
 * archivo («Máximo 500 líneas por boleta y 10 MB») y porque el copy del rechazo lo nombra. Mismo
 * compromiso que {@link COMPARENDOS_EXPORT_MAX_FILAS}: el servidor lo lee del entorno
 * (`CONCILIACION_MAX_FILAS`), cuyo valor por defecto ES esta constante, para poder recalibrarlo sin
 * desplegar código. Por eso el 400 del API trae su propio `maximo` dentro: **ese** es el que hay que
 * mostrar cuando llega, no este.
 *
 * Por qué 500 y no «sin tope»: cada fila del cruce cuesta un `IN (…)` y —en la HU siguiente— una
 * salida de bolsa EN SERIE dentro de una sola transacción, porque el saldo se encadena. 500 asientos
 * en serie son segundos; 50 000 son una transacción que nadie puede reintentar con seguridad.
 */
export const CONCILIACION_MAX_FILAS = 500;

/** Tope del `.xlsx` que sube Financiera. Es el `limits.fileSize` de multer y el copy del modal. */
export const CONCILIACION_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Tope del comprobante del pago PSE (HU #11678). Quince y no diez: es el mismo número que los demás
 * módulos que suben soportes escaneados (bolsas, SOAT, derechos), y un comprobante fotografiado con
 * un móvil pesa más que un `.xlsx` de 500 filas.
 */
export const COMPROBANTE_MAX_BYTES = 15 * 1024 * 1024;

/** Lista blanca del comprobante. Se valida por los BYTES, no por el MIME que declara el cliente. */
export const COMPROBANTE_MIMES = ['application/pdf', 'image/jpeg', 'image/png'] as const;

/**
 * Nombre de la hoja del reporte del portal, y de las DOS columnas que el cruce necesita.
 *
 * Verificado contra el archivo real (`REPORTE SOAT DAVVID.xlsx`): hoja «Export», encabezado en la
 * fila 1, 18 columnas. El parser solo lee estas dos y **ninguna otra**: la columna «Nombre» del
 * portal trae nombres completos de personas naturales y no se persiste, no se devuelve y no se
 * loguea (Ley 1581; AGENTS.md 14).
 *
 * El cotejo de encabezados es tolerante a mayúsculas, tildes y espacios repetidos —el portal ha
 * cambiado la caja de sus títulos más de una vez— pero NO a que la columna no esté: eso es un 400
 * que nombra la que falta.
 */
export const CONCILIACION_HOJA = 'Export';
export const CONCILIACION_COLUMNA_POLIZA = 'Número de Póliza';
export const CONCILIACION_COLUMNA_TOTAL = 'Total a Pagar';

/**
 * Códigos de rechazo de la carga. La pantalla enseña su propio texto por código (docs/ux), así que
 * el `error` del cuerpo es el respaldo legible, no la fuente del copy.
 *
 *   archivo_invalido   — no es un xlsx legible, falta la hoja, falta una columna, o una fila trae un
 *                        número de póliza o un valor que no se pueden leer
 *   archivo_demasiado_grande — el `.xlsx` cabe en 10 MB pero POR DENTRO es enorme (un zip comprime
 *                        20:1 sin esfuerzo). Se rechaza mirando el zip, ANTES de abrir el libro:
 *                        abrirlo para contar las filas es lo que tumba el proceso. Como todavía no
 *                        se han leído filas, este código NO puede traer un conteo de líneas —por eso
 *                        no es `demasiadas_filas`—, trae bytes
 *   sin_filas          — el archivo solo tiene encabezados
 *   demasiadas_filas   — por encima de `CONCILIACION_MAX_FILAS`
 *   poliza_repetida    — la MISMA póliza en dos filas del MISMO archivo. No confundir con el
 *                        resultado `poliza_duplicada`, que es una póliza en dos SOAT distintos
 *   fecha_invalida     — `fechaPago` futura o mal formada
 *   compania_no_existe — el cliente elegido ya no está
 *   boleta_duplicada   — el mismo `archivo_hash` en una boleta viva (trae `boletaId` y `referencia`)
 *   boleta_incompleta  — se pidió conciliar y al menos una línea NO está en `ok` tras el re-cruce
 *                        dentro de la transacción. Trae la `boleta` con el cuadre YA ACTUALIZADO
 *                        para que la pantalla repinte la tabla con lo que hay hoy, no con lo que
 *                        había cuando se cargó. **No salió un peso de ninguna bolsa** (HU #11677 AC2)
 *   sin_valor_pagado   — una línea `ok` cuyo SOAT perdió `valor_pagado` entre el cruce y el asiento.
 *                        Es una salvaguarda, no un caso esperado: `evaluarFila` marca ese SOAT como
 *                        `valor_distinto`, así que llegar aquí significa que la fila cambió DENTRO
 *                        de la transacción. Se prefiere abortar a descontar cero
 *   sin_actor          — se pidió conciliar sin un usuario identificado. El sello de la boleta exige
 *                        actor y fecha juntos (`flito_concil_boleta_sello_chk`), y un acto que mueve
 *                        dinero de terceros sin firma no es admisible ni aunque el CHECK lo dejara
 */
export const CodigoErrorConciliacion = {
  ARCHIVO_INVALIDO: 'archivo_invalido',
  ARCHIVO_DEMASIADO_GRANDE: 'archivo_demasiado_grande',
  SIN_FILAS: 'sin_filas',
  DEMASIADAS_FILAS: 'demasiadas_filas',
  POLIZA_REPETIDA: 'poliza_repetida',
  FECHA_INVALIDA: 'fecha_invalida',
  COMPANIA_NO_EXISTE: 'compania_no_existe',
  BOLETA_DUPLICADA: 'boleta_duplicada',
  BOLETA_NO_EXISTE: 'boleta_no_existe',
  BOLETA_YA_CONCILIADA: 'boleta_ya_conciliada',
  BOLETA_DESCARTADA: 'boleta_descartada',
  BOLETA_INCOMPLETA: 'boleta_incompleta',
  SIN_VALOR_PAGADO: 'sin_valor_pagado',
  SIN_ACTOR: 'sin_actor',
  // ── El comprobante del pago PSE (HU #11678) ────────────────────────────────────────────────────
  /** Ya hay un comprobante vivo en esta boleta. Se reemplaza con PUT, no se sube otro con POST. */
  COMPROBANTE_YA_EXISTE: 'comprobante_ya_existe',
  /** La boleta no tiene comprobante: no hay nada que descargar. */
  COMPROBANTE_NO_EXISTE: 'comprobante_no_existe',
  /**
   * El comprobante se adjunta DESPUÉS de conciliar. Antes no existe el pago que documentaría, y
   * dejarlo subir abriría un estado que la alerta del tablero no sabe leer: «boleta cargada con
   * comprobante» no es ni pendiente ni resuelta.
   */
  BOLETA_NO_CONCILIADA: 'boleta_no_conciliada',
} as const;

export type CodigoErrorConciliacion =
  (typeof CodigoErrorConciliacion)[keyof typeof CodigoErrorConciliacion];

/**
 * Una línea del cuadre, tal como la pinta la pantalla.
 *
 * **Los motivos NO viajan redactados desde el servidor.** `detalle` es el respaldo persistido —el
 * rastro de por qué esta línea quedó así el día que se cruzó—, y lo que se pinta lo compone la web
 * con estos campos estructurados (docs/ux/flito-conciliacion.md, «Los siete motivos»). La razón es
 * concreta: si el texto viniera de `detalle`, cambiar una palabra del motivo exigiría una migración
 * de datos, y los importes se formatearían con lo que trajera la cadena en vez de con `pesos()`.
 *
 * Qué campo hace falta para qué resultado:
 *   valor_distinto   → `valorDeclarado` + `valorSoat` (la diferencia la calcula la pantalla)
 *   poliza_duplicada → `candidatos`
 *   no_pagado        → `soatEstado`
 *   otra_compania         → `companiaSoatNombre`
 *   ya_conciliada         → `boletaAnteriorRef` + `boletaAnteriorFecha`
 *   cobrado_otro_cliente  → `companiaCobroNombre` (el cliente dueño del asiento, no el de la boleta)
 */
export interface LineaBoletaDto {
  id: string;
  /** Fila del Excel tal como la ve el usuario: 1 = primera fila de datos, no la del encabezado. */
  filaNumero: number;
  /** Póliza normalizada. Cuasi-PII: viaja en el CUERPO de la respuesta, nunca en una URL. */
  numeroPolizaNorm: string;
  /** Lo que el portal cobró por esta línea («Total a Pagar»). */
  valorDeclarado: number;
  resultado: ResultadoCruce;
  /** Motivo persistido, sin póliza ni placa en claro. No es el texto que se pinta. */
  detalle: string | null;
  soatId: string | null;
  /** Del SOAT que cruzó. `null` en `no_encontrada` y en `poliza_duplicada` (hay varios). */
  placa: string | null;
  /** `flito_soat.valor_pagado`: lo que FLITO cree que costó. NUNCA la columna del Excel. */
  valorSoat: number | null;
  soatEstado: string | null;
  companiaSoatNombre: string | null;
  /** Cuántos SOAT tienen esta póliza. Solo se llena cuando son más de uno. */
  candidatos: number | null;
  boletaAnteriorRef: string | null;
  /** ISO 'YYYY-MM-DD' del pago de la boleta que ya concilió este SOAT. */
  boletaAnteriorFecha: string | null;
  /**
   * Nombre del cliente dueño del asiento `salida:soat:<id>` cuando ese asiento NO es de la
   * compañía de la boleta (`cobrado_otro_cliente`). `null` en cualquier otro desenlace.
   */
  companiaCobroNombre: string | null;
  /**
   * El SOAT ya salió de la bolsa de ESTA compañía al sellar la liquidación de su trámite:
   * conciliar no volverá a cobrarlo. No bloquea —la línea cuadra— pero evita que el aviso de
   * éxito anuncie un descuento que no ocurrió. Falso si el asiento `automatico` es de otro cliente
   * (eso es `cobrado_otro_cliente`, y sí bloquea).
   */
  yaDescontadoEnLiquidacion: boolean;
  conciliadaEn: string | null;
}

/** Cuántas líneas quedaron en cada desenlace. Todas las claves vienen, aunque valgan 0. */
export type ConteoResultados = Record<ResultadoCruce, number>;

/** La boleta sin sus líneas: lo que necesita la bandeja. */
export interface BoletaResumenDto {
  id: string;
  referencia: string;
  companiaId: number;
  companiaNombre: string | null;
  concepto: ConceptoBoleta;
  estado: EstadoBoleta;
  archivoNombre: string;
  filas: number;
  totalDeclarado: number;
  totalCruzado: number | null;
  fechaPago: string;
  cargadaPorNombre: string;
  conciliadaEn: string | null;
  conciliadaPorNombre: string | null;
  createdAt: string;
  /** Conteo por resultado y total, para que la bandeja no tenga que pedir las líneas. */
  conteo: ConteoResultados;
  /** Cuántas líneas NO están en `ok`. Es lo que decide si la boleta se puede conciliar (CF-02). */
  sinCuadrar: number;
}

/**
 * El comprobante del pago PSE de una boleta conciliada (HU #11678, CF-06).
 *
 * `url` viene **firmada y con caducidad** (`/api/files?key=…&exp=…&sig=…`, 5 minutos): la ruta del
 * objeto en el almacenamiento no sale nunca de la API. Por eso mismo **no se pinta como `href`
 * estático**: para el clic hay que pedir una firma fresca a `GET …/boletas/:id/comprobante`, que es
 * lo único que garantiza que el enlace no esté ya muerto cuando el usuario lo pulse.
 */
export interface ComprobanteBoletaDto {
  id: string;
  nombreArchivo: string;
  contentType: string;
  tamanoBytes: number;
  /** ISO. Es la fecha que la ficha pinta («subido el 20/08/2026, 3:45 p. m.»). */
  subidoEn: string;
  subidoPorNombre: string;
  /** Enlace firmado y caducable. Nunca la clave del almacenamiento. */
  url: string;
}

/** Lo que devuelve `GET …/boletas/:id/comprobante`: una firma fresca para abrir el archivo. */
export interface ComprobanteDescargaDto {
  url: string;
  nombreArchivo: string;
  contentType: string;
}

/** La boleta con su cuadre. Lo que devuelven la carga, el detalle y el re-cruce. */
export interface BoletaDetalleDto extends BoletaResumenDto {
  lineas: LineaBoletaDto[];
  /**
   * El comprobante del pago PSE, o `null` si todavía no se ha adjuntado (HU #11678, AC2).
   *
   * Viaja en el detalle y no en una petición aparte para que la ficha pueda pintar los tres momentos
   * —antes de conciliar, conciliada sin comprobante, con comprobante— sin una segunda ida y vuelta
   * que decidiría cuál de los tres es con un `undefined`.
   */
  comprobante: ComprobanteBoletaDto | null;
  /**
   * Filas del Excel que se ignoraron por no traer número de póliza —típicamente la fila de totales
   * que algunas descargas del portal añaden al final—. Se informa en vez de callarse: una fila
   * ignorada que SÍ era un pago cambia el total declarado, y quien carga tiene que poder verlo.
   */
  filasOmitidas: number;
}

/**
 * La bandeja: una página de boletas y el cursor de la siguiente.
 *
 * Es un SOBRE y no un array pelado —que es lo que insinuaba el ADR-0006 §7.2— porque el propio ADR
 * pide `cursor` entre los filtros: un array sin sitio donde devolver el cursor obliga a la pantalla
 * a deducirlo del último elemento, y eso deja de funcionar en cuanto la última página viene llena.
 *
 * `conteo` viene DENTRO de cada boleta y no agregado aparte: los KPI de la bandeja se calculan sobre
 * la misma respuesta, que es lo que impide enseñar dos cifras distintas del mismo dinero. Un total
 * global sobre TODAS las páginas —no solo la actual— es una decisión de producto que hoy no está
 * pedida en ningún AC; cuando se pida, cabe en este sobre sin romper a nadie.
 */
export interface BoletaListadoDto {
  items: BoletaResumenDto[];
  /** `createdAt` de la última boleta entregada, o `null` si ya no hay más páginas. */
  siguienteCursor: string | null;
}

// ─────────────────── El asiento del dinero (HU #11677) ───────────────────────────────────────────
//
// Lo que devuelve `POST /boletas/:id/conciliar`. Es la única respuesta del módulo que describe un
// movimiento de dinero, y su forma la fija el AVISO DE ÉXITO de docs/ux/flito-conciliacion.md, que
// tiene que poder decir, sin una segunda petición y sin calcular nada:
//
//   «Se conciliaron 11 SOAT por $ 6.284.900.
//    · Bolsa de Transportes Andinos: − $ 6.284.900 → saldo $ 12.450.300
//    · Bolsa de tránsito de Medellín: − $ 4.180.000 → saldo $ 9.310.500
//    2 de esos SOAT ya se habían descontado al liquidar su trámite, así que no se volvieron a
//    cobrar: hoy salieron de la bolsa $ 5.120.400.»
//
// **Se aparta del ADR-0006 §7.3, que proponía `{ boleta, saldoCliente, lineas, adoptados }`.** Esa
// forma no puede expresar el desglose por bolsa de tránsito —son N bolsas, cada una con su importe y
// su saldo— ni distinguir «lo conciliado» de «lo que salió hoy», que es justo la distinción sin la
// cual el aviso anuncia un cobro que no ocurrió. `lineas` no se repite en la raíz porque ya viaja
// dentro de `boleta`, y dos copias de la misma lista se desincronizan a la primera edición.

/** Una bolsa que participó en la conciliación, con lo que el aviso necesita decir de ella. */
export interface BolsaAfectadaDto {
  /** Nombre para pintar: el del cliente, o el de la bolsa de tránsito. */
  nombre: string | null;
  /**
   * Lo que salió de esta bolsa HOY, con esta conciliación.
   *
   * Puede ser CERO con líneas conciliadas: es el «orden 2» del ADR §2.3, en el que el sellado de la
   * liquidación ya había descontado ese SOAT y conciliar no vuelve a moverlo (CF-04).
   */
  descontado: number;
  /** Saldo de la bolsa DESPUÉS de la conciliación. Se lee de la bolsa, no se calcula sumando. */
  saldoResultante: number;
}

export interface BolsaClienteAfectadaDto extends BolsaAfectadaDto {
  companiaId: number;
}

export interface BolsaTransitoAfectadaDto extends BolsaAfectadaDto {
  bolsaId: string;
}

/**
 * Una línea cuyo descuento YA existía: el sellado de la liquidación se le adelantó a Financiera.
 *
 * El movimiento no se duplica —la llave `salida:soat:<id>` ya estaba ocupada— y además se ADOPTA:
 * pasa a `origen = 'conciliacion'`, que es lo que lo saca del barrido del reverso de la liquidación
 * y hace que el CF-07 se cumpla también en este orden (ADR §2.4-ii).
 */
export interface LineaAdoptadaDto {
  lineaId: string;
  /** Fila del Excel, que es como el usuario nombra la línea en pantalla. */
  filaNumero: number;
  soatId: string;
  /**
   * Lo que en su día salió de la bolsa del cliente por este SOAT — el valor del MOVIMIENTO.
   *
   * No es necesariamente el `valor_pagado` de hoy: si se corrigió después del sellado y la boleta
   * trae ya el importe corregido, lo que no se volvió a cobrar es lo que se cobró entonces.
   */
  valor: number;
  /** Movimiento existente al que la línea quedó amarrada. */
  movimientoBolsaId: string;
  /** `true` si estaba en `origen='automatico'` y esta conciliación lo pasó a `'conciliacion'`. */
  adoptado: boolean;
}

/** Respuesta de `POST /api/flito/conciliacion/boletas/:id/conciliar`. */
export interface ConciliacionRealizadaDto {
  /** La boleta ya en `conciliada`, con sus líneas selladas. Incluye actor y fecha. */
  boleta: BoletaDetalleDto;
  /** Cuántos SOAT quedaron conciliados. Es `boleta.filas` cuando todo cuadró, y siempre lo hace. */
  soatConciliados: number;
  /**
   * Suma de `flito_soat.valor_pagado` de los SOAT conciliados — la cifra grande del aviso.
   *
   * NO es lo mismo que `cliente.descontado`: incluye también los que ya se habían descontado al
   * liquidar. La diferencia entre las dos cifras es exactamente lo que suman los `adoptados`.
   */
  totalConciliado: number;
  cliente: BolsaClienteAfectadaDto;
  /** Una entrada por bolsa de tránsito tocada. Vacío si ningún organismo está cubierto. */
  transito: BolsaTransitoAfectadaDto[];
  adoptados: LineaAdoptadaDto[];
}
