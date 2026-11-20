# ADR-0026 — Dr. Flit radica en ADO de forma síncrona, sin persistir el caso, con rutas transversales a la frontera por enlace

- **Estado:** Propuesto (lo aprueba el Líder Técnico; ningún agente lo marca Aceptado)
- **Fecha:** 2026-10-22
- **Feature:** #13695 (Épica #12757) — HUs #13803, #13804, #13805, #13806, #13807
- **Relacionados:** ADR-0021 (outbox hacia FLIT 1: patrón asíncrono que aquí se descarta), ADR-0024 (frontera por enlace: se usa `RUTAS_TRANSVERSALES`, no se modifica la regla). No supersede ninguno.
- **Diseño operativo:** `docs/diseno/feature-13695-dr-flit-soporte.md`

## Contexto

Dr. Flit (F3) debe permitir radicar un caso de soporte como Bug en el proyecto ADO **FLIT - SOPORTE** y devolver al usuario solo el número. El caso lleva PII (nombre, correo, teléfono, texto libre y adjuntos) y sale hacia un tercero (Microsoft Azure DevOps). El humano cerró el 2026-10-22: FLITO guarda solo metadatos del intento durante 12 meses (D6), los adjuntos no quedan en reposo (P9-4 a), el borrador vive en la memoria del panel (P9-6 a), la autorización Ley 1581 es por usuario, finalidad y versión (P9-5 a) y hay adaptador simulado prohibido en PDN (P9-1 a).

Es el **primer cliente de escritura hacia ADO** desde `apps/api` y el primer módulo FLITO de sesión cuyos usuarios objetivo (`proveedor`, `gestor_impuestos`) tienen enlace, así que la frontera de ADR-0024 lo cerraría si se montara como un módulo normal.

## Decisión

1. **Radicación síncrona en la petición del usuario.** Un `POST` multipart; el servidor sube los adjuntos y crea el Bug (con `AttachedFile` en el mismo json-patch) dentro de la petición, y responde el número. No hay outbox, ni cola, ni cifrado del caso, porque el caso no se guarda.
2. **Cliente REST propio con `fetch` nativo** detrás de la interfaz `ClienteSoporteAdo` (adaptador real y simulado). Sin SDK de Azure DevOps y sin `shared/upstream.ts` (reintenta, y un create no es idempotente). Sin reintentos automáticos; el reintento es del usuario con clave de idempotencia.
3. **El adaptador simulado no puede arrancar en PDN**: `superRefine` de `env.ts` falla con `DRFLIT_ADO_MODO=simulado` y `DEPLOY_ENVIRONMENT=PDN`, o con `NODE_ENV=production` sin `DEPLOY_ENVIRONMENT`. Se introduce `DEPLOY_ENVIRONMENT` (`DEV`|`QA`|`PDN`), que el repo no tenía, porque `NODE_ENV` no distingue QA de PDN.
4. **Autorizaciones de solo inserción** (`flito_drflit_autorizaciones`), protegidas por trigger `BEFORE UPDATE OR DELETE` + `BEFORE TRUNCATE`, como `pii_access_log`. Guardan el SHA-256 del texto aceptado. **Intentos** (`flito_drflit_casos_soporte`) sin texto del caso, con clave de idempotencia única por usuario y purga diaria a 12 meses.
5. **Frontera por enlace:** el router se monta **sin** `conAlcance` y sus tres rutas se declaran en `RUTAS_TRANSVERSALES` (rutas de sesión que solo tocan datos del propio usuario). El enlace `compania` se rechaza explícitamente en el router, además de `requireRole` sin `cliente`.

## Alternativas consideradas

| Alternativa | Por qué no |
|---|---|
| Outbox + worker (ADR-0021) | Persiste el caso y los adjuntos en FLITO (contra D6 y P9-4) y no devuelve el número en el momento |
| SDK `azure-devops-node-api` | Dependencia nueva para dos llamadas; más difícil garantizar que el PAT y el cuerpo no lleguen a un log |
| Adjuntos en MinIO temporal (P9-4 b) | Rechazada por el humano: PII en reposo y cron extra |
| `'drflit'` en `MODULOS_FRONTERA` abierto a `proveedor` y `organismos_transito` | Más declarativo, pero cambia un `Record` exhaustivo que consumen la web y el panel de roles, y el snapshot del centinela, para tres rutas que no son un módulo de negocio |
| Una sola migración con las dos tablas en HU-1 | Obliga a fijar la tabla de intentos antes de verificar el mapeo real en HU-2; una migración aplicada no se edita |

## Consecuencias

- **Positivas:** superficie mínima de Habeas Data (nada del caso en FLITO); sin dependencias nuevas; modo simulado para DEV sin riesgo en PDN; prueba de consentimiento por texto exacto.
- **Negativas / aceptadas:** la petición puede tardar hasta ~60 s si ADO está lento; duplicado residual si se pierde la respuesta del create (mitigado con `Ref. FLITO: DRF-<id>` en el caso); adjuntos huérfanos en ADO si el create falla tras subirlos; un rol nuevo de `USER_ROLES` entra al soporte por defecto (lo frena un test que fija la lista).
- **Precedente:** `DEPLOY_ENVIRONMENT` queda disponible para otros módulos que necesiten distinguir QA de PDN. Rutas de un panel de sesión que solo tocan datos propios pueden ir en `RUTAS_TRANSVERSALES` con su `porque` y guarda explícita de enlace.
- **Operación:** definir `DEPLOY_ENVIRONMENT`, PAT por ambiente (solo Work Items R/W) y `DRFLIT_PURGA_CRON_ENABLED=1`; crear los tags `FLITO` y `FLITO-PRUEBAS` en FLIT - SOPORTE; aplicar 0245/0246 a mano fuera de local.
