import { SignJWT } from 'jose';
import { PAGES, paginasPorDefecto, type RoleCode } from '@operaciones/shared-types';
import { PAGINAS_NO_CONCEDIBLES } from '../../src/modules/permisos/catalogo.js';
import type { FilasPermisos } from '../../src/shared/permisos-efectivos.js';

// Helper para generar JWTs válidos en tests. Firma con JWT_SECRET seteado en __tests__/setup.ts.
// El payload coincide con `JwtPayload` definido en src/shared/middleware/auth.ts.

/**
 * Las páginas que un `admin` de prueba tiene DE VERDAD desde la HU #12081.
 *
 * Antes de esa HU el token de un admin podía ir sin `allowedPages` y daba igual: `getEffectivePages`
 * tenía la rama `role === 'admin'` y `requirePage` le abría todo. El AC4 retiró esa rama; el admin
 * real ve todo porque el seed de la 0179 le marcó las 43 `pagina.*` en `permisos_rol_funcion`. Un
 * usuario de prueba sin ellas ya no representa a un administrador real: representa a uno al que le
 * cerraron todas las pantallas.
 *
 * Se deriva de `PAGES` menos las no concedibles y no se escribe a mano: si mañana entra una página
 * nueva, el admin de prueba la tiene sin que nadie toque este fichero.
 */
const PAGINAS_DE_ADMIN = Object.keys(PAGES)
  .filter((s) => !(PAGINAS_NO_CONCEDIBLES as readonly string[]).includes(s));

export type TestRole = 'admin' | 'proveedor' | 'transito' | 'compliance' | 'lider_pesv' | 'supervisor_flota' | 'conductor' | 'auditor' | 'gestor_impuestos' | 'mensajero' | 'financiera' | 'cliente';

interface TestUserOpts {
  sub?: number;
  username?: string;
  role?: TestRole;
  /**
   * Páginas PROPIAS del usuario (lo que en producción es `users.allowed_pages`). Desde la HU #12082
   * NO viajan en el JWT: alimentan el registro del double de permisos (abajo), que es de donde
   * `resolverPermisos` las lee. El admin sin esta opción recibe `PAGINAS_DE_ADMIN`.
   */
  allowedPages?: string[];
  /** Funciones `operacion.*` (o `pagina.*`) que el ROL del usuario tiene en el double. */
  funciones?: string[];
  transitoCodigo?: string;
}

// ── El double de permisos (HU #12082, §10 del diseño) ─────────────────────────────────────────────
//
// `requirePage`, `exigirFuncion` y la frontera del canal deciden con `resolverPermisos(sub)`, que en
// producción hace tres consultas por usuario por minuto. Si esas consultas consumieran el `selectMock`
// de los ~172 ficheros que firman tokens con este helper, todos caerían. Así que al importarse, el
// helper sustituye la LECTURA DE FILAS del resolutor (no la regla: `(R ∪ C) \ V`, `isValidPage`, el
// hash y la caché corren igual) por este registro, indexado por `sub`. Cada `testToken()` registra a
// su usuario e invalida su entrada de caché, de modo que el último token firmado para un `sub` es el
// que manda.
//
// El módulo del resolutor se importa EN DIFERIDO (dentro de `registrarUsuarioDePrueba`) y no arriba,
// a propósito: `permisos-efectivos.ts` importa `db/client.js`, y la mayoría de los ficheros lo mockean
// con una factory que referencia un `const selectMock` declarado DESPUÉS de los imports. Un import
// estático desde aquí —hoisted junto a los demás— evaluaría esa factory antes de que el `const`
// exista (TDZ) y tumbaría el fichero entero. Cuando `testToken()` corre, el fichero ya está inicializado.
//
// En un fichero que haga `vi.mock` del módulo entero, `fijarFuenteDePermisos` no existe (o es un stub
// que lanza al accederlo) y este helper no fija nada: ese fichero manda.
//
// Un `sub` NO registrado resuelve `{ ok:false, motivo:'sin_usuario' }`: la frontera del canal lo
// trata como externo y `requirePage` lo niega. Quien firme un token sin este helper y espere pasar
// una guarda tiene que registrarlo con `registrarUsuarioDePrueba`.
const registro = new Map<number, FilasPermisos>();

/** La fuente que este helper fija. Un test que la sustituya a mano la repone con esto. */
export const fuenteDePrueba = async (sub: number): Promise<FilasPermisos | null> => registro.get(sub) ?? null;

export async function registrarUsuarioDePrueba(sub: number, filas: FilasPermisos): Promise<void> {
  registro.set(sub, filas);
  try {
    // Se fija en CADA registro y no una sola vez: los ficheros que hacen `vi.resetModules()` en su
    // `beforeEach` reciben una instancia nueva del resolutor, con la fuente real, en cada caso.
    // Fijarla vacía la caché, que es lo que se quiere al registrar (o re-registrar) a alguien.
    const mod = await import('../../src/shared/permisos-efectivos.js');
    if (typeof mod.fijarFuenteDePermisos === 'function') mod.fijarFuenteDePermisos(fuenteDePrueba);
  } catch {
    // El módulo está mockeado entero por el fichero de test: no hay seam que fijar.
  }
}

export async function testToken(opts: TestUserOpts = {}): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const role = opts.role ?? 'admin';
  const sub = opts.sub ?? 1;
  const payload: Record<string, unknown> = {
    username: opts.username ?? 'test-user',
    role,
  };
  if (opts.transitoCodigo !== undefined) payload.transitoCodigo = opts.transitoCodigo;

  await registrarUsuarioDePrueba(sub, {
    rol: role,
    tipoPrincipal: role === 'cliente' ? 'externo' : 'interno',
    allowedPages: opts.allowedPages ?? (role === 'admin' ? PAGINAS_DE_ADMIN : []),
    funcionesDelRol: [
      ...paginasPorDefecto(role as RoleCode).map((s) => `pagina.${s}`),
      ...(opts.funciones ?? []),
    ],
    excepciones: [],
  });

  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(sub))
    .setExpirationTime('1h')
    .sign(secret);
}

export const adminAuth = async (): Promise<string> => `Bearer ${await testToken({ role: 'admin' })}`;
export const proveedorAuth = async (): Promise<string> => `Bearer ${await testToken({ role: 'proveedor' })}`;
