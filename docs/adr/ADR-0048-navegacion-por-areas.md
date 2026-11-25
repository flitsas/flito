# ADR-0048 — Menú de FLITO por áreas de la empresa

- **Estado:** Propuesto (pendiente de aprobación del Líder Técnico humano; no es Aceptado)
- **Fecha:** 2026-11-24. Mapa final tras la retroalimentación de Andrés (PO), aprobado por el humano el mismo día.
- **Épica:** ADO #14678 «[ Menú ] Organizar FLITO por áreas de la empresa» (PO: Andrés Jiménez). Sin Features ni HUs todavía.
- **Supersedes:** ninguno. **Relacionados:** ADR-0025 (árbol de permisos, citado en `packages/shared-types/src/permisos-arbol/index.ts`), ADR-0022 (`admin` recibe toda función sembrada por migración ≥ 0225, en el mismo archivo), ADR-0023 (módulos legacy por permiso de página, una página por ítem y «Administrar <ítem>» transitorio).
- **Módulos:** no es un módulo `flito-*` nuevo. Afecta a la navegación (`apps/web/src/components/shell/`) y al árbol de permisos transversal (`packages/shared-types/src/permisos-arbol/`, `apps/api/src/modules/permisos/`).
- **Documento de detalle:** `docs/arquitectura/epica-14678-menu-por-areas.md`

## Contexto

El menú agrupa las entradas por dominio (General, Gestión, Tránsito, Flota, Mantenimiento, PESV, RNDC, LAFT, Finanzas, Administración, Ayuda). La Épica pide agruparlas por ocho áreas de la empresa, en este orden: Operaciones, Financiera, Comercial, Diseño, Tecnología, Infraestructura, Producto, Gerencial. Ayuda queda fuera de las áreas, al final, como hoy. Rutas, pantallas y funciones no cambian.

Hoy la sección del menú y el elemento de nivel 1 del árbol son dos cosas que se cruzan:

- El menú pinta grupos según `NavItem.section` (`navEntradas.ts`) y rotula cada grupo con el nombre de su `menu.*` (`navItems.ts`).
- El árbol de permisos decide qué ve cada rol y usuario por la cadena `menu.* → pagina.* → accion.*`. Un nodo cuenta solo si está marcado y su padre es efectivo (`apps/api/src/shared/permisos-efectivos.ts`, `apps/api/src/modules/permisos/arbol/expansion.ts`, `efectivoDeNodos`).

Un `pagina.*` cuyo `menu.*` padre no está marcado desaparece del menú aunque el rol tenga la página marcada. Cualquier cambio de agrupación que toque el padre es, por tanto, un cambio de permisos con riesgo de pérdidas (alguien pierde una pantalla) y de ganancias (alguien gana una pantalla que antes no veía).

Decisiones ya tomadas por el PO/equipo y que este ADR no reabre: alcance = presentación + árbol de permisos (nuevos `menu.*` y migración de roles y usuarios); áreas vacías ocultas; expand → contract (los `menu.*` viejos no se borran); landing = Tablero fijado explícitamente; entrega en PRs en serie.

## Desviación de la Épica (decidida por el PO)

La Épica pide «exactamente ocho áreas». El menú final tiene **cuatro opciones con entradas más Ayuda fuera**, y dos de ellas no son áreas de la empresa:

- **Kyverum** = módulos legacy (pedido de Andrés). Opción propia, no área de la empresa.
- **Administración** = opción propia del menú. No es subgrupo de Operaciones. Reutiliza el elemento existente `menu.administracion`.

Las ocho áreas siguen en `SECTION_ORDER`; las cinco sin entradas (Comercial, Diseño, Tecnología, Infraestructura, Producto) se ocultan por el filtro existente. Esta desviación queda declarada aquí y en la Épica.

## Decisiones del humano (2026-11-24) sobre el mapa

