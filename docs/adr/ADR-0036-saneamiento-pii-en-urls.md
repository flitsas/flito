# ADR-0036: Saneamiento de PII en URLs: primero el log, después retiro por grupo y sin excepciones hoy

- **Estado:** Propuesto. Lo firma el Líder Técnico humano.
- **Fecha:** 2026-11-04
- **Contexto de trabajo:** Épica #13973, Feature #13977, HU #13986
- **Evidencia:** [inventario de endpoints con PII en la URL](../arquitectura/inventario-get-pii.md)
- **Relacionado:** ADR-0004 (export de comparendos por POST), ADR-0008 (retiro previsto de `buscar` en SOAT), ADR-0023 (`exigirFuncion` y `requirePage`), ADR-0033 (conteo de uso legacy)
- **Supersedes:** ninguno
- **Módulos:** legacy y `flito-*`; el inventario declara a cuál pertenece cada ruta

## Contexto

`AGENTS.md` §14 pide que los filtros con PII o cuasi-PII vayan en el cuerpo, y solo admite GET+query con un ADR que `security-agent` acepte y cuatro mitigaciones: auth + autorización, `logPiiAccess` en la lectura, DTO sin payload crudo y sin registrar la query en claro.

El barrido encontró 42 de 856 rutas con PII, cuasi-PII o un token portador en la URL: 19 Altas, 22 Medias y 1 Baja. Tres hechos determinan la decisión:

1. **El nginx del contenedor web registra cada URL completa.** La plantilla no declara `access_log`, así que hereda el formato `main` de la imagen, con `"$request"`, hacia stdout. Por ahí pasan el `/api/` del dominio web, que es la vía de la propia web, y todas las páginas; `api.*` lo salta (`nginx.conf.template:46`, `cd.yml:57-73`). También escriben la URL `$http_referer` y `error_log`.
2. **El API no tiene access log, pero `errorHandler` registra `req.path`,** que incluye los parámetros de path. Afecta a las rutas con PII en el path que terminan en 500 o en 413 (`errorHandler.ts:11`), como `POST /api/validacion-identidad/completar/<token>` por encima de 15 MB. Además, `identidad.routes.ts:308` registra el enlace con el token si el correo no sale.
3. **La telemetría RUM guarda `location.pathname`,** de modo que los tokens de `/tramite/portal/<token>` y `/m/<token>` quedan en `rum_web_vitals.route`.

Por el primer hecho, la mitigación 4 falla en las 42 rutas. Los logs reales de infraestructura no se revisaron: quedan pendientes para Daniel Mejía.

## Alternativas para el saneo transversal

### Opción 1: sanear las tres vías de escritura de nginx y los logs del API

En `nginx.conf.template`:

- **Formato propio:** `$request_method $uri` en vez de `$request`, **sin `$http_referer`**, y un `map` que enmascare los segmentos de path con dato (token, documento, placa, VIN).
- **`Referrer-Policy` en las páginas,** que hoy no la declaran. Debe impedir que la URL con query viaje incluso a peticiones del mismo origen, así que no sirve el valor por defecto del navegador; se propone `no-referrer` o `strict-origin`. Cuidado: un `add_header` en `location` anula los heredados del `server`.
- **Nivel de `error_log`:** `error_log` no usa `log_format`, y un 502 escribe `request: "GET …?buscar=…"`. Se recomienda subirlo a `crit` y diagnosticar los 502 y 504 por el estado del access log. Lo que el nivel `crit` aún registre se declara como residuo.

En el API:

- `errorHandler` y `frenoConRastro` sin dato en la ruta, reutilizando `rutaDe` (`exigir-funcion.ts:137`). Hay dos trampas: tras `next(err)`, `req.baseUrl` queda vacío (`uso-legacy.middleware.ts:5`), y en un 413 no hay `req.route`, por lo que aplica la heurística de `enmascarar`, que no reconoce todo (un token de 16 caracteres, `<placa>.pdf`).
- Quitar `link` de `identidad.routes.ts:308`.

