# Diseño slim — HU #13204 · Certificado RUNT con los datos de registro del vehículo

Feature #12954 · Épica #12683 · módulo **`flito-impuestos`** (no el legacy `liquidacion`/`soat`).
Estado: **Propuesto** (diseño slim, sin ADR). Base: `develop` e4189607.

## Patrón reutilizado

| Pieza | Vecino que se copia |
|---|---|
| Extractor con lista blanca y alias por las dos vías (`vehiculo` → `datosTecnicos`) | `apps/api/src/modules/flito-impuestos/certificacion-runt.ts` — `primero()`, `extraerVehiculoRunt`, `extraerColorCilindrajeRunt` (y sus `ALIAS_MOTOR`/`ALIAS_SERIE`/`ALIAS_COLOR`/`ALIAS_CILINDRAJE`) |
| PDF puro, `sanitize` + `recortar` + `fechaHoraColombia` | `apps/api/src/modules/flito-impuestos/certificado-pdf.ts` (bloque de metadatos y de propietario: etiqueta/valor) |
| Registro PII de una descarga de archivo | `registrarAccesoImpuesto` + `archivo: 'zip_soportes'` en `flito-impuestos.pii.ts` (calco del ZIP de soportes) |
| Ruta del PDF | `GET /:id/certificado` en `flito-impuestos.routes.ts:636-660` (ya con `exigirFuncion('impuestos.certificado.descargar')` → AC6 sin cambios) |

Sin esquema nuevo, sin dependencia nueva, sin cambio en `shared-types` ni en `apps/web`.

## Contrato delta

**1. `certificacion-runt.ts` — extractor nuevo (puro):**

```ts
export interface RegistroRuntCertificado {
  clasificacion: string | null; color: string | null; cilindraje: string | null;
  tipoServicio: string | null; organismoTransito: string | null; estadoAutomotor: string | null;
  fechaMatricula: string | null; numMotor: string | null; numChasis: string | null; numSerie: string | null;
}
export function extraerRegistroRunt(snapshot: unknown): RegistroRuntCertificado
```

Entrada = `flito_impuesto_certificaciones.snapshot_runt` (`{ vehiculo, tipoDocPropietario, rtm?, soat?, datosTecnicos?, solicitudes? }`, mismo `data` que ya recibe `extraerVehiculoRunt`). Cada campo: `primero(veh, ALIAS) ?? primero(tec, ALIAS)`. **Solo** se leen `snapshot.vehiculo` y `snapshot.datosTecnicos`; `rtm`, `soat`, `solicitudes`, `tipoDocPropietario` y cualquier clave de persona **no se tocan** (AC3). El retorno es un literal con exactamente las 10 claves — prohibido `...veh`, `Object.entries`, o iterar el payload.

| Campo | Alias (en orden) | Medido en real (QIU744, 2026-07-31) |
|---|---|---|
| clasificacion | `clasificacion`, `clasificacionVehiculo`, `nombreClasificacion` | `vehiculo.clasificacion` |
| color | `ALIAS_COLOR` (reutilizar) | `vehiculo.color` |
| cilindraje | `ALIAS_CILINDRAJE` (reutilizar; valor tal cual, sin inventar unidad) | `vehiculo.cilindraje` |
| tipoServicio | `tipoServicio`, `nombreServicio`, `servicio` | `vehiculo.tipoServicio` |
| organismoTransito | `organismoTransito`, `nombreOrganismoTransito`, `organismo` | `vehiculo.organismoTransito` |
| estadoAutomotor | `estadoAutomotor`, `estadoVehiculo` (**no** `estado` a secas: es genérico y lo usan otras secciones) | `vehiculo.estadoAutomotor` (en `SENALES_REGISTRO`) |
| fechaMatricula | `fechaMatricula`, `fechaRegistro`, `fechaMatriculaInicial` | `vehiculo.fechaRegistro` (en `SENALES_REGISTRO`) |
| numMotor | `ALIAS_MOTOR` (reutilizar) | `vehiculo.numMotor` |
| numChasis | `numChasis`, `noChasis`, `numeroChasis`, `nroChasis`, `chasis` — lista **propia**; **sin** caer al VIN (si falta, «No reportado») | `vehiculo.numChasis` |
| numSerie | `ALIAS_SERIE` (reutilizar; no es el VIN) | `vehiculo.numSerie` (`null` en real) |

