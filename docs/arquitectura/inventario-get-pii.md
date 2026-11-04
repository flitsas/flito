# Inventario de endpoints con PII en la URL

- **HU:** #13986 · **Feature:** #13977 · **Épica:** #13973
- **Fecha:** 2026-11-04, sobre el commit `65b20d5d` de la rama `FEATURE/13977-davidchica-inventario-get-pii`
- **Naturaleza:** auditoría. Sin código de producción y sin migrar ningún endpoint.
- **Decisiones:** [ADR-0036](../adr/ADR-0036-saneamiento-pii-en-urls.md), en estado Propuesto.
- **Regla auditada:** `AGENTS.md` §14.

## Resultado

**42 rutas de las 856 del API llevan PII, cuasi-PII o un token portador en la URL:** 19 de severidad Alta, 22 Media y 1 Baja. Las otras 814 quedan clasificadas sin hallazgo y no hay residuo.

**Ninguna ruta puede quedar hoy como excepción.** La mitigación 4 falla en todas, por el hallazgo T1: el nginx del contenedor web registra cada URL completa, con su query. Por eso los 10 grupos quedan con plan: 9 retiran el dato de la URL, y G10 conserva su ruta y solo retira su rastro del log.

| Severidad | Rutas | Grupos |
|---|---:|---|
| Alta | 19 | G1, G2, G4, G8, y la ruta pública de G7 |
| Media | 22 | G3, G5, G6, G9, y la ruta autenticada de G7 |
| Baja | 1 | G10 |

Además hay cuatro hallazgos en `apps/web` (tabla W) y un token persistido en base de datos por la telemetría RUM (T3).

## Hallazgos transversales

### T1. El nginx web registra la URL completa (hallazgo principal)

| Pieza | Evidencia |
|---|---|
| El contenedor web usa la imagen oficial | `apps/web/Dockerfile:31` (`FROM nginx:1.27-alpine`) y `:35` (copia la plantilla) |
| La plantilla no declara `access_log` ni `log_format` | `apps/web/nginx.conf.template`, archivo completo |
| Por eso hereda el formato `main`, que incluye `"$request"`: método, path y query | `/etc/nginx/nginx.conf:18` y `:22` de la imagen, leído de la imagen local con `docker run --network none` |
| Ese log va a stdout, y de ahí al log del pod | `/var/log/nginx/access.log -> /dev/stdout` en la misma imagen |
| El `/api/` del dominio web pasa por ese nginx, y es la vía de la propia web (`BASE = '/api'`). El dominio `api.*` lo salta y llega directo del proxy del host | `apps/web/nginx.conf.template:23` y `:46`; `.github/workflows/cd.yml:57-73` |
| Las páginas también: la SPA y `validar-identidad.html` | `apps/web/nginx.conf.template:100` |
| `main` también incluye `$http_referer`. Una petición hecha desde `validar-identidad.html?t=…` registró esa URL con el token en ese campo: ni las páginas ni la plantilla declaran `Referrer-Policy` | Probado por `security-agent` con `nginx:1.27-alpine` y la plantilla real |
| `error_log` no usa `log_format`: un 502 escribió `request: "GET /api/flito/soat?buscar=…"` | Probado por `security-agent` con la misma imagen y plantilla |

Consecuencia: cada `?buscar=`, `?q=`, `/privacy/preview/<documento>` y `/tramite/portal/<token>` que entra por el dominio web queda en claro en el stdout de ese contenedor. **Hay tres vías de escritura, no una:** `$request`, `$http_referer` y `error_log`, así que cambiar solo el formato no basta. Lo que entra por `api.*` no pasa por aquí: depende del proxy del host, que no está en este repo. Una configuración de `flit-gitops` podría sustituir la plantilla: no se revisó (ver «No cubierto»).

### T2. El API no tiene access log, pero sí registra el path en los errores y un enlace con token

| Punto | Qué registra | Efecto |
|---|---|---|
| `pino-http`, `morgan`, Sentry | No existen en `apps/api` ni en `apps/web` (búsqueda en código y `package.json`) | Bien: el proceso no escribe una línea por petición |
| `shared/logger.ts:11` | `REDACT_PATHS` solo cubre credenciales | No redacta `path` ni `ruta` |
| `shared/middleware/errorHandler.ts:61` (y `:11`, `:46`, `:53`) | `req.path`: sin query, con los parámetros de path | **Una ruta con PII en el path deja el valor en el log si falla con 500 o si responde 413** (`:11`, antes de llegar a la ruta). Ejemplo: `POST /api/validacion-identidad/completar/<token>` por encima de 15 MB (`app.ts:205`). `:46` y `:53` son guardas de PESV, sin PII en el path |
| `modules/tramites/identidad.routes.ts:308` | `log.warn({ tramiteId, motivo, link }, …)`: `link` es `validar-identidad.html?t=<token>`, y no está en `REDACT_PATHS` | **Si el correo no sale, el token queda en el log en claro.** Con él se obtienen nombre, documento y placa (`:463`) durante 24 h, y se puede intentar `completar` hasta 5 veces (`:470`, tope en `:482`). Pasar el token al fragmento (HU-I) no lo resuelve si se sigue registrando |
| `modules/tramites/validacion-recovery.ts:35` | Los primeros 8 caracteres del token, en la raíz del log | Nota: no abre nada |
| `shared/middleware/rateLimiter.ts:77` | `originalUrl` sin query, con parámetros de path | Mismo riesgo en cada limitador con `frenoConRastro`. Ninguno de los que protegen rutas de esta tabla lo usa hoy (`previewLimiter`, `qrPublicLimiter`, `publicLimiter`, `completarLimiter`, `downloadLimiter`) |
| `shared/middleware/exigir-funcion.ts:137` | Plantilla de la ruta o path enmascarado | Correcto: es el patrón a reutilizar |
| `modules/siigo/siigo.permisos.ts:85` | `originalUrl` sin query, con parámetros de path, en la bitácora de permisos | Sin efecto hoy: las rutas Siigo no llevan PII en el path |
| `modules/uso-legacy/uso-legacy.middleware.ts:8` | Solo el patrón de la ruta | Correcto |
| Llamadas de log con `req.query` | Ninguna (búsqueda en `apps/api/src`) | Correcto |

