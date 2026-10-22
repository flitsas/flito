# Diseño slim: Feature #13254, «Perfil y cambio autónomo de contraseña» (Épica #12811)

HUs: #13255 (BACKEND) y #13256 (FRONTEND). Toca los módulos **legacy** `users` / `auth` (sin prefijo
`flito-`) y la frontera transversal `shared/middleware/canal-cliente.ts`. No hay módulo, tabla ni endpoint nuevos.

## Patrón reutilizado

| Pieza | Vecino que se calca |
|---|---|
| Página nueva con siembra solo para admin | `apps/api/src/db/migrations/0200_pagina_finanzas_gastos_diarios.sql` + `apps/api/__tests__/db/migracion-0200.test.ts` |
| Guarda dentro del handler cuando la decisión depende de una rama | `tieneFuncion(req, …)` (`shared/middleware/exigir-funcion.ts:186`), igual que `usuarios.contrasena.cambiar_ajena` en `users.routes.ts:50` |
| Saber si el actor es externo | `resolverPermisos(sub).tipoPrincipal` (`shared/permisos-efectivos.ts`): es la misma foto en caché de 60 s que usa `guardiaCanalCliente` |
| Entrada nueva en la allowlist del canal | `RUTAS_PERMITIDAS_CLIENTE` con su `porque` (calco de `POST /api/flito/soat/soportes/zip`) |
| Campo nuevo en el sobre de sesión | `puedeSolicitarSoat` y `transitoCodigo`: van en los dos sobres (`/login` y `/me`), por el Bug #11937 |

## Decisiones

### D1. La guarda del handler: cómo distingue externo de interno y cómo consulta `pagina.perfil`

`req.user` (JWT) solo lleva `sub`, `username`, `role` y `transitoCodigo`. **No** lleva el tipo de principal, y desde la HU 12082 tampoco las funciones. Se resuelve en la petición:

```
// en PATCH /:id/password, ANTES del chequeo de cambiar_ajena
const p = await resolverPermisos(req.user!.sub);
const externo = !p.ok || p.tipoPrincipal === 'externo';   // misma regla que guardiaCanalCliente: si falla, cierra
if (externo && (req.user!.sub !== id || !(await tieneFuncion(req, 'pagina.perfil')))) → 403 { error: 'Sin permisos' }
```

- `resolverPermisos` ya está en caché porque lo pidió `guardiaCanalCliente` en el mismo `authMiddleware`, así que **no añade ninguna consulta**.
- `tieneFuncion` registra el intento denegado, igual que con `cambiar_ajena`.
- **Al externo nunca se le permite cambiar la contraseña de otro**, aunque tenga `cambiar_ajena`. Hoy esa función es «sin efecto por HTTP» para un rol externo, porque la ruta no está en la allowlist, y el panel lo avisa (`permisos-roles.service.ts:327`). Al abrir la ruta en el canal, un externo al que se le hubiera marcado `cambiar_ajena` podría restablecer contraseñas ajenas. La condición `sub !== id → 403` para el externo cierra ese hueco (cubre el AC2 y el AC7 desde el lado del externo).
- Para el **interno** no cambia nada (AC6 y AC7): sigue el flujo actual, sin pedir `pagina.perfil`.
- El 403 lleva el mismo cuerpo `{ error: 'Sin permisos' }` que el canal, así que nadie puede distinguir qué capa negó.

### D2. ¿Hay que meter `pagina.perfil` en `FUNCIONES_DEL_CANAL_EXTERNO`?

**No hace falta para conceder.** El aviso del panel filtra antes con `!f.startsWith('pagina.')` (`permisos-roles.service.ts:327`): cualquier `pagina.*` se puede dar a un rol externo sin aviso. Si la entrada declara `funcion: 'pagina.perfil'` (AC3), el conjunto la incluye solo, porque se deriva de la lista. Es inocuo por ese mismo filtro.

