// Siigo API — crear en Siigo el producto que le falta a un concepto (HU #11286, Feature #11240).
//
// Sin esto, quien parametriza tiene que salir a la interfaz de Siigo, crear el producto a mano y
// volver a copiar el código a FLITO. Copiar códigos a mano entre dos sistemas es exactamente donde
// aparecen los errores que la HU #11283 tuvo que ponerse a detectar.
//
// Vive en archivo propio y no dentro de `mapeo-conceptos.service.ts` por una razón mecánica: la
// orquestación necesita el servicio de productos Y el del mapeo, y el del mapeo ya importa el de
// productos. Meterla ahí crearía un ciclo; ponerla aquí, que importa a los dos, no.
//
// Cuatro decisiones que conviene no revertir sin pensarlo:
//
//   1. **Se BUSCA antes de crear** (AC2). El catálogo de productos de la empresa lo comparten otras
//      áreas: el código puede existir ya. Crear a ciegas produciría un `already_exists` en el mejor
//      caso y un duplicado en el peor.
//   2. **Crear no se reintenta solo.** No es idempotente: un reintento automático sobre un timeout
//      que sí llegó a Siigo crea el producto dos veces. El reintento lo pide un humano, y como se
//      busca antes de crear, ese reintento es seguro y termina vinculando.
//   3. **El producto nace con el tratamiento tributario del mapeo** (AC3), no con valores por
//      defecto. Y por eso se exige que el mapeo ya lo tenga declarado: `account_group` es INMUTABLE
//      en Siigo una vez que el producto tiene movimiento, así que un producto creado con la
//      clasificación equivocada no se arregla, se abandona.
//   4. **La confirmación de contabilidad NO se marca sola** (AC4). Crear el producto es un acto
//      técnico; firmar que su tratamiento tributario es correcto es un acto contable. Que lo
//      primero implicara lo segundo vaciaría de sentido toda la HU #11282.

import {
  CLASIFICACION_TRIBUTARIA_SIIGO,
  CODIGO_PRODUCTO_SIIGO_RE,
  CONCEPTO_FACTURABLE_LABEL,
  codigoSugeridoDeConcepto,
  type ClasificacionTributaria,
  type ConceptoFacturable,
  type DatosCreacionProducto,
  type ResultadoCreacionProducto,
} from '@operaciones/shared-types';
import { leerCatalogo } from './siigo.catalogos.service.js';
import { actualizarMapeo, obtenerMapeo, SiigoMapeoError } from './mapeo-conceptos.service.js';
import { modoSiigo } from './siigo.mock.js';
import { registrarOperacion } from './siigo.operaciones.repo.js';
import {
  consultarProductoPorCodigo, crearProducto, motivoLegible,
  type SiigoProductoNuevoApi,
} from './siigo.productos.service.js';
import type { SiigoAmbiente } from './credenciales.service.js';

/** Nombre por defecto del producto: la etiqueta legible del concepto. */
function nombrePorDefecto(concepto: ConceptoFacturable): string {
  return CONCEPTO_FACTURABLE_LABEL[concepto] ?? concepto;
}

/**
 * Mapeos con una creación en curso.
 *
 * Entre buscar y crear hay una ventana: dos peticiones simultáneas sobre el mismo concepto pasan
 * las dos por «no existe» y crean las dos. Con el mismo código nos salva la unicidad de Siigo; con
 * códigos distintos se materializan DOS productos reales en el catálogo, y los productos de Siigo
 * no se borran. El limitador por hora no frena la concurrencia: frena el volumen.
 *
 * En proceso y no en Redis por la misma razón que en `revalidarMapeo`: `ecosystem.config.cjs` no
 * declara `instances`, así que PM2 corre una sola instancia. **Si se pasa a cluster o a réplicas,
 * esto deja de bastar** y hay que moverlo a un lock distribuido.
 */
const creacionesEnCurso = new Set<string>();

/** Solo para tests y para el arranque, igual que `reiniciarRevalidaciones`. */
export function reiniciarCreacionesEnCurso(): void {
  creacionesEnCurso.clear();
}