### T3. La telemetría RUM guarda tokens en la base

`apps/web/src/lib/rum.ts:53` envía `route: location.pathname`, se inicia en todas las páginas (`apps/web/src/main.tsx:14`) y `modules/rum/rum.routes.ts` lo guarda en `rum_web_vitals.route` sin normalizar. En `/tramite/portal/<token>` y `/m/<token>` el token queda en claro en esa tabla, y `GET /api/rum/summary` lo devuelve agrupado por ruta.

El portal guarda el token solo como hash a propósito (`modules/tramites/portal.ts:74-79`). RUM anula esa protección. El alcance depende del token:

- **Portal:** dura 24 h, así que las filas de más de un día ya no abren nada.
- **`/m/<token>`:** el TTL de 24 h no aplica: `modules/rndc/qr.routes.ts` no comprueba ninguna expiración.

Cada fila lleva además IP y agente de usuario (`rum.routes.ts`), se conserva 90 días (`modules/rum/purge.cron.ts:12`, activo en `server.ts:103`), y solo se reporta el 20 % de las sesiones (`lib/rum.ts:13`). Se deduce del código: la tabla no se consultó.

## Severidad: criterio

| Nivel | Criterio |
|---|---|
| **Alta** | Identificador personal directo (cédula, correo, teléfono) que puede viajar en la URL, o token portador que entrega esos datos, abre un documento que los contiene o permite escribir |
| **Media** | Cuasi-PII (placa, VIN, NIT, nombre), o token de solo lectura que revela solo cuasi-PII |
| **Baja** | Id opaco o firma de vida corta (5 minutos o menos), que se resuelve saneando el log |

Dos reglas de aplicación:

- **Texto libre:** la severidad es la de la columna más sensible contra la que busca, porque el usuario puede escribir ese dato. `/api/users?q` es Alta por el correo. Las búsquedas RNDC son Media porque solo comparan `nombre`, aunque la fila tenga documento.
- **Ajuste con evidencia:** la ruta pública de G7 sube a Alta aunque su URL solo lleve placa, porque el token no expira y el archivo es una cuenta de cobro con propietario y cédula.

## Inventario

**Cómo leer la columna 1.** El repo sustituyó `requireRole` por `exigirFuncion` y `requirePage` (ADR-0023), así que se toman como su equivalente. `:N` es la línea en el mismo archivo.

**Columna 4.** «nginx» es T1 y «`errorHandler`» es T2. El registro de `errorHandler` se da si la petición termina en 500 o en 413.

**Las filas POST son una ampliación** pedida en el encargo de esta auditoría, no en el AC: no son GET, pero su URL llega igual al log.

### G1. Cédula en el path (Alta)

| Endpoint | Módulo | Dato expuesto | Severidad | 1. Auth + autorización | 2. `logPiiAccess` en la lectura | 3. DTO sin payload crudo | 4. Sin URL en claro en logs |
|---|---|---|---|---|---|---|---|
| `GET /api/privacy/preview/:docNumber` | legacy `privacy` | Cédula o documento en el path | Alta | Sí: auth `modules/privacy/privacy.routes.ts:26`; `privacy.titulares.operar` `:455` | No | Sí: solo conteos por tabla (`privacy.routes.ts:504`) | No: nginx y `errorHandler` |

**Decisión:** retiro, HU-C. Es la pantalla de Habeas Data, y la operación hermana `POST /forget` ya usa el cuerpo.

### G2. Colas FLITO cuya búsqueda alcanza el documento (Alta)

