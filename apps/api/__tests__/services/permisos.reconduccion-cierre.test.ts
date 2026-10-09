// HU #12083 — El CIERRE de la reconducción (AC1, AC2, AC3): en los 21 directorios de FLITO, trámites,
// usuarios y permisos (HU #12084) ya no decide ningún `requireRole`; decide el motor, ruta a ruta, con `exigirFuncion`.
//
//   · AC1/AC2: cero `requireRole(` en los 21 directorios (fuera de comentarios con `sinComentarios`, y
//     también dentro: el AC dice «ninguna aparición»); cero `import … requireRole`.
//   · Los 24 ficheros de rutas importan `exigirFuncion`; conservan `router.use(authMiddleware)` o, en
//     `identidad.routes.ts`, `authMiddleware` en cada ruta que lo llevaba (lista explícita de 7).
//   · Cada `router.<método>(` de los 24 ficheros lleva `exigirFuncion('…')` O está en la lista blanca
//     de 5 rutas sin guarda de función. Es la red que sustituye a los `router.use(requireRole)`
//     retirados: una ruta nueva sin guarda no «nace protegida» por herencia, nace aquí en rojo.
//   · `leerMontajes` cubre la foto entera (238 = 217 de la #12081 + 11 de esta HU, dos en línea, + 2 − 1 de
//     la #12373, + 2 del historial de la #12171, + 7 de los roles de la #12084).
//   · AC3: las comparaciones de ÁMBITO siguen existiendo (15 medidas el 10/09/2026; el diseño contó
//     14 porque agrupó los dos `esGestor`/`esCliente` de soat), enumeradas por fichero (regex por
//     contenido, no por número de línea): cambian QUÉ filas ve alguien, no QUIÉN puede ejecutar. Las 27
//     de `users.routes.ts` son el `superRefine` del usuario editado (HU #12088), tampoco guardas.
//
// Mutación del AC8: devolver `requireRole('admin')` a una ruta reconducida → rojo en el primer aserto
// (aparece `requireRole(`) y en el de «cada ruta lleva exigirFuncion»; y en la paridad («fila sin
// montaje»).

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FICHEROS_EN_ALCANCE, FICHEROS_LEGADO_EN_ALCANCE, RAIZ_MODULOS, leerMontajes, llaveDe, montajesDeFunciones, sinComentarios,
} from '../../src/modules/permisos/inventario-guardas.js';
import { GUARDAS_MEDIDAS } from '../../src/modules/permisos/inventario.generado.js';
import { OPERACIONES_DECLARADAS } from '../../src/modules/permisos/catalogo-operaciones.js';
import { PAGINAS_MANTENIMIENTO_POR_ITEM, PAGINAS_PESV_POR_ITEM } from '@operaciones/shared-types';

/** Los 26 directorios: los 19 del enunciado (cadena SOAT + resto de FLITO, trámites incluidos, y usuarios) + permisos (HU #12084) + finanzas-servicios-adicionales (HU #12545, nace reconducido) + flito-comprobantes (HU #12611, nace reconducido) + los legacy pesv, drivers, jornadas y rum (HU #13421, ADR-0023) + los ocho de operación (HU #13422) + los seis sensibles y runt/integraciones (HU #13423). */
export const DIRECTORIOS_RECONDUCIDOS = [
  'flito-soat', 'flito-parametrizacion', 'flito-compuerta', 'flito-bolsas', 'flito-revisiones', 'flito-sync',
  'flito-excepciones', 'flito-ocr',
  'tramites', 'flito-tramites', 'flito-impuestos', 'flito-comparendos', 'flito-conciliacion',
  'flito-liquidacion', 'flito-logistica', 'flito-tablero', 'flito-bitacora', 'flito-derechos', 'users',
  'permisos', 'finanzas-servicios-adicionales', 'flito-comprobantes',
  'pesv', 'drivers', 'jornadas', 'rum',
  'maintenance', 'vehicles', 'fleet', 'rndc', 'rutas', 'liquidacion', 'finanzas', 'clients',
  // HU #13423 (cierre de la valla): los seis sensibles y los dos de las operaciones de solo sesión.
  'laft', 'privacy', 'firma', 'drive', 'soat', 'siigo', 'runt', 'integraciones',
] as const;

/** Rutas de los 24 ficheros que NO llevan guarda de función y siguen igual (§4 del diseño; `/mios`: HU #12084). */
const LISTA_BLANCA = new Set([
  'tramites/identidad.routes.ts GET /info/:token',        // pública con limitador
  'tramites/identidad.routes.ts POST /completar/:token',  // pública con limitador
  'tramites/identidad.routes.ts POST /recortar-cedula',   // solo authMiddleware
  'users/users.routes.ts PATCH /:id/password',            // authMiddleware; la AJENA es guarda en línea
  'permisos/permisos.routes.ts GET /mios',                // authMiddleware: cada uno ve SU conjunto
]);

/** En identidad no hay `router.use(authMiddleware)`: lo llevan estas 7 rutas, una a una. */
const AUTH_EN_RUTA_IDENTIDAD = [
  'GET /sse', 'POST /iniciar', 'POST /iniciar-partes', 'GET /estado/:tramiteId',
  'GET /documentos/:tramiteId', 'POST /certificado/:tramiteId', 'POST /recortar-cedula',
];

