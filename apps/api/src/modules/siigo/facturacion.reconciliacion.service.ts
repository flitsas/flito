// Siigo — recuperar la factura que sí se emitió cuando aquí no consta (HU #11326, AC4 y AC5).
//
// El caso que resuelve es concreto y ocurre: el `POST` llega a Siigo, Siigo crea el documento, y el
// proceso muere —o la base falla— antes de escribir el resultado. La fila local se queda
// `en_proceso` para siempre y su trámite, ocupado. Reintentar a ciegas emitiría una segunda factura
// ante la DIAN; no hacer nada deja el trámite muerto.
//
// **LA REGLA QUE GOBIERNA TODO ESTE ARCHIVO: aquí se consulta, nunca se emite.**
//
// Consultar y después emitir es una carrera —entre las dos peticiones cabe la de otro proceso— y su
// resultado son dos facturas reales. Por eso la reconciliación solo tiene tres desenlaces, y ninguno
// de ellos llama a `POST /v1/invoices`: la deja `emitida` con lo que Siigo tiene, la deja `fallida`
// para que un reintento legítimo la reclame por el camino normal, o **la deja como estaba**.
//
// EL TERCER DESENLACE ES EL QUE IMPORTA
//
// «No la encontré» y «no pude comprobarlo» son cosas distintas y aquí no se pueden confundir. Si un
// error de red, una página que no se llegó a leer o un vínculo que falta se tradujeran a «no
// existe», la fila pasaría a `fallida`, el reintento la reclamaría y emitiría **la segunda factura**.
// Así que solo se concluye que no existe cuando la búsqueda **terminó entera y con éxito**. En
// cualquier otro caso se devuelve `indeterminada` y la fila se queda como está, esperando el
// siguiente barrido.
//
// CÓMO SE BUSCA, Y POR QUÉ NO ES POR OBSERVACIONES
//
// El AC pide buscarla «por el identificador FLIT que viaja en las observaciones». Ese identificador
// es en efecto la marca que permite reconocerla —lo escribe el armador—, pero `GET /v1/invoices` NO
// tiene filtro por observaciones: sus filtros son fecha, nombre, tipo de documento e identificación
// del cliente (ver `docs/integraciones/siigo-api.md` §3). Así que se filtra en Siigo por lo que Siigo
// sabe filtrar —el cliente y el rango de fechas— y se reconoce por las observaciones al leerlas. El
// resultado es el que pide el AC; el camino es el que la API permite.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { siigoFacturas, siigoFacturaTramites } from '../../db/schema.js';
import { logger } from '../../shared/logger.js';
import { siigoRequestOrThrow } from './siigo.client.js';
import { ejecutarConResiliencia } from './siigo.resiliencia.js';
import { registrarOperacion } from './siigo.operaciones.repo.js';
import { detalleTecnico, sanearMensaje } from './siigo.redaccion.js';
import { modoSiigo } from './siigo.mock.js';
import { TZ_COLOMBIA } from '../../shared/utils/fecha-rango.js';
import {
  arrendamientoConfigurado, arrendamientoVencido, cargarTramites, claveCortacircuitosEmision,
  normalizarFacturaEmitida, prepararEmision, revisionDeTotal,
  type FacturaEmitida,
} from './facturacion.emision.service.js';
import type { SiigoAmbiente } from './credenciales.service.js';

const log = logger.child({ component: 'siigo.reconciliacion' });

export const OPERACION_RECONCILIACION = 'factura_reconciliar';

/** Tope de páginas del listado. Llegar a él NO es «no existe»: es no haber terminado de mirar. */
export const MAX_PAGINAS_BUSQUEDA = 10;
const TAM_PAGINA = 100;

/** Margen de días alrededor de la reserva. Cubre una emisión a caballo entre dos días de Bogotá. */
const MARGEN_DIAS = 2;

/**
 * Minutos que descansa una fila entre dos intentos de reconciliación.
 *
 * No es un tope de intentos: una fila nunca deja de reintentarse, porque dejar de mirarla la
 * volvería invisible y su trámite irrecuperable. Es el espaciado que impide que una huérfana que no
 * concluye —un cliente con demasiadas facturas, una compañía sin tercero— consuma diez consultas en
 * cada pasada del barrido, de la misma cuota que necesita la emisión.
 */
export const ESPERA_ENTRE_INTENTOS_MIN = 30;

export type DesenlaceReconciliacion =
  /** Siigo la tiene: la fila local queda emitida con su identificador, número y CUFE. */
  | 'emitida'
  /** Siigo NO la tiene, y de eso hay certeza: la fila queda fallida y se puede reintentar. */
  | 'fallida'
  /** No se pudo comprobar. La fila se queda EXACTAMENTE como estaba. */
  | 'indeterminada'
  /** Su arrendamiento sigue vivo: alguien la está emitiendo ahora mismo y no se toca (AC4). */
  | 'en_curso';

export interface ResultadoReconciliacion {
  facturaId: string;
  desenlace: DesenlaceReconciliacion;
  siigoInvoiceId: string | null;
  /** Por qué quedó indeterminada. `null` en los demás desenlaces. */
  motivo: string | null;
}

/** Una factura candidata a reconciliar, con lo que hace falta para buscarla. */
interface FacturaHuerfana {
  id: string;
  ambiente: string;
  idempotencyKey: string;
  enProcesoDesde: Date | null;
  /** Cuándo se reservó la clave por PRIMERA vez. Fija el inicio de la ventana de búsqueda. */
  createdAt: Date | null;
  estado: string;
  tramiteIds: string[];
  idsFlit: string[];
  identificacion: string | null;
  sucursal: number | null;
  /** Cuándo se tocó por última vez el vínculo del tercero. Ver la guarda de llave en `buscarEnSiigo`. */
  terceroActualizadoEn: Date | null;
}

