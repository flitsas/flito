// Helper para registrar accesos a PII en pii_access_log (Ley 1581 art. 17).
// Append-only por trigger SQL. Best-effort: no aborta la operación principal.
//
// Llamar desde endpoints que LEAN datos cifrados (cedula, licencia, runt_payload,
// titular_pago_cuenta, etc.). El handler decide qué campos lista en `camposAccedidos`.

import net from 'node:net';
import type { Request } from 'express';
import { db } from '../db/client.js';
import { piiAccessLog } from '../db/schema.js';
import { loggerFor } from './logger.js';
import { esUuid } from './utils/uuid.js';

const log = loggerFor('pii-audit');

export interface PiiAuditOpts {
  resourceTipo: string;
  resourceId?: number | null;
  accion: 'read' | 'export' | 'decrypt' | 'search';
  camposAccedidos: string[];
  motivo?: string;
}

/** Ancho de `pii_access_log.ip_origen` (`varchar(45)`, mig. 0059). El INSERT no trunca: valida. */
const IP_ORIGEN_MAX = 45;

/** La IP si `valor` es una IPv4/IPv6 que CABE en la columna; si no, `null`. */
function ipValida(valor: unknown): string | null {
  if (typeof valor !== 'string' || valor.length > IP_ORIGEN_MAX) return null;
  return net.isIP(valor) !== 0 ? valor : null;
}

/** El primer elemento de un `X-Forwarded-For` —el más cercano al cliente—, solo si es una IP. */
function primeraIpValida(cabecera: unknown): string | null {
  // Una cabecera repetida NO llega como `string[]`: Node une los valores con `", "` y entrega un
  // string (`set-cookie` es la única que llega en array). Medido por socket crudo, no supuesto. Así
  // que el `split` de aquí ya cubre ese caso; el `String()` se queda como cast defensivo para las
  // peticiones que no vienen de un socket real (un cron que fabrica `req`, un test).
  return ipValida(String(cabecera ?? '').split(',')[0]?.trim());
}