/** AC3 — las 3 comparaciones de ámbito que se quedan, y por qué (15 hasta la HU #12815; 13 hasta el Bug #12869; 11 hasta la HU #13425; 8 hasta la HU #13426). */
const AMBITO: { fichero: string; patron: RegExp; veces: number; porque: string }[] = [
  // HU #12815: la frontera por compañía del EXTERNO ya no es una comparación de rol — la decide
  // `tipo_principal` vía `resolverPermisos` (`SoatCtx.externo`), así que el patrón sigue buscando
  // `'cliente'` para que su reaparición ponga esto rojo. Quedaban las 2 del gestor.
  // Bug #12869: tampoco las del gestor. El alcance de filas de SOAT lo decide el ENLACE del rol
  // (`permisos_roles.tipo_enlace` → `SoatCtx.alcance`), no su código: cero comparaciones, y el
  // patrón se conserva para que la reaparición de `role === 'proveedor'|'cliente'` ponga esto rojo.
  { fichero: 'flito-soat/flito-soat.service.ts', patron: /role === '(proveedor|cliente)'/g, veces: 0, porque: 'Bug #12869: el alcance lo decide el enlace del rol (tipo_enlace), no el literal' },
  // HU #13426 (AC9): Impuestos y la bandeja de Tránsito deciden por el ENLACE (`alcanceDe`), no por el
  // literal del rol. Cero, y los patrones se conservan para que su reaparición ponga esto rojo.
  { fichero: 'flito-impuestos/flito-impuestos.routes.ts', patron: /role === 'gestor_impuestos'/g, veces: 0, porque: 'HU #13426: contextoImpuesto lee el alcance del enlace' },
  { fichero: 'flito-impuestos/flito-impuestos.service.ts', patron: /role === 'gestor_impuestos'/g, veces: 0, porque: 'HU #13426: la frontera por organismo la decide el enlace' },
  { fichero: 'flito-impuestos/flito-recibos.service.ts', patron: /role === 'gestor_impuestos'/g, veces: 0, porque: 'HU #13426: el lote de recibos lo acota el enlace' },
  { fichero: 'tramites/transito-scope.ts', patron: /role (===|!==) '(admin|transito)'/g, veces: 0, porque: 'HU #13426: resolveTransitoScope sale de alcanceDe (todas sus secretarías)' },
  { fichero: 'tramites/transito-config.routes.ts', patron: /role === 'transito'/g, veces: 3, porque: 'organismo del transito al leer config, checklist y logo' },
  // HU #13425: no era ámbito de filas sino una REGLA de propiedad; la decide la función
  // `logistica.actas.operar_ajenas`. Cero, y el patrón se conserva para que su reaparición ponga esto rojo.
  { fichero: 'flito-logistica/flito-logistica.service.ts', patron: /role === 'mensajero'/g, veces: 0, porque: 'HU #13425: la propiedad del acta la decide logistica.actas.operar_ajenas' },
];

function ficherosTs(dir: string): string[] {
  const salida: string[] = [];
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) salida.push(...ficherosTs(ruta));
    else if (ruta.endsWith('.ts')) salida.push(ruta);
  }
  return salida;
}

const leer = (rel: string) => readFileSync(join(RAIZ_MODULOS, rel), 'utf8');
const FICHEROS_DE_RUTAS = FICHEROS_EN_ALCANCE.map((f) => f.fichero);

describe('AC1/AC2 — en los 21 directorios ya no decide ningún requireRole', () => {
  for (const dir of DIRECTORIOS_RECONDUCIDOS) {
    it(`${dir}/: cero requireRole( (fuera y dentro de comentarios) y cero import de requireRole`, () => {
      const conAparicion: string[] = [];
      for (const f of ficherosTs(join(RAIZ_MODULOS, dir))) {
        const fuente = readFileSync(f, 'utf8');
        if (/requireRole\(/.test(sinComentarios(fuente)) || /requireRole\(/.test(fuente)) conAparicion.push(f.replace(RAIZ_MODULOS, ''));
        if (/import[^;]*\brequireRole\b/.test(fuente)) conAparicion.push(`${f.replace(RAIZ_MODULOS, '')} (import)`);
      }
      expect(conAparicion).toEqual([]);
    });
  }

  it('los directorios son 42 (19 del enunciado + permisos + finanzas-servicios-adicionales + flito-comprobantes + pesv, drivers, jornadas y rum de la HU #13421 + los ocho de operación de la HU #13422 + los ocho de la HU #13423) y los 32 ficheros de rutas del alcance viven en ellos (flito-logistica aporta dos: el legado y el de viajes, HU #12619; flito-impuestos otros tres: el de la cola, el de la dirección, HU #12833, y el del reemplazo del comprobante, HU #13269; flito-soat cuatro: módulo, canal Cliente, incompletas, HU #12997, y documentos adicionales, HU #13362; flito-sync tres: el de sync, el del acceso a FLIT 2, HU #13061, y el del interruptor por fuente, HU #13237)', () => {
    expect(DIRECTORIOS_RECONDUCIDOS).toHaveLength(42);
    expect(FICHEROS_DE_RUTAS).toHaveLength(32);
    for (const f of FICHEROS_DE_RUTAS) {
      expect((DIRECTORIOS_RECONDUCIDOS as readonly string[]).includes(f.split('/')[0]!), f).toBe(true);
    }
  });
});

describe('AC1/AC2 — cada fichero de rutas importa exigirFuncion y ninguna ruta pierde authMiddleware', () => {
  for (const fichero of FICHEROS_DE_RUTAS) {
    it(`${fichero}`, () => {
      const fuente = sinComentarios(leer(fichero));
      expect(fuente).toMatch(/import \{[^}]*\bexigirFuncion\b[^}]*\} from '\.\.\/\.\.\/shared\/middleware\/exigir-funcion\.js';/);
      if (fichero === 'tramites/identidad.routes.ts') {
        for (const r of AUTH_EN_RUTA_IDENTIDAD) {
          const [metodo, ruta] = r.split(' ');
          const re = new RegExp(`router\\.${metodo!.toLowerCase()}\\(\\s*'${ruta!.replace(/[/:]/g, (c) => `\\${c}`)}'\\s*,\\s*authMiddleware\\b`);
          expect(fuente, `${fichero} ${r} lleva authMiddleware en la ruta`).toMatch(re);
        }
      } else {
        expect(fuente, `${fichero} conserva router.use(authMiddleware)`).toMatch(/router\.use\(\s*authMiddleware\s*\)/);
        expect(fuente).not.toMatch(/router\.use\([^)]*exigirFuncion/); // ADR-0016 §2: nunca a nivel de router
      }
    });
  }
});

