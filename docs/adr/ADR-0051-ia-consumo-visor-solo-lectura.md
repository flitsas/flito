# ADR-0051 — Visor de solo lectura de los registros de consumo de IA

- **Estado:** Propuesto (pendiente de aprobación del Líder Técnico humano; no es Aceptado)
- **Fecha:** 2026-11-27
- **Épica:** ADO #14548, «Consumo de IA». Modo Épica sola (D1): sin Features ni HUs; cuatro PRs en serie (A, B, C1, C2) sobre la rama `EPICA/14548-davidchica-ia-consumo-permisos-lectura`.
- **Supersedes:** ninguno.
- **Relacionados:**
  - ADR-0042 (Propuesto, mismo contexto de Épica #14548): define la auditoría portable del uso de IA. **Este visor no lo sustituye**: escritura, retención y particiones de ADR-0042 siguen tal como están.
  - `docs/adr/ADR-0047-registro-consumo-ia-contrato-v1.md`: el contrato de `ia_consumo_log`, `ia_consumo_detalle` e `ia_tarifa_modelo` (migración 0306). En `develop` hay dos ficheros con prefijo ADR-0047 (el otro es el del detalle universal de la Torre): citar siempre por nombre de fichero.
  - ADR-0022 (admin recibe toda función sembrada por migración), ADR-0035 (migraciones SQL a mano), ADR-0048 (árbol de permisos y menú por áreas: la página nueva cuelga de `menu.administracion`).
  - AGENTS.md §14 (sin PII en URL ni en query), §16 (`pii_access_log`).
- **Módulos:** transversal. **No** es un módulo `flito-*`. Escribe en `ia_consumo_*` todo lo que llama a `conContextoIa`, y lee el árbol de permisos. Se monta en `/api/ia-consumo` **sin** `conAlcance`, como `/api/uso-legacy` (ADR-0033): nace cerrado a los enlaces compañía, proveedor y organismos de tránsito. Permisos en el espacio `ia_consumo.*`.
- **Documento de detalle:** `docs/diseno/epica-14548-consumo-ia-visor.md` (contrato, criterios por bloque, matriz de pruebas, archivos por bloque, riesgos).

## Contexto

El registro de consumo de IA existe desde la migración 0306 y está en `release` desde el 2026-11-19. Hoy solo se puede leer con SQL directo: no hay permisos, ni filtros, ni rastro de quién miró qué (informe de 2026-11-27, H8). La Épica #14548 pide un visor de solo lectura, controlado por el árbol de permisos, con exportación.

El informe deja abiertos tres hallazgos de severidad alta que **este visor no resuelve**: H1 (el chat de Dr. Flit guarda texto que la documentación dice que no guarda), H2 (`validar_identidad` guarda el número de cédula y el resultado biométrico en `respuesta_texto`) y H3 (sin retención; ADR-0047 sigue en Propuesto). El visor audita el acceso a esos datos; no los reduce.

## Decisión

1. **Solo lectura.** El visor no escribe en `ia_consumo_log`, `ia_consumo_detalle` ni `ia_tarifa_modelo`, y no cambia su esquema (D2). La única migración es de datos de permisos: `0321_flito_ia_consumo_permisos.sql`.
2. **Permisos del árbol.** Ítem «Consumo de IA» en Administración (orden 70) con tres acciones: `ver`, `exportar` y `ver_contenido`. Las tres se conceden por defecto solo a `admin` (ADR-0022). El resto de roles las recibe desde el panel de permisos; ninguna acción reparte a otros roles por defecto (D4).
3. **Filtros fuera de la URL.** La búsqueda es `POST /api/ia-consumo/registros/buscar` con los filtros en el cuerpo (AGENTS §14). No hay `GET` con query para datos.
4. **El contenido va aparte.** El prompt y la respuesta solo salen por `POST /api/ia-consumo/registros/:id/contenido`. Exige permiso propio y un motivo de 10 a 150 caracteres sin 6 o más dígitos seguidos ni correos. La auditoría en `pii_access_log` se escribe **antes** de leer el texto, y si falla no se entrega nada (503). Hay una denylist por proceso (`validar_identidad`, `recortar_cedula`) que responde 403 `contenido_restringido` (D3, D6).
5. **Exportación de metadatos, nunca de texto.** CSV con todas las columnas de `ia_consumo_log` (D7), incluidos `error_mensaje` y `metadatos`. Nunca el texto de `ia_consumo_detalle`. Tope duro `IA_CONSUMO_EXPORT_MAX_FILAS` (defecto 2 000): por encima, 422 `export_demasiado_grande`. La auditoría se escribe antes de entregar el primer byte.
6. **Ventana visible.** Búsqueda, detalle, contenido, exportación y relacionados solo ven los últimos `IA_CONSUMO_VISOR_VENTANA_MESES` meses (entero 1..24, defecto 3; D8). Fuera de ventana: 404 en detalle y contenido, igual que un id inexistente; 400 `fuera_de_ventana` en búsqueda y exportación.
7. **Sin agregados.** Ni totales ni costos sumados. Paginación por cursor opaco de 50 filas, sin conteo total.

## Alternativas consideradas y descartadas

- **Épica nueva en ADO para el visor.** Descartada: #14548 ya es el contenedor de ADR-0042 y del visor. Una épica paralela partiría la trazabilidad.
- **Esperar a que ADR-0042 se acepte.** Descartada: el visor no cambia la escritura ni el modelo de datos. Mientras tanto, la única lectura posible es SQL directo sin rastro (H8); esperar mantiene ese hueco abierto.
- **Visor solo de metadatos, sin contenido nunca.** Descartada por decisión humana (D3): el contenido se muestra con permiso aparte, motivo y rastro.
- **Contenido dentro del listado o del detalle.** Descartada: amplía la exposición de cada consulta y mezcla metadatos con texto. Con un endpoint propio, la auditoría dice exactamente qué texto se leyó y por qué.

## Consecuencias

- **Más exposición de datos personales, no menos.** D7 pone en el CSV `usuario_id`, `usuario_login`, `placa`, `entidad_id`, `error_mensaje` y `metadatos`. D3 muestra prompts y respuestas. Mitigaciones: solo admin por defecto, motivo obligatorio, rastro en `pii_access_log`, tope, ventana, exportación sin texto y denylist.
- **El visor audita; no depura.** H1, H2, H3 y H4 (`error_mensaje` solo enmascara números de 6 a 12 dígitos y correos) siguen abiertos. D6 cierra la **lectura** de contenido de los dos procesos de identidad, no su escritura, y no cubre H1 ni los procesos OCR con documentos.
- **Fallo cerrado en contenido y exportación,** más estricto que AGENTS §16, que pide fallo abierto para colas y bandejas. Un visor que no puede registrar una lectura no entrega el dato. Es una decisión de diseño, no un incumplimiento.
- **Motivo libre en `pii_access_log.motivo`** (`varchar(200)`). Se valida que no haya 6 o más dígitos seguidos ni correos, pero un nombre propio puede colarse. Se asume: quien escribe el motivo ya tiene el permiso y el texto queda registrado.
- **Orden de la reversión.** Con la imagen 0321 y sin los permisos en la base, la API no se detiene: `verificarCatalogoAlArrancar` solo registra la incoherencia (`apps/api/src/server.ts:70-80`). El orden seguro es otro: primero se revierte la imagen a una anterior a la 0321 y se espera el rollout; después se ejecuta `docs/arquitectura/epica-14548-0321-rollback.sql` con `psql -1`. Si se borrara antes la fila del ledger con la imagen 0321 aún desplegada, un pod recreado volvería a aplicar la 0321 desde el disco (db-apply del initContainer) y deshacería la reversión.
- **Retención declarada: 3 meses** para `ia_consumo_log` e `ia_consumo_detalle` (decisión del humano, 27-nov-2026). La purga no está en esta Épica: es un bloque aparte, con su propio gate (db-review y security). Hasta entonces los datos se acumulan (H3). `pii_access_log` no se puede purgar: su trigger es append-only (migración 0059), así que su plazo es una decisión de plataforma, pendiente.
- **Número de ADR.** ADR-0050 está reclamado por la Épica #14707 (rama de la kit); este ADR toma el 0051. Se comprobó en todo el historial de Git que no existe ninguna migración 0321 ni ADR 0051 o posterior.

## Decisiones del humano (27-nov-2026)

Registradas por el humano en la sesión de desarrollo de la Épica. Quedan sujetas a la aprobación del Líder Técnico de este ADR.

1. **Retención:** 3 meses para `ia_consumo_log` e `ia_consumo_detalle`, con la purga en un bloque aparte (ver «Consecuencias»). Mientras la purga no exista, subir `IA_CONSUMO_VISOR_VENTANA_MESES` por encima de 3 exige revisión de `security-agent`, porque el visor mostraría registros más antiguos que la retención declarada.
2. **Cifrado:** sin cifrado de columna para `usuario_id`, `usuario_login`, `placa` y `entidad_id`, declarado aquí. Devops confirma si el volumen de la base ya va cifrado en reposo; si no va, es un hallazgo aparte.
3. **`error_mensaje` en el detalle:** se acepta el residual de H4 (respuesta del humano el 27-nov-2026: «Aceptar el residual por escrito»). Por defecto solo lo ve `admin`; cualquier rol al que se conceda `accion.ia_consumo.ver` desde el panel hereda el mismo residual. Los campos quedan auditados en `camposAccedidos`. Es un waiver explícito del humano y se reconsidera con `security-agent` antes de C2 en PDN.
4. **Catálogo de filtros:** incluye `desconocido` (proceso y módulo), porque el registro lo escribe cuando una llamada no trae contexto.
5. **Verificación en base real:** el humano autoriza una base desechable con el historial de migraciones hasta la 0321, en un contenedor propio y sin tocar la base demo. Sirve para `verificarCatalogoAlArrancar` y para la paridad del catálogo (A-27, A-29).

## Decisiones pendientes antes de activar el contenido en PDN

Ver «Riesgos abiertos» del diseño. Antes de desplegar el bloque C2 (botón de contenido) en PDN, el Líder Técnico debe decidir: (a) si la denylist se amplía más allá de `validar_identidad` y `recortar_cedula` (OCR de cédula y de documentos, chat de Dr. Flit, H1); (b) si el waiver de `error_mensaje` (decisión 3) sigue siendo válido tras la revisión de `security-agent`; y (c) el plazo de retención de `pii_access_log`, que fija la plataforma.

## Estado de la aprobación

Propuesto. Lo aprueba el Líder Técnico humano. Este documento no autoriza por sí solo ningún despliegue ni ninguna escritura en Azure DevOps.
