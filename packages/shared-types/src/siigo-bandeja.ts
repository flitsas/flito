// Siigo — la bandeja de fallidos y su operación (HU #11340, Feature #11244).
//
// **La bandeja NO es un cuarto estado.** Reúne tres cosas que ya tienen dueño y catálogo propios —la
// emisión que falló (`siigo_facturas.estado`), el rechazo de la DIAN (`siigo_factura_estados_dian`)
// y el correo que no salió (`siigo_factura_envios.resultado`)— y las pinta juntas conservando el
// estado NATIVO de cada una. Inventar aquí una máquina de estados propia obligaría a mantenerla
// sincronizada con las tres, y la copia sería siempre la que se quedara vieja.
//
// **Lo que esta historia NO implementa: idempotencia.** El reintento de la bandeja no emite: rearma
// la fila de cola y vuelve. Quien impide la doble factura es el reclamo de clave de la Feature
// #11242 (`reclamarFallida`), y sigue siendo el único. Si algún día un tipo de este archivo empieza
// a hablar de claves de idempotencia, es que alguien cruzó la línea.
//
// Vive en tipos compartidos y no en el servidor porque tiene DOS consumidores: la API, que arma la
// respuesta, y la pantalla de la HU #11345, que la pinta y cuenta los mismos totales.

import { SIIGO_RESULTADOS_ENCOLADO } from './siigo-cola.js';
import type { SiigoColaEstado } from './siigo-cola.js';
import { SIIGO_ENVIO_RESULTADOS } from './siigo-envio.js';
import type { SiigoEnvioResultado } from './siigo-envio.js';
import type { SiigoEstadoDian } from './siigo-estado-dian.js';

// ── La guía de un error, que es literalmente lo que pide el AC1 ─────────────
//
// Estos tres vivían en `apps/api/src/modules/siigo/siigo.errors.ts` y se mudaron aquí en esta
// historia. Son tipos PUROS —una forma y dos tablas de texto—, y tienen dos consumidores desde que
// la bandeja los devuelve en cada ítem: el servidor, que los construye, y la pantalla, que los
// pinta. La FUNCIÓN que los construye (`guiaParaCodigo`) NO se movió y no debe moverse: depende del
// catálogo de códigos de Siigo, del saneamiento y del registro de códigos sin catalogar, que son
// cosas del servidor. `siigo.errors.ts` los reexporta, así que nada que ya los importara cambió.

/**
 * Quién resuelve el error.
 *
 * Las tres primeras son las del AC1 de la HU #11339. `soporte` existe porque hay errores que no
 * puede tocar ni quien opera ni contabilidad —una cabecera mal formada, un código que Siigo inventó
 * ayer—: mandarlos a operación es mandarlos a un callejón sin salida.
 */
export type ResponsableError = 'operacion' | 'contabilidad' | 'soporte' | 'automatico';

/** Cómo se nombra a cada responsable en el texto que lee quien opera. */
export const ETIQUETA_RESPONSABLE: Record<ResponsableError, string> = {
  operacion: 'quien opera la facturación, desde FLITO',
  contabilidad: 'contabilidad, en Siigo Nube',
  soporte: 'soporte técnico de FLITO',
  automatico: 'nadie: se resuelve solo',
};

/**
 * Guía completa de un error: qué pasó, qué hacer, quién lo hace y si vuelve solo.
 *
 * `texto` es la versión de una sola cadena, ya saneada, para pintarla tal cual; los campos sueltos
 * están para agrupar y filtrar sin volver a parsear la frase.
 */