Añadir la fila de estos nombres al comentario de cabecera de `extraerVehiculoRunt` (sección «Verificado contra una consulta REAL»), no inventar una segunda fuente.

**2. `certificacion.service.ts`:** `CertificacionVigente` gana `registroRunt: RegistroRuntCertificado`; `certificacionVigente()` lo rellena con `extraerRegistroRunt(row.snapshotRunt)` (el `db.select()` ya trae la columna). **El snapshot crudo no sale del servicio**: ni se añade `snapshotRunt` al tipo ni llega a la ruta. `snapshot_runt` `null` (certificaciones antiguas) → los 10 en `null`.

**3. `certificado-pdf.ts`:** `CertificadoPdfDatos` gana `registroRunt: RegistroRuntCertificado` (obligatorio, para que el compilador obligue a la ruta a pasarlo). **Sin** campo de fecha nuevo: la fecha de «Consulta RUNT y certificación» es `certificadoEn` (= `createdAt` de la fila vigente, decisión cerrada). La fila de metadatos `'Certificado el'` pasa a etiquetarse `'Consulta RUNT y certificación'` con `fechaHoraColombia(datos.certificadoEn)` (grep de `'Certificado el'` en el test del PDF antes de renombrar; no duplicar la fecha en dos filas).

**4. `flito-impuestos.pii.ts`:**

```ts
export const CAMPOS_PII_CERTIFICADO = ['nombre_completo', 'numero_documento', 'tipo_documento',
  'placa', 'vin', 'num_motor', 'num_chasis', 'num_serie'] as const;
// AccesoImpuesto.archivo: 'zip_soportes' | 'certificado_runt'
```

Justificación de la lista: el PDF entrega nombre (FLITO), documento, tipo de documento, placa y VIN (ya los entregaba sin declararlos) y ahora motor/chasis/serie, identificadores del vehículo con la misma clasificación que `vin` en `CAMPOS_PII_IMPUESTO`. Color, clase, organismo, etc. no son PII: no se declaran.

**5. Ruta `GET /:id/certificado`:** tras `construirCertificadoPdf(...)` (si revienta no se entregó nada y no hay que registrar) y **antes** de `audit()` y de cualquier `res.setHeader`/`res.send`:

```ts
await registrarAccesoImpuesto(req, { accion: 'export', archivo: 'certificado_runt',
  impuestoId: req.params.id, filas: 1, campos: CAMPOS_PII_CERTIFICADO });
```

y se pasa `registroRunt: cert.registroRunt` al constructor. La ruta **no** llama al RUNT ni a S3/`flito_soportes` (AC4, RN-11: sin cambios).

## Maquetación del bloque (AC1, AC2, AC7)

