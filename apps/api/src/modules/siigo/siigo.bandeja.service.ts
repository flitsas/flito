// Siigo — la bandeja de fallidos: qué hay que operar hoy (HU #11340, Feature #11244).
//
// **No hay tabla nueva y no hay migración.** Todo lo que la historia pide ya tiene sede: la cola
// dice qué queda por hacer, `siigo_facturas` qué le pasó al documento, el historial DIAN qué dice la
// autoridad, el acta de envío si el correo salió, y `siigo_operaciones` —WORM por disparador desde
// la `0126`— quién dio algo por perdido, cuándo y por qué. Lo que faltaba **no era dónde escribir:
// era qué leer**, igual que en la línea de tiempo de la HU #11338.
//
// LA CONSULTA VA EN DOS FASES, y no por elegancia
//
//   Fase 1: un `UNION ALL` de tres patas con columnas idénticas, ordenado y paginado en la BASE. Es
//           la única forma de que la paginación diga la verdad: filtrar en memoria después de traer
//           cien filas dejaría páginas de tamaño variable y casos que no aparecen en ninguna.
//   Fase 2: hidratación EN LOTE de esas ≤100 filas. Una consulta por tabla, nunca una por fila: la
//           pantalla pinta cien casos y preguntar por cada uno serían cientos de consultas por
//           refresco. Es el mismo reparto que usa `finanzas.facturacion-electronica.ts`.
//
// CADA CASO CONSERVA SU ESTADO NATIVO. `SiigoColaEstado`, `SiigoEstadoDian` y `SiigoEnvioResultado`
// viajan tal cual con las etiquetas que ya existen. **Ninguna máquina de estados nueva**: las notas
// de la HU lo prohíben, y con razón —una cuarta definición habría que sincronizarla con las tres—.
//
// NADA DE ESTE ARCHIVO LLAMA A SIIGO. Mirar la bandeja no puede gastar cuota de la ventana de 100
// peticiones por minuto que comparte la emisión: si abrir la pantalla costara peticiones, mirar por
// qué no se factura frenaría la facturación.

import { sql, type SQL } from 'drizzle-orm';
import {
  ETIQUETA_RESPONSABLE, SIIGO_BANDEJA_FUENTES, SIIGO_BANDEJA_MOTIVO_DESCARTE_ETIQUETA,
  SIIGO_BANDEJA_PAGINA_DEFECTO, SIIGO_BANDEJA_PAGINA_MAX, esMotivoDescarte,
} from '@operaciones/shared-types';
import type {
  GuiaErrorSiigo, ResponsableError, SiigoBandejaDescarte, SiigoBandejaEstadoNativo,
  SiigoBandejaFiltro, SiigoBandejaFuente, SiigoBandejaItem, SiigoBandejaPagina, SiigoBandejaResumen,
  SiigoBandejaTramite, SiigoColaEstado, SiigoEnvioResultado, SiigoEstadoDian,
} from '@operaciones/shared-types';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  clients, flitoTramites, siigoColaFacturacion, siigoFacturaEnvios, siigoFacturaEstadosDian,
  siigoFacturaTramites, siigoFacturas, siigoOperaciones,
} from '../../db/schema.js';
import { guiaParaCodigo, esReintentable } from './siigo.errors.js';
import { redactarPIIEnTextoLibre } from './siigo.redaccion.js';
import { OPERACION_ENCOLAR } from './siigo.freno.service.js';
import type { SiigoAmbiente } from './credenciales.service.js';

/** El hito que marca «esto se dio por perdido». Ya estaba declarado, esperando a esta historia. */
export const HITO_DESCARTE = 'marcada_fallido_definitivo';

/**
 * Los hitos que DESHACEN un descarte, uno por tipo de entidad.
 *
 * No hay un hito «reactivado» nuevo y no hace falta: la reactivación de una fila de cola ya escribe
 * `factura_encolar` (con `codigo: 'reactivado'`) y el reenvío de un correo escribe
 * `reenvio_solicitado`, que ya está en `HITOS_SIN_LLAMADA`. Manda **el último** hito de la entidad:
 * un catálogo nuevo sería una tercera forma de decir lo mismo.
 */
const HITO_ACTIVACION: Record<'siigo_cola' | 'factura_envio', string> = {
  siigo_cola: OPERACION_ENCOLAR,
  factura_envio: 'reenvio_solicitado',
};