/**
 * AC3 — El grupo de inventario sale del catálogo sincronizado y tiene que estar ACTIVO.
 *
 * Se comprueba antes de salir a la red: es una lectura local y evita gastar una petición de la
 * cuota para que Siigo rechace lo que ya sabíamos. Y se exige activo porque `account_group` es
 * inmutable una vez que el producto tiene movimiento — crear con un grupo inactivo deja un producto
 * que no se puede arreglar.
 */
async function exigirGrupoInventario(codigo: string, ambiente: SiigoAmbiente): Promise<number> {
  const catalogo = await leerCatalogo('account_group', { incluirInactivos: true, ambiente });

  if (catalogo.elementos.length === 0) {
    throw new SiigoMapeoError('datos',
      'El catálogo de grupos de inventario no está sincronizado en este ambiente. Sincronízalo '
      + 'desde la parametrización antes de crear productos.');
  }

  const encontrado = catalogo.elementos.find((e) => e.codigo === codigo);
  if (!encontrado) {
    throw new SiigoMapeoError('datos',
      `El grupo de inventario ${codigo} no está en el catálogo sincronizado. Elige uno de la lista.`);
  }
  if (!encontrado.activo) {
    throw new SiigoMapeoError('datos',
      `El grupo de inventario «${encontrado.nombre}» está inactivo en Siigo. Como no se puede `
      + 'cambiar una vez que el producto tiene movimiento, hay que elegir uno activo.');
  }

  const id = Number(codigo);
  if (!Number.isInteger(id) || id <= 0) {
    throw new SiigoMapeoError('datos',
      `El grupo de inventario ${codigo} no tiene un identificador numérico válido para Siigo.`);
  }
  return id;
}

/**
 * Crea en Siigo el producto de un concepto y lo vincula al mapeo (AC1-AC7).
 *
 * Devuelve `vinculado_existente` sin crear nada cuando el código ya correspondía a un producto de
 * Siigo. Ese camino es además la red de seguridad del reintento: si la creación tuvo éxito pero la
 * vinculación falló —por ejemplo porque Siigo tardó en indexar el producto recién creado—, volver a
 * pedir la creación encuentra el producto y lo vincula, en vez de duplicarlo.
 */
export async function crearProductoDeConcepto(
  mapeoId: string, datos: DatosCreacionProducto, usuarioId: number,
): Promise<ResultadoCreacionProducto> {
  if (creacionesEnCurso.has(mapeoId)) {
    throw new SiigoMapeoError('en_curso',
      'Ya hay una creación de producto en curso para este concepto. Espera a que termine: dos a la '
      + 'vez pueden crear dos productos distintos en el catálogo de Siigo, y allí no se borran.');
  }
  creacionesEnCurso.add(mapeoId);
  try {
    return await crearProductoDeConceptoInterno(mapeoId, datos, usuarioId);
  } finally {
    creacionesEnCurso.delete(mapeoId);
  }
}