- Posición: después de la tabla «DATOS DEL VEHICULO VERIFICADOS» (que no se toca) y antes de «PROPIETARIO».
- Título: `'Registro del vehículo (RUNT)'` en `bold` 10 (el `sanitize` lo deja `Registro del vehiculo (RUNT)` — así lo afirma el test).
- Dos columnas de parejas etiqueta/valor: 10 campos → 5 filas. Columna izquierda en `MARGEN`, derecha en `MARGEN + ANCHO_UTIL / 2`. Dentro de cada columna: etiqueta `bold` 9 gris, ancho fijo 105; valor `font` 9 en `x + 105`, **siempre** con `recortar(valor, font, 9, ANCHO_UTIL / 2 - 105 - 8)` (así ninguna celda invade la vecina, AC7). Interlínea 14.
- Orden: Clasificación · Color · Cilindraje · Tipo de servicio · Organismo de tránsito · Estado del automotor · Fecha de matrícula · Número de motor · Número de chasis · Número de serie (tabla `REGISTRO_LABEL` local al PDF, tipada `Record<keyof RegistroRuntCertificado, string>` para que un campo nuevo sin etiqueta no compile).
- Ausente: `valor ?? 'No reportado por el RUNT'` (reusar `RESULTADO_LABEL.no_verificable`, no otro literal). Nunca guion ni vacío (AC2).
- Fecha de matrícula: helper puro `fechaRuntLegible(s)`: si empieza por `YYYY-MM-DD` → `DD/MM/YYYY` **por corte de cadena** (fecha sin hora: pasarla por `new Date` + huso de Colombia la corre un día atrás); cualquier otro formato → tal cual (el RUNT a veces ya la trae en `DD/MM/YYYY`).
- Salto de página: `page` pasa a `let`; helper `asegurarEspacio(alto)` que, si `y - alto < MARGEN + 40` (reserva del pie), hace `doc.addPage([A4_W, A4_H])` y `y = A4_H - MARGEN`. Se invoca antes del bloque de registro (alto ≈ 16 + 5×14 + 12) y antes del de propietario; el pie se dibuja en la **última** página. Con 6 campos de comparación el documento cabe en una página (≈ 520 pt de 740); el guard es para que crecer la tabla no pise el pie.
- Tildes/comillas (AC7): todo pasa por `texto()`/`recortar()`, que ya aplican `sanitize`. Ningún `page.drawText` directo con datos del RUNT.

## Archivos a crear/modificar

Producción (modificar):
1. `apps/api/src/modules/flito-impuestos/certificacion-runt.ts` — `RegistroRuntCertificado`, `extraerRegistroRunt`, alias nuevos (`ALIAS_CLASIFICACION`, `ALIAS_TIPO_SERVICIO`, `ALIAS_ORGANISMO`, `ALIAS_ESTADO`, `ALIAS_FECHA_MATRICULA`, `ALIAS_CHASIS`), nota en la cabecera.
2. `apps/api/src/modules/flito-impuestos/certificacion.service.ts` — `CertificacionVigente.registroRunt` + mapeo en `certificacionVigente()`.
3. `apps/api/src/modules/flito-impuestos/certificado-pdf.ts` — `CertificadoPdfDatos.registroRunt`, `REGISTRO_LABEL`, `fechaRuntLegible`, bloque, `asegurarEspacio`, etiqueta de la fecha.
4. `apps/api/src/modules/flito-impuestos/flito-impuestos.pii.ts` — `CAMPOS_PII_CERTIFICADO`, `archivo` ampliado (actualizar su JSDoc).
5. `apps/api/src/modules/flito-impuestos/flito-impuestos.routes.ts` — `registrarAccesoImpuesto` antes de `audit`, pasar `registroRunt`, import. Correr `npx eslint` sobre el archivo (max-lines 800 sin blancos/comentarios).

Tests P1 (modificar, sin crear archivos nuevos):
- `apps/api/__tests__/services/flito-impuestos.certificacion-runt.test.ts` — `extraerRegistroRunt`: payload real (claves medidas) → los 10; alias alternos (`fechaMatricula`/`fechaRegistro`, `numChasis`/`noChasis`) y caída a `datosTecnicos`; snapshot `null`/`{}` → 10 `null`; `Object.keys(r)` es exactamente las 10 claves aunque el snapshot traiga `direccion`, `telefono`, `correo`, `solicitudes`, `soat`, `rtm`; `numChasis` ausente con `vin` presente → `null`.
- `apps/api/__tests__/services/flito-impuestos.certificado-pdf.test.ts` — el fixture base gana `registroRunt`; título del bloque y 10 etiquetas/valores presentes; ausente → «No reportado por el RUNT»; `2015-03-10` → `10/03/2015`; fila «Consulta RUNT y certificacion» con hora de Colombia; valor de 200 caracteres sale recortado con `...` y el texto completo no aparece; 40 campos de comparación → `PDFDocument.load(pdf).getPageCount() > 1` sin lanzar; valores con `«»“”—ñ` no lanzan. La tabla de comparación sigue (no tocar sus tests).
- `apps/api/__tests__/services/flito-impuestos.certificado.routes.test.ts` — el mock de `certificacionVigenteConAcceso` devuelve `registroRunt`; con valores centinela de dirección/teléfono **no** hay forma de que lleguen (el servicio ya no los entrega) → aserto sobre el PII: `logPiiAccess` (mock de `src/shared/pii-audit.js`) llamado una vez con `accion: 'export'`, `camposAccedidos` = `CAMPOS_PII_CERTIFICADO`, `motivo` que contiene `archivo=certificado_runt` y el uuid; `audit` también; 403 sin la función (ya existe, confirmar); 409 sin certificación → **sin** `logPiiAccess`.
- `apps/api/__tests__/services/flito-impuestos.certificacion.service.test.ts` — `certificacionVigente` con fila cuyo `snapshotRunt` trae `vehiculo.direccion`/`solicitudes`: el resultado tiene `registroRunt` y **no** tiene `snapshotRunt` ni ninguna de esas claves (`JSON.stringify` sin los centinelas).