| Tema | Decisión |
|---|---|
| Operaciones (11 entradas) | vehicles, clients, flito_tramites, flito_derechos, flito_revisiones, flito_bitacora, flito_comparendos, flito_logistica, flito_logistica_ruta, flito_soat, flito_impuestos. |
| Financiera (10 entradas) | Las 7 de Finanzas (reporte de costos, gastos diarios, bolsas, tarifas, servicios adicionales, comprobantes, conciliación) y las 3 de Siigo (`siigo_parametrizacion`, `siigo_operacion`, `siigo_credenciales`). |
| Gerencial (9 entradas) | `dashboard` (Tablero) y las 8 de Torre de Control, incluida `torre_umbrales`. LAFT y Trámite Digital **no** están aquí. |
| Kyverum (43 entradas, opción propia) | `transito` (Bandeja de trámites), `fleet`, `maintenance_inicio`, `maintenance_ordenes`, `maintenance_indicadores`, las 25 de PESV, `rndc` (RNDC, Remesas, Manifiestos, Maestros), `rndc_admin`, las 7 de LAFT, `tramite` (Trámite Digital). |
| Administración (7 entradas, reutiliza `menu.administracion`) | privacy (Log accesos PII y Privacidad y datos), users, roles_permisos, drive, admin_rendimiento y `transito_organismos` (Organismos STT, movido desde Tránsito por Andrés). |
| Subgrupos del riel de Kyverum (solo presentación) | Tránsito, Flota, Mantenimiento, PESV, RNDC, LAFT, Trámites. |
| Subgrupos de Operaciones y Administración | Sin riel: las listas son cortas (11 y 7). |
| Orden de opciones en el menú | Operaciones, Financiera, (Comercial, Diseño, Tecnología, Infraestructura, Producto: sin `menu.*` hasta tener entradas), Gerencial, Kyverum, Administración, Ayuda (derivada, fuera de áreas). |
| Dr. Flit y Perfil | Fuera de las áreas en el panel, como Ayuda. |
| Ayuda FLITO | Fuera de las áreas; sus categorías (`GRUPOS_ORDEN`) no cambian en esta Épica. |
| Landing | Tablero (`/`). Logo → Tablero. |

**Pendiente UX (no es de permisos):** nombre «Operaciones» para el canal Cliente, que el PO revisa con la maqueta. No afecta al árbol.

Recuento de control: 11 + 10 + 9 + 43 + 7 = **80 entradas** (coincide con el total de la versión anterior: 53 + 10 + 17 = 80). Los recuentos los aporta el humano; PR1 los verifica contra los `ItemDef` del árbol, en particular las 25 de PESV (ADR-0023 registró 19 ítems `pesv` en 2026-10-07).

## Decisión

1. **El elemento de nivel 1 (`menu.*`) es la única fuente de verdad de la pertenencia de una página a una opción del menú**, tanto para el permiso como para la presentación. La sección del menú se deriva de su elemento, no se mantiene en paralelo.
2. Se crean cuatro elementos: `menu.operaciones`, `menu.financiera`, `menu.gerencial` y `menu.kyverum`. Solo para las opciones con entradas.
3. Se **reutiliza** `menu.administracion`: no se crea ni se renombra. Sus hijos actuales siguen; entran `transito_organismos` y salen las páginas Siigo hacia Financiera.
4. **Expand → contract.** En esta Épica (expand) se crean los elementos nuevos, se re-parentan las páginas, se conceden los elementos nuevos a quien ya tenía acceso y los viejos se marcan como deprecados (se ocultan en el panel, no se borran, no se les quitan las marcas). El borrado de los viejos queda para una Épica posterior (contract).
5. **Pérdidas = 0 y ganancias = 0**, por rol y por usuario, comparando la expansión del árbol viejo con la del árbol nuevo. Es criterio de aceptación de PR1. Las excepciones se declaran una a una; no hay excepciones implícitas.
6. **La agrupación de presentación vive en código** (orden de opciones, rótulos y riel de subgrupos en `navEntradas.ts`/`navItems.ts` y el panel). Un test de consistencia exige que la sección de cada `NAV_ENTRADAS` coincida con el padre de su `pagina.*` en el árbol.
7. **El árbol no gana un nivel de grupo.** Se mantiene elemento → ítem → acción. Los subgrupos (riel) son presentación del panel, no nodos.
8. **Landing:** `/` (Tablero) si el usuario tiene `pagina.dashboard`; si no, la primera entrada permitida del array `NAV_ENTRADAS`, sin reordenar el array.
9. **Admin explícito (ADR-0022).** La migración 0315 siembra elementos nuevos, así que debe marcarlos a `admin` en el mismo archivo, con `JOIN permisos_roles` como en 0240 (paso 2b). No basta con que `admin` tenga todas las páginas.

## Alternativas consideradas