/**
 * Código con el que se pide guía cuando no quedó ninguno escrito.
 *
 * **No es un invento de este archivo**: es el que el propio trabajador escribe cuando un ciclo
 * termina sin desenlace, y está en el catálogo como reintentable. Importa cuál se elige: `esReintentable`
 * sin código decide por el estado HTTP, y aquí no hay ninguno que pasarle —el error ocurrió hace
 * días y el objeto se perdió—. Fabricar un estado para poder preguntar sería inventarse la respuesta;
 * decir «no hubo desenlace» es exactamente lo que pasó.
 */
const CODIGO_SIN_DESENLACE = 'sin_desenlace';

/**
 * La guía de un caso a partir del código YA PERSISTIDO.
 *
 * **`requiereCorreccionDeDatos` no sirve aquí y por poco se usa**: es una propiedad de una excepción
 * viva, y la bandeja lee columnas cuando esa excepción hace días que no existe. `esReintentable` es
 * el MISMO predicado que usa `planificarDesenlace` en el trabajador, así que bandeja y trabajador no
 * pueden discrepar sobre si algo se arregla reintentando — que es justo la contradicción que haría
 * al AC3 mentir.
 */
export function guiaDelCaso(codigo: string | null | undefined): GuiaErrorSiigo {
  const c = codigo && codigo.trim() !== '' ? codigo.trim() : CODIGO_SIN_DESENLACE;
  // El segundo argumento solo manda cuando NO hay código; con código, `esReintentable` resuelve
  // contra el mismo catálogo del que `guiaParaCodigo` saca su defecto. Pasarlo explícito es lo que
  // deja escrito que el predicado es compartido y no una segunda lectura del catálogo.
  return guiaParaCodigo(c, { reintentable: esReintentable(c, 0) });
}

// ── Fase 1: las tres patas, ordenadas y paginadas en la base ────────────────

interface FilaCaso {
  fuente: SiigoBandejaFuente;
  refId: string;
  facturaId: string;
  ocurridoEn: Date;
  codigo: string | null;
  colaId: string | null;
  descartado: boolean;
}

/**
 * ¿Alguien dio por perdida esta entidad? **Manda el último hito, no la existencia de uno.**
 *
 * Con un `NOT EXISTS` a secas, una fila descartada y luego resucitada seguiría oculta para siempre:
 * la bitácora es WORM y el hito del descarte no se puede borrar (que es justo lo que el AC6 pide
 * conservar). Mirando cuál fue el ÚLTIMO, resucitar la devuelve a la bandeja sin tocar ni una fila
 * anterior.
 *
 * Entra por `idx_siigo_op_entidad`, que es `(entidad_tipo, entidad_id, created_at)`. El desempate por
 * `id` no es cosmético: `created_at` es `now()`, o sea la hora de INICIO DE LA TRANSACCIÓN, y dos
 * hitos de la misma transacción comparten instante.
 */
function expresionDescartado(entidadTipo: 'siigo_cola' | 'factura_envio', idExpr: SQL): SQL {
  return sql`COALESCE((
      SELECT o.operacion FROM siigo_operaciones o
       WHERE o.entidad_tipo = ${entidadTipo}
         AND o.entidad_id = ${idExpr}
         AND o.operacion IN (${HITO_DESCARTE}, ${HITO_ACTIVACION[entidadTipo]})
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT 1
    ), '') = ${HITO_DESCARTE}`;
}

/**
 * El filtro por cliente, como `EXISTS` y no como JOIN.
 *
 * Un JOIN sobre `siigo_factura_tramites` ensancharía la unión: una factura de N trámites saldría N
 * veces, la paginación contaría filas que no son casos y el mismo fallo aparecería repetido en la
 * pantalla. El `EXISTS` responde sí o no y no multiplica nada.
 */
function condicionCliente(clientes: number[]): SQL {
  return sql`EXISTS (
      SELECT 1 FROM siigo_factura_tramites sft
        JOIN flito_tramites t ON t.id = sft.tramite_id
       WHERE sft.factura_id = f.id
         AND t.compania_id = ANY(${sql.param(clientes)}::int[])
    )`;
}

/** `TRUE` como fragmento, para que las tres patas se escriban igual con filtro y sin él. */
const SIEMPRE: SQL = sql`TRUE`;