export interface GuiaErrorSiigo {
  codigo: string;
  descripcion: string;
  accion: string;
  responsable: ResponsableError;
  responsableEtiqueta: string;
  /**
   * **«¿Vuelve solo?»** — `true` significa que el sistema lo reintenta sin que nadie intervenga, y
   * por eso su responsable es siempre `automatico`. Hay una prueba que ancla esa equivalencia.
   *
   * **No es el predicado del AC3.** Ver `sirveReintentar`.
   */
  reintentable: boolean;
  /**
   * **«No vuelve solo, pero reintentarlo a mano sirve.»**
   *
   * Existe porque las dos preguntas NO son la misma y confundirlas hacía mentir a la bandeja. Una
   * factura que la reconciliación comprobó que Siigo no tiene (`reconciliada_inexistente`) no la
   * reintenta nadie por su cuenta —así que `reintentable` es `false`, y debe serlo: su responsable
   * no es `automatico`—, pero volver a emitirla es exactamente lo correcto y además es seguro,
   * porque ya se comprobó que no hay documento que duplicar. Con un solo campo, la bandeja habría
   * descartado justo el caso que más claro está.
   */
  reintentoManual: boolean;
  /**
   * **EL predicado del AC3**, derivado de los dos anteriores: `reintentable || reintentoManual`.
   *
   * `false` significa que el fallo es de un dato nuestro y que reintentar solo consigue el mismo
   * rechazo: la bandeja lo descarta del lote ANTES de tocar la cola, así que no gasta ni una
   * petición de la ventana de 100 por minuto. Quien opera la bandeja mira SOLO este campo: dejarle
   * combinar los otros dos sería repartir la regla por cada sitio que la consulta.
   */
  sirveReintentar: boolean;
  /** `false` cuando el código no está en el catálogo y la guía es la genérica. */
  conocido: boolean;
  texto: string;
}

// ── Las tres patas de la bandeja (AC1) ──────────────────────────────────────

/**
 * De dónde sale cada caso. **No es un estado**: es qué parte del ciclo se rompió, y cada una
 * conserva el catálogo nativo de su tabla en `SiigoBandejaEstadoNativo`.
 *
 * Las tres se arreglan de formas distintas y por eso no se pueden fundir: `emision` se reintenta
 * (no salió nada), `dian` se corrige (el documento existe y la autoridad lo rechazó, así que
 * reintentar emitiría un segundo documento) y `correo` se reenvía (la factura está bien; lo que
 * falló fue la entrega).
 */
export const SIIGO_BANDEJA_FUENTES = ['emision', 'dian', 'correo'] as const;
export type SiigoBandejaFuente = (typeof SIIGO_BANDEJA_FUENTES)[number];

export const SIIGO_BANDEJA_FUENTE_ETIQUETA: Record<SiigoBandejaFuente, string> = {
  emision: 'No se pudo emitir',
  dian: 'Rechazada por la DIAN',
  correo: 'No le llegó al cliente',
};

/**
 * Qué acción admite cada pata. La pantalla decide con esto qué botón pinta, y el servidor rechaza
 * con 409 lo que no encaje: **una factura rechazada por la DIAN no se «da por perdida», se corrige**
 * —el documento existe ante la autoridad y existirá siempre—.
 */
export const SIIGO_BANDEJA_FUENTE_ACCION: Record<SiigoBandejaFuente, string> = {
  emision: 'Reintentar la emisión, o darla por perdida con un motivo.',
  dian: 'Corregir en Siigo Nube y registrar la corrección en FLITO. No se reintenta: emitiría un segundo documento.',
  correo: 'Reenviar el correo, o darlo por perdido con un motivo.',
};

// ── El motivo de darlo por perdido (AC5) ────────────────────────────────────

/**
 * Catálogo CERRADO de motivos. **El motivo no es texto libre, y esa es la decisión.**
 *
 * `siigo_operaciones` es WORM por disparador desde la migración `0126`: prohíbe UPDATE y DELETE. Si
 * quien opera teclea ahí un NIT, una placa o el nombre de una persona, los derechos de rectificación
 * y supresión de la Ley 1581 (art. 8, lits. d y e) dejan de poder ejercerse sobre ese dato **para
 * siempre**. `sanearMensaje` corta volcados de SQL y valores de `nit=` en URLs, pero no redacta lo
 * que alguien escribe a mano, y ninguna lista negra reconoce una cédula suelta.
 *
 * Un `Record` de etiquetas y no un array suelto: añadir un motivo **no compila** hasta que tenga
 * rótulo. Es el mismo patrón de `SIIGO_RESULTADOS_ENVIO` y por la misma razón —un motivo sin texto
 * se pintaría como `undefined` en el diálogo que exige justificar la decisión—.
 */
