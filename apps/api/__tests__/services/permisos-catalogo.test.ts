// HU #12081 — El catálogo de funciones, comprobado sobre el CÓDIGO (AC2, AC2-bis, AC3, AC6).
//
// Aquí no hay base de datos y no hace falta: lo que se comprueba es lo que el catálogo AFIRMA antes
// de sembrarse. La otra mitad —que la base tiene exactamente esto y que el reparto reproduce el
// estado de hoy— vive en `__tests__/db/migracion-0179.test.ts`, que sí necesita PostgreSQL.
//
// **Ningún número escrito a mano decide nada aquí, salvo el 43.** El enunciado original de esta HU
// decía «46 constantes requireRole» y lo medido son 217 rutas guardadas; un test que hubiera fijado
// el 46 habría pasado en verde dejando fuera lo demás. Por eso los asertos de operaciones comparan
// CONJUNTOS contra la foto y contra los montajes leídos del fuente, no cardinales. El 48 sí se
// escribe: es 49 slugs de PAGES menos `flito_ayuda`, y ahí el número ES la afirmación del AC2-bis.
//
// Desde la HU #12083 las rutas ya no llevan `requireRole`: la fuente de los ROLES es la foto histórica
// `inventario.generado.ts` (congelada; se edita a mano solo con migración) y lo que se lee del fuente
// es el CÓDIGO montado con `exigirFuncion`/`tieneFuncion`. El invariante de doble sentido pasa a ser:
// por fichero, los montajes cubren EXACTAMENTE la foto.
import { describe, it, expect } from 'vitest';
import { PAGES, PAGE_GROUPS, USER_ROLES, paginasPorDefecto } from '@operaciones/shared-types';
import {
  catalogoCompleto, catalogoDePaginas, catalogoDeOperaciones, repartoDePartida, moduloDeGrupo,
  PAGINAS_NO_CONCEDIBLES, CatalogoIncoherenteError,
} from '../../src/modules/permisos/catalogo.js';
import {
  AGRUPACION_DE_OPERACION, AGRUPACION_DE_PAGINA, moduloAgrupado, reagrupaciones,
} from '../../src/modules/permisos/catalogo-agrupacion.js';
import {
  leerMontajes, llaveDe, FICHEROS_EN_ALCANCE,
} from '../../src/modules/permisos/inventario-guardas.js';
import { GUARDAS_MEDIDAS } from '../../src/modules/permisos/inventario.generado.js';
import {
  OPERACIONES_DECLARADAS, OPERACIONES_RETIRADAS_CANAL_CLIENTE,
} from '../../src/modules/permisos/catalogo-operaciones.js';
import { FUNCIONES_SIN_ADMIN } from '../../src/modules/permisos/permisos.service.js';

const catalogo = catalogoCompleto();
const paginas = catalogo.filter((f) => f.tipo === 'pagina');
const operaciones = catalogo.filter((f) => f.tipo === 'operacion');