**Conflicto con un test que hay que resolver, y es BLOQUEANTE si no se hace:** `apps/api/__tests__/services/canal-cliente.tipo-principal.test.ts` (bloque «HU #12084 (RN-A1)», líneas ~179-216) ata cada `funcion` de la lista a dos condiciones:
- (a) que sea `tipo = 'operacion'` en el catálogo (l. 206). `pagina.perfil` es de tipo `pagina`.
- (b) que `exigirFuncion` la monte en esa misma ruta dentro de `flito-soat/` (l. 210-216). El PATCH vive en `users/` y **no puede** llevar `exigirFuncion('pagina.perfil')`, porque eso rompería el AC6 (el interno sin Perfil).

Decisión recomendada: cumplir el AC3 al pie de la letra (`funcion: 'pagina.perfil'`) y **ajustar ese test**. Se añade a la lista una constante de excepciones nombrada, `GUARDAS_EN_HANDLER = { 'PATCH /api/users/:id/password': 'pagina.perfil' }`, que (a) y (b) excluyen de forma explícita. Para esas entradas se aserta otra cosa: que la función existe en el catálogo con `tipo = 'pagina'`. La guarda real la prueban los tests de comportamiento del AC2. Hay que actualizar el JSDoc de `RutaCliente.funcion` («el código de `exigirFuncion` o de la guarda del handler»).
La alternativa (no declarar `funcion`, como `/auth/me`) contradice el AC3 y deja la entrada sin documentar. Se descarta.

### D3. La migración 0218

Archivo: `apps/api/src/db/migrations/0218_pagina_perfil.sql`, calco literal de la 0200:
- Cabecera con Feature #13254 / HU #13255, antecedentes 0179/0181/0200 y las mismas reglas: sin BEGIN/COMMIT, `ON CONFLICT DO NOTHING` en los dos INSERT, forma parseable por `permisos-seed-sql.ts`.
- Paso 1: `INSERT INTO permisos_funciones … ('pagina.perfil', '<modulo>', 'Perfil', 'Entrar a la pantalla «Perfil».', 'pagina')`.
  **`<modulo>` no se escribe a mano.** Se copia de la salida de `npm run permisos:seed -w apps/api` una vez que `perfil` está en el grupo General de `PAGE_GROUPS`. En la 0179 `dashboard` es `'general'`, pero la 0205 reagrupó módulos, y el test de paridad compara con lo que genera el código hoy.
- Paso 2: el reparto **solo** a `('admin', 'pagina.perfil')`. Ningún rol de negocio, `cliente` incluido (AC1).
- Bloque `DO $resumen0218$` que verifica 1 función y 1 fila de reparto, y emite `RAISE NOTICE` para el log del CD.

Tests de paridad que se tocan:
- `apps/api/__tests__/helpers/permisos-seed-sql.ts`: añadir `'0218_pagina_perfil.sql'` a `MIGRACIONES_CON_REPARTO`, al final, después de la 0217. Sin esto, el test estático de la 0179 (generador contra lo sembrado) ve `admin → pagina.perfil` en el generador y no en el SQL, y falla.
- Nuevo `apps/api/__tests__/db/migracion-0218.test.ts`, calco de `migracion-0200.test.ts`. **No** debe asertar «es la última migración»: debe asertar «la anterior es la 0217».

### D4. Dónde se arma el sobre con `email` (AC8)

Son dos sitios en `apps/api/src/modules/auth/auth.routes.ts` y no hay un helper común. Se mantiene así, igual que `puedeSolicitarSoat`, para no refactorizar lo legacy:
- `POST /login` (l. ~117): `user: { id, name, username, email: user.email ?? null, role, … }`. La fila `user` ya trae `email`.
- `GET /me` (l. ~151): añadir `email: users.email` al `select`. Así entra en `publico` y sale sin tocar más nada. `companiaId` se sigue quitando como hoy.
- Para que no diverjan: un test que llame a los dos con el mismo usuario y compare `email` (AC8), más el aserto de que `companiaId` no sale en ninguno de los dos.
- Contrato de salida: `email: string | null`. Ni en la URL ni en los logs. El `audit` de login usa `username`, no `email`, y así se queda.

## Contrato delta

| Endpoint | Cambio |
|---|---|
| `PATCH /api/users/:id/password` | Igual para el interno. Externo: 200 `{ok:true}` solo si `id === sub` **y** tiene `pagina.perfil`; si no, 403 `{error:'Sin permisos'}` |
| `POST /api/auth/login` → `user` | + `email: string \| null` |
| `GET /api/auth/me` | + `email: string \| null` |
| Catálogo | + `pagina.perfil` (PageSlug `perfil`, grupo General); no va en `ROLE_DEFAULT_PAGES` / `DEFAULTS_POR_ROL` |

## Archivos a crear o modificar

**HU #13255 (backend-agent)**
- M `packages/shared-types/src/permissions.ts`: `PAGES.perfil = 'Perfil'` y `'perfil'` en `PAGE_GROUPS` General. No se toca `DEFAULTS_POR_ROL`.
- C `apps/api/src/db/migrations/0218_pagina_perfil.sql`
- M `apps/api/src/shared/middleware/canal-cliente.ts`: entrada `{ metodo:'PATCH', patron:'/api/users/:id/password', funcion:'pagina.perfil', porque:… }` y el JSDoc de `funcion`.
- M `apps/api/src/modules/users/users.routes.ts`: guarda D1 en el handler. Import de `resolverPermisos` (ya se importa `invalidarPermisosDe` de ese archivo).
- M `apps/api/src/modules/auth/auth.routes.ts`: `email` en los dos sobres.
- M `apps/api/__tests__/helpers/permisos-seed-sql.ts`: la 0218 en `MIGRACIONES_CON_REPARTO`.
- M `apps/api/__tests__/services/canal-cliente.tipo-principal.test.ts`: excepción `GUARDAS_EN_HANDLER` (D2).
- C `apps/api/__tests__/db/migracion-0218.test.ts`
- C/M el test de la ruta de contraseña (AC2-AC7) y el del sobre de auth (AC8). Se usa el archivo existente si lo hay.
- Verificación: `npm run build -w packages/shared-types`. El test de paridad de la 0179 lee el `dist` (ver la memoria «dist de shared-types viejo tras rebase»).

**HU #13256 (frontend-agent), solo el contrato**
- `apps/web/src/lib/auth.tsx` `interface User`: `email?: string | null`. Va con `?` por el mismo motivo que `puedeSolicitarSoat`: un `/me` viejo no la trae.
- Etiqueta del rol: hoy el sobre solo trae `role` (el código). En el front lo canónico es `ROLE_LABELS[role]` (shared-types), con el código como fallback. Para un rol creado desde el panel (Feature 12072) `ROLE_LABELS` no tiene entrada; el nombre de negocio está en `permisos_roles.nombre` y **ningún sobre de sesión lo expone**. Ver «Pendiente humano».
- `GET /permisos/mios` ya da `rol` y `tipoPrincipal`, pero no el nombre. No hay que añadir endpoint.
- `pagina.perfil` llega en `allowedPages` (`hasPage('perfil')`). Los fixtures E2E (`loginAs`, `FUNCIONES_POR_ROL`) necesitan `perfil` donde el spec lo pida.

## ADR: no aplica

No sienta precedente. La guarda en el handler ya existe (`cambiar_ajena`), y la entrada en la allowlist sigue el procedimiento de la propia lista. La excepción `GUARDAS_EN_HANDLER` del test es la primera de su tipo y queda documentada en el `porque` y en el test.

## Riesgos

1. **R1, escalada externa por `cambiar_ajena`.** Lo cierra D1 (`externo ⇒ solo id propio`). Hace falta un test explícito: externo con `cambiar_ajena` y `pagina.perfil` sobre un id ajeno → 403 y la clave no cambia.
2. **R2, test de atadura rojo** si se declara `funcion` sin ajustar el test (D2). Es un fallo garantizado, no hipotético.
3. **R3, paridad 0179/0200** si la 0218 no entra en `MIGRACIONES_CON_REPARTO`, o si `modulo` se escribe a mano en vez de copiarlo del generador.
4. **R4, «el token no se revoca» (AC3).** El handler llama a `restablecerContrasena(...)` (HU #12171). Hay que comprobar que esa función no invalida la sesión propia (`invalidateSessionCacheFor`). Si lo hace, el AC3 choca con el comportamiento actual de los internos, y eso es una pregunta, no un cambio en silencio.
5. **R5, PII.** `email` es correo personal (Ley 1581): solo el del propio usuario, solo en el cuerpo de la respuesta, nunca en la ruta web (`/perfil` sin parámetros) ni en logs. El cambio de contraseña ya queda auditado (`audit` + historial 12171).
6. **R6, superficie del canal.** Es la primera ruta del canal fuera de `flito-soat`. Rate limiting: el PATCH no tiene limitador propio. AGENTS.md §18 lo pide para auth. `security-agent` diff-scoped dispara (ruta abierta a externos + auth).

## Notas operativas

- backend-agent: el orden en el handler es parse de `id` → guarda D1 (externo) → guarda `cambiar_ajena` (interno) → Zod → verificación de la actual. Los tests usan P1, solo los archivos de este WI. Hay que correr `db-review-agent` (migración) y `security-agent` (canal + auth).
- frontend-agent: `/perfil` sin query. El email se muestra desde la sesión, nunca desde la URL. El PATCH se reusa sin tocar `PasswordForm.tsx` ni `navItems`.