/**
 * ¿La identificación viene de un derecho de supresión?
 *
 * `ANON-` es la convención del repo para un dato anonimizado; `privacy.routes.ts` la usa con
 * `NOT LIKE 'ANON-%'` para no volver a tocar lo ya anonimizado. Buscar en Siigo con ella no
 * encuentra nada — y ese vacío NO significa que la factura no exista.
 */
function identificacionAnonimizada(identificacion: string): boolean {
  return identificacion.toUpperCase().startsWith('ANON-');
}

/**
 * Carga la huérfana con todo lo necesario para buscarla en Siigo.
 *
 * La identificación sale del vínculo LOCAL (`siigo_terceros`), no de una consulta a Siigo: si para
 * reconciliar hiciera falta preguntar quién es el cliente, un fallo de esa consulta contaminaría el
 * veredicto sobre la factura. Cada pregunta a la red que se pueda evitar es una fuente menos de
 * `indeterminada`.
 */
async function cargarHuerfana(facturaId: string): Promise<FacturaHuerfana | null> {
  const [f] = await db.select({
    id: siigoFacturas.id,
    ambiente: siigoFacturas.ambiente,
    idempotencyKey: siigoFacturas.idempotencyKey,
    enProcesoDesde: siigoFacturas.enProcesoDesde,
    createdAt: siigoFacturas.createdAt,
    estado: siigoFacturas.estado,
  }).from(siigoFacturas).where(eq(siigoFacturas.id, facturaId)).limit(1);
  if (!f) return null;

  const puentes = await db.select({ tramiteId: siigoFacturaTramites.tramiteId })
    .from(siigoFacturaTramites)
    .where(eq(siigoFacturaTramites.facturaId, facturaId));
  const tramiteIds = puentes.map((p) => String(p.tramiteId));

  const datos = await db.execute<Record<string, unknown>>(sql`
    SELECT t.id_flit, st.identificacion, st.sucursal, st.updated_at AS tercero_actualizado_en
      FROM flito_tramites t
      LEFT JOIN siigo_terceros st ON st.client_id = t.compania_id
     WHERE t.id = ANY(${sql.param(tramiteIds)}::uuid[])
  `);
  const filas = datos as unknown as Array<Record<string, unknown>>;

  return {
    id: String(f.id),
    ambiente: String(f.ambiente),
    idempotencyKey: String(f.idempotencyKey),
    // Se PARSEA la cadena, igual que hace `aFila` en la emisión. Degradarla a `null` sin más hacía
    // dos cosas incompatibles a la vez: la búsqueda se centraba en `ahora` —y podía concluir sobre
    // una base infundada— mientras el filtro del barrido, que compara `< corte`, dejaba fuera esa
    // misma fila por ser NULL. La anomalía se trataba de dos formas contradictorias.
    enProcesoDesde: aFecha(f.enProcesoDesde),
    createdAt: aFecha(f.createdAt),
    estado: String(f.estado),
    tramiteIds,
    idsFlit: filas.map((r) => String(r.id_flit)).filter(Boolean),
    identificacion: (filas[0]?.identificacion as string | null) ?? null,
    // `Number.isFinite` y no un `Number` a secas: un valor no numérico daría `NaN`, que viajaría al
    // filtro como `customer_branch_office=NaN`. Siigo devolvería un listado vacío por un filtro
    // absurdo, y ese vacío se leería como «la factura no existe».
    sucursal: sucursalValida(filas[0]?.sucursal),
    terceroActualizadoEn: aFecha(filas[0]?.tercero_actualizado_en),
  };
}