Comando P1: `npm test -w apps/api -- __tests__/services/flito-impuestos.certificacion-runt.test.ts __tests__/services/flito-impuestos.certificado-pdf.test.ts __tests__/services/flito-impuestos.certificado.routes.test.ts __tests__/services/flito-impuestos.certificacion.service.test.ts` (+ `NODE_OPTIONS=--max-old-space-size=8192 npm run build:api`, cambia tipos).

### Mutantes para QA B (tope 3, P2)

| # | Mutación | Aserto que debe matarla |
|---|---|---|
| M1 | En `extraerRegistroRunt` quitar `'fechaRegistro'` de `ALIAS_FECHA_MATRICULA` (o la caída `?? primero(tec, …)`) | runt: payload real con solo `vehiculo.fechaRegistro` → `fechaMatricula` no nulo; y el de `datosTecnicos` |
| M2 | En `fechaRuntLegible` usar `fechaHoraColombia(new Date(s))`/`toLocaleDateString` en vez del corte de cadena | pdf: `'2015-03-10'` → contiene `10/03/2015` (el mutante da `09/03/2015` en cualquier TZ del proceso) |
| M3 | En la ruta, borrar (o mover después de `res.send`) `registrarAccesoImpuesto` / pasar `campos` por defecto | routes: `logPiiAccess` llamado con `camposAccedidos` exactamente `CAMPOS_PII_CERTIFICADO` y `archivo=certificado_runt` antes de responder |

Alternativo si alguno no aplica: cambiar `?? 'No reportado por el RUNT'` por `?? '-'` → muere con el aserto de AC2.

## ADR: no aplica

Extiende el extractor, el PDF y el registro PII existentes; sin tabla, sin contrato HTTP nuevo (la ruta y su respuesta binaria no cambian), sin dependencia. Consistente con ADR-0008 / HU #11167 (`snapshot_runt` existe para regenerar el certificado; RN-11 se mantiene).

## Notas operativas

**backend-agent**
- La lista blanca es la garantía de AC3: se prueba por construcción (retorno literal de 10 claves) **y** por aserto de ausencia de centinelas. No filtrar por lista negra.
- No llamar a `extraerRegistroRunt` en la ruta: el crudo no debe cruzar la frontera del servicio.
- Limitaciones fuera (decisión cerrada): no añadir la sección aunque aparezca una clave parecida.
- `security-agent`: aplica (PII nueva en un archivo descargable) en modo diff-scoped. `db-review-agent`: no aplica (sin `schema.ts`/migraciones).

**frontend-agent:** no aplica (sin cambio visible en `apps/web`; el botón de descarga ya existe). `flit-ayuda-flito`: revisar si la ficha de Impuestos describe el contenido del certificado; si lo hace, delta de una línea.

## Riesgos abiertos

- Los alias no medidos (`clasificacionVehiculo`, `nombreServicio`, `fechaMatriculaInicial`, `estadoVehiculo`…) son preventivos, como los del vecino; los medidos son los de la columna derecha. Si en DEV un vehículo muestra «No reportado» en un campo que el RUNT sí trae, se añade el alias (no es defecto de diseño).
- `cilindraje` se muestra tal cual llega (sin «cc»): no inventar unidad.
