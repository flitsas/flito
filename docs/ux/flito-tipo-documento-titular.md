# UX slim — Tipo de documento junto al número del titular (HU #11947 AC7)

> **Qué es este documento.** Entrada del `frontend-agent` para el AC7: pintar el **código ya
> resuelto** (`CC` / `NIT` / `PP` / `CE`) junto al número del titular, en las celdas y el detalle
> que **ya muestran** ese número. No hay pantalla nueva, no hay columna nueva, no hay estado nuevo.
>
> Formato **cerrado** (no reabrir): `CC 1020304050` — código + un espacio + número. Exacto. No
> `CC ·`, no etiqueta aparte, no mapeo `n`/`cc`/`ps`/`ce` en el front.

---

## Superficie tocada

Hoy el número del titular **no vive en las tres colas por igual**. El AC7 dice «en la fila **o** el
detalle»: se pinta donde el número **ya está**. No se inventa una columna de comprador en SOAT ni
en impuestos (las dos tablas ya están densas; SOAT la perdió a propósito en la HU #11905).

| Página | Archivo | Dónde está el número hoy | Qué cambia |
|---|---|---|---|
| `/flito/soat` | `apps/web/src/pages/FlitoSoat.tsx` | **Solo detalle** (`DetalleSoat`, lista «Compradores»: `{nombre} · {numero}`) | El `{numero}` pasa a `documentoConTipo(tipo, numero)`. La **cola no pinta titular**: no se añade celda. |
| `/flito/impuestos` | `apps/web/src/pages/FlitoImpuestos.tsx` | **Solo detalle** (`DetalleImpuesto`, `<Dato k="Documento" v={…}>`) | El `v` pasa a `documentoConTipo(compradorTipoDocumento, compradorDocumento)`. La **cola no pinta comprador**: no se añade celda. `AccionCertificacion` / PDF RUNT **no se tocan**. |
| `/flito/tramites` | `apps/web/src/pages/FlitoTramites.tsx` | **Fila**, columna Comprador, segunda línea (`text-[11px] tabular-nums`) | Esa línea pasa a `documentoConTipo(tipoDocumento, numeroDocumento)`. No hay modal de detalle del titular. |

**Una sola función** para las tres superficies: `documentoConTipo` en
`apps/web/src/components/flit/columnasComunes.tsx` (kit `flit/`, ya compartido). Las páginas no
duplican interpolación ni tabla de códigos. El API entrega el código; el front **imprime**.

**Contrato de datos (ya en el payload; ningún endpoint nuevo):**

| Superficie | Número | Código (`'CC' \| 'NIT' \| 'PP' \| 'CE' \| null`) |
|---|---|---|
| SOAT detalle | `compradores[].numeroDocumento` | `compradores[].tipoDocumento` |
| Impuestos detalle | `compradorDocumento` | `compradorTipoDocumento` |
| Trámites fila | `compradorPrincipal.numeroDocumento` | `compradorPrincipal.tipoDocumento` |

`null` = otro / ausente / desconocido / **canal Cliente** (el API no resuelve tipo ahí). El front
no infiere, no traduce `n`/`cc`/`ps`/`ce`, no rellena `CC` por defecto.

**Fuera de alcance (AC8 y este pedido):** `FlitoSoatSolicitud.tsx` (canal Cliente), certificación
RUNT / PDF, export Excel, `NIT {empresaNit}` de la columna Empresa gestora (es el NIT de la
compañía, no el documento del titular).

---

## Formato (regla única)

```
si no hay número  →  «—»   (el mismo hueco que ya pintan las pantallas)
si tipo es null   →  «1020304050»          (solo el número; sin prefijo, sin espacio suelto)
si tipo llega     →  «CC 1020304050»       (código tal cual + espacio + número)
```

Ejemplos canónicos (mismo número `1020304050`):

| `tipoDocumento` | Texto visible |
|---|---|
| `'CC'` | `CC 1020304050` |
| `'NIT'` | `NIT 1020304050` |
| `'PP'` | `PP 1020304050` |
| `'CE'` | `CE 1020304050` |
| `null` | `1020304050` |

Descartes (cerrados): `CC · 1020304050`; `<Dato k="Tipo">` aparte; `C.C.`; `Cédula`; mapear
códigos crudos de FLIT; prefijo inventado (`— 1020304050`, `DOC 1020304050`).

Layout: el mismo nodo de texto de hoy. En SOAT el ` · ` entre nombre y documento **se queda**
(`Ana Pérez · CC 1020304050`). En impuestos el rótulo del `<Dato>` sigue siendo **Documento**. En
trámites: nombre arriba, documento abajo, `tabular-nums` y `--flit-text-muted` igual. Varios
compradores en SOAT: cada `<li>` aplica la regla por su cuenta.

PII: el número **sigue en el body de la fila/detalle**, no en query ni path del SPA (AGENTS.md §14).
Sin cambio de logging ni de URL.

---

## Estados (4) + copy

Las tres colas **ya** tienen cargando / error+reintento / vacío / lleno. Este AC **no añade un
quinto estado** ni cambia copy de vacío ni de error.

| Estado | Comportamiento |
|---|---|
| Cargando | Sin cambio (`PageContentSkeleton` / spinner de la cola). |
| Error + reintento | Sin cambio. El tipo de documento no genera error de UI. |
| Vacío (cola sin filas) | Sin cambio. |
| Lleno | Solo cambia el **texto** de las superficies de la tabla de arriba. |

Huecos **dentro** de una fila llena (no son estados de página):

- Titular ausente en trámites (`compradorPrincipal === null`): sigue `—` en la celda.
- Número vacío: `—` (misma función).
- Tipo `null` con número presente: **solo el número**, no un vacío nuevo.

El canal Cliente en `/flito/soat` abre el **mismo** `DetalleSoat`. El API manda `tipoDocumento: null`
en esas filas → el texto queda idéntico a hoy (`nombre · número`). No hay condicional de rol para
ocultar el código: el `null` ya lo hace. `FlitoSoatSolicitud` no se toca.

---

## Permiso/slug

Sin slug nuevo, sin fila nueva en `PAGE_ROLES`.

| Página | `PageSlug` | Quién la ve (sin cambio) |
|---|---|---|
| `/flito/soat` | `flito_soat` | `admin`, `proveedor`, `auditor`, `cliente` |
| `/flito/impuestos` | `flito_impuestos` | `admin`, `gestor_impuestos`, `auditor` |
| `/flito/tramites` | `flito_tramites` | `admin`, `auditor` |

El AC7 nombra al **admin**. Los demás roles que ya ven esas superficies ven el **mismo** texto
(el código no es un privilegio). El rol `operaciones` no existe.

---

## Accesibilidad

Sin control nuevo. El texto `CC 1020304050` es el contenido del nodo existente (lector de
pantalla lo lee como «ce ce uno cero dos…» / «ene i te …» — aceptable; no se añade `aria-label`
que duplique). Contraste y `tabular-nums` de la línea tenue se conservan. Foco, botones Ver y
filtros: sin cambio.

---

## Notas para QA (≤10)

1. **Aserto positivo = texto exacto.** Con `tipoDocumento: 'CC'` y número `1020304050`, el nodo
   visible es exactamente `CC 1020304050` (`getByText` exacto / `toHaveTextContent` de esa cadena
   como valor completo del documento, no un `contains` suelto sobre la fila).
2. Lo mismo con `'NIT'`, `'PP'`, `'CE'`: `NIT 1020304050`, `PP 1020304050`, `CE 1020304050`. Un
   espacio. Cero puntos medios.
3. **Negativo sin `contains`.** Con `tipoDocumento: null` y número `1020304050`, el texto del
   documento es exactamente `1020304050`. Un `expect(fila).toContain('1020304050')` **deja pasar**
   `CC 1020304050`, `NIT 1020304050` o un prefijo inventado (`DOC 1020304050`). El aserto tiene que
   ser igualdad del string del documento, o `not.toHaveTextContent(/^CC |^NIT |^PP |^CE /)` **más**
   igualdad al número.
4. SOAT detalle, varios compradores: cada línea independiente (`Ana · CC 1020304050` y
   `Luis · 999` si el segundo viene con `null`).
5. Impuestos detalle: el `<dt>` sigue diciendo **Documento**; el `<dd>` es el string de la regla.
   No aparece un segundo campo «Tipo».
6. Trámites: segunda línea de la columna Comprador; el nombre no se concatena con el código.
7. Canal Cliente (AC8): en `/flito/soat` con fila de origen Cliente, el detalle muestra **solo el
   número** (API `null`). `/flito/soat/solicitud` **no cambia**.
8. Certificación RUNT / botón / PDF en la cola de impuestos: **idénticos** (no llevan el documento
   del titular).
9. Colas de SOAT e impuestos: **no** aparece una columna Comprador/Titular nueva. El admin que
   quiere el tipo abre **Ver**.
10. Front **sin** tabla `cc→CC` / `n→NIT` / `ps→PP`. Si el mock de E2E manda `'cc'` crudo, el UI lo
    pintaría `cc 1020304050` — eso es fallo del mock/API, no un mapeo a añadir.

---

## Decisiones y descartes

| Decisión | Por qué |
|---|---|
| No añadir columna de titular en cola SOAT / impuestos | El número no está ahí hoy; el AC pide el código **junto al número**, no una columna nueva. Slim = texto de la celda/detalle existente. |
| Un helper en `columnasComunes`, no tres interpolaciones | Tres páginas, una regla de `null`. Divergen si cada una escribe `` `${tipo} ${num}` ``. |
| Pintar el código tal cual, sin whitelist visual | La lista blanca es del backend. Filtrar en el front reintroduce la tabla que el AC prohíbe. |
| Cliente sin rama de UI | `null` del API = mismo texto de siempre. Un `if (esCliente)` sería el mapeo disfrazado. |