export async function logPiiAccess(req: Request, opts: PiiAuditOpts): Promise<void> {
  try {
    // Bug #11622 (2.º hallazgo) — `ip_origen` es `varchar(45)` en la DDL real (mig. 0059), y aquí se
    // leía la cabecera CRUDA sin acotar ni validar. Es la misma cadena que el `request_id`, dos
    // líneas más arriba y con el mismo final: un `X-Forwarded-For` de 46 caracteres o más deja un
    // primer elemento de 46, el INSERT usa cast de ASIGNACIÓN —que a diferencia del cast explícito
    // NO trunca—, PostgreSQL responde 22001 y el `catch` de abajo se lo traga. Otra vez la fila
    // entera perdida, otra vez desde una cabecera que el cliente elige.
    //
    // `trust proxy = 1` no cubría nada de esto: lo que se leía era el header, no `req.ip`. Y con el
    // `$proxy_add_x_forwarded_for` habitual, nginx ANTEPONE lo que mandó el cliente, así que el
    // primer elemento es exactamente el valor bajo su control.
    //
    // ── De ahí el ORDEN, que es una corrección aparte y de otra naturaleza ──────────────────────
    //
    // Ese mismo hecho tiene una segunda consecuencia que el código anterior no sacaba: si el XFF es
    // `<lo que mandó el cliente>, <IP que añadió el proxy>`, entonces preferir `XFF[0]` es preferir
    // el único elemento falsificable de la lista. `X-Forwarded-For: 8.8.8.8` bastaba para que la
    // columna del art. 17 dijera `8.8.8.8` teniendo la IP real a mano. Eso no es perder la fila: es
    // FALSIFICARLA, y un registro de acceso que miente sobre desde dónde se consultó es peor que
    // uno que falta, porque nadie sabe que hay que desconfiar de él.
    //
    // Por eso se prefiere `req.ip`, que con `trust proxy = 1` es el ÚLTIMO elemento del XFF —el que
    // puso el proxy— y no el primero. Medido: `XFF: "8.8.8.8, 203.0.113.7"` → `req.ip` es
    // `203.0.113.7`.
    //
    // **`req.ip` no es inviolable, y no se promete que lo sea.** Sin un proxy real delante,
    // `trust proxy = 1` hace que Express se crea el XFF que mandó el cliente y `req.ip` acaba
    // siendo su valor (medido: `XFF: "8.8.8.8"` → `req.ip` es `8.8.8.8`). Lo que se afirma es más
    // modesto: detrás de nginx —el despliegue real— `req.ip` es fidedigno y `XFF[0]` no lo es
    // nunca, así que la inversión mejora ese caso y no empeora el otro, donde los dos candidatos
    // son igual de falsificables y los dos pasan por `ipValida`.
    //
    // Se VALIDA la forma en vez de recortar a 45. Un `.slice(0, 45)` también cierra el 22001, pero
    // dejaría entrar 45 caracteres de texto arbitrario del cliente en una columna de auditoría
    // legal, que es un problema peor que el que resuelve: `ip_origen` respondería «desde dónde se
    // consultó» con lo que al consultante le apeteciera escribir. La cota de longitud se conserva
    // ADEMÁS de la forma, y no por redundancia: el porqué está medido cuatro párrafos más abajo.
    //
    // `req.ip` se valida también, y no por simetría: con `trust proxy` activo Express lo deriva del
    // propio XFF y el paquete `forwarded` no comprueba que cada elemento sea una IP, así que un
    // cliente que llegue sin proxy delante puede colocar basura ahí igual. En producción, detrás de
    // nginx, `req.ip` es el `remote_addr` que añadió el proxy y sobrevive a esta validación.
    //
    // **La cota de 45 no es redundante con `net.isIP`, y comprobarlo importaba.** En Node 24
    // `net.isIP('fe80::1%eth0')` devuelve 6, no 0: acepta IPv6 con zona, y el identificador de zona
    // NO tiene límite de longitud —`fe80::1%` + 60 caracteres también da 6, medido aquí—. Validar
    // solo la forma habría dejado el 22001 abierto exactamente por donde se cerraba, con una
    // cabecera igual de fácil de mandar. La zona sí está acotada en charset (Node rechaza espacios,
    // comillas y `<`), así que con la cota de longitud lo que entra es IP-forme y cabe.
    //
    // Se comprueba la longitud ANTES que la forma: es lo barato y acota lo que se le pasa a `isIP`.
    const xff = ipValida(req.ip) ?? primeraIpValida(req.headers['x-forwarded-for']) ?? null;
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 500);
    // Bug #11622 — `request_id` es una columna `uuid`: lo que no lo sea entra como NULL.
    //
    // La causa se corrige en el middleware de `app.ts`, que ya descarta la cabecera que no sea un
    // UUID. Esto es el cinturón sobre los tirantes y se queda aquí a propósito: `logPiiAccess` es
    // el único punto por el que se escribe la tabla que sostiene el art. 17 de la Ley 1581, lo
    // llaman tres módulos desde 15 sitios, y `req` puede no venir de la cadena de `createApp` (un
    // router montado aparte, un cron que fabrica una petición, un test). Sin este saneo, cualquiera
    // de esos caminos vuelve a provocar el 22P02 que borraba la fila entera en silencio.
    //
    // El guarda anterior era `typeof requestId === 'string'`, y **filtraba menos de lo que parecía**.
    // La versión anterior de este comentario decía que atajaba el `string[]` de una cabecera
    // repetida; es falso, y conviene dejarlo escrito porque la conclusión cambia: Node NO entrega
    // arrays para cabeceras repetidas —une los valores con `", "`— y solo `set-cookie` es la
    // excepción. Medido por socket crudo: `X-Request-Id: a` + `X-Request-Id: b` llega como el
    // string `"a, b"`, que pasaba `typeof === 'string'` tan campante y aterrizaba en una columna
    // `uuid`. Es decir, la cabecera repetida era un 22P02 vivo más, no un caso ya cubierto.
    //
    // `esUuid` lo cierra por la forma, no por el tipo (aunque comprueba el tipo primero, que es lo
    // que mantiene a salvo el `string[]` de una petición fabricada a mano). Perder el id de
    // correlación es una molestia; perder la fila es un incumplimiento.
    const requestIdCrudo = req.headers['x-request-id'] || (req as any).id || null;
    const requestId = esUuid(requestIdCrudo) ? requestIdCrudo : null;
    if (requestIdCrudo !== null && requestId === null) {
      // Sin volcar el valor: es texto que controla el cliente y este log no es sitio para él.
      log.warn({ resource: opts.resourceTipo }, 'x-request-id no es UUID — se registra el acceso con request_id NULL');
    }
    await db.insert(piiAccessLog).values({
      userId: req.user?.sub ?? null,
      userRole: req.user?.role ?? null,
      resourceTipo: opts.resourceTipo,
      resourceId: opts.resourceId ?? null,
      accion: opts.accion,
      camposAccedidos: opts.camposAccedidos,
      motivo: opts.motivo ?? null,
      ipOrigen: xff,
      userAgent: ua,
      requestId,
    });
  } catch (e: any) {
    // PENDIENTE DE DECISIÓN (negocio/legal, no técnica) — hoy esto FALLA ABIERTO: si el registro de
    // acceso no se puede escribir, la operación principal continúa y los datos personales se
    // entregan igual, con una línea de log como toda constancia. La alternativa —negarse a entregar
    // PII cuando el rastro no se puede escribir— es una decisión de David y no se toma aquí.
    //
    // Para que esa decisión se tome sobre datos ciertos, lo que este bug cerró y lo que NO:
    //
    //   · CERRADO — las tres vías por las que un usuario autenticado podía provocar el fallo a
    //     voluntad, y por tanto suprimir su propio rastro, todas por cabecera: `X-Request-Id`
    //     no-UUID (22P02), la MISMA cabecera repetida —que Node une en `"a, b"` y el guarda viejo
    //     dejaba pasar— y `X-Forwarded-For` de más de 45 caracteres (22001).
    //   · RESIDUAL CONOCIDO, y no es de infraestructura ni lo cierra este bug: `user_id` tiene una
    //     FK viva contra `users(id)` (`pii_access_log_user_id_fkey`, sin `ON DELETE`). Un token
    //     válido y sin expirar de un usuario cuya fila se borró en duro da 23503 y se pierde la
    //     misma fila, en silencio y por el mismo `catch`. No lo provoca quien consulta, pero
    //     tampoco es una caída de la base: es un estado alcanzable de los datos.
    //   · NO AUDITADO — el resto de causas de fallo del INSERT. Las otras columnas se revisaron y
    //     están acotadas en el código de HOY (`motivo` se recorta a 200 en
    //     `flito-comparendos.pii.ts`), pero nada del TIPO lo garantiza: `resourceTipo` y `accion`
    //     son `string` en `PiiAuditOpts` —igual que `recurso` en `AccesoComparendos`— y no uniones
    //     de literales, contra columnas `varchar(50)` y `varchar(20)`. Un llamador futuro que pase
    //     ahí un valor largo reabre exactamente este agujero sin que el compilador diga nada.
    //   · QUEDA FUERA de lo que nadie controla desde una petición: caída de la base, pool agotado.
    //     El trigger append-only NO entra en esta lista: `tr_pii_access_log_append` es
    //     `BEFORE UPDATE OR DELETE` (mig. 0059) y no tiene rama de INSERT, así que no puede
    //     rechazar una escritura. Estaba nombrado aquí por inercia y era una causa imposible.
    //
    // Un matiz sobre `user_agent`, que es `text` y por tanto no tiene el problema de longitud: su
    // inmunidad al byte NUL —que PostgreSQL rechaza en cualquier `text` con un 22021— no la pone
    // este código sino llhttp, el parser de Node, que descarta la petición entera si una cabecera
    // lleva `0x00`. Hoy no hay ningún `insecureHTTPParser` en el repo (verificado); si alguien lo
    // activara, `user_agent` pasa a ser vector y esta línea deja de ser cierta.
    //
    // O sea: hoy ya no se conoce ninguna forma de que un usuario provoque esto desde una cabecera,
    // pero «no se conoce ninguna» no es «no la hay» —el 23503 de arriba es un ejemplo de algo que
    // sigue vivo por otra puerta—, y la diferencia importa para elegir entre abierto y cerrado.
    log.error({ err: e?.message, resource: opts.resourceTipo }, 'fallo escribiendo pii_access_log');
  }
}
