// Siigo — enviar a facturación electrónica y consultar la cola (HU #11328, Feature #11242).
// Montado en /api/siigo/facturacion.
//
// **Es la primera ruta del programa que un humano puede pulsar para que salga una factura.** Nada de
// esta Feature se ha probado nunca contra Siigo real —no hay `access_key` de pruebas— y `SIIGO_MODE`
// está en `mock` por defecto. Todo lo que hay debajo (armado, emisión, cola, trabajador) existía sin
// disparador; aquí se conecta. Por eso las guardas van primero y no como comentario al final.
//
// CUATRO INVARIANTES, Y LOS CUATRO SE COMPRUEBAN POR MUTACIÓN EN LOS TESTS
//
//   1. **El ambiente sale de `env.SIIGO_AMBIENTE` y NUNCA del cuerpo.** No es una simplificación: si
//      el cliente pudiera elegirlo, una pantalla de pruebas podría emitir en producción, y una
//      factura aceptada por la DIAN no se deshace. El esquema es `.strict()` para que intentarlo
//      falle con un 400 ruidoso en vez de ignorarse en silencio — un campo ignorado deja al que
//      llama convencido de que se le hizo caso.
//   2. **Quién emite lo decide UNA constante compartida** (AC6): `ROLES_POR_ACCION.emitir` en
//      `@operaciones/shared-types`. Esta ruta no sabe qué roles son; pide `exigirAccionSiigo`.
//      La lectura del estado es `consultar`, que sí incluye a `auditor`: mirar la cola es auditar,
//      llenarla no. (La HU pedía una constante nueva `ROLES_EMISION_FE` en `permissions.ts`; no se
//      creó y el porqué está escrito en `siigo-permisos.ts`, junto a la que ya existía: dos
//      definiciones de «quién puede emitir» es exactamente lo que el AC6 quiere evitar.)
//   3. **Con el freno puesto no se encola** (503). Llenar una cola que nadie va a vaciar no ayuda:
//      deja a quien envió creyendo que hay trabajo en marcha, y al operador con una cola que crece
//      mientras diagnostica. Consultar el estado sí se permite: es justo lo que hace falta mirar.
//   4. **Un trámite rechazado no impide que los demás se encolen** (AC1). El servicio devuelve un
//      desenlace por trámite y la ruta responde 202 con el desglose entero, también cuando ninguno
//      entró. Un 4xx global por un trámite malo obligaría a facturar de uno en uno.
//
// **202 y no 201**, y no es cosmético: cuando esta ruta contesta no existe ninguna factura todavía.
// Lo que existe es una fila de cola. Un 201 con `Location` prometería un documento que quizá nunca
// llegue a emitirse, y quien integre lo iría a buscar.
//
// Las guardas van como middleware ANTES del handler, nunca dentro: así una ruta nueva que se olvide
// de la guarda se nota leyendo el `router.<verbo>`.