describe('AC1/AC2 — cada router.<método>( de los 24 ficheros lleva exigirFuncion o está en la lista blanca', () => {
  const RUTA = /router\.(get|post|put|patch|delete)\(\s*'([^']*)'\s*,([\s\S]{0,500}?)(?:async\s*\(|\(\s*_?req\b|\(\s*\)\s*=>|\);)/g;

  for (const fichero of FICHEROS_DE_RUTAS) {
    it(`${fichero}`, () => {
      const fuente = sinComentarios(leer(fichero));
      const rutas = [...fuente.matchAll(RUTA)];
      expect(rutas.length, 'el fichero declara rutas').toBeGreaterThan(0);
      const sinGuarda = rutas
        // Dígitos admitidos desde la HU #13061 (`tramites.flit2.*`), como en `CODIGO` de inventario-guardas.ts.
        .filter((m) => !/exigirFuncion\('[a-z0-9_.]+'\)/.test(m[3]))
        .map((m) => `${fichero} ${m[1].toUpperCase()} ${m[2]}`)
        .filter((llave) => !LISTA_BLANCA.has(llave));
      expect(sinGuarda, 'rutas sin exigirFuncion que no están en la lista blanca').toEqual([]);
    });
  }

  it('la lista blanca son exactamente 5 rutas, y todas existen sin guarda de función', () => {
    expect(LISTA_BLANCA.size).toBe(5);
    for (const llave of LISTA_BLANCA) {
      const [fichero, metodo, ruta] = llave.split(' ');
      const fuente = sinComentarios(leer(fichero!));
      const re = new RegExp(`router\\.${metodo!.toLowerCase()}\\(\\s*'${ruta!.replace(/[/:]/g, (c) => `\\${c}`)}'\\s*,([\\s\\S]{0,300}?)(?:async\\s*\\(|\\(\\s*_?req\\b)`);
      const m = re.exec(fuente);
      expect(m, `${llave} existe`).not.toBeNull();
      expect(m![1]).not.toMatch(/exigirFuncion/);
    }
  });

  it('las cuatro guardas en línea están montadas con tieneFuncion(req, …) en su fichero (dos del Bug #12642: el export ampliado)', () => {
    expect(sinComentarios(leer('tramites/tramites.routes.ts'))).toMatch(/tieneFuncion\(req, 'tramite\.tramite\.forzar_continuar'\)/);
    expect(sinComentarios(leer('users/users.routes.ts'))).toMatch(/tieneFuncion\(req, 'usuarios\.contrasena\.cambiar_ajena'\)/);
    expect(sinComentarios(leer('flito-soat/flito-soat.routes.ts'))).toMatch(/tieneFuncion\(req, 'soat\.excel\.exportar_pago'\)/);
    expect(sinComentarios(leer('flito-impuestos/flito-impuestos.routes.ts'))).toMatch(/tieneFuncion\(req, 'impuestos\.excel\.exportar_pago'\)/);
  });
});

