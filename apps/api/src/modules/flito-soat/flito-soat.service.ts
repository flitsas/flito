// FLITO — SOAT (lógica). Portado de packages/server/src/soat/soat.servicio.ts sobre el
// stack del grande, operando sobre la tabla flito_soat (que la sincronización ya puebla).
// COEXISTE con el módulo legacy modules/soat (soat_requests): shadow-run, sin tocarlo.
//
// Fase 2: workflow completo (cola, envío atómico, estados, aislamiento). La carga de factura
// (única vía a Pagado, RN-03) depende del OCR y llega en la Fase 3 (marcarPagado se exporta
// para ese uso). Las reglas caras: 3 fronteras de la cola (CA-01/CA-09), envío atómico (CA-04),
// aislamiento 404-no-403 (CA-09), RN-05/RN-06.

import { createHash } from 'crypto';
import JSZip from 'jszip';
import { and, asc, count, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { PgSelect } from 'drizzle-orm/pg-core';
import { db } from '../../db/client.js';
import {
  auditLogs,
  clients,
  flitoCompradores,
  flitoProveedoresSoat,
  flitoRevisiones,
  flitoSoat,
  flitoSoatCausalesRechazo,
  flitoSoatSolicitud,
  flitoSoportes,
  flitoTramites,
  organismosTransitoConfig,
  users,
  vehicles,
} from '../../db/schema.js';
import { aIso } from '../../shared/utils/fecha-rango.js';
import { registrarCambio, registrarCambios } from '../../shared/historial/estado-historial.js';
import { ANS_OPERATIVO,
  CampoSoat,
  CAMPOS_SOAT_EXTRAIDOS_SIN_EXIGIR,
  ESTADO_SOAT_LABEL,
  ESTADOS_SOAT_CANAL_CLIENTE,
  ESTADOS_SOAT_VISIBLES_GESTOR,
  EstadoSoat,
  FlujoRevision,
  MotivoRevision,
  polizaParaColumna,
  TipoPropiedad,
  type ExtraccionSoat,
} from '@operaciones/shared-types';
import { clasificacionDeTipoFlit, expresionesFlitRaw } from '../../shared/export/cola-flito-derivados.js';
import { extraerFacturaSoat, placaDesdeNombre, type DocumentoAAnalizar } from '../flito-ocr/flito-ocr.service.js';
import { carpetaDe, umbralPara } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { uploadEntityDocument } from '../../services/storage.js';
import { conConcurrencia } from '../../shared/utils/con-concurrencia.js';
import type { RegistroZip } from '../../shared/soportes/soportes-zip.js';

/**
 * TODOS los estados del enum, derivados y no escritos a mano (HU #11910).
 *
 * `Object.values` a propósito: un estado nuevo del catálogo entra aquí solo, y una lista literal se
 * habría quedado corta en silencio — con el efecto de que el ZIP dejaría fuera registros que el
 * actor sí puede ver, sin que nada lo dijera.
 */
const ESTADOS_SOAT_TODOS: readonly EstadoSoat[] = Object.values(EstadoSoat);

export interface SoatCtx {
  userId: number;
  username: string;
  role: string;
  proveedorSoatId: string | null;
  /**
   * La compañía del usuario `cliente` (Feature #11912). `null` para el resto de roles — y también
   * para un `cliente` al que le falte, que es el usuario que la base ya no debería permitir (CHECK
   * `users_cliente_compania_chk`) y que aquí acaba en «no ve nada», nunca en «lo ve todo».
   */
  companiaId: number | null;
}

/**
 * Resuelve la atadura de visibilidad del gestor desde la BD (no del JWT): §9.3. Un cambio de
 * proveedor de un gestor surte efecto sin re-emitir token. Para el resto de roles es null.
 *
 * Lo mismo, y por lo mismo, con la compañía del `cliente` (Feature #11912): se lee de
 * `users.compania_id` en cada petición y NO viaja en el token, así que moverle la compañía a alguien
 * surte efecto sin re-emitírselo. Es una consulta más, y solo para dos de los doce roles.
 */
export async function contextoSoat(user: { sub: number; username: string; role: string }): Promise<SoatCtx> {
  let proveedorSoatId: string | null = null;
  let companiaId: number | null = null;
  if (user.role === 'proveedor') {
    const [u] = await db.select({ p: users.flitoProveedorSoatId }).from(users).where(eq(users.id, user.sub)).limit(1);
    proveedorSoatId = u?.p ?? null;
  } else if (user.role === 'cliente') {
    const [u] = await db.select({ c: users.companiaId }).from(users).where(eq(users.id, user.sub)).limit(1);
    companiaId = u?.c ?? null;
  }
  return { userId: user.sub, username: user.username, role: user.role, proveedorSoatId, companiaId };
}

const esGestor = (ctx: SoatCtx) => ctx.role === 'proveedor';
/** Usuario de una compañía cliente (Feature #11912): ve lo de su compañía y nada más. */
const esCliente = (ctx: SoatCtx) => ctx.role === 'cliente';

/**
 * El valor de `flito_soat.origen` que marca las filas del canal Cliente (Feature #11912).
 *
 * En una constante y no repartido en literales para que un `grep ORIGEN_CLIENTE` encuentre TODAS las
 * decisiones que dependen de la puerta por la que entró la fila: la frontera de autogestión (justo
 * debajo), la lectura del propietario en la cola, el bloque de revisión del detalle y las tres
 * transiciones del canal (validar, rechazar, subsanar), que solo aplican a estas filas.
 *
 * La frase de arriba estuvo aquí siendo FALSA: la frontera conservaba el literal crudo `= 'cliente'`
 * y el grep no la encontraba. Interpolar la constante en el `sql` la trae al redil y además la pasa
 * como PARÁMETRO ENLAZADO en vez de inline, que es lo que AGENTS.md pide de cualquier valor que
 * entre en una consulta — aunque este sea una constante de compilación y no pudiera ser otra cosa.
 */
export const ORIGEN_CLIENTE = 'cliente';

/**
 * Quién entra en la cola: lo de las compañías que NO autogestionan, más lo que se desbloqueó
 * excepcionalmente (HU #10980). `COALESCE` porque la bandera del cliente es nullable.
 *
 * La TERCERA condición es del canal Cliente (Feature #11912) y no cubre un caso de borde: los dos
 * flags de la compañía son independientes, así que la primera que encienda «autogestiona SOAT» y
 * «SOAT sin trámite» a la vez radicaría solicitudes que no vería NADIE —tampoco el admin que tiene
 * que revisarlas—. Autogestionar es comprarse el SOAT de sus trámites; lo que pide por este canal se
 * lo está pidiendo a FLITO explícitamente, así que la frontera no le aplica.
 *
 * NO se reutiliza `excepcion_autogestion` para conseguir el mismo efecto: esa bandera significa «se
 * desbloqueó ESTE SOAT pese a que la compañía autogestiona» (HU #10980), y ponerla en cada alta del
 * canal la volvería mentira en el 100% de las filas, además de contaminar el informe que la usa.
 * Una tercera condición explícita dice lo que pasa; una bandera reutilizada lo esconde.
 */
const FRONTERA_AUTOGESTION_SOAT = sql`(NOT COALESCE(${clients.soatAutogestionable}, false)
  OR ${flitoSoat.excepcionAutogestion}
  OR ${flitoSoat.origen} = ${ORIGEN_CLIENTE})`;

// ───────────────────────────── Cola (3 fronteras) ───────────────────────────

export interface SoatColaItem {
  id: string;
  vin: string;
  placa: string | null;
  marca: string | null;
  linea: string | null;
  /**
   * Datos técnicos que trae FLIT y que el sync guarda en `vehicles` (HU #11906). Viajan como `null`
   * cuando FLIT no los trajo: el «—» lo pinta la interfaz, no el backend. Salen del `innerJoin` con
   * `vehicles` que la cola ya hacía, así que no cuestan una consulta más.
   */
  cilindraje: string | null;
  carroceria: string | null;
  tipoServicio: string | null;
  estado: EstadoSoat;
  tipoPropiedad: TipoPropiedad;
  esMultiplePropietario: boolean;
  companiaNombre: string;
  organismoNombre: string | null;
  proveedorSoatId: string | null;
  proveedorSoatNombre: string | null;
  /**
   * true = lo gestiona Operaciones por contingencia (HU #11152/#11153). `proveedorSoatId` puede
   * seguir viniendo lleno: es de quién se retomó, no quién lo trabaja. La interfaz necesita los dos
   * para poder decir «Operaciones, retomado de X».
   */
  gestionOperaciones: boolean;
  /**
   * Los propietarios de la fila, con el tipo de documento YA RESUELTO (HU #11947).
   *
   * `tipoDocumento` es `'CC' | 'NIT' | 'PP' | 'CE' | null` y **NO es el `tipo` crudo de FLIT**
   * (`n`, `cc`, `ps`, `ce`, `otro`): la tabla que traduce lo uno en lo otro vive en
   * `shared/export/cola-flito-derivados.ts` y tiene UNA sola copia en el repo (AC6). Si el crudo
   * viajara al navegador, las tres páginas que consumen estas colas necesitarían su propia copia y
   * las cuatro podrían divergir sin que nada fallara.
   *
   * `null` = el origen no lo dice: `tipo` ausente, desconocido, o —el caso que se lee entero en
   * `ensamblarCola`— un propietario del canal Cliente, que no tiene trámite y por tanto no tiene
   * payload del que resolverlo. Nunca se rellena con un valor por defecto.
   */
  compradores: Array<{ nombreCompleto: string; numeroDocumento: string; tipoDocumento: string | null; orden: number; porcentajeParticipacion: number | null }>;
  tramitesFlit: string[];
  /**
   * Datos del trámite, homologados con las demás tablas (tipo, aprobación, creación).
   *
   * Son `null` cuando el SOAT sirve a VARIOS trámites y no coinciden. Un SOAT es por VIN, no por
   * trámite (RN-01), así que preguntarle «su» tipo puede no tener respuesta; elegir el primero
   * sería mentir con aspecto de dato. Hoy los 51 SOAT sirven a un trámite cada uno, pero el modelo
   * permite lo contrario y la columna tiene que decirlo cuando pase.
   */
  tipoTramite: string | null;
  fechaAprobacion: string | null;
  fechaCreacion: string | null;
  enviadoPorNombre: string | null;
  enviadoEn: string | null;
  /** Fecha de pago. Ya se leía de BD para el detalle; la cola la necesita para el orden cronológico. */
  pagadoEn: string | null;
  valorPagado: number | null;
  estancado: boolean;
  motivoRechazo: string | null;
  creadoEn: string;
}

/**
 * Los campos del DTO que son de la OPERACIÓN, no del cliente (Feature #11912, corrección de
 * seguridad de la HU #11913).
 *
 * El aislamiento por compañía decide QUÉ FILAS ve el `cliente`; esta lista decide QUÉ CAMPOS de esas
 * filas. Son dos preguntas distintas y hasta aquí solo estaba respondida la primera: la forma de la
 * respuesta se diseñó para lectores internos —Operaciones, el gestor del proveedor, auditoría— y se
 * servía tal cual a una empresa tercera. Cada uno se va por un motivo propio:
 *
 *   · `proveedorSoatNombre` / `proveedorSoatId` — con qué proveedor tiene FLITO contratada la
 *     adquisición. El id se va con el nombre: es un pseudónimo estable que agrupa las filas por
 *     proveedor, así que dejarlo sería esconder la palabra y publicar el hecho.
 *   · `gestionOperaciones` — la otra mitad de lo mismo: dice si el caso lo trabaja FLITO o un
 *     tercero. Ocultar quién es el tercero y publicar que lo hay responde media pregunta.
 *   · `valorPagado` — lo que FLITO pagó por la póliza, frente a lo que le factura al cliente.
 *   · `enviadoPorNombre` — nombre del EMPLEADO de FLIT que la despachó; dato personal de un
 *     trabajador entregado a otra empresa.
 *
 * `proveedorSlaHoras` no está en esta lista porque no está en el DTO: se consulta (`ColaRow`) y no
 * se emite. Se deja escrito porque el informe de seguridad lo daba por expuesto y quien venga a
 * revisarlo merece saber que se comprobó, no que se olvidó.
 *
 * La proyección se aplica en `ensamblarCola`, que es por donde pasan las DOS lecturas —la cola y el
 * detalle—. Aplicarla en cada ruta habría dejado la del detalle a un olvido de distancia.
 */
const CAMPOS_SOLO_INTERNOS = [
  'proveedorSoatId', 'proveedorSoatNombre', 'gestionOperaciones', 'enviadoPorNombre', 'valorPagado',
] as const satisfies readonly (keyof SoatColaItem)[];
type CampoSoloInterno = (typeof CAMPOS_SOLO_INTERNOS)[number];

/** La fila tal como la ve una compañía cliente: sin nada de lo de arriba. */
export type SoatColaItemCliente = Omit<SoatColaItem, CampoSoloInterno>;

/** Lo que la cola devuelve: la fila entera, o la del cliente. Nunca «la entera con nulls». */
export type SoatColaItemSalida = SoatColaItem | SoatColaItemCliente;

/**
 * Quita los campos internos, recorriendo la LISTA DE ARRIBA y no una copia escrita a mano.
 *
 * Una desestructuración (`const { proveedorSoatId: _p, …, ...visible } = item`) se lee mejor, pero
 * serían DOS listas: quien añadiera un campo a `CAMPOS_SOLO_INTERNOS` sin tocar la desestructuración
 * seguiría entregándolo, y el compilador no diría nada —las comprobaciones de propiedades de más
 * solo aplican a literales—. Recorriendo la constante, el tipo y el borrado no pueden separarse.
 *
 * El `satisfies readonly (keyof SoatColaItem)[]` de la constante es la otra mitad: renombrar un
 * campo del DTO rompe la compilación AQUÍ en vez de dejar una cadena que ya no borra nada.
 */
function sinCamposInternos(item: SoatColaItem): SoatColaItemCliente {
  const visible: Record<string, unknown> = { ...item };
  for (const campo of CAMPOS_SOLO_INTERNOS) delete visible[campo];
  return visible as SoatColaItemCliente;
}

export interface FiltrosCola {
  estados?: EstadoSoat[];
  buscar?: string;
  /** Multiselect. Vacío = sin acotar. */
  companias?: number[];
  organismos?: string[];
  proveedores?: string[];
  /**
   * Quién gestiona. Solo tiene efecto útil para Operaciones y auditoría: la frontera del gestor ya
   * excluye lo de Operaciones, así que para él «proveedor» es redundante y «operaciones» vacío.
   */
  gestion?: 'operaciones' | 'proveedor';
  /** Rangos yyyy-mm-dd, inclusivos por día. */
  solicitadoDesde?: string; solicitadoHasta?: string;
  pagadoDesde?: string; pagadoHasta?: string;
  /**
   * Rango por CUÁNDO SE CREÓ la solicitud (`flito_soat.created_at`), HU #11909.
   *
   * Es un eje DISTINTO de `solicitadoDesde/Hasta`, que mide `enviado_en` —cuándo se despachó al
   * gestor—. Los dos existen a la vez y confundirlos es el defecto que esta HU tiene más cerca: un
   * SOAT nace en `pendiente` y puede pasar días sin enviarse, así que filtrar «creado en agosto»
   * contra `enviado_en` deja fuera todo lo que aún no se ha despachado —justo la parte de la cola
   * sobre la que se trabaja— y encima devuelve algo, así que nadie lo nota.
   *
   * Decisión de producto pegada en la HU: «Creado» es `created_at` de la solicitud, no la fecha del
   * trámite en FLIT.
   */
  creadoDesde?: string; creadoHasta?: string;
  /**
   * true = solo lo que superó el ANS OPERATIVO de FLIT (`ANS_OPERATIVO.SIN_GESTION_HORAS`), que es
   * una constante global.
   *
   * Decía «el SLA de su proveedor» y era falso: ni `EXPR_ESTANCADO` ni `estaEstancado()` leen
   * `flito_proveedores_soat.sla_horas`. La frase importa más de lo que parece desde el Feature
   * #11912 — si este filtro discriminara por el SLA del proveedor sería un oráculo sobre un dato
   * que el `cliente` no recibe, y habría que ignorárselo como a `gestion` y `proveedores`
   * (`filtrosPermitidos`). No lo es, y por eso se le deja.
   */
  estancado?: boolean;
  page?: number; pageSize?: number;
}

export interface ColaSoatPaginada {
  items: SoatColaItemSalida[]; total: number; page: number; pageSize: number;
}

/**
 * «Estancado» en SQL, para poder filtrar y contar por él.
 *
 * Es la misma regla que `estaEstancado()` aplica en JavaScript al ensamblar la fila; conviven
 * porque la pastilla se pinta desde el objeto ya ensamblado y el filtro tiene que ocurrir en la
 * consulta. Si una cambia, la otra debe cambiar con ella.
 *
 * `make_interval` y no `sla_horas || ' hours'`: la concatenación deja el tipo del parámetro
 * ambiguo y Postgres la rechaza en tiempo de ejecución.
 */
const EXPR_ESTANCADO = sql`(${flitoSoat.estado} = ${EstadoSoat.SOLICITADO}
  AND ${flitoSoat.enviadoEn} IS NOT NULL
  AND ${flitoSoat.enviadoEn} < NOW() - make_interval(hours => ${ANS_OPERATIVO.SIN_GESTION_HORAS}))`;

/**
 * Los filtros que este actor tiene derecho a APLICAR, que no es lo mismo que los que puede pedir.
 *
 * Quitarle un campo al DTO no basta si queda un filtro que particiona la cola por ese campo: con dos
 * peticiones —`?gestion=operaciones` y `?gestion=proveedor`— el `cliente` reconstruía
 * `gestionOperaciones` fila a fila, y con `?proveedores=<uuid>` hacía lo mismo con
 * `proveedorSoatId`. Un filtro es un ORÁCULO: responde sí/no sobre un campo oculto, y repetido es el
 * campo entero. Es la misma clase de fuga que `facetasCola` tenía con la lista de proveedores.
 *
 * Se ignoran —no dan 400— por la filosofía que ya sigue el resto de esta función: un valor que no
 * aplica se descarta, no tumba la pantalla de quien está trabajando. Y un 400 sería, además, otro
 * oráculo: confirmaría que el campo existe.
 *
 * ── Los otros nueve filtros, revisados uno a uno (por qué NO están aquí) ─────────────────────────
 *
 * El criterio es único: un filtro solo es oráculo si distingue por un campo que el cliente NO
 * recibe. Los que particionan por algo que ya está en su DTO no le dicen nada nuevo.
 *
 *   · `estados`, `companias`, `organismos` — `estado`, `companiaNombre` y `organismoNombre` viajan
 *     en su fila. Además su compañía ya está fijada por la frontera: pedir otra da vacío.
 *   · `buscar` — cruza placa, VIN y los compradores, que también viajan en su fila.
 *   · `solicitadoDesde/Hasta`, `pagadoDesde/Hasta` — `enviadoEn` y `pagadoEn` están en su DTO
 *     (decisión de producto: el ANS es de FLIT, no del proveedor).
 *   · `estancado` — se calcula con `estado` + `enviadoEn` + la constante global `ANS_OPERATIVO`, los
 *     tres visibles para él, y la propia bandera `estancado` viaja en la fila.
 *   · `page`/`pageSize` — no discriminan por ningún campo.
 *
 * Y no hay filtro por `valorPagado` ni por `extraccion`, los otros dos campos que el DTO le quita:
 * si mañana se añade uno, entra en esta lista.
 */
function filtrosPermitidos(ctx: SoatCtx, f: FiltrosCola): FiltrosCola {
  if (!esCliente(ctx)) return f;
  return { ...f, gestion: undefined, proveedores: undefined };
}

/**
 * Condiciones de la cola, en un solo sitio. Las comparten la página y el conteo: si difieren, el
 * total y las filas dejan de cuadrar sin que nada avise.
 *
 * Devuelve `null` cuando la frontera del gestor hace que no pueda ver NADA — distinto de «sin
 * filtros», que sería devolver una lista vacía de condiciones y traerlo todo.
 *
 * El saneo de filtros va DENTRO y no en la ruta, por la misma razón por la que la frontera vive
 * aquí: esta función la comparten la página, el conteo y las facetas, así que un solo `const` cubre
 * las tres. En la ruta habría que acordarse tres veces —y las facetas ni siquiera pasan por ella.
 *
 * **`export` desde la HU #11909**, y no por comodidad: el export a Excel tiene que producir EXACTAMENTE
 * el conjunto que la pantalla enseña. Un predicado paralelo escrito en el servicio del export
 * empezaría idéntico y divergiría en el primer filtro que se añada a uno y no al otro —y la
 * divergencia no se ve: los dos devuelven filas—. Es lo mismo que hizo el export de comparendos
 * importando `condicionesDeFiltro` del servicio del listado. Sobre todo, aquí dentro viven las TRES
 * fronteras: reimplementarlas fuera es la vía por la que un gestor acaba descargando lo de otro
 * proveedor.
 */
export function condicionesCola(ctx: SoatCtx, filtros: FiltrosCola): SQL[] | null {
  const f = filtrosPermitidos(ctx, filtros);
  const conds = [FRONTERA_AUTOGESTION_SOAT];

  if (esGestor(ctx)) {
    if (!ctx.proveedorSoatId) return null; // sin proveedor no hay frontera que aplicar → nada
    // Lo asumido por Operaciones desaparece de su cola. La condición va aquí, en las condiciones
    // COMPARTIDAS por la página, el conteo y las facetas: si viviera solo en la consulta de filas,
    // el total y los valores de los filtros seguirían contándolo y nadie lo notaría.
    conds.push(eq(flitoSoat.gestionOperaciones, false));
    conds.push(eq(flitoSoat.proveedorSoatId, ctx.proveedorSoatId));
    const visibles = f.estados?.length
      ? f.estados.filter((e) => (ESTADOS_SOAT_VISIBLES_GESTOR as readonly string[]).includes(e))
      : [EstadoSoat.SOLICITADO];
    if (visibles.length === 0) return null;
    conds.push(inArray(flitoSoat.estado, visibles));
  } else if (esCliente(ctx)) {
    // Aislamiento por compañía (Feature #11912), simétrico al del gestor y en el MISMO sitio: estas
    // condiciones las comparten la página, el conteo y las facetas, así que una sola rama cubre las
    // tres. Escribirlo en la consulta de filas dejaría el total y los valores de los filtros
    // contando lo ajeno — que es contarle al cliente que existe.
    //
    // Sin compañía no hay frontera que aplicar → NADA, igual que el gestor sin proveedor. El fallo
    // por defecto es «no ve nada»; devolver una lista vacía de condiciones sería traerlo todo.
    if (!ctx.companiaId) return null;
    conds.push(eq(flitoSoat.companiaId, ctx.companiaId));
    if (f.estados?.length) conds.push(inArray(flitoSoat.estado, f.estados));
  } else if (f.estados?.length) {
    conds.push(inArray(flitoSoat.estado, f.estados));
  }

  const termino = f.buscar?.trim();
  if (termino) {
    const term = termino.toUpperCase();
    const termNoSep = `%${term.replace(/[\s-]/g, '')}%`;
    const termTexto = `%${term}%`;
    conds.push(
      or(
        sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) LIKE ${termNoSep}`,
        sql`UPPER(${vehicles.vin}) LIKE ${termNoSep}`,
        sql`EXISTS (SELECT 1 FROM ${flitoTramites} ft JOIN ${flitoCompradores} fc ON fc.tramite_id = ft.id
              WHERE ft.soat_id = ${flitoSoat.id}
                AND (UPPER(fc.nombre_completo) LIKE ${termTexto} OR fc.numero_documento LIKE ${termTexto}))`,
        // La MISMA búsqueda por el OTRO padre de `flito_compradores` (Feature #11912, HU #11914).
        //
        // Sin esta rama, buscar por propietario devuelve MENOS FILAS DE LAS QUE HAY, en verde: una
        // solicitud del canal Cliente tiene `tramite_id IS NULL`, así que no entra por el JOIN de
        // arriba y el EXISTS da FALSE — el admin que filtra por el nombre del propietario para
        // revisarla no la encuentra y nada le dice que falta. Es el peor modo de fallo de una
        // pantalla de revisión, y por eso la auditoría de esquema lo puso como carga de esta HU.
        //
        // Dos EXISTS y no un LEFT JOIN con un OR dentro: cada uno usa su índice
        // (`idx_flito_compradores_tramite` / `idx_flito_compradores_soat`), y las dos ramas se leen
        // por separado — la del trámite puede tener VARIOS compradores por SOAT y la del canal tiene
        // exactamente uno.
        sql`EXISTS (SELECT 1 FROM ${flitoCompradores} fc
              WHERE fc.soat_id = ${flitoSoat.id}
                AND (UPPER(fc.nombre_completo) LIKE ${termTexto} OR fc.numero_documento LIKE ${termTexto}))`,
      )!,
    );
  }

  // Se AÑADE a la condición de arriba, no la sustituye: un `cliente` que pida ver otra compañía
  // obtiene la intersección, es decir, vacío. Mismo razonamiento que el filtro de proveedores.
  if (f.companias?.length) conds.push(inArray(flitoSoat.companiaId, f.companias));
  if (f.organismos?.length) conds.push(inArray(flitoSoat.organismoCodigo, f.organismos));
  // Un gestor ya está atado a su proveedor: dejarle filtrar por otro sería ruido, no una fuga —
  // la condición de la frontera sigue vigente y el resultado sería vacío. Para el `cliente` sí sería
  // una fuga, y por eso los dos llegan aquí ya vacíos (`filtrosPermitidos`).
  if (f.proveedores?.length) conds.push(inArray(flitoSoat.proveedorSoatId, f.proveedores));
  if (f.gestion === 'operaciones') conds.push(eq(flitoSoat.gestionOperaciones, true));
  else if (f.gestion === 'proveedor') conds.push(eq(flitoSoat.gestionOperaciones, false));

  // Rangos inclusivos por día: `hasta` suma un día para no dejar fuera esa jornada.
  if (f.solicitadoDesde) conds.push(sql`${flitoSoat.enviadoEn} >= ${f.solicitadoDesde}::date`);
  if (f.solicitadoHasta) conds.push(sql`${flitoSoat.enviadoEn} < (${f.solicitadoHasta}::date + INTERVAL '1 day')`);
  if (f.pagadoDesde) conds.push(sql`${flitoSoat.pagadoEn} >= ${f.pagadoDesde}::date`);
  if (f.pagadoHasta) conds.push(sql`${flitoSoat.pagadoEn} < (${f.pagadoHasta}::date + INTERVAL '1 day')`);
  // «Creado» (HU #11909) es `created_at` de ESTA tabla y no `enviado_en`, que es el rango de arriba.
  // Va aquí dentro, con los otros tres, y no en el servicio del export: estas condiciones las
  // comparten la página, el `count(*)`, las facetas y el archivo, así que un solo `if` acota las
  // cuatro y el total sigue cuadrando con lo que se descarga. Escrito en el export, la pantalla
  // filtraría por un criterio y el `.xlsx` por otro.
  if (f.creadoDesde) conds.push(sql`${flitoSoat.createdAt} >= ${f.creadoDesde}::date`);
  if (f.creadoHasta) conds.push(sql`${flitoSoat.createdAt} < (${f.creadoHasta}::date + INTERVAL '1 day')`);

  if (f.estancado) conds.push(EXPR_ESTANCADO);

  return conds;
}

/**
 * Los joins de la cola, compartidos por la página, el conteo, las facetas y —desde la HU #11909— el
 * export a Excel.
 *
 * Se exporta por el mismo motivo que `condicionesCola`: las condiciones nombran columnas de
 * `clients`, `vehicles` y `organismos_transito_config`, así que el predicado compartido solo es
 * ejecutable sobre ESTOS joins. Reescribirlos en el export dejaría abierta la puerta a que uno
 * sumara un join que multiplica filas —y en un archivo eso no se ve como un error, se ve como más
 * filas de las que hay.
 */
export function conJoinsCola<Q extends PgSelect>(q: Q) {
  return q
    .innerJoin(vehicles, eq(flitoSoat.vehiculoId, vehicles.id))
    .innerJoin(clients, eq(flitoSoat.companiaId, clients.id))
    .leftJoin(organismosTransitoConfig, eq(flitoSoat.organismoCodigo, organismosTransitoConfig.codigo))
    .leftJoin(flitoProveedoresSoat, eq(flitoSoat.proveedorSoatId, flitoProveedoresSoat.id))
    .leftJoin(users, eq(flitoSoat.enviadoPorId, users.id));
}

/**
 * Los SOAT del lote que ESTE actor puede ver, para el ZIP de soportes (HU #11910).
 *
 * ── Por qué una consulta por LOTE y no `buscarConAcceso` id a id ─────────────────────────────────
 *
 * El zip anterior llamaba a la función de acceso una vez por id: N×2 consultas para 100 ids, y en el
 * ZIP mixto de Trámites eso serían tres rondas de cien. El predicado que aplica la frontera ya está
 * escrito y ya es compartido —`condicionesCola` + `conJoinsCola`, exportados por la HU #11909—, así
 * que el lote entra en un solo `IN`.
 *
 * ── `estados: [...ESTADOS]` no es «traerlo todo», es lo contrario ────────────────────────────────
 *
 * `condicionesCola` con el filtro vacío acota al gestor a `solicitado` —el defecto de su PANTALLA—,
 * y el comprobante de SOAT solo existe cuando el registro ya está `pagado`: heredar ese defecto
 * habría dejado al gestor sin poder descargar nunca lo que él mismo subió. Pasando la lista completa
 * de estados, la intersección con `ESTADOS_SOAT_VISIBLES_GESTOR` que hay dentro devuelve exactamente
 * lo que `buscarConAcceso` deja pasar (`solicitado` + `pagado`), que es la frontera correcta para una
 * descarga. Para admin y auditoría la lista completa es, en efecto, sin recorte por estado.
 *
 * ── Los ids que no vuelven NO se distinguen ──────────────────────────────────────────────────────
 *
 * No se comprueba existencia ni se informa de descartes. Un id inexistente, uno de otro proveedor y
 * uno sin soporte producen el MISMO resultado: el archivo no está, y si no queda ninguno sale el
 * mismo 409. Contar «3 de 40 quedaron fuera» convertiría el ZIP en un oráculo de pertenencia.
 */
export async function registrosZipSoat(ids: string[], ctx: SoatCtx): Promise<RegistroZip[]> {
  if (ids.length === 0) return [];
  const conds = condicionesCola(ctx, { estados: [...ESTADOS_SOAT_TODOS] });
  if (conds === null) return []; // gestor sin proveedor → nada, nunca la tabla entera
  const filas = await conJoinsCola(db.select({
    id: flitoSoat.id,
    createdAt: flitoSoat.createdAt,
    placa: vehicles.plate,
    organismoAlias: organismosTransitoConfig.alias,
    organismoCodigo: organismosTransitoConfig.codigo,
  }).from(flitoSoat).$dynamic())
    .where(and(...conds, inArray(flitoSoat.id, ids)));

  return filas.map((f) => ({
    registroId: f.id,
    placa: f.placa,
    organismoAlias: f.organismoAlias,
    organismoCodigo: f.organismoCodigo,
    createdAt: f.createdAt,
    // La única ancla de esta superficie: el AC2 pide el comprobante del SOAT y nada más.
    soatId: f.id,
  }));
}

/**
 * Cola de SOAT con las 3 fronteras innegociables:
 *   1. Compañías que autogestionan SOAT se excluyen SIEMPRE (CA-01) — filtro en la consulta.
 *   2. Un gestor solo ve lo de su proveedor (CA-09) — filtro aquí, no en la UI.
 *   3. Un gestor NUNCA ve los Pendiente — se intersecta lo pedido con lo permitido.
 */
export async function cola(ctx: SoatCtx, f: FiltrosCola = {}): Promise<ColaSoatPaginada> {
  const page = Math.max(1, Math.floor(f.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(f.pageSize ?? 50)));

  const conds = condicionesCola(ctx, f);
  if (conds === null) return { items: [], total: 0, page, pageSize };
  const where = and(...conds);

  const [countRows, rows] = await Promise.all([
    conJoinsCola(db.select({ total: sql<number>`count(*)::int` }).from(flitoSoat).$dynamic()).where(where),
    conJoinsCola(db.select({
      id: flitoSoat.id,
      vin: flitoSoat.vin,
      estado: flitoSoat.estado,
      origen: flitoSoat.origen,
      proveedorSoatId: flitoSoat.proveedorSoatId,
      gestionOperaciones: flitoSoat.gestionOperaciones,
      enviadoEn: flitoSoat.enviadoEn,
      pagadoEn: flitoSoat.pagadoEn,
      valorPagado: flitoSoat.valorPagado,
      motivoRechazo: flitoSoat.motivoRechazo,
      createdAt: flitoSoat.createdAt,
      placa: vehicles.plate,
      marca: vehicles.brand,
      linea: vehicles.model,
      cilindraje: vehicles.cilindraje,
      carroceria: vehicles.carroceria,
      tipoServicio: vehicles.tipoServicio,
      companiaNombre: clients.name,
      organismoNombre: organismosTransitoConfig.alias,
      proveedorSoatNombre: flitoProveedoresSoat.nombre,
      proveedorSlaHoras: flitoProveedoresSoat.slaHoras,
      enviadoPorNombre: users.name,
    }).from(flitoSoat).$dynamic()).where(where)
      // Lo más RECIENTE arriba (HU #11963). La cola abre por lo que acaba de entrar para que una
      // solicitud recién llegada se vea de entrada, sin paginar: decisión de David del 2026-09-01.
      //
      // Sustituye a la prioridad por ANTIGÜEDAD que esta consulta tuvo hasta aquí, y conviene saber
      // qué se pierde: la lectura de cola FIFO —«qué lleva más esperando», el ángulo del SLA— ya NO
      // está disponible en esta pantalla. Se evaluó replicar el selector `recientes`/`antiguos` de
      // Gestión de trámites (HU #10959) para conservar las dos y se DESCARTÓ: el orden queda fijo
      // descendente. Quien eche de menos la vista por antigüedad la pide como HU; no se recupera
      // volteando esta línea, que es justo lo que esta nota existe para evitar.
      //
      // El desempate por id se voltea CON la clave, no se quita: es lo que evita que una fila salga
      // en dos páginas (o en ninguna) cuando varias comparten el mismo instante de creación, y con
      // `created_at desc` esa garantía solo se sostiene si el id desempata en el mismo sentido.
      .orderBy(desc(flitoSoat.createdAt), desc(flitoSoat.id))
      .limit(pageSize).offset((page - 1) * pageSize),
  ]);

  return {
    // SIN cast a `ColaRow[]`, y es deliberado: `$dynamic()` relaja qué métodos se pueden encadenar,
    // pero conserva el tipo de la proyección, así que el compilador SÍ compara este `select` contra
    // `ColaRow`. Un `as ColaRow[]` aquí lavaría el tipo y dejaría a la cola sin esa comparación:
    // quitar una columna de la proyección compilaría igual y la API devolvería el campo `undefined`.
    items: await ensamblarCola(rows, ctx),
    total: Number(countRows[0]?.total ?? 0),
    page,
    pageSize,
  };
}

export interface FacetasCola {
  companias: { id: number; nombre: string }[];
  organismos: { codigo: string; nombre: string | null }[];
  proveedores: { id: string; nombre: string }[];
}

/**
 * Valores disponibles para los filtros. Se calculan sobre el universo que el usuario PUEDE ver, no
 * sobre la tabla entera: ofrecerle a un gestor filtrar por un proveedor ajeno sería contarle que
 * existe.
 */
export async function facetasCola(ctx: SoatCtx): Promise<FacetasCola> {
  const conds = condicionesCola(ctx, {});
  if (conds === null) return { companias: [], organismos: [], proveedores: [] };
  const where = and(...conds);

  const [companias, organismos, proveedores] = await Promise.all([
    conJoinsCola(db.selectDistinct({ id: clients.id, nombre: clients.name }).from(flitoSoat).$dynamic()).where(where),
    conJoinsCola(db.selectDistinct({ codigo: organismosTransitoConfig.codigo, nombre: organismosTransitoConfig.alias }).from(flitoSoat).$dynamic()).where(where),
    // Los proveedores NO se consultan para el `cliente`, y no es un filtro cosmético del desplegable:
    // esta lista son los nombres de los proveedores de SUS PROPIOS SOAT, es decir, exactamente el
    // dato que `CAMPOS_SOLO_INTERNOS` acaba de quitar de cada fila. Servirlo aquí lo devolvería
    // entero por la puerta de al lado, y encima ordenado. No se lee lo que no se va a devolver.
    esCliente(ctx)
      ? Promise.resolve([] as { id: string | null; nombre: string | null }[])
      : conJoinsCola(db.selectDistinct({ id: flitoProveedoresSoat.id, nombre: flitoProveedoresSoat.nombre }).from(flitoSoat).$dynamic()).where(where),
  ]);

  return {
    companias: (companias as { id: number; nombre: string }[]).sort((a, b) => a.nombre.localeCompare(b.nombre)),
    organismos: (organismos as { codigo: string | null; nombre: string | null }[])
      .filter((o): o is { codigo: string; nombre: string | null } => o.codigo != null)
      .sort((a, b) => (a.nombre ?? '').localeCompare(b.nombre ?? '')),
    // Los SOAT sin proveedor asignado producen una fila nula en el DISTINCT: no es un proveedor.
    proveedores: (proveedores as { id: string | null; nombre: string | null }[])
      .filter((p): p is { id: string; nombre: string } => !!p.id && !!p.nombre)
      .sort((a, b) => a.nombre.localeCompare(b.nombre)),
  };
}

type ColaRow = {
  id: string; vin: string; estado: string;
  /**
   * De qué puerta salió la fila (`tramite` | `cliente`). NO viaja al DTO: se consulta porque decide
   * POR QUÉ PADRE hay que leer al propietario (ver `ensamblarCola`). Añadirlo a la respuesta sería
   * publicar un detalle de implementación que ninguna pantalla pide.
   */
  origen: string; proveedorSoatId: string | null; gestionOperaciones: boolean; enviadoEn: Date | null;
  pagadoEn: Date | null; valorPagado: string | null; motivoRechazo: string | null; createdAt: Date;
  placa: string | null; marca: string | null; linea: string | null;
  cilindraje: string | null; carroceria: string | null; tipoServicio: string | null;
  companiaNombre: string;
  organismoNombre: string | null; proveedorSoatNombre: string | null; proveedorSlaHoras: number | null;
  enviadoPorNombre: string | null;
};

/**
 * La expresión `->>` de la clave `tipo` de `flit_raw` (HU #11947), construida UNA vez.
 *
 * Sale de `expresionesFlitRaw` —la misma función que usan los dos exports— y no de un `sql` escrito
 * aquí, que es lo que garantiza tres cosas a la vez: la clave va como parámetro (regla 3 de
 * AGENTS.md), un valor no escalar se descarta en SQL con `case jsonb_typeof`, y la clave ligada es
 * la MISMA que la del archivo. Dos definiciones de «de dónde sale el tipo» podrían divergir y la
 * pantalla enseñaría un documento distinto del que el `.xlsx` publica.
 */
const TIPO_TITULAR_FLIT = expresionesFlitRaw(flitoTramites.flitRaw).tipo;

/**
 * El `ClaseId` que afirma un trámite, o `null` si no lo afirma.
 *
 * El API emite el código RESUELTO y no el `tipo` crudo de FLIT: ver `SoatColaItem.compradores`.
 */
const tipoDocumentoDeTramite = (tipo: unknown): string | null =>
  clasificacionDeTipoFlit(tipo)?.claseId ?? null;

/**
 * Arma las filas del DTO y las PROYECTA según quién pregunta.
 *
 * `ctx` es obligatorio y no tiene valor por defecto, por lo mismo que `actor` en `soportesDeSoat`:
 * un opcional haría que la fila completa se sirviera por olvido, que es exactamente cómo se coló
 * este bloqueante. Exigirlo obliga a cada llamador nuevo a decidir a quién está sirviendo.
 */
async function ensamblarCola(rows: ColaRow[], ctx: SoatCtx): Promise<SoatColaItemSalida[]> {
  const ids = rows.map((r) => r.id);
  const tramites = ids.length
    ? await db.select({
        id: flitoTramites.id, soatId: flitoTramites.soatId, idFlit: flitoTramites.idFlit,
        tipoPropiedad: flitoTramites.tipoPropiedad,
        tipoTramite: flitoTramites.tipoTramite,
        fechaAprobacion: flitoTramites.fechaAprobacion,
        // La fecha de FLIT y no `created_at`, que es cuándo el sync ingirió la fila: en la carga
        // masiva inicial todos los históricos comparten el mismo día.
        fechaCreacion: sql<Date | null>`COALESCE(${flitoTramites.fechaCreacionFlit}, ${flitoTramites.createdAt})`,
        // HU #11947. Una expresión más sobre la lectura que ya se hacía: cero consultas nuevas.
        tipoTitularFlit: TIPO_TITULAR_FLIT,
      })
        .from(flitoTramites).where(inArray(flitoTramites.soatId, ids))
    : [];
  const tramiteIds = tramites.map((t) => t.id);
  const compradores = tramiteIds.length
    ? await db.select().from(flitoCompradores).where(inArray(flitoCompradores.tramiteId, tramiteIds)).orderBy(asc(flitoCompradores.orden))
    : [];

  /**
   * El propietario de las filas del canal Cliente (Feature #11912, HU #11914).
   *
   * `flito_compradores` cuelga de DOS padres desde la 0167, con un CHECK que exige uno y solo uno.
   * Una fila del canal tiene `tramite_id IS NULL` y su propietario cuelga de `soat_id`, así que la
   * consulta de arriba —que filtra por `tramite_id IN (…)`— no lo encuentra NUNCA. Sin esta segunda
   * lectura, quien radica la solicitud abre su única pantalla y ve la fila SIN el propietario que
   * acaba de teclear, y el admin que la revisa, lo mismo. El dato está guardado; simplemente no
   * salía por ninguna parte.
   *
   * **Se consulta solo si hay filas del canal en esta página**, y de ahí que `origen` esté en la
   * proyección: una cola de puro trámite —que es el 100% de lo que hay hoy— no paga ni una consulta
   * más. `origen` es fiable para decidirlo porque el ÚNICO escritor de `flito_compradores.soat_id`
   * es el alta del canal, y esa escribe las dos cosas en la misma transacción.
   */
  const idsCanal = rows.filter((r) => r.origen === ORIGEN_CLIENTE).map((r) => r.id);
  const propietariosCanal = idsCanal.length
    ? await db.select().from(flitoCompradores).where(inArray(flitoCompradores.soatId, idsCanal)).orderBy(asc(flitoCompradores.orden))
    : [];
  const propsPorSoat = new Map<string, typeof propietariosCanal>();
  for (const c of propietariosCanal) {
    // Mismo descarte defensivo que el de `tramiteId` de abajo: la consulta filtró por
    // `soat_id IN (…)`, así que no puede ocurrir; está para que lo compruebe el compilador.
    if (!c.soatId) continue;
    const arr = propsPorSoat.get(c.soatId) ?? [];
    arr.push(c); propsPorSoat.set(c.soatId, arr);
  }

  const compsPorTramite = new Map<string, typeof compradores>();
  for (const c of compradores) {
    // `tramiteId` es nullable desde el Feature #11912 (la tabla cuelga de dos padres). Esta consulta
    // filtró por `tramite_id IN (…)`, así que el descarte no puede ocurrir; está escrito para que el
    // compilador lo compruebe en vez de creérselo.
    if (!c.tramiteId) continue;
    const arr = compsPorTramite.get(c.tramiteId) ?? [];
    arr.push(c); compsPorTramite.set(c.tramiteId, arr);
  }
  const tramitesPorSoat = new Map<string, typeof tramites>();
  for (const t of tramites) {
    if (!t.soatId) continue;
    const arr = tramitesPorSoat.get(t.soatId) ?? [];
    arr.push(t); tramitesPorSoat.set(t.soatId, arr);
  }

  const completas: SoatColaItem[] = rows.map((r) => {
    const ts = tramitesPorSoat.get(r.id) ?? [];
    // Las dos vías se UNEN en vez de excluirse: el CHECK de la 0167 garantiza que una fila de
    // `flito_compradores` cuelga de un solo padre, pero unirlas aquí hace que la columna
    // «propietario» diga lo mismo venga la fila de donde venga, sin un `if` por origen que alguien
    // tendría que mantener el día que aparezca un tercer camino.
    //
    // ── El tipo de documento se cuelga del trámite DUEÑO de cada comprador (HU #11947) ───────────
    //
    // Aquí NO hay nada que reconciliar y es la diferencia con el `.xlsx`: el archivo tiene UNA fila
    // por SOAT y por eso reconcilia los trámites con `comun()`; esta lista tiene una entrada por
    // COMPRADOR, y cada comprador cuelga de un trámite concreto, así que la relación es 1:1 y su
    // tipo es el de SU trámite. Pasarlo por `comun()` aquí sería vaciar el dato de dos propietarios
    // correctos porque sus trámites discrepan entre sí.
    //
    // Los del canal Cliente van con `null` y **no por un `if` de origen**: no tienen trámite, luego
    // no tienen `flit_raw`, luego no tienen `tipo`. Es la misma invariante que deja las cinco
    // columnas del titular vacías en el archivo.
    const comps = [
      ...(propsPorSoat.get(r.id) ?? []).map((c) => ({ ...c, tipoDocumentoFlit: null as string | null })),
      ...ts.flatMap((t) => (compsPorTramite.get(t.id) ?? [])
        .map((c) => ({ ...c, tipoDocumentoFlit: tipoDocumentoDeTramite(t.tipoTitularFlit) }))),
    ].sort((a, b) => a.orden - b.orden);
    const esMultiple = ts.some((t) => t.tipoPropiedad === TipoPropiedad.MULTIPLE_PROPIETARIO);
    return {
      id: r.id, vin: r.vin, placa: r.placa, marca: r.marca, linea: r.linea,
      // Pass-through puro, junto a marca/línea: son del vehículo, no del trámite, así que no pasan
      // por `comun()` — no hay nada que reconciliar entre varios trámites del mismo SOAT.
      cilindraje: r.cilindraje, carroceria: r.carroceria, tipoServicio: r.tipoServicio,
      estado: r.estado as EstadoSoat,
      tipoPropiedad: esMultiple ? TipoPropiedad.MULTIPLE_PROPIETARIO : TipoPropiedad.UNICO_PROPIETARIO,
      esMultiplePropietario: esMultiple,
      companiaNombre: r.companiaNombre,
      organismoNombre: r.organismoNombre,
      proveedorSoatId: r.proveedorSoatId,
      proveedorSoatNombre: r.proveedorSoatNombre,
      gestionOperaciones: r.gestionOperaciones,
      // `tipoDocumento` sale de `tipoDocumentoFlit` —resuelto desde `flit_raw`— y NO de la columna
      // `flito_compradores.tipo_documento`, que sigue a 0 de 7 052 para las filas del sync: solo la
      // escribe el canal Cliente. Publicar la columna daría un dato vacío en el 100 % de las filas
      // que la pantalla enseña, y lleno justo en las que no tienen nada más.
      compradores: comps.map((c) => ({ nombreCompleto: c.nombreCompleto, numeroDocumento: c.numeroDocumento, tipoDocumento: c.tipoDocumentoFlit, orden: c.orden, porcentajeParticipacion: c.porcentajeParticipacion === null ? null : Number(c.porcentajeParticipacion) })),
      tramitesFlit: ts.map((t) => t.idFlit),
      tipoTramite: comun(ts, (t) => t.tipoTramite),
      fechaAprobacion: aIso(comun(ts, (t) => t.fechaAprobacion)),
      fechaCreacion: aIso(comun(ts, (t) => t.fechaCreacion)),
      enviadoPorNombre: r.enviadoPorNombre,
      enviadoEn: r.enviadoEn ? r.enviadoEn.toISOString() : null,
      pagadoEn: r.pagadoEn ? r.pagadoEn.toISOString() : null,
      valorPagado: r.valorPagado === null ? null : Number(r.valorPagado),
      estancado: estaEstancado(r.estado, r.enviadoEn),
      motivoRechazo: r.motivoRechazo,
      creadoEn: r.createdAt.toISOString(),
    };
  });

  return esCliente(ctx) ? completas.map(sinCamposInternos) : completas;
}

/**
 * El valor que comparten TODOS los trámites de un SOAT, o null si discrepan.
 *
 * Un SOAT es por VIN y puede servir a varios trámites (RN-01). Cuando eso pasa, «el tipo de
 * trámite» de ese SOAT no existe: devolver el del primero pondría en la columna un dato con
 * aspecto de cierto que depende del orden de la consulta. Null es la respuesta honesta, y la
 * pantalla lo rotula «varios».
 *
 * **`export` desde la HU #11909**: la columna CIUDAD del archivo tiene la MISMA ambigüedad y hay que
 * resolverla igual. La alternativa —un `innerJoin` a `flito_tramites` en la consulta del export—
 * duplicaría la fila del SOAT una vez por trámite y falsearía además el conteo del tope, así que la
 * ciudad se lee aparte por lote y pasa por aquí, como el resto de datos del trámite.
 */
export function comun<T, V>(items: T[], leer: (t: T) => V | null): V | null {
  if (items.length === 0) return null;
  const primero = leer(items[0]);
  if (primero === null) return null;
  const iguales = items.every((t) => {
    const v = leer(t);
    // Las fechas no se comparan con ===: dos Date del mismo instante son objetos distintos.
    return v instanceof Date && primero instanceof Date ? v.getTime() === primero.getTime() : v === primero;
  });
  return iguales ? primero : null;
}

/**
 * Solicitado hace más del ANS OPERATIVO de FLIT (`ANS_OPERATIVO.SIN_GESTION_HORAS`, 24 h), la misma
 * constante global que usa `EXPR_ESTANCADO` en SQL. NO es el SLA del proveedor: ese vive en
 * `flito_proveedores_soat.sla_horas` y esta función no lo lee. La distinción importa —si
 * dependiera del proveedor, el filtro `estancado` le diría a un `cliente` con qué ANS tiene FLITO
 * contratado a su gestor, que es justo lo que la proyección por rol le oculta (Feature #11912).
 */
function estaEstancado(estado: string, enviadoEn: Date | null): boolean {
  if (estado !== EstadoSoat.SOLICITADO || !enviadoEn) return false;
  return (Date.now() - enviadoEn.getTime()) / 3_600_000 > ANS_OPERATIVO.SIN_GESTION_HORAS;
}

// ───────────────────────────── Detalle + acceso (404-no-403) ────────────────

/**
 * Busca un SOAT aplicando la frontera del gestor. Devuelve NULL (→ 404), no 403, cuando el
 * registro es de otro proveedor, autogestionado, o en un estado no visible para el gestor:
 * CA-09 dice que el gestor no obtiene datos ajenos "ni consultando por ID directo", y un 403
 * ya es un dato (confirma que el id existe).
 */
export async function buscarConAcceso(id: string, ctx: SoatCtx): Promise<typeof flitoSoat.$inferSelect | null> {
  const [soat] = await db
    .select({ soat: flitoSoat, dentroDeFrontera: FRONTERA_AUTOGESTION_SOAT })
    .from(flitoSoat)
    .innerJoin(clients, eq(flitoSoat.companiaId, clients.id))
    .where(eq(flitoSoat.id, id))
    .limit(1);
  if (!soat) return null;
  // La misma frontera que la cola: autogestionado queda fuera, salvo que se desbloqueara. Antes
  // aquí se miraba solo la bandera del cliente, así que un SOAT desbloqueado entraba en la cola y
  // luego daba 404 al abrirlo o al enviarlo (HU #11021).
  if (!soat.dentroDeFrontera) return null;
  if (esGestor(ctx)) {
    // Lo que asumió Operaciones sale de su alcance aunque siga apuntando a su proveedor: el
    // proveedor se conserva a propósito (HU #11153), así que la bandera es lo único que decide.
    // Va aquí y no solo en la cola porque esta función es la que sostiene el 404-no-403 del
    // detalle, el historial, el rechazo y la carga de factura.
    if (soat.soat.gestionOperaciones) return null;
    if (soat.soat.proveedorSoatId !== ctx.proveedorSoatId) return null;
    if (!(ESTADOS_SOAT_VISIBLES_GESTOR as readonly string[]).includes(soat.soat.estado)) return null;
  }
  if (esCliente(ctx)) {
    // La otra mitad del aislamiento por compañía (Feature #11912). Va aquí y no solo en la cola
    // porque esta es la función que sostiene el 404-no-403: cubre de una vez el detalle, el
    // historial, los soportes y la descarga. Un endpoint futuro del canal que olvide filtrar por
    // compañía no puede filtrarse por accidente — o pasa por aquí, o no ve nada.
    //
    // 404 y no 403, por lo mismo que con el gestor: un 403 ya es un dato (confirma que el id
    // existe). Sin compañía, `ctx.companiaId` es null y la comparación falla siempre.
    if (soat.soat.companiaId !== ctx.companiaId) return null;
  }
  return soat.soat;
}

/**
 * El bloque de REVISIÓN de una solicitud del canal Cliente (Feature #11912, HU #11915).
 *
 * Es lo que el AC3 pide que el Cliente pueda ver de su solicitud rechazada —la causal, la
 * observación y cuándo se revisó— y lo mismo que el admin necesita al abrirla. Viaja como bloque
 * ANIDADO y no como campos sueltos del DTO de la cola por dos razones que conviene no perder:
 *
 *   · La cola no lo necesita. `SoatColaItem` lo sirven la página, el conteo y las facetas; meterle
 *     cinco campos que solo tienen valor en el 0,x % de las filas obligaría a un LEFT JOIN más en la
 *     consulta caliente para que 99 de cada 100 filas lo recibieran en null.
 *   · `null` significa «esta fila no es del canal». Un bloque presente o ausente dice eso sin que la
 *     pantalla tenga que mirar `origen`, que además NO viaja al DTO a propósito.
 */
export interface RevisionSolicitud {
  /** El NOMBRE de la causal, resuelto contra el catálogo: la pantalla del Cliente no lo vuelve a pedir. */
  causalNombre: string | null;
  observacion: string | null;
  revisadoEn: string | null;
  /** Cuántas veces se subsanó y se volvió a enviar. */
  reenvios: number;
  solicitadoEn: string;
  /**
   * Quién la revisó. **Solo para lectores internos**, por lo mismo que `enviadoPorNombre` está en
   * `CAMPOS_SOLO_INTERNOS`: es el nombre de un EMPLEADO de FLIT, y entregárselo a la empresa tercera
   * que radicó la solicitud es un dato personal de un trabajador saliendo de la operación. El
   * Cliente ve la causal, la observación y la fecha —lo que necesita para corregir—, no la persona.
   */
  revisadoPorNombre?: string | null;
  /** HU #11935: desenlace de la verificación RUNT post-commit. Solo canal; el gestor no lo ve. */
  verificacionEstado: 'pendiente' | 'caido' | 'sin_registro' | 'no_cuadra' | 'ok';
  soatVigente: boolean | null;
  soatVigenteHasta: string | null;
  verificacionCodigo: string | null;
  /**
   * Cuándo respondió el RUNT en el alta, en ISO (HU #12093, AC4). `null` en las solicitudes
   * anteriores a la migración 0174, que no lo tienen y de las que no se inventa.
   *
   * Es lo que permite a la ficha decir DE CUÁNDO son los datos del vehículo que enseña. Va en el
   * bloque `visible` —lo ven el Cliente y el admin— porque el titular tiene derecho a saber cuándo se
   * consultó el registro sobre su vehículo, y quien revisa necesita saber si está mirando una lectura
   * de hace diez minutos o de hace tres semanas. **No es dato personal**: es un instante, sin placa,
   * sin documento y sin nombre, así que no entra en ninguna lista de `flito-soat.pii.ts`. Al gestor
   * no le llega, como todo este bloque: `revisionDeSolicitud` corta por `esGestor` antes de consultar.
   */
  runtConsultadoEn: string | null;
}

/**
 * El titular de una solicitud del canal, **partido**, tal como lo necesita la pantalla de
 * subsanación (HU #11966; lo pide el UX slim de la #11967 §6).
 *
 * ── Por qué NO se amplía `SoatColaItem.compradores` ─────────────────────────────────────────────
 *
 * Esa lista la comparten `cola()` y `detalle()` a través de `ensamblarCola`, así que ampliarla
 * publicaría correo, celular, dirección y domicilio del titular **en cada fila del listado** — una
 * fuga multiplicada por página y servida a todo lector interno, para un dato que necesita UNA
 * pantalla sobre UNA fila. Esto es una clave APARTE del detalle, con su propia proyección, y por eso
 * `cola()` no cambia ni una celda.
 */
export interface PropietarioCanalDetalle {
  tipoDocumento: string | null;
  nombres: string | null;
  apellidos: string | null;
  razonSocial: string | null;
  numeroDocumento: string;
  correo: string | null;
  celular: string | null;
  direccion: string | null;
  municipio: string | null;
  departamento: string | null;
}

/**
 * El propietario guardado de una solicitud del canal, para que la subsanación no obligue al Cliente
 * a reteclear a ciegas lo que ya está en la base.
 *
 * ── Las tres condiciones bajo las que se emite, y ninguna es redundante ─────────────────────────
 *
 *   1. **Solo filas `origen = 'cliente'`.** Se decide en `detalle()` mirando `soat.origen`, y NO por
 *      «no encontré propietario por trámite»: es el mismo criterio que la bifurcación del export
 *      (§7.1 del diseño de la #11966). Un SOAT de trámite no cambia lo que devuelve hoy, ni una
 *      clave.
 *   2. **Solo a quien pasa `buscarConAcceso`**, que es la guarda que este endpoint ya aplica antes de
 *      llegar aquí: para un `cliente` es la frontera por compañía con 404-y-no-403, así que un
 *      tercero no distingue «no es tuya» de «no existe». Esa es la prueba de propiedad; no hay otra.
 *   3. **Nunca al GESTOR del proveedor POR ESTA RUTA**, igual que `revisionDeSolicitud`: una
 *      solicitud validada entra en su cola y la abre con todo derecho, y aun así el detalle no le
 *      arma el bloque del titular. La consulta ni se emite.
 *
 *      **Y «por esta ruta» es literal, no una forma de hablar.** El gestor SÍ recibe el nombre, el
 *      documento, el contacto y el domicilio del titular de una fila del canal **en el `.xlsx` de la
 *      cola**: `POST /export` es `OPS_O_GESTOR` y `datosDeCanal` llena `Municipio`, `Departamento` y
 *      las cinco columnas del titular para `origen='cliente'` (AC6 de la HU #11966). Es una decisión
 *      TOMADA y no un hueco, por lo mismo que se anotó en su día la de `Departamento`:
 *
 *        · `correo`, `celular` y `direccion` **ya** le llegaban por ese Excel antes de esta HU
 *          —`COLUMNAS_COMPRADOR` los tenía en `develop`—, así que la hoja no le abre nada nuevo en
 *          contacto; lo que añade es el nombre partido y el domicilio.
 *        · Un gestor necesita la identidad y la dirección del propietario para EXPEDIR la póliza.
 *          Ese es el trabajo que se le encarga, y el archivo existe para eso.
 *
 *      Lo que este corte garantiza, entonces, es una cosa concreta y vale la pena decirla bien: que
 *      esos datos le lleguen **cuando se le encarga el trabajo** (una descarga explícita, con su
 *      cuota, su tope y su línea en `pii_access_log`), y no de propina en cada respuesta de detalle
 *      o de mutación que toque. Si algún día el export dejara de entregárselos, este párrafo se
 *      queda corto y hay que revisarlo aquí y en `datosDeCanal`.
 *
 * Proyección escrita campo a campo y no `select()`: la misma regla del export (RN-E1). `orden` y
 * `nombre_completo` no viajan —el primero no significa nada con un solo propietario; el segundo ya va
 * en `compradores` y duplicarlo daría dos fuentes del mismo nombre en la misma respuesta—.
 */
async function propietarioDelCanal(soatId: string, ctx: SoatCtx): Promise<PropietarioCanalDetalle | null> {
  if (esGestor(ctx)) return null;

  const [r] = await db
    .select({
      tipoDocumento: flitoCompradores.tipoDocumento,
      nombres: flitoCompradores.nombres,
      apellidos: flitoCompradores.apellidos,
      razonSocial: flitoCompradores.razonSocial,
      numeroDocumento: flitoCompradores.numeroDocumento,
      correo: flitoCompradores.correo,
      celular: flitoCompradores.celular,
      direccion: flitoCompradores.direccion,
      municipio: flitoCompradores.municipio,
      departamento: flitoCompradores.departamento,
    })
    .from(flitoCompradores)
    .where(eq(flitoCompradores.soatId, soatId))
    // Una solicitud del canal tiene EXACTAMENTE un propietario (lo escribe el alta con `orden: 0`),
    // pero el orden se fija igual: si algún día hubiera dos, «el primero que devuelva PostgreSQL»
    // sería un dato que cambia entre peticiones sin que nada haya cambiado en la base.
    .orderBy(asc(flitoCompradores.orden), asc(flitoCompradores.id))
    .limit(1);

  return r ?? null;
}

/** Columna `date` de Drizzle: string `yyyy-mm-dd`. Guardia Date por si el driver devolviera objeto. */
function diaIso(v: unknown): string | null {
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  return null;
}

/**
 * Lee el satélite de una solicitud y lo proyecta según quién pregunta.
 *
 * Vive aquí y no en `flito-soat-cliente.service.ts` para no invertir la dependencia entre los dos
 * módulos: aquel importa de este (`SoatCtx`, `buscarConAcceso`, `enviarAlGestor`), y si `detalle()`
 * importara de vuelta una función suya el ciclo estaría hecho.
 *
 * **Al GESTOR no se le sirve nunca, en ningún estado.** No es una precaución de más: una solicitud
 * validada entra en su cola en `solicitado` y él la abre con todo derecho, así que sin este corte
 * recibiría el revisor, la fecha de radicación y el contador de reenvíos — es decir, cuántas veces
 * FLITO le devolvió la solicitud a su cliente. Es la misma razón por la que el ADR-0008 §1.2 sacó
 * estos campos de `flito_soat`: la fila entera de esa tabla sí le llega. La consulta ni se emite.
 */
async function revisionDeSolicitud(soatId: string, ctx: SoatCtx): Promise<RevisionSolicitud | null> {
  if (esGestor(ctx)) return null;

  const [r] = await db
    .select({
      solicitadoEn: flitoSoatSolicitud.solicitadoEn,
      revisadoPorNombre: flitoSoatSolicitud.revisadoPorNombre,
      revisadoEn: flitoSoatSolicitud.revisadoEn,
      causalNombre: flitoSoatCausalesRechazo.nombre,
      observacion: flitoSoatSolicitud.observacionRechazo,
      reenvios: flitoSoatSolicitud.reenvios,
      verificacionEstado: flitoSoatSolicitud.verificacionEstado,
      soatVigente: flitoSoatSolicitud.soatVigente,
      soatVigenteHasta: flitoSoatSolicitud.soatVigenteHasta,
      verificacionCodigo: flitoSoatSolicitud.verificacionCodigo,
      runtConsultadoEn: flitoSoatSolicitud.runtConsultadoEn,
    })
    .from(flitoSoatSolicitud)
    // LEFT y no INNER: una solicitud sin rechazar no tiene causal, y un INNER la haría desaparecer
    // entera del detalle — que es justo la fila que el admin está a punto de validar.
    .leftJoin(flitoSoatCausalesRechazo, eq(flitoSoatSolicitud.causalRechazoId, flitoSoatCausalesRechazo.id))
    .where(eq(flitoSoatSolicitud.soatId, soatId))
    .limit(1);
  if (!r) return null;

  const visible: RevisionSolicitud = {
    causalNombre: r.causalNombre,
    observacion: r.observacion,
    revisadoEn: r.revisadoEn ? r.revisadoEn.toISOString() : null,
    reenvios: Number(r.reenvios),
    solicitadoEn: r.solicitadoEn.toISOString(),
    verificacionEstado: r.verificacionEstado as RevisionSolicitud['verificacionEstado'],
    soatVigente: r.soatVigente,
    soatVigenteHasta: diaIso(r.soatVigenteHasta),
    verificacionCodigo: r.verificacionCodigo,
    // Mismo trato que `revisadoEn` y `solicitadoEn`: ISO, y `null` cuando no consta. No se sustituye
    // por `solicitadoEn` «que es casi lo mismo» — son dos hechos distintos y esa sustitución es lo
    // que la columna vino a evitar.
    runtConsultadoEn: r.runtConsultadoEn ? r.runtConsultadoEn.toISOString() : null,
  };
  // La clave NO se emite con `undefined` para el cliente: se omite. Un `revisadoPorNombre: null` que
  // el admin ve lleno y el cliente ve vacío es el mismo objeto con menos datos; la clave ausente
  // dice que ese campo no es suyo.
  return esCliente(ctx) ? visible : { ...visible, revisadoPorNombre: r.revisadoPorNombre };
}

/**
 * El detalle de un SOAT, proyectado para quien pregunta.
 *
 * `extraccion` es el volcado del OCR de la FACTURA DE LA ASEGURADORA —valor, número de factura,
 * identificación del proveedor— y por eso viaja solo para los lectores internos: omitir
 * `valorPagado` y mandar el mismo importe dentro de este objeto sería una proyección de adorno.
 * Ninguna pantalla lo lee hoy (comprobado por grep en `apps/web`), así que quitarlo del canal del
 * cliente no rompe nada.
 */
export async function detalle(id: string, ctx: SoatCtx): Promise<(SoatColaItemSalida & {
  extraccion?: unknown;
  pagadoEn: string | null;
  solicitud?: RevisionSolicitud | null;
  /** Solo en filas del canal y solo para quien no es gestor. Ver {@link PropietarioCanalDetalle}. */
  propietarioCanal?: PropietarioCanalDetalle | null;
}) | null> {
  const soat = await buscarConAcceso(id, ctx); // valida la frontera del gestor (404-no-403)
  if (!soat) return null;

  const rows = await db
    .select({
      id: flitoSoat.id, vin: flitoSoat.vin, estado: flitoSoat.estado, origen: flitoSoat.origen,
      proveedorSoatId: flitoSoat.proveedorSoatId,
      gestionOperaciones: flitoSoat.gestionOperaciones,
      enviadoEn: flitoSoat.enviadoEn, pagadoEn: flitoSoat.pagadoEn, valorPagado: flitoSoat.valorPagado,
      motivoRechazo: flitoSoat.motivoRechazo, createdAt: flitoSoat.createdAt,
      placa: vehicles.plate, marca: vehicles.brand, linea: vehicles.model,
      // Por simetría con la cola. `detalle()` también alimenta `ensamblarCola`, así que si faltaran
      // aquí el TypeScript no compilaría — la misma red que protege a `cola()` desde que su llamada
      // dejó de ir con `as ColaRow[]`. Lo que esto evita es un detalle que dice «—» de un vehículo
      // cuya fila en la cola sí muestra el dato.
      cilindraje: vehicles.cilindraje, carroceria: vehicles.carroceria, tipoServicio: vehicles.tipoServicio,
      companiaNombre: clients.name, organismoNombre: organismosTransitoConfig.alias,
      proveedorSoatNombre: flitoProveedoresSoat.nombre, proveedorSlaHoras: flitoProveedoresSoat.slaHoras,
      enviadoPorNombre: users.name,
    })
    .from(flitoSoat)
    .innerJoin(vehicles, eq(flitoSoat.vehiculoId, vehicles.id))
    .innerJoin(clients, eq(flitoSoat.companiaId, clients.id))
    .leftJoin(organismosTransitoConfig, eq(flitoSoat.organismoCodigo, organismosTransitoConfig.codigo))
    .leftJoin(flitoProveedoresSoat, eq(flitoSoat.proveedorSoatId, flitoProveedoresSoat.id))
    .leftJoin(users, eq(flitoSoat.enviadoPorId, users.id))
    .where(eq(flitoSoat.id, id))
    .limit(1);

  const [item] = await ensamblarCola(rows, ctx);
  if (!item) return null;
  const pagadoEn = soat.pagadoEn ? soat.pagadoEn.toISOString() : null;
  // La consulta al satélite se emite SOLO para las filas del canal (Feature #11912): las de trámite
  // —el 100 % de lo que hay hoy— no tienen fila allí, así que preguntarlo sería una consulta más por
  // cada apertura de detalle para recibir siempre vacío. `origen` es fiable para decidirlo porque el
  // único escritor de `flito_soat_solicitud` es este canal, y escribe las dos cosas en la misma
  // transacción.
  const solicitud = soat.origen === ORIGEN_CLIENTE ? await revisionDeSolicitud(id, ctx) : null;
  // Misma condición y mismo motivo que la línea de arriba (HU #11966): la consulta se emite SOLO
  // para las filas del canal. Una fila de trámite ni siquiera gana la clave, así que su respuesta es
  // byte a byte la de antes de esta HU.
  const propietarioCanal = soat.origen === ORIGEN_CLIENTE ? await propietarioDelCanal(id, ctx) : null;
  if (soat.origen !== ORIGEN_CLIENTE) {
    return esCliente(ctx)
      ? { ...item, pagadoEn, solicitud }
      : { ...item, extraccion: soat.extraccion, pagadoEn, solicitud };
  }
  if (esCliente(ctx)) return { ...item, pagadoEn, solicitud, propietarioCanal };
  return { ...item, extraccion: soat.extraccion, pagadoEn, solicitud, propietarioCanal };
}

// ───────────────────────────── Envío atómico (CA-04) ────────────────────────

export interface ResultadoEnvio { enviados: string[]; yaEnviados: string[] }

/**
 * A quién se envía. Son excluyentes y la ruta lo valida antes de llegar aquí; si aun así llegaran
 * los dos, `gestionOperaciones` gana, para que ninguna fila acabe con las dos formas de gestión a
 * la vez (AC6). Eso es una red de seguridad, no el contrato.
 */
export interface DestinoEnvio {
  proveedorSoatId?: string;
  /** true = lo asume Operaciones por contingencia; el SOAT queda sin proveedor (HU #11152). */
  gestionOperaciones?: boolean;
}

/**
 * Lo que cambia entre las DOS puertas que llegan a `solicitado` (Feature #11912, HU #11915).
 *
 * La cola de trámite parte de `pendiente`; la validación de una solicitud del canal Cliente parte de
 * `pendiente_revision`. Todo lo demás —el bloqueo, la asignación de destino, el `enviado_por`, el
 * historial— es EXACTAMENTE lo mismo, y por eso se parametriza el estado de partida en vez de
 * escribir un segundo `update` que mañana diverja (ADR-0008 §6, precisión de `#6`).
 */
export interface OpcionesEnvio {
  /** Estado de PARTIDA exigido. Por defecto `pendiente`, que es la cola del flujo de trámite. */
  estadoOrigen?: EstadoSoat;
  /** Texto del historial. Por defecto, el del envío desde la cola. */
  motivo?: string;
}

/**
 * Envía SOAT al gestor: Pendiente → En adquisición. Solo Operaciones. La atomicidad es
 * obligatoria (CA-04): con dos usuarios despachando la misma cola, leer-luego-escribir deja
 * que ambos envíen el mismo registro. `SELECT ... FOR UPDATE OF s SKIP LOCKED` hace que el
 * segundo no vea la fila que el primero bloqueó. El destino se fija en el mismo movimiento.
 *
 * Desde la HU #11915 la usa TAMBIÉN la validación del admin sobre una solicitud del canal Cliente,
 * con `estadoOrigen: 'pendiente_revision'`. Es reúso de verdad y no una copia: el `SKIP LOCKED` que
 * impide el doble envío, la limpieza del proveedor y la fila de historial son los mismos, así que
 * una solicitud validada y un SOAT despachado desde la cola llegan a `solicitado` idénticos — que es
 * lo que el AC1 pide para que el proveedor la vea en su cola sin saber por qué puerta entró.
 */
export async function enviarAlGestor(
  ids: string[], ctx: SoatCtx, destino: DestinoEnvio = {}, opciones: OpcionesEnvio = {},
): Promise<ResultadoEnvio> {
  if (ids.length === 0) return { enviados: [], yaEnviados: [] };
  const estadoOrigen = opciones.estadoOrigen ?? EstadoSoat.PENDIENTE;

  const enviados = await db.transaction(async (tx) => {
    // FOR UPDATE OF flito_soat SKIP LOCKED: el segundo usuario que envíe el mismo registro no
    // ve la fila que el primero bloqueó (CA-04). Solo bloquea flito_soat (no clients).
    const locked = await tx
      .select({ id: flitoSoat.id })
      .from(flitoSoat)
      .innerJoin(clients, eq(flitoSoat.companiaId, clients.id))
      .where(and(
        inArray(flitoSoat.id, ids),
        eq(flitoSoat.estado, estadoOrigen),
        FRONTERA_AUTOGESTION_SOAT,
      ))
      .for('update', { of: flitoSoat, skipLocked: true });
    const idsEnviados = locked.map((r) => r.id);
    if (idsEnviados.length === 0) return [];

    const ahora = new Date();
    // El proveedor se pone a null explícitamente y no se deja "como estaba": desde Pendiente ya
    // debería serlo, pero una reversa desde En adquisición devuelve el SOAT a Pendiente sin
    // limpiarlo, y ese resto convertiría a este envío en un registro con proveedor Y contingencia.
    const aDestino = destino.gestionOperaciones
      ? {
          gestionOperaciones: true,
          gestionOperacionesPorId: ctx.userId,
          gestionOperacionesEn: ahora,
          proveedorSoatId: null,
          proveedorSobrescrito: false,
        }
      : { proveedorSoatId: destino.proveedorSoatId, proveedorSobrescrito: true };

    await tx.update(flitoSoat).set({
      estado: EstadoSoat.SOLICITADO,
      enviadoPorId: ctx.userId,
      enviadoEn: ahora,
      updatedAt: ahora,
      ...aDestino,
    }).where(inArray(flitoSoat.id, idsEnviados));

    // Un INSERT para todo el lote. Los que se quedaron fuera por el `skipLocked` no entran: el
    // historial cuenta lo que pasó, no lo que se intentó.
    const motivo = opciones.motivo
      ?? (destino.gestionOperaciones ? 'Envío a gestión de Operaciones' : 'Envío al gestor');
    await registrarCambios(tx, idsEnviados.map((sid) => ({
      concepto: 'soat' as const, registroId: sid,
      estadoAnterior: estadoOrigen, estadoNuevo: EstadoSoat.SOLICITADO,
      motivo, usuarioId: ctx.userId, usuarioEmail: ctx.username,
    })));

    return idsEnviados;
  });

  return { enviados, yaEnviados: ids.filter((id) => !enviados.includes(id)) };
}

// ───────────────────────────── Rechazo / reactivación / reversa / proveedor ──

export class SoatError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Rechazo del proveedor (CA-08). Solo desde En adquisición; motivo obligatorio. */
export async function rechazar(id: string, motivo: string, ctx: SoatCtx): Promise<typeof flitoSoat.$inferSelect> {
  const soat = await buscarConAcceso(id, ctx);
  if (!soat) throw new SoatError(404, 'El SOAT no existe');
  if (soat.estado !== EstadoSoat.SOLICITADO) throw new SoatError(400, 'Solo se puede rechazar un SOAT en adquisición');
  if (!motivo?.trim()) throw new SoatError(400, 'El motivo del rechazo es obligatorio');
  // En transacción con el historial: un estado sin su fila de historial es justo el agujero que el
  // historial viene a tapar, así que o entran los dos o no entra ninguno.
  return db.transaction(async (tx) => {
    const [updated] = await tx.update(flitoSoat)
      .set({ estado: EstadoSoat.CON_NOVEDAD, motivoRechazo: motivo.trim(), updatedAt: new Date() })
      .where(eq(flitoSoat.id, id)).returning();
    await registrarCambio(tx, {
      concepto: 'soat', registroId: id,
      estadoAnterior: soat.estado, estadoNuevo: EstadoSoat.CON_NOVEDAD,
      motivo: `Rechazo: ${motivo.trim()}`, usuarioId: ctx.userId, usuarioEmail: ctx.username,
    });
    return updated;
  });
}

/** Devuelve un SOAT rechazado a la cola (CA-08). Solo Operaciones, solo desde Rechazado. */
export async function reactivar(id: string, motivo: string, ctx: SoatCtx): Promise<typeof flitoSoat.$inferSelect> {
  const [soat] = await db.select().from(flitoSoat).where(eq(flitoSoat.id, id)).limit(1);
  if (!soat) throw new SoatError(404, 'El SOAT no existe');
  if (soat.estado !== EstadoSoat.CON_NOVEDAD) {
    throw new SoatError(400, `Solo un SOAT rechazado vuelve a Pendiente. Este está en "${ESTADO_SOAT_LABEL[soat.estado as EstadoSoat]}".`);
  }
  if (!motivo?.trim()) throw new SoatError(400, 'El motivo de la corrección es obligatorio');
  return db.transaction(async (tx) => {
    const [updated] = await tx.update(flitoSoat)
      .set({ estado: EstadoSoat.PENDIENTE, enviadoPorId: null, enviadoEn: null, motivoRechazo: null, updatedAt: new Date() })
      .where(eq(flitoSoat.id, id)).returning();
    await registrarCambio(tx, {
      concepto: 'soat', registroId: id,
      estadoAnterior: soat.estado, estadoNuevo: EstadoSoat.PENDIENTE,
      motivo: `Reactivación: ${motivo.trim()}`, usuarioId: ctx.userId, usuarioEmail: ctx.username,
    });
    return updated;
  });
}

/**
 * Reversa de un estado por Operaciones (RN-06). Pagado es terminal, pero terminal no es
 * inmutable: solo Operaciones lo mueve, con justificación (≥5) y rastro. Reversar un pagado es
 * lo único que devuelve un VIN a la cola, por eso no está en ningún camino automático.
 */
export async function reversar(id: string, estadoDestino: EstadoSoat, motivo: string, ctx: SoatCtx): Promise<typeof flitoSoat.$inferSelect> {
  const [soat] = await db.select().from(flitoSoat).where(eq(flitoSoat.id, id)).limit(1);
  if (!soat) throw new SoatError(404, 'El SOAT no existe');
  if (!motivo?.trim() || motivo.trim().length < 5) throw new SoatError(400, 'La reversa exige un motivo que explique el porqué');
  if (soat.estado === estadoDestino) throw new SoatError(400, 'El SOAT ya está en ese estado');

  // ── Los dos estados del canal Cliente quedan FUERA de la reversa, en los dos sentidos ───────────
  //
  // Es la puerta de al lado por la que se saltaba entera la revisión de la HU #11915, y estaba
  // abierta: la reversa NO comprobaba el estado de partida, así que un admin podía llevar una
  // solicitud en `pendiente_revision` a `pendiente` — y `pendiente` es justo lo que filtra
  // `POST /enviar`, de modo que la siguiente pasada de la cola la despachaba al gestor SIN QUE NADIE
  // la hubiera validado. El AC1 dice que a `solicitado` solo se llega revisando; esto lo hace
  // verdad en el único sitio donde vale, que es el servicio y no el botón.
  //
  // El sentido contrario lo prohíbe el ADR-0008 §8 por escrito: devolver a `pendiente_revision` un
  // SOAT ya validado dejaría al gestor sin la fila de su cola y al cliente con una solicitud que
  // creía resuelta. Se comprueba aquí y no solo en el `z.enum` de la ruta porque ese enum alimenta
  // también el selector de la pantalla, y basta con que alguien añada allí los dos estados nuevos
  // «para que la pill funcione» para abrir el destino sin darse cuenta.
  //
  // Salir de estos estados NO se queda sin camino: `POST /:id/validar` y
  // `POST /:id/rechazar-solicitud` son las dos únicas salidas de `pendiente_revision`, y de
  // `rechazada` se sale subsanando. La reversa es la excepción manual del ciclo de TRÁMITE.
  if (ESTADOS_SOAT_CANAL_CLIENTE.includes(soat.estado as EstadoSoat)) {
    throw new SoatError(400, `Una solicitud del canal Cliente en "${ESTADO_SOAT_LABEL[soat.estado as EstadoSoat]}" no se reversa: se valida o se rechaza desde la revisión.`);
  }
  if (ESTADOS_SOAT_CANAL_CLIENTE.includes(estadoDestino)) {
    throw new SoatError(400, `"${ESTADO_SOAT_LABEL[estadoDestino]}" es un estado del canal Cliente y no es un destino de reversa.`);
  }

  const limpiar = estadoDestino === EstadoSoat.PENDIENTE
    ? { enviadoPorId: null, enviadoEn: null, pagadoEn: null, valorPagado: null, motivoRechazo: null }
    : {};
  return db.transaction(async (tx) => {
    const [updated] = await tx.update(flitoSoat)
      .set({ estado: estadoDestino, ...limpiar, updatedAt: new Date() })
      .where(eq(flitoSoat.id, id)).returning();
    // La reversa es la operación que más falta hace explicar después: es la única que saca a un VIN
    // de `pagado`, así que el motivo va literal al historial.
    await registrarCambio(tx, {
      concepto: 'soat', registroId: id,
      estadoAnterior: soat.estado, estadoNuevo: estadoDestino,
      motivo: `Reversa: ${motivo.trim()}`, usuarioId: ctx.userId, usuarioEmail: ctx.username,
    });
    return updated;
  });
}

/**
 * Cambio de proveedor sobre un registro puntual (RN-05). Exige reversar a Pendiente antes de
 * cambiar el proveedor de un registro en adquisición: el proveedor determina la estrategia de
 * flujo, y cambiarlo a media adquisición dejaría el registro con un gestor sin acceso.
 */
export async function cambiarProveedor(id: string, proveedorSoatId: string, motivo: string): Promise<{ soat: typeof flitoSoat.$inferSelect; anterior: string | null }> {
  const [soat] = await db.select().from(flitoSoat).where(eq(flitoSoat.id, id)).limit(1);
  if (!soat) throw new SoatError(404, 'El SOAT no existe');
  if (soat.estado === EstadoSoat.SOLICITADO) {
    throw new SoatError(400, 'RN-05: para cambiar el proveedor de un SOAT en adquisición, primero hay que reversarlo a Pendiente con justificación.');
  }
  if (!motivo?.trim()) throw new SoatError(400, 'El motivo del cambio de proveedor es obligatorio');
  const [prov] = await db.select({ id: flitoProveedoresSoat.id }).from(flitoProveedoresSoat).where(eq(flitoProveedoresSoat.id, proveedorSoatId)).limit(1);
  if (!prov) throw new SoatError(404, 'El proveedor no existe');

  const anterior = soat.proveedorSoatId;
  const [updated] = await db.update(flitoSoat)
    .set({ proveedorSoatId, proveedorSobrescrito: true, updatedAt: new Date() })
    .where(eq(flitoSoat.id, id)).returning();
  return { soat: updated, anterior };
}

// ─────────────────── Traspaso de gestión: Operaciones ↔ proveedor (HU #11153) ─

/**
 * Estados en los que el traspaso tiene sentido: el registro ya salió a gestión y todavía no se
 * pagó. `pendiente` no ha salido —para eso está el destino del envío (HU #11152)— y `pagado` ya
 * consumió el dinero, así que cambiarle el gestor no describe nada real.
 */
const ESTADOS_TRASPASO_GESTION: readonly EstadoSoat[] = [EstadoSoat.SOLICITADO, EstadoSoat.CON_NOVEDAD];

const MOTIVO_MINIMO = 5;

/** Mensaje según por qué el estado no admite traspaso: el usuario necesita saber cuál de los dos es. */
function noAdmiteTraspaso(estado: EstadoSoat): SoatError {
  if (estado === EstadoSoat.PAGADO) {
    return new SoatError(400, 'Este SOAT ya está pagado: su gestión no se traspasa. Si hay que rehacerlo, primero reversarlo con justificación.');
  }
  return new SoatError(400, `Este SOAT aún no se ha enviado a gestión (está en "${ESTADO_SOAT_LABEL[estado]}"). Elige el destino al enviarlo.`);
}

function exigirMotivo(motivo: string, accion: string): string {
  const limpio = motivo?.trim() ?? '';
  if (limpio.length < MOTIVO_MINIMO) throw new SoatError(400, `${accion} exige un motivo que explique el porqué`);
  return limpio;
}

/**
 * Operaciones asume la gestión de un SOAT que ya está con un proveedor (contingencia).
 *
 * NO cambia el estado ni toca `enviadoEn`: el SOAT lleva el tiempo que lleva en adquisición, y
 * reiniciarlo escondería el retraso que justamente motivó la contingencia. Tampoco borra
 * `proveedorSoatId` — se conserva para poder devolvérselo de un clic y para que el reporte por
 * proveedor siga contando de quién se retomó. Quien decide la visibilidad es la bandera.
 *
 * Alternativa descartada: reutilizar `cambiarProveedor()`. RN-05 prohíbe cambiar de proveedor sobre
 * un SOAT En adquisición porque dejaría el registro con un gestor sin acceso; esa prohibición sigue
 * en pie. Esto es otra operación: no reasigna entre terceros, retira el caso de los terceros.
 */
export async function asumirEnOperaciones(id: string, motivo: string, ctx: SoatCtx): Promise<typeof flitoSoat.$inferSelect> {
  const [soat] = await db.select().from(flitoSoat).where(eq(flitoSoat.id, id)).limit(1);
  if (!soat) throw new SoatError(404, 'El SOAT no existe');
  const limpio = exigirMotivo(motivo, 'Asumir la gestión en Operaciones');
  if (soat.gestionOperaciones) throw new SoatError(400, 'Este SOAT ya lo gestiona Operaciones');
  if (!ESTADOS_TRASPASO_GESTION.includes(soat.estado as EstadoSoat)) throw noAdmiteTraspaso(soat.estado as EstadoSoat);

  const ahora = new Date();
  return db.transaction(async (tx) => {
    const [updated] = await tx.update(flitoSoat).set({
      gestionOperaciones: true,
      gestionOperacionesMotivo: limpio,
      gestionOperacionesPorId: ctx.userId,
      gestionOperacionesEn: ahora,
      updatedAt: ahora,
    }).where(eq(flitoSoat.id, id)).returning();

    // El estado no cambia, así que anterior y nuevo coinciden. El historial deja de ser solo de
    // transiciones y pasa a ser de eventos del registro — que es lo que el detalle ya muestra.
    await registrarCambio(tx, {
      concepto: 'soat', registroId: id,
      estadoAnterior: soat.estado as EstadoSoat, estadoNuevo: soat.estado as EstadoSoat,
      // SIN el uuid del proveedor del que se retomó (antes: «(retomada del proveedor <uuid>)»). Ese
      // dato es de la operación, y el historial es de las pocas cosas que un lector EXTERNO llega a
      // pedir: metido en la frase viajaba fuera del DTO que se lo quita. No se pierde —`audit()` lo
      // sigue anotando con el uuid en la ruta, y la columna `proveedor_soat_id` no se toca— y para
      // el lector interno la frase decía un uuid, que no es lo que una persona lee: el nombre lo
      // pinta el detalle.
      motivo: `Gestión asumida por Operaciones: ${limpio}`,
      usuarioId: ctx.userId, usuarioEmail: ctx.username,
    });
    return updated;
  });
}

/**
 * Devuelve al proveedor un SOAT que gestionaba Operaciones. Limpia las marcas de contingencia: las
 * columnas describen la situación ACTUAL, y el rastro de lo que pasó vive en el historial.
 */
export async function devolverAlGestor(id: string, proveedorSoatId: string, motivo: string, ctx: SoatCtx): Promise<typeof flitoSoat.$inferSelect> {
  const [soat] = await db.select().from(flitoSoat).where(eq(flitoSoat.id, id)).limit(1);
  if (!soat) throw new SoatError(404, 'El SOAT no existe');
  const limpio = exigirMotivo(motivo, 'Devolver la gestión al proveedor');
  if (!soat.gestionOperaciones) throw new SoatError(400, 'Este SOAT no lo gestiona Operaciones: no hay nada que devolver');
  if (!ESTADOS_TRASPASO_GESTION.includes(soat.estado as EstadoSoat)) throw noAdmiteTraspaso(soat.estado as EstadoSoat);

  const [prov] = await db.select({ id: flitoProveedoresSoat.id }).from(flitoProveedoresSoat)
    .where(eq(flitoProveedoresSoat.id, proveedorSoatId)).limit(1);
  if (!prov) throw new SoatError(404, 'El proveedor no existe');

  const ahora = new Date();
  return db.transaction(async (tx) => {
    const [updated] = await tx.update(flitoSoat).set({
      gestionOperaciones: false,
      gestionOperacionesMotivo: null,
      gestionOperacionesPorId: null,
      gestionOperacionesEn: null,
      proveedorSoatId,
      proveedorSobrescrito: true,
      updatedAt: ahora,
    }).where(eq(flitoSoat.id, id)).returning();

    await registrarCambio(tx, {
      concepto: 'soat', registroId: id,
      estadoAnterior: soat.estado as EstadoSoat, estadoNuevo: soat.estado as EstadoSoat,
      // Sin el uuid del proveedor, por lo mismo que en `asumirEnOperaciones`: `audit()` lo conserva
      // y la columna dice a quién se devolvió. Aquí sobraba incluso para quien es de la casa.
      motivo: `Gestión devuelta al proveedor: ${limpio}`,
      usuarioId: ctx.userId, usuarioEmail: ctx.username,
    });
    return updated;
  });
}

// ═══════════════════════ Carga de factura → Pagado (Fase 3, RN-03) ═══════════
// La factura validada por OCR es la ÚNICA vía a `Pagado` (RN-03): no hay marca manual. El estado es
// consecuencia del soporte, no de un clic. Porta packages/server/src/soat/soat.servicio.ts sobre el
// motor OCR Anthropic (modules/flito-ocr) y el storage S3/MinIO.

export interface ArchivoSubido {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

/** Campos que sí bloquean el avance a Pagado. Vigencia/expedición NO están (D-7): se leen sin exigir. */
const CAMPOS_REQUERIDOS_SOAT: readonly CampoSoat[] = [
  CampoSoat.NUMERO_POLIZA, CampoSoat.VALOR_TOTAL, CampoSoat.ASEGURADORA,
];

const normalizarLlave = (v: string | null | undefined): string => (v ?? '').toUpperCase().replace(/[\s-]/g, '');

export interface Veredicto { aprobada: boolean; motivo?: MotivoRevision; detalle?: string }

/**
 * Decide si la extracción alcanza para cerrar sin humano. Tres condiciones EN ORDEN, porque el
 * motivo cambia el mensaje y la acción: (1) que haya llave leída, (2) que la llave cruce con ESTE
 * registro, (3) que la llave y los campos requeridos superen el umbral. Compara `confianza` numérica
 * contra el umbral (no el flag `confiable`), para que reevaluar con otro umbral —el del proveedor en
 * la carga masiva— dé el resultado correcto. RN-04/CA-06.
 */
export function evaluarExtraccionSoat(
  extraccion: ExtraccionSoat,
  esperado: { vin: string; placa: string | null },
  umbral: number,
): Veredicto {
  const placa = extraccion[CampoSoat.PLACA];
  const vin = extraccion[CampoSoat.VIN];

  if (!placa?.valor && !vin?.valor) {
    return { aprobada: false, motivo: MotivoRevision.SIN_LLAVE_DE_CRUCE,
      detalle: 'La factura no permitió leer ni placa ni VIN, así que no se puede saber a qué vehículo pertenece.' };
  }

  const placaCruza = !!placa?.valor && normalizarLlave(placa.valor) === normalizarLlave(esperado.placa);
  const vinCruza = !!vin?.valor && normalizarLlave(vin.valor) === normalizarLlave(esperado.vin);
  if (!placaCruza && !vinCruza) {
    return { aprobada: false, motivo: MotivoRevision.LLAVE_NO_CRUZA,
      detalle: `La factura dice placa "${placa?.valor ?? '—'}" / VIN "${vin?.valor ?? '—'}", pero el registro es placa ${esperado.placa ?? '—'} / VIN ${esperado.vin}.` };
  }

  const llaveConfiable = (placaCruza && placa!.confianza >= umbral) || (vinCruza && vin!.confianza >= umbral);
  const dudosos = CAMPOS_REQUERIDOS_SOAT.filter((c) => {
    const e = extraccion[c];
    return !e || e.valor === null || e.confianza < umbral;
  });

  if (!llaveConfiable || dudosos.length > 0) {
    const faltantes = dudosos.length > 0 ? dudosos.join(', ') : 'la llave de cruce';
    return { aprobada: false, motivo: MotivoRevision.CONFIANZA_INSUFICIENTE,
      detalle: `La lectura no superó el umbral de ${umbral} en: ${faltantes}.` };
  }
  return { aprobada: true };
}

// Tx de drizzle (mismo truco de tipado que flito-sync: no hay alias exportado).
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const TIPO_FACTURA_SOAT = 'factura_soat';

/** Bitácora en la MISMA tx que el cambio, con la identidad del actor. Trazabilidad atómica del pago. */
async function auditEnTx(tx: Tx, ctx: SoatCtx, resourceId: string, detail: string): Promise<void> {
  await tx.insert(auditLogs).values({
    userId: ctx.userId, userEmail: ctx.username, action: 'update', resource: 'flito_soat', resourceId, detail,
  });
}

/**
 * Lleva el SOAT a `Pagado` dentro de una tx. Es el ÚNICO punto que escribe `pagado` (RN-03): revalida
 * que exista factura (belt-and-suspenders CA-11), copia el valor DESDE la factura (no de un cálculo)
 * y registra en bitácora qué campos no exigidos pasaron sin ser confiables (D-7), por si mañana se
 * quiere alertar sobre pólizas por vencer.
 */
async function pagarEnTx(tx: Tx, soatId: string, vin: string, estadoAnterior: EstadoSoat, extraccion: ExtraccionSoat, ctx: SoatCtx, soporteId: string | null): Promise<void> {
  const [{ n }] = await tx.select({ n: count() }).from(flitoSoportes)
    .where(and(eq(flitoSoportes.soatId, soatId), eq(flitoSoportes.tipo, TIPO_FACTURA_SOAT), eq(flitoSoportes.descartado, false)));
  if (Number(n) === 0) throw new SoatError(400, 'No se puede marcar pagado un SOAT sin factura cargada');

  const valorTotal = extraccion[CampoSoat.VALOR_TOTAL]?.valor ?? null;
  // La póliza sube de `extraccion` a su columna en el mismo `set()` que el estado (Feature #11623):
  // son el mismo hecho, y separarlos dejaría SOAT pagados sin la llave con la que se concilian.
  // `polizaParaColumna` es la misma normalización que el backfill de la 0157, para que un SOAT
  // pagado hoy y uno migrado ayer se puedan comparar entre sí.
  //
  // Cuando no hay póliza legible NO se escribe nada: la columna se deja como esté. Poner `null`
  // aquí borraría una corrección hecha a mano —el OCR no es la única fuente que puede tener razón—
  // y esta transición no es el sitio para decidir eso. En la práctica el caso es raro: la póliza es
  // un campo requerido para llegar a `pagado` (CAMPOS_REQUERIDOS_SOAT).
  const numeroPoliza = polizaParaColumna(extraccion[CampoSoat.NUMERO_POLIZA]?.valor);
  await tx.update(flitoSoat).set({
    estado: EstadoSoat.PAGADO,
    extraccion,
    valorPagado: valorTotal, // numeric acepta el string ya normalizado a pesos enteros
    ...(numeroPoliza ? { numeroPoliza } : {}),
    pagadoEn: new Date(),
    motivoRechazo: null,
    updatedAt: new Date(),
  }).where(eq(flitoSoat.id, soatId));

  await registrarCambio(tx, {
    concepto: 'soat', registroId: soatId,
    estadoAnterior, estadoNuevo: EstadoSoat.PAGADO,
    // SIN el importe (antes: «Valor <valorTotal>»). Es el camino feliz —toda transición a `pagado`
    // pasa por aquí—, así que era el más eficaz de los tres: `valorPagado` se quita del DTO del
    // cliente y volvía a salir, en texto, por el historial. Vive en su columna (`valor_pagado`, que
    // se escribe cuatro líneas más arriba) y en `audit_logs`, que es interno y no se sirve a nadie
    // de fuera. Para admin, proveedor y auditoría el importe sigue en el detalle y en la bitácora.
    motivo: 'Pago confirmado por factura.',
    usuarioId: ctx.userId, usuarioEmail: ctx.username,
  });

  const noExigidosSinLeer = CAMPOS_SOAT_EXTRAIDOS_SIN_EXIGIR.filter((c) => !extraccion[c]?.confiable);
  await auditEnTx(tx, ctx, soatId,
    `Pago confirmado por factura (${estadoAnterior}→pagado). Valor ${valorTotal ?? '—'}, ` +
    `póliza ${extraccion[CampoSoat.NUMERO_POLIZA]?.valor ?? '—'}, aseguradora ${extraccion[CampoSoat.ASEGURADORA]?.valor ?? '—'}` +
    `${soporteId ? `, soporte ${soporteId}` : ''}. VIN ${vin}.` +
    (noExigidosSinLeer.length ? ` No exigidos sin leer: ${noExigidosSinLeer.join(', ')}.` : ''));
}

/**
 * Marca pagado un SOAT desde una extracción ya validada, en su propia tx. Exportada (§9.2) para usos
 * fuera de la carga directa; la carga usa `pagarEnTx` para hacer soporte+pago atómicos.
 */
export async function marcarPagado(soatId: string, extraccion: ExtraccionSoat, ctx: SoatCtx): Promise<void> {
  await db.transaction(async (tx) => {
    const [soat] = await tx.select().from(flitoSoat).where(eq(flitoSoat.id, soatId)).limit(1);
    if (!soat) throw new SoatError(404, 'El SOAT no existe');
    const [sop] = await tx.select({ id: flitoSoportes.id }).from(flitoSoportes)
      .where(and(eq(flitoSoportes.soatId, soatId), eq(flitoSoportes.tipo, TIPO_FACTURA_SOAT), eq(flitoSoportes.descartado, false)))
      .orderBy(desc(flitoSoportes.subidoEn)).limit(1);
    await pagarEnTx(tx, soat.id, soat.vin, soat.estado as EstadoSoat, extraccion, ctx, sop?.id ?? null);
  });
}

// Datos de un SOAT necesarios para leer y archivar su factura: llave, compañía (carpeta S3) y umbral.
interface DatosCarga {
  soatId: string; vin: string; placa: string | null; estado: EstadoSoat;
  // `document` NO se trae (HU #11770): la carpeta se nombra con el id de la compañía, no con su NIT.
  companiaId: number; carpeta: string | null; umbralOcr: string | null;
}

async function datosCargaPorId(id: string): Promise<DatosCarga | null> {
  const [r] = await db.select({
    soatId: flitoSoat.id, vin: flitoSoat.vin, estado: flitoSoat.estado, placa: vehicles.plate,
    companiaId: clients.id, carpeta: clients.flitoCarpetaStorage,
    umbralOcr: flitoProveedoresSoat.umbralOcr,
  }).from(flitoSoat)
    .innerJoin(vehicles, eq(flitoSoat.vehiculoId, vehicles.id))
    .innerJoin(clients, eq(flitoSoat.companiaId, clients.id))
    .leftJoin(flitoProveedoresSoat, eq(flitoSoat.proveedorSoatId, flitoProveedoresSoat.id))
    .where(eq(flitoSoat.id, id)).limit(1);
  return r ? { ...r, estado: r.estado as EstadoSoat } : null;
}

/** Duplicado por hash (CA-08): un mismo archivo no se concilia dos veces. */
async function facturaDuplicada(hash: string): Promise<boolean> {
  const [dup] = await db.select({ id: flitoSoportes.id }).from(flitoSoportes)
    .where(and(eq(flitoSoportes.hash, hash), eq(flitoSoportes.tipo, TIPO_FACTURA_SOAT), eq(flitoSoportes.descartado, false))).limit(1);
  return !!dup;
}

/** Sube la factura a S3 y devuelve su storage_key. Va ANTES de tocar la BD (CA-11). */
async function archivarFactura(datos: DatosCarga, archivo: ArchivoSubido): Promise<string> {
  const carpeta = carpetaDe({ id: datos.companiaId, flitoCarpetaStorage: datos.carpeta }, 'soat/facturas');
  return uploadEntityDocument(carpeta, datos.soatId, archivo.originalname, archivo.buffer, archivo.mimetype);
}

// Persiste soporte + (pago | revisión) en una sola tx. `aprobada` decide el desenlace.
async function persistirCarga(datos: DatosCarga, archivo: ArchivoSubido, hash: string, storageKey: string, extraccion: ExtraccionSoat, veredicto: Veredicto, ctx: SoatCtx): Promise<void> {
  await db.transaction(async (tx) => {
    const [soporte] = await tx.insert(flitoSoportes).values({
      tipo: TIPO_FACTURA_SOAT, nombreArchivo: archivo.originalname, contentType: archivo.mimetype,
      storageKey, hash, tamanoBytes: archivo.size, soatId: datos.soatId,
      subidoPorId: ctx.userId, subidoPorNombre: ctx.username,
    }).returning({ id: flitoSoportes.id });

    if (veredicto.aprobada) {
      await pagarEnTx(tx, datos.soatId, datos.vin, datos.estado, extraccion, ctx, soporte.id);
    } else {
      // El SOAT se queda En adquisición (CA-06): el documento existe, pero ningún dato del OCR se da
      // por válido sin confirmación humana (RN-04). Los gestores no resuelven esta cola (RN-05).
      await tx.insert(flitoRevisiones).values({
        modulo: FlujoRevision.SOAT, motivo: veredicto.motivo!, detalle: veredicto.detalle!,
        registroId: datos.soatId, soporteId: soporte.id,
        placaSugerida: extraccion[CampoSoat.PLACA]?.valor ?? null,
        extraccion, resuelto: false,
      });
      await auditEnTx(tx, ctx, datos.soatId, `OCR a revisión (${veredicto.motivo}): ${veredicto.detalle} Soporte ${soporte.id}.`);
    }
  });
}

/**
 * Carga de la factura de un SOAT puntual. Única vía a `Pagado` (RN-03). Se LEE y VERIFICA antes de
 * guardar: si la factura no corresponde a este SOAT (sin llave o llave que contradice), se descarta
 * sin archivarla — sería un comprobante de otro vehículo colgado del registro equivocado.
 */
export async function cargarFactura(id: string, archivo: ArchivoSubido, ctx: SoatCtx): Promise<Awaited<ReturnType<typeof detalle>>> {
  const soat = await buscarConAcceso(id, ctx); // frontera del gestor (404-no-403)
  if (!soat) throw new SoatError(404, 'El SOAT no existe');
  if (soat.estado !== EstadoSoat.SOLICITADO) {
    throw new SoatError(400, `Solo se puede cargar factura de un SOAT en adquisición. Este está en "${ESTADO_SOAT_LABEL[soat.estado as EstadoSoat]}".`);
  }

  const datos = await datosCargaPorId(id);
  if (!datos) throw new SoatError(404, 'El SOAT no existe');

  const umbral = umbralPara(datos.umbralOcr);
  const extraccion = await extraerFacturaSoat(docDe(archivo, umbral));
  const veredicto = evaluarExtraccionSoat(extraccion, { vin: datos.vin, placa: datos.placa }, umbral);

  if (!veredicto.aprobada && (veredicto.motivo === MotivoRevision.SIN_LLAVE_DE_CRUCE || veredicto.motivo === MotivoRevision.LLAVE_NO_CRUZA)) {
    throw new SoatError(400, `${veredicto.detalle} No corresponde a este SOAT, así que no se guardó.`);
  }

  const hash = createHash('sha256').update(archivo.buffer).digest('hex');
  if (await facturaDuplicada(hash)) {
    throw new SoatError(409, 'Esta factura ya fue cargada antes (mismo archivo). No se concilia dos veces.');
  }

  const storageKey = await archivarFactura(datos, archivo);
  await persistirCarga(datos, archivo, hash, storageKey, extraccion, veredicto, ctx);

  return detalle(soat.id, ctx);
}

const docDe = (archivo: ArchivoSubido, umbral: number): DocumentoAAnalizar => ({
  nombreArchivo: archivo.originalname, contentType: archivo.mimetype, contenido: archivo.buffer, umbral,
});

// ─────────────────────────── Carga masiva ────────────────────────────────────

export interface ItemCarga { archivo: string; placa: string | null; soatId: string | null; detalle: string }
export interface ResultadoCargaMasiva {
  pagados: ItemCarga[]; enRevision: ItemCarga[]; duplicados: ItemCarga[]; noAsociados: ItemCarga[];
}

/**
 * SOAT en adquisición que cruce por placa o VIN, respetando la frontera del gestor. Devuelve también
 * lo necesario para archivar (compañía) y el umbral del proveedor.
 */
async function buscarEnAdquisicion(placa: string | null, vin: string | null, ctx: SoatCtx): Promise<DatosCarga | null> {
  if (!placa && !vin) return null;
  const llave: ReturnType<typeof sql>[] = [];
  if (placa) llave.push(sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) = ${normalizarLlave(placa)}`);
  if (vin) llave.push(sql`UPPER(${vehicles.vin}) = ${normalizarLlave(vin)}`);

  const conds = [
    eq(flitoSoat.estado, EstadoSoat.SOLICITADO),
    FRONTERA_AUTOGESTION_SOAT,
    or(...llave)!,
  ];
  if (esGestor(ctx)) {
    if (!ctx.proveedorSoatId) return null;
    // Misma frontera que la cola: un comprobante del gestor no cruza con lo que asumió Operaciones,
    // así que se informa como no asociado y ni siquiera se archiva.
    conds.push(eq(flitoSoat.gestionOperaciones, false));
    conds.push(eq(flitoSoat.proveedorSoatId, ctx.proveedorSoatId));
  }

  const [r] = await db.select({
    soatId: flitoSoat.id, vin: flitoSoat.vin, estado: flitoSoat.estado, placa: vehicles.plate,
    companiaId: clients.id, carpeta: clients.flitoCarpetaStorage,
    umbralOcr: flitoProveedoresSoat.umbralOcr,
  }).from(flitoSoat)
    .innerJoin(vehicles, eq(flitoSoat.vehiculoId, vehicles.id))
    .innerJoin(clients, eq(flitoSoat.companiaId, clients.id))
    .leftJoin(flitoProveedoresSoat, eq(flitoSoat.proveedorSoatId, flitoProveedoresSoat.id))
    .where(and(...conds)).limit(1);
  return r ? { ...r, estado: r.estado as EstadoSoat } : null;
}

/** Concurrencia del OCR en la carga masiva. Detalle de ejecución: no vive en shared-types. */
const OCR_CONCURRENCIA_CARGA_MASIVA = 5;

/**
 * Carga masiva de comprobantes. El gestor sube varios PDF/imágenes —o un ZIP— sin clasificar nada:
 * el OCR lee placa/VIN (o la placa del nombre del archivo como respaldo, §8.4) y cada comprobante se
 * cruza SOLO con un SOAT en adquisición. Los que cruzan y superan el umbral pasan a Pagado; los que
 * no, a revisión. Un comprobante que no cruza con ningún SOAT NO va a revisión (no hay contra qué
 * compararlo): se informa y no se guarda. Un archivo que falla no afecta a los demás.
 *
 * Fases (HU #12051): expandir ZIP en serie → hash CA-08 en serie (dup sin OCR) → OCR en pool de 5
 * → cruce + archivo + persistir en serie, orden de entrada.
 */
export async function cargarFacturasMasivo(archivos: ArchivoSubido[], ctx: SoatCtx): Promise<ResultadoCargaMasiva> {
  const res: ResultadoCargaMasiva = { pagados: [], enRevision: [], duplicados: [], noAsociados: [] };
  const expandidos = await expandir(archivos);

  const pendientes: { archivo: ArchivoSubido; hash: string }[] = [];
  const hashesVistos = new Set<string>();
  for (const archivo of expandidos) {
    try {
      const hash = createHash('sha256').update(archivo.buffer).digest('hex');
      if (hashesVistos.has(hash) || await facturaDuplicada(hash)) {
        res.duplicados.push({ archivo: archivo.originalname, placa: null, soatId: null, detalle: 'Ya cargada antes (mismo archivo).' });
        continue;
      }
      hashesVistos.add(hash);
      pendientes.push({ archivo, hash });
    } catch (e) {
      const msg = e instanceof SoatError ? e.message : 'Error procesando el archivo.';
      res.noAsociados.push({ archivo: archivo.originalname, placa: null, soatId: null, detalle: msg });
    }
  }

  const extraidos = await conConcurrencia(pendientes, OCR_CONCURRENCIA_CARGA_MASIVA, async (item) => {
    try {
      return { ...item, extraccion: await extraerFacturaSoat(docDe(item.archivo, umbralPara(null))) };
    } catch (error) {
      return { ...item, error };
    }
  });

  for (const item of extraidos) {
    try {
      if ('error' in item && item.error) throw item.error;
      const extraccion = 'extraccion' in item ? item.extraccion : undefined;
      if (!extraccion) throw new Error('Error procesando el archivo.');
      const placaLeida = extraccion[CampoSoat.PLACA]?.valor ?? placaDesdeNombre(item.archivo.originalname);
      const vinLeido = extraccion[CampoSoat.VIN]?.valor ?? null;

      const datos = await buscarEnAdquisicion(placaLeida, vinLeido, ctx);
      if (!datos) {
        // Se DESCARTA: ni archivo ni registro. Hubo una etapa en que se guardaba en una bandeja para
        // que un reintento lo cruzara al aparecer el SOAT, y se retiró por decisión de negocio —los
        // comprobantes huérfanos se acumulaban sin llegar a cruzar—. Lo que queda es el aviso, con la
        // placa leída, para poder volver a subirlo cuando el SOAT exista.
        res.noAsociados.push({ archivo: item.archivo.originalname, placa: placaLeida, soatId: null,
          detalle: 'No cruza con ningún SOAT en adquisición. Se descarta: vuelve a cargarlo cuando el SOAT exista.' });
        continue;
      }

      const umbral = umbralPara(datos.umbralOcr);
      const veredicto = evaluarExtraccionSoat(extraccion, { vin: datos.vin, placa: datos.placa }, umbral);
      const storageKey = await archivarFactura(datos, item.archivo);
      await persistirCarga(datos, item.archivo, item.hash, storageKey, extraccion, veredicto, ctx);

      const fila: ItemCarga = { archivo: item.archivo.originalname, placa: datos.placa, soatId: datos.soatId, detalle: veredicto.aprobada ? 'Pagado.' : (veredicto.detalle ?? 'En revisión.') };
      (veredicto.aprobada ? res.pagados : res.enRevision).push(fila);
    } catch (e) {
      const msg = e instanceof SoatError ? e.message : 'Error procesando el archivo.';
      res.noAsociados.push({ archivo: item.archivo.originalname, placa: null, soatId: null, detalle: msg });
    }
  }
  return res;
}

/** Un ZIP es una caja: se abre y se procesa cada archivo que trae (PDF/imagen). */
async function expandir(archivos: ArchivoSubido[]): Promise<ArchivoSubido[]> {
  const salida: ArchivoSubido[] = [];
  for (const archivo of archivos) {
    const esZip = archivo.mimetype.includes('zip') || archivo.originalname.toLowerCase().endsWith('.zip');
    if (!esZip) { salida.push(archivo); continue; }

    const zip = await JSZip.loadAsync(archivo.buffer);
    for (const entrada of Object.values(zip.files)) {
      if (entrada.dir) continue;
      if (entrada.name.startsWith('__MACOSX/')) continue;
      const base = entrada.name.split('/').pop() || entrada.name;
      if (base.startsWith('.')) continue;
      const buffer = Buffer.from(await entrada.async('nodebuffer'));
      const lower = base.toLowerCase();
      const mimetype = lower.endsWith('.pdf') ? 'application/pdf'
        : /\.(jpg|jpeg)$/.test(lower) ? 'image/jpeg'
        : lower.endsWith('.png') ? 'image/png'
        : 'application/octet-stream';
      salida.push({ originalname: base, mimetype, buffer, size: buffer.length });
    }
  }
  return salida;
}

// ─────────────────────────── Reintento de pendientes ─────────────────────────