/**
 * **No hay opción «Otro», y es deliberado.** Un cajón «otro» con una nota al lado es texto libre con
 * otro nombre: quien no encuentre su caso escribirá el motivo real en la nota, y la nota acaba en una
 * tabla que prohíbe UPDATE y DELETE. Si falta un motivo, se añade aquí —y añadirlo es ADITIVO, no
 * rompe nada—; quitar «Otro» una vez que la gente se acostumbró a usarlo, en cambio, obliga a
 * reinterpretar hacia atrás filas que ya no se pueden tocar.
 */
export const SIIGO_BANDEJA_MOTIVOS_DESCARTE = [
  'dato_cliente_incompleto',
  'resolucion_dian_vencida',
  'tramite_anulado',
  'duplicado_emitido_por_fuera',
  'no_se_factura_electronicamente',
] as const;
export type SiigoBandejaMotivoDescarte = (typeof SIIGO_BANDEJA_MOTIVOS_DESCARTE)[number];

export const SIIGO_BANDEJA_MOTIVO_DESCARTE_ETIQUETA: Record<SiigoBandejaMotivoDescarte, string> = {
  dato_cliente_incompleto: 'La ficha del cliente está incompleta y no se va a completar',
  resolucion_dian_vencida: 'La resolución de la DIAN estaba vencida cuando se intentó',
  tramite_anulado: 'El trámite se anuló',
  duplicado_emitido_por_fuera: 'Ya se facturó por fuera de FLITO',
  no_se_factura_electronicamente: 'Este cobro no se factura electrónicamente',
};

/**
 * Tope de la nota. Corta a propósito: es una aclaración, no un informe.
 *
 * La nota es OPCIONAL —también forma parte de la decisión— y pasa por el mismo saneamiento que el
 * resto de lo que se escribe en la bitácora. Que sea corta y opcional reduce la superficie por la
 * que un dato personal puede entrar en una tabla que nadie puede podar.
 */
export const SIIGO_BANDEJA_NOTA_MAX = 200;

export function esMotivoDescarte(v: unknown): v is SiigoBandejaMotivoDescarte {
  return typeof v === 'string' && (SIIGO_BANDEJA_MOTIVOS_DESCARTE as readonly string[]).includes(v);
}

// ── Topes y paginación (AC2) ────────────────────────────────────────────────

/** Cuántos casos trae una página como mucho. La hidratación de la fase 2 se hace sobre esto. */
export const SIIGO_BANDEJA_PAGINA_MAX = 100;
export const SIIGO_BANDEJA_PAGINA_DEFECTO = 50;

/**
 * Tope de facturas por reintento de emisión (AC2). **Derivado de la página, no inventado**: no hay
 * pantalla que pueda seleccionar más de lo que enseña, y un tope mayor solo permitiría que un
 * cliente en bucle llenara la cola.
 *
 * Queda por debajo de `TOPE_TRAMITES_ENVIO` (200), que es el tope del envío desde el reporte de
 * costos; hay una prueba que lo comprueba y falla si alguien lo sube por encima.
 */
export const SIIGO_BANDEJA_TOPE_REINTENTO = SIIGO_BANDEJA_PAGINA_MAX;

/**
 * Tope de facturas por reenvío de correo. **Mucho más bajo, y no por simetría.**
 *
 * El reintento de emisión encola y vuelve en milisegundos: no sale ni una petición. El reenvío SÍ
 * llama a Siigo dentro de la petición HTTP y gasta cuota de la ventana de 100 por minuto que se
 * comparte con la emisión. Veinte correos, con el limitador durmiendo entre ellos, ya es una
 * petición larga; doscientos dejarían la emisión sin cuota y le mandarían al cliente un montón de
 * correos que nadie revisó uno por uno.
 */
