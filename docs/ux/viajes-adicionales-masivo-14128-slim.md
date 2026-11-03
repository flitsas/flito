# UX slim — Viajes adicionales, registro masivo con valor por LT (HU #14128)

Épica 13758 · Feature #14095 · Mockup: pendiente (el hilo publica el Artifact `design` y espera el «ok»).

## Superficie tocada

- Pantalla: `apps/web/src/pages/FlitoLogistica.tsx` (consola «Logística», público operador, tono **tuteo**: «Ve a…», «Sincroniza…», «Selecciona…»).
- Análogas leídas: `components/flito/logistica/ModalRegistrarViaje.tsx` (individual, por trámite, desde el detalle) y `ViajesLogistica.tsx` (sección «Viajes adicionales»). El masivo **no** toca el modal individual ni el detalle.
- Cambio: una **pestaña nueva «Viajes adicionales»** junto a «Trámites / Generación de actas / Actas». Es una vista de trabajo, no un modal: 200 filas no caben en un `FlitModal`. No hay ruta ni `PageSlug` nuevos (la pestaña vive en la página existente, `tab` es estado local).
- Código nuevo previsto (para frontend): `components/flito/logistica/ViajesMasivo.tsx` (+ helper en `lib/viajesLogistica.ts`). `FlitoLogistica.tsx` solo suma la pestaña, condicionada al permiso.
- Endpoint: `POST /api/flito/logistica/viajes/masivo` (placa en el BODY, `Idempotency-Key`). Sin endpoints inventados: no existe un listado de vehículos/LT para elegir, por eso la entrada es por placa (ver Decisiones).

**Qué vino a hacer quien abre esto:** registrar el mismo viaje adicional a muchas LT de una vez, con el valor de cada una, y saber con certeza cuáles quedaron y cuáles no.

## Delta de claridad (qué se ve / qué se calla)

Se ve primero: la lista de placas con su valor (el trabajo) y el contador `n / 200`. Una sola primaria: **«Registrar N viajes»**.

| Zona | Contenido |
|---|---|
| 1. Entrada | Un cuadro «Placas» donde se **pega** una lista (de Excel: una por línea; opcional segunda columna con el valor) o se escribe, y el botón secundario «Agregar a la lista». |
| 2. Lista | Una fila por placa: casilla, placa, valor, ✕. Barra superior de la lista: «Valor para todas las seleccionadas» + «Aplicar», «Quitar seleccionadas». |
| 3. Cierre | Primaria «Registrar N viajes» (N = seleccionadas con valor válido). |
| 4. Resultado | Reemplaza la lista: resumen «Se registraron X · No se registraron Y», tabla de rechazadas con motivo, tabla de registradas plegada. |

Se calla (no está): tarifa vigente, comparaciones con la tarifa, motivo/detalle del viaje (el masivo no los envía; contrato `{placa, valor}`), selección de trámite en los casos de varios aprobados (solo se informa), números de viaje internos fuera del resultado. Densidad: **no empeora** la consola; la pestaña es aparte y no suma columnas a «Trámites».

Selección: las casillas definen **a qué filas aplica** «Aplicar a las seleccionadas», «Quitar» y «Registrar». Al agregar placas entran **seleccionadas**. Desmarcar una la deja en la lista sin enviarla.

### Cómo se ingresan las placas (propuesta cerrada)

- **Pegar o escribir** en un `textarea`; separadores: salto de línea, coma, punto y coma, espacio o tabulación. Si una línea trae dos columnas (`ABC123<TAB>350000`), la segunda llena el valor de esa fila (copiar y pegar desde Excel). Valor con puntos o `$` de miles se limpia (`350.000` -> 350000).
- Se normaliza en mayúsculas y sin espacios. Duplicadas dentro de lo pegado o ya en la lista **no se agregan** y se avisan: «Se omitieron 3 placas repetidas.» (el servidor igual valida `PLACA_REPETIDA`).
- No se valida el formato de la placa en el cliente más allá de no vacía: la fuente de verdad es el servidor (`PLACA_INVALIDA`), y así no se duplica una regla.
- Seleccionar de una lista de LT: **fuera de alcance** (no hay endpoint de listado por vehículo). Pregunta 1.

### Más de 200 (propuesta cerrada)

