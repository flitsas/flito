// HU #13421 (ADR-0023 §D4) — Reporte EN SECO del cambio de guardas de una HU de la Épica #13411:
// para cada ruta del alcance, quién pasa hoy y quién pasaría con las filas que la migración propone.
//
//   npm run permisos:en-seco -w apps/api -- --hu 13421 > /tmp/reparto-13421.md
//   npm run permisos:en-seco -w apps/api -- --hu 13422 > /tmp/reparto-13422.md   (HU #13422)
//   npm run permisos:en-seco -w apps/api -- --hu 13423 > /tmp/reparto-13423.md   (HU #13423)
//   npm run permisos:en-seco -w apps/api -- --hu 12875 > /tmp/frontera-12875.md   (HU #12875, AC9:
//     frontera por enlace; núcleo `modules/permisos/frontera-en-seco.ts`, sin ids de usuario)
//
// Solo LEE: una transacción `READ ONLY` con tres SELECT (usuarios activos, reparto por rol y
// excepciones por usuario). Lo propuesto se simula en memoria con el núcleo puro
// `modules/permisos/reparto-en-seco.ts`. Sin PII: el detalle es `user_id` + rol. La salida NO se
// commitea (lleva ids de usuario y el repo es público): va como adjunto a la Discussion de la HU.
//
// Se corre desde el árbol de la HU (necesita los `.routes.ts` para leer las guardas de «después»).
// «Antes» no sale del fuente —ya cambió— sino de la foto `inventario.generado.ts` (la lista literal de
// cada `requireRole`) y de la regla de montaje medida en develop 29d3461e:
//   · toda ruta de pesv/, drivers/ y jornadas/ exigía `pagina.pesv` (`router.use(…requirePage('pesv'))`);
//   · las de raci/normativa/retención exigían su página propia Y `pagina.pesv`, porque en /api/pesv se
//     montan antes `tablero` y `huerfanos` con esa guarda a nivel de router y Express la ejecuta para
//     toda petición que pasa por ellos;
//   · `rum` GET /summary solo exigía rol.
//
// Salida del proceso: 0 si el reporte se generó (haya o no diferencias: es información), 1 si falló,
// 2 si la HU no está soportada.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { PAGINAS_MANTENIMIENTO_POR_ITEM, PAGINAS_PESV_POR_ITEM } from '@operaciones/shared-types';
import { db } from '../db/client.js';
import { RAIZ_MODULOS, llaveDe, sinComentarios } from '../modules/permisos/inventario-guardas.js';
import { GUARDAS_MEDIDAS } from '../modules/permisos/inventario.generado.js';
import { catalogoCompleto } from '../modules/permisos/catalogo.js';
import {
  informeMarkdown, repartoEnSeco,
  type FilaRolEnSeco, type FilaUsuarioEnSeco, type RutaEnSeco, type UsuarioEnSeco,
} from '../modules/permisos/reparto-en-seco.js';
import { fronteraEnSeco, informeFronteraMarkdown, montajesDeAppTs, type RolFronteraEnSeco } from '../modules/permisos/frontera-en-seco.js';

const HU_SOPORTADAS = ['13421', '13422', '13423', '12875'];
const DIRECTORIOS = ['pesv', 'drivers', 'jornadas', 'rum'];
const CON_PAGINA_PROPIA = new Map([
  ['pesv/raci.routes.ts', 'pagina.pesv_raci'],
  ['pesv/normativa.routes.ts', 'pagina.pesv_normativa'],
  ['pesv/retencion.routes.ts', 'pagina.pesv_retencion'],
]);
const RUTA = /router\.(get|post|put|patch|delete)\(\s*'([^']*)'\s*,([\s\S]{0,500}?)(?:async\s*\(|\(\s*_?req\b|\(\s*\)\s*=>|\);)/g;