describe('AC2-bis — los dos defectos del catálogo de origen, y el que no lo era', () => {
  it('`PAGE_GROUPS` trae 49 entradas para 48 slugs únicos: `transito` está dos veces', () => {
    // 44 → 45 / 43 → 44 desde la HU #12375: entra `flito_tarifas` en «Finanzas».
    // 45 → 46 / 44 → 45 desde la HU #12085: entra `roles_permisos` en «Administración».
    // 46 → 47 / 45 → 46 desde la HU #12542: entra `flito_servicios_adicionales` en «Finanzas».
    // 47 → 48 / 46 → 47 desde la HU #12611: entra `flito_comprobantes` en «Finanzas».
    // 48 → 49 / 47 → 48 desde la HU #12623: entra `finanzas_gastos_diarios` en «Finanzas».
    const entradas = PAGE_GROUPS.flatMap((g) => g.pages);
    expect(entradas).toHaveLength(49);
    expect(new Set(entradas).size).toBe(48);
    const repetidos = entradas.filter((s, i) => entradas.indexOf(s) !== i);
    expect(repetidos).toEqual(['transito']);
  });

  it('la duplicación no se propaga: ni un código repetido en el catálogo', () => {
    const codigos = catalogo.map((f) => f.codigo);
    expect(new Set(codigos).size).toBe(codigos.length);
    // Y en particular la que lo provocaría: una sola función para `transito`.
    expect(codigos.filter((c) => c === 'pagina.transito')).toHaveLength(1);
  });

  it('`flito_ayuda` NO genera función de tipo `pagina`, y nadie la puede "arreglar"', () => {
    // El AC original mandaba meterla en PAGE_GROUPS por estar fuera; se corrigió el 9/09/2026. El
    // motivo está escrito encima de su declaración en permissions.ts: existe SOLO para el label de
    // NoAccess y el ítem de nav, y su visibilidad es DERIVADA (`puedeVerAyudaFlito`, la intersección
    // con el catálogo de fichas). Concederla a mano no habilita nada.
    //
    // Este caso es el clavo: si alguien la mete en PAGE_GROUPS o la saca de PAGINAS_NO_CONCEDIBLES,
    // se pone rojo y obliga a releer aquel comentario antes de "arreglarla".
    expect(PAGES).toHaveProperty('flito_ayuda');
    expect(PAGE_GROUPS.flatMap((g) => g.pages)).not.toContain('flito_ayuda');
    expect(PAGINAS_NO_CONCEDIBLES).toContain('flito_ayuda');
    expect(catalogo.map((f) => f.codigo)).not.toContain('pagina.flito_ayuda');
  });

  it('las funciones de tipo `pagina` son 48: los 49 slugs de PAGES menos `flito_ayuda`', () => {
    expect(Object.keys(PAGES)).toHaveLength(49);
    expect(paginas).toHaveLength(48);
    const esperados = Object.keys(PAGES).filter((s) => s !== 'flito_ayuda').sort();
    expect(paginas.map((f) => f.codigo.replace('pagina.', '')).sort()).toEqual(esperados);
  });
});

describe('AC2 — el catálogo, nombrado como lo nombra el negocio', () => {
  it('cada página lleva el label de PAGES como nombre de negocio', () => {
    for (const f of paginas) {
      const slug = f.codigo.replace('pagina.', '') as keyof typeof PAGES;
      expect(f.nombreNegocio).toBe(PAGES[slug]);
    }
  });

  it('ninguna función tiene descripción vacía, ni página ni operación', () => {
    const vacias = catalogo.filter((f) => !f.descripcion.trim()).map((f) => f.codigo);
    expect(vacias).toEqual([]);
  });

  it('cada función lleva módulo; el de las operaciones prefija su código o es su reagrupación declarada, y el prefijo sigue siendo un módulo de FICHEROS_EN_ALCANCE', () => {
    expect(catalogo.filter((f) => !f.modulo)).toEqual([]);
    const modulosDeFichero = new Set(FICHEROS_EN_ALCANCE.map((f) => f.modulo));
    for (const f of operaciones) {
      const prefijo = f.codigo.slice(0, f.codigo.indexOf('.'));
      expect(modulosDeFichero, f.codigo).toContain(prefijo);
      const reagrupada = AGRUPACION_DE_OPERACION[f.codigo];
      if (reagrupada) expect(f.modulo, f.codigo).toBe(reagrupada);
      else expect(f.codigo.startsWith(`${f.modulo}.`), f.codigo).toBe(true);
    }
  });

  it('los códigos de operación tienen la forma <modulo>.<objeto>.<accion>', () => {
    const malFormados = operaciones.filter((f) => !/^[a-z_]+\.[a-z_]+\.[a-z_]+$/.test(f.codigo));
    expect(malFormados.map((f) => f.codigo)).toEqual([]);
  });

  it('los diez códigos SOAT que el AC nombra existen tal cual', () => {
    const codigos = new Set(catalogo.map((f) => f.codigo));
    for (const c of [
      'soat.cola.ver', 'soat.solicitud.crear', 'soat.solicitud.enviar', 'soat.solicitud.reversar',
      'soat.proveedor.cambiar', 'soat.soportes.descargar', 'soat.excel.exportar',
      'soat.comprobante.cargar', 'soat.masiva.cargar', 'soat.runt.preconsultar',
    ]) expect(codigos).toContain(c);
  });

  it('caben en las columnas que declara la 0179', () => {
    for (const f of catalogo) {
      expect(f.codigo.length).toBeLessThanOrEqual(80);
      expect(f.modulo.length).toBeLessThanOrEqual(40);
      expect(f.nombreNegocio.length).toBeLessThanOrEqual(120);
    }
  });
});