- **Pros:** corta en este contenedor y en el API la escritura para todas las rutas a la vez, sin tocar contratos ni pantallas. Conserva el log operativo. No añade dependencias: `log_format` y `map` son válidos en `conf.d/default.conf`, dentro del bloque `http`.
- **Contras:** se pierde la query para diagnóstico, y la lista de `map` hay que mantenerla mientras exista alguna ruta con dato en el path. Subir `error_log` reduce el detalle ante fallos. No cubre el proxy del host, lo que entra por `api.*` ni el historial del navegador.
- **Esfuerzo:** S.
- **Riesgos:** si `flit-gitops` sustituye la configuración, el cambio no surtiría efecto: hay que comprobarlo en el ambiente.

### Opción 2: `access_log off` en `location /api/`

- **Pros:** es el cambio mínimo y no requiere `map`.
- **Contras:** deja sin rastro todo el API en esa capa, y el proceso no tiene access log propio, por lo que se perdería toda visibilidad. Tampoco cubre `location /`, por donde entran `validar-identidad.html?t=`, `/tramite/portal/<token>` y `/flito/tramites?placa=`.
- **Esfuerzo:** S.
- **Riesgos:** diagnóstico a ciegas ante incidentes.

### Opción 3: migrar endpoints sin tocar el log

- **Pros:** resuelve la causa, y también el historial del navegador y los proxies externos.
- **Contras:** son 42 rutas y sus pantallas, y mientras tanto se sigue escribiendo PII en el log. Tampoco limpia lo que entre en el futuro por una ruta nueva mal hecha.
- **Esfuerzo:** L.
- **Riesgos:** exposición prolongada durante la migración.

## Decisión

Se recomienda la **Opción 1 como primer paso, seguida de la Opción 3 por grupos.** Las dos se necesitan: el saneo corta la escritura en las capas de este repo, y el retiro quita el dato de las que no alcanza.

### D1. Ninguna ruta queda hoy como excepción GET+query

La mitigación 4 falla en todas, así que ninguna cumple §14. Por tanto `security-agent` no tiene excepción que aceptar. Sanear el log no convierte a una ruta en excepción por sí solo: quien quiera una necesitaría un ADR nuevo con las cuatro mitigaciones verificadas y la aceptación de `security-agent`.

### D2. Plan por grupo

| Grupo | Rutas | Severidad | Decisión | HU derivada propuesta |
|---|---:|---|---|---|
| Transversal T1 y T2 | Todas | Principal | Sanear logs | **HU-A** (radicar ya): Sacar query y datos de path del access log y de los logs del API |
| Transversal T3 | Portal y QR | Alta | No persistir tokens | **HU-B** (radicar ya): No persistir tokens en la telemetría RUM |
| G1 Cédula en el path | 1 | Alta | Retiro | **HU-C** (radicar ya): Consulta previa de olvido con el documento en el cuerpo |
| G2 Colas FLITO con documento | 3 | Alta | Retiro | HU-D: Búsqueda de colas SOAT, Impuestos y Trámites por cuerpo |
| G3 Colas y reportes con cuasi-PII | 6 | Media | Retiro | HU-E: Filtros de Derechos, Logística y Finanzas por cuerpo |
| G4 Búsquedas legacy con identidad | 6 | Alta | Retiro | HU-F: Búsquedas de vehículos, conductores, LAFT y usuarios por cuerpo |
| `GET /api/drivers`, lectura sin rastro | 1, ya en G4 | Alta | Añadir rastro | **HU-L** (radicar ya): Registrar el acceso a PII en el listado de conductores |
| G5 Búsquedas legacy con cuasi-PII | 6 | Media | Retiro | HU-G: Búsquedas legacy con cuasi-PII por cuerpo |
| G6 Placa o VIN en el path | 4 | Media | Retiro | HU-H: Retirar placa y VIN del path |
| G7 Cuentas de cobro | 2 | Alta y Media | Retiro | HU-J: Cuentas de cobro: descarga con expiración y sin placa en la URL |
| G8 Enlaces con token | 8 | Alta | Retiro | HU-I: Enlaces de portal e identidad sin token en la URL |
| G9 QR públicos | 5 | Media | Formato nuevo con fragmento; impresos como deuda | HU-K: QR nuevos con el token en el fragmento |
| G10 Firma de 5 minutos | 1 | Baja | Se mantiene la ruta; su rastro en el log lo retira HU-A | HU-A |

