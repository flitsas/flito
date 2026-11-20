---
resumen: Retenciones, estancamientos y diferencias de operación.
palabras_clave:
  - tablero
  - retenciones
  - estancamientos
  - diferencias
consultas:
  - qué muestra el tablero
  - dónde veo los trámites retenidos
  - por qué un trámite está estancado
version: 1.2
fecha: 2026-10-22
---
## Qué es

Es el **Tablero**, la pantalla de inicio. Resume las retenciones, los estancamientos y las diferencias de la operación que el proceso por Excel y correo no dejaba ver. Las alertas operativas llevan a **Gestión Trámites** con el filtro ya aplicado, para que usted no rearme la búsqueda. Es de solo lectura: aquí no se ejecuta ninguna acción.

## Para quién

Quien tiene asignado el ítem **Tablero** en **Roles y permisos**: lo ve como pantalla de inicio. Los bloques de **SOAT** e **Impuestos** aparecen según las colas que usted puede ver.

Si su rol tiene enlace **Compañía**, el tablero cuenta solo los trámites de su compañía. Con enlace **Proveedor** u **Organismos** el Tablero no está disponible.

## Cómo se entra

Es lo primero que ve al iniciar sesión. Para volver a él, en la barra de navegación al pie de la pantalla pulse el primer icono: sección **General**, ítem **Tablero** (en pantallas pequeñas, use el botón de menú de la barra superior). No lo confunda con **Tablero ejecutivo PESV**.

## Pasos

1. Lea los cuatro indicadores: **Revisiones pendientes** y **Fuera de ANS** (cada uno dice debajo cuántos son de SOAT y cuántos de Impuestos), **Diferencias de valor** (pagados cuyo recibo no cuadra con lo liquidado) y **Habilitados para entrega** (SOAT e impuestos resueltos; falta ejecutar la entrega). Un indicador con valor en riesgo muestra el chip **atención**.
2. En la segunda fila están las alertas operativas: **Más de 5 días en borrador**, **Más de 2 días sin aprobar (ANS)**, **SOAT solicitado sin gestión** e **Impuesto solicitado sin gestión**. El chip **Requiere atención** marca las que tienen trámites. Pulse una tarjeta para abrir **Gestión Trámites** filtrado por esa alerta. ![Tablero con los cuatro indicadores arriba y las cuatro alertas operativas debajo, dos de ellas con el chip Requiere atención](./flito_tablero/01-indicadores-y-alertas.png)
3. Más abajo, revise **SOAT por estado** e **Impuestos por estado** (**Pendiente**, **Solicitado**, **Con novedad**, **Pagado**), con el total de cada bloque. Cada bloque aparece solo si su rol puede ver esa cola; si no, el tablero lo omite y los indicadores que se parten por módulo cuentan solo el que usted ve. ![Bloques SOAT por estado e Impuestos por estado con el recuento de Pendiente, Solicitado, Con novedad y Pagado y el total de cada uno](./flito_tablero/02-por-estado.png)

## Estados

- Cargando: el encabezado **Tablero** se ve; los indicadores aún no.
- Error: mensaje en rojo sobre una tarjeta.
- Vacío: no hay un mensaje de «sin datos»; los recuentos aparecen en cero cuando no hay alertas.
- Lleno: cuatro indicadores, cuatro alertas operativas y los dos recuentos por estado.

## Qué no hace

- No sincroniza trámites: FLITO los trae de FLIT y FLIT 2 solo, y el estado de esa lectura se ve en **Gestión Trámites**, tarjeta **Sincronización**.
- No es el listado para despachar: use **Gestión Trámites**.
- No es la cola **SOAT** ni **Impuestos**: sus bloques por estado solo cuentan.
- No **Factura** ni hace **emisión electrónica**.
- No es el **Tablero ejecutivo PESV**.