/** Las rutas del alcance de la #13421 con su requisito de antes y de después. */
function rutasHu13421(raiz = RAIZ_MODULOS): { rutas: RutaEnSeco[]; abiertas: { llave: string; motivo: string }[] } {
  const rolesAntes = new Map(GUARDAS_MEDIDAS.map((g) => [llaveDe(g), g.roles]));
  const rutas: RutaEnSeco[] = [];
  const abiertas: { llave: string; motivo: string }[] = [];
  for (const d of DIRECTORIOS) {
    for (const nombre of readdirSync(join(raiz, d)).filter((n) => n.endsWith('.routes.ts')).sort()) {
      const fichero = `${d}/${nombre}`;
      const fuente = sinComentarios(readFileSync(join(raiz, fichero), 'utf8'));
      for (const m of fuente.matchAll(RUTA)) {
        const llave = `${fichero} ${m[1]!.toUpperCase()} ${m[2]}`;
        const pagina = /requirePage\('([a-z_]+)'\)/.exec(m[3]!)?.[1];
        const funcion = /exigirFuncion\('([a-z0-9_.]+)'\)/.exec(m[3]!)?.[1];
        const despues = [pagina && `pagina.${pagina}`, funcion].filter((c): c is string => !!c);
        if (despues.length === 0) { abiertas.push({ llave, motivo: 'sin guarda de función antes ni después' }); continue; }
        const antes = d === 'rum' ? [] : ['pagina.pesv', ...(CON_PAGINA_PROPIA.has(fichero) ? [CON_PAGINA_PROPIA.get(fichero)!] : [])];
        rutas.push({ llave, antes: { codigos: antes, roles: rolesAntes.get(llave) }, despues: { codigos: despues } });
      }
    }
  }
  // `estandaresRouter` (GET /api/pesv/estandares…) no lo ve la regex de rutas: guarda de router propia.
  rutas.push({
    llave: 'pesv/diagnostico.routes.ts estandaresRouter *',
    antes: { codigos: ['pagina.pesv'] }, despues: { codigos: ['pagina.pesv_diagnostico'] },
  });
  return { rutas, abiertas };
}

/** Lo que la 0227 propone: copia viva de `pagina.pesv` a las 21 páginas, reparto literal del catálogo y el recorte del Paso 3b. */
function propuestaHu13421() {
  const destinos = PAGINAS_PESV_POR_ITEM.map((s) => `pagina.${s}`);
  const ops = catalogoCompleto().filter((f) => f.tipo === 'operacion' && /^(pesv|drivers|jornadas|rum)\./.test(f.codigo));
  const literales: FilaRolEnSeco[] = [
    ...destinos.map((codigo) => ({ rol: 'admin', codigo })),
    ...ops.flatMap((f) => f.roles.map((rol) => ({ rol, codigo: f.codigo }))),
  ];
  // 0227 Paso 3b: raci, normativa y retención pedían también `pagina.pesv`; su reparto se recorta a esa intersección.
  const recortes = [{ paginas: ['pagina.pesv_raci', 'pagina.pesv_normativa', 'pagina.pesv_retencion'], requisito: 'pagina.pesv' }];
  return { copias: [{ origen: 'pagina.pesv', destinos }], literales, recortes };
}

// ── HU #13422 — maintenance/, vehicles/, fleet/, rndc/, rutas/, liquidacion/, finanzas/ y clients/ ──
// «Antes» medido en develop 8f0d8b85:
//   · maintenance/: toda ruta exigía `pagina.maintenance` (`router.use(…requirePage('maintenance'))` en
//     cada router, y el de /api/maintenance se ejecutaba para toda petición bajo ese prefijo);
//   · rutas/: toda ruta exigía `pagina.pesv` (misma forma, montada en /api/rutas);
//   · fleet/ y rndc/ conservan su página a nivel de router, antes y después (`pagina.fleet`,
//     `pagina.rndc`; `pagina.rndc_admin` en credenciales);
//   · vehicles/, liquidacion/, finanzas/ y clients/: solo el rol (o solo sesión).
// La guarda en línea del documento del propietario y el aviso del envío RNDC fallido van como
// requisitos sueltos: no son rutas, pero también decidían por el nombre `admin`.
const DIRECTORIOS_13422 = ['maintenance', 'vehicles', 'fleet', 'rndc', 'rutas', 'liquidacion', 'finanzas', 'clients'];
const PAGINA_DE_ROUTER_13422: Record<string, string> = { fleet: 'pagina.fleet', rndc: 'pagina.rndc' };
const PAGINA_ANTES_13422: Record<string, string> = { maintenance: 'pagina.maintenance', rutas: 'pagina.pesv', ...PAGINA_DE_ROUTER_13422 };

