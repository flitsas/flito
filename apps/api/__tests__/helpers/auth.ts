import { SignJWT } from 'jose';
import { PAGES } from '@operaciones/shared-types';
import { PAGINAS_NO_CONCEDIBLES } from '../../src/modules/permisos/catalogo.js';

// Helper para generar JWTs válidos en tests. Firma con JWT_SECRET seteado en __tests__/setup.ts.
// El payload coincide con `JwtPayload` definido en src/shared/middleware/auth.ts.

/**
 * Las páginas que un JWT de `admin` lleva DE VERDAD desde la HU #12081.
 *
 * Antes de esta HU el token de un admin podía ir sin `allowedPages` y daba igual: `getEffectivePages`
 * tenía la rama `role === 'admin'` y `requirePage` le abría todo. El AC4 retiró esa rama, y desde
 * entonces `POST /login` mete en el token la lista RESUELTA contra `permisos_rol_funcion`
 * (`paginasEfectivasDeUsuario`, auth.routes.ts). Un token de prueba sin ellas ya no representa a un
 * administrador real: representa a uno al que le cerraron todas las pantallas.
 *
 * Así que el helper reproduce el token de producción. No es «hacer pasar el test»: es lo contrario —
 * dejarlo como estaba habría hecho fallar ~40 ficheros por una diferencia entre el token de prueba y
 * el que emite el servidor, que es justo lo que un helper de autenticación no debe introducir.
 *
 * Se deriva de `PAGES` menos las no concedibles y no se escribe a mano: si mañana entra una página
 * nueva, el token del admin la lleva sin que nadie toque este fichero.
 */
const PAGINAS_DE_ADMIN = Object.keys(PAGES)
  .filter((s) => !(PAGINAS_NO_CONCEDIBLES as readonly string[]).includes(s));

export type TestRole = 'admin' | 'proveedor' | 'transito' | 'compliance' | 'lider_pesv' | 'supervisor_flota' | 'conductor' | 'auditor' | 'gestor_impuestos' | 'mensajero' | 'financiera' | 'cliente';

interface TestUserOpts {
  sub?: number;
  username?: string;
  role?: TestRole;
  allowedPages?: string[];
  transitoCodigo?: string;
}

export async function testToken(opts: TestUserOpts = {}): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const payload: Record<string, unknown> = {
    username: opts.username ?? 'test-user',
    role: opts.role ?? 'admin',
  };
  const paginas = opts.allowedPages
    ?? ((opts.role ?? 'admin') === 'admin' ? PAGINAS_DE_ADMIN : undefined);
  if (paginas !== undefined) payload.allowedPages = paginas;
  if (opts.transitoCodigo !== undefined) payload.transitoCodigo = opts.transitoCodigo;
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(opts.sub ?? 1))
    .setExpirationTime('1h')
    .sign(secret);
}

export const adminAuth = async (): Promise<string> => `Bearer ${await testToken({ role: 'admin' })}`;
export const proveedorAuth = async (): Promise<string> => `Bearer ${await testToken({ role: 'proveedor' })}`;
