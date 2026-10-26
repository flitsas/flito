---
resumen: Lo que el organismo cobra por radicar.
palabras_clave:
  - derechos
  - organismo de tránsito
  - radicar
  - pago de derechos
consultas:
  - cuánto cobra el organismo por radicar
  - cómo registro el pago de derechos
version: 1.1
fecha: 2026-10-22
---
## Qué es

Registro de los recibos de derecho de tránsito que emite el organismo. El sistema lee placa, fecha y valor, y los asocia al trámite. El resultado de una carga no es un simple «ok»: cada archivo que usted sube cae en una canasta (Registrados, En revisión, Sin trámite asociado, Duplicados, Páginas omitidas, Fallidos).

## Para quién

Administrador (carga, procesa el Drive y consulta). Auditor (consulta). Financiera no gestiona esta pantalla: los recibos los carga el Administrador.

## Cómo se entra

En la barra de navegación al pie de la pantalla, pulse **Gestión** y, en el grupo **Trámites** del panel que se abre, el ítem **Derechos**. En pantallas pequeñas, use el botón de menú de la barra superior; también puede pulsar **Ctrl + K** (**Command + K** en Mac) y escribir «Derechos».

## Pasos

1. En **Cargar recibos**, elija uno o varios archivos: PDF, imagen, ZIP o un PDF con varios recibos. El **Organismo (opcional)** es el código del organismo (por ejemplo, 05001) y solo afina la lectura; el trámite se determina por la placa del recibo.
2. Pulse **Cargar**; el botón dice cuántos archivos eligió, por ejemplo **Cargar (1)**, y mientras lee dice **Procesando…**. Al terminar, un aviso le dice cuántos derechos quedaron registrados y aparece **Resultado de la carga**: cada archivo en su canasta —**Registrados**, **En revisión**, **Sin trámite asociado**, **Duplicados**, **Páginas omitidas** o **Fallidos**—, con el archivo, la placa, el trámite, el valor y el detalle. **Cerrar** oculta el panel cuando termine. ![Resultado de la carga de un recibo demo: canastas Registrados, En revisión y Duplicados, cada una con archivo, placa, trámite, valor y detalle](./flito_derechos/01-resultado-de-la-carga.png)
3. Lo **En revisión** (por ejemplo, una placa con varios trámites) se resuelve en **Revisiones OCR**, no aquí.
4. En la pestaña **Drive · Medellín** están los consolidados que publica la secretaría en su Drive, con quién los modificó, el tamaño y si ya se procesaron (la fecha, **Nunca** o **Dado por visto**). Pulse **Procesar**, o **Reprocesar** si ya se había procesado; el resultado aparece en el mismo panel **Resultado de la carga**. **Ver el registro** muestra cada pasada, aunque el archivo ya no esté en el Drive. El barrido automático diario de las 9:00 no sustituye este botón. ![Pestaña Drive · Medellín con el registro de procesamientos abierto y la lista de consolidados demo con Procesar y Reprocesar](./flito_derechos/02-drive.png)
5. En la pestaña **Registrados**, busque por placa o trámite y filtre por **Secretaría**, **Origen** o el rango **Pagado**; en **Vista**, **Con advertencia** deja solo los recibos cuyo concepto no coincide con el del trámite. Bajo el origen va el archivo y la página de donde salió cada recibo (o **Archivo no registrado** en los antiguos). **Ver PDF** abre el soporte y **Ver todos** abre los documentos del trámite (derecho, SOAT e impuesto). Una fila con duda muestra **Con advertencia**. ![Pestaña Registrados con el buscador, los filtros y tres derechos demo, uno de ellos Con advertencia](./flito_derechos/03-registrados.png)

![Diagrama: los recibos entran por Cargar recibos o por Drive · Medellín, el sistema lee placa, fecha y valor, y cada uno cae en Registrados, En revisión, Sin trámite asociado, Duplicados, Páginas omitidas o Fallidos; lo En revisión se resuelve en Revisiones OCR](./flito_derechos/canastas-de-carga.svg)

## Estados

- Cargando: **Consultando el Drive…** al listar los archivos del Drive; **Cargando…** en el registro de procesamientos; **Procesando…** en el botón mientras se lee una carga o un consolidado (no cierre la pestaña: se lee cada página).
- Error: aviso al fallar la carga o el procesamiento; en el Drive, el motivo queda además en una tarjeta.
- Vacío: **Todavía no hay derechos de tránsito registrados.** (el mismo texto sale cuando los filtros no encuentran nada). En el Drive: **No hay PDF en la carpeta del Drive.** o **Todavía no se ha procesado ningún archivo.**
- Lleno: listado con el trámite, el vehículo, las fechas, la empresa, el organismo, el concepto del recibo, el valor, la fecha de pago y el origen (**Carga manual** o **Drive de la secretaría**).

## Qué no hace

- No despacha SOAT ni impuestos, ni entrega el trámite.
- No resuelve ambigüedades de placa: eso es **Revisiones OCR**.
- No **Factura** ni hace **emisión electrónica**.
- No cubre secretarías que no publican en ese Drive: esas se cargan a mano desde **Cargar recibos**.