function aFecha(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function sucursalValida(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * `yyyy-MM-dd` desplazado tantos días. Los filtros de Siigo son de fecha, no de instante.
 *
 * En hora de Colombia, igual que `fechaDocumento`, que es con la que se fechó la factura que
 * buscamos. Con UTC, las emisiones de entre las 19:00 y medianoche de Bogotá caen en el día
 * siguiente y la ventana se desplaza. Hoy `MARGEN_DIAS` lo absorbería —pero entonces el margen
 * estaría haciendo un trabajo que nadie escribió, y reducirlo algún día rompería la búsqueda sin
 * que nada avisara.
 */
function dia(base: Date, desplazamiento: number): string {
  const d = new Date(base.getTime() + desplazamiento * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_COLOMBIA, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/**
 * ¿Alguna de estas observaciones es la de nuestra factura?
 *
 * Se compara contra los identificadores FLIT del grupo y se exigen **todos**: una factura
 * consolidada de tres trámites y otra de uno solo de ellos comparten dos de las tres marcas, y
 * confundirlas daría por emitido un grupo que no lo está.
 *
 * La comparación es sobre la cadena completa de observaciones y no sobre un prefijo, porque el
 * armador puede recortarla a cuatro mil caracteres: exigir la forma exacta haría fallar justo las
 * facturas más grandes.
 */
export function observacionesCoinciden(observaciones: unknown, idsFlit: string[]): boolean {
  if (typeof observaciones !== 'string' || idsFlit.length === 0) return false;
  const marcas = identificadoresDeObservaciones(observaciones);
  const buscados = idsFlit.map((id) => id.trim()).filter(Boolean);
  if (buscados.length !== idsFlit.length) return false;

  // Igualdad de CONJUNTOS, no «están todos los míos». Con `every`, un grupo {A} satisfacía la
  // factura de {A, B}: se adjudicaría una factura que cubre además otro trámite, y ese otro quedaría
  // contabilizado como facturado por un documento que aquí no consta. Hoy los grupos son de uno y da
  // igual; el día que se consolide, no.
  return marcas.size === buscados.length && buscados.every((id) => marcas.has(id));
}

/**
 * ¿Se puede reconocer con seguridad un grupo con estos identificadores?
 *
 * El `idFlit` entra **verbatim** del reporte de FLIT (`flit-http.adapter.ts`: `idFlit: it.Id`), sin
 * regex, sin charset y sin recorte. Si uno trae los mismos separadores con los que el armador
 * escribe las observaciones, el texto resultante es ambiguo y el reconocimiento deja de ser fiable
 * **en las dos direcciones**: `'FL|9'` produce las marcas `{FL, 9}`, así que un grupo cuyo id sea
 * `FL` se adjudicaría esa factura ajena; y un id con `·` dentro no se reconocería a sí mismo.
 *
 * Cuando pasa, aquí no se adivina: la búsqueda deja de ser concluyente. Es preferible una huérfana
 * que espera a un veredicto inventado sobre un documento ante la DIAN.
 */
function identificadoresAmbiguos(idsFlit: string[]): string[] {
  return idsFlit.filter((id) => id.includes('|') || id.includes('·') || id.trim() !== id);
}

/**
 * Los identificadores FLIT que hay escritos en unas observaciones.
 *
 * **Por segmentos delimitados, no por subcadena.** `includes` parecía suficiente y no lo era: el
 * `idFlit` llega tal cual del reporte de FLIT, sin formato garantizado, así que `'9001'` está
 * contenido en `'19001'` y en `'90012'`. Con la comparación por subcadena, la factura del trámite
 * 90012 se adjudicaba al trámite 9001 —mismo cliente, misma ventana— y la fila local acababa
 * guardando el identificador, el número y el CUFE **de un documento ajeno**, dado por emitido.
 *
 * El armador escribe `FLITO · <id> · placa <p> · <tipo> | <id2> · …`, así que el identificador es
 * siempre el primer campo de cada bloque separado por `|`.
 */
function identificadoresDeObservaciones(observaciones: string): Set<string> {
  const sinPrefijo = observaciones.startsWith('FLITO · ') ? observaciones.slice('FLITO · '.length) : observaciones;
  return new Set(sinPrefijo.split('|').map((bloque) => bloque.split('·')[0]!.trim()).filter(Boolean));
}

interface Busqueda {
  encontrada: FacturaEmitida | null;
  /** false = la búsqueda no terminó (error, o tope de páginas). NUNCA concluir «no existe». */
  concluyente: boolean;
  motivo: string | null;
  /**
   * true = el impedimento NO se va a resolver reintentando.
   *
   * Existe porque «déjala como estaba y vuelve luego» es la respuesta correcta ante un corte de red
   * y la respuesta equivocada ante una compañía sin tercero vinculado: esa fila volvería a entrar en
   * cada barrido, gastaría hasta diez consultas de la misma cuota que necesita la emisión y
   * escribiría un error en la bitácora que alimenta el freno de la HU #11341 — y su trámite seguiría
   * ocupado para siempre, que es la inmortalidad que el arrendamiento vino a impedir.
   *
   * Lo estructural se marca para revisión humana y deja de barrerse. Lo transitorio se reintenta.
   */
  permanente?: boolean;
}

/**
 * Recorre el listado de Siigo buscando la factura del grupo.
 *
 * Devuelve `concluyente: false` en cuanto algo impide afirmar que se ha mirado todo. Llegar al tope
 * de páginas es uno de esos casos y por eso está aquí y no en un `break` silencioso: un tope que
 * pasa por «no encontrada» es la vía por la que se emitiría la segunda factura.
 */
async function buscarEnSiigo(
  h: FacturaHuerfana, ambiente: SiigoAmbiente, ahora: Date,
): Promise<Busqueda> {
  if (!h.identificacion) {
    return {
      encontrada: null,
      concluyente: false,
      permanente: true,
      motivo: 'La compañía del trámite no tiene tercero vinculado en Siigo: no hay por qué identificación buscar.',
    };
  }
  if (h.idsFlit.length === 0) {
    return {
      encontrada: null,
      concluyente: false,
      permanente: true,
      motivo: 'La factura no tiene trámites vinculados: no hay identificador FLIT con el que reconocerla.',
    };
  }

  const ambiguos = identificadoresAmbiguos(h.idsFlit);
  if (ambiguos.length > 0) {
    return {
      encontrada: null,
      concluyente: false,
      permanente: true,
      motivo: `El identificador FLIT ${ambiguos.join(', ')} contiene separadores o espacios que hacen `
        + 'ambiguas las observaciones: no se puede reconocer la factura con seguridad. '
        + 'Hay que resolverla a mano comprobándola en Siigo.',
    };
  }

  // ── La llave con la que se busca tiene que ser la llave con la que se emitió ──
  //
  // Es la misma confusión de siempre —«no la encontré» contra «busqué mal»— entrando por la única
  // puerta que quedaba. La identificación NO se guarda en `siigo_facturas`: se lee de
  // `siigo_terceros` en el momento de reconciliar, y esa fila es MUTABLE por dos caminos que existen
  // hoy: `asegurarTercero` la reescribe cuando cambia la ficha fiscal del cliente, y el derecho al
  // olvido (Ley 1581) la sustituye por `ANON-…`.
  //
  // Con la identificación cambiada, Siigo responde `total_results: 0` —correctamente: nadie tiene
  // facturas con esa llave— y el recorrido concluye que la factura no existe. La fila pasa a
  // `fallida`, el disparador libera el trámite, y queda escrita en una bitácora que prohíbe
  // rectificar una afirmación FALSA sobre un documento vivo ante la DIAN.
  //
  // No hace falta una columna nueva para cerrarlo: basta con no afirmar nada cuando no se puede
  // demostrar que la llave es la misma.
  if (identificacionAnonimizada(h.identificacion)) {
    return {
      encontrada: null,
      concluyente: false,
      permanente: true,
      motivo: 'La identificación del tercero está anonimizada por un derecho de supresión, así que '
        + 'ya no se puede buscar la factura con la llave con la que se emitió. Hay que comprobarla '
        + 'a mano en Siigo.',
    };
  }
  if (h.terceroActualizadoEn && h.createdAt && h.terceroActualizadoEn > h.createdAt) {
    return {
      encontrada: null,
      concluyente: false,
      permanente: true,
      motivo: 'El tercero se modificó después de reservarse esta factura, así que la identificación '
        + 'de ahora puede no ser la que se usó al emitir. No se puede concluir que la factura no '
        + 'exista; hay que comprobarla a mano en Siigo.',
    };
  }

  // La ventana cubre TODOS los intentos de esta clave: del primero al que está en curso.
  //
  // Anclarla solo en `enProcesoDesde` era un error sutil y peligroso, porque `reclamarFallida`
  // reescribe esa marca en cada reintento: la factura que buscamos pudo crearla un intento
  // ANTERIOR. Un intento el día D que sí llegó a Siigo, y un reintento el día D+10, daban una
  // ventana de [D+8, D+12] donde la factura real —de D— no está; el listado se agotaba, la búsqueda
  // se declaraba concluyente y la fila pasaba a `fallida`. Un «no existe» falso y en firme.
  //
  // Anclarla en `ahora` por arriba era el error contrario, el de la corrección anterior: la ventana
  // crecía sin límite con la edad de la huérfana y acababa rebasando el tope de páginas siempre.
  //
  // Entre los dos extremos de la propia clave la ventana es tan ancha como haga falta y ni un día
  // más: `created_at` es cuándo se reservó por primera vez, `enProcesoDesde` cuándo empezó el
  // intento vivo.
  const primera = h.createdAt ?? h.enProcesoDesde ?? ahora;
  const ultima = h.enProcesoDesde ?? ahora;
  const desde = dia(primera, -MARGEN_DIAS);
  const hasta = dia(ultima, MARGEN_DIAS);
  const vistas = new Set<string>();

  for (let pagina = 1; pagina <= MAX_PAGINAS_BUSQUEDA; pagina++) {
    let datos: unknown;
    try {
      const ruta = '/v1/invoices'
        + `?customer_identification=${encodeURIComponent(h.identificacion)}`
        + (h.sucursal === null ? '' : `&customer_branch_office=${h.sucursal}`)
        + `&created_start=${desde}&created_end=${hasta}`
        + `&page=${pagina}&page_size=${TAM_PAGINA}`;

      datos = await ejecutarConResiliencia(
        () => siigoRequestOrThrow<unknown>({ metodo: 'GET', ruta, ambiente }),
        {
          clave: `siigo:${ambiente}`,
          claveCortacircuitos: claveCortacircuitosEmision(ambiente),
        },
      );
    } catch (e) {
      // Un fallo de consulta NO es una respuesta. Se corta aquí y la fila se queda como está.
      return { encontrada: null, concluyente: false, motivo: sanearMensaje(detalleTecnico(e)) };
    }

    const cuerpo = (typeof datos === 'object' && datos !== null ? datos : {}) as Record<string, unknown>;
    const resultados = Array.isArray(cuerpo.results) ? cuerpo.results : null;
    if (!resultados) {
      return {
        encontrada: null,
        concluyente: false,
        motivo: 'Siigo respondió al listado de facturas con un cuerpo sin resultados legibles.',
      };
    }

    for (const r of resultados) {
      const fila = (typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>;
      if (!observacionesCoinciden(fila.observations, h.idsFlit)) continue;
      try {
        return { encontrada: normalizarFacturaEmitida(fila), concluyente: true, motivo: null };
      } catch (e) {
        // Coincide por observaciones pero no se puede leer: es NUESTRA factura y no se sabe su
        // identificador. Concluir que no existe aquí sería lo peor que puede hacer este archivo.
        return { encontrada: null, concluyente: false, motivo: sanearMensaje(detalleTecnico(e)) };
      }
    }

    // ¿Se ha visto TODO el listado?
    //
    // No se decide por `resultados.length < TAM_PAGINA`. `TAM_PAGINA` es lo que PEDIMOS; cuántos
    // devuelve lo decide el servidor, y la documentación de Siigo muestra un listado respondiendo
    // `page_size: 25` con `total_results: 253` sin declarar máximo. Con la comparación ingenua, una
    // primera página de 25 sobre 253 facturas se habría dado por completa y la búsqueda habría
    // concluido «no existe» habiendo mirado una de cada diez.
    //
    // El dato correcto viene en la misma respuesta: `total_results`. Y si no viene, o no es un
    // número, **no se concluye nada**: sin saber cuántas hay no se puede afirmar haberlas visto
    // todas.
    const paginacion = (typeof cuerpo.pagination === 'object' && cuerpo.pagination !== null
      ? cuerpo.pagination : null) as Record<string, unknown> | null;
    const total = typeof paginacion?.total_results === 'number' ? paginacion.total_results : null;
    if (total === null) {
      return {
        encontrada: null,
        concluyente: false,
        motivo: 'Siigo no informó cuántas facturas hay en total: no se puede afirmar haberlas visto todas.',
      };
    }

    // Se cuentan facturas DISTINTAS, no filas devueltas. El listado no garantiza un orden estable, y
    // FLITO mismo crea facturas del mismo cliente mientras el barrido pagina: con una repetición
    // entre páginas, contar filas alcanzaría el total sin haber visto el conjunto entero — y ese
    // «ya las vi todas» falso se convierte en «la factura no existe».
    for (const r of resultados) {
      const id = (r as { id?: unknown } | null)?.id;
      if (typeof id === 'string' && id) vistas.add(id);
    }
    if (vistas.size >= total) return { encontrada: null, concluyente: true, motivo: null };

    // Una página vacía con un total mayor que lo visto es una respuesta incoherente: seguir pidiendo
    // páginas daría vueltas sin avanzar nunca.
    if (resultados.length === 0) {
      return {
        encontrada: null,
        concluyente: false,
        motivo: `Siigo devolvió una página vacía diciendo que hay ${total} facturas: el listado no se puede recorrer.`,
      };
    }
  }

  // El tope se marca como permanente porque se autoalimenta: el cliente con más facturas de las que
  // caben en diez páginas dentro de la ventana lo superará en TODOS los barridos, no en este.
  return {
    encontrada: null,
    concluyente: false,
    permanente: true,
    motivo: `Se alcanzó el tope de ${MAX_PAGINAS_BUSQUEDA} páginas sin agotar el listado: no se puede afirmar que la factura no exista.`,
  };
}

export interface OpcionesReconciliacion {
  ambiente: SiigoAmbiente;
  usuarioId?: number | null;
  ahora?: () => Date;
  arrendamientoMin?: number;
}

/**
 * AC5 — Reconcilia UNA factura huérfana.
 *
 * Solo actúa sobre filas `en_proceso` con el arrendamiento vencido: una que sigue dentro de su
 * arrendamiento tiene un proceso vivo detrás, y tocarla sería competir con él.
 */
export async function reconciliarFactura(
  facturaId: string, opciones: OpcionesReconciliacion,
): Promise<ResultadoReconciliacion> {
  const ahora = (opciones.ahora ?? (() => new Date()))();
  const inicio = Date.now();

  const h = await cargarHuerfana(facturaId);
  if (!h) {
    return { facturaId, desenlace: 'indeterminada', siigoInvoiceId: null, motivo: 'La factura no existe.' };
  }
  if (h.estado !== 'en_proceso') {
    return {
      facturaId, desenlace: 'indeterminada', siigoInvoiceId: null,
      motivo: `La factura ya no está en proceso (${h.estado}): no hay nada que reconciliar.`,
    };
  }
  if (h.ambiente !== opciones.ambiente) {
    // `pruebas` y `produccion` son EMPRESAS distintas de Siigo. Buscar una factura de pruebas en el
    // ambiente real no la encontraría —lógicamente— y esa ausencia se tomaría por «no existe», con
    // lo que la fila quedaría fallida y un reintento la emitiría de verdad. Se corta antes.
    return {
      facturaId, desenlace: 'indeterminada', siigoInvoiceId: null,
      motivo: `La factura es del ambiente ${h.ambiente} y se está reconciliando contra ${opciones.ambiente}.`,
    };
  }

  const minutos = opciones.arrendamientoMin ?? await arrendamientoConfigurado(opciones.ambiente);
  if (!arrendamientoVencido(h, minutos, ahora)) {
    return { facturaId, desenlace: 'en_curso', siigoInvoiceId: null, motivo: null };
  }

  const busqueda = await buscarEnSiigo(h, opciones.ambiente, ahora);
  const modo = modoSiigo();

  if (!busqueda.concluyente) {
    log.warn({ facturaId, motivo: busqueda.motivo, permanente: busqueda.permanente === true },
      'reconciliación indeterminada: la fila se deja intacta');

    // Lo estructural se marca para que se VEA, pero **no se saca del barrido**.
    //
    // La versión anterior de esta corrección lo excluía, y era peor que el problema que arreglaba:
    // hoy no hay ninguna pantalla ni endpoint que lea `requiere_revision`, así que la fila quedaba
    // `en_proceso` —estado que el reporte enseña como «se resuelve solo, nadie tiene que hacer
    // nada»—, sin volver jamás al barrido, sin nadie que pudiera quitarle la marca, y con su trámite
    // retenido para siempre por el índice de facturas vivas. Un estado terminal sin lector no es una
    // salida: es una fila que solo se rescata con un UPDATE a mano en producción.
    //
    // Lo que sí acota el gasto es el `updatedAt` que se escribe aquí: el barrido no vuelve a mirar
    // una fila hasta pasado `ESPERA_ENTRE_INTENTOS_MIN`, así que un impedimento permanente cuesta
    // una pasada de vez en cuando y no una en cada barrido. Cuando exista la bandeja que lea esta
    // marca (HU #11331), se podrá decidir si además conviene excluirla.
    await db.update(siigoFacturas).set({
      ...(busqueda.permanente === true
        ? {
          requiereRevision: true,
          revisionMotivo: `La reconciliación no puede concluir y no se resolverá sola: ${busqueda.motivo}`,
        }
        : {}),
      updatedAt: ahora,
    }).where(and(eq(siigoFacturas.id, facturaId), eq(siigoFacturas.estado, 'en_proceso')));

    await registrarOperacion({
      operacion: OPERACION_RECONCILIACION,
      entidadTipo: 'siigo_factura',
      entidadId: facturaId,
      ambiente: opciones.ambiente,
      modo,
      // **Lo permanente NO es un fallo del servicio, y confundirlos frena la facturación entera.**
      //
      // El freno de la HU #11341 mide `error_tecnico` en el numerador Y en el denominador;
      // `error_negocio` queda fuera de los dos, porque es el resultado de «un dato nuestro está
      // mal». Un impedimento permanente —la compañía sin tercero vinculado, una identificación
      // anonimizada por un derecho de supresión, un identificador FLIT ambiguo— es exactamente eso,
      // y encima se detecta **antes de la primera petición**: no dice absolutamente nada sobre la
      // salud de Siigo.
      //
      // Registrarlo como `error_tecnico` tenía una consecuencia que solo aparece al engancharlo al
      // trabajador de la HU #11327: el barrido corre cada dos minutos, una huérfana permanente
      // vuelve cada media hora, y eso son unos cuarenta y ocho fallos diarios sin una sola llamada a
      // la red. Bastaba una factura atascada y un fin de semana flojo para que el freno saltara y la
      // empresa dejara de facturar por un problema que no tenía nada que ver con Siigo. Es el mismo
      // razonamiento que ya dejó fuera al sondeo DIAN, escrito unas líneas más arriba en
      // `siigo.freno.service.ts`.
      //
      // Lo TRANSITORIO sigue midiéndose: un corte de red o un cuerpo ilegible sí hablan del
      // servicio, y son justo lo que el freno existe para detectar.
      resultado: busqueda.permanente === true ? 'error_negocio' : 'error_tecnico',
      codigo: 'reconciliacion_indeterminada',
      mensaje: busqueda.motivo,
      duracionMs: Date.now() - inicio,
      createdBy: opciones.usuarioId ?? null,
    });
    return { facturaId, desenlace: 'indeterminada', siigoInvoiceId: null, motivo: busqueda.motivo };
  }

  if (busqueda.encontrada) {
    const emitida = busqueda.encontrada;
    // El total esperado se reconstruye con el MISMO armador y los mismos datos sellados: una
    // segunda forma de calcularlo aquí discreparía de la emisión sobre la misma factura.
    const revision = await revisionEsperada(h, opciones.ambiente, emitida, ahora);

    const escritas = await db.update(siigoFacturas).set({
      estado: 'emitida',
      siigoInvoiceId: emitida.siigoInvoiceId,
      numero: emitida.numero,
      comprobanteNombre: emitida.comprobanteNombre,
      cufe: emitida.cufe,
      publicUrl: emitida.publicUrl,
      totalSiigo: emitida.total === null ? null : emitida.total.toFixed(2),
      enviadaEn: ahora,
      enProcesoDesde: null,
      requiereRevision: revision !== null,
      revisionMotivo: revision,
      updatedAt: ahora,
    }).where(and(eq(siigoFacturas.id, facturaId), eq(siigoFacturas.estado, 'en_proceso')))
      .returning({ id: siigoFacturas.id });

    // Si no se escribió nada, el emisor resolvió la fila mientras buscábamos. La condición hizo su
    // trabajo — pero afirmar igualmente el desenlace escribiría en una bitácora que prohíbe
    // rectificar un hecho que no ocurrió.
    if (escritas.length === 0) {
      return {
        facturaId, desenlace: 'indeterminada', siigoInvoiceId: null,
        motivo: 'La fila dejó de estar en proceso mientras se reconciliaba: la resolvió su emisor.',
      };
    }

    await registrarOperacion({
      operacion: OPERACION_RECONCILIACION,
      entidadTipo: 'siigo_factura',
      entidadId: facturaId,
      ambiente: opciones.ambiente,
      modo,
      responseBody: emitida,
      resultado: 'ok',
      codigo: 'reconciliada_emitida',
      duracionMs: Date.now() - inicio,
      createdBy: opciones.usuarioId ?? null,
    });
    return { facturaId, desenlace: 'emitida', siigoInvoiceId: emitida.siigoInvoiceId, motivo: null };
  }

  // Siigo NO la tiene, y la búsqueda fue concluyente. `fallida` libera el trámite por disparador,
  // así que el reintento legítimo puede reclamarla por el camino normal — con la MISMA clave, que
  // es lo que impide que ese reintento duplique nada si Siigo apareciera con ella más tarde.
  const liberadas = await db.update(siigoFacturas).set({
    estado: 'fallida',
    enProcesoDesde: null,
    errorCode: 'reconciliada_inexistente',
    errorDetalle: 'La emisión se quedó a medias y Siigo no tiene la factura. Se puede volver a intentar.',
    updatedAt: ahora,
  }).where(and(eq(siigoFacturas.id, facturaId), eq(siigoFacturas.estado, 'en_proceso')))
    .returning({ id: siigoFacturas.id });

  if (liberadas.length === 0) {
    return {
      facturaId, desenlace: 'indeterminada', siigoInvoiceId: null,
      motivo: 'La fila dejó de estar en proceso mientras se reconciliaba: la resolvió su emisor.',
    };
  }

  await registrarOperacion({
    operacion: OPERACION_RECONCILIACION,
    entidadTipo: 'siigo_factura',
    entidadId: facturaId,
    ambiente: opciones.ambiente,
    modo,
    resultado: 'ok',
    codigo: 'reconciliada_inexistente',
    duracionMs: Date.now() - inicio,
    createdBy: opciones.usuarioId ?? null,
  });
  return { facturaId, desenlace: 'fallida', siigoInvoiceId: null, motivo: null };
}

// ── La salida humana ────────────────────────────────────────────────────────

/** Qué dice la persona que fue a mirarlo a Siigo Nube. */
export type VeredictoHumano =
  /** «La factura existe, aquí está su identificador.» */
  | { existe: true; siigoInvoiceId: string }
  /** «He mirado y Siigo no la tiene.» */
  | { existe: false };

export class SiigoReconciliacionError extends Error {
  readonly codigo: 'no_existe' | 'no_aplica' | 'datos';

  constructor(codigo: SiigoReconciliacionError['codigo'], message: string) {
    super(message);
    this.name = 'SiigoReconciliacionError';
    this.codigo = codigo;
  }
}

/**
 * Comprueba en Siigo que el documento que señala la persona existe Y es el de estos trámites.
 *
 * Se lee y se contrasta contra las observaciones, la misma marca que usa el barrido. Aceptar el
 * identificador a ciegas convertía el endpoint en la puerta a una fila `emitida` falsa —terminal en
 * todo el repositorio— y a un trámite retenido para siempre.
 *
 * Si no se puede comprobar, **no se escribe**: quien resuelve recibe el motivo y vuelve a intentarlo.
 * Es preferible una huérfana que espera a una afirmación sin comprobar sobre un documento fiscal.
 */
async function confirmarEnSiigo(
  h: FacturaHuerfana, siigoInvoiceId: string, ambiente: SiigoAmbiente,
): Promise<void> {
  let datos: unknown;
  try {
    datos = await ejecutarConResiliencia(
      () => siigoRequestOrThrow<unknown>({
        metodo: 'GET', ruta: `/v1/invoices/${encodeURIComponent(siigoInvoiceId)}`, ambiente,
      }),
      { clave: `siigo:${ambiente}`, claveCortacircuitos: claveCortacircuitosEmision(ambiente) },
    );
  } catch (e) {
    throw new SiigoReconciliacionError(
      'datos',
      `No se pudo comprobar esa factura en Siigo, así que no se escribió nada: ${detalleTecnico(e)}`,
    );
  }

  let leida;
  try {
    leida = normalizarFacturaEmitida(datos);
  } catch {
    throw new SiigoReconciliacionError(
      'datos', 'Siigo respondió algo que no parece una factura. No se escribió nada.',
    );
  }
  if (leida.siigoInvoiceId !== siigoInvoiceId) {
    throw new SiigoReconciliacionError(
      'datos', 'Siigo devolvió una factura distinta de la pedida. No se escribió nada.',
    );
  }

  const obs = (datos as { observations?: unknown }).observations;
  if (!observacionesCoinciden(obs, h.idsFlit)) {
    throw new SiigoReconciliacionError(
      'datos',
      `La factura ${siigoInvoiceId} existe en Siigo pero no es la de este trámite: sus observaciones `
      + 'no lo mencionan. Comprueba el identificador antes de volver a intentarlo.',
    );
  }
}

/**
 * Resuelve a mano una huérfana que la máquina no puede comprobar.
 *
 * **Por qué existe.** La historia pide que «cada estado de esa reserva tenga una salida», y hay un
 * caso en que la búsqueda automática no puede darla: un cliente con más facturas en la ventana de
 * las que caben en el tope de páginas, un identificador FLIT ambiguo, una compañía sin tercero. Sin
 * esto, esa fila se queda `en_proceso` para siempre y su trámite retenido por el índice de facturas
 * vivas — irrecuperable salvo con un UPDATE a mano en producción, que no es una salida.
 *
 * **Lo que hace y lo que no.** No emite. Registra el veredicto de alguien que FUE A MIRARLO, y
 * cuando ese veredicto es «existe», lo **comprueba** con una lectura antes de escribirlo. Consultar
 * está permitido aquí —la regla del archivo es no emitir—, y hace falta: `emitida` es un estado del
 * que no sale nadie en todo el repositorio, así que un identificador mal tecleado dejaría la fila y
 * su trámite irrecuperables, y además el sondeo DIAN la consultaría eternamente contra un documento
 * que no existe, alimentando el freno que bloquea la integración.
 *
 * **Dos guardas de tiempo, no una.** La de estado impide pisar lo que la máquina ya resolvió. La de
 * arrendamiento impide pisar lo que la máquina está resolviendo AHORA: el veredicto humano es rancio
 * por construcción —se forma minutos antes del clic— y entre la comprobación y el envío cabe un
 * reintento entero que sí creó el documento. Es exactamente la razón por la que el barrido no toca
 * una fila con arrendamiento vivo, y faltaba aquí.
 */
export async function resolverHuerfanaAMano(
  facturaId: string,
  veredicto: VeredictoHumano,
  ctx: {
    ambiente: SiigoAmbiente; usuarioId: number; ahora?: () => Date; arrendamientoMin?: number;
  },
): Promise<ResultadoReconciliacion> {
  const ahora = (ctx.ahora ?? (() => new Date()))();

  const h = await cargarHuerfana(facturaId);
  if (!h) throw new SiigoReconciliacionError('no_existe', 'La factura no existe.');
  if (h.estado !== 'en_proceso') {
    throw new SiigoReconciliacionError(
      'no_aplica',
      `La factura ya está ${h.estado}: no hay ninguna reserva a medias que resolver.`,
    );
  }
  if (h.ambiente !== ctx.ambiente) {
    throw new SiigoReconciliacionError(
      'no_aplica',
      `La factura es del ambiente ${h.ambiente} y se está resolviendo desde ${ctx.ambiente}.`,
    );
  }

  const minutos = ctx.arrendamientoMin ?? await arrendamientoConfigurado(ctx.ambiente);
  if (!arrendamientoVencido(h, minutos, ahora)) {
    throw new SiigoReconciliacionError(
      'no_aplica',
      'La factura tiene una emisión en curso ahora mismo. Espera a que termine: resolverla a mano '
      + 'mientras hay una petición en vuelo puede dejar el trámite libre con el documento ya creado.',
    );
  }

  // El «sí existe» se COMPRUEBA. Y no basta con que el identificador exista en Siigo: tiene que ser
  // la factura de ESTOS trámites. Sin esta segunda parte, pegar por error el identificador de otro
  // cliente dejaría este trámite apuntando al documento de aquel — y `emitida` no tiene marcha atrás.
  if (veredicto.existe) await confirmarEnSiigo(h, veredicto.siigoInvoiceId, ctx.ambiente);

  const comun = {
    enProcesoDesde: null,
    updatedAt: ahora,
    requiereRevision: true,
    revisionMotivo: veredicto.existe
      ? 'Resuelta a mano: una persona la localizó en Siigo y FLITO comprobó el documento. Conviene '
        + 'revisar el número, el CUFE y el total, que se completarán con el sondeo.'
      : 'Resuelta a mano: una persona confirmó en Siigo que la factura no existe y liberó el trámite.',
  };

  const filas = veredicto.existe
    ? await db.update(siigoFacturas).set({
      ...comun,
      estado: 'emitida',
      siigoInvoiceId: veredicto.siigoInvoiceId,
      enviadaEn: ahora,
    }).where(and(eq(siigoFacturas.id, facturaId), eq(siigoFacturas.estado, 'en_proceso')))
      .returning({ id: siigoFacturas.id })
    : await db.update(siigoFacturas).set({
      ...comun,
      estado: 'fallida',
      errorCode: 'resuelta_a_mano',
      errorDetalle: 'Una persona comprobó en Siigo que la factura no llegó a crearse.',
    }).where(and(eq(siigoFacturas.id, facturaId), eq(siigoFacturas.estado, 'en_proceso')))
      .returning({ id: siigoFacturas.id });

  if (filas.length === 0) {
    throw new SiigoReconciliacionError(
      'no_aplica', 'La factura dejó de estar en proceso mientras se resolvía: la resolvió su emisor.',
    );
  }

  // `marcar_fallido` es la acción del catálogo que gobierna esto y el registro lleva quién lo hizo:
  // una afirmación humana sobre un documento fiscal tiene que poder atribuirse.
  await registrarOperacion({
    operacion: OPERACION_RECONCILIACION,
    entidadTipo: 'siigo_factura',
    entidadId: facturaId,
    ambiente: ctx.ambiente,
    modo: modoSiigo(),
    resultado: 'ok',
    codigo: veredicto.existe ? 'resuelta_a_mano_existe' : 'resuelta_a_mano_no_existe',
    mensaje: veredicto.existe ? `Confirmada en Siigo como ${veredicto.siigoInvoiceId}.` : null,
    createdBy: ctx.usuarioId,
  });

  return {
    facturaId,
    desenlace: veredicto.existe ? 'emitida' : 'fallida',
    siigoInvoiceId: veredicto.existe ? veredicto.siigoInvoiceId : null,
    motivo: null,
  };
}

/**
 * AC6 desde la reconciliación: el total esperado, recalculado con el mismo armador.
 *
 * Si no se puede reconstruir —falta el vínculo del tercero, o el mapeo cambió— **no se afirma que
 * cuadre**: se marca para revisión diciendo que no se pudo comprobar. Un silencio aquí sería un
 * descuadre dado por bueno.
 */
async function revisionEsperada(
  h: FacturaHuerfana, ambiente: SiigoAmbiente, emitida: FacturaEmitida, ahora: Date,
): Promise<string | null> {
  if (!h.identificacion) {
    return 'No se pudo recalcular el total esperado: la compañía no tiene tercero vinculado.';
  }
  try {
    const preparacion = await prepararEmision({
      tramiteIds: h.tramiteIds,
      tramites: await cargarTramites(h.tramiteIds),
      ambiente,
      tercero: { identificacion: h.identificacion, sucursal: h.sucursal ?? 0 },
      ahora,
    });
    return revisionDeTotal(emitida.total, preparacion.armada._total);
  } catch (e) {
    return `No se pudo recalcular el total esperado para comprobarlo: ${detalleTecnico(e)}`;
  }
}

/**
 * AC4 — El barrido: todas las huérfanas de un ambiente.
 *
 * Se expone aquí y lo invoca el trabajador de la HU #11327. Corre aunque no haya nada pendiente en
 * la cola, porque una huérfana es precisamente una fila que ya no tiene a nadie esperándola.
 */
export async function reconciliarHuerfanas(
  opciones: OpcionesReconciliacion & { limite?: number },
): Promise<ResultadoReconciliacion[]> {
  const ahora = (opciones.ahora ?? (() => new Date()))();
  const minutos = opciones.arrendamientoMin ?? await arrendamientoConfigurado(opciones.ambiente);
  const limite = Math.min(opciones.limite ?? 50, 200);
  const corte = new Date(ahora.getTime() - minutos * 60_000);
  const esperaHasta = new Date(ahora.getTime() - ESPERA_ENTRE_INTENTOS_MIN * 60_000);

  const filas = await db.select({ id: siigoFacturas.id })
    .from(siigoFacturas)
    .where(and(
      eq(siigoFacturas.ambiente, opciones.ambiente),
      eq(siigoFacturas.estado, 'en_proceso'),
      sql`${siigoFacturas.enProcesoDesde} < ${corte}`,
      // Espera entre intentos, y NO exclusión. Ninguna fila desaparece del barrido —eso la volvería
      // invisible y su trámite, irrecuperable— pero tampoco se reintenta en cada pasada: cada
      // reconciliación toca `updated_at`, así que una que no concluye descansa antes de volver.
      // Es lo que impide que una huérfana imposible gaste diez consultas por barrido de la misma
      // cuota que necesita la emisión, y que llene de errores la bitácora que alimenta el freno.
      sql`${siigoFacturas.updatedAt} < ${esperaHasta}`,
    ))
    // Las más antiguas primero: son las que llevan más tiempo con su trámite retenido.
    .orderBy(siigoFacturas.enProcesoDesde)
    .limit(limite);

  const salida: ResultadoReconciliacion[] = [];
  for (const f of filas) {
    // Una a una y en serie: cada reconciliación consulta a Siigo, y la cuota que gastan es la misma
    // que necesita la emisión. En paralelo, un barrido grande dejaría sin turnos a lo que sí factura.
    salida.push(await reconciliarFactura(String(f.id), { ...opciones, arrendamientoMin: minutos }));
  }
  return salida;
}
