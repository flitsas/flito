// HU #12875 (AC9) — Reporte en seco de la frontera por enlace: núcleo puro (`frontera-en-seco.ts`) sobre
// una lista SINTÉTICA de roles (TC-09a/c) y lectura del script (TC-09b: solo lectura, sin PII).
//
// Mutante que mata: el reporte deja de marcar al rol externo sin enlace (BLOQUEANTE) o al interno con
// compañía (AC7).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fronteraEnSeco, informeFronteraMarkdown, montajesDeAppTs, type MontajeEnSeco, type RolFronteraEnSeco,
} from '../../src/modules/permisos/frontera-en-seco.js';

const aqui = path.dirname(fileURLToPath(import.meta.url));

const MONTAJES: MontajeEnSeco[] = [
  { prefijo: '/api/auth', modulo: null },
  { prefijo: '/api/vehicles', modulo: null },
  { prefijo: '/api/flito/soat', modulo: 'soat' },
  { prefijo: '/api/flito/soat', modulo: 'soat' },
  { prefijo: '/api/flito/impuestos', modulo: null },
  { prefijo: '/api/flito/parametrizacion', modulo: null },
];

const rol = (codigo: string, tipoAntes: string, tipoEnlace: string, usuarios = 1): RolFronteraEnSeco => ({
  codigo, tipoAntes, tipoEnlace, activo: true, usuarios, sinIdDeEnlace: 0,
});

/** La lista sintética de TC-09a. */
const ROLES = [
  rol('cliente', 'externo', 'compania', 3),
  rol('aseguradora_x', 'externo', 'ninguno', 2),
  rol('gestor', 'interno', 'ninguno', 4),
  rol('gestor_impuestos', 'interno', 'organismos_transito', 2),
  rol('contable', 'interno', 'compania', 1),
  rol('gestor_soat', 'interno', 'proveedor_soat', 3), // valor previo a la 0231: el reporte corre ANTES
];