| Endpoint | Módulo | Dato expuesto | Severidad | 1. Auth + autorización | 2. `logPiiAccess` en la lectura | 3. DTO sin payload crudo | 4. Sin URL en claro en logs |
|---|---|---|---|---|---|---|---|
| `GET /api/flito/soat` | `flito-soat` | `buscar`: placa, VIN, nombre, documento del propietario (`flito-soat.service.ts:527`) | Alta | Sí: auth `modules/flito-soat/flito-soat.routes.ts:46`; `soat.cola.ver` `:136` | Sí: `modules/flito-soat/flito-soat.pii.ts:199`, llamado desde `:136` | Sí: proyección de cola, sin payload RUNT | No: nginx |
| `GET /api/flito/impuestos` | `flito-impuestos` | `buscar`: placa, VIN, id FLIT, nombre, documento (`flito-impuestos.service.ts:281`) | Alta | Sí: auth `modules/flito-impuestos/flito-impuestos.routes.ts:61`; `impuestos.cola.ver` `:333` | Sí: `modules/flito-impuestos/flito-impuestos.pii.ts:170`, llamado desde `:333` | Sí: proyección de cola, sin payload | No: nginx |
| `GET /api/flito/tramites` | `flito-tramites` | `buscar`: id FLIT, placa, VIN, nombre, documento (`flito-tramites.service.ts:557`); `empresas`: NIT | Alta | Sí: auth `modules/flito-tramites/flito-tramites.routes.ts:39`; `tramites.cola.ver` `:83` | No | Sí: fila de tabla, sin payload | No: nginx |

**Decisión:** retiro, HU-D. ADR-0008 (Propuesto, línea 186) ya preveía retirar `buscar` del GET de SOAT en la #11915, y sigue ahí: `apps/web/src/pages/FlitoSoat.tsx:222` lo envía y `flito-soat.routes.ts:141` lo lee. Las exportaciones ya van por POST con cuerpo.

### G3. Colas y reportes con cuasi-PII (Media)

| Endpoint | Módulo | Dato expuesto | Severidad | 1. Auth + autorización | 2. `logPiiAccess` en la lectura | 3. DTO sin payload crudo | 4. Sin URL en claro en logs |
|---|---|---|---|---|---|---|---|
| `GET /api/flito/derechos` | `flito-derechos` | `buscar`: placa, id FLIT (`flito-derechos.service.ts:705`) | Media | Sí: auth `modules/flito-derechos/flito-derechos.routes.ts:31`; `derechos.cola.ver` `:101` | No | Sí: fila de tabla, sin payload | No: nginx |
| `GET /api/flito/logistica` | `flito-logistica` | `buscar`: id FLIT, placa, VIN; `empresas`: NIT (`flito-logistica.consulta.ts:79,102`) | Media | Sí: auth `modules/flito-logistica/flito-logistica.routes.ts:33`; `logistica.consola.ver` `:92` | No | Sí: fila de tabla, sin payload | No: nginx |
| `GET /api/finanzas/reporte-costos` | legacy `finanzas` | `buscar`: id FLIT, placa, VIN; `empresas`: NIT (`finanzas.service.ts:424,435`) | Media | Sí: auth `modules/finanzas/finanzas.routes.ts:29`; `finanzas.reporte_costos.ver` `:108` | Sí: `modules/finanzas/finanzas.routes.ts:63`, llamado desde `:108` | Sí: DTO de reporte, sin payload. Entrega nombre, documento y contacto | No: nginx |
| `GET /api/finanzas/reporte-costos/consolidado` | legacy `finanzas` | Mismos filtros de la query | Media | Sí: auth `modules/finanzas/finanzas.routes.ts:29`; `finanzas.reporte_costos.ver` `:143` | No | Sí: solo empresa y cifras | No: nginx |
| `GET /api/finanzas/reporte-costos/facturacion-electronica` | legacy `finanzas` | Mismos filtros de la query | Media | Sí: auth `modules/finanzas/finanzas.routes.ts:29`; `finanzas.reporte_costos.ver` `:130` | No | Sí: solo contadores | No: nginx |
| `GET /api/finanzas/gastos-diarios` | legacy `finanzas` | `empresas`: NIT | Media | Sí: auth `modules/finanzas/finanzas.routes.ts:29`; `finanzas_gastos_diarios` `:160` | No | Sí: días, cantidades y totales | No: nginx |

**Decisión:** retiro, HU-E.

### G4. Búsquedas legacy que alcanzan identidad (Alta)

| Endpoint | Módulo | Dato expuesto | Severidad | 1. Auth + autorización | 2. `logPiiAccess` en la lectura | 3. DTO sin payload crudo | 4. Sin URL en claro en logs |
|---|---|---|---|---|---|---|---|
| `GET /api/vehicles` | legacy `vehicles` | `search`: VIN, placa, nombre y documento del propietario (`vehicles.routes.ts:155`) | Alta | Sí: auth `modules/vehicles/vehicles.routes.ts:94`; `vehicles.vehiculos.consultar` `:112` | No | Parcial: select explícito sin payload; entrega documento en claro | No: nginx |
| `GET /api/drivers` | legacy `drivers` | `q`: nombre, usuario, cédula (`drivers.routes.ts:75`) | Alta | Sí: auth `modules/drivers/drivers.routes.ts:16`; `pesv_conductores` `:68` | No | Parcial: sin payload; descifra cédula y licencia de hasta 500 filas | No: nginx |
| `GET /api/laft/counterparties` | legacy `laft` | `search`: nombre, número de documento (`counterparties.routes.ts:90`) | Alta | Sí: auth `modules/laft/counterparties.routes.ts:18`; `laft.contrapartes.operar` `:71` | No | No: `db.select()` de la fila completa (`counterparties.routes.ts:95`) | No: nginx |
| `GET /api/users` | legacy `users` | `q`: usuario, nombre, correo (`users.service.ts:753`) | Alta | Sí: auth `modules/users/users.routes.ts:210`; `usuarios.usuario.listar` `:493` | No | Sí: `userSelect`, sin hash ni payload | No: nginx |
| `GET /api/users/export` | legacy `users` | `q`: usuario, nombre, correo; descarga por GET | Alta | Sí: auth `modules/users/users.routes.ts:210`; `usuarios.usuario.exportar` `:221` | No | Sí: filas de `userSelect` | No: nginx |
| `GET /api/users/resumen` | legacy `users` | `q`: usuario, nombre, correo | Alta | Sí: auth `modules/users/users.routes.ts:210`; `usuarios.usuario.ver_resumen` `:263` | No | Sí: solo conteos | No: nginx |

