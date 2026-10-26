// Ayuda FLITO — plantilla, skill y cableado de matriz (HU #11893, AC6 y AC7).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../helpers/fixtures';
import { parsearFicha, fechaFichaLegible } from '../../src/lib/ayudaFicha';
import { CATALOGO_AYUDA } from '../../src/content/ayuda/catalogo';
import { SRC_IMAGEN, parseMarkdown } from '../../src/lib/ayudaMarkdown';

const raiz = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

function leer(rel: string): string {
  return readFileSync(resolve(raiz, rel), 'utf8');
}

test.describe('FLITO — Ayuda · artefactos AC6/AC7', () => {
  test('AC6 — la plantilla trae las seis secciones, tono usted, sin endpoints; imágenes solo con datos demo', () => {
    const plantilla = leer('apps/web/src/content/ayuda/_plantilla.md');
    for (const h of ['## Qué es', '## Para quién', '## Cómo se entra', '## Pasos', '## Estados', '## Qué no hace']) {
      expect(plantilla, h).toContain(h);
    }
    expect(plantilla).toMatch(/\busted\b/i);
    // HU #13707 AC7: ya no prohíbe imágenes; las permite con datos demo y en la carpeta de la ficha.
    expect(plantilla).toMatch(/solo con datos demo/);
    expect(plantilla).toMatch(/sin cédulas, placas, nombres ni teléfonos reales/);
    expect(plantilla).toContain('apps/web/public/ayuda/<clave>/');
    expect(plantilla).not.toMatch(/\/api\//);
    expect(plantilla).not.toMatch(/\b(CREATE TABLE|FROM public\.|pg_)/i);
  });

  test('AC7 — skill flit-ayuda-flito con frontmatter y gate duro', () => {
    const skill = leer('.claude/skills/flit-ayuda-flito/SKILL.md');
    expect(skill).toMatch(/^---\nname: flit-ayuda-flito\n/m);
    expect(skill).toMatch(/^description:/m);
    expect(skill).toMatch(/ficha|ayuda FLITO|docs\/usuario|cambio visible|pre-PR/i);
    expect(skill).toMatch(/gate duro/i);
    expect(skill).toMatch(/no se abre el PR/i);
    expect(skill).toMatch(/BACKEND-only/);
    expect(skill).toMatch(/CHORE/);
    expect(skill.split('\n').length).toBeLessThan(500);
    // HU #13707 AC7: capturas y diagramas permitidos solo con datos demo.
    expect(skill).not.toMatch(/Prohibido: capturas, diagramas como imagen/);
    expect(skill).toMatch(/Capturas y diagramas[^\n]*solo con datos demo/);
    expect(skill).toMatch(/sin cédulas, placas,\s+nombres\s+ni teléfonos reales/);
  });

  test('AC7 — fila nueva en la matriz de AGENTS.md', () => {
    const agents = leer('AGENTS.md');
    expect(agents).toMatch(/flit-ayuda-flito/);
    expect(agents).toMatch(/\| Pre-PR \(ayuda in-app\) \|/);
    expect(agents).toMatch(/\| \*\*Skill\*\* `flit-ayuda-flito` \|/);
    expect(agents).toMatch(/Ficha de ayuda in-app/);
  });

  test('AC7 — mención en el ciclo pre-PR de flit-modo-desarrollo-auto', () => {
    const modo = leer('.claude/skills/flit-modo-desarrollo-auto/SKILL.md');
    expect(modo).toMatch(/flit-ayuda-flito/);
    expect(modo).toMatch(/paso 4b/);
    expect(modo).toMatch(/Skill flit-ayuda-flito/);
  });

  test('HU #11894 AC5 — las fichas de gestión existen en disco (sin Compuerta desde la HU #13431)', () => {
    const gestion = [
      'flito_tramites', 'soat', 'flito_impuestos', 'flito_derechos', 'flito_revisiones',
      'flito_tablero', 'flito_bitacora', 'flito_logistica',
      'flito_logistica_ruta', 'flito_comparendos', 'clients',
    ];
    for (const c of gestion) {
      const md = leer(`apps/web/src/content/ayuda/${c}.md`);
      expect(md.length, c).toBeGreaterThan(0);
      expect(md).toContain('## Qué es');
    }
  });

  test('AC6 — el catálogo lista sus claves y no aliasa credenciales a parametrización', () => {
    const catalogo = leer('apps/web/src/content/ayuda/catalogo.ts');
    const claves = [
      'flito_tramites', 'soat', 'flito_impuestos', 'flito_derechos', 'flito_revisiones',
      'flito_tablero', 'flito_bitacora', 'flito_logistica',
      'flito_logistica_ruta', 'flito_comparendos', 'clients', 'flito_bolsas',
      'flito_conciliacion', 'finanzas_reporte_costos', 'siigo_parametrizacion',
      'siigo_operacion', 'siigo_credenciales',
    ];
    for (const c of claves) {
      expect(catalogo).toContain(`clave: '${c}'`);
    }
    // HU #13431: la Compuerta no es un ítem del menú; su capítulo se retiró.
    expect(catalogo).not.toContain("clave: 'flito_compuerta'");
    expect(catalogo).toMatch(/clave: 'siigo_credenciales', grupo: 'administracion'/);
    // HU #12872: la ficha cuelga de SU slug y enlaza la pantalla real. Nunca alias a parametrización
    // (Financiera la tiene y vería credenciales).
    expect(catalogo).toMatch(/clave: 'siigo_credenciales'[^}]*to: '\/siigo\/credenciales'/);
    expect(catalogo).toMatch(/clave: 'siigo_credenciales'[^}]*permiso: 'siigo_credenciales'/);
    expect(catalogo).not.toMatch(/clave: 'siigo_credenciales'[^}]*permiso: 'siigo_parametrizacion'/);
  });

  // HU #13704 AC4: el +100 de «título igual a la consulta» deja cada ficha primera al buscar su
  // etiqueta. Dos etiquetas iguales (sin tildes ni mayúsculas) romperían esa garantía.
  test('HU #13704 AC4 — claves y etiquetas del catálogo son únicas', () => {
    const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const claves = CATALOGO_AYUDA.map((e) => e.clave);
    const etiquetas = CATALOGO_AYUDA.map((e) => norm(e.etiqueta));
    expect(new Set(claves).size, 'claves únicas').toBe(claves.length);
    expect(new Set(etiquetas).size, 'etiquetas únicas').toBe(etiquetas.length);
  });

  // Feature #13691 · HU #13703 AC4/AC5: encabezado obligatorio y estricto en cada ficha.
  const dirFichas = resolve(raiz, 'apps/web/src/content/ayuda');
  const fichas = readdirSync(dirFichas).filter((f) => f.endsWith('.md') && !f.startsWith('_'));

  test('HU #13703 AC4 — toda ficha trae encabezado válido (resumen, palabras_clave, consultas, version, fecha)', () => {
    expect(fichas.length).toBeGreaterThanOrEqual(22);
    for (const f of fichas) {
      const { encabezado, errores } = parsearFicha(readFileSync(resolve(dirFichas, f), 'utf8'));
      expect(errores, f).toEqual([]);
      expect(encabezado, f).not.toBeNull();
      expect(encabezado!.resumen.length, f).toBeGreaterThan(0);
      expect(encabezado!.palabrasClave.length, f).toBeGreaterThanOrEqual(1);
      expect(encabezado!.consultas.length, f).toBeGreaterThanOrEqual(1);
      expect(encabezado!.version, f).toMatch(/^\d+\.\d+$/);
      // El encabezado no se filtra al cuerpo: nada de `---` ni claves al inicio.
      expect(parsearFicha(readFileSync(resolve(dirFichas, f), 'utf8')).cuerpo, f).not.toMatch(/^---|^resumen:/);
    }
  });

  test('HU #13703 AC4 — el parser es estricto: falta, clave desconocida, versión o fecha inválidas', () => {
    const ok = [
      '---', 'resumen: Uno: con dos puntos, y coma.', 'palabras_clave:', '  - a', 'consultas:', '  - b',
      'version: 1.0', 'fecha: 2026-10-20', '---', '## Qué es', '',
    ].join('\n');
    const p = parsearFicha(ok);
    expect(p.errores).toEqual([]);
    expect(p.encabezado?.resumen).toBe('Uno: con dos puntos, y coma.');
    expect(p.cuerpo).toBe('## Qué es\n');
    expect(fechaFichaLegible('2026-10-20')).toBe('20/10/2026');

    const conCambio = (de: string, a: string) => parsearFicha(ok.replace(de, a)).errores;
    expect(conCambio('version: 1.0', 'version: 1')).not.toEqual([]);
    expect(conCambio('fecha: 2026-10-20', 'fecha: 2026-02-30')).not.toEqual([]);
    expect(conCambio('fecha: 2026-10-20', 'fecha: 20/10/2026')).not.toEqual([]);
    expect(conCambio('resumen: Uno: con dos puntos, y coma.', 'resumen:')).not.toEqual([]);
    expect(conCambio('  - a\n', '')).not.toEqual([]);
    expect(conCambio('  - b\n', '')).not.toEqual([]);
    expect(conCambio('version: 1.0', 'version: 1.0\nautor: x')).toEqual(expect.arrayContaining([expect.stringMatching(/desconocida/)]));
    const sinBloque = parsearFicha('## Qué es\n');
    expect(sinBloque.encabezado).toBeNull();
    expect(sinBloque.cuerpo).toBe('## Qué es\n');
    expect(sinBloque.errores).not.toEqual([]);
  });

  test('HU #13703 AC2/AC3 — resumen de fuente única: con .md no hay resumenPendiente; sin .md es obligatorio', () => {
    for (const e of CATALOGO_AYUDA) {
      const tieneMd = existsSync(resolve(dirFichas, `${e.clave}.md`));
      if (tieneMd) expect(e.resumenPendiente, e.clave).toBeUndefined();
      else expect(e.resumenPendiente?.trim().length ?? 0, e.clave).toBeGreaterThan(0);
    }
  });

  test('HU #13703 AC6 — plantilla y skill documentan el encabezado y que version y fecha suben en cada cambio', () => {
    const plantilla = leer('apps/web/src/content/ayuda/_plantilla.md');
    expect(parsearFicha(plantilla).errores).toEqual([]);
    expect(plantilla).toMatch(/suba la version y ponga la fecha/);
    const skill = leer('.claude/skills/flit-ayuda-flito/SKILL.md');
    for (const clave of ['resumen', 'palabras_clave', 'consultas', 'version', 'fecha']) {
      expect(skill).toContain(`\`${clave}\``);
    }
    expect(skill).toMatch(/se actualizan en cada cambio de la ficha/);
  });

  // HU #13707 AC2/AC7 (diseño slim §6): toda imagen de ficha trae alt, `src` válido, carpeta = clave y
  // archivo en disco. Evita además que el servidor devuelva index.html con 200 y el SW lo cachee.
  test('HU #13707 AC2/AC7 — imágenes de las fichas: alt, src válido, carpeta de la ficha y archivo existente', () => {
    const dirPublico = resolve(raiz, 'apps/web/public/ayuda');
    let total = 0;
    for (const f of fichas) {
      const clave = f.replace(/\.md$/, '');
      const md = readFileSync(resolve(dirFichas, f), 'utf8');
      for (const [, alt, src] of md.matchAll(/!\[([^\]]*)\]\(([^)]*)\)/g)) {
        total += 1;
        const donde = `${f} · imagen ${src}`;
        expect(alt.trim(), `${donde}: falta el texto alternativo`).not.toBe('');
        const m = SRC_IMAGEN.exec(src.trim());
        expect(m, `${donde}: src fuera de ./<clave>/<archivo>.(png|jpg|jpeg|webp|svg)`).not.toBeNull();
        expect(m![1], `${donde}: la carpeta debe ser la clave de la ficha (${clave})`).toBe(clave);
        expect(existsSync(resolve(dirPublico, m![1], m![2])), `${donde}: no existe en public/ayuda/`).toBe(true);
      }
    }
    // Al menos la imagen demo de la HU #13707 (siigo_operacion) está cubierta.
    expect(total).toBeGreaterThanOrEqual(1);
  });
  // HU #13769 AC4 — ficha piloto con una captura por paso clave, todas con alt y en disco (el test de
  // arriba ya valida src/carpeta/archivo) y ≤ 200 KB.
  test('HU #13769 AC4 — flito_logistica_ruta cita sus 5 capturas NN-<paso>.png con alt y ≤ 200 KB', () => {
    const md = leer('apps/web/src/content/ayuda/flito_logistica_ruta.md');
    const imgs = [...md.matchAll(/!\[([^\]]+)\]\(\.\/flito_logistica_ruta\/(\d{2}-[a-z0-9-]+\.png)\)/g)];
    expect(imgs.map((m) => m[2])).toEqual([
      '01-recoger-licencias.png', '02-resultado-validacion.png', '03-confirmar-recogida.png', '04-entregar.png', '05-sin-conexion.png',
    ]);
    for (const [, alt, archivo] of imgs) {
      expect(alt.trim().length, archivo).toBeGreaterThan(10);
      expect(statSync(resolve(raiz, 'apps/web/public/ayuda/flito_logistica_ruta', archivo)).size, archivo).toBeLessThanOrEqual(200 * 1024);
    }
    const { encabezado } = parsearFicha(md);
    expect(encabezado!.version).not.toBe('1.0');
  });

  test('HU #13769 AC5 — la skill exige el delta de capturas regeneradas o un N/A justificado', () => {
    const skill = leer('.claude/skills/flit-ayuda-flito/SKILL.md');
    expect(skill).toContain('npm run capturas:ayuda -w apps/web -- --grep <clave>');
    expect(skill).toMatch(/capturas: N\/A — /);
    expect(skill).toMatch(/Sin delta de\s+capturas ni N\/A justificado → \*\*no se abre el PR\*\*/);
    expect(leer('apps/web/package.json')).toMatch(/"capturas:ayuda": "AYUDA_CAPTURAS=1 playwright test --project=capturas/);
  });

  test('HU #13769 AC6 — la matriz de cobertura lista al menos una ficha existente por cada una de las 5 áreas', () => {
    const matriz = leer('docs/ayuda/matriz-cobertura.md');
    for (const area of ['Corredor SOAT', 'Corredor Impuestos', 'Mensajero y Logística', 'Facturación', 'Super Admin']) {
      // La fila de la matriz (5 columnas), no la de equivalencia área ↔ rol.
      const fila = matriz.split('\n').find((l) => l.startsWith(`| ${area} |`) && l.split('|').length === 6);
      expect(fila, area).toBeTruthy();
      const fichas = fila!.split('|')[2].match(/`([a-z_]+)`/g)!.map((c) => c.slice(1, -1));
      expect(fichas.length, area).toBeGreaterThanOrEqual(1);
      for (const c of fichas) expect(existsSync(resolve(dirFichas, `${c}.md`)), `${area}: ${c}.md`).toBe(true);
    }
  });

  // HU #13770 — manuales del área Facturación: versión y fecha subidas (AC5), una captura por paso clave
  // con alt y ≤ 200 KB, en el orden en que la ficha las cita (AC2), y diagrama SVG con alt donde el
  // proceso tiene más de 3 pasos o decisiones (AC3). Gastos diarios es de solo lectura: sin diagrama.
  const FACTURACION_13770: Record<string, { version: string; fecha: string; capturas: string[]; diagrama: string | null }> = {
    siigo_parametrizacion: { version: '1.1', fecha: '2026-10-21', diagrama: 'camino-a-produccion.svg', capturas: [
      '01-compuerta.png', '02-mapeo-de-conceptos.png', '03-editar-concepto.png', '04-terceros.png', '05-sincronizar-terceros.png'] },
    siigo_operacion: { version: '1.2', fecha: '2026-10-21', diagrama: 'camino-caso-detenido.svg', capturas: [
      '01-bandeja.png', '02-ver-caso.png', '03-reintentar-varios.png'] },
    flito_comprobantes: { version: '1.3', fecha: '2026-10-24', diagrama: 'camino-comprobante.svg', capturas: [
      '01-cargar.png', '02-cola.png', '03-asociar.png'] },
    flito_conciliacion: { version: '1.2', fecha: '2026-10-25', diagrama: 'ciclo-boleta.svg', capturas: [
      '01-cargar-boleta.png', '02-bandeja.png', '03-detalle-sin-cuadrar.png', '04-conciliar.png', '05-comprobante-pse.png'] },
    // HU #13901: alta manual de la bolsa, conceptos y autogestión, inactivar y reactivar.
    // HU #13892: paso 7 «Documentos» (v1.3); botón de descargar a la altura del kit en la 05 (v1.5).
    // HU #13908: tránsito en el catálogo único: filtro Alcance, tabla de tránsitos, alta y detalle (v1.6).
    // HU #13964: «Quitar» la versión vigente y el estado «retirada» del historial (v1.8).
    flito_bolsas: { version: '1.8', fecha: '2026-10-26', diagrama: 'ciclo-periodo.svg', capturas: [
      '01-cabecera-y-kpi.png', '02-companias.png', '03-crear-bolsa.png', '04-detalle-compania.png', '05-documentos.png'] },
    flito_tarifas: { version: '1.2', fecha: '2026-10-25', diagrama: 'vigencias.svg', capturas: [
      '01-elegir-compania.png', '02-fijar-valor.png', '03-historial.png'] },
    // Citadas en el orden de los pasos de la ficha (la 01 ilustra el paso 5, «Por tarifar»).
    flito_servicios_adicionales: { version: '1.1', fecha: '2026-10-21', diagrama: 'ciclo-tipo.svg', capturas: [
      '02-editar.png', '03-nuevo-tipo.png', '04-dados-de-baja.png', '01-catalogo.png'] },
    finanzas_reporte_costos: { version: '1.1', fecha: '2026-10-21', diagrama: 'tres-verbos.svg', capturas: [
      '01-filtros-y-periodo.png', '02-tabla.png', '03-acciones-de-fila.png', '04-consolidado.png'] },
    finanzas_gastos_diarios: { version: '1.2', fecha: '2026-10-22', diagrama: null, capturas: [
      '01-tarjetas-y-total.png', '02-evolucion-diaria.png'] },
  };

  for (const [clave, esperado] of Object.entries(FACTURACION_13770)) {
    test(`HU #13770 — ${clave}: versión ${esperado.version} del ${esperado.fecha}, capturas y diagrama con alt`, () => {
      const md = leer(`apps/web/src/content/ayuda/${clave}.md`);
      const { encabezado, errores } = parsearFicha(md);
      expect(errores, clave).toEqual([]);
      // AC5 — la ficha cambió: sube la versión menor y la fecha.
      expect(encabezado!.version, `${clave} · version`).toBe(esperado.version);
      expect(String(encabezado!.fecha), `${clave} · fecha`).toBe(esperado.fecha);

      // AC2 — lista exacta de capturas NN-<paso>.png, con alt, en disco y ≤ 200 KB.
      const dir = resolve(raiz, 'apps/web/public/ayuda', clave);
      const capturas = [...md.matchAll(new RegExp(`!\\[([^\\]]*)\\]\\(\\./${clave}/(\\d{2}-[a-z0-9-]+\\.png)\\)`, 'g'))];
      expect(capturas.map((m) => m[2]), `${clave} · capturas`).toEqual(esperado.capturas);
      for (const [, alt, archivo] of capturas) {
        expect(alt.trim().length, `${clave}/${archivo} · alt`).toBeGreaterThan(10);
        const ruta = resolve(dir, archivo);
        expect(existsSync(ruta), `${clave}/${archivo} en disco`).toBe(true);
        expect(statSync(ruta).size, `${clave}/${archivo} ≤ 200 KB`).toBeLessThanOrEqual(200 * 1024);
        // AC2 — pasos numerados: la captura va al final de su paso; en un párrafo aparte, la lista reinicia en «1.».
        const linea = md.split('\n').find((l) => l.includes(`(./${clave}/${archivo})`));
        expect(linea, `${clave}/${archivo} · dentro de su paso`).toMatch(/^\d+\. /);
      }

      // AC2 — la sección Pasos es UNA sola lista ordenada (el renderizador reinicia la numeración en cada <ol>).
      // En flito_comprobantes el segundo procedimiento vive en su propio h2 («Asociar y aplicar»), fuera de Pasos.
      const pasos = md.slice(md.indexOf('## Pasos')).split(/\n(?=## )/)[0];
      const listas = parseMarkdown(pasos).filter((b) => b.type === 'ol');
      expect(listas.length, `${clave} · listas ordenadas en Pasos`).toBe(1);

      // AC3 — diagrama SVG estático con alt (o ninguno, si la ficha no describe un proceso).
      const diagramas = [...md.matchAll(new RegExp(`!\\[([^\\]]*)\\]\\(\\./${clave}/([a-z0-9-]+\\.svg)\\)`, 'g'))];
      expect(diagramas.map((m) => m[2]), `${clave} · diagramas`).toEqual(esperado.diagrama ? [esperado.diagrama] : []);
      for (const [, alt, archivo] of diagramas) {
        expect(alt.trim().length, `${clave}/${archivo} · alt`).toBeGreaterThan(10);
        expect(existsSync(resolve(dir, archivo)), `${clave}/${archivo} en disco`).toBe(true);
      }
    });
  }

  // HU #13771 — manuales del área Corredor SOAT: misma comprobación que el bloque de Facturación (versión y fecha
  // exactas, capturas citadas en orden con alt y ≤ 200 KB, diagrama SVG con alt o ninguno). Tablero y Bitácora
  // son de solo lectura y de tres pasos o menos: sin diagrama.
  const SOAT_13771: Record<string, { version: string; capturas: string[]; diagrama: string | null; fecha?: string }> = {
    // HU #13968: SOAT sin trámite por proveedor (soat y clients cambiaron de nuevo).
    soat: { version: '1.3', fecha: '2026-10-25', diagrama: 'ciclo-soat.svg', capturas: [
      '01-cola.png', '02-enviar-al-gestor.png', '03-detalle.png', '04-solicitar-soat.png'] },
    flito_tramites: { version: '1.2', diagrama: 'camino-a-entregar.svg', capturas: [
      '01-sincronizacion.png', '02-filtros-y-tabla.png', '03-seleccion.png', '04-documentos-del-zip.png'] },
    flito_revisiones: { version: '1.2', diagrama: 'resolver-o-descartar.svg', capturas: [
      '01-cola-y-documento.png', '02-revisar-campos.png', '03-constancia.png'] },
    flito_bitacora: { version: '1.2', diagrama: null, capturas: ['01-movimientos.png'] },
    flito_comparendos: { version: '1.2', diagrama: 'ciclo-monitoreo.svg', capturas: [
      '01-registros.png', '02-detalle.png', '03-sincronizacion.png', '04-configuracion.png'] },
    // HU #13935: la ficha de Clientes cambió después (checks «FLITO gestiona»); HU #13948: Estado y filtro;
    // HU #13949: menú ⋮ para desactivar y activar (capturas sin cambio: el ⋮ queda fuera del encuadre).
    // HU #13955: NIT duplicado bajo el campo y campo Sucursal en el alta (capturas sin cambio: el
    // formulario de alta y la ficha fiscal no salen en ninguna).
    // HU #13961: Proveedores con Estado, filtro y ⋮ para desactivar y activar (03-proveedores regenerada).
    clients: { version: '2.0', fecha: '2026-10-25', diagrama: 'canal-soat-sin-tramite.svg', capturas: [
      '01-clientes.png', '02-soat-sin-tramite.png', '03-proveedores.png'] },
    flito_tablero: { version: '1.2', diagrama: null, capturas: ['01-indicadores-y-alertas.png', '02-por-estado.png'] },
  };

  for (const [clave, esperado] of Object.entries(SOAT_13771)) {
    test(`HU #13771 — ${clave}: versión ${esperado.version} del ${esperado.fecha ?? '2026-10-22'}, capturas y diagrama con alt`, () => {
      const md = leer(`apps/web/src/content/ayuda/${clave}.md`);
      const { encabezado, errores } = parsearFicha(md);
      expect(errores, clave).toEqual([]);
      // AC5 — la ficha cambió: sube la versión menor y la fecha.
      expect(encabezado!.version, `${clave} · version`).toBe(esperado.version);
      expect(String(encabezado!.fecha), `${clave} · fecha`).toBe(esperado.fecha ?? '2026-10-22');
      // AC4 — sin rutas de API ni rutas de la app en el texto.
      expect(md, `${clave} · sin rutas`).not.toMatch(/`\/|\/api\//);

      // AC2 — lista exacta de capturas NN-<paso>.png, con alt, en disco y ≤ 200 KB.
      const dir = resolve(raiz, 'apps/web/public/ayuda', clave);
      const capturas = [...md.matchAll(new RegExp(`!\\[([^\\]]*)\\]\\(\\./${clave}/(\\d{2}-[a-z0-9-]+\\.png)\\)`, 'g'))];
      expect(capturas.map((m) => m[2]), `${clave} · capturas`).toEqual(esperado.capturas);
      for (const [, alt, archivo] of capturas) {
        expect(alt.trim().length, `${clave}/${archivo} · alt`).toBeGreaterThan(10);
        const ruta = resolve(dir, archivo);
        expect(existsSync(ruta), `${clave}/${archivo} en disco`).toBe(true);
        expect(statSync(ruta).size, `${clave}/${archivo} ≤ 200 KB`).toBeLessThanOrEqual(200 * 1024);
        // AC2 — pasos numerados: la captura va al final de su paso; en un párrafo aparte, la lista reinicia en «1.».
        const linea = md.split('\n').find((l) => l.includes(`(./${clave}/${archivo})`));
        expect(linea, `${clave}/${archivo} · dentro de su paso`).toMatch(/^\d+\. /);
      }

      // AC2 — la sección Pasos es UNA sola lista ordenada (el renderizador reinicia la numeración en cada <ol>).
      const pasos = md.slice(md.indexOf('## Pasos')).split(/\n(?=## )/)[0];
      const listas = parseMarkdown(pasos).filter((b) => b.type === 'ol');
      expect(listas.length, `${clave} · listas ordenadas en Pasos`).toBe(1);

      // AC3 — diagrama SVG estático con alt (o ninguno, si la ficha no describe un proceso).
      const diagramas = [...md.matchAll(new RegExp(`!\\[([^\\]]*)\\]\\(\\./${clave}/([a-z0-9-]+\\.svg)\\)`, 'g'))];
      expect(diagramas.map((m) => m[2]), `${clave} · diagramas`).toEqual(esperado.diagrama ? [esperado.diagrama] : []);
      for (const [, alt, archivo] of diagramas) {
        expect(alt.trim().length, `${clave}/${archivo} · alt`).toBeGreaterThan(10);
        expect(existsSync(resolve(dir, archivo)), `${clave}/${archivo} en disco`).toBe(true);
      }
    });
  }

  // HU #13772 — manuales del área Corredor Impuestos: misma comprobación que los bloques de Facturación y Corredor
  // SOAT (versión y fecha exactas, sin rutas, capturas citadas en orden con alt y ≤ 200 KB, diagrama SVG con alt).
  // Las dos fichas describen procesos de más de 3 pasos o con decisiones: las dos llevan diagrama.
  const IMPUESTOS_13772: Record<string, { version: string; capturas: string[]; diagrama: string | null }> = {
    flito_impuestos: { version: '1.2', diagrama: 'ciclo-impuesto.svg', capturas: [
      '01-cola.png', '02-seleccion.png', '03-carga-masiva.png', '04-validacion-runt.png', '05-detalle.png'] },
    flito_derechos: { version: '1.1', diagrama: 'canastas-de-carga.svg', capturas: [
      '01-resultado-de-la-carga.png', '02-drive.png', '03-registrados.png'] },
  };

  for (const [clave, esperado] of Object.entries(IMPUESTOS_13772)) {
    test(`HU #13772 — ${clave}: versión ${esperado.version} del 2026-10-22, capturas y diagrama con alt`, () => {
      const md = leer(`apps/web/src/content/ayuda/${clave}.md`);
      const { encabezado, errores } = parsearFicha(md);
      expect(errores, clave).toEqual([]);
      // AC5 — la ficha cambió: sube la versión menor y la fecha.
      expect(encabezado!.version, `${clave} · version`).toBe(esperado.version);
      expect(String(encabezado!.fecha), `${clave} · fecha`).toBe('2026-10-22');
      // AC4 — sin rutas de API ni rutas de la app en el texto.
      expect(md, `${clave} · sin rutas`).not.toMatch(/`\/|\/api\/|\/flito\//);

      // AC2 — lista exacta de capturas NN-<paso>.png, con alt, en disco y ≤ 200 KB.
      const dir = resolve(raiz, 'apps/web/public/ayuda', clave);
      const capturas = [...md.matchAll(new RegExp(`!\\[([^\\]]*)\\]\\(\\./${clave}/(\\d{2}-[a-z0-9-]+\\.png)\\)`, 'g'))];
      expect(capturas.map((m) => m[2]), `${clave} · capturas`).toEqual(esperado.capturas);
      for (const [, alt, archivo] of capturas) {
        expect(alt.trim().length, `${clave}/${archivo} · alt`).toBeGreaterThan(10);
        const ruta = resolve(dir, archivo);
        expect(existsSync(ruta), `${clave}/${archivo} en disco`).toBe(true);
        expect(statSync(ruta).size, `${clave}/${archivo} ≤ 200 KB`).toBeLessThanOrEqual(200 * 1024);
        // AC2 — pasos numerados: la captura va al final de su paso; en un párrafo aparte, la lista reinicia en «1.».
        const linea = md.split('\n').find((l) => l.includes(`(./${clave}/${archivo})`));
        expect(linea, `${clave}/${archivo} · dentro de su paso`).toMatch(/^\d+\. /);
      }

      // AC3 — diagrama SVG estático con alt (o ninguno, si la ficha no describe un proceso).
      const diagramas = [...md.matchAll(new RegExp(`!\\[([^\\]]*)\\]\\(\\./${clave}/([a-z0-9-]+\\.svg)\\)`, 'g'))];
      expect(diagramas.map((m) => m[2]), `${clave} · diagramas`).toEqual(esperado.diagrama ? [esperado.diagrama] : []);
      for (const [, alt, archivo] of diagramas) {
        expect(alt.trim().length, `${clave}/${archivo} · alt`).toBeGreaterThan(10);
        expect(existsSync(resolve(dir, archivo)), `${clave}/${archivo} en disco`).toBe(true);
      }
    });
  }

  // HU #13773 — manuales del área Mensajero y Logística: misma comprobación que Facturación, Corredor SOAT y
  // Corredor Impuestos (versión y fecha exactas, sin rutas, capturas citadas en orden y dentro de su paso, una
  // sola lista ordenada en Pasos, diagrama SVG con alt). Las dos fichas describen procesos de más de 3 pasos.
  // flito_logistica_ruta conserva sus 5 capturas de la piloto (HU #13769): el texto cambió, la pantalla no.
  const LOGISTICA_13773: Record<string, { version: string; capturas: string[]; diagrama: string | null }> = {
    flito_logistica: { version: '1.1', diagrama: 'ciclo-licencia.svg', capturas: [
      '01-tramites.png', '02-detalle.png', '03-registrar-viaje.png', '04-generacion-de-actas.png', '05-actas.png',
      '06-firmar-y-despachar.png'] },
    flito_logistica_ruta: { version: '1.2', diagrama: 'recorrido-mensajero.svg', capturas: [
      '01-recoger-licencias.png', '02-resultado-validacion.png', '03-confirmar-recogida.png', '04-entregar.png',
      '05-sin-conexion.png'] },
  };

  for (const [clave, esperado] of Object.entries(LOGISTICA_13773)) {
    test(`HU #13773 — ${clave}: versión ${esperado.version} del 2026-10-22, capturas y diagrama con alt`, () => {
      const md = leer(`apps/web/src/content/ayuda/${clave}.md`);
      const { encabezado, errores } = parsearFicha(md);
      expect(errores, clave).toEqual([]);
      // AC5 — la ficha cambió: sube la versión menor y la fecha.
      expect(encabezado!.version, `${clave} · version`).toBe(esperado.version);
      expect(String(encabezado!.fecha), `${clave} · fecha`).toBe('2026-10-22');
      // AC4 — sin rutas de API ni rutas de la app en el texto.
      expect(md, `${clave} · sin rutas`).not.toMatch(/`\/|\/api\/|\/flito\//);

      // AC2 — lista exacta de capturas NN-<paso>.png, con alt, en disco y ≤ 200 KB.
      const dir = resolve(raiz, 'apps/web/public/ayuda', clave);
      const capturas = [...md.matchAll(new RegExp(`!\\[([^\\]]*)\\]\\(\\./${clave}/(\\d{2}-[a-z0-9-]+\\.png)\\)`, 'g'))];
      expect(capturas.map((m) => m[2]), `${clave} · capturas`).toEqual(esperado.capturas);
      for (const [, alt, archivo] of capturas) {
        expect(alt.trim().length, `${clave}/${archivo} · alt`).toBeGreaterThan(10);
        const ruta = resolve(dir, archivo);
        expect(existsSync(ruta), `${clave}/${archivo} en disco`).toBe(true);
        expect(statSync(ruta).size, `${clave}/${archivo} ≤ 200 KB`).toBeLessThanOrEqual(200 * 1024);
        // AC2 — pasos numerados: la captura va al final de su paso; en un párrafo aparte, la lista reinicia en «1.».
        const linea = md.split('\n').find((l) => l.includes(`(./${clave}/${archivo})`));
        expect(linea, `${clave}/${archivo} · dentro de su paso`).toMatch(/^\d+\. /);
      }

      // AC2 — la sección Pasos es UNA sola lista ordenada (el renderizador reinicia la numeración en cada <ol>).
      const pasos = md.slice(md.indexOf('## Pasos')).split(/\n(?=## )/)[0];
      const listas = parseMarkdown(pasos).filter((b) => b.type === 'ol');
      expect(listas.length, `${clave} · listas ordenadas en Pasos`).toBe(1);

      // AC3 — diagrama SVG estático con alt (o ninguno, si la ficha no describe un proceso).
      const diagramas = [...md.matchAll(new RegExp(`!\\[([^\\]]*)\\]\\(\\./${clave}/([a-z0-9-]+\\.svg)\\)`, 'g'))];
      expect(diagramas.map((m) => m[2]), `${clave} · diagramas`).toEqual(esperado.diagrama ? [esperado.diagrama] : []);
      for (const [, alt, archivo] of diagramas) {
        expect(alt.trim().length, `${clave}/${archivo} · alt`).toBeGreaterThan(10);
        expect(existsSync(resolve(dir, archivo)), `${clave}/${archivo} en disco`).toBe(true);
      }
    });
  }

  // HU #13774 — manuales del área Super Admin: misma comprobación que LOGISTICA_13773. Las 4 fichas nuevas nacen en
  // 1.0; Roles y permisos e Integración con Siigo suben a 1.1 (Roles tenía 3 listas ordenadas en Pasos). Log de
  // accesos PII describe una consulta de 3 pasos: sin diagrama. Privacidad no tiene captura del diálogo de
  // anonimización ni de su resultado (AC4).
  // HU #13951: Roles y permisos sube a 1.2 (funciones exclusivas del Administrador); sus capturas no cambian.
  const ADMIN_13774: Record<string, { version: string; fecha?: string; capturas: string[]; diagrama: string | null }> = {
    privacy_log_pii: { version: '1.0', diagrama: null, capturas: ['01-resumen.png', '02-filtros.png'] },
    users: { version: '1.1', fecha: '2026-10-25', diagrama: 'ciclo-usuario.svg', capturas: ['01-usuarios.png', '02-nuevo-usuario.png', '03-historial.png'] },
    roles_permisos: { version: '1.2', fecha: '2026-10-25', diagrama: 'reparto-de-permisos.svg', capturas: [
      '01-roles.png', '02-arbol.png', '03-sin-guardar.png', '04-nuevo-rol.png'] },
    drive: { version: '1.0', diagrama: 'procesar-cuentas.svg', capturas: ['01-carpeta-raiz.png', '02-carpeta.png', '03-resultado.png'] },
    privacy: { version: '1.0', diagrama: 'derecho-al-olvido.svg', capturas: ['01-documento.png', '02-registros-afectados.png'] },
    siigo_credenciales: { version: '1.1', diagrama: 'ciclo-credencial.svg', capturas: [
      '01-ambientes.png', '02-registrar.png', '03-probar-conexion.png', '04-historial.png'] },
  };

  for (const [clave, esperado] of Object.entries(ADMIN_13774)) {
    test(`HU #13774 — ${clave}: versión ${esperado.version} del ${esperado.fecha ?? '2026-10-22'}, capturas y diagrama con alt`, () => {
      const md = leer(`apps/web/src/content/ayuda/${clave}.md`);
      const { encabezado, errores } = parsearFicha(md);
      expect(errores, clave).toEqual([]);
      // AC5 — la ficha cambió: sube la versión menor y la fecha.
      expect(encabezado!.version, `${clave} · version`).toBe(esperado.version);
      expect(String(encabezado!.fecha), `${clave} · fecha`).toBe(esperado.fecha ?? '2026-10-22');
      // AC4 — sin rutas de API ni rutas de la app en el texto.
      expect(md, `${clave} · sin rutas`).not.toMatch(/`\/|\/api\/|\/flito\//);

      // AC2 — lista exacta de capturas NN-<paso>.png, con alt, en disco y ≤ 200 KB.
      const dir = resolve(raiz, 'apps/web/public/ayuda', clave);
      const capturas = [...md.matchAll(new RegExp(`!\\[([^\\]]*)\\]\\(\\./${clave}/(\\d{2}-[a-z0-9-]+\\.png)\\)`, 'g'))];
      expect(capturas.map((m) => m[2]), `${clave} · capturas`).toEqual(esperado.capturas);
      for (const [, alt, archivo] of capturas) {
        expect(alt.trim().length, `${clave}/${archivo} · alt`).toBeGreaterThan(10);
        const ruta = resolve(dir, archivo);
        expect(existsSync(ruta), `${clave}/${archivo} en disco`).toBe(true);
        expect(statSync(ruta).size, `${clave}/${archivo} ≤ 200 KB`).toBeLessThanOrEqual(200 * 1024);
        // AC2 — pasos numerados: la captura va al final de su paso; en un párrafo aparte, la lista reinicia en «1.».
        const linea = md.split('\n').find((l) => l.includes(`(./${clave}/${archivo})`));
        expect(linea, `${clave}/${archivo} · dentro de su paso`).toMatch(/^\d+\. /);
      }

      // AC2 — la sección Pasos es UNA sola lista ordenada (el renderizador reinicia la numeración en cada <ol>).
      const pasos = md.slice(md.indexOf('## Pasos')).split(/\n(?=## )/)[0];
      const listas = parseMarkdown(pasos).filter((b) => b.type === 'ol');
      expect(listas.length, `${clave} · listas ordenadas en Pasos`).toBe(1);

      // AC3 — diagrama SVG estático con alt (o ninguno, si la ficha no describe un proceso).
      const diagramas = [...md.matchAll(new RegExp(`!\\[([^\\]]*)\\]\\(\\./${clave}/([a-z0-9-]+\\.svg)\\)`, 'g'))];
      expect(diagramas.map((m) => m[2]), `${clave} · diagramas`).toEqual(esperado.diagrama ? [esperado.diagrama] : []);
      for (const [, alt, archivo] of diagramas) {
        expect(alt.trim().length, `${clave}/${archivo} · alt`).toBeGreaterThan(10);
        expect(existsSync(resolve(dir, archivo)), `${clave}/${archivo} en disco`).toBe(true);
      }
    });
  }

  // HU #13775 — Tablero de control (General) y Organismos de tránsito (grupo Tránsito): misma comprobación que
  // ADMIN_13774. Las dos nacen en 1.0. «Sin rutas» admite solo el enlace interno a otra ficha de la Ayuda
  // (`/flito/ayuda/<clave>`), que es el aviso de AC2 en «Cómo se entra» del Tablero de control.
  const TRANSITO_13775: Record<string, { version: string; capturas: string[]; diagrama: string | null }> = {
    dashboard: { version: '1.0', diagrama: 'que-ve-al-entrar.svg', capturas: ['01-estado-operativo.png', '02-atencion-y-atajos.png'] },
    transito_organismos: { version: '1.0', diagrama: 'cambio-de-modalidad.svg', capturas: [
      '01-organismos.png', '02-general.png', '03-autogestion.png', '04-plantilla.png'] },
  };

  for (const [clave, esperado] of Object.entries(TRANSITO_13775)) {
    test(`HU #13775 — ${clave}: versión ${esperado.version} del 2026-10-22, capturas y diagrama con alt`, () => {
      const md = leer(`apps/web/src/content/ayuda/${clave}.md`);
      const { encabezado, errores } = parsearFicha(md);
      expect(errores, clave).toEqual([]);
      expect(encabezado!.version, `${clave} · version`).toBe(esperado.version);
      expect(String(encabezado!.fecha), `${clave} · fecha`).toBe('2026-10-22');
      // AC4 — sin rutas de API ni rutas de la app en el texto (salvo el enlace interno a otra ficha).
      const sinEnlacesAyuda = md.replace(/\]\(\/flito\/ayuda\/[a-z_]+(#[a-z0-9-]+)?\)/g, ']()');
      expect(sinEnlacesAyuda, `${clave} · sin rutas`).not.toMatch(/`\/|\/api\/|\/flito\//);

      const dir = resolve(raiz, 'apps/web/public/ayuda', clave);
      const capturas = [...md.matchAll(new RegExp(`!\\[([^\\]]*)\\]\\(\\./${clave}/(\\d{2}-[a-z0-9-]+\\.png)\\)`, 'g'))];
      expect(capturas.map((m) => m[2]), `${clave} · capturas`).toEqual(esperado.capturas);
      for (const [, alt, archivo] of capturas) {
        expect(alt.trim().length, `${clave}/${archivo} · alt`).toBeGreaterThan(10);
        const ruta = resolve(dir, archivo);
        expect(existsSync(ruta), `${clave}/${archivo} en disco`).toBe(true);
        expect(statSync(ruta).size, `${clave}/${archivo} ≤ 200 KB`).toBeLessThanOrEqual(200 * 1024);
        const linea = md.split('\n').find((l) => l.includes(`(./${clave}/${archivo})`));
        expect(linea, `${clave}/${archivo} · dentro de su paso`).toMatch(/^\d+\. /);
      }

      const pasos = md.slice(md.indexOf('## Pasos')).split(/\n(?=## )/)[0];
      const listas = parseMarkdown(pasos).filter((b) => b.type === 'ol');
      expect(listas.length, `${clave} · listas ordenadas en Pasos`).toBe(1);

      const diagramas = [...md.matchAll(new RegExp(`!\\[([^\\]]*)\\]\\(\\./${clave}/([a-z0-9-]+\\.svg)\\)`, 'g'))];
      expect(diagramas.map((m) => m[2]), `${clave} · diagramas`).toEqual(esperado.diagrama ? [esperado.diagrama] : []);
      for (const [, alt, archivo] of diagramas) {
        expect(alt.trim().length, `${clave}/${archivo} · alt`).toBeGreaterThan(10);
        expect(existsSync(resolve(dir, archivo)), `${clave}/${archivo} en disco`).toBe(true);
      }
    });
  }
});