/** La página de router que se conserva (antes y después) para un fichero de fleet/ o rndc/. */
function paginaDeRouter13422(fichero: string, d: string): string | undefined {
  if (fichero === 'rndc/qr.routes.ts') return undefined; // pública, sin auth
  if (fichero === 'rndc/credenciales.routes.ts') return 'pagina.rndc_admin';
  return PAGINA_DE_ROUTER_13422[d];
}

function rutasHu13422(raiz = RAIZ_MODULOS): { rutas: RutaEnSeco[]; abiertas: { llave: string; motivo: string }[] } {
  const rolesAntes = new Map(GUARDAS_MEDIDAS.map((g) => [llaveDe(g), g.roles]));
  const rutas: RutaEnSeco[] = [];
  const abiertas: { llave: string; motivo: string }[] = [];
  for (const d of DIRECTORIOS_13422) {
    for (const nombre of readdirSync(join(raiz, d)).filter((n) => n.endsWith('.routes.ts')).sort()) {
      const fichero = `${d}/${nombre}`;
      const fuente = sinComentarios(readFileSync(join(raiz, fichero), 'utf8'));
      const deRouter = paginaDeRouter13422(fichero, d);
      const paginaAntes = fichero === 'rndc/qr.routes.ts' ? undefined
        : fichero === 'rndc/credenciales.routes.ts' ? 'pagina.rndc_admin' : PAGINA_ANTES_13422[d];
      for (const m of fuente.matchAll(RUTA)) {
        const llave = `${fichero} ${m[1]!.toUpperCase()} ${m[2]}`;
        const pagina = /requirePage\('([a-z_]+)'\)/.exec(m[3]!)?.[1];
        const funcion = /exigirFuncion\('([a-z0-9_.]+)'\)/.exec(m[3]!)?.[1];
        const despues = [deRouter, pagina && `pagina.${pagina}`, funcion].filter((c): c is string => !!c);
        const roles = rolesAntes.get(llave);
        const antes = [paginaAntes, pagina && d !== 'maintenance' && d !== 'rutas' ? `pagina.${pagina}` : undefined]
          .filter((c): c is string => !!c);
        if (despues.length === 0 && !roles && antes.length === 0) {
          abiertas.push({ llave, motivo: fichero === 'vehicles/vehicles.routes.ts' ? 'solo sesión (su guarda es de la HU #13423)' : 'sin guarda de función antes ni después' });
          continue;
        }
        rutas.push({ llave, antes: { codigos: [...new Set(antes)], roles }, despues: { codigos: [...new Set(despues)] } });
      }
    }
  }
  rutas.push({
    llave: 'vehicles/vehicles.routes.ts GET / [documentoCompleto]',
    antes: { codigos: [], roles: ['admin'] }, despues: { codigos: ['vehicles.propietario.ver_documento'] },
  });
  rutas.push({
    llave: 'rndc/envio.service.ts aviso de envío fallido (destinatarios)',
    antes: { codigos: [], roles: ['admin'] }, despues: { codigos: ['rndc.manifiestos.administrar'] },
  });
  return { rutas, abiertas };
}