function consultaPatas(ambiente: SiigoAmbiente, cliente: SQL): SQL {
  return sql`
    -- La emisión que falló. LEFT JOIN a la cola: una factura fallida PUEDE no tener fila de cola
    -- (emisión directa histórica), y un INNER la habría escondido justo a ella.
    SELECT 'emision'::text AS fuente,
           f.id::text      AS ref_id,
           f.id::text      AS factura_id,
           f.updated_at    AS ocurrido_en,
           COALESCE(c.error_code, f.error_code)::text AS codigo,
           c.id::text      AS cola_id,
           ${expresionDescartado('siigo_cola', sql`c.id::text`)} AS descartado
      FROM siigo_facturas f
      LEFT JOIN siigo_cola_facturacion c ON c.lote_id = f.lote_id
     WHERE f.ambiente = ${ambiente}
       AND f.estado = 'fallida'
       AND ${cliente}

    UNION ALL

    -- Lo que rechazó la DIAN. El estado vigente es la ÚLTIMA fila por secuencia, nunca por fecha:
    -- created_at es la hora de inicio de la transacción y dos filas pueden compartirla.
    SELECT 'dian'::text, d.id::text, f.id::text, d.created_at,
           'dian_rechazada'::text, NULL::text,
           -- Un rechazo de la DIAN no se «da por perdido»: se corrige. Sale de la bandeja cuando hay
           -- corrección registrada, que es el hecho, no una opinión de nadie.
           FALSE
      FROM siigo_facturas f
      JOIN LATERAL (
            SELECT dd.id, dd.estado, dd.created_at
              FROM siigo_factura_estados_dian dd
             WHERE dd.factura_id = f.id
             ORDER BY dd.secuencia DESC
             LIMIT 1
           ) d ON TRUE
     WHERE f.ambiente = ${ambiente}
       AND d.estado = 'rechazada'
       AND NOT EXISTS (
             SELECT 1 FROM siigo_factura_correcciones k WHERE k.factura_id = f.id
           )
       AND ${cliente}

    UNION ALL

    -- El correo que no salió. Se mira SOLO la última acta de cada factura: si la última dice
    -- enviado, el cliente lo tiene y no hay caso, aunque antes hubiera diez intentos fallidos.
    SELECT 'correo'::text, e.id::text, f.id::text, e.created_at,
           COALESCE(NULLIF(e.codigo, ''), 'siigo_rechazo')::text, NULL::text,
           ${expresionDescartado('factura_envio', sql`e.id::text`)}
      FROM siigo_facturas f
      JOIN LATERAL (
            SELECT ee.id, ee.resultado, ee.codigo, ee.created_at
              FROM siigo_factura_envios ee
             WHERE ee.factura_id = f.id
             ORDER BY ee.created_at DESC, ee.id DESC
             LIMIT 1
           ) e ON TRUE
     WHERE f.ambiente = ${ambiente}
       AND e.resultado IN ('fallido', 'no_realizado')
       AND ${cliente}`;
}

/** Las condiciones que se aplican SOBRE la unión: son las mismas para las tres patas. */
function condicionesExternas(f: SiigoBandejaFiltro, ahora: Date): SQL[] {
  const conds: SQL[] = [];
  if (!f.incluirDescartados) conds.push(sql`NOT descartado`);
  if (f.fuentes && f.fuentes.length > 0) {
    conds.push(sql`fuente = ANY(${sql.param([...f.fuentes])}::text[])`);
  }
  if (f.codigos && f.codigos.length > 0) {
    conds.push(sql`COALESCE(codigo, ${CODIGO_SIN_DESENLACE}) = ANY(${sql.param([...f.codigos])}::text[])`);
  }
  // Antigüedad: «lleva al menos N días» es una cita ANTERIOR, así que `min` se traduce a `<=`. Las
  // fechas viajan como TEXTO ISO con su cast, nunca como `Date`: `db.execute` acaba en
  // `client.unsafe(query, params)` de postgres.js, que no aplica serializadores por tipo y revienta
  // con un `Date` dentro. Es la lección del Bug del 2026-08-13 en `tomarLote`.
  if (typeof f.antiguedadDiasMin === 'number') {
    conds.push(sql`ocurrido_en <= ${corte(ahora, f.antiguedadDiasMin)}::timestamptz`);
  }
  if (typeof f.antiguedadDiasMax === 'number') {
    conds.push(sql`ocurrido_en >= ${corte(ahora, f.antiguedadDiasMax + 1)}::timestamptz`);
  }
  return conds;
}

function corte(ahora: Date, dias: number): string {
  return new Date(ahora.getTime() - dias * 86_400_000).toISOString();
}

function unir(conds: SQL[]): SQL {
  return conds.length === 0 ? SIEMPRE : sql.join(conds, sql` AND `);
}

/** Las filas de un `execute`, venga como venga el driver (mismo motivo que en la cola). */
function filasDe(r: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(r)) return r as Array<Record<string, unknown>>;
  const rows = (r as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [];
}