import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { SiigoDestinatario, SiigoRespuestaEnvio } from '@operaciones/shared-types';
import { CONCEPTOS_FACTURABLES, SIIGO_ENVIO_MAX_DESTINATARIOS } from '@operaciones/shared-types';
import { env } from '../../config/env.js';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { frenoConRastro, makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { loggerFor } from '../../shared/logger.js';
import { exigirAccionSiigo, registrarAccionSiigo } from './siigo.permisos.js';
import { colaDeTramites, SiigoColaError } from './facturacion.cola.service.js';
import { enviarAFacturacion, TOPE_TRAMITES_ENVIO } from './facturacion.encolado.service.js';
import { emisionRecordada } from './emision-cliente.repo.js';
import { SiigoIntegracionFrenadaError } from './siigo.freno.service.js';

const router = Router();
router.use(authMiddleware);

const log = loggerFor('siigo-facturacion');

/** Emitir es una acción de operación: `auditor` queda fuera. La tabla lo decide, no esta línea. */
const EMISION = exigirAccionSiigo('emitir');

/**
 * Reactivar lo que el sistema ya dio por perdido tiene su propia acción en el catálogo, y por eso
 * tiene aquí su propia guarda.
 *
 * Hoy `emitir` y `reactivar` resuelven a la misma lista de roles, así que no cambia nada — pero esa
 * coincidencia es de hoy. La pregunta 16 sigue abierta, y el día que alguien restrinja `reactivar` a
 * administración, esta ruta seguiría dejando reactivar a cualquiera con `emitir` si el permiso se
 * dedujera de la acción equivocada. Es la misma trampa de «dos definiciones» que el AC6 evita para
 * `emitir`; no tiene sentido evitarla ahí y caer en ella una línea más abajo.
 */
const REACTIVACION = exigirAccionSiigo('reactivar');
/** Ver en qué punto está la cola es lectura, y la lectura sí llega hasta auditoría. */
const LECTURA = exigirAccionSiigo('consultar');

/**
 * Limitador del envío. Mucho más estrecho que el de las consultas del módulo, y con motivo: cada
 * petición puede crear hasta 200 lotes con sus filas de cola, y todo lo que entre en la cola acabará
 * saliendo a Siigo contra una cuota de 100 peticiones por minuto que se comparte con todo lo demás.
 * Un cliente en bucle no produciría facturas duplicadas —lo impiden los índices— pero sí llenaría la
 * cola de trabajo que el trabajador tardaría horas en vaciar.
 */
const envioLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  keyGenerator: userOrIpKey('siigo-envio-facturacion'),
  message: { error: 'Demasiados envíos seguidos. Espera un momento antes de volver a enviar.' },
  // El 429 deja rastro (HU #11299). Con el limitador delante de la guarda, quien insiste sin
  // permiso deja de escribir en la bitácora a partir del tope — que es lo que se buscaba — pero
  // también dejaba de aparecer en ningún sitio. `frenoConRastro` cuenta el freno y anota la llave.
  handler: frenoConRastro('siigo-envio-facturacion'),
  store: makeStore('rl:siigo-envio-facturacion:'),
});

/** El de consulta, por paridad con el resto del módulo: la pantalla refresca y quien concilia pagina. */
const consultaLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  keyGenerator: userOrIpKey('siigo-cola-consulta'),
  message: { error: 'Demasiadas consultas seguidas. Espera un momento.' },
  store: makeStore('rl:siigo-cola-consulta:'),
});

/**
 * El cuerpo del envío. **`.strict()` a propósito**: un `{"ambiente":"produccion"}` colado aquí se
 * rechaza con un 400 en vez de ignorarse. Ignorarlo también sería seguro —el ambiente sale del
 * servidor pase lo que pase— pero dejaría al que llama creyendo que eligió, que es peor.
 */
const envioSchema = z.object({
  tramiteIds: z.array(z.string().uuid()).min(1).max(TOPE_TRAMITES_ENVIO),
  // A1 — qué se factura viaja explícito y SIN valor por omisión. Un default aquí («todos los
  // aplicables», que es lo que hacía antes) convertiría el olvido de un cliente en una factura ante
  // la DIAN con conceptos que nadie pidió, y eso no se deshace.
  conceptos: z.array(z.enum(CONCEPTOS_FACTURABLES)).min(1).max(CONCEPTOS_FACTURABLES.length),
  // A2 — la emisión elegida, una entrada por empresa. OPCIONAL, y aquí sí con motivo: su ausencia
  // cae a la configuración global vigente, que es una configuración explícita que alguien guardó y
  // con la que se venía emitiendo. No es lo mismo que el default de `conceptos`, que habría sido
  // deducir de la liquidación algo que nadie eligió.
  emision: z.array(z.object({
    clienteId: z.number().int().positive(),
    documentoTipoCodigo: z.string().trim().max(60).nullable(),
    vendedorCodigo: z.string().trim().max(60).nullable(),
    formaPagoCodigo: z.string().trim().max(60).nullable(),
    centroCostoCodigo: z.string().trim().max(60).nullable(),
  })).max(TOPE_TRAMITES_ENVIO).optional(),
  // Reactivar lo dado por perdido es una decisión de quien opera, no un efecto secundario de
  // reenviar: por eso viaja explícito y apagado por omisión (AC3).
  reactivar: z.boolean().optional(),
  /**
   * HU #11708 — si la factura sale por correo al cliente y a qué direcciones.
   *
   * **Opcional, y su ausencia significa que NO se pidió** (AC2). Antes de esta historia el correo lo
   * decidía el ambiente y en producción salía siempre; ahora hay que pedirlo. Que la ausencia
   * apague el correo en vez de romper la petición con un 400 es deliberado: el daño de que un
   * cliente no reciba el correo se repara con un reenvío —que existe y sigue igual (AC6)—, y además
   * no pasa desapercibido, porque la emisión deja acta `no_realizado` diciendo que no se solicitó.
   * El daño de un 400 sería que no se factura nada.
   *
   * `destinatarios` vacío o ausente = las direcciones de la ficha del cliente. Se validan aquí Y en
   * la emisión, que es donde el AC5 las pide: esta ruta no es el único camino al lote —el cron emite
   * lo que el lote diga— y la ficha puede cambiar entre el envío y la emisión. Lo de aquí es lo que
   * permite decirle a quien escribe una dirección mal que la escribió mal, en vez de contárselo
   * media hora después en un acta.
   *
   * El mensaje del rechazo lo escribe Zod con la POSICIÓN del campo y nunca su valor (Ley 1581):
   * `.email()` no imprime lo que rechaza. Ninguna dirección puede acabar en un log de errores.
   */
  correo: z.object({
    enviar: z.boolean(),
    destinatarios: z.array(z.string().trim().email().max(150))
      .max(SIIGO_ENVIO_MAX_DESTINATARIOS)
      .optional(),
  }).strict().optional(),
}).strict();

