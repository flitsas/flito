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

1. **El nginx del contenedor web registra cada URL completa.** La plantilla no declara `access_log`, así que hereda el formato `main` de la imagen, con `"$request"`, hacia stdout. Por ahí pasa todo `/api/` y todas las páginas.
2. **El API no tiene access log, pero `errorHandler` registra `req.path`,** que incluye los parámetros de path. Esto solo afecta a las rutas con PII en el path que terminan en 500.
3. **La telemetría RUM guarda `location.pathname`,** de modo que los tokens de `/tramite/portal/<token>` y `/m/<token>` quedan en `rum_web_vitals.route`.

Por el primer hecho, la mitigación 4 falla en las 42 rutas. Los logs reales de infraestructura no se revisaron: quedan pendientes para Daniel Mejía.

## Alternativas para el saneo transversal

### Opción 1: formato de log propio en la plantilla de nginx

Registrar `$request_method $uri` en vez de `$request`, y enmascarar con un `map` los segmentos de path con dato (token, documento, placa, VIN). En el API, `errorHandler` y `frenoConRastro` pasarían a usar la plantilla de ruta (`rutaDe`, ya en `exigir-funcion.ts:137`).

- **Pros:** corta la escritura para todas las rutas a la vez, sin tocar contratos ni pantallas. Conserva el log operativo. No añade dependencias: `log_format` y `map` son válidos en `conf.d/default.conf`, dentro del bloque `http`.
- **Contras:** se pierde la query para diagnóstico, y la lista de `map` hay que mantenerla mientras exista alguna ruta con dato en el path. No cubre el proxy del host ni el historial del navegador.
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

Se recomienda la **Opción 1 como primer paso, seguida de la Opción 3 por grupos.** Las dos se necesitan: el saneo corta la escritura de inmediato y el retiro quita el dato de las capas que el saneo no alcanza.

### D1. Ninguna ruta queda hoy como excepción GET+query

La mitigación 4 falla en todas, así que ninguna cumple §14. Por tanto `security-agent` no tiene excepción que aceptar. Sanear el log no convierte a una ruta en excepción por sí solo: quien quiera una necesitaría un ADR nuevo con las cuatro mitigaciones verificadas y la aceptación de `security-agent`.

### D2. Plan por grupo

| Grupo | Rutas | Severidad | Decisión | HU derivada propuesta |
|---|---:|---|---|---|
| Transversal T1 y T2 | Todas | Principal | Sanear logs | HU-A: Sacar query y datos de path del access log y de los logs del API |
| Transversal T3 | Portal y QR | Alta | No persistir tokens | HU-B: No persistir tokens en la telemetría RUM |
| G1 Cédula en el path | 1 | Alta | Retiro | HU-C: Consulta previa de olvido con el documento en el cuerpo |
| G2 Colas FLITO con documento | 3 | Alta | Retiro | HU-D: Búsqueda de colas SOAT, Impuestos y Trámites por cuerpo |
| G3 Colas y reportes con cuasi-PII | 6 | Media | Retiro | HU-E: Filtros de Derechos, Logística y Finanzas por cuerpo |
| G4 Búsquedas legacy con identidad | 6 | Alta | Retiro | HU-F: Búsquedas de vehículos, conductores, LAFT y usuarios por cuerpo |
| G5 Búsquedas legacy con cuasi-PII | 6 | Media | Retiro | HU-G: Búsquedas legacy con cuasi-PII por cuerpo |
| G6 Placa o VIN en el path | 4 | Media | Retiro | HU-H: Retirar placa y VIN del path |
| G7 Cuentas de cobro | 2 | Alta y Media | Retiro | HU-J: Cuentas de cobro: descarga con expiración y sin placa en la URL |
| G8 Enlaces con token | 8 | Alta | Retiro | HU-I: Enlaces de portal e identidad sin token en la URL |
| G9 QR públicos | 5 | Media | Retiro; forma pendiente de decisión humana | HU-K: QR públicos sin token en la URL de log |
| G10 Firma de 5 minutos | 1 | Baja | Se mantiene la ruta; el log lo cubre HU-A | HU-A |

El alcance de cada HU, las páginas web afectadas y el orden están en el inventario. **Ninguna está creada en ADO:** se radican solo con «sí» humano, y cada una entra por su ciclo normal.

### D3. Patrón para los retiros

Se reutiliza lo que ya existe, sin patrón nuevo:

- **Búsquedas:** `POST …/buscar` con esquema `.strict()`, como `POST /api/flito/comparendos/registros/buscar`. El GET conserva solo los filtros que no identifican a nadie, y rechaza los demás.
- **Rastro:** `logPiiAccess` en la lectura, sin el valor buscado en `motivo`, como `registrarAccesoSoat`.
- **Enlaces con token:** el token viaja en el fragmento (`#`) de la página, que el navegador no envía al servidor, y hacia el API en cabecera o cuerpo.

## Consecuencias

- **El contrato cambia en cada retiro.** Pasar a POST exige tocar `apps/web` y, si aplica, `packages/shared-types` (con su `grep` obligatorio de usos).
- **El GET pierde semántica de lectura** en esas búsquedas. Es el mismo costo que ya se aceptó en comparendos (ADR-0004).
- **La query deja de estar en el access log,** así que un diagnóstico por URL exacta dependerá de otros rastros, como el `x-request-id`.
- **Las rutas legacy podrían no valer la migración:** ADR-0033 mide su uso, y puede resultar más barato retirarlas.

## Riesgos abiertos y qué falta decidir

- Los logs reales pueden contener ya cédulas, correos y tokens. Este ADR no los limpia.
- HU-A no alcanza al proxy del host ni al ingress, que no están en este repo.
- Los enlaces de cuentas de cobro ya circulan en archivos Excel, y añadirles expiración los rompería.
- Los QR impresos no pueden cambiar. §14 prohíbe siempre los tokens en URLs de página, y las rutas públicas no pueden cumplir la mitigación 1, por lo que no existe vía de excepción para ellos. Hace falta una decisión humana: cambiar el formato para los QR nuevos conservando los antiguos, o ajustar §14 para tokens de verificación pública.