**Decisión:** retiro de los filtros de la URL, HU-F. Dos puntos van aparte, por decisión de David Chica:

- **`GET /api/drivers`:** descifra cédula y licencia de hasta 500 filas sin `logPiiAccess`, que solo se llama en el detalle (`drivers.routes.ts:169`). Tiene HU propia, HU-L. `?q=` sigue en HU-F.
- **`GET /api/laft/counterparties`:** sin work item; se anota junto a la revisión de LAFT que David hace aparte. La respuesta incluye `email`, `phone`, `address`, `fund_origin`, `is_pep`, `block_reason`, los `*_enc` y `doc_number_hash` (`db/schema.ts:820-856`, `counterparties.routes.ts:95`).

### G5. Búsquedas legacy con cuasi-PII (Media)

| Endpoint | Módulo | Dato expuesto | Severidad | 1. Auth + autorización | 2. `logPiiAccess` en la lectura | 3. DTO sin payload crudo | 4. Sin URL en claro en logs |
|---|---|---|---|---|---|---|---|
| `GET /api/tramites` | legacy `tramites` | `search`: VIN, placa (`tramites.service.ts:94`) | Media | Sí: auth `modules/tramites/tramites.routes.ts:53`; `tramite.cola.ver` `:304` | No | No: `db.select()` de la fila, con `comprador` y `vehiculo` jsonb (`tramites.service.ts:105`) | No: nginx |
| `GET /api/fleet/vehicles` | legacy `fleet` | `search`: placa, alias, marca, modelo (flota propia) | Media | Sí: auth `modules/fleet/vehicles.routes.ts:13`; `fleet` `:13` | No | Sí: select explícito | No: nginx |
| `GET /api/rndc/tenedores` | legacy `rndc` | `q`: nombre, que puede ser persona natural | Media | Sí: auth `modules/rndc/maestros.routes.ts:19`; `rndc` `:19` | No | No: `db.select()` de la fila, con documento | No: nginx |
| `GET /api/rndc/propietarios-carga` | legacy `rndc` | `q`: nombre | Media | Sí: auth `modules/rndc/maestros.routes.ts:19`; `rndc` `:19` | No | No: `db.select()` de la fila, con documento | No: nginx |
| `GET /api/rndc/destinatarios-carga` | legacy `rndc` | `q`: nombre | Media | Sí: auth `modules/rndc/maestros.routes.ts:19`; `rndc` `:19` | No | No: `db.select()` de la fila, con documento | No: nginx |
| `GET /api/drive/search` | legacy `drive` | `q`: nombre de archivo, texto libre (el nombre suele llevar placa) | Media | Sí: auth `modules/drive/drive.routes.ts:8`; `drive.archivos.administrar` `:30` | No | Sí: metadatos de archivo | No: nginx |

**Decisión:** retiro, HU-G. Migrar o retirar las rutas legacy sigue pendiente (ADR-0036, «Decisiones pendientes»).

### G6. Placa o VIN en el path (Media)

| Endpoint | Módulo | Dato expuesto | Severidad | 1. Auth + autorización | 2. `logPiiAccess` en la lectura | 3. DTO sin payload crudo | 4. Sin URL en claro en logs |
|---|---|---|---|---|---|---|---|
| `GET /api/vehicles/:vin/historial` | legacy `vehicles` | VIN en el path | Media | Sí: auth `modules/vehicles/vehicles.routes.ts:94`; `vehicles.vehiculos.consultar` `:442` | No | Parcial: fila completa de `vehiculo_historial` (`vehiculo-historial.ts:199`); contenido no evaluado | No: nginx y `errorHandler` |
| `GET /api/vehicles/:vin/certificado` | legacy `vehicles` | VIN en el path y en `Content-Disposition` | Media | Sí: auth `modules/vehicles/vehicles.routes.ts:94`; `vehicles.vehiculos.consultar` `:456` | No | Sin verificar: PDF generado, no se leyó | No: nginx y `errorHandler` |
| `POST /api/vehicles/:vin/historial/sync` | legacy `vehicles` | VIN en el path (ampliación: no GET) | Media | Sí: auth `modules/vehicles/vehicles.routes.ts:94`; `vehicles.vehiculos.consultar` `:448` | No | Parcial: fila completa de `vehiculo_historial` (`vehiculo-historial.ts:199`); contenido no evaluado | No: nginx y `errorHandler` |
| `GET /api/flito/derechos/candidatos/:placa` | `flito-derechos` | Placa en el path | Media | Sí: auth `modules/flito-derechos/flito-derechos.routes.ts:31`; `derechos.candidatos.ver` `:204` | No | Sí: candidatos, sin payload | No: nginx y `errorHandler` |

