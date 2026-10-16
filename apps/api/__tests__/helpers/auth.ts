import { SignJWT } from 'jose';
import { PAGES, paginasPorDefecto, type RoleCode } from '@operaciones/shared-types';
import { PAGINAS_NO_CONCEDIBLES, repartoDePartida } from '../../src/modules/permisos/catalogo.js';
import { ancestrosDe, claseDe, codigosQueConceden, expandir, PADRES_DE_OPCIONAL } from '../../src/modules/permisos/arbol/expansion.js';
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

/**
 * Las OPERACIONES que un rol de prueba tiene DE VERDAD desde la HU #12083.
 *
 * Con las rutas reconducidas a `exigirFuncion`, un token de `admin` sin `soat.solicitud.enviar` en su
 * conjunto recibe 403 en `POST /enviar`: no representa a un administrador real, que las tiene todas
 * sembradas por la 0179/0181. Se cargan desde `repartoDePartida()` —la foto histórica, que es lo que
 * la base tiene sembrado— y NO se escriben a mano; `opts.funciones` sigue siendo aditivo. Un rol que
 * la foto no conoce (`'gestor'` inventado por un spec) no recibe ninguna: 403, como con `requireRole`.
 *
 * Se llena en diferido y una sola vez: `repartoDePartida()` cruza foto y catálogo (sin base), pero no
 * hace falta pagarlo en un fichero que nunca firme un token.
 */
const REPARTO_POR_ROL = new Map<string, string[]>();
export function operacionesDePartida(rol: string): string[] {
  if (REPARTO_POR_ROL.size === 0) {
    // HU #13429: con la cadena, la partida sin sus páginas no expande nada (la acción exige su ítem): se devuelve
    // ENTERA (páginas y `menu.*` incluidos), que es lo que la base tiene sembrado tras la 0239.
    for (const [r, codigo] of repartoDePartida()) REPARTO_POR_ROL.set(r, [...(REPARTO_POR_ROL.get(r) ?? []), codigo]);
  }
  return REPARTO_POR_ROL.get(rol) ?? [];
}

/**
 * HU #13429 — Todo lo que el rol tiene sembrado tras la 0239, páginas incluidas: las de `paginasPorDefecto` y las
 * que la cadena le sembró (Organismos STT al auditor, Logística al mensajero) y sus `menu.*`.
 */
export function funcionesDePartida(rol: string): string[] {
  return operacionesDePartida(rol);
}

/**
 * HU #13429 (lección del PR #494) — Con el resolutor en cadena, un fixture que da un código suelto (una página sin su
 * elemento, una operación absorbida sin su acción) daría 403. `conCadena` añade lo que lo concede de verdad: el
 * nodo con todos sus ancestros; para una operación absorbida, la primera acción o ítem que la expande y su cadena;
 * para un opcional, su padre y su cadena. Lo que se pide medir no cambia: el fixture sigue dando ESE código.
 */
export function conCadena(codigos: readonly string[]): string[] {
  const salida = new Set<string>();
  for (const c of codigos) {
    salida.add(c);
    const clase = claseDe(c);
    if (clase === 'nodo') for (const a of ancestrosDe(c)) salida.add(a);
    else if (clase === 'opcional') { const p = PADRES_DE_OPCIONAL.get(c)![0]!; for (const a of [p, ...ancestrosDe(p)]) salida.add(a); }
    // Una PÁGINA absorbida por una acción (la compuerta, el Tablero FLITO) no trae la acción: sería una ganancia.
    else if (clase === null && !c.startsWith('pagina.')) {
      const via = codigosQueConceden(c).find((x) => x !== c && claseDe(x) === 'nodo');
      if (via) for (const a of [via, ...ancestrosDe(via)]) salida.add(a);
    }
  }
  return [...salida];
}

/**
 * HU #13429 — «El usuario tiene EXACTAMENTE estas operaciones». Con la cadena, una operación se tiene por su acción,
 * que trae también sus hermanas; las que no se pidieron se revocan (revocar gana al final). Para los specs que miden
 * que CADA ruta exige SU operación aunque se tengan las de al lado.
 */
export function soloEstas(funciones: readonly string[]): Pick<FilasPermisos, 'funcionesDelRol' | 'excepciones'> {
  const pedidas = new Set(funciones);
  const extra = [...expandir(conCadena(funciones))].filter((c) => !pedidas.has(c) && claseDe(c) === null && !c.startsWith('pagina.'));
  return { funcionesDelRol: conCadena(funciones), excepciones: extra.map((codigo) => ({ codigo, efecto: 'revocar' as const })) };
}

/**
 * HU #13429 — Para los specs que fijan su propia fuente de filas con códigos sueltos (`fijarFuenteDePermisos`):
 * la misma fuente con `conCadena` sobre lo del rol y sobre las excepciones `conceder`. Las `revocar` no se tocan.
 */
