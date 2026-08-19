// Siigo API — sincronización y caché de los catálogos de parametrización (HU #11281).
//
// Siigo permite 100 peticiones por minuto POR EMPRESA. Los catálogos —tipos de comprobante,
// vendedores, formas de pago, impuestos, grupos de inventario y centros de costo— cambian con muy
// poca frecuencia y se consultan constantemente para pintar una pantalla de parametrización.
// Consultarlos en vivo gastaría la cuota que necesitan las facturas en respuestas idénticas.
//
// Seis decisiones que sostienen el diseño:
//
//   1. CADA CATÁLOGO ES INDEPENDIENTE. Cada uno tiene su propio try/catch y solo escribe si su
//      respuesta llegó completa. Que `/v1/taxes` esté caído no puede dejar los vendedores a medias
//      ni borrar los que ya había (AC5).
//   2. NO SE BORRA NADA. Un elemento que deja de venir se marca `activo = false`. Una factura
//      emitida hace un año referencia un centro de costo que quizá ya no existe; sin la fila no
//      habría forma de explicar esa parametrización (AC4).
//   3. TODO PASA POR `ejecutarConResiliencia`, y el LIMITADOR DE TASA usa UNA SOLA clave para los
//      seis catálogos. Con una clave por catálogo permitiría 600 peticiones por minuto mientras cree
//      que respeta 100 — que es exactamente la forma de saltarse el límite creyendo que se cumple
//      (AC2).
//   4. EL CORTACIRCUITOS, EN CAMBIO, VA POR CATÁLOGO. Comparte mecanismo con el limitador pero mide
//      otra cosa: la cuota es de la empresa, la salud es del endpoint. Con clave compartida, tres
//      catálogos caídos abren el circuito en el quinto fallo y los tres sanos se quedan sin una sola
//      petición; y tras una caída total el reintento manual del operador queda muerto un minuto
//      aunque Siigo ya responda. Son dos preocupaciones distintas, con dos claves distintas.
//   5. LA COPIA ES POR AMBIENTE. `pruebas` y `produccion` son empresas DISTINTAS en Siigo, con
//      identificadores propios. Toda escritura y toda lectura filtran por `ambiente`; en particular
//      la inactivación de «lo que no vino», que de otro modo daría de baja el catálogo entero del
//      otro ambiente solo porque no apareció en esta respuesta.
//   6. DEL CATÁLOGO DE VENDEDORES SOLO SE GUARDA EL NOMBRE. Siigo devuelve además `identification`
//      y `email`; son datos personales bajo la Ley 1581 y no hacen falta para elegir un vendedor,
//      así que no entran a la base ni a la bitácora.

import { and, asc, eq, notInArray, sql } from 'drizzle-orm';
import type {
  SiigoAmbienteCatalogo, SiigoCatalogoElemento, SiigoCatalogoLocal, SiigoCatalogoResumen,
  SiigoResultadoCatalogo, SiigoResultadoSincronizacion, SiigoTipoCatalogo,
} from '@operaciones/shared-types';
import { SIIGO_CATALOGO_ETIQUETAS, SIIGO_TIPOS_CATALOGO } from '@operaciones/shared-types';
import { CircuitoAbiertoError } from '../../services/circuitBreaker.js';
import { db } from '../../db/client.js';
import { siigoCatalogos } from '../../db/schema.js';
import { SiigoEncKeyError } from '../../shared/utils/crypto.js';
import { siigoRequestOrThrow } from './siigo.client.js';
import { resolverConfig, SiigoConfigError } from './siigo.config.js';
import { SiigoCredencialError, type SiigoAmbiente } from './credenciales.service.js';
import { SiigoApiError } from './siigo.errors.js';
import { modoSiigo } from './siigo.mock.js';
import { registrarOperacion } from './siigo.operaciones.repo.js';
import { detalleTecnico, sanearMensaje } from './siigo.redaccion.js';
import { ejecutarConResiliencia, SiigoOperacionFallida } from './siigo.resiliencia.js';
import { SiigoAuthError } from './siigo.token.js';

/** Elemento ya normalizado, listo para persistir. */
interface ElementoNormalizado {
  codigo: string;
  nombre: string;
  descripcion: string | null;
  activo: boolean;
  atributos: Record<string, unknown> | null;
}

interface DefinicionCatalogo {
  tipo: SiigoTipoCatalogo;
  /** Ruta relativa contra Siigo, con sus parámetros de consulta ya resueltos. */
  ruta: string;
  normalizar: (crudo: unknown) => ElementoNormalizado | null;
}

/**
 * Un intento por catálogo además del primero.
 *
 * La sincronización la dispara una persona que está mirando la pantalla: cuatro reintentos por seis
 * catálogos serían 24 peticiones y una espera larga para acabar diciendo lo mismo. Dos intentos
 * absorben el hipo transitorio sin convertir un botón en un proceso por lotes.
 */
const MAX_INTENTOS_CATALOGO = 2;

/** Los catálogos son listas pequeñas: no necesitan los 120 s del POST de comprobantes. */
const TIMEOUT_CATALOGO_MS = 30_000;

/** Tope defensivo: una respuesta anómala no puede intentar escribir un millón de filas. */
const MAX_ELEMENTOS_POR_CATALOGO = 5_000;

/** Lotes del upsert. Los catálogos reales caben en uno solo; esto acota el caso patológico. */
const TAMANO_LOTE = 500;