function fecha(v: unknown): Date {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? new Date(0) : v;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

function esFuente(v: unknown): v is SiigoBandejaFuente {
  return typeof v === 'string' && (SIIGO_BANDEJA_FUENTES as readonly string[]).includes(v);
}

// ── La consulta (AC1) ───────────────────────────────────────────────────────

export interface OpcionesBandeja extends SiigoBandejaFiltro {
  ambiente: SiigoAmbiente;
  ahora?: Date;
}

/**
 * AC1 — La bandeja: emisiones fallidas, rechazos de la DIAN y correos que no salieron.
 *
 * Pide una fila MÁS de las que va a devolver y la descarta. Es lo que permite decir «hay más» sin
 * contar la unión entera en cada refresco de pantalla: el total exacto lo da `/resumen`, que es una
 * sola consulta agrupada y se pide una vez.
 */
export async function consultarBandeja(o: OpcionesBandeja): Promise<SiigoBandejaPagina> {
  const ahora = o.ahora ?? new Date();
  const limite = Math.min(Math.max(o.limite ?? SIIGO_BANDEJA_PAGINA_DEFECTO, 1), SIIGO_BANDEJA_PAGINA_MAX);
  const offset = Math.max(o.offset ?? 0, 0);
  const cliente = o.clientes && o.clientes.length > 0 ? condicionCliente([...o.clientes]) : SIEMPRE;

  const resultado = await db.execute(sql`
    WITH casos AS (${consultaPatas(o.ambiente, cliente)})
    SELECT fuente, ref_id, factura_id, ocurrido_en, codigo, cola_id, descartado
      FROM casos
     WHERE ${unir(condicionesExternas(o, ahora))}
     ORDER BY ocurrido_en DESC, ref_id DESC
     LIMIT ${limite + 1} OFFSET ${offset}
  `);

  const crudas = filasDe(resultado);
  const hayMas = crudas.length > limite;
  const casos: FilaCaso[] = crudas.slice(0, limite)
    .filter((r) => esFuente(r.fuente))
    .map((r) => ({
      fuente: r.fuente as SiigoBandejaFuente,
      refId: String(r.ref_id),
      facturaId: String(r.factura_id),
      ocurridoEn: fecha(r.ocurrido_en),
      codigo: r.codigo === null || r.codigo === undefined ? null : String(r.codigo),
      colaId: r.cola_id === null || r.cola_id === undefined ? null : String(r.cola_id),
      descartado: r.descartado === true || r.descartado === 't',
    }));

  return {
    ambiente: o.ambiente,
    items: await hidratar(casos, ahora),
    limite,
    offset,
    hayMas,
  };
}

// ── Fase 2: hidratación EN LOTE de la página ────────────────────────────────

interface Cargas {
  facturas: Map<string, { numero: string | null; loteId: string; errorCode: string | null }>;
  colaPorLote: Map<string, {
    id: string; estado: SiigoColaEstado; intentos: number; maxIntentos: number;
  }>;
  tramites: Map<string, SiigoBandejaTramite[]>;
  clientePorFactura: Map<string, { id: number; nombre: string | null }>;
  dian: Map<string, { estado: SiigoEstadoDian; motivo: string | null }>;
  correo: Map<string, { resultado: SiigoEnvioResultado; motivo: string | null }>;
  descartes: Map<string, SiigoBandejaDescarte>;
}

/**
 * Rellena la página. **Una consulta por tabla, nunca una por fila.**
 *
 * Cien casos con una consulta por caso serían ~700 consultas para dibujar una tabla que se refresca
 * sola. Con esto son siete, y ninguna crece con el número de filas: crecen con el número de TABLAS,
 * que no cambia.
 */
async function hidratar(casos: FilaCaso[], ahora: Date): Promise<SiigoBandejaItem[]> {
  if (casos.length === 0) return [];
  const c = await cargar(casos);

  return casos.map((caso) => {
    const factura = c.facturas.get(caso.facturaId);
    const cola = factura ? c.colaPorLote.get(factura.loteId) : undefined;
    const cliente = c.clientePorFactura.get(caso.facturaId);
    const dian = c.dian.get(caso.refId);
    const correo = c.correo.get(caso.refId);

    const estado: SiigoBandejaEstadoNativo = {
      cola: caso.fuente === 'emision' ? cola?.estado ?? null : null,
      dian: caso.fuente === 'dian' ? dian?.estado ?? null : null,
      correo: caso.fuente === 'correo' ? correo?.resultado ?? null : null,
    };

    return {
      fuente: caso.fuente,
      refId: caso.refId,
      facturaId: caso.facturaId,
      facturaNumero: factura?.numero ?? null,
      ocurridoEn: caso.ocurridoEn.toISOString(),
      antiguedadDias: Math.max(
        0, Math.floor((ahora.getTime() - caso.ocurridoEn.getTime()) / 86_400_000),
      ),
      codigo: caso.codigo,
      guia: guiaDelCaso(caso.codigo),
      // El detalle de la fuente, NO el `error_detalle` de la factura: ese ya está resumido en la
      // guía, y repetirlo daría dos versiones del mismo diagnóstico en la misma fila.
      //
      // **Enmascarado, y por lo que va AL LADO.** Este campo sale en una fila que además trae
      // `clienteNombre`, y nombre + identificación juntos son una correlación que
      // `CAMPOS_PII_BANDEJA = ['name']` no declara ante el registro del art. 17. Se enmascara al
      // ENTREGARLO: el operador sigue viendo qué regla se infringió, que es lo que necesita para
      // actuar.
      //
      // **Corrección de una premisa que estuvo escrita aquí**: decía que estos motivos «citan con
      // frecuencia el NIT del adquiriente». Eso NO está verificado y la evidencia apunta en contra.
      // `componerMotivo` arma descripciones estáticas del catálogo más `campoLegible`, y
      // `FORMA_DE_CAMPO` (`siigo.errors.ts`) ya rechaza lo que traiga seis dígitos seguidos, un
      // arroba o un espacio: por ahí no pasa una identificación. La superficie real es más estrecha
      // y está en otro sitio —`entradaDesconocida` interpola el `Code` crudo de Siigo pasado solo por
      // `redactarSecretos`, que es una lista negra de credenciales y no reconoce una cédula—. Se deja
      // dicho para que quien venga detrás no gaste el viaje en el sitio equivocado; corregir esa ruta
      // es deuda preexistente y no es de esta HU.
      detalle: redactarPIIEnTextoLibre(
        caso.fuente === 'dian' ? dian?.motivo ?? ''
          : caso.fuente === 'correo' ? correo?.motivo ?? ''
            : '',
        // El nombre del cliente de ESTA fila, que se emite veinte líneas más abajo como
        // `clienteNombre`. Sin pasarlo, un motivo que repita la razón social —lo normal cuando el
        // cliente es persona natural y su «razón social» ES el nombre del titular— la entrega
        // entera justo al lado de su identificación, que es la correlación que este bloque dice
        // estar evitando. Es además la única defensa que queda para un motivo escrito en altas.
        [cliente?.nombre],
      ) || null,
      estado,
      colaId: caso.colaId ?? cola?.id ?? null,
      intentos: cola?.intentos ?? 0,
      maxIntentos: cola?.maxIntentos ?? 0,
      tramites: c.tramites.get(caso.facturaId) ?? [],
      clienteId: cliente?.id ?? null,
      clienteNombre: cliente?.nombre ?? null,
      descarte: caso.descartado
        ? c.descartes.get(claveDescarte(caso)) ?? descarteSinDetalle(caso.ocurridoEn)
        : null,
    };
  });
}

/** La llave con la que se busca el descarte: entidad y su id, que es lo que se apuntó. */
function claveDescarte(caso: FilaCaso): string {
  return caso.fuente === 'correo'
    ? `factura_envio:${caso.refId}`
    : `siigo_cola:${caso.colaId ?? ''}`;
}

/**
 * Un descarte cuya fila de bitácora no se encontró.
 *
 * No puede pasar —la condición de la fase 1 sale de esa misma fila—, pero si pasara, devolver `null`
 * diría «no está descartado» sobre algo que sí lo está, y la pantalla ofrecería reintentar lo que el
 * servidor va a rechazar. Se prefiere admitir que falta el detalle.
 */
function descarteSinDetalle(ocurridoEn: Date): SiigoBandejaDescarte {
  return {
    motivo: null,
    motivoEtiqueta: 'Dado por perdido (no se pudo leer el motivo en la bitácora)',
    nota: null,
    usuarioId: null,
    marcadoEn: ocurridoEn.toISOString(),
  };
}

async function cargar(casos: FilaCaso[]): Promise<Cargas> {
  const facturaIds = [...new Set(casos.map((x) => x.facturaId))];
  const dianIds = casos.filter((x) => x.fuente === 'dian').map((x) => x.refId);
  const correoIds = casos.filter((x) => x.fuente === 'correo').map((x) => x.refId);

  const facturas = await db.select({
    id: siigoFacturas.id, numero: siigoFacturas.numero, loteId: siigoFacturas.loteId,
    errorCode: siigoFacturas.errorCode,
  }).from(siigoFacturas).where(inArray(siigoFacturas.id, facturaIds));

  const loteIds = [...new Set(facturas.map((f) => String(f.loteId)))];
  const colas = loteIds.length === 0 ? [] : await db.select({
    id: siigoColaFacturacion.id, loteId: siigoColaFacturacion.loteId,
    estado: siigoColaFacturacion.estado, intentos: siigoColaFacturacion.intentos,
    maxIntentos: siigoColaFacturacion.maxIntentos,
  }).from(siigoColaFacturacion).where(inArray(siigoColaFacturacion.loteId, loteIds));

  // Los trámites y su compañía en UNA consulta: el trámite es lo que quien opera reconoce, y la
  // compañía es el filtro por cliente. Se pide el `id_flit` y no la placa — la placa es cuasi-PII y
  // esta respuesta se pinta en una tabla que además se refresca sola.
  const vinculos = await db.select({
    facturaId: siigoFacturaTramites.facturaId,
    tramiteId: siigoFacturaTramites.tramiteId,
    idFlit: flitoTramites.idFlit,
    companiaId: flitoTramites.companiaId,
  }).from(siigoFacturaTramites)
    .innerJoin(flitoTramites, eq(flitoTramites.id, siigoFacturaTramites.tramiteId))
    .where(inArray(siigoFacturaTramites.facturaId, facturaIds));

  const companiaIds = [...new Set(
    vinculos.map((v) => v.companiaId).filter((x): x is number => typeof x === 'number'),
  )];
  const empresas = companiaIds.length === 0 ? [] : await db
    .select({ id: clients.id, name: clients.name })
    .from(clients).where(inArray(clients.id, companiaIds));

  const dian = dianIds.length === 0 ? [] : await db.select({
    id: siigoFacturaEstadosDian.id, estado: siigoFacturaEstadosDian.estado,
    motivo: siigoFacturaEstadosDian.motivo,
  }).from(siigoFacturaEstadosDian).where(inArray(siigoFacturaEstadosDian.id, dianIds));

  const correo = correoIds.length === 0 ? [] : await db.select({
    id: siigoFacturaEnvios.id, resultado: siigoFacturaEnvios.resultado,
    motivo: siigoFacturaEnvios.motivo,
  }).from(siigoFacturaEnvios).where(inArray(siigoFacturaEnvios.id, correoIds));

  return {
    facturas: new Map(facturas.map((f) => [String(f.id), {
      numero: f.numero ?? null, loteId: String(f.loteId), errorCode: f.errorCode ?? null,
    }])),
    colaPorLote: new Map(colas.map((k) => [String(k.loteId), {
      id: String(k.id), estado: String(k.estado) as SiigoColaEstado,
      intentos: Number(k.intentos) || 0, maxIntentos: Number(k.maxIntentos) || 0,
    }])),
    tramites: agruparTramites(vinculos),
    clientePorFactura: clientePorFactura(vinculos, new Map(empresas.map((e) => [e.id, e.name]))),
    dian: new Map(dian.map((d) => [String(d.id), {
      estado: String(d.estado) as SiigoEstadoDian, motivo: d.motivo ?? null,
    }])),
    correo: new Map(correo.map((e) => [String(e.id), {
      resultado: String(e.resultado) as SiigoEnvioResultado, motivo: e.motivo ?? null,
    }])),
    descartes: await cargarDescartes(casos),
  };
}

/**
 * La razón social del cliente de una factura. **Para cotejarla contra lo que se teclee sobre ella.**
 *
 * No la usa la bandeja para pintar —eso ya lo hace `hidratar` en lote—, sino la redacción de la nota
 * de un descarte: quien opera tiene esta razón social delante, en su fila, mientras escribe, así que
 * copiarla a la nota es el flujo esperado. Conocer el valor exacto permite taparlo sin adivinar y
 * sin tocar el texto que lo rodea, que es lo que ninguna heurística por forma puede prometer.
 *
 * Dos consultas y por el camino corto —el primer trámite de la factura, y de ahí su compañía—, no la
 * hidratación entera: esto corre en una acción de una sola fila que arranca una persona, no en la
 * consulta de la página. Devuelve `null` si no se puede resolver, y quien llama sigue: no tener con
 * qué cotejar no puede impedir que se registre una decisión.
 */
export async function nombreDeClienteDeFactura(facturaId: string): Promise<string | null> {
  const [vinculo] = await db.select({ companiaId: flitoTramites.companiaId })
    .from(siigoFacturaTramites)
    .innerJoin(flitoTramites, eq(flitoTramites.id, siigoFacturaTramites.tramiteId))
    .where(eq(siigoFacturaTramites.facturaId, facturaId))
    .limit(1);

  if (!vinculo || typeof vinculo.companiaId !== 'number') return null;

  const [empresa] = await db.select({ name: clients.name })
    .from(clients).where(eq(clients.id, vinculo.companiaId)).limit(1);
  return empresa?.name ?? null;
}

interface Vinculo {
  facturaId: string; tramiteId: string; idFlit: string | null; companiaId: number | null;
}

function agruparTramites(vinculos: Vinculo[]): Map<string, SiigoBandejaTramite[]> {
  const salida = new Map<string, SiigoBandejaTramite[]>();
  for (const v of vinculos) {
    const lista = salida.get(String(v.facturaId)) ?? [];
    lista.push({ tramiteId: String(v.tramiteId), idFlit: v.idFlit ?? null });
    salida.set(String(v.facturaId), lista);
  }
  return salida;
}

/**
 * El cliente de cada factura. Se toma el de su PRIMER trámite.
 *
 * Hoy es siempre uno: la estrategia de lote es `por_tramite` (D-1) y un lote tiene un solo trámite.
 * Si algún día se consolida por cliente, todos los trámites del lote serán del mismo cliente por
 * construcción, así que la respuesta seguirá siendo la misma.
 */
function clientePorFactura(
  vinculos: Vinculo[], nombres: Map<number, string>,
): Map<string, { id: number; nombre: string | null }> {
  const salida = new Map<string, { id: number; nombre: string | null }>();
  for (const v of vinculos) {
    if (v.companiaId === null || salida.has(String(v.facturaId))) continue;
    salida.set(String(v.facturaId), { id: v.companiaId, nombre: nombres.get(v.companiaId) ?? null });
  }
  return salida;
}

/**
 * Quién dio por perdido cada caso, cuándo y con qué motivo (AC5), leído de la bitácora WORM.
 *
 * Solo se pregunta por los casos que la fase 1 marcó como descartados: en la operación normal esa
 * lista está vacía, así que la consulta ni sale. El tope existe porque un caso descartado y
 * resucitado varias veces acumula hitos, y esta consulta no puede crecer sin límite.
 */
async function cargarDescartes(casos: FilaCaso[]): Promise<Map<string, SiigoBandejaDescarte>> {
  const marcados = casos.filter((x) => x.descartado);
  if (marcados.length === 0) return new Map();

  const colas = marcados.filter((x) => x.fuente !== 'correo')
    .map((x) => x.colaId).filter((x): x is string => Boolean(x));
  const actas = marcados.filter((x) => x.fuente === 'correo').map((x) => x.refId);

  const salida = new Map<string, SiigoBandejaDescarte>();
  for (const [tipo, ids] of [['siigo_cola', colas], ['factura_envio', actas]] as const) {
    for (const [id, d] of await descartesVigentes(tipo, ids)) salida.set(`${tipo}:${id}`, d);
  }
  return salida;
}

/**
 * Quién dio por perdida cada entidad, cuándo y con qué motivo — **si sigue estándolo**.
 *
 * Es la MISMA regla que `expresionDescartado` afirma en SQL, escrita una vez en TypeScript para que
 * la use tanto la hidratación de la página como el reintento en lote, que necesita saber a cuáles NO
 * puede tocar. Las dos encarnaciones comparten las constantes (`HITO_DESCARTE`, `HITO_ACTIVACION`) y
 * el mismo criterio de desempate: manda el ÚLTIMO hito, no la existencia de uno.
 *
 * Devuelve solo las que están descartadas AHORA. Una entidad descartada y luego resucitada no sale:
 * su hito sigue en la tabla —es WORM, no se puede borrar, y el AC6 pide justamente que se conserve—
 * pero ya no es la marca vigente.
 *
 * El tope existe porque un caso descartado y resucitado varias veces acumula hitos y esta consulta
 * no puede crecer sin límite. Con una página de 100 y dos hitos por vuelta, 500 cubre cinco ciclos
 * completos de descarte y resurrección de TODA la página.
 */
export async function descartesVigentes(
  entidadTipo: 'siigo_cola' | 'factura_envio', ids: string[],
): Promise<Map<string, SiigoBandejaDescarte>> {
  const unicos = [...new Set(ids)].filter(Boolean);
  if (unicos.length === 0) return new Map();

  const filas = await db.select({
    entidadId: siigoOperaciones.entidadId,
    operacion: siigoOperaciones.operacion,
    codigo: siigoOperaciones.codigo,
    mensaje: siigoOperaciones.mensaje,
    createdAt: siigoOperaciones.createdAt,
    createdBy: siigoOperaciones.createdBy,
  }).from(siigoOperaciones)
    .where(and(
      eq(siigoOperaciones.entidadTipo, entidadTipo),
      inArray(siigoOperaciones.operacion, [HITO_DESCARTE, HITO_ACTIVACION[entidadTipo]]),
      inArray(siigoOperaciones.entidadId, unicos),
    ))
    // Desempate por `id` y no solo por fecha: `created_at` es `now()`, o sea la hora de INICIO DE LA
    // TRANSACCIÓN, y dos hitos escritos en la misma transacción comparten instante exacto.
    .orderBy(desc(siigoOperaciones.createdAt), desc(siigoOperaciones.id))
    .limit(500);

  const vistas = new Set<string>();
  const salida = new Map<string, SiigoBandejaDescarte>();
  for (const f of filas) {
    const id = String(f.entidadId ?? '');
    // La primera que llega es la más reciente: manda esa y las anteriores no cuentan.
    if (vistas.has(id)) continue;
    vistas.add(id);
    if (f.operacion !== HITO_DESCARTE) continue;
    const motivo = esMotivoDescarte(f.codigo) ? f.codigo : null;
    salida.set(id, {
      motivo,
      motivoEtiqueta: motivo
        ? SIIGO_BANDEJA_MOTIVO_DESCARTE_ETIQUETA[motivo]
        : 'Motivo no reconocido',
      nota: f.mensaje && f.mensaje.trim() !== '' ? f.mensaje : null,
      usuarioId: f.createdBy ?? null,
      marcadoEn: f.createdAt.toISOString(),
    });
  }
  return salida;
}

// ── El resumen (AC1) ────────────────────────────────────────────────────────

/**
 * Cuántos casos hay, de qué tipo y a quién le tocan.
 *
 * **Agrupa en la BASE y sobre EL MISMO conjunto filtrado que ve la tabla.** Si contara sobre otro
 * conjunto —o en memoria, sobre la página— los números de arriba no cuadrarían con las filas de
 * abajo, que es la forma más rápida de que nadie vuelva a creerse la pantalla.
 *
 * `porResponsable` se calcula aquí y no en SQL a propósito: el responsable sale del catálogo de
 * códigos, que vive en TypeScript. Traerlo a la base sería copiarlo, y la copia se quedaría vieja.
 */
export async function resumenBandeja(o: OpcionesBandeja): Promise<SiigoBandejaResumen> {
  const ahora = o.ahora ?? new Date();
  const cliente = o.clientes && o.clientes.length > 0 ? condicionCliente([...o.clientes]) : SIEMPRE;

  const resultado = await db.execute(sql`
    WITH casos AS (${consultaPatas(o.ambiente, cliente)})
    SELECT fuente, COALESCE(codigo, ${CODIGO_SIN_DESENLACE}) AS codigo, COUNT(*)::int AS total
      FROM casos
     WHERE ${unir(condicionesExternas(o, ahora))}
     GROUP BY fuente, COALESCE(codigo, ${CODIGO_SIN_DESENLACE})
  `);

  const porFuente = Object.fromEntries(
    SIIGO_BANDEJA_FUENTES.map((f) => [f, 0]),
  ) as Record<SiigoBandejaFuente, number>;
  const porResponsable = Object.fromEntries(
    (Object.keys(ETIQUETA_RESPONSABLE) as ResponsableError[]).map((r) => [r, 0]),
  ) as Record<ResponsableError, number>;
  const porCodigo = new Map<string, { total: number; guia: GuiaErrorSiigo }>();
  let total = 0;

  for (const fila of filasDe(resultado)) {
    const n = Number(fila.total) || 0;
    total += n;
    if (esFuente(fila.fuente)) porFuente[fila.fuente] += n;
    const codigo = String(fila.codigo ?? CODIGO_SIN_DESENLACE);
    const guia = guiaDelCaso(codigo);
    porResponsable[guia.responsable] += n;
    const previo = porCodigo.get(codigo);
    porCodigo.set(codigo, { total: (previo?.total ?? 0) + n, guia });
  }

  return {
    ambiente: o.ambiente,
    total,
    porFuente,
    porResponsable,
    porCodigo: [...porCodigo.entries()]
      .map(([codigo, v]) => ({
        codigo,
        // La descripción y no el texto entero: esto es la lista del filtro, no la explicación.
        etiqueta: v.guia.descripcion,
        total: v.total,
        // El predicado del AC3, no el de «vuelve solo»: esta lista alimenta el filtro por motivo y
        // quien la mira decide sobre qué grupo pulsar «reintentar».
        reintentable: v.guia.sirveReintentar,
      }))
      .sort((a, b) => b.total - a.total || a.codigo.localeCompare(b.codigo)),
  };
}
