import rateLimit, { Options, ipKeyGenerator, type RateLimitInfo } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { getRedis } from '../redis.js';
import type { Request, Response } from 'express';
import { loggerFor } from '../logger.js';
import { rateLimitBloqueadoTotal } from '../metrics.js';

// Helper: keyGenerator que prefiere userId si está autenticado, sino normaliza IP (IPv6 /64).
// Sin esta normalización, atacantes con IPv6 pueden bypassear los límites cambiando los bits bajos.
export function userOrIpKey(prefix: string) {
  return (req: Request): string => {
    const userId = (req as Request & { user?: { sub?: string } }).user?.sub;
    if (userId) return `${prefix}-${userId}`;
    return `${prefix}-${ipKeyGenerator(req.ip ?? '')}`;
  };
}

// Si Redis está disponible, usamos su store para rate limit distribuido entre instancias.
// Si no, fallback al store in-memory por defecto de express-rate-limit.
export function makeStore(prefix: string): Options['store'] | undefined {
  const r = getRedis();
  if (!r) return undefined;
  return new RedisStore({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendCommand: (...args: string[]) => (r.call as any)(...args),
    prefix,
  });
}

const logFreno = loggerFor('rate-limit');

/**
 * Handler de 429 que además deja rastro: un `warn` con la llave y un punto en el contador.
 *
 * ── Por qué existe (HU #11299) ─────────────────────────────────────────────────────────────────
 *
 * La corrección de seguridad de esa HU puso los limitadores del módulo `siigo/` DELANTE de las
 * guardas de permiso, porque una denegación escribe en `siigo_operaciones` y esa tabla es
 * append-only: sin limitador por delante, un autenticado sin permiso podía inundar una bitácora que
 * nadie puede podar. El intercambio es el correcto, pero abrió un punto ciego: a partir del intento
 * 61, el mismo actor recibe 429 y ya NO deja la fila `permiso_denegado`. Y el 429 no era observable
 * por ningún lado —`metrics.ts` no expone estados HTTP y el handler por defecto de
 * `express-rate-limit` no escribe nada—, así que quien insistía se volvía invisible exactamente
 * cuando pasaba a ser interesante. Frenar a un atacante sin verlo es media defensa.
 *
 * Se cierra con los dos mecanismos que el repo ya tiene, cada uno con lo que sabe hacer:
 *
 *   · **El contador** (`rate_limit_bloqueado_total`, etiquetado por limitador) responde «¿cuánto?»
 *     y es lo que se grafica y lo que dispara una alerta. No lleva llave ni ruta: serían series sin
 *     techo de cardinalidad.
 *   · **El log** responde «¿quién?». La llave del limitador es `<prefijo>-<sub>` para un
 *     autenticado, y ese `sub` es el identificador interno del usuario en `users` — que es
 *     justamente lo que hace falta para cruzarlo con `audit_logs` y con la bitácora del módulo.
 *
 * **Nada de datos personales**, y no por costumbre: `logger` no redacta lo que no reconoce, y aquí
 * el 429 puede venir de una petición cuya query trae un documento o una placa. Por eso se escribe
 * la llave y NO el correo, y por eso la ruta va sin query string. Un log de frenos que copiara la
 * consulta sería una copia sin control de aquello que el resto de esta HU se ha dedicado a acotar.
 *
 * Responde igual que el handler por defecto —mismo estado y mismo cuerpo, tomados de `options`—
 * para que añadir el rastro no cambie ni una respuesta.
 */