/**
 * Clave del limitador de tasa. Una sola para toda la sincronización de un ambiente: la cuota de
 * Siigo es por empresa, no por catálogo.
 */
export function claveResiliencia(ambiente: string): string {
  return `catalogos:${ambiente}`;
}

/**
 * Circuito del cortacircuitos: UNO POR CATÁLOGO Y AMBIENTE.
 *
 * Deliberadamente distinta de `claveResiliencia`. Con el circuito compartido, tres catálogos caídos
 * suman los cinco fallos del umbral y los tres sanos —que habrían respondido— no reciben ni una
 * petición; y tras una caída total, el reintento del operador queda rechazado sesenta segundos
 * aunque Siigo ya esté arriba. Por catálogo, cada lista falla y se recupera por su cuenta.
 */
export function claveCortacircuitos(ambiente: string, tipo: SiigoTipoCatalogo): string {
  return `siigo:catalogos:${ambiente}:${tipo}`;
}

/**
 * Ambiente efectivo cuando quien llama no lo dice.
 *
 * No lanza: leer la copia local no puede depender de que el `Partner-Id` esté configurado. Sin
 * configuración se asume `pruebas`, que es el ambiente en el que no se emite nada ante la DIAN — si
 * hay que equivocarse, que sea hacia el lado que no factura.
 */
function ambienteEfectivo(explicito?: SiigoAmbiente): SiigoAmbienteCatalogo {
  if (explicito) return explicito;
  try {
    return resolverConfig().ambiente;
  } catch {
    return 'pruebas';
  }
}

// ── Normalizadores ──────────────────────────────────────────────────────────
//
// Cada catálogo tiene su propia forma. Se traducen aquí, una sola vez, a la estructura común de la
// tabla. Un elemento sin identificador se descarta en vez de guardarse con código vacío: una fila
// sin código no se puede referenciar desde una parametrización, así que no sirve para nada.