El alcance de cada HU, las páginas web afectadas y el orden recomendado están en el inventario. **Ninguna está creada en ADO todavía.** HU-A, HU-B, HU-C y HU-L se radican ya; HU-D a HU-K quedan nombradas y sin radicar.

### D3. Patrón para los retiros

Se reutiliza lo que ya existe, sin patrón nuevo:

- **Búsquedas:** `POST …/buscar` con esquema `.strict()`, como `POST /api/flito/comparendos/registros/buscar`. El GET conserva solo los filtros que no identifican a nadie, y rechaza los demás.
- **Rastro:** `logPiiAccess` en la lectura, sin el valor buscado en `motivo`, como `registrarAccesoSoat`.
- **Enlaces con token:** el token viaja en el fragmento (`#`) de la página, que el navegador no envía al servidor, y hacia el API en cabecera o cuerpo.

## Decisiones de David Chica (2026-11-04)

El ADR sigue en estado Propuesto: lo firma él. Estas decisiones se registran para que las HUs puedan radicarse.

- **Se radican ya HU-A, HU-B, HU-C y HU-L.** Las otras 8 (HU-D a HU-K) quedan nombradas aquí, sin radicar, hasta decidir legacy y QR.
- **QR (G9, HU-K):** formato nuevo con el token en el fragmento `#`. Los impresos siguen funcionando, como deuda declarada. §14 no cambia.
- **LAFT, `GET /api/laft/counterparties`:** sin work item; se anota junto a la revisión de LAFT que David hace aparte. La respuesta incluye `email`, `phone`, `address`, `fund_origin`, `is_pep`, `block_reason`, los `*_enc` y `doc_number_hash` (`db/schema.ts:820-856`, `counterparties.routes.ts:95`).

### Logs ya escritos

Ningún agente purga. Daniel Mejía confirma, **por conteo y sin copiar datos:**

1. La retención de los logs.
2. Si hay PII: búsquedas por `?buscar=`, `?q=`, `/privacy/preview/`, `/tramite/portal/` y `validar-identidad.html?t=`, también en el campo Referer y en el log de errores de nginx.
3. Cuántas veces aparece el mensaje de `identidad.routes.ts:308` («email de validación no enviado»).
4. Si los logs salen a un agregador o a un tercero, y quién los puede leer.
5. Qué registran el proxy del host, el ingress y `api.*`, y si `flit-gitops` sustituye la configuración de nginx.

Con eso, David decide si escala al responsable de datos.

## Decisiones pendientes del humano

Siguen abiertas y este ADR no las decide:

| Tema | Pregunta | HU |
|---|---|---|
| `rum_web_vitals` | ¿Se limpian las filas existentes con tokens? La purga automática las borra a los 90 días | HU-B |
| Legacy | ¿Migrar o retirar? ADR-0033 mide el uso, y `/api/tramites` es el caso más claro | HU-G |
| ADR-0008 y HU-D | ADR-0008 (Propuesto) preveía quitar `buscar` del GET de SOAT en la #11915 y sigue ahí. ¿Lo absorbe HU-D? | HU-D |
| Cuentas de cobro | ¿Se aceptan rotos los enlaces que ya circulan en Excel al añadir expiración, o hay transición? | HU-J |
| `empresas` | ¿El NIT de una compañía cliente cuenta como cuasi-PII? Si no, G3 se reduce a `buscar`, sale `gastos-diarios` y sale W2 | HU-D, HU-E |

## HUs que se radican ya

Título, alcance y AC propuestos para `flit-crear-hu`. Módulos legacy y transversales; ninguna toca un módulo `flito-*`.

### HU-A: Sacar query y datos de path del access log y de los logs del API