**Decisión:** retiro, HU-H. El código ya reconoce el caso de la placa en `flito-derechos.routes.ts:115`.

### G7. Cuentas de cobro con placa en la URL (Alta la pública, Media la autenticada)

| Endpoint | Módulo | Dato expuesto | Severidad | 1. Auth + autorización | 2. `logPiiAccess` en la lectura | 3. DTO sin payload crudo | 4. Sin URL en claro en logs |
|---|---|---|---|---|---|---|---|
| `GET /api/public/drive/cuentas-archivo/:dir/:token/:filename` | legacy `drive` | Token HMAC sin expiración; `:filename` = `<placa>.pdf`; `?dl=` con placa, organismo y marca. El PDF es una cuenta de cobro, cuyo registro lleva propietario y cédula (`procesador.service.ts:29`) | Alta | No: pública | No | N/A: archivo binario, y ese es el problema | No: nginx y `errorHandler` |
| `GET /api/drive/cuentas-archivo/:dir/:filename` | legacy `drive` | `:filename` = `<placa>.pdf`; `?dl=` con placa | Media | Sí: auth `modules/drive/procesador.routes.ts:54`; `drive.archivos.administrar` `:293` | No | N/A: archivo binario | No: nginx y `errorHandler` |

**Decisión:** retiro, HU-J. Los enlaces públicos se escriben en un Excel (`procesador.routes.ts:222`) y ya circulan, así que la expiración sigue pendiente (ADR-0036, «Decisiones pendientes»).

### G8. Enlaces con token portador (Alta)

| Endpoint | Módulo | Dato expuesto | Severidad | 1. Auth + autorización | 2. `logPiiAccess` en la lectura | 3. DTO sin payload crudo | 4. Sin URL en claro en logs |
|---|---|---|---|---|---|---|---|
| `GET /api/validacion-identidad/info/:token` | legacy `tramites` | Token portador de 24 h que devuelve nombre, documento y placa (`identidad.routes.ts:463`) | Alta | No: pública | No | Parcial: DTO explícito, con cédula en claro y `vehiculoInfo` | No: nginx y `errorHandler` |
| `POST /api/validacion-identidad/completar/:token` | legacy `tramites` | Token portador en el path (ampliación); habilita el envío biométrico | Alta | No: pública | No | No aplica: es una escritura | No: nginx y `errorHandler` |
| `GET /api/tramite-portal/:token` | legacy `tramites` | Token portador de 24 h (`portal.ts:34`); en BD solo vive su hash | Alta | No: pública | No | Sí: DTO mínimo (`portal.ts:108`) | No: nginx, `errorHandler` y RUM |
| `GET /api/tramite-portal/:token/firma/url` | legacy `tramites` | Token portador en el path; devuelve la URL de firma | Alta | No: pública | No | Sí: `url`, `proveedor`, `estado` (`portal.public.routes.ts:80`) | No: nginx y `errorHandler` |
| `POST /api/tramite-portal/:token/aceptar-declaracion` | legacy `tramites` | Token portador en el path (ampliación); registra consentimiento | Alta | No: pública | No | No aplica: es una escritura | No: nginx y `errorHandler` |
| `POST /api/tramite-portal/:token/documentos` | legacy `tramites` | Token portador en el path (ampliación); sube documentos | Alta | No: pública | No | No aplica: es una escritura | No: nginx y `errorHandler` |
| `POST /api/tramite-portal/:token/finalizar` | legacy `tramites` | Token portador en el path (ampliación) | Alta | No: pública | No | No aplica: es una escritura | No: nginx y `errorHandler` |
| `POST /api/tramite-portal/:token/firma-simulada` | legacy `tramites` | Token portador en el path (ampliación) | Alta | No: pública | No | No aplica: es una escritura | No: nginx y `errorHandler` |

**Decisión:** retiro, HU-I. No cabe excepción: son rutas públicas, y §14 prohíbe siempre los tokens en URLs de página. Ninguna llama a `logPiiAccess`; el portal solo emite un evento `acceso_portal` (`portal.ts:100`). Además, a diferencia del portal, `tramites_validaciones.token` se guarda en claro (`db/schema.ts:588`, preexistente).

### G9. QR públicos (Media)

| Endpoint | Módulo | Dato expuesto | Severidad | 1. Auth + autorización | 2. `logPiiAccess` en la lectura | 3. DTO sin payload crudo | 4. Sin URL en claro en logs |
|---|---|---|---|---|---|---|---|
| `GET /api/public/tramite-verificar` | legacy `tramites` | `?t=`: token de 7 días que devuelve placa y VIN (`eventos.ts:133`) | Media | No: pública | No | Sí: estado, placa, VIN y hashes | No: nginx |
| `GET /api/public/tramite-verificar/qr-png/:token` | legacy `tramites` | Token en el path | Media | No: pública | No | Sí: PNG del QR | No: nginx y `errorHandler` |
| `GET /api/rndc/public/manifiestos/qr/:token` | legacy `rndc` | Token en el path que devuelve placa y número de manifiesto | Media | No: pública | No | Sí: datos mínimos, sin conductor | No: nginx y `errorHandler` |
| `GET /api/rndc/public/manifiestos/qr-png/:token` | legacy `rndc` | Token en el path | Media | No: pública | No | Sí: PNG del QR | No: nginx y `errorHandler` |
| `GET /api/drivers/checklists/qr/:token` | legacy `drivers` | Token en el path que devuelve placa y nombre del conductor (`checklists.routes.ts:27`) | Media | No: pública | No | Sí: decisión, fecha, placa, nombre | No: nginx y `errorHandler` |