export const SIIGO_BANDEJA_TOPE_REENVIO = 20;

/** Filtros de la consulta (AC1). Los que identifican a alguien viajan en el cuerpo, nunca en la URL. */
export interface SiigoBandejaFiltro {
  /** Qué patas mirar. Vacío o ausente = las tres. */
  fuentes?: SiigoBandejaFuente[];
  /** Filtro por motivo: los códigos ya persistidos, tal como los agrupa el resumen. */
  codigos?: string[];
  /** Filtro por cliente. Es el `compania_id` del trámite, un id interno, no un NIT. */
  clientes?: number[];
  /** Antigüedad en días completos desde que ocurrió. `min` = «lleva al menos tantos días». */
  antiguedadDiasMin?: number;
  antiguedadDiasMax?: number;
  /**
   * Ver también lo que alguien dio por perdido (AC6). Apagado por omisión: lo descartado ya no es
   * trabajo pendiente. Encenderlo es el único camino para resucitarlo, así que no se puede quitar.
   */
  incluirDescartados?: boolean;
  limite?: number;
  offset?: number;
}

// ── El ítem (AC1) ───────────────────────────────────────────────────────────

/**
 * El estado NATIVO de cada pata. **Ninguna máquina de estados nueva** (nota de la HU).
 *
 * Los tres campos son nulos salvo el de la pata del caso, y cada uno se pinta con la tabla de
 * etiquetas que ya existe (`SIIGO_COLA_ESTADO_ETIQUETA`, `SIIGO_ESTADO_DIAN_ETIQUETA`,
 * `SIIGO_ENVIO_RESULTADOS`). Un cuarto campo «estado de la bandeja» sería la cuarta definición de
 * algo que ya tiene tres dueños.
 */
export interface SiigoBandejaEstadoNativo {
  cola: SiigoColaEstado | null;
  dian: SiigoEstadoDian | null;
  correo: SiigoEnvioResultado | null;
}

/** El trámite que hay detrás, con su identificador de FLIT para poder buscarlo. */
export interface SiigoBandejaTramite {
  tramiteId: string;
  idFlit: string | null;
}

/**
 * Quién lo dio por perdido, cuándo y por qué (AC5), leído de la bitácora WORM.
 *
 * **No se guarda en ninguna columna nueva.** Está en `siigo_operaciones`, que prohíbe UPDATE y
 * DELETE, así que el marcado anterior y su motivo se conservan aunque se resucite (AC6) — por
 * construcción, no porque alguien se acuerde de copiarlos.
 */
export interface SiigoBandejaDescarte {
  motivo: SiigoBandejaMotivoDescarte | null;
  motivoEtiqueta: string;
  /** La nota opcional, ya saneada. `null` cuando no se escribió ninguna. */
  nota: string | null;
  usuarioId: number | null;
  marcadoEn: string;
}