const consultaSchema = z.object({ tramiteIds: z.string().trim().min(1) });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST / — encola la selección. Responde 202 con el desenlace de cada trámite.
 *
 * El orden importa y es este: permiso → limitador → validación → servicio → rastro → respuesta. El
 * rastro se escribe SIEMPRE que el servicio devuelve, aunque no se haya encolado ni un trámite
 * (AC7): «quién pidió facturar qué» es la pregunta que se hace después, cuando algo salió mal, y
 * entonces ya no se puede reconstruir. Va a dos sitios que nadie puede editar ni borrar —la
 * auditoría general y la bitácora del módulo—, así que se conserva aunque la emisión falle después:
 * son tablas distintas de la cola y de las facturas, y ningún desenlace posterior las toca.
 */
/**
 * `reactivar: true` exige además el permiso de reactivar. Condicional y no siempre, porque el envío
 * normal —el que se usa cada día— no reactiva nada y no debe pedir un permiso que no ejerce.
 *
 * Que sea condicional no lo hace inocuo para el freno: cuando dispara, delega en `REACTIVACION`,
 * que es otro `exigirAccionSiigo` y por tanto escribe su propia fila `permiso_denegado` en la
 * bitácora WORM. Es la segunda escritura de esta ruta, y por eso el limitador va delante de las
 * DOS y no entre ellas.
 */
function exigirReactivar(req: Request, res: Response, next: NextFunction): void {
  if ((req.body as { reactivar?: unknown } | undefined)?.reactivar !== true) { next(); return; }
  REACTIVACION(req, res, next);
}

/**
 * **El limitador va ANTES de las dos guardas**, y el orden es la corrección, no el estilo (deuda de
 * seguridad del PR #194, cerrada en la segunda tanda de la HU #11299).
 *
 * Con `EMISION` delante, cada intento sin permiso se resolvía en 403 sin que el limitador llegara a
 * contarlo, y `exigirAccionSiigo` escribe una fila `permiso_denegado` en `siigo_operaciones` por
 * cada uno. Esa tabla es append-only por disparador (HU #11251): lo que entra ahí no se borra ni se
 * rectifica. Un autenticado cualquiera —con rol de consulta— podía meter así las ~500 filas que le
 * permitiera `apiLimiter` cada quince minutos en una bitácora que nadie puede podar.
 *
 * **Y va antes también de `exigirReactivar`, que es lo que esta ruta tiene de distinto**: son tres
 * middlewares, no dos, y el del medio TAMBIÉN escribe cuando deniega —delega en `REACTIVACION`, que
 * es otra guarda del mismo catálogo—. Poner el limitador en medio (`EMISION, envioLimiter,
 * exigirReactivar`) habría tapado una de las dos escrituras y dejado la otra abierta, que es medio
 * arreglo con aspecto de arreglo entero. El limitador va primero porque lo que se está acotando no
 * es «pedir facturar», es «cuántas veces puede un mismo usuario hacer que el servidor escriba en
 * una tabla que no se puede podar», y las dos guardas escriben.
 *
 * Gastar cuota antes de comprobar el permiso es exactamente lo que se quiere aquí: la cuota se
 * lleva por usuario (`userOrIpKey`), así que quien insiste sin permiso se frena a sí mismo y no a
 * quien factura. Y el desperdicio no existe: una petición denegada NO es gratis para el sistema
 * —cuesta una fila WORM—, así que cobrarla es contabilizar el coste real, no castigar un error.
 *
 * No debilita nada: los 403 los siguen dando las mismas guardas sobre el mismo rol del JWT, en el
 * mismo orden entre ellas, y el limitador no mira el cuerpo ni ejecuta el handler.
 */