export function conCadenaEnFuente(fuente: (userId: number) => Promise<FilasPermisos | null>): (userId: number) => Promise<FilasPermisos | null> {
  return async (userId) => {
    const f = await fuente(userId);
    if (!f) return f;
    const concedidas = conCadena(f.excepciones.filter((e) => e.efecto === 'conceder').map((e) => e.codigo));
    const revocadas = f.excepciones.filter((e) => e.efecto === 'revocar');
    return {
      ...f,
      funcionesDelRol: conCadena(f.funcionesDelRol),
      excepciones: [...concedidas.map((codigo) => ({ codigo, efecto: 'conceder' as const })), ...revocadas],
    };
  };
}

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
  /**
   * Funciones `operacion.*` (o `pagina.*`) que el ROL del usuario tiene en el double, ADEMÁS de las
   * operaciones de partida del rol (foto de la #12081 ampliada por la #12083).
   */
  funciones?: string[];
  transitoCodigo?: string;
  /**
   * HU #12875: el `tipo_enlace` del rol en el double, si no es el de fábrica. Lo usan las pruebas que
   * miden el FILTRO DEL SERVICIO de un módulo que la frontera aún tiene cerrado a ese enlace (p. ej.
   * Impuestos para `organismos_transito`, que abre #13426): con `'ninguno'` la petición llega al
   * servicio. El cierre en sí lo prueba `frontera-por-enlace.test.ts`.
   */
  tipoEnlace?: string;
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
  // HU #13429: lo que el spec registre con códigos sueltos se completa con su cadena (`conCadena`), igual que en la
  // base tras la 0239; lo que se mide (que el usuario tiene ESE código) no cambia. `null` = «el resolutor no decide».
  registro.set(sub, filas === null ? (null as never) : {
    ...filas,
    funcionesDelRol: conCadena(filas.funcionesDelRol),
    excepciones: [
      ...conCadena(filas.excepciones.filter((e) => e.efecto === 'conceder').map((e) => e.codigo)).map((codigo) => ({ codigo, efecto: 'conceder' as const })),
      ...filas.excepciones.filter((e) => e.efecto === 'revocar'),
    ],
  });
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

/** `permisos_roles.tipo_enlace` de los roles de fábrica (0178; `proveedor_soat` → `proveedor` en la 0231). */
const ENLACE_DE_FABRICA: Record<string, string> = {
  proveedor: 'proveedor',
  transito: 'organismos_transito',
  gestor_impuestos: 'organismos_transito',
  cliente: 'compania',
};

/**
 * HU #12875 — Roles de fábrica cuyo enlace se NEUTRALIZA (`ninguno`) en este fichero de pruebas.
 *
 * La frontera por enlace cierra a `gestor_impuestos`/`transito` (organismos) y a `proveedor` todo
 * módulo que no sea SOAT hasta la #13426 (decisión (b) del PO). Las pruebas que miden la REGLA de un
 * módulo legacy o de Impuestos/Derechos/Trámites con esos roles (por función, organismo o asignación)
 * la declaran aquí, a la vista, y siguen midiendo el módulo; el cierre en sí lo prueban
 * `frontera-por-enlace.test.ts` y `frontera-enlace.centinela.test.ts`. Vitest aísla los módulos por
 * fichero, así que la lista vale solo para el fichero que la llama.
 */
const ENLACE_NEUTRO = new Set<string>();
export function neutralizarEnlaceDe(...roles: string[]): void {
  for (const r of roles) ENLACE_NEUTRO.add(r);
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

  // HU #12087: `opts.allowedPages` sigue significando «páginas propias de este usuario», pero desde
  // esta HU viajan como excepciones `conceder pagina.<slug>` de `permisos_usuario_funcion`, que es la
  // única fuente que el resolutor lee. La firma de `testToken` no cambia: los ficheros que la usan
  // no se tocan.
  const paginasPropias = opts.allowedPages ?? (role === 'admin' ? PAGINAS_DE_ADMIN : []);
  await registrarUsuarioDePrueba(sub, {
    rol: role,
    // Bug #12869: el enlace de fábrica (siembra de la 0178). En SOAT decide el alcance de filas.
    tipoEnlace: opts.tipoEnlace ?? (ENLACE_NEUTRO.has(role) ? 'ninguno' : ENLACE_DE_FABRICA[role]) ?? 'ninguno',
    // HU #13429: la partida entera del rol (con su cadena) y, para lo que el test añade, `conCadena`.
    // La partida ya viene encadenada (es el catálogo de después de la 0239); a las páginas por defecto solo se les
    // añade su elemento (una página absorbida por una acción, p. ej. la compuerta, NO trae la acción: sería ganancia).
    funcionesDelRol: [...new Set([
      ...funcionesDePartida(role),
      ...paginasPorDefecto(role as RoleCode).flatMap((s) => [`pagina.${s}`, ...ancestrosDe(`pagina.${s}`)]),
      ...conCadena(opts.funciones ?? []),
    ])],
    excepciones: conCadena(paginasPropias.map((slug) => `pagina.${slug}`)).map((codigo) => ({ codigo, efecto: 'conceder' as const })),
  });

  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(sub))
    .setExpirationTime('1h')
    .sign(secret);
}

export const adminAuth = async (): Promise<string> => `Bearer ${await testToken({ role: 'admin' })}`;
export const proveedorAuth = async (): Promise<string> => `Bearer ${await testToken({ role: 'proveedor' })}`;
