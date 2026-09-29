# API externa — Sincronización incremental de trámites (v3)

> Contrato para clientes de integración externos (primer consumidor: **Flito**).
> Estado: **Acordado** (2026-09-29) · Épica ADO: [#12737](https://dev.azure.com/FlitDevOps/FLIT%20-%20EVOLUTION/_workitems/edit/12737) · Sin implementar.
> Todos los ejemplos usan datos ficticios. Este documento puede copiarse al repositorio del consumidor.
>
> **Cambios de v2 → v3** (2026-09-29, acordados entre los equipos de FLIT y Flito):
> 1. **Se elimina el canal de señal** (webhook `tramite_sync_changed`, firma HMAC, secreto compartido y
>    requisito de conectividad FLIT → consumidor). La integración es **solo pull**: el consumidor
>    consulta cada 5 min y a demanda, siempre por el mismo cursor.
> 2. `cursor` y `since` en la misma llamada → `400 cursor_and_since_exclusive`.
> 3. La guía de consumo (§5) arranca por `since` con la hora real, no por cursor vacío.
> 4. **`comprador` (objeto) pasa a `compradores` (array)** con `ordinal` y `porcentajeParticipacion`, para
>    no perder copropietarios (FLIT 2 admite hasta 4 por rol, ADR-0053). Nunca `null`; puede venir vacío.
> 5. Autenticación, alcance, resto del ítem, estados y endpoint del adjunto: **sin cambios**.
>
> **Cambios de v1 → v2** (histórico; el punto 1 queda anulado por v3):
> 1. Se añade un **canal de señal** (webhook saliente firmado) para que el consumidor no consulte a
>    ciegas — ver §3. El pull por cursor sigue siendo la fuente de verdad; la señal solo lo acelera.
> 2. Se precisa la regla de alcance: **se entrega todo trámite radicado al menos una vez, y una vez
>    dentro ya no sale nunca del feed.** v1 decía lo mismo en prosa pero lo implementaba con una
>    condición distinta, que dejaba desaparecer del feed a los trámites que retrocedían.
> 3. Se añade la **tabla de estados** (§4) con cuáles son terminales y a dónde puede ir cada uno.
> 4. §2 (auth), §4 (ítem) y el endpoint de adjunto quedan **sin cambios funcionales**.

## 1. Resumen

| Aspecto | Valor |
|---|---|
| Base | `https://<host-ambiente>/api/v1/external` (un cliente y un host por ambiente: DEV, QA, PDN) |
| Autenticación | `client_credentials` → JWT Bearer RS256, vigencia 30 min |
| Scopes | `external.tramites.read` (obligatorio) · `external.tramites.pii.read` (datos personales sin enmascarar) |
| Patrón | Pull incremental por cursor opaco (keyset), consultado periódicamente (previsto: cada 5 min) y a demanda. Semántica **al menos una vez** |
| Formato | JSON camelCase · fechas ISO-8601 con offset `-05:00` · **todas las claves siempre presentes**, vacío = `null` |
| Errores | RFC 7807 `application/problem+json` |
| Límites | `pageSize` default 200, máx 1000 · 120 solicitudes/min por cliente · token: límite por IP · ventana de estabilidad 5 s |

## 2. Autenticación

### `POST /api/v1/external/auth/token`

```http
POST /api/v1/external/auth/token
Content-Type: application/json

{ "clientId": "flito-qa", "clientSecret": "<secreto>" }
```

```json
{ "accessToken": "<jwt>", "tokenType": "Bearer", "expiresIn": 1800, "scope": ["external.tramites.read", "external.tramites.pii.read"] }
```

- 401 `invalid_client` si las credenciales son inválidas o el cliente está inactivo (no se revela cuál).
- 423 `client_locked` tras 5 fallos consecutivos; bloqueo temporal de **15 min**, con desbloqueo automático o por el superadministrador.
- 403 `secret_rotation_required` si el cliente tiene rotación obligatoria pendiente.
- El consumidor cachea el token y lo renueva antes de `expiresIn` o ante un 401.

Todos los demás endpoints exigen `Authorization: Bearer <jwt>`.

## 3. Sincronización

### `GET /api/v1/external/tramites/sync`

| Parámetro | Tipo | Descripción |
|---|---|---|
| `cursor` | string, opcional | Cursor opaco devuelto en `nextCursor`. Vacío = desde el inicio del histórico. |
| `since` | ISO-8601, opcional | Solo sin `cursor` (los dos juntos → 400). Inicia desde el primer trámite cuya **fecha de último cambio** ≥ `since` (no por fecha de creación). |
| `pageSize` | int, opcional | Default 200, máximo 1000. |

Respuesta `200`:

```json
{
  "items": [ { "...": "ver §4" } ],
  "nextCursor": "eyJ2IjoxLCJzdiI6NDgyMTN9",
  "hasMore": true,
  "pageSize": 500,
  "serverTime": "2026-09-21T10:15:03-05:00"
}
```

Reglas:
- Ítems ordenados por `syncVersion` ascendente. `nextCursor` **siempre** presente (aunque `hasMore=false`): el consumidor lo persiste y continúa desde ahí en la siguiente corrida.
- Sin resultados → `200` con `items: []` (nunca 404).
- Un trámite puede repetirse entre páginas o corridas si cambió entre medias: el consumidor hace **upsert por `id`** y descarta si `syncVersion` recibido ≤ el guardado.
- **Alcance: se entrega todo trámite RADICADO al menos una vez**, es decir, que alguna vez ha llegado al organismo de tránsito. Un trámite que nunca se radicó —en `borrador` o `preparado`— no se entrega: es trabajo en curso interno de la empresa.
- **Una vez entregado por primera vez, el trámite permanece en el feed de forma definitiva.** Si retrocede a `borrador` o a `preparado`, llega como **un cambio de estado más, nunca como una baja**. Desaparecer del feed no es un comportamiento posible de este contrato: la única forma de baja es el tombstone.
- Un trámite eliminado lógicamente llega con `eliminado: true` y payload mínimo (tombstone).
- Ventana de estabilidad: los cambios se exponen con un retraso de **5 s** para no perder transacciones concurrentes.
- Errores: `400 invalid_cursor`, `400 invalid_page_size`, `400 invalid_since`, `400 cursor_and_since_exclusive` (`cursor` y `since` juntos), `401`, `403 insufficient_scope`, `429` con `Retry-After`.

### `GET /api/v1/external/tramites/{id}/adjuntos/{adjuntoId}/url`

Devuelve una URL firmada de corta vida para descargar un adjunto del trámite (uso previsto: la factura).

```json
{ "url": "https://.../firmada?...", "expiraEn": "2026-09-21T10:30:00-05:00", "nombreArchivo": "factura.pdf", "contentType": "application/pdf" }
```

- Vigencia de la URL: **10 minutos** (mismo mecanismo y mismo tope que el resto de la plataforma; el ADR-0029 exige ≤ 15 min).
- `expiraEn` es **informativo**: el TTL real lo firma el servicio de almacenamiento y puede no devolverlo. El consumidor debe tratar la URL como de un solo uso inmediato y volver a pedirla si falla, en vez de confiar en `expiraEn`.
- 404 si el trámite o el adjunto no existen o el adjunto no pertenece al trámite.
- Exige `external.tramites.read`. Queda en la bitácora de acceso.

## 4. Ítem de trámite

```json
{
  "id": "0192b7c4-5e6a-7d10-9f21-3a4b5c6d7e8f",
  "radicado": "FT1-0001234",
  "consecutivo": 1234,
  "syncVersion": 48213,
  "fechaUltimoCambio": "2026-09-21T10:14:55-05:00",
  "eliminado": false,

  "estado": "aprobado",
  "tramite": { "codigo": "MATRICULA_NUEVA", "nombre": "Matrícula inicial", "familia": "MATRICULAS" },
  "fechaCreacion": "2026-09-01T08:00:00-05:00",
  "fechaRadicacion": "2026-09-01T09:30:00-05:00",
  "fechaAprobacion": "2026-09-20T16:02:10-05:00",

  "vehiculo": {
    "vin": "1HGBH41JXMN109186",
    "placa": "ABC123",
    "clase": "CAMIONETA",
    "marca": "MARCA EJEMPLO",
    "linea": "LINEA EJEMPLO",
    "modeloAno": 2026,
    "carroceria": "SUV",
    "cilindraje": 2000,
    "cilindrajeTexto": null,
    "capacidad": 5,
    "numeroMotor": "MTR000000",
    "numeroSerie": "SER000000",
    "tipoServicio": { "codigo": "PARTICULAR", "nombre": "Particular" }
  },

  "organismo": {
    "codigoTransito": "76520000",
    "nombre": "SECRETARIA DE TRANSITO EJEMPLO",
    "codigoSecretaria": "76520",
    "ciudad": "PALMIRA",
    "departamento": "VALLE DEL CAUCA"
  },

  "compradores": [
    {
      "ordinal": 1,
      "porcentajeParticipacion": 60.00,
      "rolActor": "comprador",
      "tipoPersona": "juridical",
      "tipoDocumento": "NIT",
      "numeroDocumento": "900000000",
      "nombreCompleto": "EMPRESA EJEMPLO SAS",
      "direccion": "CALLE 1 # 2-3",
      "ciudad": "PALMIRA",
      "celular": "3000000000",
      "correo": "contacto@ejemplo.test"
    },
    {
      "ordinal": 2,
      "porcentajeParticipacion": 40.00,
      "rolActor": "comprador",
      "tipoPersona": "natural",
      "tipoDocumento": "CC",
      "numeroDocumento": "1000000000",
      "nombreCompleto": "PERSONA EJEMPLO",
      "direccion": "CARRERA 4 # 5-6",
      "ciudad": "PALMIRA",
      "celular": "3100000000",
      "correo": "persona@ejemplo.test"
    }
  ],

  "factura": {
    "adjuntoId": "0192b7c4-9a1b-7c2d-8e3f-4a5b6c7d8e9f",
    "nombreArchivo": "factura.pdf",
    "cargadaEn": "2026-09-02T10:00:00-05:00"
  },

  "companiaGestora": {
    "tenantId": "0189a0b1-c2d3-7e4f-a5b6-c7d8e9f0a1b2",
    "nit": "901000000",
    "nombre": "TRAMITADORA EJEMPLO SAS"
  }
}
```

### Diccionario de campos

| Clave | Tipo | Descripción | PII |
|---|---|---|---|
| `id` | uuid | Identificador estable del trámite. Clave de upsert. | |
| `radicado` | string | Radicado FLIT, formato `FTn-NNNNNNN`. Único e inmutable. | |
| `consecutivo` | long | Consecutivo numérico global. | |
| `syncVersion` | long | Versión de sincronización, estrictamente creciente. | |
| `fechaUltimoCambio` | datetime | Último cambio del trámite o de sus datos relacionados. | |
| `eliminado` | bool | `true` = tombstone (borrado lógico). Con `true`, `vehiculo`, `organismo` y `factura` llegan en `null` y `compradores` en `[]`. | |
| `estado` | string | Código interno, siempre en minúscula (ver tabla de estados). `borrador` y `preparado` solo aparecen en trámites ya radicados que retrocedieron. | |
| `tramite.codigo` / `.nombre` / `.familia` | string | Tipo de trámite; familia `MATRICULAS` \| `TRASPASO` \| `OTROS`. | |
| `fechaCreacion` / `fechaRadicacion` / `fechaAprobacion` | datetime \| null | Aprobación = última transición a `aprobado`. | |
| `vehiculo.vin` / `.placa` | string \| null | | |
| `vehiculo.clase` / `.marca` / `.linea` / `.carroceria` | string \| null | `linea` equivale al «modelo» comercial. | |
| `vehiculo.modeloAno` | int \| null | Año modelo. | |
| `vehiculo.cilindraje` / `.cilindrajeTexto` | int \| null / string \| null | Si el valor origen no es numérico, `cilindraje=null` y el texto crudo va en `cilindrajeTexto`. | |
| `vehiculo.capacidad` | int \| null | Pasajeros. | |
| `vehiculo.numeroMotor` / `.numeroSerie` | string \| null | | |
| `vehiculo.tipoServicio.{codigo,nombre}` | object \| null | Normalizado (`PARTICULAR`, `PUBLICO`, …). | |
| `organismo.codigoTransito` | string \| null | Código RUNT del organismo (8 dígitos). | |
| `organismo.nombre` / `.ciudad` / `.departamento` | string \| null | | |
| `organismo.codigoSecretaria` | string \| null | Código DIVIPOLA del municipio (ej. `76520`). | |
| `compradores` | array | Actores `comprador` del trámite; si no hay ninguno, los `propietario`. Ordenado por `ordinal`. **Nunca `null`: vacío `[]` si no hay ninguno** (también en tombstone). Hasta 4 (copropiedad). | |
| `compradores[].ordinal` | int | Posición dentro del rol: `1` = principal, `2..4` = copropietarios. | |
| `compradores[].porcentajeParticipacion` | decimal \| null | Porcentaje de propiedad (2 decimales). `null` cuando hay un solo comprador (equivale a 100). Con 2+ compradores la suma es 100. | |
| `compradores[].rolActor` | string | `comprador` \| `propietario`. Todos los elementos comparten rol. | |
| `compradores[].tipoPersona` | string \| null | `natural` \| `juridical`. En jurídica, `nombreCompleto` es la razón social. | |
| `compradores[].tipoDocumento` | string \| null | Código canónico FLIT: `CC`, `NIT`, `CE`, `PAS`, `TI`, … | |
| `compradores[].numeroDocumento` | string \| null | | alta |
| `compradores[].nombreCompleto` | string \| null | FLIT no separa nombres y apellidos. | media |
| `compradores[].direccion` | string \| null | | alta |
| `compradores[].ciudad` | string \| null | | |
| `compradores[].celular` | string \| null | | media |
| `compradores[].correo` | string \| null | | alta |
| `factura` | object \| null | Adjunto de tipo factura más reciente. Descarga vía §3. | |
| `companiaGestora.{tenantId,nit,nombre}` | | Compañía que radicó el trámite. | |

Sin el scope `external.tramites.pii.read`, los campos marcados PII llegan enmascarados
(`"9****0000"`, `"c***@ejemplo.test"`), nunca ausentes.

**Bloques en `null`.** Todo trámite entregado ha superado el control de completitud de la radicación,
así que los bloques principales vienen poblados. Aun así, un campo sin dato llega siempre como `null`
—nunca ausente, nunca cadena vacía— y el consumidor debe tolerarlo sin descartar el ítem. El caso en
que pueden llegar bloques vacíos es el **retroceso**: un trámite que vuelve a `borrador` entra en
edición y sus datos pueden variar entre entregas.

**`compradores` vacío.** Un trámite radicado y no eliminado **puede llegar con `compradores: []`**:
durante un retroceso o una subsanación los actores se editan y pueden faltar entre dos entregas, y
existen tipos de trámite cuyo actor principal no es comprador ni propietario. El consumidor debe
guardar el ítem sin comprador, **nunca rechazarlo**; la siguiente entrega del trámite trae el estado
vigente.

### Estados del trámite

| Estado | Qué significa | ¿Terminal? | Puede pasar a | ¿Puerta de entrada? |
|---|---|---|---|---|
| `borrador` | La empresa arma el expediente. Único estado donde se editan datos | No | `anulado`, `preparado` | No — solo por retroceso |
| `preparado` | Expediente completo, aún **no radicado** | No | `entregado`, `preasignacion` | No — solo por retroceso |
| `preasignacion` | Radicado **sin placa**, esperando que el organismo la asigne | No | `asignado`, `rechazado` | **Sí** |
| `asignado` | El organismo asignó la placa; el gestor gestiona SOAT e impuestos | No | `entregado`, `preasignacion` | Sí |
| `entregado` | En manos del organismo para que decida | No | `aprobado`, `rechazado` | **Sí** |
| `aprobado` | El organismo aprobó | **No** | `revocado` | Sí |
| `rechazado` | El organismo rechazó; se reabre para subsanar | No | `borrador`, `anulado`, `entregado`, `preasignacion` | Sí |
| `anulado` | Anulado | **Sí** | — | Sí |
| `revocado` | El organismo deshace su propia aprobación | **Sí** | — | Sí |

Notas imprescindibles para el consumidor:

- **Terminales de verdad: solo `anulado` y `revocado`.** `aprobado` **no** lo es — el organismo puede
  revocar su propia aprobación después. Si el consumidor arranca procesos al aprobar, debe prever que
  la revocación llega más tarde.
- **`rechazado` revive por cuatro caminos.** Un trámite dado por cerrado puede volver a estar vivo.
- La **subsanación no es un estado**: es un indicador sobre `rechazado` que reabre la edición sin
  mover el estado. Durante la subsanación llegan cambios de datos y nuevas `syncVersion`, pero
  `estado` no cambia.
- `preasignacion` y `asignado` solo ocurren en los tipos que piden asignación de placa (hoy 4 de 96:
  matrícula inicial, matrícula leasing, rematrícula y duplicado de placa). **El resto —incluidos todos
  los traspasos— entra directamente por `entregado` y nunca pasa por `asignado`.**
- Liberan la placa: `rechazado`, `anulado`, `revocado`. El vehículo queda disponible para otro trámite,
  que tendrá un `id` distinto.

## 5. Guía de consumo

1. Obtener token; cachearlo hasta `expiresIn − 60 s`; ante 401 volver a pedir token una vez.
2. Primera corrida: `GET /tramites/sync?since=<hora real del arranque>&pageSize=500` (ver «Arrancar sin cargar el histórico»). Iterar mientras `hasMore=true` pasando `nextCursor`. Un cursor vacío entrega **todo el histórico**: úsese solo si se quiere esa carga.
3. Persistir `nextCursor` **solo después de aplicar** la página (no antes, y no solo al final de la corrida). Un fallo a mitad no deja huecos: el cursor no avanzó.
4. Corridas siguientes: `GET /tramites/sync?cursor=<guardado>&pageSize=500`.
5. Por cada ítem: upsert por `id`; si `syncVersion` ≤ el guardado, ignorar; si `eliminado=true`, aplicar la política local de borrado. Un estado desconocido no debe descartar el ítem.
6. Ante 429: esperar `Retry-After` y reintentar la misma página con el mismo cursor.
7. Para descargar la factura: `GET /tramites/{id}/adjuntos/{factura.adjuntoId}/url` y descargar la URL antes de `expiraEn`.
8. Frecuencia: corrida programada cada 5 min más corridas a demanda, **nunca dos a la vez** para el mismo cliente (ambas comparten cursor). Sin cambios, la respuesta es `items: []` con el mismo `nextCursor`: es la situación normal, no un error.

### Arrancar sin cargar el histórico

Si el consumidor NO quiere la población histórica y solo pretende seguir los cambios desde su puesta en
marcha, su primera llamada debe usar `since` con **la hora del reloj en el momento real del arranque**,
nunca una fecha escrita a mano ni planificada de antemano.

> **Aviso operativo.** La asignación inicial de `syncVersion` sella todo el histórico con la fecha de
> esa migración. Un `since` **anterior** a ese instante hace que **todo el histórico califique** y se
> entregue completo, paginado, sin error ni advertencia. Un `since` posterior arranca en el presente,
> que es el comportamiento buscado. La diferencia entre las dos cosas puede ser un solo segundo.

La decisión es reversible en cualquier momento: una sola corrida con **cursor vacío** vuelve a entregar
todo el histórico desde el principio.

## 6. Auditoría y datos personales

Cada solicitud queda registrada en FLIT (cliente, rango de `syncVersion`, cantidad de ítems, compañías
tocadas, IP, duración, resultado), con una **retención de 12 meses**. El consumidor es responsable del tratamiento posterior de los datos
personales conforme a la Ley 1581 de 2012 y de no exponerlos en logs ni documentación.