**Decisión (David Chica):** HU-K. Formato nuevo con el token en el fragmento `#`. Los QR impresos siguen funcionando, como deuda declarada. §14 no cambia.

### G10. Descarga con firma de vida corta (Baja)

| Endpoint | Módulo | Dato expuesto | Severidad | 1. Auth + autorización | 2. `logPiiAccess` en la lectura | 3. DTO sin payload crudo | 4. Sin URL en claro en logs |
|---|---|---|---|---|---|---|---|
| `GET /api/files` | legacy `files` | `key`, `exp`, `sig`: firma HMAC de 300 s (`services/storage.ts:265`) | Baja | No: pública | No | N/A: archivo binario | No: nginx |

**Decisión:** se retira su rastro del log por HU-A; la ruta se mantiene. Quitar la query del log cubre `sig` y `key`. La clave de objeto sigue el formato `prefijo/entidad/fecha_sufijo` (`services/storage.ts:223`). No se revisó cada uno de los 12 llamadores de `firmarDescargaEntidad`, ni las claves antiguas.

### Rutas y páginas de `apps/web`

| Id | URL de página | Dato | Severidad | Evidencia | Decisión |
|---|---|---|---|---|---|
| W1 | `/flito/tramites?placa=` y `?buscar=` | Placa. `?buscar=` también admite documento o nombre, pero no se encontró quién lo escriba | Media | Escribe `lib/comprobantes.ts:216`; lee `pages/FlitoTramites.tsx:129-130` | HU-D |
| W2 | `/finanzas/gastos-diarios?empresas=` | NIT | Media | `components/finanzas/gastos-diarios/tiposGastosDiarios.ts:100`; valor de faceta en `finanzas.service.ts:883` | HU-E |
| W3 | `/tramite/portal/:token` y `/validar-identidad.html?t=` | Token portador, **prohibido siempre** | Alta | `App.tsx:223`; `public/validar-identidad.html:84`; `identidad.routes.ts:297,423` | HU-I |
| W4 | `/m/:token` y `/tramite/verificar?t=` | Token de QR, **prohibido siempre** | Media | `App.tsx:221-222`; `verify.public.routes.ts:29` | HU-K |

No se encontró cédula, teléfono, dirección ni correo en rutas o query del router. Las demás lecturas de `useSearchParams` llevan vista, estado, sección o ids (`SiigoOperacion`, `SiigoParametrizacion`, `navegacionComparendos`, `FlitoComprobantes`, `FinanzasReporteCostos`, `TramiteTraspaso`, `Fleet`).

`src/lib/api.ts` no construye URLs con PII: sus únicas interpolaciones por nombre sensible son `documentoId`, un id (`:659-666`). Las URLs con PII las arman las páginas: `pages/Privacy.tsx:46`, `pages/FlitoRevisiones.tsx:113`, `pages/vehiculo/PasaporteVehiculo.tsx:51,59,97`, `pages/Soat.tsx:264`, `pages/DriveViewer.tsx:136`, `pages/FlitoSoat.tsx:222`, `pages/FlitoImpuestos.tsx:182`, `pages/FlitoDerechos.tsx:374`, `pages/FlitoLogistica.tsx:134`, `pages/Laft.tsx:79`, `pages/Fleet.tsx:64`, `pages/Drivers.tsx:42`.

**Nota menor:** `lib/api.ts:86` guarda path y query en `sessionStorage` al vencer la sesión. No sale del navegador, y se resuelve al retirar W1 y W2.

### Sin hallazgo: 814 rutas

| Categoría | Rutas | De ellas GET |
|---|---:|---:|
| S1. Sin parámetros de path ni query | 266 | 95 |
| S2. Ids opacos y filtros que no identifican a nadie | 507 | 235 |
| S3. Solo catálogo en el path (`:tipo`, `:codigo`, `:anio`…) | 32 | 14 |
| S4. Texto libre sobre catálogos o sobre el número de comparendo | 9 | 7 |

- **S4** son `/api/maintenance/jobs`, `/api/parts`, `/api/rndc/catalogos/{municipios,productos}`, `/api/siigo/ciudades/buscar`, `/api/siigo/productos` y las tres de `/api/flito/comparendos/registros`. En comparendos `q` es el número, y `.strict()` rechaza `?nit=` (`flito-comparendos.routes.ts:935`).
- **`/api/tramites/ocr-extracted/:filename`** está en S3: el servidor genera el nombre como `<tipo>_<fecha>.pdf` (`ocr-docs.routes.ts:313`).
- **Decisión de estas rutas:** se mantienen. §14 permite ids opacos en el path y filtros no identificantes en la query.

## Plan de retiro: HUs derivadas propuestas

