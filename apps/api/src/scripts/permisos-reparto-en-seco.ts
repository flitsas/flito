// HU #13421 (ADR-0023 §D4) — Reporte EN SECO del cambio de guardas de una HU de la Épica #13411:
// para cada ruta del alcance, quién pasa hoy y quién pasaría con las filas que la migración propone.
//
//   npm run permisos:en-seco -w apps/api -- --hu 13421 > /tmp/reparto-13421.md
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
import { PAGINAS_PESV_POR_ITEM } from '@operaciones/shared-types';
import { db } from '../db/client.js';
import { RAIZ_MODULOS, llaveDe, sinComentarios } from '../modules/permisos/inventario-guardas.js';
import { GUARDAS_MEDIDAS } from '../modules/permisos/inventario.generado.js';
import { catalogoCompleto } from '../modules/permisos/catalogo.js';
import {
  informeMarkdown, repartoEnSeco,
  type FilaRolEnSeco, type FilaUsuarioEnSeco, type RutaEnSeco, type UsuarioEnSeco,
} from '../modules/permisos/reparto-en-seco.js';

const HU_SOPORTADAS = ['13421'];
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

/** Lo que la 0226 propone: copia viva de `pagina.pesv` a las 21 páginas, reparto literal del catálogo y el recorte del Paso 3b. */
function propuestaHu13421() {
  const destinos = PAGINAS_PESV_POR_ITEM.map((s) => `pagina.${s}`);
  const ops = catalogoCompleto().filter((f) => f.tipo === 'operacion' && /^(pesv|drivers|jornadas|rum)\./.test(f.codigo));
  const literales: FilaRolEnSeco[] = [
    ...destinos.map((codigo) => ({ rol: 'admin', codigo })),
    ...ops.flatMap((f) => f.roles.map((rol) => ({ rol, codigo: f.codigo }))),
  ];
  // 0226 Paso 3b: raci, normativa y retención pedían también `pagina.pesv`; su reparto se recorta a esa intersección.
  const recortes = [{ paginas: ['pagina.pesv_raci', 'pagina.pesv_normativa', 'pagina.pesv_retencion'], requisito: 'pagina.pesv' }];
  return { copias: [{ origen: 'pagina.pesv', destinos }], literales, recortes };
}

async function main(): Promise<number> {
  const i = process.argv.indexOf('--hu');
  const hu = i >= 0 ? process.argv[i + 1] : undefined;
  if (!hu || !HU_SOPORTADAS.includes(hu)) {
    console.error(`Uso: npm run permisos:en-seco -w apps/api -- --hu <${HU_SOPORTADAS.join('|')}>`);
    return 2;
  }
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
  const { rutas, abiertas } = rutasHu13421();
  const informe = repartoEnSeco({ usuarios, filasRol, filasUsuario, propuesta: propuestaHu13421(), rutas, abiertas });
  console.log(informeMarkdown(informe, `HU #${hu} (${usuarios.length} usuarios activos, ${rutas.length} rutas)`));
  return 0;
}

main().then((c) => process.exit(c)).catch((e: unknown) => {
  console.error('permisos-reparto-en-seco falló:', e instanceof Error ? e.message : e);
  process.exit(1);
});
