---
resumen: Panel operativo de inicio con los indicadores, las alertas y los atajos de los módulos que usted puede abrir.
palabras_clave:
  - tablero de control
  - panel operativo
  - pantalla de inicio
  - indicadores
  - documentos por vencer
  - atajos
consultas:
  - qué muestra el panel operativo
  - qué veo al iniciar sesión
  - por qué mi inicio no muestra indicadores
  - dónde veo los documentos por vencer
version: 1.0
fecha: 2026-10-22
---
## Qué es

El **Tablero de control** es la pantalla de inicio de quien no tiene el Tablero FLITO. Arriba lo saluda con su nombre y la fecha, bajo el título **Panel operativo**. Reúne los indicadores de vehículos, SOAT, documentos de flota por vencer y errores de RNDC, las alertas que piden atención y atajos a Mantenimiento, RNDC y PESV. Cada bloque aparece solo si usted puede abrir la pantalla a la que lleva. Es de solo lectura: cada tarjeta lo lleva a la pantalla donde se actúa.

## Para quién

Quien tenga el ítem **Tablero de control** en **Roles y permisos**. De partida lo tienen todos los roles del sistema salvo Cliente. Lo que se ve dentro depende de los demás permisos: sin Vehículos, SOAT, Flota, RNDC, Mantenimiento ni PESV, el panel queda sin indicadores.

## Cómo se entra

Es lo primero que ve al iniciar sesión. Para volver a él, abra el menú **General** y pulse **Tablero de control**.

> [!NOTA]
> Si su usuario también tiene el Tablero FLITO, al entrar a FLITO verá ese tablero en lugar del Panel operativo. Para saber cómo se usa, consulte la ficha [Tablero](/flito/ayuda/flito_tablero).

## Pasos

1. Lea el bloque **Estado operativo**: **Vehículos** (en operación), **SOAT vigentes** (porcentaje verificado del total), **Por vencer 60d** (documentos de flota) y **RNDC errores** (manifiestos con error de envío). A la derecha, **Flota** y **Salud SOAT** resumen lo mismo y abren su pantalla al pulsarlas. ![Panel operativo demo con el bloque Estado operativo, sus cuatro indicadores y las tarjetas Flota y Salud SOAT](./dashboard/01-estado-operativo.png)
2. Pulse **Por vencer 60d** para abrir Flota en la pestaña de vencimientos. Los enlaces **Ver vehículos**, **Tablero PESV**, **Rendimiento (RUM)** y **Métricas trámites** abren esas pantallas.
3. Revise **Atención operativa**: cada fila dice qué está pendiente (solicitudes SOAT pendientes de compra, documentos vencidos o por vencer en 60 días) y su botón **Ir a SOAT** o **Ver vencimientos** lo lleva a resolverlo. Debajo, los atajos **Mantenimiento**, **RNDC**, **PESV** y **Tablero ejecutivo** abren cada módulo. ![Atención operativa demo con una solicitud SOAT pendiente y documentos vencidos y por vencer, y la fila de atajos debajo](./dashboard/02-atencion-y-atajos.png)
4. Si un bloque dice «No pudimos cargar…», pulse **Reintentar**: repite solo esa consulta y los demás bloques siguen como están.

![Diagrama de qué ve al iniciar sesión: con el Tablero FLITO, ese tablero; con el Tablero de control, el Panel operativo; sin ninguno de los dos, la primera pantalla que su usuario puede abrir](./dashboard/que-ve-al-entrar.svg)

## Estados

- **Cargando**: las cifras muestran un punto (·) mientras llegan.
- **Error**: por bloque, «No pudimos cargar…» con **Reintentar**. Si le quitaron el permiso de un bloque mientras lo miraba, ese bloque desaparece en vez de mostrar el error.
- **Vacío**: «Tu tablero no tiene indicadores con tus permisos actuales», con la indicación de usar el buscador (Ctrl K) o el menú para ir a sus secciones.
- **Lleno**: el bloque **Estado operativo**, las tarjetas de la derecha, **Atención operativa** cuando hay pendientes y la fila de atajos.

## Qué no hace

- No ejecuta ninguna acción: cada indicador y cada alerta lo lleva a su pantalla.
- No es el **Tablero** de FLITO (retenciones, estancamientos y diferencias de la operación).
- No muestra cifras de módulos que usted no puede abrir.