Tope duro de **200 filas en la lista** (contador `n / 200` visible, en `--flit-danger-ink` al llegar a 200). Al pegar más: se agregan las que caben y **las que sobran se quedan en el cuadro de texto** (no se pierden ni se truncan en silencio) con aviso en página: «Se agregaron 120 placas. Quedan 80 por fuera: regístralas en otra tanda cuando termines esta.» Cuando la lista baja, «Agregar a la lista» vuelve a tomar las que quedaron en el cuadro. «Registrar» nunca envía más de 200.

### Reintentar solo lo rechazado (propuesta cerrada)

Tras la respuesta, las registradas **salen** de la lista de trabajo. En el resumen, el botón secundario **«Corregir y reintentar N»** vuelve al editor cargando solo las rechazadas **corregibles** (`NO_ENCONTRADO`, `PLACA_INVALIDA`, `VALOR_INVALIDO`), cada fila con su motivo en línea y su valor tal como se envió. No se recargan las que no se arreglan aquí (`VARIOS_TRAMITES_APROBADOS`, `TRAMITE_LIQUIDADO`, `LOGISTICA_AUTOGESTIONADA`, `PLACA_REPETIDA`): quedan solo en el resumen. «Nueva carga» (terciario, texto) limpia todo. Nunca se reenvía una registrada: además del filtrado, el reintento usa una `Idempotency-Key` nueva (lista distinta) y la anterior solo se reutiliza si el mismo envío falló por red y se pulsa «Reintentar» sin editar nada.

## Estados (4) + copy

Wireframes ASCII (contrato de estructura). `[x]` casilla, `( )` botón.

### Escritorio ≥ `lg` (1366)

Pestañas: `Trámites | Generación de actas | Actas | Viajes adicionales` (esta última con el patrón de pestaña existente, sin badge).

**Vacío (entrada)**
```
Logística  (PageHeaderCard, sin cambios)
[Trámites] [Generación de actas] [Actas] [Viajes adicionales]*
┌ FlitCard ───────────────────────────────────────────────────────────────┐
│ Registra el mismo viaje adicional a varias LT, con el valor de cada una.│
│ Placas                                                          0 / 200 │
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ Pega una placa por línea. Si copias desde Excel, puedes incluir      │ │
│ │ el valor en la segunda columna.                                      │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ (Agregar a la lista)                                                     │
├──────────────────────────────────────────────────────────────────────── │
│ FlitEmpty: Aún no hay placas en la lista. Pega o escribe las placas      │
│ arriba y pulsa «Agregar a la lista».                                     │
└─────────────────────────────────────────────────────────────────────────┘
```
(Sin primaria visible habilitada: «Registrar 0 viajes» aparece deshabilitado solo cuando hay lista.)

**Lleno (editando)**
```
┌ FlitCard: entrada (textarea colapsa a 2 líneas con la lista presente) ──┐
│ Placas ┌──────────────────────────────┐ (Agregar a la lista)  37 / 200  │
└─────────────────────────────────────────────────────────────────────────┘
┌ FlitCard: lista ────────────────────────────────────────────────────────┐
│ Valor para todas  [ $ 350000 ] (Aplicar a las seleccionadas)            │
│ (Quitar seleccionadas)                          35 de 37 seleccionadas  │
│ [x] Placas                         Valor (COP)                          │
│ [x] ABC123                         [ 350000      ]               ✕      │
│ [x] DEF456                         [ 350000      ]               ✕      │
│ [ ] GHI789                         [ 280000      ]               ✕      │
│ [x] JKL012                         [             ] ← Escribe el valor   │
│ …                                                                       │
│                                          ( Registrar 34 viajes )        │
└─────────────────────────────────────────────────────────────────────────┘
```
- «Registrar N viajes» (única primaria, alineada a la derecha, igual que «Registrar viaje» del detalle) se habilita con ≥ 1 seleccionada y **todas las seleccionadas con valor válido**; N cuenta solo las listas para enviar. Deshabilitada, lleva debajo el motivo: «Falta el valor en 1 placa seleccionada.»
- Fila con valor faltante o inválido: mensaje en línea bajo el input (`--flit-danger-ink`), `aria-invalid`, vinculado con `aria-describedby`. Valor válido: entero ≥ 0 en pesos (0 se permite).
- «Aplicar a las seleccionadas» pisa el valor de esas filas; cada fila sigue editable. Deshabilitada sin valor común o sin seleccionadas.