/** Lo que la 0229 propone: copia viva de `pagina.maintenance` a sus 3 páginas y el reparto literal del catálogo. */
function propuestaHu13422() {
  const destinos = PAGINAS_MANTENIMIENTO_POR_ITEM.map((s) => `pagina.${s}`);
  const prefijos = /^(maintenance|vehicles|fleet|rndc|rutas|liquidacion\.pago_manual|finanzas\.reporte_costos|clients)\./;
  const ops = catalogoCompleto().filter((f) => f.tipo === 'operacion' && prefijos.test(f.codigo));
  const literales: FilaRolEnSeco[] = [
    ...destinos.map((codigo) => ({ rol: 'admin', codigo })),
    ...ops.flatMap((f) => f.roles.map((rol) => ({ rol, codigo: f.codigo }))),
  ];
  return { copias: [{ origen: 'pagina.maintenance', destinos }], literales };
}

// ── HU #13423 — laft/, privacy/, firma/, drive/, soat/ (antiguo), siigo/ y las 4 de solo sesión ──────
// «Antes» medido en la base de la HU (a2b2cd47, HU #13422):
//   · las rutas de los seis directorios exigían la lista literal de su `requireRole` (la foto
//     `inventario.generado.ts`); las que además llevan `requirePage` a nivel de router (laft: plan de
//     auditorías, manual, oficial, tablero) la conservan antes y después;
//   · las acciones de Siigo (`exigirAccionSiigo`) decidían con la fila de su acción en la vieja tabla de
//     roles por acción (misma foto: guardas en línea de `siigo/siigo.permisos.ts`);
//   · las cuatro operaciones de solo sesión (`vehicles.vehiculos.consultar`, `runt.persona.consultar`,
//     `runt.cedula.leer`, `integraciones.fasecolda.buscar`) las alcanzaba todo usuario activo.
const FICHEROS_13423 = GUARDAS_MEDIDAS.filter((g) => /^(laft|privacy|firma|drive|soat|siigo|runt|integraciones)\//.test(g.fichero)
  || (g.fichero === 'vehicles/vehicles.routes.ts' && !g.condicion));
const SESION_13423: Record<string, string[]> = {
  'vehicles.vehiculos.consultar': ['pagina.vehicles', 'pagina.soat', 'pagina.fleet', 'pagina.tramite'],
  'runt.persona.consultar': ['pagina.tramite'],
  'runt.cedula.leer': ['pagina.tramite'],
  'integraciones.fasecolda.buscar': ['pagina.tramite'],
};

function rutasHu13423(raiz = RAIZ_MODULOS): { rutas: RutaEnSeco[]; abiertas: { llave: string; motivo: string }[]; sesion: Map<string, string[]> } {
  const codigoDeLlave = new Map<string, string>();
  const paginaDeRouter = new Map<string, string | undefined>();
  const sesion = new Map<string, string[]>();
  for (const fichero of new Set(FICHEROS_13423.map((g) => g.fichero))) {
    const fuente = sinComentarios(readFileSync(join(raiz, fichero), 'utf8'));
    const p = /router\.use\([^)]*requirePage\('([a-z_]+)'\)/.exec(fuente)?.[1];
    paginaDeRouter.set(fichero, p ? `pagina.${p}` : undefined);
    for (const m of fuente.matchAll(RUTA)) {
      const funcion = /exigirFuncion\('([a-z0-9_.]+)'\)/.exec(m[3]!)?.[1];
      if (funcion) codigoDeLlave.set(`${fichero} ${m[1]!.toUpperCase()} ${m[2]}`, funcion);
    }
    for (const m of fuente.matchAll(/case '([a-z_]+)': return tieneFuncion\(req, '([a-z0-9_.]+)'\)/g)) {
      codigoDeLlave.set(`${fichero} ${m[1] === 'consultar' ? 'GET' : 'POST'} * [${m[1]}]`, m[2]!);
    }
  }
  const rutas: RutaEnSeco[] = [];
  const abiertas: { llave: string; motivo: string }[] = [];
  for (const g of FICHEROS_13423) {
    const llave = llaveDe(g);
    const codigo = codigoDeLlave.get(llave);
    if (!codigo) { abiertas.push({ llave, motivo: 'en la foto pero sin guarda en el fuente' }); continue; }
    const pagina = paginaDeRouter.get(g.fichero);
    const deSesion = codigo in SESION_13423;
    if (deSesion) sesion.set(codigo, [...(sesion.get(codigo) ?? []), llave]);
    rutas.push({
      llave,
      antes: deSesion ? { codigos: [] } : { codigos: pagina ? [pagina] : [], roles: g.roles },
      despues: { codigos: [...(pagina ? [pagina] : []), codigo] },
    });
  }
  return { rutas, abiertas, sesion };
}

