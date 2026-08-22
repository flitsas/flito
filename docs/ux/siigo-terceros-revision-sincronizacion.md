# UX slim — Terceros de Siigo: revisar y sincronizar (HU #11299, Feature #11241)

> **Modo `slim`.** Los siete AC de la HU ya fijan el *qué* con un detalle inusual. Este documento
> resuelve el *cómo* de las tres superficies donde el AC dice qué debe verse pero no de qué forma,
> más los cuatro estados (AC2), los permisos (AC1), el aviso de modo simulado (AC7) y las notas
> para QA. No hay flowchart de flujo completo ni wireframes de pantallas no tocadas: la pantalla ya
> existe y la HU le añade una pestaña.
>
> Los tres bloques de **«requerimientos»** al final **no son opcionales de estilo**: uno de ellos
> (§R1) impide hoy cumplir el AC6 tal como está escrito.

---

## Contexto y encuadre

Pestaña nueva dentro de `apps/web/src/pages/SiigoParametrizacion.tsx` (229 líneas hoy). Reutiliza
ruta (`/siigo/parametrizacion`), slug (`siigo_parametrizacion`) y guarda (`ProtectedRoute`). **Sin
ítem de menú nuevo, sin migración de permisos, sin `PageSlug` nuevo.**

**El encuadre que cambia el diseño:** FLIT factura **una sola línea por factura** (el trámite
digital). Esto no es «alistar la cartera para seis conceptos»: es responder **cuántos clientes
pueden recibir esa factura**, y qué falta para que los demás también puedan. Por eso el panel
encabeza con un número —facturables sobre el total— y no con una tabla.

**La pantalla vuelve a tener pestañas, y hay que decirlo.** El comentario de cabecera del archivo
explica por qué se quitaron en la #11287: *«cuando solo queda una sección, una barra de pestañas es
un adorno»*. Ese razonamiento no se contradice, se cumple: **vuelven a ser dos secciones**. Se usa
el patrón que el repo ya tiene resuelto en `components/flito/comparendos/navegacionComparendos.tsx`
(`FlitPillGroup role="tablist"`, `role="tab"` con `aria-selected`, `tabIndex` itinerante, flechas
←/→ e Inicio/Fin, panel con `role="tabpanel"` y su `h2` `sr-only focus:not-sr-only`). **Ningún
patrón visual nuevo en toda la HU.**

```
┌─ Facturación electrónica — Parametrización ──────── [Ambiente: Pruebas ▾] ┐
└───────────────────────────────────────────────────────────────────────────┘
  ▸ banner de modo simulado (AC7 — existe, se le añade una frase)
  ▸ banner de compuerta (existe, sin cambios)

 ( Mapeo de conceptos )( Terceros )        ← tablist; ?seccion=terceros en la URL

┌─ A · ¿A cuántos se les puede facturar? ───────────────────────────────────┐
┌─ B · Clientes que todavía no (AC3, AC4) ──────────────────────────────────┐
┌─ C · Equivalencias de ciudad (AC5) ───────────────────────────────────────┐
┌─ D · Sincronizar terceros con Siigo (AC6) ────────────────────────────────┐
```

**El orden de los cuatro bloques es el orden en que se trabaja**, y no es decorativo: se corrige el
dato → se confirma la ciudad → se sincroniza. Sincronizar primero produce fallidos evitables que
gastan cuota de la ventana que se comparte con la emisión.

### La trampa del selector de ambiente — se desactiva, no se hereda

El selector «Ambiente» de la cabecera gobierna la compuerta y el mapeo de conceptos. **No gobierna
la sincronización de terceros:** `asegurarTercero` lee `env.SIIGO_AMBIENTE` en el servidor y ni
siquiera acepta un parámetro de ambiente. Un usuario que ponga «Producción» arriba y pulse
sincronizar creerá que escribió en producción.

Se resuelve con lo que ya hay: **una llamada a `GET /siigo/compuerta` SIN el parámetro `ambiente`**
devuelve `{ ambiente, modo }` del servidor. El bloque D los pinta en su encabezado:

> Se sincroniza contra el ambiente **pruebas** que tiene configurado el servidor. El selector de
> arriba no cambia esto: solo afecta al mapeo de conceptos y a la compuerta.

---

## Superficie 1 — Bloques A y B: qué le falta a un cliente (AC3, AC4)

### A · El número, antes que la tabla

Datos: `GET /siigo/clientes/validacion` → `{ total, facturables, noFacturables, pendientesClasificacion, porMotivo[] }`.

```
┌───────────────────────────────────────────────────────────────────────────┐
│  412 clientes activos · 118 pueden recibir factura electrónica            │
│  ████████░░░░░░░░░░░░░░░░░░░░░░░░  29 %                                   │
│                                                                           │
│  294 no pueden todavía, y de esos 37 esperan una decisión, no un dato.    │
│                                                                           │
│  Por dónde empezar:                                                       │
│   (Contacto 271)(Teléfono 268)(Ciudad 190)(Resp. fiscal 143)(Dirección 88)│
│   (Tipo de persona 31)(Nombre 12)(Identificación duplicada 6) …           │
│                                                                           │
│  Un cliente puede aparecer en varias líneas: resolver una causa no        │
│  siempre lo desbloquea.                                                   │
└───────────────────────────────────────────────────────────────────────────┘
```