**Cargando (envío en curso)**: la lista queda donde está pero de solo lectura (`aria-busy="true"`, inputs y casillas deshabilitados); la primaria pasa a «Registrando 34 viajes…» deshabilitada, con texto de estado en `role="status"`: «Registrando 34 viajes. No cierre ni recargue esta página.» Sin spinner decorativo. No hay carga inicial de datos en esta pestaña, por eso no hay esqueleto.

**Error de la solicitud completa** (red, 5xx, 403, 422 del tope): la lista y los valores **no se tocan**.
```
┌ aviso role="alert" ─────────────────────────────────────────────────────┐
│ No pudimos registrar los viajes. Tus placas siguen en la lista.          │
│ (Reintentar)                                                            │
└─────────────────────────────────────────────────────────────────────────┘
```
Copy por causa: red/5xx «No pudimos registrar los viajes. Tus placas siguen en la lista; vuelve a intentarlo.» · 403 «No tienes permiso para registrar viajes.» (sin Reintentar) · más de 200 «La lista supera las 200 placas. Quita las que sobran y vuelve a intentarlo.». «Reintentar» reenvía con la misma `Idempotency-Key`. Si el servidor tardó y no se sabe si guardó, la misma llave evita duplicar. Nunca se pinta `e.message`.

**Lleno (resultado)**: reemplaza la lista; el aviso es persistente (`role="status"`, tarjeta), no toast.
```
┌ FlitCard: resumen ──────────────────────────────────────────────────────┐
│ Resultado del registro                                                  │
│ ✔ Se registraron 31 viajes     ✖ No se registraron 3                    │
│ (Corregir y reintentar 2)   Nueva carga                                 │
├─────────────────────────────────────────────────────────────────────────┤
│ No se registraron                                                       │
│ Placa    Motivo                                                         │
│ ABC12    La placa no tiene un formato válido. Corrígela y reintenta.    │
│ DEF456   Esta placa tiene varios trámites aprobados (FLIT-10234,        │
│          FLIT-10311). Regístrale el viaje desde el detalle de uno.      │
│ GHI789   El trámite ya está liquidado. Reversa la liquidación…          │
├─────────────────────────────────────────────────────────────────────────┤
│ ▸ Registrados (31)   (acordeón FlitAcordeon, cerrado por defecto)       │
│   Placa · Trámite (idFlit) · Viaje N.º · Valor                          │
└─────────────────────────────────────────────────────────────────────────┘
```
- Si no se rechazó nada: «Se registraron 34 viajes.» y solo «Nueva carga» (secundario); la tabla de rechazadas no existe. Si se rechazó todo: «No se registró ningún viaje.» con la tabla de rechazadas abierta.
- Rechazadas arriba (es lo que exige acción); registradas plegadas. Tablas con `FlitTable`/`FlitTh`/`FlitTr`. `StatusChip` no se usa: el título de cada bloque ya dice el estado.
- En el resumen la primaria del paso es «Corregir y reintentar N» **solo si hay corregibles** (`flitBtnPrimary`); si no, «Nueva carga» pasa a ser la única acción (secundaria). Nunca dos primarias: «Nueva carga» es texto/secundario.

### Móvil < `lg` (375)
```
[Trámites][Generación…][Actas][Viajes adi…]   ← pestañas envuelven (flex-wrap ya existente)
┌ FlitCard ─────────────────────┐
│ Registra el mismo viaje…      │
│ Placas              37 / 200  │
│ ┌───────────────────────────┐ │
│ │ (textarea, ancho completo)│ │
│ └───────────────────────────┘ │
│ (Agregar a la lista)          │
├───────────────────────────────┤
│ Valor para todas              │
│ [ $ 350000 ]                  │
│ (Aplicar a las seleccionadas) │
│ (Quitar seleccionadas)        │
│ [x] Seleccionar todas  35/37  │
│ ┌ [x] ABC123              ✕ ┐ │
│ │ Valor (COP) [ 350000    ] │ │
│ └───────────────────────────┘ │
│ ┌ [x] JKL012              ✕ ┐ │
│ │ Valor (COP) [           ] │ │
│ │ Escribe el valor.         │ │
│ └───────────────────────────┘ │
│ ( Registrar 34 viajes )       │  ← ancho completo, bajo la lista
└───────────────────────────────┘
```
Resultado en móvil: resumen en una columna; rechazadas como lista de tarjetas (placa en negrita, motivo debajo); registradas dentro del acordeón en `FlitTable` con scroll horizontal del kit. Sin columnas fijas: la fila de la lista usa `flex-wrap` / `grid-cols-1` en móvil y se alinea a una línea solo desde `sm:`/`lg`.