async function crearProductoDeConceptoInterno(
  mapeoId: string, datos: DatosCreacionProducto, usuarioId: number,
): Promise<ResultadoCreacionProducto> {
  const arranque = Date.now();
  const mapeo = await obtenerMapeo(mapeoId);
  const ambiente = mapeo.ambiente;
  const modo = modoSiigo();

  const codigo = datos.codigo ?? codigoSugeridoDeConcepto(mapeo.concepto);
  const nombre = datos.nombre ?? nombrePorDefecto(mapeo.concepto);

  // La historia es «el producto que le FALTA a un concepto». Sin estas dos guardas, un POST sobre
  // un concepto ya vinculado con un código distinto crea un producto nuevo y deja el anterior
  // HUÉRFANO en el catálogo de la empresa — y en Siigo los productos no se borran, solo se
  // desactivan. Es el único efecto de esta HU que no tiene vuelta atrás.
  //
  // Cambiar de producto sigue siendo posible: se hace con el PATCH del mapeo, que no crea nada.
  if (!mapeo.activo) {
    throw new SiigoMapeoError('no_editable',
      'Esa configuración del concepto está desactivada. Crear un producto real para una fila que '
      + 'ningún flujo va a usar dejaría un residuo permanente en el catálogo de Siigo.');
  }
  if (mapeo.codigoProducto !== null && mapeo.codigoProducto !== codigo) {
    throw new SiigoMapeoError('no_editable',
      `El concepto ya está vinculado al producto ${mapeo.codigoProducto}. Crear otro dejaría el `
      + 'anterior huérfano en el catálogo de Siigo, donde no se puede borrar. Si quieres cambiar de '
      + 'producto, edita el código del mapeo; si el nuevo no existe todavía, créalo desde un '
      + 'concepto sin vincular.');
  }

  /** Bitácora de esta operación (AC6). Nunca lanza: no puede tumbar el resultado del negocio. */
  const bitacora = (
    resultado: 'ok' | 'error_negocio' | 'error_tecnico',
    mensaje: string,
    extra: { statusHttp?: number | null; codigo?: string | null; responseBody?: unknown } = {},
  ) => registrarOperacion({
    operacion: 'siigo.producto.crear',
    metodo: 'POST',
    ruta: '/v1/products',
    entidadTipo: 'siigo_mapeo_concepto',
    entidadId: mapeoId,
    ambiente,
    modo,
    requestBody: { code: codigo, name: nombre, account_group: datos.grupoInventarioCodigo },
    resultado,
    mensaje,
    duracionMs: Date.now() - arranque,
    createdBy: usuarioId,
    ...extra,
  });

  // AC1 — el código es alfanumérico, sin espacios y de máximo treinta. Se valida igual venga
  // sugerido o editado por quien parametriza: la validación no depende de quién lo escribió.
  if (!CODIGO_PRODUCTO_SIIGO_RE.test(codigo)) {
    const mensaje = 'El código de producto de Siigo debe ser alfanumérico (admite punto, guion y '
      + 'guion bajo), sin espacios y de máximo 30 caracteres.';
    await bitacora('error_negocio', mensaje);
    throw new SiigoMapeoError('datos', mensaje);
  }

  // AC3 — sin clasificación tributaria no se crea. `account_group` y el tratamiento tributario son
  // lo que hace útil al producto, y crear uno mal clasificado no se corrige: se abandona.
  if (mapeo.clasificacionTributaria === null) {
    const mensaje = 'El concepto no tiene clasificación tributaria declarada. Configúrala antes de '
      + 'crear el producto: nace con ella y corregirla después obliga a crear otro producto.';
    await bitacora('error_negocio', mensaje);
    throw new SiigoMapeoError('datos', mensaje);
  }

  const grupoId = await exigirGrupoInventario(datos.grupoInventarioCodigo, ambiente)
    .catch(async (e: unknown) => {
      await bitacora('error_negocio', e instanceof Error ? e.message : String(e));
      throw e;
    });

  // AC2 — buscar ANTES de crear.
  let existente;
  try {
    existente = await consultarProductoPorCodigo(codigo, ambiente);
  } catch (e) {
    const mensaje = `No se pudo comprobar si el producto ${codigo} ya existe en Siigo: `
      + `${motivoLegible(e)}. No se creó nada; vuelve a intentarlo cuando Siigo responda.`;
    await bitacora('error_tecnico', mensaje);
    throw new SiigoMapeoError('no_verificable', mensaje);
  }

  if (existente.existe && !existente.activo) {
    // Vincular un producto inactivo dejaría el mapeo marcado como inválido por la HU #11283 en la
    // siguiente lectura. Mejor decirlo ahora que dejar que lo descubra la validación.
    const mensaje = `El producto ${codigo} ya existe en Siigo pero está INACTIVO. Actívalo en Siigo `
      + 'Nube o elige otro código.';
    await bitacora('error_negocio', mensaje);
    throw new SiigoMapeoError('validacion', mensaje);
  }

  let desenlace: ResultadoCreacionProducto['desenlace'];
  let nombreFinal: string | null;

  if (existente.existe) {
    // AC2 — no se duplica: se vincula el que ya está.
    desenlace = 'vinculado_existente';
    nombreFinal = existente.nombre;
  } else {
    const cuerpo: SiigoProductoNuevoApi = {
      code: codigo,
      name: nombre,
      account_group: grupoId,
      // Lo que FLITO factura son servicios y derechos de trámite, no inventario. Un producto con
      // control de existencias exigiría movimientos de bodega que aquí no existen.
      type: 'Service',
      stock_control: false,
      active: true,
      // AC3 — el tratamiento tributario del mapeo viaja en la creación.
      tax_classification:
        CLASIFICACION_TRIBUTARIA_SIIGO[mapeo.clasificacionTributaria as ClasificacionTributaria],
      taxes: mapeo.impuestos.map((i) => ({ id: i.id })),
      ...(mapeo.unidadMedida === null ? {} : { unit: mapeo.unidadMedida }),
    };

    try {
      const creado = await crearProducto(cuerpo, ambiente);
      desenlace = 'creado';
      nombreFinal = typeof creado?.name === 'string' ? creado.name : nombre;
      await bitacora('ok', `Producto ${codigo} creado en Siigo.`, { responseBody: creado });
    } catch (e) {
      // AC5 — el rechazo de Siigo se traduce a lenguaje operativo con el campo señalado.
      // `motivoLegible` ya devuelve `descripcionOperativa`, que incluye «Campo: x» cuando Siigo
      // lo dice. Y el mapeo NO se toca: sigue exactamente como estaba.
      const mensaje = `Siigo rechazó la creación del producto ${codigo}: ${motivoLegible(e)}`;
      await bitacora('error_negocio', mensaje);
      throw new SiigoMapeoError('validacion', mensaje);
    }
  }

  // AC4 — crear y vincular en un solo paso. Se pasa por `actualizarMapeo` a propósito y no se
  // escribe la fila a mano: así el cambio de código de producto tumba la confirmación de
  // contabilidad como manda el AC4 de la HU #11282, y queda el mismo rastro que cualquier otra
  // edición. La confirmación NO se marca: crear no es firmar.
  try {
    // El nombre viene de Siigo sin acotar y la columna es `varchar(200)`: un producto preexistente
    // del catálogo compartido con nombre más largo produciría un 22001 crudo del motor, que es
    // justo el error cuyo mensaje no puede salir de aquí.
    const nombreAcotado = nombreFinal === null
      ? null
      : [...nombreFinal].slice(0, 200).join('');
    await actualizarMapeo(mapeoId, { codigoProducto: codigo, nombreProducto: nombreAcotado }, usuarioId);
  } catch (e) {
    // La creación en Siigo ya ocurrió; solo falló la vinculación. Se dice tal cual —y no «no se
    // pudo crear»— porque reintentar es seguro: la búsqueda previa encontrará el producto.
    //
    // `motivoLegible` y NO `e.message`: `actualizarMapeo` relanza en crudo todo lo que no sea una
    // violación de unicidad, y desde drizzle 0.45 ese mensaje es `Failed query: … params: …` con la
    // sentencia y sus valores dentro. Este texto se devuelve al cliente, así que ponerlo tal cual
    // reintroduciría exactamente la fuga que la HU #11281 tuvo que remediar.
    const detalle = e instanceof SiigoMapeoError ? e.message : motivoLegible(e);
    const mensaje = desenlace === 'creado'
      ? `El producto ${codigo} SÍ se creó en Siigo, pero no se pudo vincular al concepto: `
        + `${detalle}. Vuelve a intentarlo: no se duplicará.`
      : `No se pudo vincular el producto ${codigo} al concepto: ${detalle}`;
    await bitacora('error_tecnico', mensaje);
    throw new SiigoMapeoError('no_verificable', mensaje);
  }

  const mensaje = desenlace === 'creado'
    ? `Producto ${codigo} creado en Siigo y vinculado al concepto.`
    : `El producto ${codigo} ya existía en Siigo: se vinculó al concepto sin crear uno nuevo.`;

  if (desenlace === 'vinculado_existente') await bitacora('ok', mensaje);

  return { desenlace, codigo, nombre: nombreFinal, ambiente, modo, mensaje };
}