/** Un caso de la bandeja. Todo lo que el AC1 exige leer sin abrir otra pantalla. */
export interface SiigoBandejaItem {
  fuente: SiigoBandejaFuente;
  /** El identificador de la fila que originó el caso: la factura, el estado DIAN o el acta. */
  refId: string;
  /**
   * La factura del caso. **Va siempre, también en las patas `dian` y `correo`**, porque es la llave
   * con la que se piden las acciones que no son de la bandeja: registrar una corrección
   * (`/api/siigo/correcciones`), ver la línea de tiempo o reenviar el correo.
   */
  facturaId: string;
  facturaNumero: string | null;
  /**
   * Cuándo pasó, y **desde cuándo está detenido: son el mismo instante y por eso hay un solo campo**.
   *
   * Un caso de la bandeja no tiene dos relojes. La emisión fallida se detuvo cuando se escribió el
   * fallo (`siigo_facturas.updated_at`), el rechazo de la DIAN cuando entró la fila del historial y
   * el correo cuando se cerró el acta. Un `detenidoDesde` aparte sería una copia del mismo valor que
   * el día que se calculara distinto haría que el filtro de antigüedad y la columna de la tabla no
   * cuadraran, sin que nada avisara.
   */
  ocurridoEn: string;
  /** Días completos detenido, ya calculados: el filtro de antigüedad se lee sin restar fechas. */
  antiguedadDias: number;
  /** El código ya persistido. `null` solo si no quedó ninguno. */
  codigo: string | null;
  /**
   * Motivo en lenguaje operativo, acción sugerida y responsable: el AC1 entero, ya saneado.
   *
   * `guia.codigo` es el código CRUDO, y va además del texto a propósito: agrupar y filtrar por
   * motivo se hace por código, nunca por la frase. Dos casos con la misma causa comparten código y
   * pueden tener frases distintas —la de Siigo lleva el campo señalado dentro—, así que agrupar por
   * texto partiría en dos un motivo que es uno solo.
   */
  guia: GuiaErrorSiigo;
  /** Lo que dijo la fuente además del código: el motivo de la DIAN, el del acta de envío. */
  detalle: string | null;
  estado: SiigoBandejaEstadoNativo;
  /** La fila de cola, cuando la hay. `null` en una emisión directa histórica sin cola. */
  colaId: string | null;
  intentos: number;
  maxIntentos: number;
  tramites: SiigoBandejaTramite[];
  clienteId: number | null;
  clienteNombre: string | null;
  /** No nulo = alguien lo dio por perdido y solo vuelve si alguien lo resucita (AC5, AC6). */
  descarte: SiigoBandejaDescarte | null;
}

/**
 * Una página de la bandeja.
 *
 * `hayMas` y no un total: contar la unión entera en cada refresco cuesta lo mismo que traerla, y el
 * total exacto ya lo da `/resumen`, que es una sola consulta agrupada. Se resuelve pidiendo una fila
 * de más y descartándola.
 */
export interface SiigoBandejaPagina {
  ambiente: string;
  items: SiigoBandejaItem[];
  limite: number;
  offset: number;
  hayMas: boolean;
}

/** Cuántos casos hay y de qué tipo (AC1). Es lo que decide a quién hay que llamar. */
export interface SiigoBandejaResumen {
  ambiente: string;
  total: number;
  porFuente: Record<SiigoBandejaFuente, number>;
  /** Cuántos casos le tocan a cada responsable. La pregunta «¿esto es mío?» respondida de una vez. */
  porResponsable: Record<ResponsableError, number>;
  /** Los motivos, del más frecuente al menos. Es también el catálogo del filtro por motivo. */
  porCodigo: Array<{ codigo: string; etiqueta: string; total: number; reintentable: boolean }>;
}

// ── El reintento de emisión (AC2, AC3) ──────────────────────────────────────

/**
 * Qué pasó con cada factura del lote de reintento.
 *
 * **Derivado de `SIIGO_RESULTADOS_ENCOLADO`** y no escrito a mano: el reintento de la bandeja no
 * hace nada que `encolar()` no haga, así que si mañana el encolado distingue un caso nuevo aparece
 * aquí solo y el `Record` de contadores obliga a contarlo.
 *
 * Los tres añadidos son los que ocurren ANTES de llegar a la cola:
 *
 *   `descartado_datos` — el AC3. El código dice que el fallo es de un dato nuestro, así que la
 *                        factura sale del lote sin tocar la cola y sin gastar una sola petición.
 *   `no_aplica`        — el lote no se puede reencolar tal cual: es anterior a A1 y no tiene
 *                        conceptos, o perdió su pertenencia. Reventar el lote entero con un 500 por
 *                        una fila histórica es exactamente lo que no puede pasar.
 *   `error`            — falló el reintento de ESA factura. Existe para que el fallo de una no se
 *                        lleve por delante a las demás de la selección.
 */
