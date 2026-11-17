---
resumen: Cola de confirmación de campos leídos.
palabras_clave:
  - revisiones
  - OCR
  - confirmar campos
  - lectura de documentos
consultas:
  - cómo confirmo los campos que leyó el OCR
  - por qué un documento quedó en revisión
  - cómo busco el trámite de un documento en revisión
version: 1.3
fecha: 2026-11-17
---
## Qué es

Cola de confirmación humana: todo documento leído por OCR que no superó la coincidencia cae aquí. Nada se da por válido sin que usted lo confirme.

## Para quién

Administrador (confirma o descarta). Auditor (ve la cola y los soportes, pero no los resuelve: **Solo lectura · Auditoría ve la cola y los soportes, pero no los resuelve.**).

## Cómo se entra

En la barra de navegación al pie de la pantalla, pulse **Gestión** y, en el panel que se abre, en el grupo **Trámites**, el ítem **Revisiones OCR**. Si la ventana es estrecha, la barra deja solo los iconos y el nombre de cada sección aparece al pasar el cursor por encima; en pantallas pequeñas, use el botón de menú de la barra superior. También puede pulsar **Ctrl + K** (**Command + K** en Mac) y escribir «revisiones».

## Pasos

1. Elija el grupo: **SOAT**, **Impuestos** (incluye las facturas de venta) o **Derechos de tránsito**. Marque **Incluir resueltas**, arriba a la derecha, si necesita ver también las ya cerradas.
2. En **Cola**, a la izquierda, pulse el archivo; la primera de la lista viene elegida. En el centro aparece el documento; si el visor no lo muestra, use **Abrir el documento**. A la derecha, el tipo de documento, el motivo por el que llegó (por ejemplo, **Confianza del OCR bajo el umbral**) y los campos leídos, cada uno con su confianza: **confiable**, **no confiable** o **Sin lectura**. ![Revisiones OCR con la cola de dos pólizas a la izquierda, el documento en el centro y los campos leídos con su porcentaje de confianza a la derecha](./flito_revisiones/01-cola-y-documento.png)
3. En **Trámite contra el que se concilia**, el trámite aparece elegido cuando es el único que coincide con la placa o el VIN del documento; lo indica el aviso **Elegido automáticamente**, y puede pulsar **Cambiar** para elegir otro. Si no viene elegido, pulse el campo y escriba la placa, el VIN o el número FLIT: la lista muestra el número FLIT y la placa de cada trámite, y marca **Coincide placa**, **Coincide VIN** o **Coincide placa y VIN**. Si aparece **Hay más trámites que coinciden**, escriba más caracteres para afinar. Al elegirlo, aparece una tabla que compara **Placa** y **VIN** del trámite con lo **Leído del PDF**, con ✓ si cruzan y ✗ si no. Corrija en cada campo el valor que no corresponda; si corrige la placa y ya no es la del trámite elegido, un aviso se lo dice y **Buscar con** la placa nueva le muestra los trámites que sí coinciden. ![Trámite elegido automáticamente en el buscador y tabla que compara placa y VIN del trámite con lo leído del PDF, ambos con marca de coincidencia](./flito_revisiones/02-revisar-campos.png)
4. Pulse **Confirmar y resolver** (solo se habilita con un trámite elegido). Escriba en **Deja constancia de qué validaste** y pulse **Resolver**, o **Cancelar** para volver. Si el documento no corresponde a ningún trámite, pulse **Descartar documento**, escriba el **Motivo del descarte (mín. 5 caracteres)** y pulse **Descartar**. ![Recuadro Deja constancia de qué validaste con el botón Resolver y Cancelar debajo de los campos](./flito_revisiones/03-constancia.png)
5. Al resolver o descartar, el documento sale de la cola. Una revisión ya cerrada (con **Incluir resueltas**) muestra **Resuelta** y sus campos no se editan.

![Diagrama: el documento en la cola, elegir el trámite y revisar los campos; si corresponde, Confirmar y resolver con constancia; si no, Descartar documento con motivo](./flito_revisiones/resolver-o-descartar.svg)

## Estados

- Cargando: **Cargando documento…** en el visor mientras llega el archivo.
- Error: el recuadro de constancia o de descarte muestra el mensaje si falla la confirmación o el descarte. Si la búsqueda de trámites falla, el campo muestra **No pudimos buscar los trámites.** con **Reintentar**.
- Vacío: **No hay nada en revisión. Cuando una extracción no supere el umbral o su llave no cruce, el documento aparecerá aquí.** El mismo mensaje se ve si la cola no se pudo consultar.
- Lleno: cola a la izquierda, documento al centro y campos a la derecha (en pantallas pequeñas, uno debajo del otro).

## Qué no hace

- No sustituye la carga masiva: los archivos entran desde **SOAT**, **Impuestos** o **Derechos**.
- No envía el SOAT al Proveedor ni el impuesto al gestor.
- No **Factura** ni hace **emisión electrónica**.
- El Auditor no confirma ni descarta.