**Alcance:** `apps/web/nginx.conf.template`; `shared/middleware/errorHandler.ts`, `rateLimiter.ts` (`frenoConRastro`) y `modules/tramites/identidad.routes.ts:308`. **Fuera:** proxy del host, ingress y `api.*`; logs ya escritos.

```gherkin
Escenario: La query no llega al access log
  Dado el contenedor web con la plantilla nueva
  Cuando llega "GET /api/flito/soat?buscar=VALOR"
  Entonces la línea del access log conserva método, path y estado
  Y no contiene "VALOR" ni la query

Escenario: El Referer no llega al access log
  Cuando llega una petición con cabecera Referer "/validar-identidad.html?t=TOKEN"
  Entonces la línea del access log no contiene "TOKEN"

Escenario: Los datos de path se enmascaran en el access log
  Cuando se pide una URL con token, documento, placa o VIN en el path entre las rutas de los grupos G1, G6, G7, G8 y G9 y las páginas "/tramite/portal/:token" y "/m/:token"
  Entonces la línea del access log no contiene ese valor

Escenario: Las páginas no filtran su URL por Referer
  Cuando se sirve "/validar-identidad.html" o el index de la SPA
  Entonces la respuesta declara una cabecera Referrer-Policy
  Y una petición del mismo origen hecha desde "/validar-identidad.html?t=TOKEN" no envía "TOKEN" en el Referer

Escenario: Un 502 no escribe la query en el log de errores
  Dado que el API no responde
  Cuando llega "GET /api/flito/soat?buscar=VALOR"
  Entonces el cliente recibe 502
  Y ni el log de errores ni el access log contienen "VALOR"
  Y el access log muestra el estado 502

Escenario: Un error del API no registra el valor del path
  Cuando "POST /api/validacion-identidad/completar/TOKEN" supera 15 MB y responde 413
  O una ruta con dato en el path responde 500
  Entonces el log del API no contiene el valor del path
  Y la respuesta al cliente no cambia

Escenario: El límite de peticiones no registra el valor del path
  Cuando un limitador con "frenoConRastro" rechaza una ruta con dato en el path
  Entonces el log no contiene ese valor

Escenario: El modo de enlace manual no registra el enlace
  Dado que el correo de validación no se pudo enviar
  Cuando se responde en modo de enlace manual
  Entonces el administrador sigue recibiendo el enlace en la respuesta
  Y el log conserva el trámite y el motivo, sin el enlace ni el token
```

### HU-B: No persistir tokens en la telemetría RUM

**Alcance:** `apps/web/src/lib/rum.ts` y `apps/api/src/modules/rum/rum.routes.ts`. **Fuera:** limpiar filas existentes (pendiente).

```gherkin
Escenario: El navegador reporta la ruta sin token
  Dado un visitante en "/tramite/portal/TOKEN" o en "/m/TOKEN"
  Cuando se reporta una métrica
  Entonces el campo route no contiene "TOKEN"

Escenario: El API no guarda un token aunque el cliente lo envíe
  Dado un cliente con una versión anterior de la página
  Cuando "POST /api/rum" llega con route "/tramite/portal/TOKEN" o "/m/TOKEN"
  Entonces responde 204
  Y la fila guardada no contiene "TOKEN"

Escenario: El resumen sigue agrupando
  Dado métricas de dos tokens distintos de la misma página
  Cuando se consulta "GET /api/rum/summary"
  Entonces aparecen agrupadas en una sola ruta

Escenario: Las demás rutas no cambian
  Cuando se reporta una métrica en una ruta sin token
  Entonces se guarda con la misma route de hoy
```

### HU-C: Consulta previa de olvido con el documento en el cuerpo

**Alcance:** `modules/privacy/privacy.routes.ts`, `apps/web/src/pages/Privacy.tsx` y los registros de la ruta en `permisos/catalogo-operaciones.legado.ts:441` e `inventario.generado.ts:684`. Mismo permiso (`privacy.titulares.operar`), mismo limitador y mismos conteos. Patrón: `POST /api/flito/comparendos/registros/buscar`.