describe('el lector de montajes cubre la foto entera', () => {
  it('353 montajes = 238 previos + 2 de la #12089 (baja/reactivar) + 4 de la #12541 (servicios adicionales) + 3 por la HU #12545 (servicios por trámite) + 1 por la HU #12591 (recibo de caja) + 5 por la HU #12611 (comprobantes) + 3 por la HU #12619 (viajes de logística) + 3 por la HU #12629 (comprobantes F2) + 1 por la HU #12654 (comprobantes F3: aceptar diferencia) + 2 por el Bug #12642 (export ampliado, en línea) + 1 por la HU #12833 (corregir dirección) + 2 por la HU #12997 (incompletas SOAT: buscar y ver) + 1 por la HU #12998 (reintentar la consulta RUNT) + 2 por la HU #13061 (acceso a FLIT 2: ver y guardar) + 1 por la HU #13237 (interruptor por fuente) + 1 por la HU #13269 (reemplazar el comprobante de pago) + 1 por la HU #13362 (documentos adicionales del SOAT) + 2 por la HU #13364 (cargar y eliminar documentos adicionales) + 76 por la HU #13421 (pesv 48, drivers 24, jornadas 3, rum 1) + 1 por la HU #13425 (operar actas ajenas, en línea) + 3 por la HU #13425 fase B (jornada ajena; vista de auditoría del diagnóstico: abrirla y sugerirla; en línea) + 92 por la HU #13422 (maintenance 33, vehicles 12 + 1 en línea, fleet 10, rndc 5, rutas 16, liquidacion 4, finanzas 8, clients 3) + 134 por la HU #13423 (laft 60, siigo 35 + 8 en línea, soat 12, drive 6, privacy 4, firma 2, vehicles 4, runt 2, integraciones 1) + 1 por la HU #12874 (compañías del canal SOAT sin trámite); los códigos son exactamente los de la foto', () => {
    const montajes = montajesDeFunciones();
    expect(GUARDAS_MEDIDAS).toHaveLength(580); // +1 por la HU #12874 (compañías del canal SOAT sin trámite)
    expect(montajes).toHaveLength(580);
    const codigoDeLlave = new Map(OPERACIONES_DECLARADAS.map((o) => [o.llave, o.codigo]));
    expect(montajes.map((m) => m.codigo).sort()).toEqual(GUARDAS_MEDIDAS.map((g) => codigoDeLlave.get(llaveDe(g))!).sort());
    // En línea: 2 del Bug #12642 + forzar_continuar + contraseña ajena + operar actas ajenas (HU #13425)
    // + jornada ajena + vista de auditoría (abrir y sugerir) de la fase B de la HU #13425
    // + documento completo del propietario en el listado de vehículos (HU #13422)
    // + las 8 acciones de Siigo, en línea en `siigo.permisos.ts` (HU #13423).
    expect(montajes.filter((m) => m.metodo === null)).toHaveLength(17);
  });

  it('un exigirFuncion sin literal hace que el lector LANCE en vez de adivinar', () => {
    // Se prueba sobre un fichero temporal en el scratchpad del test: no se toca ningún router.
    const dir = join(RAIZ_MODULOS, '..', '..', '__tests__', 'fixtures');
    const tmp = join(dir, 'permisos-montaje-no-literal.tmp.ts');
    writeFileSync(tmp, "router.get('/x', exigirFuncion(CODIGO), async (req, res) => {});\n", 'utf8');
    try {
      expect(() => leerMontajes({ modulo: 'x', fichero: 'permisos-montaje-no-literal.tmp.ts' }, dir)).toThrow(/no sé qué código/);
    } finally { unlinkSync(tmp); }
  });
});