export function frenoConRastro(limitador: string): Options['handler'] {
  return (req: Request, res: Response, _next, options) => {
    // `key`, `limit` y `used` los deja el propio middleware en `req.rateLimit`; el tipo no está
    // declarado en el `Request` de Express, de ahí el ensanchado local (igual que en `userOrIpKey`).
    const info = (req as Request & { rateLimit?: RateLimitInfo }).rateLimit;
    rateLimitBloqueadoTotal.inc({ limitador });
    logFreno.warn({
      limitador,
      // La llave, no el usuario: lleva el `sub` y nunca el correo ni el nombre.
      llave: info?.key ?? null,
      metodo: req.method,
      // Sin query string: ahí es donde viajan el documento y la placa.
      ruta: (req.originalUrl || req.url || '').split('?')[0]!.slice(0, 300),
      limite: info?.limit ?? null,
      intentos: info?.used ?? null,
    }, 'Limitador activado: peticion rechazada con 429');
    if (!res.writableEnded) res.status(options.statusCode).send(options.message);
  };
}

// General API rate limit: 500 requests per 15 min per IP
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes, intente de nuevo mas tarde' },
  store: makeStore('rl:api:'),
});

// Auth endpoints: 10 attempts per 15 min per IP (brute force protection)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de autenticacion, espere 15 minutos' },
  store: makeStore('rl:auth:'),
});

// GET /metrics: 120 requests / 15 min / IP (Bug #11599). La ruta vive FUERA de `/api`, así
// que `apiLimiter` nunca la cubrió; ahora que porta autenticación, la regla 18 de AGENTS.md
// pide freno propio. No es contención de costo —`metricsAuth` rechaza antes de llamar a
// `registry.metrics()`, no hay amplificación— sino techo a la fuerza bruta contra el token.
// 120/15min deja holgura al scrape legítimo de Prometheus (60 con el intervalo por defecto
// de 15s) incluso con dos scrapers apuntando a la misma instancia.
export const metricsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('metrics:'),
  message: { error: 'Demasiadas solicitudes' },
  store: makeStore('rl:metrics:'),
});

// QR público RNDC: 60 requests / 15 min / IP. Anti-enumeración del token.
export const qrPublicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas consultas, espere unos minutos' },
  store: makeStore('rl:qr:'),
});

// PESV upload evidencia: 50 uploads / 15 min / usuario (o IP si no auth).
// BELK B3 (sprint rediseño PHVA): contención contra cuenta comprometida que
// intente llenar bucket MinIO en minutos. 50/15min es generoso para uso normal
// del líder PESV (típicamente 24×N evidencias en sesiones de horas).
export const pesvUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('pesv-up:'),
  message: { error: 'Demasiadas evidencias subidas. Espere 15 minutos.' },
  store: makeStore('rl:pesv-up:'),
});