### Copy de rechazos por código (tuteo, nunca el error crudo)

| Código | Texto en la fila |
|---|---|
| NO_ENCONTRADO | No encontramos un trámite aprobado para esta placa. Revisa que esté bien escrita. |
| VARIOS_TRAMITES_APROBADOS | Esta placa tiene varios trámites aprobados (FLIT-10234, FLIT-10311). Regístrale el viaje desde el detalle de uno de ellos. |
| PLACA_INVALIDA | La placa no tiene un formato válido. Corrígela y reintenta. |
| PLACA_REPETIDA | La placa estaba más de una vez en la lista; solo se tomó una. |
| VALOR_INVALIDO | El valor no es válido. Escribe un valor en pesos, sin decimales, desde $0. |
| TRAMITE_LIQUIDADO | El trámite ya está liquidado. Reversa la liquidación para registrar el viaje. |
| LOGISTICA_AUTOGESTIONADA | La logística de esta compañía la gestiona el cliente. |
| (otro) | No se pudo registrar este viaje. Inténtalo de nuevo más tarde. |

`candidatos` se muestran como `idFlit` en texto (sin enlace por ahora, pregunta 3). Los `idFlit` no son PII; las placas sí son cuasi-PII: viven en el estado del componente y en el body, **nunca** en URL, `localStorage` ni consola (AGENTS §14).

## Responsive + feedback del delta (qué pasa <lg; hover/focus de lo nuevo; toast vs aviso)

- <`lg`: ver wireframe móvil. Primaria al pie en ancho completo; barra de valor común apila input y botones; la lista son tarjetas, no tabla.
- Hover sutil + foco (`flit-focus`) en: pestaña nueva (igual que las existentes, `transition-colors`), botones (`flitBtnSecondary`/`flitBtnPrimary` ya traen hover y deshabilitado), casillas, inputs de valor (`flitInp`), ✕ de fila (`flitBtnIconoSm`: hover velo `--flit-bg-hover`, `aria-label="Quitar ABC123"`), cabecera del acordeón. Fila con hover `--flit-bg-hover` solo como velo, no clicable.
- Teclado: Tab recorre entrada -> agregar -> valor común -> aplicar -> quitar -> casilla "todas" -> (casilla, valor, ✕) por fila -> primaria. **Enter en un valor pasa al valor de la fila siguiente** (no envía el formulario; el envío solo es por la primaria). En el textarea, Enter es salto de línea. Casillas: Espacio. Tras «Agregar», el foco vuelve a la lista (a la primera fila nueva); tras «Quitar», a la primaria o al textarea si la lista queda vacía; tras el resultado, el foco va al título del resumen (`tabIndex=-1`).
- Notificaciones:
  - Aviso en página (persistente): resultado del registro, error de la solicitud, omitidas por repetidas, excedente de 200.
  - Toast cerrable, una frase (`ToastFlito`): «Valor aplicado a 35 placas.» (éxito ~4 s). «Quitar seleccionadas» no lleva toast: el contador y la lista lo muestran.
  - Error de campo: en línea bajo el input de valor, no toast.
- Sin animaciones ni sombras nuevas.

## Permiso/slug

Sin `PageSlug` nuevo: la pestaña es de `FlitoLogistica` (slug existente). Visible y operable solo con `hasFuncion('logistica.viajes.registrar')` (la función del registro individual); sin ella la pestaña no se pinta. Roles: los que ya tienen esa función (no se diseña `operaciones`). Confirmar que el endpoint masivo exige esa misma función (pregunta 2).

## Notas para QA (≤10)

1. Pegar lista de una columna y de dos columnas (Excel con tabulador); valor con `$` y puntos se normaliza.
2. Pegar duplicadas: se omiten y el aviso dice cuántas.
3. Pegar 250: entran 200, quedan 50 en el cuadro, aviso exacto; «Registrar» nunca envía > 200.
4. Valor común: aplica solo a seleccionadas, la fila sigue editable, toast con el conteo.
5. Registrar con una fila seleccionada sin valor: primaria deshabilitada con motivo; valor 0 es válido.
6. Respuesta mixta: resumen con X/Y correctos; copy por cada código; ningún texto crudo del API.
7. «Corregir y reintentar» carga solo corregibles, sin registradas, con su motivo en línea.
8. Fallo de red: lista intacta; «Reintentar» reutiliza la `Idempotency-Key` (no duplica viajes); editar la lista genera otra.
9. Solo teclado completo (incluye Enter entre valores); lector de pantalla anuncia el resultado.
10. 375 px sin scroll horizontal de página; ambos temas (tokens, sin `red-600` crudo).