**David Chica decidió radicar ya HU-A, HU-B, HU-C y HU-L;** sus AC Gherkin están en ADR-0036. Las otras 8 quedan nombradas y sin radicar. Las letras son etiquetas de este documento, no ids.

| Etiqueta | Título propuesto | Alcance | Cubre | Módulo |
|---|---|---|---|---|
| HU-A | Sacar query y datos de path del access log y de los logs del API | **Radicar ya.** En `nginx.conf.template`: formato sin query ni `$http_referer`, `Referrer-Policy` en páginas y nivel de `error_log`. En el API: `errorHandler` y `frenoConRastro` sin dato en la ruta, y quitar `link` de `identidad.routes.ts:308` | T1, T2, G10 | Transversal |
| HU-B | No persistir tokens en la telemetría RUM | **Radicar ya.** Normalizar `route` en `lib/rum.ts` y en `rum.routes.ts`. La limpieza de filas existentes sigue pendiente | T3 | Legacy `rum` |
| HU-C | Consulta previa de olvido con el documento en el cuerpo | **Radicar ya.** `POST` con cuerpo en `privacy` y `pages/Privacy.tsx`; `logPiiAccess`; retirar el GET | G1 | Legacy `privacy` |
| HU-D | Búsqueda de colas SOAT, Impuestos y Trámites por cuerpo | `POST …/buscar`, retirar `buscar` y `empresas` del GET, `logPiiAccess` en Trámites, quitar `?placa=` y `?buscar=` de la página | G2, W1 | `flito-*` |
| HU-E | Filtros de Derechos, Logística y Finanzas por cuerpo | Igual para `buscar` y `empresas`; quitar `?empresas=` de la página de gastos | G3, W2 | `flito-*` y legacy `finanzas` |
| HU-F | Búsquedas de vehículos, conductores, LAFT y usuarios por cuerpo | `POST …/buscar`, `logPiiAccess` donde falta salvo el listado de conductores (HU-L), export de usuarios por POST. El DTO de LAFT queda fuera: va con la revisión de LAFT | G4 | Legacy |
| HU-G | Búsquedas legacy con cuasi-PII por cuerpo | Fleet, RNDC, Drive y `/api/tramites`, si no se decide retirar ese prefijo | G5 | Legacy |
| HU-H | Retirar placa y VIN del path | `candidatos` y pasaporte por POST o por id opaco | G6 | `flito-derechos` y legacy `vehicles` |
| HU-I | Enlaces de portal e identidad sin token en la URL | Token en el fragmento (`#`) de la página, y hacia el API en cabecera o cuerpo; `logPiiAccess` en `/info` | G8, W3 | Legacy `tramites` |
| HU-J | Cuentas de cobro: descarga con expiración y sin placa en la URL | Nombre opaco en disco, token con expiración, `dl` sin placa | G7 | Legacy `drive` |
| HU-K | QR nuevos con el token en el fragmento | Formato nuevo con el token en el fragmento `#`, y hacia el API en cabecera o cuerpo. Los impresos siguen funcionando, como deuda declarada | G9, W4 | Legacy `tramites`, `rndc` y `drivers` |
| HU-L | Registrar el acceso a PII en el listado de conductores | **Radicar ya.** `logPiiAccess` en `GET /api/drivers` | G4 (`/api/drivers`) | Legacy `drivers` |

**Orden recomendado:**

1. **Ya decididas:** HU-A y HU-B, que son pequeñas y reducen la escritura en log y en base para todas las rutas web; luego HU-C y HU-L.
2. **Sin radicar, por severidad:** HU-J, HU-I, HU-D y HU-F. HU-E, HU-G, HU-H y HU-K al final.

Recomiendo HU-J antes que HU-I, como sugirió `security-agent`: su enlace público no expira, de modo que una URL ya escrita en un log sigue abriendo el archivo, mientras que los tokens de HU-I caducan en 24 h. Depende de la decisión pendiente sobre la expiración: la decide David.

**HU-A no sustituye a las demás:** el dato seguiría en el historial del navegador, en el proxy del host y en lo que entra por `api.*`.

**Patrón a copiar para los POST:** `POST /api/flito/comparendos/registros/buscar` (`flito-comparendos.routes.ts:1061`), con `.strict()`, y `POST /api/flito/soat/buscar` (`flito-soat.routes.ts:189`).

## Para `security-agent`

**No hay endpoints marcados como excepción, así que no hay nada que aceptar hoy.** Las tablas de arriba dejan archivo:línea de cada mitigación por si, una vez cerrada HU-A, se propone alguna en un ADR nuevo. Los candidatos naturales son los que ya cumplen 1, 2 y 3: `GET /api/flito/soat`, `GET /api/flito/impuestos` y `GET /api/finanzas/reporte-costos`. El ADR no los propone como excepción.

## Método

**Reproducir** (solo lee código, sin red ni base de datos; requiere `node_modules`):

```bash
mkdir -p /tmp/barrido && node docs/arquitectura/inventario-get-pii-barrido.cjs . /tmp/barrido
```

Deja `rutas.json`, con cada ruta y su grupo, y escribe los conteos en stdout.

### Conteos

