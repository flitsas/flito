## Qué es

Cola de confirmación humana: todo documento leído por OCR que no superó la coincidencia cae aquí. Nada se da por válido sin que usted lo confirme.

## Para quién

Administrador (confirma o descarta). Auditor (ve la cola, los soportes y el trámite asociado, pero no los resuelve ni vuelve a leer el documento: **Solo lectura · Auditoría ve la cola y los soportes, pero no los resuelve.**).

## Cómo se entra

En el menú lateral, sección **Gestión**, ítem **Revisiones OCR**.

## Pasos

1. Elija el grupo: **SOAT**, **Impuestos** o **Derechos de tránsito**. Marque **Incluir resueltas** si necesita ver las ya cerradas.
2. En **Cola**, pulse el archivo. A la derecha aparece el documento; si no carga el visor, use **Abrir el documento**.
3. En **Trámite contra el que se concilia**, el trámite aparece elegido cuando es el único que coincide con la placa o el VIN del documento; lo indica el aviso **Elegido automáticamente**, y puede pulsar **Cambiar** para elegir otro. Si la revisión ya tenía un trámite asociado, aparece elegido desde el principio; el Auditor lo ve igual, sin poder cambiarlo, o **Sin trámite asociado** si no lo hay. Si no viene elegido, pulse el campo (**Selecciona el trámite…**) y escriba la placa, el VIN o el número FLIT: la lista muestra el número FLIT y la placa de cada trámite, y marca **Coincide placa**, **Coincide VIN** o **Coincide placa y VIN**. Si aparece **Hay más trámites que coinciden**, escriba más caracteres para afinar. Revise cada campo (**Leído del PDF** vs el valor que usted escribe); si corrige la placa y ya no es la del trámite elegido, un aviso se lo dice y **Buscar con** la placa nueva le muestra los trámites que sí coinciden.
4. Si la lectura salió mal (campos vacíos o con confianza baja), pulse **Reintentar lectura**, junto a **Confirmar y resolver**, para que el sistema vuelva a leer el documento guardado. No resuelve la revisión: usted sigue teniendo que revisar y confirmar. Mientras lee, el botón dice **Leyendo de nuevo…** y los campos no se editan. Si ya corrigió algún campo, antes le avisa **Se reemplazarán los campos que corregiste con la nueva lectura.**: pulse **Reintentar de todos modos** o **Cancelar** para conservar sus correcciones. Al terminar, aparece **Lectura actualizada** con el número de campos leídos, los campos traen los valores y la confianza nuevos, y el trámite se vuelve a buscar con la placa o el VIN leídos (sin cambiar el que usted ya eligió). Si la nueva lectura no obtiene ningún campo, la revisión queda como estaba. Hay un límite de intentos seguidos: si lo alcanza, espere unos minutos.
5. Pulse **Confirmar y resolver**. Si el documento no corresponde, **Descartar documento** (luego confirme o **Cancelar**).
6. Una revisión ya cerrada muestra **Resuelta**. Un campo sin dato aparece como **Sin lectura**.

## Estados

- Cargando: **Cargando documento…** en el visor.
- Error: el formulario muestra el mensaje al fallar la confirmación o el descarte. Si la búsqueda de trámites falla, el campo muestra **No pudimos buscar los trámites.** con **Reintentar**. Si **Reintentar lectura** falla, un aviso lo explica: **El lector de documentos no está disponible en este momento. La revisión no cambió; intenta de nuevo en unos minutos.**, **No se pudo abrir el documento guardado de esta revisión. Intenta de nuevo en unos minutos.**, **Demasiados reintentos de lectura seguidos. Espera unos minutos e intenta de nuevo.**, **La revisión ya está resuelta** o, si no hay conexión, **No pudimos reintentar la lectura. Intenta de nuevo.** También puede ver **El documento se volvió a leer, pero no se obtuvo ningún campo. La revisión no cambió.**
- Vacío: **No hay nada en revisión. Cuando una extracción no supere el umbral o su llave no cruce, el documento aparecerá aquí.**
- Lleno: cola a la izquierda, documento al centro y campos a la derecha.

## Qué no hace

- No sustituye la carga masiva: los archivos entran desde **SOAT**, **Impuestos** o **Derechos**.
- No envía el SOAT al Proveedor ni el impuesto al gestor.
- No **Factura** ni hace **emisión electrónica**.
- El Auditor no confirma, no descarta ni vuelve a leer el documento.
- **Reintentar lectura** no resuelve la revisión por sí solo.