describe('TC-09a — una entrada por rol, con lo que pierde y lo que gana', () => {
  const inf = fronteraEnSeco(ROLES, MONTAJES);
  const de = (c: string) => inf.filas.find((f) => f.codigo === c)!;

  it('BLOQUEANTE: el externo sin enlace (pasaría a verlo todo), y solo él', () => {
    expect(inf.bloqueantes.map((f) => f.codigo)).toEqual(['aseguradora_x']);
    expect(de('aseguradora_x').gana).toEqual(expect.arrayContaining(['/api/vehicles', '/api/flito/impuestos']));
    expect(de('aseguradora_x').gana[0]).toMatch(/SOAT sin acotar/);
  });

  it('AC7: el interno con compañía queda marcado y pierde todo lo que no es SOAT', () => {
    expect(inf.ac7.map((f) => f.codigo)).toEqual(['contable']);
    expect(de('contable').pierde).toEqual(['/api/auth', '/api/flito/impuestos', '/api/flito/parametrizacion', '/api/vehicles']);
    expect(de('contable').gana).toEqual([]);
  });

  it('sin enlace e interno: sin cambios; cliente: gana SOAT entero (antes solo las rutas del canal)', () => {
    expect(de('gestor').pierde).toEqual([]);
    expect(de('gestor').gana).toEqual([]);
    expect(de('cliente').pierde).toEqual([]);
    expect(de('cliente').gana).toHaveLength(1);
    expect(de('cliente').gana[0]).toMatch(/^\/api\/flito\/soat entero/);
  });

  it('el valor previo `proveedor_soat` se lee como `proveedor` (el reporte corre antes de la 0231) y conserva SOAT', () => {
    expect(de('gestor_soat').enlace).toBe('proveedor');
    expect(de('gestor_soat').pierde).not.toContain('/api/flito/soat');
    expect(de('gestor_soat').pierde).toContain('/api/vehicles');
  });

  it('«lo que cada enlace pierde»: lee la tabla VIVA (HU #13426 abrió Impuestos, Derechos, Tránsito y los de compañía)', () => {
    const porEnlace = Object.fromEntries(inf.interinos.map((i) => [i.enlace, i]));
    expect(porEnlace.organismos_transito!.abiertos).toEqual(['impuestos', 'derechos', 'transito']);
    expect(porEnlace.organismos_transito!.cerradosHasta13426).toContain('soat');
    expect(porEnlace.compania!.abiertos).toEqual(['soat', 'impuestos', 'tramites', 'bolsas', 'comprobantes', 'logistica', 'tablero']);
    expect(porEnlace.proveedor!.roles).toEqual(['gestor_soat']);
  });

  it('el markdown nombra las tres secciones y no lleva nada que no sea código de rol o conteo', () => {
    const md = informeFronteraMarkdown(inf, 'prueba');
    expect(md).toMatch(/## 2\. BLOQUEANTE/);
    expect(md).toMatch(/`aseguradora_x` \(2 usuarios\): asignarle enlace ANTES del merge — tiene usuarios/);
    expect(md).toMatch(/## 3\. AC7/);
    expect(md).toMatch(/## 4\. Lo que cada enlace pierde hasta #13426/);
    expect(md).not.toMatch(/@|\b\d{6,}\b/); // ni correos ni documentos
  });
});

describe('TC-09c — ningún rol marcado: sale limpio y lo dice', () => {
  it('sin bloqueantes ni AC7 el reporte lo afirma (no una lista vacía muda)', () => {
    const md = informeFronteraMarkdown(fronteraEnSeco([rol('gestor', 'interno', 'ninguno')], MONTAJES), 'limpio');
    expect(md).toMatch(/BLOQUEANTE[^\n]*\n\nNinguno\. Limpio\./);
    expect(md).toMatch(/Resultado: sin roles marcados/);
  });
});

describe('TC-09b — el script solo LEE y los montajes salen del fuente de app.ts', () => {
  it('la rama `--hu 12875` abre una transacción READ ONLY y no tiene ninguna escritura', () => {
    const src = readFileSync(path.resolve(aqui, '../../src/scripts/permisos-reparto-en-seco.ts'), 'utf8');
    const rama = /async function informeHu12875\(\)[\s\S]*?\n}\n/.exec(src)![0];
    expect(rama).toMatch(/SET TRANSACTION READ ONLY/);
    expect(rama).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(rama).not.toMatch(/\bu\.(id|email|name|username|documento)\b(?! IS NULL)(?!\))/);
    expect(src).toMatch(/const HU_SOPORTADAS = \[[^\]]*'12875'/);
  });

  it('`montajesDeAppTs` lee el app.ts real: los declarados (4 de SOAT + los de #13426), los públicos y los limitadores fuera', () => {
    const fuente = readFileSync(path.resolve(aqui, '../../src/app.ts'), 'utf8');
    const m = montajesDeAppTs(fuente);
    expect(m.filter((x) => x.modulo)).toEqual([
      ...Array(4).fill({ prefijo: '/api/flito/soat', modulo: 'soat' }),
      { prefijo: '/api/flito/impuestos', modulo: 'impuestos' },
      { prefijo: '/api/flito/derechos', modulo: 'derechos' },
      { prefijo: '/api/flito/tramites', modulo: 'tramites' },
      { prefijo: '/api/flito/tablero', modulo: 'tablero' },
      { prefijo: '/api/flito/logistica', modulo: 'logistica' },
      { prefijo: '/api/flito/logistica', modulo: 'logistica' },
      { prefijo: '/api/flito/bolsas', modulo: 'bolsas' },
      { prefijo: '/api/flito/comprobantes', modulo: 'comprobantes' },
      { prefijo: '/api/transito', modulo: 'transito' },
    ]);
    // La configuración de Tránsito, sobre el mismo prefijo, queda SIN declarar (cerrada).
    expect(m.filter((x) => x.prefijo === '/api/transito').map((x) => x.modulo)).toEqual(['transito', null]);
    expect(m.some((x) => x.prefijo === '/api/files' || x.prefijo === '/api/rum')).toBe(false);
    expect(m.some((x) => x.prefijo === '/api/vehicles' && x.modulo === null)).toBe(true);
    expect(m.length).toBeGreaterThan(80);
  });
});
