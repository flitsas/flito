import { SignJWT } from 'jose';

// Helper para generar JWTs válidos en tests. Firma con JWT_SECRET seteado en __tests__/setup.ts.
// El payload coincide con `JwtPayload` definido en src/shared/middleware/auth.ts.

export type TestRole = 'admin' | 'proveedor' | 'transito' | 'compliance' | 'lider_pesv' | 'supervisor_flota' | 'conductor' | 'auditor' | 'gestor_impuestos';

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
  if (opts.allowedPages !== undefined) payload.allowedPages = opts.allowedPages;
  if (opts.transitoCodigo !== undefined) payload.transitoCodigo = opts.transitoCodigo;
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(opts.sub ?? 1))
    .setExpirationTime('1h')
    .sign(secret);
}

export const adminAuth = async (): Promise<string> => `Bearer ${await testToken({ role: 'admin' })}`;
export const proveedorAuth = async (): Promise<string> => `Bearer ${await testToken({ role: 'proveedor' })}`;