router.post('/', envioLimiter, EMISION, exigirReactivar, async (req: Request, res: Response) => {
  const parsed = envioSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }
  const { tramiteIds, conceptos, emision, reactivar, correo } = parsed.data;
  const usuarioId = req.user?.sub ?? null;

  // `manual` porque eso es lo que son: direcciones que escribió una persona en el diálogo de envío.
  // La procedencia se guarda con cada una para que el acta distinga después lo que salió de la ficha
  // de lo que alguien tecleó — que es la diferencia entre «el cliente lo tiene mal en su ficha» y
  // «quien envió se equivocó al escribirlo». Las de la ficha no llegan por aquí: llegan por no
  // elegir ninguna, y las resuelve `resolverDestinatarios` en el momento de emitir.
  //
  // **Con la casilla apagada no se guarda ninguna**, aunque vengan en el cuerpo: una pantalla que
  // conserva lo escrito mientras se desmarca la casilla es lo normal, y guardarlas significaría
  // meter datos personales en el lote para un correo que nadie va a mandar. Ley 1581, principio de
  // minimización: el dato que no hace falta no se recoge.
  const solicitado = correo?.enviar === true;
  const destinatarios: SiigoDestinatario[] = solicitado
    ? (correo?.destinatarios ?? []).map((c) => ({ correo: c, origen: 'manual' as const }))
    : [];

  let salida: SiigoRespuestaEnvio;
  try {
    salida = await enviarAFacturacion({
      tramiteIds,
      conceptos,
      emision,
      correo: { solicitado, destinatarios },
      // AQUÍ, y en ningún otro sitio. El cuerpo no participa en esta línea.
      ambiente: env.SIIGO_AMBIENTE,
      usuarioId,
      reactivar,
    });
  } catch (e) { fallo(res, e); return; }

  await dejarRastro(req, tramiteIds, salida);
  res.status(202).json(salida);
});

/**
 * GET /?tramiteIds=a,b,c — en qué punto está la cola de esos trámites.
 *
 * Por lista y no por trámite: la pantalla que muestre el estado pinta una tabla, y una llamada por
 * fila serían doscientas peticiones para dibujarla.
 *
 * Un trámite que no aparece en la respuesta es un trámite sin fila de cola —nunca se encoló, o se
 * facturó por la vía directa—, no un hueco. Devolver una entrada vacía por cada uno obligaría a
 * distinguir dos formas de «nada».
 */
router.get('/', LECTURA, consultaLimiter, async (req: Request, res: Response) => {
  const parsed = consultaSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Falta la lista de trámites' });
    return;
  }
  const ids = parsed.data.tramiteIds.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length > TOPE_TRAMITES_ENVIO) {
    res.status(400).json({
      error: `Se pueden consultar como máximo ${TOPE_TRAMITES_ENVIO} trámites por petición.`,
    });
    return;
  }
  // El formato se comprueba AQUÍ y no se deja caer en el motor. Un `?tramiteIds=abc` llega al
  // `::uuid[]` de la consulta, PostgreSQL lanza un 22P02 y drizzle lo envuelve con la sentencia y
  // sus parámetros dentro — que el manejador de errores vuelca al log sin sanear. Un 400 dice lo
  // mismo, no ensucia el registro y no gasta un viaje a la base. El POST ya lo validaba con Zod;
  // esto es la mitad que faltaba.
  if (!ids.every((id) => UUID_RE.test(id))) {
    res.status(400).json({ error: 'Alguno de los identificadores de trámite no es válido.' });
    return;
  }

  res.json({ ambiente: env.SIIGO_AMBIENTE, items: await colaDeTramites(env.SIIGO_AMBIENTE, ids) });
});