describe('AC2/AC6 — las operaciones salen de la foto, y los montajes del fuente la cubren exactamente', () => {
  const guardas = GUARDAS_MEDIDAS;
  const codigoDeLlave = new Map(OPERACIONES_DECLARADAS.map((o) => [o.llave, o.codigo]));

  it('por fichero, `leerMontajes` cubre EXACTAMENTE la foto: cada ruta de la foto lleva montado el código que el catálogo le declara, y no hay montaje fuera de la foto', () => {
    // El runtime NO relee los `.ts` —la imagen de producción no los lleva—, así que lo que decide en
    // arranque es `inventario.generado.ts`. Este caso es lo único que impide que esa foto se separe del
    // fuente: una ruta nueva con `exigirFuncion` y sin entrada en la foto (ni migración) se ve aquí;
    // una ruta de la foto que alguien deje sin guarda, también. Las guardas EN LÍNEA (`condicion`) se
    // comprueban por código: `tieneFuncion(req, '<codigo>')` aparece en su fichero.
    for (const f of FICHEROS_EN_ALCANCE) {
      const esperados = guardas.filter((g) => g.fichero === f.fichero).map((g) => {
        const codigo = codigoDeLlave.get(llaveDe(g));
        return g.condicion ? `${g.fichero} tieneFuncion → ${codigo}` : `${llaveDe(g)} → ${codigo}`;
      }).sort();
      const leidos = leerMontajes(f).map((m) => (m.metodo === null
        ? `${m.fichero} tieneFuncion → ${m.codigo}`
        : `${m.fichero} ${m.metodo} ${m.ruta} → ${m.codigo}`)).sort();
      expect(leidos, f.fichero).toEqual(esperados);
    }
  });

  it('hay exactamente una función por ruta de la foto, y ninguna de sobra', () => {
    // El aserto que el «46» del enunciado habría dejado pasar: conjuntos, no cardinales.
    expect(new Set(OPERACIONES_DECLARADAS.map((o) => o.llave)))
      .toEqual(new Set(guardas.map(llaveDe)));
    expect(operaciones).toHaveLength(guardas.length);
    expect(new Set(operaciones.map((f) => f.codigo)).size).toBe(guardas.length);
  });

  it('los roles de cada operación son LITERALMENTE los de su entrada en la foto', () => {
    const porLlave = new Map(guardas.map((g) => [llaveDe(g), g]));
    const declPorLlave = new Map(OPERACIONES_DECLARADAS.map((o) => [o.llave, o]));
    for (const f of operaciones) {
      const llave = [...declPorLlave.entries()].find(([, o]) => o.codigo === f.codigo)![0];
      expect(f.roles).toEqual(porLlave.get(llave)!.roles);
    }
  });

  it('la foto cubre el alcance del Feature —incluido `users/` desde la #12083— y NO se cuela `clients`, que queda fuera', () => {
    expect(FICHEROS_EN_ALCANCE.some((f) => f.fichero.startsWith('clients/'))).toBe(false);
    expect(new Set(guardas.map((g) => g.fichero))).toEqual(new Set(FICHEROS_EN_ALCANCE.map((f) => f.fichero)));
    expect(guardas.some((g) => g.fichero === 'users/users.routes.ts')).toBe(true);
  });

  it('una guarda sin nombre declarado revienta, y dice cuál', () => {
    const sobrante = [...guardas, {
      modulo: 'soat', fichero: 'flito-soat/flito-soat.routes.ts',
      metodo: 'POST' as const, ruta: '/inventada', roles: ['admin'], heredada: false,
    }];
    expect(() => catalogoDeOperaciones(sobrante)).toThrow(CatalogoIncoherenteError);
    expect(() => catalogoDeOperaciones(sobrante)).toThrow(/POST \/inventada/);
  });

  it('un nombre declarado sin guarda viva revienta también, que es el otro sentido', () => {
    const faltante = guardas.filter((g) => g.ruta !== '/enviar');
    expect(() => catalogoDeOperaciones(faltante)).toThrow(/SIN guarda viva/);
  });

  it('las cuatro guardas en línea van con su condición en la llave y no colisionan con la ruta que las contiene (dos son del Bug #12642)', () => {
    const enLinea = guardas.filter((g) => g.condicion);
    expect(enLinea.map(llaveDe).sort()).toEqual([
      'flito-impuestos/flito-impuestos.routes.ts POST /export [incluirPago]',
      'flito-soat/flito-soat.routes.ts POST /export [incluirPago]',
      'tramites/tramites.routes.ts PATCH /:id [_forzarContinuar]',
      'users/users.routes.ts PATCH /:id/password [ajena]',
    ]);
    expect(codigoDeLlave.get('flito-soat/flito-soat.routes.ts POST /export')).toBe('soat.excel.exportar');
    expect(codigoDeLlave.get('flito-soat/flito-soat.routes.ts POST /export [incluirPago]')).toBe('soat.excel.exportar_pago');
    expect(codigoDeLlave.get('tramites/tramites.routes.ts PATCH /:id')).toBe('tramite.tramite.editar');
    expect(codigoDeLlave.get('tramites/tramites.routes.ts PATCH /:id [_forzarContinuar]')).toBe('tramite.tramite.forzar_continuar');
  });
});

