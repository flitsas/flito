---
resumen: Carpetas y archivos de Google Drive compartidos con FLITO, y lectura de los PDF de cuentas de cobro.
palabras_clave:
  - Google Drive
  - carpetas
  - archivos
  - cuentas de cobro
  - procesar PDF
consultas:
  - cómo proceso un PDF de cuentas de cobro
  - dónde veo los archivos de Google Drive
  - por qué no veo una carpeta de Drive
version: 1.0
fecha: 2026-10-22
---
## Qué es

Un visor de las carpetas de **Google Drive** compartidas con FLITO. Permite recorrerlas, buscar archivos, verlos sin salir de FLITO, descargarlos y **procesar** un PDF de cuentas de cobro: FLITO lee cada página y devuelve un resumen con placa, propietario, documento, vehículo, tipo de trámite y valor de cada cuenta, más un Excel.

## Para quién

Quien tenga el ítem **Google Drive**. De partida, solo el Administrador; se reparte desde **Roles y permisos**. Sus acciones (abrir, descargar y procesar) piden además la acción de administrar los archivos de Drive.

## Cómo se entra

Menú **Administración**, ítem **Google Drive**.

## Pasos

1. Entre a **Google Drive**. Verá la **Carpeta raíz** con sus **Carpetas (N)** y **Archivos (N)**; cada archivo muestra su tamaño y su fecha de cambio. ![Carpeta raíz de Drive con dos carpetas demo y un archivo demo](./drive/01-carpeta-raiz.png)
2. Pulse una carpeta para abrirla. Arriba aparece la ruta y **Atrás** para volver a la carpeta anterior. ![Carpeta demo abierta con dos PDF de cuentas de cobro y una imagen, cada uno con Descargar y los PDF con Procesar](./drive/02-carpeta.png)
3. Para buscar, escriba al menos dos letras en **Buscar archivos...** y pulse **Buscar** (o Enter). **Limpiar** vuelve a la carpeta.
4. Pulse un archivo para verlo: los PDF se muestran página por página y las imágenes tal cual. **Descargar** lo guarda en su equipo.
5. En un PDF de cuentas de cobro pulse **Procesar**. Mientras lee dice **Procesando cuentas de cobro…** (puede tardar unos minutos). Al terminar, **Resultado del procesamiento** muestra **Páginas**, **Cuentas**, **Placas** y **Valor total**, la tabla de cuentas con **Descargar** por cuenta y **Descargar Excel resumen**. **Cerrar** oculta el resultado. ![Resultado del procesamiento de un PDF demo: tres cuentas con placa, propietario, documento, vehículo, trámite y valor](./drive/03-resultado.png)

![Diagrama del procesamiento: abrir la carpeta, elegir el PDF, procesar, revisar el resultado y descargar el Excel o cada cuenta](./drive/procesar-cuentas.svg)

> [!NOTA]
> Solo se procesa un PDF a la vez: mientras uno se lee, los demás botones dicen **Espere…**.

## Estados

- **Cargando**: «Cargando Drive…» con un indicador de progreso.
- **Error**: un aviso arriba («Error cargando Drive», «Error de conexión», «Error procesando» o el motivo de la descarga).
- **Vacío**: «Carpeta vacía o sin acceso», con la sugerencia de recargar y, si persiste, compartir la carpeta con la cuenta de servicio de FLITO.
- **Lleno**: carpetas en tarjetas y archivos en lista, con sus acciones.

## Qué no hace

- No sube, mueve, renombra ni borra archivos: eso se hace en Google Drive.
- No muestra carpetas que no estén compartidas con la cuenta de servicio de FLITO.
- No guarda el resultado del procesamiento: si lo cierra, hay que volver a procesar el PDF.
- No muestra vista previa de archivos que no sean PDF o imagen.