| Medida | Valor |
|---|---:|
| Archivos `.ts` analizados (sin tests) | 659 |
| Archivos con rutas registradas | 150 |
| Rutas | **856** (GET 387, POST 347, PATCH 70, DELETE 37, PUT 15) |
| GET con parámetro de path | 170 |
| GET con query | 135 |
| GET con path o query | 292 |
| Rutas sin montar, con path no literal o con query opaca | 0 |
| Nodos `req.query` en el AST / atribuidos a una ruta | 361 / 361 |
| **Clasificadas con hallazgo** | **42** (36 GET y 6 no GET) |
| **Clasificadas sin hallazgo** | **814** (351 GET) |
| **Residuo sin clasificar** | **0** |

**Contraprueba independiente:** una regex multilínea sobre el texto da 859 registros. Son las 856 rutas más 3 menciones en comentarios (`inventario-guardas.ts:231`, `users.routes.ts:213`, `exigir-funcion.ts:128`), y no hay ninguna ruta del AST que la regex no vea.

### Qué cubre (AC4 y ampliación del encargo)

| Superficie | Cómo |
|---|---|
| Parámetros de path | Todo `:param` de la plantilla, incluido el del prefijo de montaje |
| `req.query.x` y `req.query['x']` | Visitante de AST sobre el handler |
| Desestructuración y alias de `req.query` | `const { a } = req.query`, `const q = req.query` |
| `schema.parse` / `safeParse` | Se resuelven las llaves de `z.object`, `.extend`, `.merge` y `.omit` (la base), también entre archivos |
| Helpers y middleware | Se sigue `req` o `req.query` a funciones del repo, hasta 5 niveles, incluidos `router.use(fn)` y fábricas de middleware |
| Otros métodos | POST, PUT, PATCH y DELETE, marcados como ampliación si tienen hallazgo (pedida en el encargo, no en el AC) |
| Routers no llamados `*.routes.ts` | Se reconoce el router por `Router()` o por su tipo, no por el nombre del archivo; fábricas como `analisisRouter(ctx)` incluidas |
| `src/app.ts` | Grafo de montajes desde `createApp`, con `conAlcance`, y sus rutas directas (`/api/health*`, `/metrics`) |
| `apps/web/src` | `App.tsx`, `useSearchParams`, `URLSearchParams`, navegación y plantillas de URL con nombres sensibles, y `public/*.html` |

### Cómo se clasificó

1. El script asigna cada ruta a un grupo explícito o a una lista cerrada de parámetros no identificantes. Lo que no encaja sale como residuo.
2. Los 199 nombres distintos de parámetro se revisaron, y los dudosos se leyeron en el handler y en el servicio: un nombre no es prueba. Así salieron `empresas` (es NIT, no id), `:filename` (es `<placa>.pdf` en Drive y un nombre generado en OCR) y `q` (distinta en cada módulo).
3. **`logPiiAccess`:** el script sigue la llamada desde esa ruta, incluidos envoltorios como `registrarAccesoSoat`, y se contrastó con un `grep` por archivo. Que un módulo lo importe no cuenta.

## No cubierto

- **Logs reales de infraestructura: no se revisaron. Pendiente para Daniel Mejía.** Las comprobaciones que se le piden están en ADR-0036, «Logs ya escritos». Incluye el proxy TLS del host, el ingress del k3s, lo que `flit-gitops` pueda sobrescribir de nginx, el dominio `api.*` (llega directo del proxy del host, según `nginx.conf.template:46`) y la retención y los destinos de esos logs.
- **Si hay PII real en logs o en `rum_web_vitals`:** no se consultó ningún log, base de datos ni ambiente. T1 y T3 se deducen del código y de la imagen.
- **`:id` no comprobado uno a uno.** De 331 rutas con `:id`, 268 muestran conversión o validación cerca de la ruta. Para las otras 63 hubo una comprobación indirecta: se leyó una muestra, y ningún llamador web interpola una variable con nombre sensible en ellas. Un `:id` que reciba otro dato bajo un nombre neutro no se detectaría.
- **Web por nombre de variable:** una URL armada con una variable de nombre neutro se escaparía de esa búsqueda. Lo mitiga que los parámetros de la API sí se enumeraron todos.
- **Fuera del alcance pactado:** cuerpos de petición, URLs salientes hacia terceros (RUNT, SIMIT, UTS, Nominatim desde `validar-identidad.html`), PII en `log.*` por campos ajenos a la URL, y cabeceras `Content-Disposition`. Tras el hallazgo de `identidad.routes.ts:308` se buscaron en `log.*` y `console.*` los campos `link`, `url`, `href`, `enlace` y `token`: el resto son URLs fijas de listas LAFT y el prefijo de `validacion-recovery.ts:35`. Esa búsqueda es por nombre de campo: una URL bajo otro nombre no se detectaría.
- **Forma no detectada por el barrido:** `new URL(req.originalUrl).searchParams` no deja señal en el AST. Hoy tiene 0 usos: los `searchParams` del API son de clientes salientes (búsqueda de texto en `apps/api/src`).
- **Mitigación 3:** se verificó por lectura de la consulta y por búsqueda de campos `payload`, no con respuestas reales. Quedan marcados «Parcial» los casos sin evaluar a fondo.
- **Sin ejecución:** esta auditoría no probó ninguna ruta. Las pruebas de `$http_referer` y `error_log` de T1 son de `security-agent`.