describe('AC3 — las cuatro operaciones del canal Cliente no existen, y no vuelven', () => {
  it('ninguna de las cuatro está en el catálogo', () => {
    const codigos = new Set(catalogo.map((f) => f.codigo));
    for (const c of OPERACIONES_RETIRADAS_CANAL_CLIENTE) expect(codigos).not.toContain(c);
  });

  it('ni queda rastro de validar, rechazar con causal, ver causales o subsanar en SOAT', () => {
    // Por si vuelven con otro nombre: se busca el verbo, no el código exacto.
    const soat = catalogo.filter((f) => f.codigo.startsWith('soat.'));
    const sospechosas = soat.filter((f) => /causal|subsan|\.validar$/.test(f.codigo));
    expect(sospechosas.map((f) => f.codigo)).toEqual([]);
  });
});

describe('AC4 — el reparto de partida reproduce el estado de hoy (CF-16)', () => {
  const reparto = repartoDePartida(catalogo);
  const porRol = (rol: string) => reparto.filter(([r]) => r === rol).map(([, c]) => c);

  it('cada rol de sistema tiene una fila `pagina.<slug>` por cada slug que hoy le concede su tabla', () => {
    for (const rol of USER_ROLES) {
      if (rol === 'admin') continue; // el admin va en su propio caso: ya no tiene fila en la tabla
      const esperadas = paginasPorDefecto(rol)
        .filter((s) => !PAGINAS_NO_CONCEDIBLES.includes(s))
        .map((s) => `pagina.${s}`).sort();
      const sembradas = porRol(rol).filter((c) => c.startsWith('pagina.')).sort();
      expect(sembradas, `páginas sembradas para ${rol}`).toEqual(esperadas);
    }
  });

  it('`admin` queda con TODAS las páginas concedibles marcadas una a una', () => {
    // Es la mitad que hace neutro retirar los dos atajos. Si esto se rompe, el administrador se
    // queda sin pantallas el día del merge: no es un test de forma, es el seguro de la HU.
    const suyas = porRol('admin').filter((c) => c.startsWith('pagina.')).sort();
    expect(suyas).toEqual(paginas.map((f) => f.codigo).sort());
    expect(suyas).toHaveLength(48);
  });

  it('`admin` tiene todas las operaciones salvo las tres del canal Cliente, que son de `cliente`', () => {
    const suyas = new Set(porRol('admin'));
    const sinAdmin = operaciones.filter((f) => !suyas.has(f.codigo)).map((f) => f.codigo).sort();
    expect(sinAdmin).toEqual([...FUNCIONES_SIN_ADMIN].sort());
    // Y no están huérfanas: son del canal Cliente, con `requireRole('cliente')` a secas.
    for (const c of sinAdmin) {
      expect(operaciones.find((f) => f.codigo === c)!.roles).toEqual(['cliente']);
    }
  });

  it('ningún rol recibe una función que no esté en el catálogo', () => {
    const codigos = new Set(catalogo.map((f) => f.codigo));
    for (const [, codigo] of reparto) expect(codigos).toContain(codigo);
  });

  it('todos los roles del reparto son roles que el producto conoce', () => {
    const roles = new Set(reparto.map(([r]) => r));
    for (const r of roles) expect(USER_ROLES).toContain(r as never);
  });
});

describe('AC6 — añadir una función obliga a decidir sobre `admin`', () => {
  it('la lista de excepciones nombra las tres, y solo las tres', () => {
    // Un `FUNCIONES_SIN_ADMIN` que crezca sin que nadie lo note es exactamente el fallo que el AC6
    // quiere evitar. Aquí se fija su contenido: ampliarla obliga a tocar este caso y explicarse.
    expect([...FUNCIONES_SIN_ADMIN].sort())
      .toEqual(['soat.factura.leer', 'soat.runt.preconsultar', 'soat.solicitud.crear']);
  });

  it('todas las excepciones existen de verdad en el catálogo', () => {
    const codigos = new Set(catalogo.map((f) => f.codigo));
    for (const c of FUNCIONES_SIN_ADMIN) expect(codigos).toContain(c);
  });
});