/** Lo que la 0230 propone: reparto literal del catálogo (admin en todo) y copia viva de las páginas para las 4 de sesión. */
function propuestaHu13423() {
  const prefijos = /^(laft|privacy|firma|drive|siigo|runt|integraciones)\.|^soat\.antiguo\.|^vehicles\.vehiculos\.consultar$/;
  const ops = catalogoCompleto().filter((f) => f.tipo === 'operacion' && prefijos.test(f.codigo));
  const literales: FilaRolEnSeco[] = ops.flatMap((f) => (f.codigo in SESION_13423 ? ['admin'] : f.roles).map((rol) => ({ rol, codigo: f.codigo })));
  const porOrigen = new Map<string, string[]>();
  for (const [codigo, paginas] of Object.entries(SESION_13423)) for (const p of paginas) porOrigen.set(p, [...(porOrigen.get(p) ?? []), codigo]);
  return { copias: [...porOrigen].map(([origen, destinos]) => ({ origen, destinos })), literales };
}

/** AC7: por cada operación de solo sesión, qué roles la usan hoy (sus páginas) y cuántos usuarios dejan de alcanzarla. */
function informeSesion13423(
  sesion: Map<string, string[]>, informe: ReturnType<typeof repartoEnSeco>, filasRol: FilaRolEnSeco[], usuarios: UsuarioEnSeco[],
): string {
  const l = ['## 6. Las 4 operaciones que hoy solo exigen sesión (AC7)', '',
    '| Operación | Páginas que la llaman | Roles con esas páginas (hoy) | Usuarios que hoy la alcanzan | Después | Dejan de alcanzarla (por rol) |', '|---|---|---|---|---|---|'];
  for (const [codigo, paginas] of Object.entries(SESION_13423)) {
    const roles = [...new Set(filasRol.filter((f) => paginas.includes(f.codigo)).map((f) => f.rol))].sort();
    const llaves = sesion.get(codigo) ?? [];
    const pierden = new Map<number, string>();
    for (const d of informe.detalle) if (llaves.includes(d.llave) && d.cambio === 'pierde') pierden.set(d.userId, d.rol);
    const porRol: Record<string, number> = {};
    for (const r of pierden.values()) porRol[r] = (porRol[r] ?? 0) + 1;
    const despues = Math.min(...informe.rutas.filter((r) => llaves.includes(r.llave)).map((r) => r.despues));
    l.push(`| \`${codigo}\` | ${paginas.join(', ')} | ${roles.join(', ') || '—'} | ${usuarios.length} | ${despues} | ${Object.entries(porRol).sort().map(([r, n]) => `${r} (${n})`).join(', ') || '—'} (total ${pierden.size}) |`);
  }
  return l.join('\n');
}

/**
 * HU #12875 (AC9): por rol, el enlace, el tipo de antes, usuarios activos y cuántos no tienen el id que
 * su enlace exige. Solo conteos y códigos de rol. Lee la columna del tipo retirado a propósito: es la
 * foto del «antes» (diseño §10). READ ONLY.
 */
