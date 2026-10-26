---
resumen: Rastro de movimientos de un trámite.
palabras_clave:
  - bitácora
  - historial
  - movimientos
  - trazabilidad
consultas:
  - dónde veo el historial de un trámite
  - quién cambió el estado de un trámite
version: 1.2
fecha: 2026-10-22
---
## Qué es

Consulta de solo lectura del rastro de movimientos de un trámite: toda transición deja huella, incluidas las automáticas del sistema (actor **sistema**). Usted consulta; no edita.

## Para quién

Administrador y Auditor. Nadie edita ni borra movimientos desde esta pantalla.

## Cómo se entra

En la barra de navegación al pie de la pantalla, pulse **Gestión** y, en el panel que se abre, en el grupo **Auditoría**, el ítem **Bitácora**. Si la ventana es estrecha, la barra deja solo los iconos y el nombre de cada sección aparece al pasar el cursor por encima; en pantallas pequeñas, use el botón de menú de la barra superior. También puede pulsar **Ctrl + K** (**Command + K** en Mac) y escribir «bitácora».

## Pasos

1. Elija el recurso con las pastillas: **Todas**, **SOAT**, **Impuesto**, **Trámite** o **Revisión**. La tabla se vuelve a consultar con ese filtro.
2. Ajuste **Límite** (de 1 a 500 filas; de partida, 100) si necesita una ventana más amplia o más corta.
3. Lea **Fecha**, **Recurso**, **Acción**, **Actor** y **Detalle**, del más reciente al más antiguo. Un movimiento automático muestra el chip **sistema** en la columna **Actor**. El recurso y la acción se muestran con el nombre corto que guarda el sistema (por ejemplo, *soat* y *update*). ![Bitácora con las pastillas de recurso, el campo Límite y la tabla de movimientos, varios con el actor sistema](./flito_bitacora/01-movimientos.png)

## Estados

- Cargando: la tabla aún no aparece (el encabezado y las pastillas sí).
- Error: mensaje en rojo dentro de la tarjeta.
- Vacío: **Sin movimientos registrados. Cuando se sincronice, se tome o se pague algo, aparecerá aquí.**
- Lleno: tabla **Bitácora de movimientos** con una fila por transición.

## Qué no hace

- No corrige un SOAT, un impuesto ni un trámite: es rastro, no bandeja.
- No sustituye el historial puntual que abre una fila en **Gestión Trámites**.
- No registra comparendos ni actas de logística (esa trazabilidad vive en esas pantallas).
- No busca por placa ni por trámite: filtra solo por recurso y límite.
- No **Factura** ni hace **emisión electrónica**.