## Decisiones y descartes

- **Pestaña vs modal vs ruta nueva:** modal descartado (200 filas, foco atrapado, difícil en móvil); ruta nueva descartada (exige `PageSlug` y registro, desproporcionado para una extensión). Pestaña = menor huella.
- **Entrada por pegado y no por selector de LT:** no existe endpoint de listado; inventarlo está prohibido. El pegado cubre el caso real (la lista viene de una hoja).
- **Sin validación de placa en cliente:** evita duplicar la regla; el servidor responde `PLACA_INVALIDA`.
- **Sin mostrar tarifa ni advertencias por valor** (el contrato lo declara libre): ver pregunta 4.
- **Resumen como aviso persistente, no toast:** sigue cierto al mirar la página.
- **Sin descarga de rechazadas, sin barra de progreso por lote, sin elegir entre candidatos:** fuera del AC; el reintento y la lista de motivos cubren el trabajo. No se añaden adornos ni patrón visual nuevo: todo es `PageHeaderCard` (sin cambios), `FlitCard`, `FlitTable`, `FlitAcordeon`, `FlitEmpty`, `flitInp`, botones del kit, `ToastFlito`.
- **Oficio:** vino a registrar viajes en bloque; ve primero la lista y su valor; una primaria («Registrar N viajes», o «Corregir y reintentar N» en el resumen); vacío y error con siguiente paso; móvil dicho; feedback dicho; notificación elegida.

## Preguntas abiertas para David

1. ¿Aceptas la entrada solo por placa pegada/escrita? (Seleccionar de una lista de LT requeriría un endpoint de listado por vehículo que no existe; sería requerimiento para backend/architecture.)
2. ¿El endpoint masivo exige `logistica.viajes.registrar` (la del registro individual)? Si usa otra función, la pestaña se condiciona a esa.
3. En `VARIOS_TRAMITES_APROBADOS`, ¿basta con listar los `idFlit` en texto o quieres que lleven al detalle del trámite (abre el detalle en la pestaña «Trámites»)?
4. Valor libre sin referencia: ¿se acepta sin ninguna advertencia (ni siquiera para $0 o cifras muy altas)? Propongo ninguna, por contrato.

## Brief de mockup (pantallas tocadas, kit, datos ficticios, 4 estados, móvil)

- Vistas: pestaña «Viajes adicionales» en Logística: (1) vacío, (2) lleno editando con una fila inválida, (3) cargando (envío), (4) error de solicitud, (5) resultado mixto con acordeón de registradas, (6) resultado total exitoso; más móvil 375 de (2) y (5), en claro y oscuro.
- Kit: `PageHeaderCard` (sin cambios), pestañas existentes, `FlitCard`, `FlitEmpty`, `FlitTable/FlitTh/FlitTr`, `FlitAcordeon`, `ToastFlito`, `flitInp`, `flitBtnPrimary`, `flitBtnSecondary`, `flitBtnIconoSm`. Tokens `--flit-*`, sin HEX.
- Datos ficticios: placas `AAA111`, `BBB222`, `CCC333` … (no reales); valores 350000, 280000; `FLIT-10234`, `FLIT-10311`; resumen 31 registradas / 3 rechazadas.
- Copy exacto: el de las secciones de estados y la tabla de rechazos.
- No mostrar: tarifa, motivo/detalle del viaje, números internos, descarga de rechazadas.

HANDOFF
  Modo: slim
  Resultado: OK
  Entrega: /home/david/flit/flito/docs/ux/viajes-adicionales-masivo-14128-slim.md
  Oficio: primaria única | jerarquía dicha | vacío con siguiente paso | responsive dicho | feedback dicho | notificación elegida | sin efectos
  Densidad: sin cambio
  Pantallas: 1 (pestaña nueva en FlitoLogistica) | Requerimientos nuevos de datos: ninguno
  Mockup: brief listo
  Reconocimiento: 8
  Siguiente: hilo publica mockup (Artifact design) y espera «ok» humano → frontend-agent; antes, David responde las 4 preguntas.
