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
 *   otra_compania    — la póliza es de un SOAT de otra compañía
 *   ya_conciliada    — ese SOAT ya salió de la bolsa en otra boleta
 *
 * Espejo del CHECK `flito_concil_linea_resultado_chk` de la 0157.
 */
export const ResultadoCruce = {
  OK: 'ok',
  NO_ENCONTRADA: 'no_encontrada',
  NO_PAGADO: 'no_pagado',
  VALOR_DISTINTO: 'valor_distinto',
  POLIZA_DUPLICADA: 'poliza_duplicada',
  OTRA_COMPANIA: 'otra_compania',
  YA_CONCILIADA: 'ya_conciliada',
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
 *   otra_compania    → `companiaSoatNombre`
 *   ya_conciliada    → `boletaAnteriorRef` + `boletaAnteriorFecha`
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
   * El SOAT ya salió de la bolsa al sellar la liquidación de su trámite: conciliar no volverá a
   * cobrarlo. No bloquea —la línea cuadra— pero evita que el aviso de éxito anuncie un descuento
   * que no ocurrió.
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

/** La boleta con su cuadre. Lo que devuelven la carga, el detalle y el re-cruce. */
export interface BoletaDetalleDto extends BoletaResumenDto {
  lineas: LineaBoletaDto[];
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