| Opción | Descripción | Pros | Contras | Esfuerzo | Veredicto |
|---|---|---|---|---|---|
| **(a) Solo presentación (web)** | Cambiar `section` y el orden de secciones; el árbol no cambia. | Cero migración, cero pérdidas o ganancias, PR único, revertible con un commit. | El panel «Roles y permisos» sigue mostrando los dominios viejos. Admin concede por dominio y usuario ve por opción. Contradice el alcance decidido. | S | Descartada como destino. Válida como contingencia si PR1 no cierra V1. |
| **(b) Árbol por opción, expand → contract** | Nuevos `menu.*`, re-parentado, migración de marcas y de excepciones de usuario, viejos deprecados. | Un solo modelo para panel y menú. Admin concede por opción. Alcance decidido. | Migración con riesgo de ganancias. Verificación fuerte. Contrato compartido cambia (flag `deprecado`). | M–L (3 PRs) | **Recomendada.** |
| **(b′) Árbol por opción, migración directa** | Cambiar códigos o padres de golpe y borrar lo viejo. | Menos filas. | Rompe marcas y deep links de permisos existentes; pérdidas no controladas; rollback imposible. | M | Rechazada: lo prohíbe expand → contract. |

Ubicación de la agrupación:

| Opción | Veredicto |
|---|---|
| c1. Todo en código | Rechazada para permisos: el resolutor vive en la API y la BD es la verdad de las marcas. |
| c2. Todo en BD (tabla de opciones) | Rechazada: tabla y migración para algo que cambia poco, y duplica el árbol. |
| c3. Híbrido: padre en el árbol (BD + `shared-types`) = permiso; orden, rótulos y riel de presentación en código, con test de consistencia | **Recomendada.** |

## Consecuencias

- **Positivas:** el panel, el menú, la paleta de comandos y los permisos usan la misma pertenencia. La presentación de opciones nuevas es cambio de código, no de BD.
- **Negativas:** hay dos sistemas de nombres durante la transición (viejo deprecado y nuevo) y el panel debe ocultar los deprecados. Kyverum y Administración apartan el menú de la lista de ocho áreas de la Épica (desviación declarada).
- **Riesgo principal:** ganancias y pérdidas silenciosas por marcas dormantes, por `revocar` de elementos viejos y por la reutilización de `menu.administracion` (ver abajo). Se mitiga con la verificación bidireccional antes de aprobar PR1.
- **Riesgo específico de la reutilización de `menu.administracion`:** `transito_organismos` pasa a colgar de `menu.administracion`. Un usuario con `revocar` directo sobre `menu.administracion` pierde `transito_organismos` aunque su rol lo tenga por `menu.transito`. El modelo de tres niveles no permite conservar una página con su padre revocado: es una **pérdida que no se evita por migración**. Si la medición (V5) la encuentra, se declara como excepción aprobada por el PO. No se resuelve en silencio.
- **Riesgo de proceso:** AGENTS exige que todo PR de producto esté ligado a una HU o Bug. Antes de abrir PR1 hay que crear el Feature bajo la Épica y sus HUs (tech-lead-agent). La Épica no tiene campos de trazabilidad de PR.

## Lo que valida PR1 (criterios de aceptación de este ADR)

1. **Pérdidas = 0 y ganancias = 0** por rol y por usuario, con salida real pegada en el PR (en-seco extendido). Excepciones declaradas: elementos viejos deprecados, `menu.*` nuevos y, si aparece, el caso de `revocar` de `menu.administracion` con `transito_organismos` (aprobado por el PO).
2. **Rollback:** el código viejo no borra ni reconcilia a la baja códigos desconocidos (`menu.operaciones`, `menu.financiera`, `menu.gerencial`, `menu.kyverum`) al arrancar. Si lo hace, el rollback no es seguro y hay que documentar un SQL inverso antes de promover.
3. **Hipótesis R7:** `REPARTO_POSTERIOR_AL_ARBOL` se aplica después de derivar los roles de elementos y páginas en `catalogoCompleto`. Confirmar o descartar con un test de catálogo. Afecta a semillas, no a las marcas existentes.
4. **Filas no verificadas del mapa:** las páginas sin leer en código (Trámite Digital, PESV, RNDC, LAFT, mantenimiento, flota, Siigo y Administración) se leen antes de codear. Los recuentos del humano (11/10/9/43/7) se contrastan con los `ItemDef`. Si algo no encaja, se para y se pregunta; no se reasigna en silencio.
5. **Recuentos de riesgo:** marcas dormantes por rol (consulta A); `revocar` de `menu.*` en usuarios (consulta B); usuarios con `revocar` de `menu.administracion` que tengan `transito_organismos` por rol (caso de la pérdida anterior). Decisión explícita si cualquiera es distinto de cero.

## Criterios de salida del ADR

- Los cinco puntos anteriores cerrados con salida real pegada en el PR.
- Contract (retirar los `menu.*` deprecados) fuera de esta Épica, con su propio ADR si se decide.
