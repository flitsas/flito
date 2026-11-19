---
resumen: Configuración de cada secretaría de tránsito, con su alias, su logo, la modalidad de gestión FLITO y la plantilla de documentos.
palabras_clave:
  - organismos de tránsito
  - secretaría de movilidad
  - modalidad de gestión
  - autogestionado
  - logo del organismo
  - plantilla de documentos
consultas:
  - cómo cambio la modalidad de un organismo
  - cómo subo el logo de una secretaría
  - qué documentos pide un organismo de tránsito
  - qué organismos gestiona FLITO
version: 1.0
fecha: 2026-10-22
---
## Qué es

La pantalla **Organismos de tránsito**: una fila por secretaría de tránsito con su municipio, código, alias, **Modalidad FLITO**, los usuarios de tránsito que tiene asignados y su estado. La modalidad dice si FLITO gestiona ante ese organismo (**Requiere gestión FLITO**) o si el organismo lo hace por su cuenta (**Autogestionado por el organismo**). Desde **Editar** se configura su nombre corto, su logo, la modalidad, los parámetros de OCR y ANS, y los documentos que exige por tipo de trámite.

## Para quién

Quien tenga el ítem **Organismos de tránsito**. De partida, el Administrador. Cambiar la modalidad y guardar los parámetros de OCR y ANS pide además la acción de editar la configuración de tránsito. Sin ella, la pestaña **Autogestión** se ve en solo lectura.

## Cómo se entra

Menú **Tránsito**, ítem **Organismos de tránsito**.

## Pasos

1. Entre a **Organismos de tránsito**. El encabezado cuenta cuántas secretarías tienen alias o logo propio. Escriba en el buscador parte de la ciudad, del nombre o del código para filtrar la tabla. ![Tabla demo de organismos de tránsito con municipio, código, alias, modalidad FLITO, usuarios y estado](./transito_organismos/01-organismos.png)
2. Pulse **Editar** en la fila del organismo. En la pestaña **General** escriba el **Alias** (el nombre corto que se ve en la bandeja), suba el logo con **Subir logo** (PNG, JPEG, WEBP o SVG de hasta 512 KB), marque o desmarque **Organismo activo en FLIT** y pulse **Guardar**. El logo subido tiene prioridad sobre la URL de un logo externo. ![Ventana Editar en la pestaña General con el alias, el logo, la URL externa y la casilla de organismo activo](./transito_organismos/02-general.png)
3. En la pestaña **Autogestión** elija la **Modalidad**, escriba el **Motivo del cambio** (mínimo 5 caracteres) y pulse **Cambiar modalidad**. El **Historial de vigencias** muestra desde y hasta cuándo rigió cada modalidad, quién la cambió y por qué. ![Pestaña Autogestión con la modalidad, el motivo, los parámetros de OCR y ANS y el historial de vigencias demo](./transito_organismos/03-autogestion.png)
4. En la misma pestaña ajuste **Umbral OCR (0–1)**, **ANS pactado con el organismo (horas)** y **Marcar diferencia de valor de impuestos (D-5)**, y pulse **Guardar parámetros**.
5. En la pestaña **Plantilla documentos** elija la **Tipología**. Sobre la lista nacional marque **Ocultar** en lo que ese organismo no pide, u **Obligatorio** en un documento opcional que sí exige; con **Agregar anexo STT** sume un documento propio. Pulse **Guardar plantilla**: el cambio aplica al asistente del trámite y al envío a tránsito. ![Pestaña Plantilla documentos con la tipología, la lista de documentos con Ocultar y Obligatorio y un anexo propio del organismo](./transito_organismos/04-plantilla.png)

![Diagrama del cambio de modalidad: se elige la modalidad, se escribe el motivo y se cambia; la vigencia anterior se cierra, la nueva queda en el historial y decide si FLITO gestiona ante el organismo](./transito_organismos/cambio-de-modalidad.svg)

> [!IMPORTANTE]
> Un organismo sin modalidad registrada se muestra como **Autogestionado por el organismo**. Cada cambio queda en el historial con su motivo.

## Estados

- **Cargando**: la tabla dice «Cargando…».
- **Error**: si la lista no carga, aparece un aviso con el motivo y la tabla queda sin filas; recargue la página para intentarlo de nuevo.
- **Vacío**: «Sin resultados» cuando la búsqueda no coincide con ningún organismo. En **Autogestión**, «Sin vigencias registradas.» si la modalidad nunca se ha cambiado.
- **Lleno**: la tabla con **Municipio**, **Código**, **Alias**, **Modalidad FLITO**, **Usuarios**, **Estado** y **Acciones**.

## Qué no hace

- No asigna usuarios a un organismo: eso se hace en **Usuarios**, con el rol Tránsito.
- No es la bandeja de trámites de tránsito: esa es el ítem **Tránsito**.
- No define bolsas por organismo: eso es **Bolsas**, en Finanzas.
