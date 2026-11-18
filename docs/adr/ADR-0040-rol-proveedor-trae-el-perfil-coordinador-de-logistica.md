# ADR-0040 — El rol `proveedor` trae por defecto el perfil «Coordinador de proveedor» de logística

- **Estado:** Propuesto
- **Fecha:** 2026-11-09
- **Autor:** architecture-agent (sesión local con David Chica)
- **Épica / Feature:** #13757 / #14326 (PR #764, rama `FEATURE/14326-davidchica-proveedores-logistica-consola`)
- **Supersedes (parcial):** ADR-0039 §12, la línea «Conjuntos recomendados para los roles (los crea el administrador; **no se siembran**)». El resto de ADR-0039 sigue vigente, incluidas las fronteras de §6 y la tabla de rutas de §7 (cerrar lote, reversar y viajes adicionales siguen cerrados al proveedor, D3).

## Contexto

ADR-0039 dejó el perfil «Coordinador de proveedor» como recomendación: el administrador lo armaba a mano y la migración no lo sembraba. En la sesión local del 2026-11-09 David Chica decidió: «el proveedor debería poder tener logística». Desde ahora el rol `proveedor` trae ese perfil sembrado. Un mensajero de proveedor se arma por usuario: se le revoca `logistica.actas.operar_ajenas`, que es la regla de `flito-logistica.mensajeros.ts`.

Un proveedor que no presta logística (por ejemplo, uno solo de SOAT) no debe ver Logística. Hoy el menú ya lo cumple: `paginasDePermisos` (`apps/api/src/shared/permisos-efectivos.ts`, HU #14338) descarta las páginas cuyo módulo pide un servicio que el proveedor no presta. Las rutas también lo cumplen: la frontera por servicio de `conAlcance` responde 403. Lo que todavía no lo cumple es la lista `funciones` de `/auth/me`.

## Decisión

1. **Reparto de filas en `permisos_rol_funcion` para el rol `proveedor`** (migración 0299, forma `JOIN permisos_roles`). Las filas se marcan después del paso al árbol, así que son acciones, páginas y opcionales, no operaciones sueltas:
   - Páginas: `pagina.flito_logistica` y `pagina.flito_logistica_ruta`.
   - Acciones: `accion.logistica.ver_consola`, `accion.logistica.ver_actas`, `accion.logistica.generar_actas`, `accion.logistica.despachar_entregar_devolver`, `accion.mi_ruta.ver`, `accion.mi_ruta.escanear` y `accion.mi_ruta.reportar_novedad`.
   - Opcionales: `logistica.actas.descargar`, `logistica.actas.despachar`, `logistica.actas.operar_ajenas`, `logistica.recogida.confirmar`, `logistica.traslado.registrar` y `logistica.traslado.anular`.
   - No se siembran: `accion.logistica.cerrar_lote`, `accion.logistica.reversar_paso`, `accion.logistica.registrar_viajes` (viajes adicionales, D3), `logistica.actas.firmar_flit` (N4), `logistica.documento.dejar_pendiente` (R20), `logistica.documento.resolver_tramite` (R20), `logistica.actas.ver_documento_firmante` (PII, se concede aparte) y `logistica.motivos.gestionar`.
2. **`logistica.traslado.anular` se declara también opcional de `accion.logistica.despachar_entregar_devolver`.** Hoy solo cuelga de `reversar_paso`, una acción cerrada al proveedor. Con la regla de cadena no contaría sin su padre. El árbol ya admite que varias acciones declaren el mismo opcional (`PADRES_DE_OPCIONAL`): basta que una de ellas sea efectiva.
3. **El filtro por servicio se aplica como una proyección para `/me`, no dentro del resolutor.** Se añade `funcionesDePermisos(p)`, simétrica a `paginasDePermisos`. Para el enlace `proveedor` quita las funciones cuyo módulo pide un servicio que el proveedor no presta. `resolverPermisos`, `conjuntoEfectivo`, `usuariosConFuncion`, `filtrarPorFuncion` y `companiasConUsuarioConFuncion` no cambian.

## Alternativa descartada

**Filtrar dentro de `resolverPermisos`** (propuesta del hilo). `exigirFuncion` y `/me` quedarían coherentes por construcción. A cambio, `usuariosConFuncion`, `filtrarPorFuncion` y `companiasConUsuarioConFuncion` tendrían que leer el proveedor y sus servicios de cada usuario para seguir siendo equivalentes al resolutor: es una consulta más en tres funciones, `FilasPermisos` crece y los dos tests de equivalencia cambian. El beneficio no compensa: la decisión en el API ya la toma la frontera por servicio (`conAlcance`). Esfuerzo M frente a S.

## Consecuencias

- Todos los usuarios con rol `proveedor` ganan las filas, también los de un proveedor solo de SOAT. Para ellos las filas quedan latentes: no tienen página, la ruta les da 403 y no aparecen en `funciones` de `/me`. Si su proveedor empieza a prestar logística, se abren sin tocar permisos, porque `invalidarPermisosDeProveedor` ya vacía la caché.
- La migración no afecta a la caché: el rollout reinicia los pods.
- Cambia el texto de ayuda del rol (`users.md`, `flito_logistica.md`).

## Respuesta del humano

**David Chica, sesión de pruebas en local del 2026-11-09:** «El proveedor debería poder tener logística»; eligió el perfil **Coordinador** (recomendado) y aprobó este ADR **con Generar actas** (`accion.logistica.generar_actas`). «Registrar viajes» = `logistica.traslado.registrar` (viaje a cliente); los viajes adicionales siguen cerrados. El aterrizaje en SOAT observado en la sesión no fue un defecto: el proveedor de prueba ya prestaba SOAT. El estado del ADR no lo cambia ningún agente.
