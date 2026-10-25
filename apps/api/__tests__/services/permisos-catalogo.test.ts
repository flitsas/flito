// HU #12081 — El catálogo de funciones, comprobado sobre el CÓDIGO (AC2, AC2-bis, AC3, AC6).
//
// Aquí no hay base de datos y no hace falta: lo que se comprueba es lo que el catálogo AFIRMA antes
// de sembrarse. La otra mitad —que la base tiene exactamente esto y que el reparto reproduce el
// estado de hoy— vive en `__tests__/db/migracion-0179.test.ts`, que sí necesita PostgreSQL.
//
// **Ningún número escrito a mano decide nada aquí, salvo el 43.** El enunciado original de esta HU
// decía «46 constantes requireRole» y lo medido son 217 rutas guardadas; un test que hubiera fijado
// el 46 habría pasado en verde dejando fuera lo demás. Por eso los asertos de operaciones comparan
// CONJUNTOS contra la foto y contra los montajes leídos del fuente, no cardinales. El 49 sí se
// escribe: es 50 slugs de PAGES menos `flito_ayuda`, y ahí el número ES la afirmación del AC2-bis.
//
// Desde la HU #12083 las rutas ya no llevan `requireRole`: la fuente de los ROLES es la foto histórica
// `inventario.generado.ts` (congelada; se edita a mano solo con migración) y lo que se lee del fuente
// es el CÓDIGO montado con `exigirFuncion`/`tieneFuncion`. El invariante de doble sentido pasa a ser:
// por fichero, los montajes cubren EXACTAMENTE la foto.
import { describe, it, expect } from 'vitest';
import { PAGES, PAGE_GROUPS, USER_ROLES, paginasPorDefecto } from '@operaciones/shared-types';
import {
  catalogoPlano, catalogoDePaginas, catalogoDeOperaciones, repartoDePartida, moduloDeGrupo,
  PAGINAS_NO_CONCEDIBLES, CatalogoIncoherenteError,
} from '../../src/modules/permisos/catalogo.js';
import {
  AGRUPACION_DE_OPERACION, AGRUPACION_DE_OPERACION_LEGADO, AGRUPACION_DE_PAGINA, moduloAgrupado, reagrupaciones,
} from '../../src/modules/permisos/catalogo-agrupacion.js';
import {
  leerMontajes, llaveDe, FICHEROS_EN_ALCANCE, FICHEROS_LEGADO_EN_ALCANCE,
} from '../../src/modules/permisos/inventario-guardas.js';
import { GUARDAS_MEDIDAS } from '../../src/modules/permisos/inventario.generado.js';
import {
  OPERACIONES_DECLARADAS, OPERACIONES_RETIRADAS_CANAL_CLIENTE,
} from '../../src/modules/permisos/catalogo-operaciones.js';

/**
 * Las funciones que el reparto DE PARTIDA (la siembra que genera `catalogo.ts`) no le da a `admin`.
 * HU #13424 (ADR-0022): ya no son una excepción del motor —`FUNCIONES_SIN_ADMIN` se retiró con el
 * check de arranque—; la 0226 le marca a `admin` `impuestos.recibos.reemplazar` y deja fuera las tres
 * del canal SOAT sin trámite (motivo en `permisos-siembra-admin.test.ts`, `EXCLUIDAS_DE_ADMIN`).
 * Se fija aquí para que el reparto de partida no cambie en silencio.
 */
const SIN_ADMIN_EN_EL_REPARTO_DE_PARTIDA: readonly string[] = [
  'impuestos.recibos.reemplazar', 'soat.factura.leer', 'soat.runt.preconsultar', 'soat.solicitud.crear',
];

const catalogo = catalogoPlano();
const paginas = catalogo.filter((f) => f.tipo === 'pagina');
const operaciones = catalogo.filter((f) => f.tipo === 'operacion');