export const SIIGO_BANDEJA_RESULTADOS = [
  ...SIIGO_RESULTADOS_ENCOLADO, 'descartado_datos', 'no_aplica', 'error',
] as const;
export type SiigoBandejaResultado = (typeof SIIGO_BANDEJA_RESULTADOS)[number];

export const SIIGO_BANDEJA_RESULTADO_ETIQUETA: Record<SiigoBandejaResultado, string> = {
  encolado: 'En cola para emitir',
  reactivado: 'Reactivados',
  ya_en_cola: 'Ya estaban en cola',
  ya_enviado: 'Ya se habían emitido',
  fallido_definitivo: 'Dados por perdidos: hay que resucitarlos a mano',
  descartado_datos: 'No se reintenta: hay que corregir un dato',
  no_aplica: 'No se puede reintentar desde aquí',
  error: 'No se pudo reintentar',
};

/** Los que dejan trabajo nuevo en la cola. Son los que suma `encolados`. */
export const SIIGO_BANDEJA_RESULTADOS_ENCOLADO: readonly SiigoBandejaResultado[] = [
  'encolado', 'reactivado',
];

/**
 * Los que significan «no se encoló y hay que hacer algo».
 *
 * `ya_en_cola` y `ya_enviado` NO están: son respuestas idempotentes a una petición repetida, no
 * rechazos. Contarlos como descarte haría que pulsar dos veces pareciera un problema.
 */
export const SIIGO_BANDEJA_RESULTADOS_DESCARTE: readonly SiigoBandejaResultado[] = [
  'descartado_datos', 'no_aplica', 'fallido_definitivo', 'error',
];

export interface SiigoBandejaItemReintento {
  facturaId: string;
  resultado: SiigoBandejaResultado;
  /**
   * Por qué se descartó, con la acción concreta (AC3). Es `guia.texto`, palabra por palabra: la
   * bandeja no redacta una segunda versión del mismo diagnóstico.
   */
  motivo: string | null;
  guia: GuiaErrorSiigo | null;
  colaId: string | null;
  loteId: string | null;
  estado: SiigoColaEstado | null;
}

/**
 * El recuento (AC2). Los tres números no se solapan: `encolados` es trabajo nuevo, `yaEstaban` es
 * una repetición inocua y `descartados` es lo que exige que alguien actúe.
 */
export interface SiigoBandejaResumenReintento {
  total: number;
  encolados: number;
  yaEstaban: number;
  descartados: number;
  porResultado: Record<SiigoBandejaResultado, number>;
}

export function resumenReintentoVacio(): SiigoBandejaResumenReintento {
  const porResultado = Object.fromEntries(
    SIIGO_BANDEJA_RESULTADOS.map((r) => [r, 0]),
  ) as Record<SiigoBandejaResultado, number>;
  return { total: 0, encolados: 0, yaEstaban: 0, descartados: 0, porResultado };
}

/**
 * Cuenta los resultados. Vive aquí, y no en el servidor, porque la pantalla que muestre el desglose
 * tiene que contar igual: dos aritméticas del mismo hecho acabarían discrepando.
 */
export function resumirReintento(
  items: readonly SiigoBandejaItemReintento[],
): SiigoBandejaResumenReintento {
  const r = resumenReintentoVacio();
  r.total = items.length;
  for (const it of items) {
    r.porResultado[it.resultado] += 1;
    if (SIIGO_BANDEJA_RESULTADOS_ENCOLADO.includes(it.resultado)) r.encolados += 1;
    else if (SIIGO_BANDEJA_RESULTADOS_DESCARTE.includes(it.resultado)) r.descartados += 1;
    else r.yaEstaban += 1;
  }
  return r;
}

/** La respuesta del reintento en lote. **202**: cuando contesta no existe ninguna factura todavía. */
export interface SiigoBandejaRespuestaReintento {
  ambiente: string;
  items: SiigoBandejaItemReintento[];
  resumen: SiigoBandejaResumenReintento;
}