- Las pastillas por motivo son **`FlitPillGroup` de filtro** (no pestañas): pulsar una fija
  `?motivo=` **en la petición**, nunca en la URL del SPA — ver §PII.
- Orden: **el que devuelve el servidor** (`porMotivo` viene ordenado por cantidad descendente y solo
  con `clientes > 0`). El navegador no reordena ni recalcula nada.
- El texto de cada pastilla es la etiqueta corta del motivo; la frase completa es
  `MOTIVOS_NO_FACTURABLE[motivo]`, importada de `@operaciones/shared-types`. **Cero copy nuevo para
  los motivos**: el catálogo ya está redactado en prosa de negocio («Falta la dirección.»), que es
  exactamente lo que evita que el detalle parezca un volcado de validación.
- La barra de progreso es decorativa (`aria-hidden`): el dato está en la frase.

### B · El detalle de un cliente — dos grupos, no una lista de seis errores

Datos: `GET /siigo/clientes/validacion/detalle?motivo=&limit=50&offset=` →
`{ total, data: VeredictoCliente[] }`, cada uno con `nombre`, `documento`, `pendienteClasificacion`
y `faltantes[] = { motivo, detalle, campo? }`.

```
┌───────────────────────────────────────────────────────────────────────────┐
│ Cliente                        Estado                Acción               │
├───────────────────────────────────────────────────────────────────────────┤
│ ▾ TRANSPORTES DEL SUR S.A.S.   ● Falta decidir 1     [Completar ficha]    │
│   NIT 900.123.456              ● Faltan 5 datos      [Sincronizar]        │
│                                                                           │
│   Hay que decidir (1)                                                     │
│    · Falta clasificar si es empresa o persona natural.                    │
│      Al clasificarlo pueden aparecer datos nuevos que ahora no se pueden  │
│      evaluar: el nombre solo se revisa cuando ya se sabe qué es.          │
│                                                                           │
│   Hay que capturar (5)                                                    │
│    · Falta la responsabilidad fiscal ante la DIAN.                        │
│    · Falta la dirección.                                                  │
│    · Falta el país, el departamento o la ciudad en códigos de Siigo.      │
│         → Se confirma abajo, en «Equivalencias de ciudad».  [Ir]          │
│    · Falta el teléfono separado en indicativo y número.                   │
│    · Falta el nombre de la persona de contacto.                           │
│                                                                           │
│ ▸ LOGÍSTICA ANDINA LTDA.       ● Faltan 2 datos      [Completar ficha]    │
│ ▸ CARLOS PÉREZ                 ● Puede facturarse    [Sincronizar]        │
└───────────────────────────────────────────────────────────────────────────┘
```

**Las cuatro decisiones que hacen que esto no parezca un volcado de errores:**

1. **Dos grupos con encabezado propio, no una lista.** El backend ya separa
   `MOTIVOS_PENDIENTE_CLASIFICACION` (tipo de persona, identificación duplicada, partición del
   nombre) del resto, y separa porque **se resuelven de forma distinta**: unos necesitan que alguien
   mire y decida, otros que alguien teclee. «Hay que decidir» va **primero** aunque casi siempre sea
   el grupo más pequeño: es el que bloquea al otro.
2. **La lista puede crecer al corregir, y se avisa antes.** `evaluarCliente` omite la revisión del
   nombre mientras el tipo de persona esté sin clasificar. Sin la frase de aviso, completar un dato
   y ver aparecer otro se lee como un error del sistema. Con ella, se lee como lo que es.
3. **El orden dentro de cada grupo es el del servidor** (identidad → nombre → fiscales → ubicación →
   teléfono → contacto), que es el orden de un formulario. No se ordena por «gravedad»: ninguno es
   más grave, todos bloquean por igual.
4. **Un `<li>` por carencia, con frase completa.** Un lector de pantalla anuncia «lista de 5
   elementos, elemento 1…», que es literalmente el «uno por uno» del AC4. Nada de motivos
   concatenados con comas ni escondidos en un `title`.

**Cómo se prioriza cuando faltan seis:** no se prioriza dentro del cliente —hay que llenarlos todos—
sino **entre clientes**, desde el bloque A. El resumen por motivo es la herramienta de priorización;
la ficha del cliente es la de ejecución. Por eso el detalle no lleva números de prioridad ni colores
por campo: sería una jerarquía inventada.

**«Llevar a su ficha en Clientes» se resuelve reusando el componente, no navegando.**
`components/clientes/FichaFiscal.tsx` es un `FlitModal` autónomo
(`clienteId`, `clienteNombre`, `editable`, `onClose`, `onGuardado`) que ya pinta el veredicto y la
ubicación. Se monta desde aquí con `editable={user?.role === 'admin'}` y `onGuardado` recarga el
resumen y la lista. Motivo: **hoy `/clients` no tiene enlace profundo** —`Clients.tsx` guarda el
cliente abierto en estado local (`fiscalDe`), no en la URL—, así que «llevar a su ficha» significaría
navegar a un listado de 500 y buscar a mano. Reusar el modal es además la opción que **no mete
ningún identificador de cliente en la URL**.

**Sincronizar se ofrece también a los no facturables, y es deliberado.** `asegurarTercero` exige
facturabilidad **solo en las ramas que escriben** en Siigo; la rama que **vincula** un tercero que
Siigo ya tiene funciona con la ficha local incompleta y encima **rellena los huecos** con lo que
Siigo sabe (`hidratarClienteDesdeSiigo`). Esconder el botón en las filas no facturables mataría
justo el camino que las rescata. La fila lo dice:

> Puede que Siigo ya lo tenga completo. Sincronizar lo vincula y, de paso, completa lo que falte
> aquí con lo que haya allá.

**Acción secundaria del motivo «identificación duplicada»:** botón
`[Volver a revisar los duplicados]` → `POST /siigo/clientes/validacion/recalcular-duplicados`
(solo `admin`). Es idempotente y **quita** marcas de conflictos ya resueltos: sin él, ese contador
no baja nunca y la lista deja de mirarse. Copy del resultado: «Se marcaron N y se quitaron M.»
**La interfaz nunca dice con qué otro cliente choca** —el backend tampoco lo dice—: son datos de un
tercero que no es el que se está mirando.

---

## Superficie 2 — Bloque C: equivalencias de ciudad (AC5)

Datos: `GET /siigo/clientes-ciudades/estado` (los seis contadores),
`GET /siigo/clientes-ciudades/propuestas` (todas las pendientes, con `certeza` y `candidatas[]`),
`POST /siigo/clientes-ciudades/:id/confirmar` (`{ countryCode, stateCode, cityCode }`, solo `admin`),
`GET /siigo/ciudades/buscar?q=` (mínimo 2 caracteres) y
`GET /siigo/clientes-ciudades/obsoletas`.

### La certeza: cuatro nombres, cero porcentajes

**No se muestra `puntaje`.** Es `1 − distancia/(longitud+1)`: un artefacto de la distancia de
edición. Pintarlo como «87 % de confianza» inventa una precisión que el cálculo no tiene y convierte
un dato dudoso en uno con apariencia de verificado —exactamente lo que el servicio evita en su
comentario de cabecera—. La certeza se comunica con **el nombre del estado + una frase que dice qué
hizo el sistema**, que es información verdadera y accionable:

| `certeza` | Chip (`StatusChip`) | Frase bajo la propuesta | Candidata preseleccionada |
|---|---|---|---|
| `exacta` | `success` «Coincide» | El texto escrito y el nombre del catálogo son el mismo, sin tildes ni puntuación. | Sí (hay una) |
| `aproximada` | `warning` «Se parece» | Difiere en una o dos letras. Puede ser una tilde o un dedazo — **o puede ser otro municipio**. | Sí (hay una) |
| `ambigua` | `draft` «Hay N posibles» | El mismo nombre existe en varios departamentos. **Elige cuál es.** | **No. Nunca.** |
| `sin_equivalencia` | `danger` «Sin equivalencia» | Lo escrito no se parece a ningún municipio: puede ser una dirección, una abreviatura o estar vacío. Búscalo. | No (hay buscador) |