/**
 * Canal Cliente de SOAT: 20 peticiones / 15 min / usuario (Feature #11912, HU #11914, AC5).
 *
 * ── Por qué el canal necesita freno propio, y no le basta el `apiLimiter` ───────────────────────
 *
 * `apiLimiter` es 500/15min POR IP y está pensado para una plantilla que trabaja desde la oficina.
 * Estas rutas son otra cosa: las llama un principal EXTERNO —el primer rol que entra desde fuera de
 * la operación— y cada llamada gasta algo que se paga fuera: una consulta al RUNT por pasarela y,
 * en el alta, una subida de hasta 15 MB a MinIO más una escritura en cinco tablas. Una cuenta de
 * cliente comprometida podía quemar 500 consultas al RUNT y llenar el bucket antes de que nadie
 * mirara.
 *
 * **Son DOS rutas desde la HU #12214** —`POST /cliente/preconsulta` y `POST /cliente`—, y conviene
 * decir cuál se fue y por qué, porque entre la #12092 y la #12214 este párrafo enumeraba TRES:
 * `POST /cliente/factura/lectura` colgaba también de este contador y ya no. Manda el PDF a un
 * ENCARGADO EXTERNO de pago (el modelo que hace el OCR), no consulta el RUNT, no escribe ninguna
 * fila, y cada relectura le quitaba presupuesto al envío de la misma solicitud que estaba
 * prellenando. Tiene contador propio: {@link soatLecturaFacturaLimiter}.
 *
 * ── Por qué UN contador compartido para estas dos, y no uno por ruta ────────────────────────────
 *
 * Comparten llave (`soat-cliente:<sub>`), así que comparten contador, y eso es lo que se busca: el
 * flujo real es preconsultar y radicar —2 peticiones por solicitud—, así que 20 son diez solicitudes
 * en quince minutos, muy por encima de lo que una persona teclea. Un contador por ruta le daría a
 * cada una su presupuesto entero y multiplicaría el techo del canal sin que nadie lo decidiera.
 *
 * Que la lectura saliera de aquí NO es un contraejemplo de esa regla, es su otra mitad: las dos que
 * quedan gastan el MISMO recurso escaso —la ficha del RUNT, que es lo que se puede cosechar—, y por
 * eso tienen que competir por un solo presupuesto. La lectura no consulta el RUNT ni crea filas: su
 * riesgo es de coste y es suyo, así que se raciona aparte. El techo agregado del canal sube de 20 a
 * 32 peticiones por ventana, y hay que decirlo sin adornos. Lo que NO sube es este presupuesto: el
 * compartido sigue en 20 y de él siguen saliendo las que tocan el RUNT y las que escriben.
 *
 * **Cuidado con leer eso como «la exposición al RUNT no cambia», porque sí cambia** —y no por este
 * contador, sino por el de al lado—: el vinculante para la preconsulta nunca fueron los 20, era su
 * sub-límite, y ese pasa de 8 a 15. Las consultas al registro por usuario y ventana casi se doblan.
 * Está medido y escrito donde toca, en el docblock de {@link soatPreconsultaLimiter}.
 *
 * ── LO QUE ESTE PÁRRAFO DECÍA Y ERA FALSO DESDE LA HU #12090 ────────────────────────────────────
 *
 * Decía que 20/15min está «muy por debajo de lo que sirve para enumerar placas contra el RUNT».
 * Cuando se escribió era cierto por una razón que ya no existe: **enumerar era imposible a cualquier
 * ritmo**, porque la consulta exigía el documento del propietario (Bug #11927) y el RUNT no
 * respondía si ese documento no figuraba entre los propietarios activos del vehículo. El límite no
 * era lo que impedía la cosecha; era el requisito de conocer al titular.
 *
 * Desde la #12090 la consulta va SOLO por VIN y ese requisito desapareció: cualquiera que conozca un
 * VIN obtiene la ficha. **El limitador pasó de ser una contención de coste a ser la única barrera de
 * ritmo entre una cuenta `cliente` y la cosecha de una flota ajena.** Y los números, dichos sin
 * adornos, porque el párrafo viejo daba a entender un margen que no hay:
 *
 *   · `userOrIpKey` cuenta POR USUARIO, no por compañía: una compañía con N usuarios dispone de 20N
 *     peticiones por ventana.
 *   · 20/15min = 80/hora ≈ 1 920/día por usuario.
 *   · Los VIN de una flota comparten las 11 primeras posiciones y difieren en un serial consecutivo,
 *     así que una flota de 200 vehículos son ~200 peticiones: **unas 2,5 h** a ese ritmo.
 *
 * Por eso la preconsulta gana ADEMÁS un sub-límite propio: {@link soatPreconsultaLimiter}.
 *
 * `userOrIpKey` y no la IP pelada: el canal es autenticado y varios usuarios de la misma compañía
 * salen por la misma IP corporativa. Frenar por IP castigaría a la compañía por lo que hace una
 * cuenta.
 */
export const soatClienteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('soat-cliente:'),
  handler: frenoConRastro('soat-cliente'),
  message: { error: 'Demasiadas solicitudes de SOAT. Espera unos minutos e intenta de nuevo.' },
  store: makeStore('rl:soat-cliente:'),
});