async function informeHu12875(): Promise<string> {
  const filas = await db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    return tx.execute(sql`
      SELECT r.codigo, r.tipo_principal AS tipo_antes, r.tipo_enlace, r.activo,
             count(u.id) FILTER (WHERE u.active AND u.deleted_at IS NULL)::int AS usuarios,
             count(u.id) FILTER (WHERE u.active AND u.deleted_at IS NULL AND (
               (r.tipo_enlace = 'compania' AND u.compania_id IS NULL)
               OR (r.tipo_enlace IN ('proveedor', 'proveedor_soat') AND u.flito_proveedor_soat_id IS NULL)
               OR (r.tipo_enlace = 'organismos_transito' AND u.transito_codigo IS NULL
                   AND NOT EXISTS (SELECT 1 FROM flito_gestor_organismos g WHERE g.user_id = u.id))
             ))::int AS sin_id
        FROM permisos_roles r LEFT JOIN users u ON u.role = r.codigo
       GROUP BY r.codigo, r.tipo_principal, r.tipo_enlace, r.activo`);
  });
  const roles: RolFronteraEnSeco[] = [...filas].map((r) => ({
    codigo: String(r.codigo), tipoAntes: r.tipo_antes == null ? null : String(r.tipo_antes),
    tipoEnlace: String(r.tipo_enlace), activo: r.activo === true,
    usuarios: Number(r.usuarios), sinIdDeEnlace: Number(r.sin_id),
  }));
  const montajes = montajesDeAppTs(readFileSync(join(RAIZ_MODULOS, '..', 'app.ts'), 'utf8'));
  return informeFronteraMarkdown(fronteraEnSeco(roles, montajes), `HU #12875 (${roles.length} roles)`);
}

async function main(): Promise<number> {
  const i = process.argv.indexOf('--hu');
  const hu = i >= 0 ? process.argv[i + 1] : undefined;
  if (!hu || !HU_SOPORTADAS.includes(hu)) {
    console.error(`Uso: npm run permisos:en-seco -w apps/api -- --hu <${HU_SOPORTADAS.join('|')}>`);
    return 2;
  }
  if (hu === '12875') { console.log(await informeHu12875()); return 0; }
  const filas = await db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const usuarios = await tx.execute(sql`SELECT id, role FROM users WHERE active = true AND deleted_at IS NULL`);
    const rol = await tx.execute(sql`SELECT rol_codigo, funcion_codigo FROM permisos_rol_funcion`);
    const usr = await tx.execute(sql`SELECT user_id, funcion_codigo, efecto FROM permisos_usuario_funcion`);
    return { usuarios, rol, usr };
  });
  const usuarios: UsuarioEnSeco[] = [...filas.usuarios].map((r) => ({ id: Number(r.id), rol: String(r.role) }));
  const filasRol: FilaRolEnSeco[] = [...filas.rol].map((r) => ({ rol: String(r.rol_codigo), codigo: String(r.funcion_codigo) }));
  const filasUsuario: FilaUsuarioEnSeco[] = [...filas.usr].map((r) => ({
    userId: Number(r.user_id), codigo: String(r.funcion_codigo), efecto: r.efecto === 'revocar' ? 'revocar' : 'conceder',
  }));
  const r13423 = hu === '13423' ? rutasHu13423() : undefined;
  const { rutas, abiertas } = r13423 ?? (hu === '13422' ? rutasHu13422() : rutasHu13421());
  const propuesta = hu === '13423' ? propuestaHu13423() : hu === '13422' ? propuestaHu13422() : propuestaHu13421();
  const informe = repartoEnSeco({ usuarios, filasRol, filasUsuario, propuesta, rutas, abiertas });
  console.log(informeMarkdown(informe, `HU #${hu} (${usuarios.length} usuarios activos, ${rutas.length} rutas)`));
  if (r13423) console.log(informeSesion13423(r13423.sesion, informe, filasRol, usuarios));
  return 0;
}

main().then((c) => process.exit(c)).catch((e: unknown) => {
  console.error('permisos-reparto-en-seco falló:', e instanceof Error ? e.message : e);
  process.exit(1);
});