El color no carga solo: cada fila lleva chip **con texto**, frase y un control distinto.

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Ciudad en códigos de Siigo · 190 clientes sin confirmar                   │
│  118 con propuesta directa · 46 ambiguas · 26 sin equivalencia             │
│  No hay «confirmar todas»: cada municipio sale impreso en una factura      │
│  ante la DIAN.                        Confirmadas en esta sesión: 12       │
├───────────────────────────────────────────────────────────────────────────┤
│ TRANSPORTES DEL SUR      «BOGOTA D.C.»   ● Coincide                        │
│    → Bogotá D.C. · Bogotá D.C.                          [Confirmar]        │
├───────────────────────────────────────────────────────────────────────────┤
│ LOGÍSTICA ANDINA         «Medellin»      ● Se parece                       │
│    → Medellín · Antioquia                               [Confirmar]        │
├───────────────────────────────────────────────────────────────────────────┤
│ AGRÍCOLA EL ROBLE        «San Pedro»     ● Hay 4 posibles                  │
│    ( ) San Pedro · Antioquia      ( ) San Pedro · Sucre                    │
│    ( ) San Pedro · Valle          ( ) San Pedro de Urabá · Antioquia       │
│                                                         [Confirmar]⊘       │
│    Elige un municipio para poder confirmar.                                │
├───────────────────────────────────────────────────────────────────────────┤
│ MINAS DEL NORTE          «Km 5 vía Cota» ● Sin equivalencia                │
│    [buscar municipio…        ]                          [Confirmar]⊘       │
└───────────────────────────────────────────────────────────────────────────┘
```

### Que confirmar cincuenta veces no sea un castigo — sin «confirmar todo»

El AC prohíbe la acción masiva. **Tampoco se ofrece «confirmar todas las exactas»**: es la misma
acción con otro nombre y con el mismo efecto (nadie miró esas cincuenta). Lo que sí se hace:

1. **Cola con foco encadenado.** Al confirmar una fila, esa fila colapsa a una línea confirmada y el
   foco salta al `[Confirmar]` de la siguiente pendiente. Cincuenta confirmaciones son cincuenta
   `Enter`, sin ratón y sin volver a buscar dónde estaba.
2. **Orden por certeza: `exacta` → `aproximada` → `ambigua` → `sin_equivalencia`.** Lo barato
   primero para que el trabajo avance de verdad.
3. **Y el automatismo se rompe a propósito donde importa.** El riesgo obvio del punto 2 es que
   cuarenta `Enter` seguidos entrenen la mano y las ambiguas se confirmen a ciegas. Por eso las
   ambiguas **no traen nada preseleccionado** y su botón está inhabilitado hasta elegir: la mano se
   detiene sola, sin necesidad de un diálogo de confirmación que nadie leería.
4. **Cada confirmación es definitiva por sí sola.** Son `POST` independientes: si la número 31 falla,
   las 30 anteriores están confirmadas y no se pierden. La fila fallida se queda con su error inline
   y `[Reintentar]`; la cola sigue.
5. **Contador de avance** («Confirmadas en esta sesión: 12») con una región `aria-live="polite"` que
   anuncia solo el desenlace: «Bogotá D.C. confirmada. Quedan 37.» No se anuncia el movimiento del
   foco: eso ya lo dice el lector al llegar al control.
6. **Sin recargar la lista entera tras cada confirmación.** La fila se resuelve en local con la
   respuesta (`{ clienteId, cityCode, cityName }`); `/propuestas` se vuelve a pedir solo al reabrir
   el bloque.

**Equivalencias obsoletas** (`/obsoletas`): un aviso plegado al pie del bloque, solo si `total > 0`.
«N clientes cambiaron su ciudad escrita después de confirmarse: los códigos que viajan a Siigo son
los viejos.» Cada uno se reabre como una fila pendiente más. No lo pedía el AC; cuesta una llamada y
sin él el síntoma es una factura con el municipio anterior.

**Coste, dicho sin adornos:** `/estado` calcula internamente las propuestas de toda la cartera, así
que pedir `/estado` y `/propuestas` es hacer el mismo barrido dos veces. Mitigación de esta HU: el
bloque C **nace plegado** y solo pide `/propuestas` al abrirse; `/estado` se pide una vez al entrar
a la pestaña. Si el p95 de cualquiera de los dos pasa de ~1,5 s con la cartera real, la salida es de
backend (§R3), no de interfaz.

---

## Superficie 3 — Bloque D: el resultado por cliente de la sincronización (AC6)

### Lo que hay de verdad detrás del botón

- **No existe endpoint de lote.** Solo `POST /siigo/terceros/cliente/:clienteId`, uno por cliente.
- **Limitador: 60 sincronizaciones por 15 minutos y por usuario.** Y cada llamada puede gastar hasta
  **3 peticiones** de la ventana de 100/minuto que la empresa **comparte con la emisión de facturas**.
- Desenlaces reales del servicio: `vinculado_existente`, `creado`, `actualizado` y **`sin_cambios`**.

**Son cinco, no cuatro, y el quinto no se puede disimular.** El AC nombra cuatro; el servicio
devuelve además `sin_cambios`, que significa «la huella coincide, no se llamó a Siigo». Plegarlo
dentro de «actualizado» sería afirmar una escritura que no ocurrió. Tiene su propia fila.

### Cómo se distinguen de un vistazo — y sobre todo «vinculado» frente a «creado»

Esa es la distinción con consecuencia contable: **creado** significa que ahora hay un tercero nuevo
en Siigo Nube que antes no existía; **vinculado** significa que ya había uno, con su historia
contable, y que las facturas de FLIT van a salir contra él. Se separan en **cuatro ejes a la vez**,
no solo por color:

| | `creado` | `vinculado_existente` |
|---|---|---|
| Chip | `success` **«Creado en Siigo»** | `active` **«Vinculado a uno que ya existía»** |
| Símbolo (`aria-hidden`) | `✚` | `🔗` |
| Frase | Antes no existía. Ahora hay un tercero nuevo con este NIT y esta sucursal. | Ya había un tercero con este NIT y esta sucursal. **No se creó nada: se apuntó a él**, y las facturas saldrán contra su contabilidad. |
| Acción sugerida | ninguna | **`[Ver el tercero en Siigo]`** (identificador visible y copiable) |

`vinculado_existente` es el **único** desenlace con acción de verificación, y la razón es literal:
es el único donde la ficha contable del tercero no la puso FLITO. Enseñar el `siigoCustomerId` en
ambos casos, pero ofrecer la verificación solo en uno, es lo que hace que la diferencia se lea sin
tener que compararlas.

### Los cinco desenlaces + el fallo

| Desenlace | Chip | Frase |
|---|---|---|
| `creado` | `success` «Creado en Siigo» | Antes no existía. Ahora hay un tercero nuevo con este NIT y esta sucursal. |
| `vinculado_existente` | `active` «Vinculado a uno que ya existía» | No se creó nada: ya había un tercero con este NIT y esta sucursal, y se apuntó a él. |
| `actualizado` | `active` «Actualizado en Siigo» | Ya estaba vinculado y algo había cambiado: se reenvió la ficha completa. |
| `sin_cambios` | `neutral` «Ya estaba al día» | Nada cambió desde la última vez. **No se llamó a Siigo.** |
| fallo | `danger` «No se pudo» | El motivo del servidor, palabra por palabra + `[Reintentar este]` |

**Agrupado por desenlace, y los fallos arriba.** Orden: fallos → `creado` → `vinculado_existente` →
`actualizado` → `sin_cambios`. Lo que exige que alguien actúe va primero; el éxito se comprueba en
el encabezado de tres números y no se lee fila a fila. Ningún grupo con cero se pinta.

```
╔═ Sincronización · 25 clientes ══════════════════════════════════════════╗
║  Ambiente pruebas (del servidor)          🧪 SIMULADO — nada llegó a    ║
║                                              Siigo Nube                 ║
║  23 sincronizados · 2 no se pudieron                                    ║
║  ────────────────────────────────────────────────────────────────────   ║
║  ▾ ⛔ No se pudo (2)                                                    ║
║     · MINAS DEL NORTE — Falta la dirección. Falta el nombre de la       ║
║       persona de contacto.                    [Completar ficha]         ║
║     · CARGA RÁPIDA — Otro cliente de FLITO ya está vinculado a esa      ║
║       identificación y sucursal.              [Revisar duplicados]      ║
║  ▾ ✚ Creados en Siigo (simulado) (7)                                    ║
║     TRANSPORTES DEL SUR · id 4471   …                                   ║
║  ▾ 🔗 Vinculados a uno que ya existía (simulado) (9)                    ║
║     LOGÍSTICA ANDINA · id 118  [Ver en Siigo]   …                       ║
║  ▸ ↺ Actualizados (4)          ▸ ● Ya estaban al día (3)                ║
║                                                    [Cerrar]             ║
╚═════════════════════════════════════════════════════════════════════════╝
```

### Cómo se lanzan 25 llamadas sin romper la cuota de la emisión

- **Tandas de 25 como máximo.** Cabe tres veces en la ventana de 60/15 min y deja margen para
  reintentos.
- **Secuencial, nunca en paralelo**, con una pausa mínima entre llamadas para no pasar de ~20 por
  minuto: cada una puede costar 3 peticiones de la ventana que comparte con las facturas.
- **Progreso visible**: «8 de 25 · aproximadamente 1 minuto». Botón primario inhabilitado mientras
  corre (esto es lo que impide pulsar dos veces).
- **`[Detener]`**, no «cancelar»: detiene antes de la siguiente llamada. **Lo ya sincronizado queda
  sincronizado** y se dice con esas palabras. Nada de deshacer: no hay deshacer.
- **Una cartera de 400 clientes son ~100 minutos por el limitador, y el panel lo dice antes de
  empezar**, no después de la primera tanda: «Se sincronizan de 25 en 25. Con 294 pendientes son
  unas 12 tandas.»
- **429** → «Demasiadas sincronizaciones seguidas. Espera unos minutos.» + `[Reintentar]`. Los ya
  hechos no se repiten.
- **Sin respuesta (`ApiError.status === 0`)** → «No hubo respuesta. **Puede que el tercero sí se
  haya creado en Siigo.** Vuelve a sincronizar ese cliente para comprobarlo: si ya existía, el
  resultado dirá "Ya estaba al día" o "Vinculado".» Es el único caso donde el reintento se explica
  en vez de ofrecerse a ciegas — y aquí sí es seguro, porque el servicio consulta antes de crear.

---

## Los 4 estados (AC2)

Se listan por superficie con datos propios. **El error va siempre antes que el vacío:** si la
consulta falló no se sabe si hay algo, y decir «no hay» sería afirmar lo que nadie comprobó. Es la
regla que ya sigue `ContadoresFacturacion`.

### A · Resumen de facturabilidad

| Estado | Qué se ve |
|---|---|
| Cargando | `role="status"` · «Revisando la cartera…». El bloque reserva su alto para que B no salte. |
| Error | `role="alert"` · «No se pudo revisar la cartera: `<mensaje del servidor>`» + `[Reintentar]`. **Los bloques C y D siguen en pie**: un fallo del informe no tumba la pestaña. |
| Vacío | `total === 0` → «No hay clientes activos. Facturación electrónica no tiene a quién facturarle todavía.» · `noFacturables === 0` → «Los 412 clientes activos pueden recibir factura electrónica. No hay nada que corregir aquí.» (y el bloque B no se pinta) |
| Lleno | La tarjeta de arriba, con las pastillas por motivo. |

### B · Lista de clientes

| Estado | Qué se ve |
|---|---|
| Cargando | Tres filas esqueleto con la altura real; `aria-busy="true"` en la tabla. |
| Error | «No se pudo traer la lista: `<mensaje>`» + `[Reintentar]`. El resumen de arriba se mantiene si él sí cargó. |
| Vacío | Sin filtro: «Ningún cliente activo tiene datos pendientes.» Con filtro de motivo: «Ningún cliente tiene pendiente “Falta la dirección”. Quita el filtro para ver el resto.» + `[Quitar filtro]`. **Los dos vacíos no dicen lo mismo y no comparten copy.** |
| Lleno | Filas plegables; paginación de 50 con `total` del servidor. |

### C · Equivalencias de ciudad

| Estado | Qué se ve |
|---|---|
| Cargando | «Comparando las ciudades escritas con el catálogo…» · `role="status"`. Puede tardar: es toda la cartera contra 4.605 municipios. |
| Error | Dos mensajes distintos, porque son dos problemas distintos: **409 `catalogo_vacio`** → «El catálogo de ubicaciones no tiene ciudades activas. Cárgalo antes de proponer equivalencias.» + `[Ir al catálogo]` (solo `admin`). Cualquier otro → «No se pudieron calcular las equivalencias: `<mensaje>`» + `[Reintentar]`. **Sin esta distinción, un catálogo vacío se leería como “ningún cliente tiene equivalencia”**, que manda a corregir 400 fichas a mano en vez de cargar un archivo. |
| Vacío | «Todas las ciudades están confirmadas en códigos de Siigo.» (+ el aviso de obsoletas si lo hay). |
| Lleno | La cola de confirmación. |

### D · Sincronización

| Estado | Qué se ve |
|---|---|
| Cargando | Progreso «8 de 25», botón inhabilitado, `[Detener]` disponible, `role="status"`. |
| Error | Fallo de **toda** la tanda (429, red caída): mensaje único arriba + `[Reintentar los que faltan]`. Fallo **de un cliente**: no es este estado, es una fila del resultado. |
| Vacío | Sin selección: «Marca los clientes que quieras sincronizar.» Con 0 clientes en la lista: «No hay clientes que sincronizar.» El botón **nunca se pinta con 0** (evita el `disabled:opacity-50` que baja el contraste del botón primario). |
| Lleno | El panel de resultados agrupado. |

---

## AC7 — el aviso de modo simulado

Permanente, no un toast, y **con las dos afirmaciones**. La pantalla ya tiene el banner
(`SiigoParametrizacion.tsx:89-107`, condicionado a `compuerta?.modo === 'mock'`), pero su segundo
párrafo solo habla de la compuerta. **Se le añade una frase dependiente de la pestaña activa** —el
banner es del nivel de página y no se duplica—:

- Pestaña **Mapeo de conceptos** (hoy): sin cambios.
- Pestaña **Terceros**:

> **Modo simulado: los datos vienen del simulador, no de Siigo.**
> Los terceros que aparezcan como creados o vinculados **no existen en Siigo Nube**: no se creó ni
> se modificó nada allá. Cuando se conecte el ambiente real habrá que volver a sincronizarlos.

Y —esto es lo que de verdad impide la media verdad— **la marca viaja también donde estaría la
mentira**: en modo simulado cada grupo del panel de resultados lleva «(simulado)» en su encabezado
(«Creados en Siigo (simulado)») y el encabezado del panel repite el distintivo. Un banner arriba y
un «Creado en Siigo» abajo, en una captura de pantalla recortada, dicen cosas opuestas.

---

## Permiso y comportamiento por rol (AC1)

Slug: **`siigo_parametrizacion`** (existente). Roles que lo tienen: administración y financiera.

| Elemento | `admin` | `financiera` | Sin el slug |
|---|---|---|---|
| Pestaña «Terceros», bloques A–D | sí | sí | `NoAccess` |
| Ficha fiscal del cliente | sí, **editable** | sí, **solo lectura** (`editable={false}`) | — |
| `[Confirmar]` una ciudad | sí | **no disponible, visible y explicado** | — |
| `[Sincronizar]` / `[Sincronizar N]` | sí | **no disponible, visible y explicado** | — |
| `[Volver a revisar los duplicados]` | sí | **no disponible, visible y explicado** | — |
| `[Cargar el catálogo de ubicaciones]` | sí | no se pinta (vive en otra pantalla) | — |

**Cómo se ve un control que existe pero no está disponible.** No ausente y no `disabled` a secas:

- Se usa **`aria-disabled="true"` en vez de `disabled`**, con el `onClick` neutralizado. Motivo
  concreto: `disabled` saca el botón del orden de tabulación, así que quien navega con teclado o con
  lector **no llega nunca al control ni a su explicación** — la misma razón por la que el documento
  de la HU #11329 separó el botón inhabilitado de su «¿Por qué no?».
- La explicación se escribe **una sola vez por bloque**, en un `<p id="permiso-ciudades">` bajo el
  encabezado, y cada botón la referencia con `aria-describedby`. Repetirla en cincuenta filas sería
  cincuenta anuncios idénticos.
- Copy (bloque C): «Confirmar una ciudad fija el municipio que se imprime en la factura ante la
  DIAN: lo hace administración. Tu rol puede revisar las propuestas y avisar qué falta.»
  Copy (bloque D): «Sincronizar escribe en Siigo: lo hace administración.»
- Estilo del control no disponible: opacidad **no** por debajo del 4,5:1 del texto. `disabled:opacity-50`
  del `flitBtnPrimary` no cumple; para este caso se usa el secundario con
  `color: var(--flit-text-muted)` sobre blanco (5,12:1 con el token vigente).

**⚠ Divergencia real entre el AC1 y el servidor — hay que resolverla antes de implementar (§R2).**
El AC dice que **solo administración** dispara la sincronización. El servidor no dice eso:
`terceros.routes.ts` guarda el `POST` con `exigirAccionSiigo('emitir')`, que resuelve a
`['admin', 'financiera']`. Es decir: financiera **puede** sincronizar llamando al endpoint. Esta
especificación implementa el AC (botón no disponible para financiera) y deja constancia de que la
interfaz estaría entonces siendo más estricta que el servidor —que es el sentido seguro, pero es una
divergencia, y las divergencias se cierran, no se heredan—.

---

## Datos personales (AGENTS.md §14, Ley 1581)

1. **Nada de PII en la URL del SPA.** Lo único que va a la URL es `?seccion=terceros`. El filtro de
   motivo, la página, la selección de clientes y el resultado de la sincronización viven en **estado
   de React**. `?motivo=` existe pero solo en la **petición al API**, y es un código de catálogo, no
   un dato de nadie.
2. **El buscador de la lista filtra en cliente sobre lo ya cargado.** El endpoint no acepta búsqueda
   por nombre ni por documento — y no se pide que la acepte: sería un parámetro con PII en un query
   string que acaba en logs de proxy.
3. `GET /siigo/ciudades/buscar?q=` **sí** lleva texto en la query, y es correcto: es un nombre de
   municipio del catálogo público de la DIAN, no un dato del titular.
4. **Nombre y documento se muestran** —son la identidad operativa del tercero (`identification` +
   `branch_office` es su clave en Siigo) y ambos roles ya los leen en Clientes— **pero no se
   registran**: ningún `console.log`/`console.error` con la fila, el veredicto o la respuesta. Los
   errores se pintan con `errorMessage(e)` y nada más.
5. **Los motivos se pintan literales.** El contrato esperado del validador es «Falta la dirección.»,
   nunca «la dirección "Cra 7 #32-16" es inválida». Si algún `detalle` llegara a traer el **valor**
   de un dato personal, aparecería en un panel que se comparte por captura de pantalla. Va como
   caso de prueba (nota QA 10).
6. **El conflicto de identificación no nombra al otro cliente.** Ni el backend lo hace ni la interfaz
   lo deduce.

---

## Requerimientos para architecture/backend

### R1 — **Bloqueante del AC6**: un cliente no facturable devuelve hoy un 500 genérico

`asegurarTercero` relanza `ClienteNoFacturableError` a propósito («el fallo del validador sube TAL
CUAL… borraría lo único que sirve para arreglarlo: la lista de qué campo falta»). Pero
`terceros.routes.ts` solo traduce `SiigoTerceroError`; cualquier otra excepción cae en
`errorHandler.ts:45` → **`500 { error: 'Error interno del servidor' }`**. Resultado: el fallo **más
frecuente** de la sincronización —le falta un dato— llega a la pantalla como avería genérica, y el
AC6 («fallido **con motivo**») no se puede cumplir por más que la interfaz se esfuerce.

**Petición:** mapear `ClienteNoFacturableError` a **409** con `{ error, codigo: 'cliente_no_facturable', faltantes: FaltanteCliente[] }`.
Con eso la fila fallida pinta la misma lista «uno por uno» del AC4 y el botón `[Completar ficha]`.
Es un `catch` más en una ruta que ya tiene la forma hecha.

### R2 — Cerrar la divergencia de permisos del AC1

O el `POST /siigo/terceros/cliente/:id` pasa a exigir `admin` (coherente con `ciudades-mapeo`, que
ya usa `requireRole('admin')` para confirmar), o el AC1 se corrige para admitir a financiera.
Decisión de tech-lead/PO, no de UX. **Mientras tanto la interfaz implementa el AC.**

### R3 — Recomendados, no bloqueantes (con su coste medido)

| # | Qué | Por qué | Coste de no hacerlo |
|---|---|---|---|
| a | Que la respuesta de `POST /siigo/terceros/cliente/:id` incluya `camposCompletados: string[]` (**nombres** de campo, jamás valores) | `hidratarClienteDesdeSiigo` **escribe en `clients`** al vincular. Hoy eso solo queda en `siigo_operaciones`. | La ficha de un cliente cambia y la pantalla no lo puede decir: una escritura silenciosa sobre datos del titular |
| b | `GET /siigo/terceros?clienteIds=` (lote) | Saber quién ya está vinculado | Una petición por fila, o no mostrarlo. Esta spec **no lo muestra** |
| c | Paginación (`limit`/`offset`) en `/clientes-ciudades/propuestas`, y que `/estado` no recalcule las propuestas | `/propuestas` devuelve la cartera entera sin tope y `/estado` repite el mismo barrido | Payload grande y doble cálculo. Mitigado con bloque plegado; si el p95 pasa de ~1,5 s, deja de ser mitigable |

---

## Notas para QA (insumo de TCs)

1. **AC1 · financiera**: ve los cuatro bloques y las propuestas de ciudad; los botones `[Confirmar]`,
   `[Sincronizar]` y `[Volver a revisar los duplicados]` **existen, se alcanzan con `Tab`**, tienen
   `aria-disabled="true"` y anuncian la explicación por `aria-describedby`. Ninguna petición de
   escritura sale al pulsarlos. La ficha fiscal abre en solo lectura.
2. **AC1 · admin**: los tres botones funcionan. Un rol sin el slug cae en `NoAccess`.
3. **AC2 · los cuatro estados de los cuatro bloques**, con el error **antes** que el vacío: con
   `/validacion` en 500 el panel dice «no se pudo revisar», **nunca** «no hay clientes pendientes»,
   y los bloques C y D siguen usables.
4. **AC2 · catálogo vacío**: `/propuestas` con 409 `catalogo_vacio` muestra el mensaje del catálogo
   y su enlace, **no** «todas las ciudades están confirmadas».
5. **AC4**: un cliente con 6 faltantes pinta **dos grupos** con encabezado, un `<li>` por carencia y
   el **texto exacto** de `MOTIVOS_NO_FACTURABLE` (mock con un `detalle` inventado: debe salir tal
   cual). Al clasificar el tipo de persona desde la ficha, la lista puede **crecer** y eso no es un
   fallo: el aviso tiene que estar visible antes.
6. **AC5 · ambigua**: con `certeza: 'ambigua'` y 4 candidatas **ninguna viene marcada** y
   `[Confirmar]` está inhabilitado hasta elegir. **No existe en toda la pestaña ningún control que
   confirme más de una ciudad a la vez** (ni «confirmar todas las exactas»).
7. **AC5 · cola**: al confirmar, el foco pasa al `[Confirmar]` siguiente y la región `aria-live`
   anuncia el municipio y cuántas quedan. Si la confirmación 3 devuelve 400, las 2 anteriores siguen
   confirmadas y solo la 3 muestra error con `[Reintentar]`.
8. **AC6 · cinco desenlaces**: una tanda que devuelva `creado`, `vinculado_existente`, `actualizado`,
   `sin_cambios` y un fallo pinta **cinco grupos distintos**, con los fallos primero.
   `creado` y `vinculado_existente` se distinguen por chip **y** por texto **y** por tener o no
   `[Ver en Siigo]`. `sin_cambios` **no** se cuenta como actualizado.
   Caso obligatorio (§R1): un cliente no facturable debe mostrar **sus faltantes**, no «Error interno
   del servidor». *Este caso falla hoy: es la prueba que sostiene el requerimiento.*
9. **AC7 · modo simulado**: con `modo: 'mock'` el aviso está siempre visible (no es un toast), dice
   **las dos cosas** (simulador **y** «no existen en Siigo Nube»), y los grupos del resultado llevan
   «(simulado)». Con `modo: 'real'` no aparece nada de eso.
   **Ambiente**: cambiar el selector de la cabecera a «Producción» **no** cambia lo que dice el
   bloque D, que muestra el ambiente devuelto por `GET /siigo/compuerta` sin parámetros.
10. **PII y disciplina de red**: tras filtrar por motivo, paginar, seleccionar 25 clientes y
    sincronizar, la URL solo contiene `?seccion=terceros`; ningún nombre ni documento aparece en la
    query string ni en la consola del navegador. Ninguna petición de sincronización sale en paralelo
    (una a la vez), y con 25 seleccionados salen **25** peticiones, no 26. Caso adicional: un
    `detalle` de motivo que traiga un valor personal debe detectarse en revisión — el contrato es el
    nombre del campo, no su contenido.

---

## Decisiones y descartes

1. **Ningún patrón visual nuevo.** Pestañas = el patrón de `MarcoComparendos`. Tarjetas = `FlitCard`.
   Tabla = `FlitTable`. Chips = `StatusChip` con los seis tonos existentes. Plegables =
   `<details>`/`<summary>`. Ficha del cliente = `FichaFiscal` tal cual. Botones = `flitBtnPrimary` /
   `flitBtnSecondary` / `flitBtnSecondarySm`.
2. **Descartado: mostrar el `puntaje` de la equivalencia** (como porcentaje, estrellas o barra). Es
   una función de la distancia de edición, no una probabilidad. Vestirla de porcentaje es
   exactamente el «dato dudoso con apariencia de verificado» que el servicio evita a propósito.
3. **Descartado: «Confirmar todas las exactas».** Es la acción masiva que el AC5 prohíbe, con otro
   nombre. Lo que se mejora es la **velocidad de confirmar una a una** (foco encadenado), no el
   número de decisiones.
4. **Descartado: enlace profundo a `/clients?fiscal=<id>`.** Habría requerido tocar `Clients.tsx`
   para leer el parámetro (alcance de otra HU) y metería un identificador de cliente en la URL.
   Reusar el modal `FichaFiscal` desde aquí cuesta cinco líneas y no navega.
5. **Descartado: esconder `[Sincronizar]` en los clientes no facturables.** Vincular no exige la
   ficha completa y encima la rellena desde Siigo: esconderlo mataría el rescate. Depende de §R1
   para que su fallo sea legible.
6. **Descartado: consultar el vínculo (`GET /siigo/terceros/cliente/:id`) por fila.** Sería una
   petición por cliente para pintar una columna. Se pinta solo lo sincronizado en la sesión, y el
   lote queda como §R3-b.
7. **Descartado: plegar `sin_cambios` dentro de «actualizado».** Serían cuatro desenlaces como pide
   el AC, a cambio de afirmar una escritura en Siigo que no ocurrió.
8. **Descartado: un diálogo de confirmación antes de sincronizar la tanda.** La operación es
   idempotente por construcción (se consulta antes de crear) y el diálogo se convertiría en un
   `Enter` más. Lo que sí hay: tope de 25, progreso, `[Detener]` y el ambiente escrito **en el
   botón**, que es donde se mira antes de pulsar.
9. **Pregunta abierta para el PO (no bloquea):** con 294 pendientes, sincronizar la cartera entera
   son ~12 tandas y ~100 minutos por el limitador de 60/15 min. Si el negocio necesita una pasada
   completa en un cierre, eso es un trabajo de servidor (una cola, como la de emisión), no un botón
   con más paciencia. Esta HU no lo asume.

---

```
HANDOFF
  Modo: slim
  Entrega: docs/ux/siigo-terceros-revision-sincronizacion.md
  Pantallas: 1 (SiigoParametrizacion: 1 pestaña nueva con 4 bloques; ningún PageSlug nuevo)
  Requerimientos nuevos de datos: 2 (§R1 bloqueante del AC6, §R2 divergencia de permisos)
                                  + 3 recomendados (§R3 a/b/c)
  Siguiente: architecture/backend por §R1 (mapear ClienteNoFacturableError a 409 con faltantes)
             y tech-lead/PO por §R2 (¿financiera sincroniza o no?).
             Con esas dos cerradas → frontend-agent implementa.
```