/**
 * Sub-límite SOLO de `POST /cliente/preconsulta`: 15 / 15 min / usuario (HU #12090, bloqueante 3;
 * el techo sube de 8 a 15 en la HU #12214).
 *
 * ── Anidado, no paralelo ────────────────────────────────────────────────────────────────────────
 *
 * Va DETRÁS de {@link soatClienteLimiter} en la cadena de la ruta, así que un intento que este
 * middleware rechace ya ha consumido su punto del contador compartido. Eso es deliberado y es lo que
 * conserva la decisión ya razonada de arriba: la preconsulta **no** recibe un presupuesto propio que
 * se sume a los 20, recibe un techo MÁS BAJO dentro de ellos. Sondear sigue gastando el presupuesto
 * del canal, y las altas siguen teniendo sitio: con 15 preconsultas quedan ≥5 peticiones para las
 * que sí crean una fila.
 *
 * Ese margen es más estrecho que el de antes (con 8 quedaban ≥12) y no se disimula: quien agote las
 * 15 se queda con cinco altas en la ventana. Se acepta por dos razones medibles en el propio código.
 * (a) El flujo legítimo es 1:1, así que quien gasta 15 preconsultas está REINTENTANDO, no radicando
 * quince veces; con el flujo 1:1 el techo efectivo del canal sigue siendo diez solicitudes. (b) Desde
 * esta misma HU la lectura de factura ya no cuelga del contador compartido, así que esos 20 se
 * reparten ahora entre DOS rutas y no entre tres: el presupuesto real del alta sube, no baja.
 *
 * ── Por qué 15, y qué compra ────────────────────────────────────────────────────────────────────
 *
 * El flujo legítimo es 1 preconsulta + 1 alta por solicitud. 15 preconsultas en quince minutos dejan
 * siete solicitudes con un reintento cada una —o cinco con dos reintentos, que es el caso del RUNT
 * caído, donde la pantalla invita a volver a consultar y cada intento gasta su punto igual—, muy por
 * encima de lo que una persona teclea en ese rato. Al otro lado de la cuenta: 15/15min = 60/hora, así
 * que la flota de 200 vehículos del párrafo de arriba pasa de **~2,5 h a ~3,3 h**.
 *
 * Ese ~3,3 h es la parte incómoda del cambio y va escrita a propósito: con 8 la misma flota costaba
 * ~6,3 h, así que subir a 15 devuelve poco más de la mitad del coste que el sub-límite le había
 * puesto a la cosecha. Se acepta porque el 8 frenaba también al usuario legítimo —los 429 que motivan
 * esta HU los emitía este middleware, nunca el RUNT— y porque el ritmo nunca fue lo que cierra esta
 * amenaza; lo que la cierra es que cada intento queda escrito.
 *
 * **No es una solución, es una cota, y conviene no venderla como otra cosa**: ningún límite por
 * ventana detiene a quien tiene paciencia. Lo que hace es (a) subir el coste, (b) dejar el intento
 * dentro de un presupuesto que la compañía también necesita para trabajar, y sobre todo (c)
 * garantizar que cada intento queda escrito — cada preconsulta deja su línea en `pii_access_log`
 * (`registrarAccesoRuntCliente`) y cada 429 deja un `warn` con la llave vía {@link frenoConRastro}.
 * La detección es lo que cierra lo que el ritmo no cierra.
 *
 * **El valor sigue siendo REVISABLE y se sigue eligiendo sin telemetría**: no hay medida de cuántas
 * preconsultas gasta de verdad una solicitud en producción. Ni el 8 ni el 15 salen de un percentil
 * observado; el 15 sale del flujo descrito arriba y del único dato que hay, que es cualitativo —429
 * intermitentes reportados por quien usa el canal—. Si el dato dijera que el uso legítimo roza el
 * techo, sube; si dijera que sobra holgura, baja. Lo que no puede volver es la justificación
 * anterior, que describía una amenaza que ya no es la real.
 *
 * Llave y store PROPIOS (`soat-preconsulta:`): con el prefijo del compartido, los dos limitadores
 * escribirían sobre el mismo contador y el más estricto ganaría para las dos rutas.
 */
