---
resumen: Quién consultó datos personales, cuándo, qué campos y desde qué equipo. Solo se consulta.
palabras_clave:
  - log de accesos PII
  - accesos a datos personales
  - auditoría de datos personales
  - quién consultó
  - Ley 1581
  - habeas data
consultas:
  - quién consultó los datos personales de un conductor
  - cómo reviso los accesos a datos personales
  - dónde está el log de accesos PII
version: 1.0
fecha: 2026-10-22
---
## Qué es

El registro de **cada consulta a datos personales** dentro de FLITO: quién la hizo, cuándo, sobre qué registro, qué campos vio y desde qué dirección de red. Es la prueba que pide la Ley 1581 (artículo 17) cuando un titular o la autoridad preguntan quién miró sus datos. Nadie lo puede editar ni borrar: solo se consulta.

## Para quién

Quien tenga el ítem **Privacidad y datos**: este capítulo y el de **Privacidad y datos** van juntos. Leer el registro pide además la acción de ver el log de accesos a datos personales. De partida, el Administrador y Cumplimiento; se reparte desde **Roles y permisos**.

## Cómo se entra

Menú **Administración**, ítem **Log accesos PII**. La pantalla se titula **Auditoría accesos a datos personales**.

## Pasos

1. Entre a **Log accesos PII**. Arriba verá dos resúmenes de los últimos 30 días: **Top usuarios (últimos 30 días)**, con cuántos accesos hizo cada usuario (por su número y su rol), y **Top recursos accedidos**, con qué tipo de registro se consultó y de qué forma. ![Resumen del log con los usuarios y los recursos con más accesos, sobre datos demo](./privacy_log_pii/01-resumen.png)
2. Para acotar, use la fila de filtros: el número de usuario, el tipo de registro (por ejemplo, conductor o propietario), la acción (**read** es leer, **decrypt** es ver un dato cifrado, **export** es exportar y **search** es buscar) y el rango de fechas. Cada cambio de filtro vuelve a la primera página. ![Log filtrado por la acción de leer: dos accesos demo con fecha, usuario, registro, campos y dirección de ejemplo](./privacy_log_pii/02-filtros.png)
3. Lea la tabla: **Fecha UTC** (hora universal, cinco horas por delante de la de Colombia), **User**, **Recurso**, **Acción**, **Campos** e **IP**. Debajo, **Total** dice cuántos accesos cumplen los filtros; la tabla muestra 100 por página y se recorre con **← Anterior** y **Siguiente →**.

> [!IMPORTANTE]
> Si el registro no se puede leer, la pantalla lo dice y no muestra ningún total. Eso no significa que nadie haya accedido: pulse **Reintentar** antes de sacar una conclusión.

## Estados

- **Cargando**: la tabla dice «Cargando...».
- **Error**: «No se pudo cargar el log de accesos: …» con **Reintentar**. No se pinta el total ni la paginación, para no afirmar un cero que no se pudo comprobar.
- **Vacío**: «Sin accesos para los filtros». Si en los últimos 30 días no hubo accesos, los resúmenes dicen «Sin accesos».
- **Lleno**: los dos resúmenes, la tabla y el pie «Total: N · página X de Y».

## Qué no hace

- No muestra el nombre de quien consultó: lo identifica por su número de usuario y su rol.
- No muestra el valor de los datos consultados, solo qué campos se vieron.
- No exporta el registro ni permite borrar o corregir una fila.
- Los resúmenes de arriba cubren siempre los últimos 30 días; no cambian con los filtros.
- No atiende solicitudes de los titulares: para eso está **Privacidad y datos**.