describe('AC3 — el ámbito no se toca: las 3 comparaciones de rol que deciden QUÉ filas se ven siguen ahí (HU #13426 retiró 5)', () => {
  for (const { fichero, patron, veces, porque } of AMBITO) {
    it(`${fichero}: ${veces} (${porque})`, () => {
      const fuente = sinComentarios(leer(fichero));
      expect(fuente.match(patron) ?? []).toHaveLength(veces);
    });
  }

  it('son 3 en total, y fuera de ellas no queda ninguna comparación de rol en users (HU #12088, HU #13424)', () => {
    expect(AMBITO.reduce((n, a) => n + a.veces, 0)).toBe(3);
    const enUsers = sinComentarios(leer('users/users.routes.ts')).match(/\brole (===|!==) '[a-z_]+'/g) ?? [];
    // Antes #12088 había ~27 (superRefine + filtros de ámbito por rol). El ámbito del gestor
    // pasó a la puente `flito_gestor_organismos` y quedaron 3 de validación (`role !== 'admin'`,
    // `role === 'admin'` ×2): las guardas «último admin activo». La HU #13424 (ADR-0022 §D1) las
    // retiró: el último administrador lo protege el seguro anti-bloqueo por permisos, no el nombre.
    expect(enUsers.length).toBe(0);
    expect(sinComentarios(leer('users/users.routes.ts'))).not.toMatch(/req\.user!?\.role (===|!==)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// HU #13421 (ADR-0023) — pesv/, drivers/, jornadas/ y rum/ por permiso, una página por ítem del menú.
//
//   · AC1: cada ruta de sus ficheros de rutas lleva SU página (`requirePage('pesv_<item>')`, la del ítem
//     dueño); ninguna ruta de pesv/ queda protegida por la página única `pesv` y no queda ningún
//     `router.use(…requirePage…)` (en /api/pesv se montan varios routers: una guarda de router se
//     filtraba a los siguientes, y así raci/normativa/retención pedían también `pagina.pesv`).
//   · AC3/AC4: lo que exigía rol lleva `exigirFuncion('<…>.administrar')` (transitorio, HU #13429) o la
//     única permanente `rum.resumen.ver`.
//   · AC8: cero `requireRole(` (bloque AC1/AC2 de arriba, por DIRECTORIOS_RECONDUCIDOS) y ninguna
//     comparación de nombre de rol en la declaración de una ruta. Las comparaciones DENTRO de handlers
//     son de la HU #13425 y se enumeran aquí por fichero y número: si aparece otra, rojo.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const DIRECTORIOS_13421 = ['pesv', 'drivers', 'jornadas', 'rum'] as const;
const PAGINAS_PESV = new Set<string>(['pesv', ...PAGINAS_PESV_POR_ITEM, 'pesv_raci', 'pesv_normativa', 'pesv_retencion']);

/** Todos los `*.routes.ts` de los cuatro directorios, leídos del disco (un fichero nuevo entra solo). */
/** Los de FICHEROS_LEGADO_EN_ALCANCE que son de estos cuatro directorios (la HU #13422 añadió los suyos). */
const LEGADO_13421 = FICHEROS_LEGADO_EN_ALCANCE.filter(({ fichero }) => (DIRECTORIOS_13421 as readonly string[]).includes(fichero.split('/')[0]!));
const FICHEROS_LEGADO_DE_RUTAS = DIRECTORIOS_13421.flatMap((d) =>
  readdirSync(join(RAIZ_MODULOS, d)).filter((n) => n.endsWith('.routes.ts')).map((n) => `${d}/${n}`)).sort();

/** Rutas legacy sin página, y por qué. */
const LISTA_BLANCA_LEGADO = new Map([
  ['drivers/checklists.routes.ts GET /qr/:token', 'pública: el QR del vehículo, antes de authMiddleware'],
  ['rum/rum.routes.ts POST /', 'pública: Web Vitals se reportan antes del login (con limitador)'],
  ['rum/rum.routes.ts GET /summary', 'authMiddleware + exigirFuncion permanente: no cuelga de un ítem del menú'],
]);

/** Sub-routers que heredan `authMiddleware` del router que los monta. */
const HEREDAN_AUTH: Record<string, { fichero: string; montaje: string }> = {
  'pesv/diagnostico-evidencias.routes.ts': { fichero: 'pesv/diagnostico.routes.ts', montaje: "router.use('/', evidenciasRouter)" },
  'pesv/export-diagnostico.routes.ts': { fichero: 'pesv/export.routes.ts', montaje: "router.use('/', diagnosticoExportRouter)" },
};

/** HU #13425 (fuera de alcance): comparaciones de nombre de rol DENTRO de handlers que siguen ahí. */
// HU #13425 (fase B): las 12 reglas por nombre de rol que quedaban dentro de los handlers (jornadas 6 +
// notify 1, pesv/diagnostico 2, pesv/export-diagnostico 2, drivers/alcohol 1) pasaron a funciones del motor.
const PENDIENTES_13425: { fichero: string; veces: number; que: string }[] = [];
const COMPARACION_DE_ROL = /\brole\s*(?:===|!==)\s*'[a-z_]+'|\]\.includes\(req\.user[!?]?\.role\)|eq\(users\.role,\s*'[a-z_]+'\)/g;
const RUTA_LEGADO = /router\.(get|post|put|patch|delete)\(\s*'([^']*)'\s*,([\s\S]{0,500}?)(?:async\s*\(|\(\s*_?req\b|\(\s*\)\s*=>|\);)/g;

describe('HU #13421 — pesv/, drivers/, jornadas/ y rum/: página por ítem y «Administrar <ítem>»', () => {
  it('los ficheros de rutas son los 23 medidos y los 20 con guarda de función están en FICHEROS_LEGADO_EN_ALCANCE', () => {
    expect(FICHEROS_LEGADO_DE_RUTAS).toHaveLength(23);
    for (const { fichero } of LEGADO_13421) expect(FICHEROS_LEGADO_DE_RUTAS, fichero).toContain(fichero);
    expect(LEGADO_13421).toHaveLength(20);
  });

  for (const fichero of FICHEROS_LEGADO_DE_RUTAS) {
    it(`${fichero}: cada ruta lleva su página PESV (o está en la lista blanca) y ninguna guarda de router`, () => {
      const fuente = sinComentarios(leer(fichero));
      expect(fuente, 'sin página ni función a nivel de router').not.toMatch(/\brouter\.use\([^)]*(requirePage|exigirFuncion)/);
      const padre = HEREDAN_AUTH[fichero];
      if (padre) {
        // Sub-router sin auth propio: lo monta su padre DESPUÉS de `router.use(authMiddleware)`.
        const p = sinComentarios(leer(padre.fichero));
        expect(p.indexOf(padre.montaje), `${padre.fichero} monta ${fichero}`).toBeGreaterThan(p.search(/router\.use\(\s*authMiddleware\s*\)/));
        expect(p.search(/router\.use\(\s*authMiddleware\s*\)/)).toBeGreaterThan(-1);
      } else if (fichero !== 'rum/rum.routes.ts') expect(fuente).toMatch(/router\.use\(\s*authMiddleware\s*\)/);
      const rutas = [...fuente.matchAll(RUTA_LEGADO)];
      expect(rutas.length).toBeGreaterThan(0);
      for (const m of rutas) {
        const llave = `${fichero} ${m[1]!.toUpperCase()} ${m[2]}`;
        expect(m[3], `${llave}: la declaración de la ruta no compara nombres de rol`).not.toMatch(/\brole\b|requireRole/);
        const pagina = /requirePage\('([a-z_]+)'\)/.exec(m[3]!);
        if (LISTA_BLANCA_LEGADO.has(llave)) { expect(pagina, llave).toBeNull(); continue; }
        expect(pagina, `${llave} sin requirePage`).not.toBeNull();
        expect(PAGINAS_PESV.has(pagina![1]!), `${llave}: ${pagina![1]} no es una página PESV`).toBe(true);
        if (fichero.startsWith('pesv/')) expect(pagina![1], `${llave}: página única`).not.toBe('pesv');
        const funcion = /exigirFuncion\('([a-z0-9_.]+)'\)/.exec(m[3]!);
        if (funcion) expect(funcion[1], llave).toMatch(/\.administrar$/);
      }
    });
  }

  it('la lista blanca existe tal cual y `rum.resumen.ver` es la única operación permanente', () => {
    for (const llave of LISTA_BLANCA_LEGADO.keys()) {
      const [fichero, metodo, ruta] = llave.split(' ');
      const hay = [...sinComentarios(leer(fichero!)).matchAll(RUTA_LEGADO)].some((m) => m[1] === metodo!.toLowerCase() && m[2] === ruta);
      expect(hay, llave).toBe(true);
    }
    const rum = sinComentarios(leer('rum/rum.routes.ts'));
    expect(rum).toMatch(/router\.get\('\/summary', authMiddleware, exigirFuncion\('rum\.resumen\.ver'\),/);
    const legado = new Set(LEGADO_13421.map((f) => f.fichero));
    const codigos = new Set(OPERACIONES_DECLARADAS.filter((o) => legado.has(o.llave.split(' ')[0]!)).map((o) => o.codigo));
    expect([...codigos].filter((c) => !c.endsWith('.administrar'))).toEqual(['rum.resumen.ver']);
  });

  it('cada fichero con guarda de función importa exigirFuncion del motor (o `tieneFuncion`, en las guardas en línea de siigo.permisos.ts)', () => {
    for (const { fichero } of FICHEROS_LEGADO_EN_ALCANCE) {
      const sube = '\\.\\.\\/'.repeat(fichero.split('/').length);
      const nombre = fichero === 'siigo/siigo.permisos.ts' ? 'tieneFuncion' : 'exigirFuncion';
      expect(sinComentarios(leer(fichero)), fichero)
        .toMatch(new RegExp(`import \\{[^}]*\\b${nombre}\\b[^}]*\\} from '${sube}shared\\/middleware\\/exigir-funcion\\.js';`));
    }
  });

  it('AC8 — las comparaciones de nombre de rol que quedan son SOLO las pendientes de la HU #13425 (fichero y número)', () => {
    const medidas: Record<string, number> = {};
    for (const d of DIRECTORIOS_13421) {
      for (const f of ficherosTs(join(RAIZ_MODULOS, d))) {
        const n = (sinComentarios(readFileSync(f, 'utf8')).match(COMPARACION_DE_ROL) ?? []).length;
        if (n) medidas[f.replace(`${RAIZ_MODULOS}/`, '')] = n;
      }
    }
    expect(medidas).toEqual(Object.fromEntries(PENDIENTES_13425.map((p) => [p.fichero, p.veces])));
  });
});


// ─────────────────────────────────────────────────────────────────────────────────────────────────
// HU #13422 (ADR-0023) — maintenance/, vehicles/, fleet/, rndc/, rutas/, liquidacion/, finanzas/ y
// clients/ piden permiso, no rol.
//
//   · AC1: cada ruta de maintenance/ lleva la página de SU ítem (`maintenance_inicio|_ordenes|
//     _indicadores`), nunca la página única `maintenance`, y ningún router de maintenance/ ni de rutas/
//     lleva página a nivel de router (en /api/maintenance y /api/rutas se montan varios routers: la
//     guarda de router de uno se filtraba a los siguientes). rutas/ pasa a `pesv_rutas`/`pesv_pernocta`.
//   · AC3/AC4: lo que exigía rol lleva `exigirFuncion('<…>.administrar')` (transitorio, HU #13429) o una
//     de las tres permanentes (dos lecturas y el documento del propietario).
//   · AC8: cero `requireRole(` (bloque AC1/AC2 de arriba, por DIRECTORIOS_RECONDUCIDOS), ninguna
//     comparación de nombre de rol en NINGÚN fichero de los ocho, y ninguna en la declaración de una ruta.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const DIRECTORIOS_13422 = ['maintenance', 'vehicles', 'fleet', 'rndc', 'rutas', 'liquidacion', 'finanzas', 'clients'] as const;
const PERMANENTES_13422 = ['clients.clientes.ver', 'finanzas.reporte_costos.ver', 'vehicles.propietario.ver_documento'];
const FICHEROS_13422 = DIRECTORIOS_13422.flatMap((d) =>
  readdirSync(join(RAIZ_MODULOS, d)).filter((n) => n.endsWith('.routes.ts')).map((n) => `${d}/${n}`)).sort();
const LEGADO_13422 = FICHEROS_LEGADO_EN_ALCANCE.filter(({ fichero }) => (DIRECTORIOS_13422 as readonly string[]).includes(fichero.split('/')[0]!));

describe('HU #13422 — los ocho directorios de operación: página por ítem y «Administrar <ítem>»', () => {
  it('los ficheros de rutas son los 27 medidos y los 19 con guarda de función están en FICHEROS_LEGADO_EN_ALCANCE', () => {
    expect(FICHEROS_13422).toHaveLength(27);
    for (const { fichero } of LEGADO_13422) expect(FICHEROS_13422, fichero).toContain(fichero);
    expect(LEGADO_13422).toHaveLength(19);
    for (const f of FICHEROS_13422) {
      const tieneGuarda = /exigirFuncion\(|tieneFuncion\(/.test(sinComentarios(leer(f)));
      expect(LEGADO_13422.some((x) => x.fichero === f), `${f} con guarda y fuera del lector`).toBe(tieneGuarda);
    }
  });

  for (const fichero of FICHEROS_13422) {
    it(`${fichero}: ninguna guarda de función en el router, ninguna ruta compara roles, páginas por ítem`, () => {
      const fuente = sinComentarios(leer(fichero));
      expect(fuente).not.toMatch(/router\.use\([^)]*exigirFuncion/);
      if (fichero.startsWith('maintenance/') || fichero.startsWith('rutas/')) {
        expect(fuente, 'sin página a nivel de router').not.toMatch(/\brouter\.use\([^)]*requirePage/);
        expect(fuente).toMatch(/router\.use\(\s*authMiddleware\s*\)/);
      }
      for (const m of fuente.matchAll(RUTA_LEGADO)) {
        const llave = `${fichero} ${m[1]!.toUpperCase()} ${m[2]}`;
        expect(m[3], `${llave}: la declaración no compara roles`).not.toMatch(/\brole\b|requireRole/);
        const pagina = /requirePage\('([a-z_]+)'\)/.exec(m[3]!)?.[1];
        if (fichero.startsWith('maintenance/')) {
          expect(pagina, `${llave} sin página de ítem`).toBeDefined();
          expect((PAGINAS_MANTENIMIENTO_POR_ITEM as readonly string[]).includes(pagina!), `${llave}: ${pagina}`).toBe(true);
        }
        if (fichero.startsWith('rutas/')) {
          expect(pagina, llave).toBe(fichero === 'rutas/pernocta.routes.ts' ? 'pesv_pernocta' : 'pesv_rutas');
        }
        const funcion = /exigirFuncion\('([a-z0-9_.]+)'\)/.exec(m[3]!)?.[1];
        // `vehicles.vehiculos.consultar` es de la HU #13423 (una de las cuatro de solo sesión).
        if (funcion && !PERMANENTES_13422.includes(funcion) && funcion !== 'vehicles.vehiculos.consultar') expect(funcion, llave).toMatch(/\.administrar$/);
      }
    });
  }

  it('AC8 — ninguna comparación de nombre de rol en los ocho directorios (fichero a fichero, no solo rutas)', () => {
    const medidas: Record<string, number> = {};
    for (const d of DIRECTORIOS_13422) {
      for (const f of ficherosTs(join(RAIZ_MODULOS, d))) {
        const n = (sinComentarios(readFileSync(f, 'utf8')).match(COMPARACION_DE_ROL) ?? []).length
          + (sinComentarios(readFileSync(f, 'utf8')).match(/\.role\s*(?:===|!==)/g) ?? []).length;
        if (n) medidas[f.replace(`${RAIZ_MODULOS}/`, '')] = n;
      }
    }
    expect(medidas).toEqual({});
  });

  it('las tres operaciones permanentes y la guarda en línea del documento del propietario están montadas', () => {
    expect(sinComentarios(leer('vehicles/vehicles.routes.ts'))).toMatch(/tieneFuncion\(req, 'vehicles\.propietario\.ver_documento'\)/);
    const codigos = new Set(OPERACIONES_DECLARADAS.filter((o) => LEGADO_13422.some((f) => o.llave.startsWith(`${f.fichero} `))).map((o) => o.codigo));
    expect([...codigos].filter((c) => !c.endsWith('.administrar') && c !== 'vehicles.vehiculos.consultar').sort()).toEqual([...PERMANENTES_13422].sort());
  });

  it('el aviso del envío RNDC fallido va a quien tiene `rndc.manifiestos.administrar`, no al rol `admin`', () => {
    const envio = sinComentarios(leer('rndc/envio.service.ts'));
    expect(envio).toMatch(/usuariosConFuncion\('rndc\.manifiestos\.administrar'\)/);
    expect(envio).not.toMatch(/users\.role/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// HU #13423 (ADR-0023) — laft/, privacy/, firma/, drive/, soat/ (antiguo) y siigo/ piden permiso, no rol;
// las cuatro operaciones que solo exigían sesión piden su permiso. Lo que se vigila aquí, por fichero:
//
//   · AC1: cada ruta que exigía rol lleva `exigirFuncion('<código>')` EN LA RUTA, nunca en un
//     `router.use` (en /api/laft/ros y /api/drive se montan dos routers: una guarda de router de uno
//     se filtraba al otro); los ficheros con guarda están en `FICHEROS_LEGADO_EN_ALCANCE`.
//   · AC2: las 8 acciones de Siigo se deciden en línea en `siigo.permisos.ts` (una por acción).
//   · AC3: las 4 operaciones de solo sesión llevan su guarda de ruta.
//   · AC4: la guarda va ANTES de los limitadores, de multer y de leer el cuerpo.
//   · AC5: lo que exigía un rol de escritura va a un transitorio `.administrar`; las permanentes son
//     las de esta lista cerrada (leer u operar el día a día con la lista de roles que ya lo hacía).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const DIRECTORIOS_13423 = ['laft', 'privacy', 'firma', 'drive', 'soat', 'siigo'] as const;
const PERMANENTES_13423 = [
  'laft.listas.operar', 'laft.contrapartes.operar', 'laft.bitacora.ver', 'laft.capacitaciones.operar',
  'laft.inusuales.operar', 'laft.ros.operar', 'laft.ros.exportar', 'laft.efectivo.operar', 'laft.empleados.operar',
  'laft.manual.firmar', 'laft.tablero.ver', 'laft.sincronizacion.ver',
  'privacy.titulares.operar', 'privacy.accesos_pii.ver', 'firma.estado.ver', 'soat.antiguo.operar',
  'siigo.factura.consultar', 'siigo.factura.emitir', 'siigo.factura.reintentar', 'siigo.factura.reenviar_correo',
  'siigo.factura.marcar_fallido', 'siigo.factura.reactivar', 'siigo.factura.corregir', 'siigo.factura.anular',
  'siigo.parametrizacion.ver', 'siigo.conceptos.confirmar', 'siigo.emision.ver',
  'vehicles.vehiculos.consultar', 'runt.persona.consultar', 'runt.cedula.leer', 'integraciones.fasecolda.buscar',
];
function ficherosDeRutas13423(): string[] {
  const salida: string[] = [];
  for (const d of DIRECTORIOS_13423) {
    for (const f of ficherosTs(join(RAIZ_MODULOS, d))) if (f.endsWith('.routes.ts')) salida.push(f.replace(`${RAIZ_MODULOS}/`, ''));
  }
  return salida.sort();
}
const LEGADO_13423 = FICHEROS_LEGADO_EN_ALCANCE.filter(({ fichero }) =>
  [...DIRECTORIOS_13423, 'runt', 'integraciones'].includes(fichero.split('/')[0] as never));

describe('HU #13423 — los seis directorios sensibles y las cuatro operaciones de solo sesión', () => {
  it('los ficheros con guarda de función son exactamente los de FICHEROS_LEGADO_EN_ALCANCE (36 = 33 de rutas + siigo.permisos.ts + runt + integraciones)', () => {
    expect(LEGADO_13423).toHaveLength(36);
    for (const f of ficherosDeRutas13423()) {
      const tieneGuarda = /exigirFuncion\(|tieneFuncion\(/.test(sinComentarios(leer(f)));
      expect(LEGADO_13423.some((x) => x.fichero === f), `${f} con guarda y fuera del lector`).toBe(tieneGuarda);
    }
    expect(LEGADO_13423.map((x) => x.fichero)).toContain('siigo/siigo.permisos.ts');
  });

  for (const fichero of ficherosDeRutas13423()) {
    it(`${fichero}: ninguna guarda en el router, ninguna declaración de ruta mira el rol, transitorio o permanente medida`, () => {
      const fuente = sinComentarios(leer(fichero));
      expect(fuente).not.toMatch(/router\.use\([^)]*(exigirFuncion|requireRole)/);
      for (const m of fuente.matchAll(RUTA_LEGADO)) {
        const llave = `${fichero} ${m[1]!.toUpperCase()} ${m[2]}`;
        expect(m[3], `${llave}: la declaración no compara roles`).not.toMatch(/\brole\b|requireRole/);
        const funcion = /exigirFuncion\('([a-z0-9_.]+)'\)/.exec(m[3]!)?.[1];
        if (funcion && !PERMANENTES_13423.includes(funcion)) expect(funcion, llave).toMatch(/\.administrar$/);
        // AC4: la guarda es lo PRIMERO de la declaración (antes de limitador, multer o lector de xlsx).
        if (funcion) expect(m[3]!.trimStart(), llave).toMatch(/^exigirFuncion\(/);
      }
    });
  }

  it('AC2: las 8 acciones de Siigo se deciden en línea con su función, una por acción', () => {
    const fuente = sinComentarios(leer('siigo/siigo.permisos.ts'));
    for (const a of ['consultar', 'emitir', 'reintentar', 'reenviar_correo', 'marcar_fallido', 'reactivar', 'corregir', 'anular']) {
      expect(fuente, a).toMatch(new RegExp(`case '${a}': return tieneFuncion\\(req, 'siigo\\.factura\\.${a}'\\)`));
    }
  });

  it('AC3: las cuatro operaciones de solo sesión llevan su guarda de ruta, antes del handler', () => {
    const vehicles = sinComentarios(leer('vehicles/vehicles.routes.ts'));
    for (const r of [/router\.get\('\/', exigirFuncion\('vehicles\.vehiculos\.consultar'\)/, /router\.get\('\/:vin\/historial', exigirFuncion\('vehicles\.vehiculos\.consultar'\)/,
      /router\.post\('\/:vin\/historial\/sync', exigirFuncion\('vehicles\.vehiculos\.consultar'\)/, /router\.get\('\/:vin\/certificado', exigirFuncion\('vehicles\.vehiculos\.consultar'\)/]) {
      expect(vehicles).toMatch(r);
    }
    const runt = sinComentarios(leer('runt/runt.routes.ts'));
    expect(runt).toMatch(/router\.post\('\/consulta-persona', exigirFuncion\('runt\.persona\.consultar'\), async/);
    expect(runt).toMatch(/router\.post\('\/ocr-cedula', exigirFuncion\('runt\.cedula\.leer'\), async/);
    expect(sinComentarios(leer('integraciones/integraciones.routes.ts')))
      .toMatch(/router\.get\('\/fasecolda\/buscar', authMiddleware, exigirFuncion\('integraciones\.fasecolda\.buscar'\), async/);
  });

  it('AC4: los limitadores de laft/ y privacy/ siguen montados (los mismos que en la base a2b2cd47)', () => {
    const cuenta = (d: string, re: RegExp) => ficherosTs(join(RAIZ_MODULOS, d))
      .reduce((n, f) => n + (sinComentarios(readFileSync(f, 'utf8')).match(re) ?? []).length, 0);
    expect(cuenta('laft', /\b(writeLimiter|laftWriteLimiter|generateLimiter|syncLimiter|manualSyncLimiter)\b/g)).toBe(42);
    expect(cuenta('privacy', /\b(forgetLimiter|previewLimiter)\b/g)).toBe(4);
  });

  it('AC5: los transitorios de esta HU son exactamente estos once, todos «Administrar …»', () => {
    const codigos = new Set(OPERACIONES_DECLARADAS.filter((o) => LEGADO_13423.some((f) => o.llave.startsWith(`${f.fichero} `))).map((o) => o.codigo));
    codigos.add('vehicles.vehiculos.consultar'); // vive en vehicles/, ya en el lector desde la HU #13422 (aserto de AC3)
    expect([...codigos].filter((c) => c.endsWith('.administrar')).sort()).toEqual([
      'drive.archivos.administrar', 'firma.solicitud.administrar', 'laft.listas.administrar', 'laft.manual.administrar',
      'laft.oficial.administrar', 'laft.plan_auditoria.administrar', 'laft.retencion.administrar', 'laft.sincronizacion.administrar',
      'privacy.olvido.administrar', 'siigo.parametrizacion.administrar', 'soat.antiguo.administrar',
    ]);
    expect([...codigos].filter((c) => !c.endsWith('.administrar')).sort()).toEqual([...PERMANENTES_13423].sort());
  });
});