describe('HU #12716 — cada página se agrupa con las acciones de su módulo', () => {
  const porCodigo = new Map(catalogoDePaginas().map((f) => [f.codigo, f.modulo]));
  const codigoDeLlave = new Map(OPERACIONES_DECLARADAS.map((o) => [o.llave, o.codigo]));

  it('la pantalla cae en el módulo de sus acciones, no en el grupo de PAGE_GROUPS (AC1)', () => {
    expect(porCodigo.get('pagina.transito')).toBe('transito');
    expect(porCodigo.get('pagina.transito_organismos')).toBe('transito');
    expect(porCodigo.get('pagina.drive')).toBe('derechos');
    expect(porCodigo.get('pagina.clients')).toBe('clientes');
    expect(porCodigo.get('pagina.users')).toBe('usuarios');
  });

  it('una página sin acciones conserva su grupo', () => {
    expect(porCodigo.get('pagina.dashboard')).toBe('general');
    expect(AGRUPACION_DE_PAGINA).not.toHaveProperty('dashboard');
    expect(moduloAgrupado('pagina.dashboard', 'general')).toBe('general');
  });

  it('ninguna página queda en `flito_soat_e_impuestos`, y los módulos `parametrizacion`, `sync` y `finanzas` de operaciones no existen (AC1, AC2)', () => {
    const modulos = new Set(catalogo.map((f) => f.modulo));
    expect(modulos.has('flito_soat_e_impuestos')).toBe(false);
    expect(modulos.has('parametrizacion')).toBe(false);
    expect(modulos.has('sync')).toBe(false);
    expect(paginas.filter((f) => f.modulo === 'flito_soat_e_impuestos')).toEqual([]);
    // `finanzas` sigue existiendo como módulo de PÁGINAS sin acciones (gastos diarios, Siigo), pero
    // ninguna operación queda ahí: las de servicios adicionales se fueron a su pantalla.
    expect(operaciones.filter((f) => f.modulo === 'finanzas')).toEqual([]);
    for (const m of ['clientes', 'tarifas', 'servicios_adicionales', 'catalogos_compartidos']) expect(modulos).toContain(m);
  });

  it('los 46 códigos que la HU nombra llevan el módulo esperado (AC1, AC2)', () => {
    // La tabla literal de la HU: es la afirmación del PO, no se deriva del mapa.
    const esperado: Record<string, string> = {
      'pagina.flito_tramites': 'tramites', 'pagina.flito_soat': 'soat', 'pagina.flito_impuestos': 'impuestos',
      'pagina.flito_derechos': 'derechos', 'pagina.drive': 'derechos', 'pagina.flito_revisiones': 'revisiones',
      'pagina.flito_compuerta': 'compuerta', 'pagina.flito_tablero': 'tablero', 'pagina.flito_bitacora': 'bitacora',
      'pagina.flito_logistica': 'logistica', 'pagina.flito_logistica_ruta': 'logistica', 'pagina.flito_bolsas': 'bolsas',
      'pagina.flito_comparendos': 'comparendos', 'pagina.flito_conciliacion': 'conciliacion',
      'pagina.flito_comprobantes': 'comprobantes', 'pagina.finanzas_reporte_costos': 'liquidacion',
      'pagina.users': 'usuarios', 'pagina.roles_permisos': 'permisos', 'pagina.tramite': 'tramite',
      'pagina.transito': 'transito', 'pagina.clients': 'clientes', 'pagina.flito_tarifas': 'tarifas',
      'pagina.flito_servicios_adicionales': 'servicios_adicionales',
      'sync.sync.lanzar': 'tramites', 'sync.sync.ver_estado': 'tramites',
      'parametrizacion.companias.editar': 'clientes',
      'parametrizacion.proveedores.crear': 'clientes', 'parametrizacion.proveedores.editar': 'clientes',
      'parametrizacion.tarifas.crear': 'tarifas', 'parametrizacion.tarifas.editar': 'tarifas',
      'parametrizacion.tarifas.historial': 'tarifas', 'parametrizacion.tarifas.listar': 'tarifas',
      'parametrizacion.tarifas.ver_por_cliente': 'tarifas',
      'parametrizacion.servicios_adicionales.crear': 'servicios_adicionales',
      'parametrizacion.servicios_adicionales.dar_de_baja': 'servicios_adicionales',
      'parametrizacion.servicios_adicionales.editar': 'servicios_adicionales',
      'parametrizacion.servicios_adicionales.listar': 'servicios_adicionales',
      'finanzas.servicios_adicionales.asignar': 'servicios_adicionales',
      'finanzas.servicios_adicionales.quitar': 'servicios_adicionales',
      'finanzas.servicios_adicionales.ver': 'servicios_adicionales',
      'parametrizacion.organismos.editar': 'transito', 'parametrizacion.organismos.fijar_modalidad': 'transito',
      'parametrizacion.organismos.ver_vigencias': 'transito',
      'parametrizacion.companias.listar': 'catalogos_compartidos',
      'parametrizacion.proveedores.listar': 'catalogos_compartidos',
      'parametrizacion.organismos.listar': 'catalogos_compartidos',
    };
    expect(Object.keys(esperado)).toHaveLength(46);
    const porCodigoTodo = new Map(catalogo.map((f) => [f.codigo, f.modulo]));
    for (const [codigo, modulo] of Object.entries(esperado)) expect(porCodigoTodo.get(codigo), codigo).toBe(modulo);
  });

  it('`reagrupaciones()` tiene 47 pares ordenados por código; 46 cambian el valor estructural y el de `transito_organismos` es no-op', () => {
    const pares = reagrupaciones();
    expect(pares).toHaveLength(47);
    expect(pares.map(([c]) => c)).toEqual([...pares.map(([c]) => c)].sort((a, b) => a.localeCompare(b)));
    expect(new Set(pares.map(([c]) => c)).size).toBe(47);

    // El módulo ESTRUCTURAL: el grupo de PAGE_GROUPS (primera aparición) para páginas y `g.modulo`
    // de la foto para operaciones. Se calcula sin el mapa, que es la otra cuenta.
    const estructural = new Map<string, string>();
    for (const grupo of PAGE_GROUPS) for (const slug of grupo.pages) {
      if (!estructural.has(`pagina.${slug}`)) estructural.set(`pagina.${slug}`, moduloDeGrupo(grupo.label));
    }
    for (const g of GUARDAS_MEDIDAS) estructural.set(codigoDeLlave.get(llaveDe(g))!, g.modulo);

    const cambian = pares.filter(([codigo, modulo]) => estructural.get(codigo) !== modulo);
    expect(cambian).toHaveLength(46);
    const noOp = pares.filter(([codigo, modulo]) => estructural.get(codigo) === modulo);
    expect(noOp).toEqual([['pagina.transito_organismos', 'transito']]);
  });

  it('una clave del mapa que no exista en el catálogo revienta con CatalogoIncoherenteError (AC3)', () => {
    // El mapa es `Readonly` en tipos, no congelado en runtime: se inyecta y se retira la entrada muerta.
    const mapa = AGRUPACION_DE_OPERACION as Record<string, string>;
    mapa['parametrizacion.tarifas.borrar'] = 'tarifas';
    try {
      expect(() => catalogoCompleto()).toThrow(CatalogoIncoherenteError);
      expect(() => catalogoCompleto()).toThrow(/Agrupación declarada para un código que no existe: parametrizacion\.tarifas\.borrar/);
    } finally {
      delete mapa['parametrizacion.tarifas.borrar'];
    }
    expect(() => catalogoCompleto()).not.toThrow();
  });

  it('la comprobación estructural del prefijo se conserva: una guarda cuyo código no empiece por su módulo de fichero revienta aunque el mapa la reagrupe (AC3)', () => {
    // `sync.sync.lanzar` se reagrupa a `tramites`; si su guarda dijera módulo `tramites`, el prefijo
    // `sync.` ya no cuadra y tiene que caer ANTES de aplicar el mapa.
    const guardas = GUARDAS_MEDIDAS.map((g) => (g.modulo === 'sync' ? { ...g, modulo: 'tramites' } : g));
    expect(() => catalogoDeOperaciones(guardas)).toThrow(CatalogoIncoherenteError);
    expect(() => catalogoDeOperaciones(guardas)).toThrow(/no empieza por el módulo «tramites»/);
  });
});