/**
 * AC7 — quién envió y sobre qué trámites.
 *
 * Dos registros y no uno, porque responden a dos preguntas y las hacen dos personas distintas: la
 * auditoría general (`audit_logs`) es la que consulta cumplimiento —usuario, IP, cuándo—, y la
 * bitácora del módulo (`siigo_operaciones`) es la que consulta quien diagnostica una emisión, junto
 * al resto de operaciones de la misma factura. `audit` y `registrarOperacion` se tragan sus errores:
 * perder el rastro es malo, pero convertir un envío correcto en un 500 por un fallo de bitácora lo
 * es más.
 *
 * La lista de trámites va en el `detail` cuando no cabe en `resource_id` (50 caracteres, dos UUID ya
 * no caben) — de eso se encarga `audit` sola, y es la razón de pasarle la lista y no una cuenta.
 *
 * **No lanza nunca**, y el `try` no sobra aunque las dos funciones ya se traguen sus errores: para
 * cuando esto corre, la cola YA tiene las filas dentro. Un fallo aquí que se convirtiera en 500
 * haría creer a quien envió que no se encoló nada, y lo normal entonces es volver a pulsar — sobre
 * un trabajo que ya está en marcha. El rastro es importante; deshacer una respuesta correcta por
 * perderlo, no.
 */
async function dejarRastro(
  req: Request, tramiteIds: string[], salida: SiigoRespuestaEnvio,
): Promise<void> {
  const r = salida.resumen;
  const detalle = `Envío a facturación electrónica (${salida.ambiente}): ${r.total} trámites · `
    + `${r.encolados} encolados · ${r.yaEstaban} ya estaban · ${r.rechazados} rechazados`;

  try {
    await audit(req, {
      action: 'create',
      resource: 'siigo_cola_facturacion',
      resourceId: tramiteIds.join(','),
      detail: detalle,
    });
    await registrarAccionSiigo(req, 'emitir', {
      entidadTipo: 'siigo_cola',
      // El identificador de la operación es el trámite cuando es uno solo; con una selección no hay
      // una entidad única que señalar y se deja nulo antes que inventar una.
      entidadId: tramiteIds.length === 1 ? tramiteIds[0]! : null,
      statusHttp: 202,
      codigo: `encolados=${r.encolados};rechazados=${r.rechazados}`,
      mensaje: detalle,
    });
  } catch (e) {
    // Se registra en el log del servidor —que es lo que vigila la alerta de ISO 27001— y se sigue.
    log.error({ err: (e as Error).message, trazas: tramiteIds.length }, 'rastro de envío fallido');
  }
}

/**
 * Traduce los fallos de dominio a HTTP.
 *
 * El freno es **503 y no 409**: no es que la petición esté mal, es que el servicio de abajo no está
 * disponible ahora mismo y se podrá reintentar cuando alguien lo reactive. Un 4xx haría creer a
 * quien integra que tiene que cambiar lo que envía.
 *
 * Lo que no reconoce se relanza: un error inesperado tiene que llegar al manejador global y salir
 * como 500 con su traza, no disfrazarse de rechazo de negocio.
 */
function fallo(res: Response, e: unknown): void {
  if (e instanceof SiigoIntegracionFrenadaError) {
    res.status(503).json({
      error: e.message, codigo: 'integracion_frenada', freno: e.estado,
    });
    return;
  }
  if (e instanceof SiigoColaError) {
    res.status(e.codigo === 'sin_tramites' ? 400 : 409).json({ error: e.message, codigo: e.codigo });
    return;
  }
  throw e;
}

/**
 * GET /emision — lo último que se usó con cada cliente (A2).
 *
 * Lo consume el diálogo de envío para precargar una fila por empresa. Los clientes sin memoria
 * simplemente no salen, y la pantalla cae a la configuración global, que es la semilla.
 *
 * Guarda de LECTURA y no de emisión: preguntar con qué se facturó la última vez no factura nada.
 */
router.get('/emision', LECTURA, consultaLimiter, async (req: Request, res: Response) => {
  const parsed = z.object({ clienteIds: z.string().trim().min(1) }).safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }
  const ids = parsed.data.clienteIds.split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0 || ids.length > TOPE_TRAMITES_ENVIO) {
    res.status(400).json({ error: `Indica entre 1 y ${TOPE_TRAMITES_ENVIO} clientes.` });
    return;
  }

  res.json({ items: await emisionRecordada(env.SIIGO_AMBIENTE, ids) });
});

export default router;