// ── El reenvío de correo (AC2, AC3) ─────────────────────────────────────────

/**
 * Qué pasó con cada correo. **Derivado de `SIIGO_ENVIO_RESULTADOS`**, que es el catálogo del acta:
 * el acta es la que manda sobre qué pasó con un envío, y esta lista no puede contradecirla.
 *
 * `descartado_datos` es el AC3 aplicado al correo: un cliente sin dirección en su ficha nunca llegó
 * a Siigo, así que no hay cuota que gastar — lo que hay es un dato que falta.
 */
export const SIIGO_BANDEJA_RESULTADOS_CORREO = [
  ...SIIGO_ENVIO_RESULTADOS, 'descartado_datos', 'error',
] as const;
export type SiigoBandejaResultadoCorreo = (typeof SIIGO_BANDEJA_RESULTADOS_CORREO)[number];

export const SIIGO_BANDEJA_RESULTADO_CORREO_ETIQUETA:
Record<SiigoBandejaResultadoCorreo, string> = {
  enviado: 'Enviados',
  fallido: 'Siigo rechazó el envío',
  no_realizado: 'No se llegó a enviar',
  descartado_datos: 'No se reintenta: hay que corregir un dato',
  error: 'No se pudo reenviar',
};

export interface SiigoBandejaItemCorreo {
  facturaId: string;
  resultado: SiigoBandejaResultadoCorreo;
  motivo: string | null;
  guia: GuiaErrorSiigo | null;
  /** El acta que quedó, cuando llegó a haberla. Es el registro autorizado de a quién se le mandó. */
  envioId: string | null;
  /** Cuántas direcciones, nunca cuáles: el acta es el único sitio que guarda las direcciones. */
  destinatarios: number;
}

export interface SiigoBandejaResumenCorreo {
  total: number;
  enviados: number;
  descartados: number;
  porResultado: Record<SiigoBandejaResultadoCorreo, number>;
}

export function resumenCorreoVacio(): SiigoBandejaResumenCorreo {
  const porResultado = Object.fromEntries(
    SIIGO_BANDEJA_RESULTADOS_CORREO.map((r) => [r, 0]),
  ) as Record<SiigoBandejaResultadoCorreo, number>;
  return { total: 0, enviados: 0, descartados: 0, porResultado };
}

export function resumirCorreo(
  items: readonly SiigoBandejaItemCorreo[],
): SiigoBandejaResumenCorreo {
  const r = resumenCorreoVacio();
  r.total = items.length;
  for (const it of items) {
    r.porResultado[it.resultado] += 1;
    if (it.resultado === 'enviado') r.enviados += 1;
    else r.descartados += 1;
  }
  return r;
}

/** La respuesta del reenvío. **200**: el acta ya existe cuando esto contesta. */
export interface SiigoBandejaRespuestaCorreo {
  ambiente: string;
  items: SiigoBandejaItemCorreo[];
  resumen: SiigoBandejaResumenCorreo;
}

// ── Dar por perdido y resucitar (AC5, AC6) ──────────────────────────────────

/** Lo que devuelve marcar un caso como perdido: el hecho, tal como quedó escrito. */
export interface SiigoBandejaRespuestaDescarte {
  fuente: SiigoBandejaFuente;
  refId: string;
  facturaId: string;
  colaId: string | null;
  estado: SiigoColaEstado | null;
  descarte: SiigoBandejaDescarte;
}

/**
 * Lo que devuelve resucitar (AC6).
 *
 * `descarteAnterior` viaja en la respuesta a propósito: es la prueba de que resucitar **no borra** el
 * marcado, y quien acaba de pulsar tiene derecho a ver qué está deshaciendo.
 */
export interface SiigoBandejaRespuestaReactivacion {
  fuente: SiigoBandejaFuente;
  refId: string;
  facturaId: string;
  colaId: string | null;
  estado: SiigoColaEstado | null;
  resultado: SiigoBandejaResultado;
  descarteAnterior: SiigoBandejaDescarte | null;
}