function texto(v: unknown): string | null {
  if (typeof v === 'string') { const t = v.trim(); return t.length > 0 ? t : null; }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function codigoDe(crudo: unknown): string | null {
  const id = (crudo as { id?: unknown }).id;
  return texto(id);
}

/** Siigo omite `active` en algunos catálogos; ausente significa vigente. */
function activoDe(crudo: unknown): boolean {
  const v = (crudo as { active?: unknown }).active;
  return typeof v === 'boolean' ? v : true;
}

function numero(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

const DEFINICIONES: DefinicionCatalogo[] = [
  {
    // Tipos de comprobante de venta. `type=FV` es obligatorio: sin él Siigo devuelve también
    // facturas de compra, notas y recibos, que no se pueden emitir desde aquí.
    tipo: 'document_type',
    ruta: '/v1/document-types?type=FV',
    normalizar: (crudo) => {
      const codigo = codigoDe(crudo);
      if (!codigo) return null;
      const c = crudo as Record<string, unknown>;
      const nombre = texto(c.name) ?? texto(c.description) ?? `Comprobante ${codigo}`;
      return {
        codigo,
        nombre,
        descripcion: texto(c.description),
        activo: activoDe(crudo),
        atributos: {
          code: texto(c.code),
          tipo: texto(c.type),
          tipoElectronico: texto(c.electronic_type),
          // Lo que decide si la parametrización debe exigir centro de costo (HUs #11282–#11284).
          manejaCentroCosto: c.cost_center === true,
          centroCostoObligatorio: c.cost_center_mandatory === true,
          numeracionAutomatica: c.automatic_number === true,
          consecutivo: numero(c.consecutive),
          manejaDecimales: c.decimals === true,
          tipoDescuento: texto(c.discount_type),
          manejaAnticipo: c.advance_payment === true,
          vendedorPorItem: c.seller_by_item === true,
        },
      };
    },
  },
  {
    // Vendedores. Solo el nombre: `identification` y `email` son datos personales (Ley 1581) y no
    // hacen falta para elegir un vendedor en una factura.
    tipo: 'user',
    ruta: '/v1/users',
    normalizar: (crudo) => {
      const codigo = codigoDe(crudo);
      if (!codigo) return null;
      const c = crudo as Record<string, unknown>;
      const nombre = [texto(c.first_name), texto(c.last_name)].filter(Boolean).join(' ').trim();
      return {
        codigo,
        // Si Siigo no trae nombre no se cae al `username`: en Siigo el username es el correo, y
        // guardarlo metería un dato personal por la puerta de atrás.
        nombre: nombre.length > 0 ? nombre : `Vendedor ${codigo}`,
        descripcion: null,
        activo: activoDe(crudo),
        atributos: null,
      };
    },
  },
  {
    tipo: 'payment_type',
    ruta: '/v1/payment-types?document_type=FV',
    normalizar: (crudo) => {
      const codigo = codigoDe(crudo);
      if (!codigo) return null;
      const c = crudo as Record<string, unknown>;
      return {
        codigo,
        nombre: texto(c.name) ?? `Forma de pago ${codigo}`,
        descripcion: null,
        activo: activoDe(crudo),
        atributos: {
          tipo: texto(c.type),
          // Siigo no admite más de una forma de pago cuando alguna maneja vencimiento, y entonces
          // `due_date` pasa a ser obligatorio. La validación de la factura necesita saberlo.
          manejaVencimiento: c.due_date === true,
        },
      };
    },
  },
  {
    tipo: 'tax',
    ruta: '/v1/taxes',
    normalizar: (crudo) => {
      const codigo = codigoDe(crudo);
      if (!codigo) return null;
      const c = crudo as Record<string, unknown>;
      return {
        codigo,
        nombre: texto(c.name) ?? `Impuesto ${codigo}`,
        descripcion: null,
        activo: activoDe(crudo),
        atributos: { tipo: texto(c.type), porcentaje: numero(c.percentage) },
      };
    },
  },
  {
    tipo: 'account_group',
    ruta: '/v1/account-groups',
    normalizar: (crudo) => {
      const codigo = codigoDe(crudo);
      if (!codigo) return null;
      const c = crudo as Record<string, unknown>;
      return {
        codigo,
        nombre: texto(c.name) ?? `Grupo ${codigo}`,
        descripcion: null,
        activo: activoDe(crudo),
        atributos: null,
      };
    },
  },
  {
    // Centros de costo. NO está en `docs/integraciones/siigo-api.md`; se verificó contra el
    // blueprint de Apiary (`## Centros de Costo [GET /v1/cost-centers]`, estructura `CostCenter`),
    // que documenta id, code, name y active. La doc del repo se amplió con esta sección.
    tipo: 'cost_center',
    ruta: '/v1/cost-centers',
    normalizar: (crudo) => {
      const codigo = codigoDe(crudo);
      if (!codigo) return null;
      const c = crudo as Record<string, unknown>;
      const codigoContable = texto(c.code);
      return {
        codigo,
        nombre: texto(c.name) ?? `Centro de costo ${codigo}`,
        descripcion: codigoContable,
        activo: activoDe(crudo),
        atributos: { code: codigoContable },
      };
    },
  },
];

const DEFINICION_POR_TIPO = new Map<SiigoTipoCatalogo, DefinicionCatalogo>(
  DEFINICIONES.map((d) => [d.tipo, d]),
);

// ── Ajuste a lo que la tabla admite ─────────────────────────────────────────
//
// Las columnas de `siigo_catalogos` son `varchar` con longitud (ver `db/schema.ts`), y Siigo no
// promete respetarlas. Un nombre de vendedor más largo que la columna hacía fallar el INSERT con
// `value too long for type character varying(200)` y tumbaba el catálogo entero —además de ser el
// disparador más probable del volcado de SQL que corrige `siigo.redaccion.ts`—. Se recorta aquí,
// antes de escribir, para que el catálogo entre y el fallo no exista.
//
// Los textos SE RECORTAN y los CÓDIGOS NO. Un nombre recortado sigue identificando al mismo
// elemento; un código recortado sería OTRO identificador —`13156` y `131560` son elementos
// distintos— y la parametrización acabaría apuntando a algo que en Siigo no existe. Un código que
// no cabe se descarta y se cuenta.

/** Longitudes reales de las columnas. Deben coincidir con `schema.ts`. */
const LONGITUD_MAXIMA = { codigo: 60, nombre: 200, descripcion: 300 } as const;

/**
 * Recorta a `max` CARACTERES.
 *
 * Por puntos de código y no por `slice`: `varchar(n)` de Postgres cuenta caracteres, mientras que
 * `String.prototype.length` cuenta unidades UTF-16. Cortar por unidades podría además partir un par
 * suplente por la mitad y dejar media letra en la base.
 */
function recortar(valor: string, max: number): string {
  const puntos = Array.from(valor);
  return puntos.length <= max ? valor : puntos.slice(0, max).join('');
}

/**
 * Ajusta un elemento ya normalizado a lo que la tabla admite.
 *
 * Devuelve `null` cuando hay que descartarlo: hoy, solo si su código no cabe en la columna.
 */
function ajustarALongitudes(e: ElementoNormalizado): ElementoNormalizado | null {
  if (Array.from(e.codigo).length > LONGITUD_MAXIMA.codigo) return null;
  return {
    ...e,
    nombre: recortar(e.nombre, LONGITUD_MAXIMA.nombre),
    descripcion: e.descripcion === null ? null : recortar(e.descripcion, LONGITUD_MAXIMA.descripcion),
  };
}

/**
 * Extrae la lista de elementos de la respuesta.
 *
 * Los catálogos devuelven un arreglo simple, pero el resto de la API de Siigo usa la forma paginada
 * `{ pagination, results }`. Se aceptan las dos: si un catálogo cambia de forma, la sincronización
 * sigue funcionando en vez de reportar cero elementos y vaciar la copia local en silencio.
 */
function extraerElementos(datos: unknown): unknown[] | null {
  if (Array.isArray(datos)) return datos;
  if (datos !== null && typeof datos === 'object') {
    const results = (datos as { results?: unknown }).results;
    if (Array.isArray(results)) return results;
  }
  return null;
}

/** Respuesta con una forma que no se puede interpretar como lista de elementos. */
class SiigoCatalogoFormaInesperada extends Error {
  constructor(tipo: string) {
    super(`Siigo respondió el catálogo "${tipo}" con una forma que no es una lista de elementos.`);
    this.name = 'SiigoCatalogoFormaInesperada';
  }
}

/**
 * Fallo al escribir el catálogo en la copia local.
 *
 * Existe para que un error de Postgres NO llegue crudo al traductor genérico. Desde `drizzle-orm`
 * 0.45, el driver devuelve un `DrizzleQueryError` cuyo `message` es `Failed query: <SQL>\nparams:
 * <valores>`; ese texto acababa en la respuesta HTTP y en la bitácora WORM, que no se puede depurar
 * después (Ley 1581, art. 8). El mensaje de esta clase es FIJO y no admite detalle: lo que sirve
 * para depurar —la causa del driver— se escribe en el log del servidor, donde sí se puede rotar.
 *
 * `tipo` se guarda para el log, no para el mensaje: nombrar el catálogo en la respuesta no aporta
 * nada que el propio resultado no diga ya.
 */
export class SiigoPersistenciaError extends Error {
  readonly tipo: SiigoTipoCatalogo;

  constructor(tipo: SiigoTipoCatalogo) {
    super('No se pudo guardar el catálogo en la copia local.');
    this.name = 'SiigoPersistenciaError';
    this.tipo = tipo;
  }
}

// ── Traducción de fallos ────────────────────────────────────────────────────

/**
 * Convierte cualquier fallo en `{ codigo, mensaje }` accionable (AC5).
 *
 * Lo primero es DESENVOLVER: `ejecutarConResiliencia` empaqueta la causa dentro de un
 * `SiigoOperacionFallida`, y sin esto un `invalid_partner_id` llegaría como «la operación falló tras
 * 2 intentos», que no le dice a nadie qué corregir.
 */
export function traducirFalloCatalogo(entrada: unknown): { codigo: string; mensaje: string } {
  const e = entrada instanceof SiigoOperacionFallida ? entrada.causa : entrada;

  if (e instanceof SiigoApiError) return { codigo: e.code, mensaje: e.descripcionOperativa };
  if (e instanceof SiigoConfigError) {
    return { codigo: 'sin_configuracion', mensaje: `${e.message} Configúralo en las variables de entorno del servidor.` };
  }
  if (e instanceof SiigoEncKeyError) return { codigo: 'llave_maestra', mensaje: e.message };
  if (e instanceof SiigoCredencialError) {
    if (e.codigo === 'no_configurada') {
      return {
        codigo: 'sin_credenciales',
        mensaje: `${e.message} Regístralas en Administración › Integración con Siigo.`,
      };
    }
    if (e.codigo === 'llave_maestra') return { codigo: 'llave_maestra', mensaje: e.message };
    return { codigo: 'credenciales_rechazadas', mensaje: e.message };
  }
  if (e instanceof SiigoAuthError) return { codigo: 'credenciales_rechazadas', mensaje: e.message };
  if (e instanceof SiigoCatalogoFormaInesperada) {
    return { codigo: 'respuesta_inesperada', mensaje: e.message };
  }
  // Circuito abierto: la petición ni siquiera salió. El mensaje del cortacircuitos lleva el nombre
  // interno del circuito (`siigo:catalogos:pruebas:tax`), que no significa nada para quien opera la
  // pantalla y además expone cómo está segmentado por dentro. Se traduce a qué pasó y qué hacer.
  if (e instanceof CircuitoAbiertoError) {
    return {
      codigo: 'servicio_no_disponible',
      mensaje: 'Este catálogo acumuló varios fallos seguidos y las consultas quedaron suspendidas '
        + 'temporalmente para no seguir gastando la cuota de Siigo. Vuelve a intentarlo en un minuto; '
        + 'los demás catálogos no están afectados.',
    };
  }

  // La escritura en la copia local no es «traer el catálogo desde Siigo»: los datos llegaron bien y
  // el problema es nuestro. Va con su propio código para que la pantalla no invite a revisar Siigo,
  // y con mensaje fijo para que la sentencia que falló no viaje al operador.
  if (e instanceof SiigoPersistenciaError) {
    return {
      codigo: 'error_persistencia',
      mensaje: `${e.message} Los datos que llegaron de Siigo son correctos; el problema está en la `
        + 'base de datos de FLITO. Vuelve a intentarlo y, si persiste, avísale al equipo técnico.',
    };
  }

  // Rama genérica: lo único que queda es el `message` del error, y ahí es donde entraba el volcado
  // `Failed query: … params: …` de drizzle. `sanearMensaje` lo corta antes de incrustarlo, de modo
  // que ningún fallo futuro pueda reabrir esta vía por descuido.
  const detalle = sanearMensaje(e instanceof Error ? e.message : String(e));
  return {
    codigo: 'servicio_no_disponible',
    mensaje: `No se pudo traer el catálogo desde Siigo: ${detalle}`,
  };
}

// ── Persistencia ────────────────────────────────────────────────────────────

interface ResultadoPersistencia { total: number; inactivados: number }

/**
 * Escribe un catálogo completo en una sola transacción.
 *
 * Upsert por (ambiente, tipo, codigo) e inactivación de lo que no vino, dentro de la MISMA
 * transacción: si el proceso muere entre las dos operaciones, la copia local quedaría con elementos
 * ya sustituidos y otros marcados a medias, y nadie sabría cuál de los dos estados es el bueno.
 *
 * `ambiente` entra en el `target` del upsert y en el `where` de la inactivación. Son las dos
 * fronteras que impiden que sincronizar producción pise —o dé de baja— la copia de pruebas.
 */
async function persistirCatalogo(
  ambiente: SiigoAmbienteCatalogo, tipo: SiigoTipoCatalogo,
  elementos: ElementoNormalizado[], sincronizadoEn: Date,
): Promise<ResultadoPersistencia> {
  const codigos = elementos.map((e) => e.codigo);

  return db.transaction(async (tx) => {
    for (let i = 0; i < elementos.length; i += TAMANO_LOTE) {
      const lote = elementos.slice(i, i + TAMANO_LOTE);
      await tx.insert(siigoCatalogos)
        .values(lote.map((e) => ({
          ambiente,
          tipo,
          codigo: e.codigo,
          nombre: e.nombre,
          descripcion: e.descripcion,
          activo: e.activo,
          atributos: e.atributos,
          sincronizadoEn,
          inactivadoEn: e.activo ? null : sincronizadoEn,
          updatedAt: sincronizadoEn,
        })))
        .onConflictDoUpdate({
          // Las MISMAS columnas del índice único `idx_siigo_catalogos_ambiente_tipo_codigo`. Si
          // dejan de coincidir, Postgres rechaza la sentencia entera.
          target: [siigoCatalogos.ambiente, siigoCatalogos.tipo, siigoCatalogos.codigo],
          set: {
            nombre: sql`excluded.nombre`,
            descripcion: sql`excluded.descripcion`,
            activo: sql`excluded.activo`,
            atributos: sql`excluded.atributos`,
            sincronizadoEn: sql`excluded.sincronizado_en`,
            // Se conserva la PRIMERA fecha de inactivación: si un elemento se reactiva y vuelve a
            // caer, lo que interesa saber es desde cuándo dejó de estar disponible esta vez, no la
            // marca de la sincronización que lo confirmó.
            inactivadoEn: sql`CASE WHEN excluded.activo THEN NULL
                                   ELSE COALESCE(${siigoCatalogos.inactivadoEn}, excluded.sincronizado_en) END`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }

    // Lo que dejó de venir se inactiva; NUNCA se borra (AC4). Solo se tocan las filas que hoy
    // están activas: reescribir las ya inactivas movería su `inactivado_en` sin motivo.
    //
    // El filtro por `ambiente` es lo que acota el alcance de esta baja masiva: sin él, sincronizar
    // producción inactivaría todo el catálogo de pruebas por no venir en la respuesta.
    const condiciones = [
      eq(siigoCatalogos.ambiente, ambiente),
      eq(siigoCatalogos.tipo, tipo),
      eq(siigoCatalogos.activo, true),
    ];
    // `notInArray` con lista vacía no produce SQL válido. Una respuesta vacía es legítima —Siigo
    // puede haber quedado sin formas de pago activas—, y entonces la condición correcta es
    // simplemente «todas las activas de este tipo en este ambiente».
    if (codigos.length > 0) condiciones.push(notInArray(siigoCatalogos.codigo, codigos));

    const inactivadas = await tx.update(siigoCatalogos)
      .set({
        activo: false,
        inactivadoEn: sql`COALESCE(${siigoCatalogos.inactivadoEn}, ${sincronizadoEn})`,
        updatedAt: sincronizadoEn,
      })
      .where(and(...condiciones))
      .returning({ id: siigoCatalogos.id });

    return { total: elementos.length, inactivados: inactivadas.length };
  });
}

// ── Sincronización ──────────────────────────────────────────────────────────

export interface OpcionesSincronizacion {
  ambiente?: SiigoAmbiente;
  usuarioId?: number | null;
  /** Subconjunto a sincronizar. Sin él, los seis. */
  tipos?: SiigoTipoCatalogo[];
  /** Inyectables para poder probar el control de tasa sin esperar un minuto real. */
  dormir?: (ms: number) => Promise<void>;
  ahora?: () => number;
  maxIntentos?: number;
}

/**
 * Trae los seis catálogos de Siigo y actualiza la copia local.
 *
 * Nunca lanza por el fallo de un catálogo: el resultado lleva el detalle de cada uno. Que una lista
 * caída tumbe la sincronización entera dejaría al operador sin las cinco que sí respondieron y sin
 * saber cuál falló (AC5).
 */
export async function sincronizarCatalogos(
  opciones: OpcionesSincronizacion = {},
): Promise<SiigoResultadoSincronizacion> {
  const inicio = Date.now();
  const modo = modoSiigo();

  // La configuración se resuelve UNA vez, antes de tocar la red. Si falta el Partner-Id, los seis
  // catálogos fallan por la misma causa y ninguno sale a Siigo: no tiene sentido gastar cuota para
  // que todas las peticiones sean rechazadas por una cabecera inválida.
  let ambiente: SiigoAmbienteCatalogo = opciones.ambiente ?? 'pruebas';
  let errorDeConfiguracion: unknown = null;
  try {
    const config = resolverConfig();
    ambiente = opciones.ambiente ?? config.ambiente;
  } catch (e) {
    errorDeConfiguracion = e;
  }

  const pedidos = opciones.tipos?.length
    ? DEFINICIONES.filter((d) => opciones.tipos!.includes(d.tipo))
    : DEFINICIONES;

  const catalogos: SiigoResultadoCatalogo[] = [];
  for (const definicion of pedidos) {
    catalogos.push(await sincronizarUno(definicion, {
      ambiente, modo, errorDeConfiguracion, opciones,
    }));
  }

  const exitosos = catalogos.filter((c) => c.ok).length;
  return {
    ok: exitosos === catalogos.length && catalogos.length > 0,
    parcial: exitosos > 0 && exitosos < catalogos.length,
    // Un vaciado masivo NO baja `ok`: la sincronización hizo su trabajo y la copia local quedó fiel
    // a lo que Siigo respondió. Pero viaja arriba porque el veredicto que ve el operador no puede
    // ser un verde liso cuando la parametrización acaba de quedarse sin opciones.
    vaciadoMasivo: catalogos.some((c) => c.vaciadoMasivo),
    ambiente,
    modo,
    duracionMs: Date.now() - inicio,
    catalogos,
  };
}

interface ContextoSincronizacion {
  ambiente: SiigoAmbienteCatalogo;
  modo: string;
  errorDeConfiguracion: unknown;
  opciones: OpcionesSincronizacion;
}

async function sincronizarUno(
  definicion: DefinicionCatalogo, ctx: ContextoSincronizacion,
): Promise<SiigoResultadoCatalogo> {
  const { ambiente, modo, opciones } = ctx;
  const inicio = Date.now();
  const etiqueta = SIIGO_CATALOGO_ETIQUETAS[definicion.tipo];

  const fallo = async (causa: unknown, statusHttp: number | null): Promise<SiigoResultadoCatalogo> => {
    const { codigo, mensaje } = traducirFalloCatalogo(causa);
    const duracionMs = Date.now() - inicio;
    await registrarOperacion({
      operacion: 'sync_catalogo',
      metodo: 'GET',
      ruta: definicion.ruta,
      entidadTipo: 'catalogo',
      entidadId: definicion.tipo,
      ambiente,
      modo,
      statusHttp,
      // Un rechazo con código de Siigo es un error de negocio; una caída de red o de configuración
      // es técnico. Distinguirlos es lo que permite leer la bitácora sin abrir cada fila.
      resultado: causaEsDeNegocio(causa) ? 'error_negocio' : 'error_tecnico',
      codigo,
      mensaje,
      duracionMs,
      createdBy: opciones.usuarioId ?? null,
    });
    return {
      tipo: definicion.tipo, etiqueta, ok: false, total: 0, inactivados: 0, descartados: 0,
      vaciadoMasivo: false, sincronizadoEn: null, error: { codigo, mensaje }, duracionMs,
    };
  };

  if (ctx.errorDeConfiguracion !== null) return fallo(ctx.errorDeConfiguracion, null);

  try {
    const datos = await ejecutarConResiliencia(
      () => siigoRequestOrThrow({
        metodo: 'GET',
        ruta: definicion.ruta,
        ambiente: ambiente as SiigoAmbiente,
        timeoutMs: TIMEOUT_CATALOGO_MS,
      }),
      {
        // Cuota: compartida por los seis, porque Siigo la cuenta por empresa.
        clave: claveResiliencia(ambiente),
        // Salud: propia de este catálogo, para que una lista caída no silencie a las demás.
        claveCortacircuitos: claveCortacircuitos(ambiente, definicion.tipo),
        maxIntentos: opciones.maxIntentos ?? MAX_INTENTOS_CATALOGO,
        dormir: opciones.dormir,
        ahora: opciones.ahora,
      },
    );

    const crudos = extraerElementos(datos);
    if (crudos === null) throw new SiigoCatalogoFormaInesperada(definicion.tipo);

    // Deduplicación por código antes de escribir: el índice único rechazaría el INSERT completo si
    // Siigo repitiera un elemento, y un catálogo entero perdido por un duplicado suyo sería un
    // fallo nuestro. Gana la última aparición, que es la más reciente en la respuesta.
    const porCodigo = new Map<string, ElementoNormalizado>();
    let descartados = 0;
    for (const crudo of crudos.slice(0, MAX_ELEMENTOS_POR_CATALOGO)) {
      const normalizado = definicion.normalizar(crudo);
      // Sin identificador utilizable: no se puede referenciar desde una parametrización.
      if (!normalizado) { descartados++; continue; }
      // Con un código más largo que su columna: recortarlo crearía otro elemento.
      const ajustado = ajustarALongitudes(normalizado);
      if (!ajustado) { descartados++; continue; }
      porCodigo.set(ajustado.codigo, ajustado);
    }

    const sincronizadoEn = new Date();
    // La escritura va con su PROPIO catch. Sin él, un error de Postgres sale crudo de aquí y cae en
    // la rama genérica del traductor, que lo incrusta en el mensaje que ven el operador y la
    // bitácora WORM; y desde drizzle ≥ 0.45 ese mensaje es la sentencia entera con sus parámetros
    // —los nombres de los vendedores, entre ellos—. El detalle técnico se queda en el log del
    // servidor, que sí se puede rotar y depurar; hacia fuera va un error de dominio con texto fijo.
    let persistencia: ResultadoPersistencia;
    try {
      persistencia = await persistirCatalogo(
        ambiente, definicion.tipo, [...porCodigo.values()], sincronizadoEn,
      );
    } catch (e) {
      console.error('[siigo] no se pudo guardar el catálogo en la copia local', {
        tipo: definicion.tipo, ambiente, elementos: porCodigo.size, err: detalleTecnico(e),
      });
      throw new SiigoPersistenciaError(definicion.tipo);
    }

    const { total, inactivados } = persistencia;
    const duracionMs = Date.now() - inicio;

    // Siigo respondió 200 con una lista vacía y aquí había elementos activos: la parametrización se
    // acaba de quedar sin opciones. No se revierte —una baja masiva legítima existe y esconderla
    // sería peor— pero se anuncia, porque el caso indistinguible es «un error del lado de Siigo que
    // devuelve listas vacías» y ese no puede reportarse como una sincronización más.
    //
    // `inactivados > 0` es la parte que lo separa de un catálogo que ya estaba vacío: si no había
    // nada activo que dar de baja, no se perdió nada y no hay nada que destacar.
    const vaciadoMasivo = total === 0 && inactivados > 0;

    await registrarOperacion({
      operacion: 'sync_catalogo',
      metodo: 'GET',
      ruta: definicion.ruta,
      entidadTipo: 'catalogo',
      entidadId: definicion.tipo,
      ambiente,
      modo,
      statusHttp: 200,
      resultado: 'ok',
      // Solo el conteo: el contenido del catálogo ya está en su tabla, duplicarlo en la bitácora
      // WORM la haría crecer sin aportar nada que no se pueda consultar.
      responseBody: { total, inactivados, vaciadoMasivo, descartados },
      mensaje: (vaciadoMasivo
        ? `Catálogo "${definicion.tipo}": Siigo lo devolvió VACÍO; ${inactivados} elementos quedaron `
          + 'inactivados. Verifica en Siigo antes de parametrizar.'
        : `Catálogo "${definicion.tipo}": ${total} elementos, ${inactivados} inactivados.`)
        // Un descarte es un elemento que Siigo tiene y FLITO no: si no se dice, la lista aparece
        // incompleta en la pantalla sin que nada explique por qué.
        + (descartados > 0
          ? ` ${descartados} elemento(s) se descartaron por venir sin identificador utilizable o con `
            + 'un código más largo del que admite la copia local.'
          : ''),
      duracionMs,
      createdBy: opciones.usuarioId ?? null,
    });

    return {
      tipo: definicion.tipo, etiqueta, ok: true, total, inactivados, descartados, vaciadoMasivo,
      sincronizadoEn: sincronizadoEn.toISOString(), error: null, duracionMs,
    };
  } catch (e) {
    const status = e instanceof SiigoOperacionFallida && e.causa instanceof SiigoApiError
      ? e.causa.status
      : (e instanceof SiigoApiError ? e.status : null);
    return fallo(e, status);
  }
}

function causaEsDeNegocio(entrada: unknown): boolean {
  const e = entrada instanceof SiigoOperacionFallida ? entrada.causa : entrada;
  return e instanceof SiigoApiError && !e.reintentable;
}

// ── Lectura desde la copia local (AC3) ──────────────────────────────────────

/**
 * Devuelve un catálogo desde la copia local. NO llama a Siigo, ni siquiera si está vacío.
 *
 * Caer a Siigo cuando la copia está vacía parecería amable y sería justo lo contrario: convertiría
 * cada pintado de una pantalla sin sincronizar en peticiones a un servicio con cuota, y escondería
 * el hecho de que nadie ha ejecutado la sincronización todavía.
 */
export async function leerCatalogo(
  tipo: SiigoTipoCatalogo,
  opciones: { incluirInactivos?: boolean; ambiente?: SiigoAmbiente } = {},
): Promise<SiigoCatalogoLocal> {
  const ambiente = ambienteEfectivo(opciones.ambiente);

  // Se traen también las inactivas y se filtra en memoria: son listas de decenas de elementos, y
  // así `sincronizadoEn` es la fecha real del catálogo aunque todos sus elementos estén inactivos.
  //
  // El filtro por `ambiente` no es opcional: los identificadores de pruebas y de producción son de
  // empresas distintas, y mezclarlos en un desplegable llevaría a facturar contra un vendedor o un
  // centro de costo que en la empresa real no existe.
  const filas = await db.select({
    codigo: siigoCatalogos.codigo,
    nombre: siigoCatalogos.nombre,
    descripcion: siigoCatalogos.descripcion,
    activo: siigoCatalogos.activo,
    atributos: siigoCatalogos.atributos,
    sincronizadoEn: siigoCatalogos.sincronizadoEn,
  })
    .from(siigoCatalogos)
    .where(and(eq(siigoCatalogos.ambiente, ambiente), eq(siigoCatalogos.tipo, tipo)))
    .orderBy(asc(siigoCatalogos.nombre));

  let ultima: number | null = null;
  const elementos: SiigoCatalogoElemento[] = [];
  for (const f of filas) {
    const ms = f.sincronizadoEn instanceof Date ? f.sincronizadoEn.getTime() : null;
    if (ms !== null && (ultima === null || ms > ultima)) ultima = ms;
    if (!opciones.incluirInactivos && !f.activo) continue;
    elementos.push({
      codigo: f.codigo,
      nombre: f.nombre,
      descripcion: f.descripcion ?? null,
      activo: f.activo,
      atributos: (f.atributos as Record<string, unknown> | null) ?? null,
      sincronizadoEn: f.sincronizadoEn instanceof Date
        ? f.sincronizadoEn.toISOString()
        : String(f.sincronizadoEn),
    });
  }

  return {
    tipo,
    etiqueta: SIIGO_CATALOGO_ETIQUETAS[tipo],
    ambiente,
    sincronizadoEn: ultima === null ? null : new Date(ultima).toISOString(),
    elementos,
  };
}

/** Los cuatro catálogos que alimentan la elección de emisión de un envío. */
export const CATALOGOS_DE_EMISION = ['document_type', 'user', 'payment_type', 'cost_center'] as const;

export type CatalogoDeEmision = typeof CATALOGOS_DE_EMISION[number];

export function esCatalogoDeEmision(v: string): v is CatalogoDeEmision {
  return (CATALOGOS_DE_EMISION as readonly string[]).includes(v);
}

/**
 * Un catálogo de emisión leído EN VIVO de Siigo, sin tocar la copia local.
 *
 * **Por qué en vivo y no desde la copia.** Estos cuatro se abren para elegir y se cierran, igual que
 * el listado de productos: se leen una vez por envío, no miles de veces para pintar una pantalla.
 * Una copia local suya obligaba a un botón de «sincronizar» —que alguien tenía que acordarse de
 * pulsar— y ofrecía una lista vieja justo en el momento en que alguien acaba de crear el vendedor en
 * Siigo, que es cuando se abre este selector. El botón se quitó y la copia dejó de ser la fuente.
 *
 * La copia local sigue existiendo para los catálogos que SÍ se consultan constantemente (los grupos
 * de inventario y los impuestos del mapeo de conceptos), y por eso este módulo conserva
 * `sincronizarCatalogos`: son dos usos distintos de la misma API, no dos verdades.
 *
 * Reutiliza `DEFINICIONES` a propósito. La normalización —qué es el código, qué es el nombre, qué
 * significa `due_date` o `cost_center_mandatory`— tiene que ser la misma se guarde o no: dos
 * normalizadores para el mismo endpoint acabarían discrepando sobre qué vendedor está activo.
 *
 * No captura errores: los propaga tal cual para que la ruta los traduzca con
 * `traducirFalloCatalogo` y responda 502. Un fallo aquí no es una lista vacía.
 */
export async function leerCatalogoEnVivo(
  tipo: CatalogoDeEmision,
  opciones: { ambiente?: SiigoAmbiente } = {},
): Promise<SiigoCatalogoElemento[]> {
  const ambiente = ambienteEfectivo(opciones.ambiente);
  const definicion = DEFINICIONES.find((d) => d.tipo === tipo);
  if (!definicion) throw new SiigoCatalogoFormaInesperada(tipo);

  const datos = await ejecutarConResiliencia(
    () => siigoRequestOrThrow({
      metodo: 'GET',
      ruta: definicion.ruta,
      ambiente: ambiente as SiigoAmbiente,
      timeoutMs: TIMEOUT_CATALOGO_MS,
    }),
    {
      clave: claveResiliencia(ambiente),
      claveCortacircuitos: claveCortacircuitos(ambiente, definicion.tipo),
      maxIntentos: MAX_INTENTOS_CATALOGO,
    },
  );

  const crudos = extraerElementos(datos);
  if (crudos === null) throw new SiigoCatalogoFormaInesperada(definicion.tipo);

  // Misma deduplicación por código que la sincronización, y por el mismo motivo: Siigo puede repetir
  // un elemento, y dos opciones idénticas en un desplegable son una forma de elegir mal.
  const porCodigo = new Map<string, SiigoCatalogoElemento>();
  const leidoEn = new Date().toISOString();
  for (const crudo of crudos.slice(0, MAX_ELEMENTOS_POR_CATALOGO)) {
    const normalizado = definicion.normalizar(crudo);
    if (!normalizado) continue;
    // Solo lo activo: aquí no hay historial que preservar —no se guarda nada— y una opción inactiva
    // en el desplegable solo sirve para que Siigo rechace la factura después.
    if (!normalizado.activo) continue;
    porCodigo.set(normalizado.codigo, {
      codigo: normalizado.codigo,
      nombre: normalizado.nombre,
      descripcion: normalizado.descripcion,
      activo: true,
      atributos: normalizado.atributos,
      // No es una fecha de sincronización: es cuándo se leyó. Se conserva el nombre del campo
      // porque el tipo es compartido, y el valor es honesto — se acaba de traer.
      sincronizadoEn: leidoEn,
    });
  }

  return [...porCodigo.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

/**
 * Resumen de los seis catálogos: cuántos elementos tiene cada uno y cuándo se trajo.
 *
 * Los que nunca se sincronizaron aparecen con total 0 y `sincronizadoEn: null`. Omitirlos dejaría
 * la pantalla sin poder decir «este catálogo nunca se ha traído», que es la información que hace
 * falta para saber que hay que pulsar el botón.
 */
export async function resumenCatalogos(
  opciones: { ambiente?: SiigoAmbiente } = {},
): Promise<SiigoCatalogoResumen[]> {
  const ambiente = ambienteEfectivo(opciones.ambiente);

  // Agrupado y filtrado por ambiente: un resumen que sumara los dos diría «42 impuestos» donde la
  // empresa con la que se factura tiene 21, y la pantalla no podría detectar que producción nunca
  // se sincronizó.
  const filas = await db.select({
    tipo: siigoCatalogos.tipo,
    total: sql<number>`count(*)::int`,
    activos: sql<number>`count(*) filter (where ${siigoCatalogos.activo})::int`,
    sincronizadoEn: sql<Date | null>`max(${siigoCatalogos.sincronizadoEn})`,
  })
    .from(siigoCatalogos)
    .where(eq(siigoCatalogos.ambiente, ambiente))
    .groupBy(siigoCatalogos.tipo);

  const porTipo = new Map(filas.map((f) => [f.tipo, f]));

  return SIIGO_TIPOS_CATALOGO.map((tipo) => {
    const f = porTipo.get(tipo);
    const fecha = f?.sincronizadoEn ?? null;
    return {
      tipo,
      etiqueta: SIIGO_CATALOGO_ETIQUETAS[tipo],
      ambiente,
      total: Number(f?.total ?? 0),
      activos: Number(f?.activos ?? 0),
      sincronizadoEn: fecha === null
        ? null
        : (fecha instanceof Date ? fecha.toISOString() : new Date(fecha).toISOString()),
    };
  });
}

/** Rutas consultadas por catálogo. Expuesto para la documentación y para los tests. */
export function rutaDeCatalogo(tipo: SiigoTipoCatalogo): string | null {
  return DEFINICION_POR_TIPO.get(tipo)?.ruta ?? null;
}