describe('AC2-bis — los dos defectos del catálogo de origen, y el que no lo era', () => {
  it('`PAGE_GROUPS` trae 76 entradas para 75 slugs únicos: `transito` está dos veces', () => {
    // 44 → 45 / 43 → 44 desde la HU #12375: entra `flito_tarifas` en «Finanzas».
    // 45 → 46 / 44 → 45 desde la HU #12085: entra `roles_permisos` en «Administración».
    // 46 → 47 / 45 → 46 desde la HU #12542: entra `flito_servicios_adicionales` en «Finanzas».
    // 47 → 48 / 46 → 47 desde la HU #12611: entra `flito_comprobantes` en «Finanzas».
    // 48 → 49 / 47 → 48 desde la HU #12623: entra `finanzas_gastos_diarios` en «Finanzas».
    // 49 → 50 / 48 → 49 desde la HU #13255: entra `perfil` en «General».
    // 50 → 71 / 49 → 70 desde la HU #13421: entran las 21 páginas por ítem del menú PESV.
    // 71 → 74 / 70 → 73 desde la HU #13422: entran las 3 páginas por ítem del menú Mantenimiento.
    // 74 → 75 / 73 → 74 desde la HU #13588: entra `admin_rendimiento` («Rendimiento») en «Administración».
    // 75 → 76 / 74 → 75 desde la HU #13941: entra `flito_dr_flit` («Dr. Flit») en «General».
    const entradas = PAGE_GROUPS.flatMap((g) => g.pages);
    expect(entradas).toHaveLength(76);
    expect(new Set(entradas).size).toBe(75);
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

  it('las funciones de tipo `pagina` del mundo plano son 73: los 76 slugs de PAGES menos `flito_ayuda`, `admin_rendimiento` y `flito_dr_flit`', () => {
    // HU #13255: +1 (`perfil`). HU #13421: +21 (una por ítem del menú PESV). HU #13422: +3 (Mantenimiento).
    // HU #13588: +1 en PAGES (`admin_rendimiento`), que nace en el árbol (la 0240): no es del mundo plano (≤ 0231).
    // HU #13941: +1 en PAGES (`flito_dr_flit`), que también nace en el árbol (la 0254).
    expect(Object.keys(PAGES)).toHaveLength(76);
    expect(paginas).toHaveLength(73);
    const esperados = Object.keys(PAGES).filter((s) => s !== 'flito_ayuda' && s !== 'admin_rendimiento' && s !== 'flito_dr_flit').sort();
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
    const modulosDeFichero = new Set([...FICHEROS_EN_ALCANCE, ...FICHEROS_LEGADO_EN_ALCANCE].map((f) => f.modulo));
    for (const f of operaciones) {
      const prefijo = f.codigo.slice(0, f.codigo.indexOf('.'));
      expect(modulosDeFichero, f.codigo).toContain(prefijo);
      const reagrupada = AGRUPACION_DE_OPERACION[f.codigo] ?? AGRUPACION_DE_OPERACION_LEGADO[f.codigo];
      if (reagrupada) expect(f.modulo, f.codigo).toBe(reagrupada);
      else expect(f.codigo.startsWith(`${f.modulo}.`), f.codigo).toBe(true);
    }
  });

  it('los códigos de operación tienen la forma <modulo>.<objeto>.<accion>', () => {
    const malFormados = operaciones.filter((f) => !/^[a-z_]+\.[a-z0-9_]+\.[a-z_]+$/.test(f.codigo));
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
    for (const f of [...FICHEROS_EN_ALCANCE, ...FICHEROS_LEGADO_EN_ALCANCE]) {
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

  it('hay exactamente una función por ruta de la foto, y ninguna de sobra (salvo las legacy, que comparten código por ítem)', () => {
    // El aserto que el «46» del enunciado habría dejado pasar: conjuntos, no cardinales.
    expect(new Set(OPERACIONES_DECLARADAS.map((o) => o.llave)))
      .toEqual(new Set(guardas.map(llaveDe)));
    // HU #13421 (ADR-0023): en los ficheros FLITO, una función por ruta; en los legacy, una por
    // código (el transitorio «Administrar <ítem>» cubre varias rutas). Ningún código se repite.
    const legado = new Set(FICHEROS_LEGADO_EN_ALCANCE.map((f) => f.fichero));
    const guardasFlito = guardas.filter((g) => !legado.has(g.fichero));
    const codigosLegado = new Set(guardas.filter((g) => legado.has(g.fichero)).map((g) => codigoDeLlave.get(llaveDe(g))!));
    // HU #12874 — ÚNICA excepción FLITO, nombrada y no genérica: `GET /cliente/companias` reutiliza
    // `soat.solicitud.crear` del alta por decisión del PO (sin función nueva ni migración). El catálogo
    // ya exige igualdad de nombre y reparto entre las dos guardas; aquí se fija que no haya otra.
    const porCodigoFlito = new Map<string, number>();
    for (const g of guardasFlito) {
      const c = codigoDeLlave.get(llaveDe(g))!;
      porCodigoFlito.set(c, (porCodigoFlito.get(c) ?? 0) + 1);
    }
    const compartidosFlito = [...porCodigoFlito].filter(([, n]) => n > 1);
    // HU #13429 (diseño §5-quater.5): los tres `GET …/arbol` reutilizan la guarda de la lectura que suceden (el
    // catálogo, el cuadro del rol y la lectura de las excepciones del usuario), sin función nueva.
    // HU #13628: `PUT /flit1/parametros-lectura` reutiliza `tramites.sincronizacion.configurar` del interruptor
    // (diseño docs/diseno/hu-13628-parametros-lectura-flit1.md: sin función nueva ni siembra).
    // HU #13684: `POST /novedades/buscar` de flito-tramites reutiliza `tramites.cola.ver` del listado (sin función nueva ni siembra).
    // HU #13889 (ADR-0028 §5): el expediente, el historial y la descarga piden la misma `bolsas.documentos.ver`.
    // HU #13893 (ADR-0028 §5 E6): el estado del lote para el chip también pide `bolsas.documentos.ver`.
    // HU #13890 (ADR-0028 §5 E4): la fecha de expedición manual reutiliza `bolsas.documentos.cargar` de la carga.
    // HU #13964 (ADR-0028 adenda E7): retirar la versión vigente también reutiliza `bolsas.documentos.cargar`.
    // HU #13900 (ADR-0029): las rutas por bolsa (`/bolsa/:bolsaId*`, `/compania/:companiaId/estado`) reutilizan los
    // códigos de sus pares del canal Cliente; inactivar y reactivar piden la misma `bolsas.bolsa.inactivar`.
    // HU #13907 (ADR-0029): la rama tránsito del catálogo reutiliza crear, ver y editar de las rutas `/transito…`
    // (que retira la #13911), y también listar, ver movimientos y cargar; inactivar y reactivar piden la misma
    // `bolsas.transito.inactivar`.
    // HU #13836: `POST /buscar` de flito-tramites (Dr. Flit) reutiliza `tramites.cola.ver` del listado (sin función nueva ni siembra).
    // HU #13837: `POST /buscar` de flito-soat (Dr. Flit) reutiliza `soat.cola.ver` de la cola (sin función nueva ni siembra).
    // HU #13838: `POST /buscar` de flito-impuestos y de flito-derechos (Dr. Flit) reutilizan `impuestos.cola.ver` y `derechos.cola.ver`.
    // HU #13958: el impacto y el cambio de estado de un proveedor SOAT piden la misma `parametrizacion.proveedores.estado`
    // (gemelo de `clients.clientes.estado`).
    expect(compartidosFlito.sort()).toEqual([
      ['bolsas.bolsa.inactivar', 2], ['bolsas.bolsa.ver', 3], ['bolsas.cierre.crear', 2], ['bolsas.cierres.ver', 2],
      ['bolsas.documentos.cargar', 3], ['bolsas.documentos.ver', 4],
      ['bolsas.movimientos.ver', 2], ['bolsas.recarga.registrar', 2],
      ['bolsas.transito.cargar', 2], ['bolsas.transito.crear', 2], ['bolsas.transito.editar', 2], ['bolsas.transito.inactivar', 2],
      ['bolsas.transito.listar', 2], ['bolsas.transito.ver', 2], ['bolsas.transito.ver_movimientos', 2],
      ['derechos.cola.ver', 2], ['impuestos.cola.ver', 2], ['parametrizacion.proveedores.estado', 2],
      ['permisos.catalogo.ver', 2], ['permisos.cuadro.ver', 2], ['soat.cola.ver', 2], ['soat.solicitud.crear', 2],
      ['tramites.cola.ver', 3], ['tramites.sincronizacion.configurar', 2], ['usuarios.usuario.listar', 2],
    ]);
    // HU #13427: las de HOY (con las operaciones nuevas que parten una guarda vieja), no las del mundo plano.
    const deHoy = catalogoDeOperaciones();
    expect(deHoy).toHaveLength(porCodigoFlito.size + codigosLegado.size);
    expect(new Set(deHoy.map((f) => f.codigo)).size).toBe(deHoy.length);
    // 25 de la HU #13421 + 13 de la HU #13422 + 42 de la HU #13423 + 11 de la HU #13427 (12 nuevas − el transitorio de Siigo)
    // + 3 de la HU #13428 (3 nuevas de clientes − el transitorio `clients.clientes.administrar` + `perfil.datos.ver`)
    // + 1 de la HU #13945 (`clients.clientes.estado`: impacto y estado del cliente comparten código)
    // + 1 de la HU #13954 (`clients.clientes.eliminar`)
    expect(codigosLegado.size).toBe(96);
  });

  it('HU #13421 — varias guardas con el mismo código exigen IGUALDAD de reparto: una lista distinta revienta (no se une)', () => {
    const g = guardas.filter((x) => codigoDeLlave.get(llaveDe(x)) === 'pesv.comite.administrar');
    expect(g.length).toBeGreaterThan(1);
    const alterada = guardas.map((x) => (x === g[1] ? { ...x, roles: ['admin'] } : x));
    expect(() => catalogoDeOperaciones(alterada)).toThrow(CatalogoIncoherenteError);
    expect(() => catalogoDeOperaciones(alterada)).toThrow(/pesv\.comite\.administrar/);
  });

  it('los roles de cada operación son LITERALMENTE los de su entrada en la foto', () => {
    const porLlave = new Map(guardas.map((g) => [llaveDe(g), g]));
    const declPorLlave = new Map(OPERACIONES_DECLARADAS.map((o) => [o.llave, o]));
    for (const f of operaciones) {
      // Todas las llaves del código (las legacy comparten código): cada una con los mismos roles.
      const llaves = [...declPorLlave.entries()].filter(([, o]) => o.codigo === f.codigo).map(([l]) => l);
      for (const llave of llaves) expect(f.roles, llave).toEqual(porLlave.get(llave)!.roles);
    }
  });

  it('la foto cubre el alcance del Feature —incluido `users/` desde la #12083— y `clients` entra solo como legacy (HU #13422), no en el alcance FLITO', () => {
    expect(FICHEROS_EN_ALCANCE.some((f) => f.fichero.startsWith('clients/'))).toBe(false);
    expect(new Set(guardas.map((g) => g.fichero))).toEqual(new Set([...FICHEROS_EN_ALCANCE, ...FICHEROS_LEGADO_EN_ALCANCE].map((f) => f.fichero)));
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

  it('las veintiocho guardas en línea (tres de la HU #13941: las funciones de Dr. Flit) van con su condición en la llave y no colisionan con la ruta que las contiene (dos son del Bug #12642, cuatro de la HU #13425, una de la HU #13422, ocho de la HU #13423: las acciones de Siigo; dos de la HU #13427: credenciales de Siigo por ambiente; seis de la HU #13428: compañía por grupo de campos, clientes editar y fiscal, contraseña propia)', () => {
    const enLinea = guardas.filter((g) => g.condicion);
    expect(enLinea.map(llaveDe).sort()).toEqual([
      'clients/clients.routes.ts PATCH /:id [editar]',
      'clients/clients.routes.ts POST * [fiscal]',
      'flito-dr-flit/dr-flit.funciones.ts POST * [consultar_gestion]',
      'flito-dr-flit/dr-flit.funciones.ts POST * [radicar_soporte]',
      'flito-dr-flit/dr-flit.funciones.ts POST * [usar_ia]',
      'flito-impuestos/flito-impuestos.routes.ts POST /export [incluirPago]',
      'flito-logistica/flito-logistica.routes.ts POST /actas/:id/entregar [operarAjenas]',
      'flito-parametrizacion/flito-parametrizacion.routes.ts PATCH /companias/:id [autogestion]',
      'flito-parametrizacion/flito-parametrizacion.routes.ts PATCH /companias/:id [general]',
      'flito-parametrizacion/flito-parametrizacion.routes.ts PATCH /companias/:id [sinTramite]',
      'flito-soat/flito-soat.routes.ts POST /export [incluirPago]',
      'jornadas/jornadas.routes.ts POST /abrir [jornadaAjena]',
      'pesv/diagnostico.routes.ts GET /:id [sugerirAuditoria]',
      'pesv/diagnostico.routes.ts GET /:id [vistaAuditoria]',
      'siigo/credenciales.routes.ts POST * [produccion]',
      'siigo/credenciales.routes.ts POST * [pruebas]',
      'siigo/siigo.permisos.ts GET * [consultar]',
      'siigo/siigo.permisos.ts POST * [anular]',
      'siigo/siigo.permisos.ts POST * [corregir]',
      'siigo/siigo.permisos.ts POST * [emitir]',
      'siigo/siigo.permisos.ts POST * [marcar_fallido]',
      'siigo/siigo.permisos.ts POST * [reactivar]',
      'siigo/siigo.permisos.ts POST * [reenviar_correo]',
      'siigo/siigo.permisos.ts POST * [reintentar]',
      'tramites/tramites.routes.ts PATCH /:id [_forzarContinuar]',
      'users/users.routes.ts PATCH /:id/password [ajena]',
      'users/users.routes.ts PATCH /:id/password [propia]',
      'vehicles/vehicles.routes.ts GET / [documentoCompleto]',
    ]);
    expect(codigoDeLlave.get('vehicles/vehicles.routes.ts GET / [documentoCompleto]')).toBe('vehicles.propietario.ver_documento');
    expect(codigoDeLlave.get('flito-soat/flito-soat.routes.ts POST /export')).toBe('soat.excel.exportar');
    expect(codigoDeLlave.get('flito-soat/flito-soat.routes.ts POST /export [incluirPago]')).toBe('soat.excel.exportar_pago');
    expect(codigoDeLlave.get('tramites/tramites.routes.ts PATCH /:id')).toBe('tramite.tramite.editar');
    expect(codigoDeLlave.get('tramites/tramites.routes.ts PATCH /:id [_forzarContinuar]')).toBe('tramite.tramite.forzar_continuar');
    expect(codigoDeLlave.get('flito-logistica/flito-logistica.routes.ts POST /actas/:id/entregar')).toBe('logistica.actas.entregar');
    expect(codigoDeLlave.get('flito-logistica/flito-logistica.routes.ts POST /actas/:id/entregar [operarAjenas]')).toBe('logistica.actas.operar_ajenas');
    expect(codigoDeLlave.get('jornadas/jornadas.routes.ts POST /abrir [jornadaAjena]')).toBe('jornadas.control.administrar');
    expect(codigoDeLlave.get('pesv/diagnostico.routes.ts GET /:id [vistaAuditoria]')).toBe('pesv.diagnostico_consulta.administrar');
    expect(codigoDeLlave.get('pesv/diagnostico.routes.ts GET /:id [sugerirAuditoria]')).toBe('pesv.diagnostico.administrar');
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
    expect(suyas).toHaveLength(73); // HU #13255: +`pagina.perfil` (la 0218 la reparte a admin); HU #13421: +21 PESV; HU #13422: +3 Mantenimiento
  });

  it('`admin` tiene todas las operaciones salvo las tres del canal Cliente, que son de `cliente`, y la que nace sin rol (HU #13269)', () => {
    const suyas = new Set(porRol('admin'));
    const sinAdmin = operaciones.filter((f) => !suyas.has(f.codigo)).map((f) => f.codigo).sort();
    expect(sinAdmin).toEqual([...SIN_ADMIN_EN_EL_REPARTO_DE_PARTIDA].sort());
    // Y no están huérfanas: son del canal Cliente, con `requireRole('cliente')` a secas; salvo el
    // reemplazo del comprobante de pago, que la 0220 siembra sin reparto (AC7 de la HU #13269).
    for (const c of sinAdmin) {
      expect(operaciones.find((f) => f.codigo === c)!.roles).toEqual(c === 'impuestos.recibos.reemplazar' ? [] : ['cliente']);
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

describe('HU #13424 — lo que el reparto de partida no da a `admin` (la 0226 completa todo salvo las tres del canal)', () => {
  it('son las tres del canal Cliente y la del reemplazo (HU #13269), y solo esas', () => {
    // El aserto «toda siembra marca a `admin`» vive en `permisos-siembra-admin.test.ts`.
    expect([...SIN_ADMIN_EN_EL_REPARTO_DE_PARTIDA].sort())
      .toEqual(['impuestos.recibos.reemplazar', 'soat.factura.leer', 'soat.runt.preconsultar', 'soat.solicitud.crear']);
  });

  it('todas existen de verdad en el catálogo', () => {
    const codigos = new Set(catalogo.map((f) => f.codigo));
    for (const c of SIN_ADMIN_EN_EL_REPARTO_DE_PARTIDA) expect(codigos).toContain(c);
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
    // `finanzas` sigue existiendo como módulo de PÁGINAS (gastos diarios, Siigo); las de servicios
    // adicionales se fueron a su pantalla. Desde la HU #13423 las únicas operaciones de `finanzas` son
    // las de Siigo, que se agrupan con sus páginas (`siigo_operacion`, `siigo_parametrizacion`).
    expect(operaciones.filter((f) => f.modulo === 'finanzas' && !f.codigo.startsWith('siigo.'))).toEqual([]);
    for (const m of ['clientes', 'tarifas', 'servicios_adicionales', 'catalogos_compartidos']) expect(modulos).toContain(m);
  });

  it('los 45 códigos que la HU nombra llevan el módulo esperado (AC1, AC2)', () => {
    // La tabla literal de la HU: es la afirmación del PO, no se deriva del mapa. Eran 46: la HU #13631
    // retiró `sync.sync.lanzar` (sincronización manual de FLIT 1, migración 0243).
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
      'sync.sync.ver_estado': 'tramites',
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
    expect(Object.keys(esperado)).toHaveLength(45);
    const porCodigoTodo = new Map(catalogo.map((f) => [f.codigo, f.modulo]));
    expect(porCodigoTodo.has('sync.sync.lanzar'), 'HU #13631: retirada').toBe(false);
    expect(porCodigoTodo.get('tramites.sincronizacion.configurar')).toBe('tramites');
    for (const [codigo, modulo] of Object.entries(esperado)) expect(porCodigoTodo.get(codigo), codigo).toBe(modulo);
  });

  it('`reagrupaciones()` tiene 46 pares ordenados por código (HU #13631: sin `sync.sync.lanzar`); 45 cambian el valor estructural y el de `transito_organismos` es no-op', () => {
    const pares = reagrupaciones();
    expect(pares).toHaveLength(46);
    expect(pares.map(([c]) => c)).toEqual([...pares.map(([c]) => c)].sort((a, b) => a.localeCompare(b)));
    expect(new Set(pares.map(([c]) => c)).size).toBe(46);

    // El módulo ESTRUCTURAL: el grupo de PAGE_GROUPS (primera aparición) para páginas y `g.modulo`
    // de la foto para operaciones. Se calcula sin el mapa, que es la otra cuenta.
    const estructural = new Map<string, string>();
    for (const grupo of PAGE_GROUPS) for (const slug of grupo.pages) {
      if (!estructural.has(`pagina.${slug}`)) estructural.set(`pagina.${slug}`, moduloDeGrupo(grupo.label));
    }
    for (const g of GUARDAS_MEDIDAS) estructural.set(codigoDeLlave.get(llaveDe(g))!, g.modulo);

    const cambian = pares.filter(([codigo, modulo]) => estructural.get(codigo) !== modulo);
    expect(cambian).toHaveLength(45);
    const noOp = pares.filter(([codigo, modulo]) => estructural.get(codigo) === modulo);
    expect(noOp).toEqual([['pagina.transito_organismos', 'transito']]);
  });

  it('una clave del mapa que no exista en el catálogo revienta con CatalogoIncoherenteError (AC3)', () => {
    // El mapa es `Readonly` en tipos, no congelado en runtime: se inyecta y se retira la entrada muerta.
    const mapa = AGRUPACION_DE_OPERACION as Record<string, string>;
    mapa['parametrizacion.tarifas.borrar'] = 'tarifas';
    try {
      expect(() => catalogoPlano()).toThrow(CatalogoIncoherenteError);
      expect(() => catalogoPlano()).toThrow(/Agrupación declarada para un código que no existe: parametrizacion\.tarifas\.borrar/);
    } finally {
      delete mapa['parametrizacion.tarifas.borrar'];
    }
    expect(() => catalogoPlano()).not.toThrow();
  });

  it('la comprobación estructural del prefijo se conserva: una guarda cuyo código no empiece por su módulo de fichero revienta aunque el mapa la reagrupe (AC3)', () => {
    // `sync.sync.ver_estado` se reagrupa a `tramites`; si su guarda dijera módulo `tramites`, el prefijo
    // `sync.` ya no cuadra y tiene que caer ANTES de aplicar el mapa.
    const guardas = GUARDAS_MEDIDAS.map((g) => (g.modulo === 'sync' ? { ...g, modulo: 'tramites' } : g));
    expect(() => catalogoDeOperaciones(guardas)).toThrow(CatalogoIncoherenteError);
    expect(() => catalogoDeOperaciones(guardas)).toThrow(/no empieza por el módulo «tramites»/);
  });
});