export const soatPreconsultaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('soat-preconsulta:'),
  handler: frenoConRastro('soat-preconsulta'),
  message: { error: 'Demasiadas consultas al RUNT. Espera unos minutos e intenta de nuevo.' },
  store: makeStore('rl:soat-preconsulta:'),
});

/**
 * Límite PROPIO de `POST /cliente/factura/lectura`: 12 / 15 min / usuario (HU #12214).
 *
 * ── Aparte, no anidado: es lo contrario que la preconsulta y es a propósito ─────────────────────
 *
 * {@link soatPreconsultaLimiter} va DETRÁS del compartido porque lo que quiere es un techo más bajo
 * DENTRO de los 20. Aquí se pide justo lo contrario: que releer la factura no le quite presupuesto al
 * envío. Anidarla dejaría el problema intacto —cada relectura seguiría gastando un punto de los 20—,
 * así que la ruta sale del contador compartido y queda solo con este.
 *
 * Eso no rompe el razonamiento del párrafo vecino, lo delimita: aquel dice que las rutas que compiten
 * por el MISMO recurso escaso comparten presupuesto, y el recurso escaso del canal es la ficha del
 * RUNT —lo único cosechable—. La lectura no consulta el RUNT ni escribe ninguna fila; su PDF lo
 * adjuntó quien ya lo tenía y de él no sale ningún dato de un tercero. Sacarla no le abre a nadie ni
 * una consulta más al registro: las que tocan el RUNT siguen siendo 20, y de ellas HASTA 15 pueden
 * ser preconsulta —el sub-límite es un techo, no una cuota reservada: el reparto entre preconsulta y
 * alta lo decide el uso, y las 20 son el único total—.
 *
 * ── Por qué 12 ──────────────────────────────────────────────────────────────────────────────────
 *
 * Es la petición más cara del canal POR BYTE —hasta 15 MB a un encargado externo de pago— y a la vez
 * la que el usuario legítimo repite más: la HU #12092 la introdujo con relectura y sobrescritura
 * precisamente porque el OCR falla y se reintenta con el PDF re-exportado. Las dos cosas son ciertas,
 * y 12 es donde se cruzan: son cuatro solicitudes con TRES lecturas cada una (la buena más dos
 * relecturas) en quince minutos, o una sola solicitud con doce intentos si alguien se empeña con un
 * escaneo malo. Por encima de eso ya no se está prellenando un formulario.
 *
 * Comparado con sus dos vecinos, que es como se elige un número aquí: por debajo del canal (20)
 * porque cuesta más por petición, y por debajo de la preconsulta (15) porque su reintento es más
 * caro que el de una consulta al RUNT. Y aun así generoso frente al flujo real, que es UNA lectura
 * por solicitud: 12 son doce veces ese flujo.
 *
 * **Cota revisable y sin telemetría, igual que los otros dos**: no hay medida de cuántas relecturas
 * gasta de verdad una factura en producción. Si el dato dijera que el uso legítimo roza el techo,
 * sube; si dijera que sobra, baja. Lo que no se puede es quitarlo: el gasto lo dispara un principal
 * externo y lo paga FLITO por byte enviado.
 *
 * Llave y store PROPIOS (`soat-lectura:` / `rl:soat-lectura:`), distintos de los otros dos: con un
 * prefijo compartido los limitadores escribirían sobre el mismo contador y el `max` más estricto
 * ganaría para todas las rutas — que es exactamente lo que esta HU viene a deshacer.
 */
export const soatLecturaFacturaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('soat-lectura:'),
  handler: frenoConRastro('soat-lectura'),
  message: { error: 'Demasiadas lecturas de factura seguidas. Espera unos minutos e intenta de nuevo.' },
  store: makeStore('rl:soat-lectura:'),
});