```gherkin
Escenario: Consulta con el documento en el cuerpo
  Dado un usuario con la función "privacy.titulares.operar"
  Cuando envía el documento en el cuerpo de la consulta previa
  Entonces recibe los mismos conteos por tabla que hoy
  Y la URL de la petición no contiene el documento

Escenario: La consulta deja rastro sin el documento
  Cuando la consulta responde 200, también con todos los conteos en cero
  Entonces queda una fila en "pii_access_log" para ese usuario
  Y ni "motivo" ni los logs contienen el documento

Escenario: La ruta antigua ya no existe
  Cuando se pide "GET /api/privacy/preview/DOCUMENTO"
  Entonces no se ejecuta ninguna consulta de conteo y no responde 200

Escenario: Validación
  Cuando el documento falta, tiene menos de 3 o más de 20 caracteres, o el cuerpo trae un campo desconocido
  Entonces responde 400 y no queda rastro de acceso

Escenario: Autorización y límite
  Cuando el usuario no tiene la función
  Entonces responde 403 y no queda rastro de acceso
  Cuando supera el límite de 20 consultas por minuto
  Entonces responde 429

Escenario: Pantalla de privacidad
  Cuando el usuario consulta un documento en la pantalla de Privacidad
  Entonces ve los mismos conteos y mensajes que hoy
```

### HU-L: Registrar el acceso a PII en el listado de conductores

**Alcance:** `modules/drivers/drivers.routes.ts` (`GET /api/drivers`, línea 68). **Fuera:** sacar `?q=` de la URL (HU-F) y cambiar lo que devuelve. Patrón: `registrarAccesoSoat`, y el detalle de `drivers.routes.ts:169`.

```gherkin
Escenario: El listado deja rastro
  Dado un usuario con permiso sobre "pesv_conductores"
  Cuando pide "GET /api/drivers" y la respuesta es 200
  Entonces queda una fila en "pii_access_log" con los campos descifrados entregados y el número de filas
  Y esa fila se escribe antes de enviar la respuesta

Escenario: El rastro no copia la búsqueda
  Cuando el listado se pide con "?q=VALOR"
  Entonces "motivo" no contiene "VALOR"

Escenario: Sin descifrado no se declaran campos de más
  Dado un listado cuyas filas no tienen cédula ni licencia cifradas
  Cuando responde 200
  Entonces la fila de auditoría no declara "cedula" ni "licencia_numero"

Escenario: Un acceso denegado no deja rastro de lectura
  Cuando el usuario no tiene permiso
  Entonces responde 403 y no se escribe la fila

Escenario: La respuesta no cambia
  Cuando pide el listado con o sin "vencidos"
  Entonces recibe los mismos campos que hoy
```

## Consecuencias

- **El contrato cambia en cada retiro.** Pasar a POST exige tocar `apps/web` y, si aplica, `packages/shared-types` (con su `grep` obligatorio de usos).
- **El GET pierde semántica de lectura** en esas búsquedas. Es el mismo costo que ya se aceptó en comparendos (ADR-0004).
- **La query y el Referer dejan de estar en el access log,** y `error_log` pierde detalle si se sube de nivel, así que un diagnóstico por URL exacta dependerá de otros rastros, como el `x-request-id`.
- **Las rutas legacy podrían no valer la migración:** ADR-0033 mide su uso, y puede resultar más barato retirarlas.

## Riesgos abiertos

- Los logs reales pueden contener ya cédulas, correos y tokens. Este ADR no los limpia: ver «Logs ya escritos».
- HU-A no alcanza al proxy del host, al ingress ni a lo que entra por `api.*`, que no están en este repo. El proxy puede registrar la URL antes de llegar a nginx.
- **Residuo tras HU-A:** lo que `error_log` escriba a nivel `crit`, si lo hay.
- **QR impresos:** siguen con el token en la URL, como deuda declarada. HU-A enmascara su path en el log, pero no en el historial del navegador ni en proxies externos.
- `tramites_validaciones.token` se guarda en claro (`db/schema.ts:588`, preexistente), y el enlace de `/m/<token>` no expira.
