// HU #11293 — catálogo de países, departamentos y ciudades de Siigo (Feature #11241).
//
// Lo que estas pruebas cuidan por encima de todo es el ARCHIVO REAL del repo: es el único artefacto
// de esta historia que nadie escribió a mano y del que depende que una factura lleve un código de
// ciudad que Siigo reconozca. Si la conversión del .xlsx se trunca o cambia de forma, tiene que
// fallar aquí y no en producción.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, insert: insertMock, update: updateMock,
    delete: vi.fn(), transaction: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const RUTA_REAL = path.resolve(process.cwd(), 'src/db/data/siigo-ciudades.json');

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
});

/** Escribe un catálogo temporal para probar la carga sin tocar el del repo. */
function catalogoTemporal(contenido: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ciudades-'));
  const ruta = path.join(dir, 'siigo-ciudades.json');
  writeFileSync(ruta, typeof contenido === 'string' ? contenido : JSON.stringify(contenido), 'utf8');
  return ruta;
}

describe('el archivo del repositorio (AC1, AC5)', () => {
  const datos = JSON.parse(readFileSync(RUTA_REAL, 'utf8'));

  it('declara de dónde salió y con qué fecha', () => {
    // AC5: el listado se publica como archivo externo. Sin esto, dentro de un año nadie sabe si el
    // catálogo está al día ni contra qué compararlo.
    expect(datos.origen).toMatch(/^https:\/\/.*Lista-de-ciudades\.xlsx$/);
    expect(datos.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(datos.descargadoEn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(datos.sha256Origen).toMatch(/^[a-f0-9]{64}$/);
  });

  it('el total declarado cuadra con las ciudades que trae', () => {
    // Cargar medio catálogo es PEOR que no cargar nada: marcaría como inactivas ciudades reales.
    expect(datos.ciudades).toHaveLength(datos.total);
  });

  it('ninguna ciudad viene sin sus tres códigos', () => {
    const incompletas = datos.ciudades.filter(
      (c: Record<string, string>) => !c.countryCode || !c.stateCode || !c.cityCode || !c.cityName,
    );
    expect(incompletas).toEqual([]);
  });

  it('la terna país + departamento + ciudad no se repite', () => {
    // Es la clave del upsert. Un duplicado aquí haría fallar la carga entera en Postgres.
    const ternas = datos.ciudades.map((c: Record<string, string>) =>
      `${c.countryCode}|${c.stateCode}|${c.cityCode}`);
    expect(new Set(ternas).size).toBe(ternas.length);
  });

  it('el código de ciudad SÍ se repite entre países: por eso la clave es la terna', () => {
    // 05001 es Medellín en Colombia y Chachapollas en Perú. Un único sobre `city_code` habría
    // perdido una de las dos, y esta prueba existe para que nadie lo "simplifique" así.
    const porCodigo = datos.ciudades.filter((c: Record<string, string>) => c.cityCode === '05001');
    expect(porCodigo.length).toBeGreaterThan(1);
  });

  it('trae las ciudades documentadas con el código que dice la documentación', () => {
    const bogota = datos.ciudades.find((c: Record<string, string>) => c.cityCode === '11001' && c.countryCode === 'Co');
    expect(bogota).toMatchObject({ stateCode: '11', cityName: 'Bogotá' });
  });

  it('el código de país viene como lo publica Siigo: «Co», no «CO»', () => {
    // La tabla de ejemplo de siigo-api.md lo escribe en mayúsculas y el archivo oficial no. Se
    // guarda tal cual porque es lo que hay que enviarle de vuelta a Siigo.
    const colombianas = datos.ciudades.filter((c: Record<string, string>) => c.countryName === 'Colombia');
    expect(colombianas.length).toBeGreaterThan(1000);
    expect(new Set(colombianas.map((c: Record<string, string>) => c.countryCode))).toEqual(new Set(['Co']));
  });

  it('los nombres conservan las tildes', () => {
    const medellin = datos.ciudades.find((c: Record<string, string>) => c.cityCode === '05001' && c.countryCode === 'Co');
    expect(medellin.cityName).toBe('Medellín');
  });

  it('los códigos caben en las columnas de la tabla', () => {
    for (const c of datos.ciudades as Record<string, string>[]) {
      expect(c.countryCode.length).toBeLessThanOrEqual(2);
      expect(c.stateCode.length).toBeLessThanOrEqual(5);
      expect(c.cityCode.length).toBeLessThanOrEqual(10);
      expect(c.cityName.length).toBeLessThanOrEqual(80);
      expect(c.stateName.length).toBeLessThanOrEqual(80);
      expect(c.countryName.length).toBeLessThanOrEqual(80);
    }
  });
});

describe('normalizarNombre (AC2)', () => {
  it('quita tildes y baja a minúsculas', async () => {
    const { normalizarNombre } = await import('../../src/modules/siigo/siigo.ciudades.service.js');
    expect(normalizarNombre('Medellín')).toBe('medellin');
    expect(normalizarNombre('BOGOTÁ')).toBe('bogota');
    expect(normalizarNombre('  Chocó  ')).toBe('choco');
  });

  it('pliega también la ñ, para que se pueda escribir desde cualquier teclado', async () => {
    const { normalizarNombre } = await import('../../src/modules/siigo/siigo.ciudades.service.js');
    expect(normalizarNombre('Muñoz')).toBe('munoz');
  });

  it('lo que ya está normalizado no cambia', async () => {
    const { normalizarNombre } = await import('../../src/modules/siigo/siigo.ciudades.service.js');
    expect(normalizarNombre('cali')).toBe('cali');
  });
});

describe('lectura del catálogo — se niega a cargar algo roto (AC1)', () => {
  it('archivo inexistente → error explicando cuál', async () => {
    const { leerArchivoCatalogo, SiigoCiudadesError } = await import('../../src/modules/siigo/siigo.ciudades.service.js');
    expect(() => leerArchivoCatalogo('/no/existe.json')).toThrow(SiigoCiudadesError);
  });

  it('JSON inválido → error, no una excepción de parseo cruda', async () => {
    const { leerArchivoCatalogo } = await import('../../src/modules/siigo/siigo.ciudades.service.js');
    expect(() => leerArchivoCatalogo(catalogoTemporal('{no es json'))).toThrow(/no es JSON válido/);
  });

  it('sin ciudades → error', async () => {
    const { leerArchivoCatalogo } = await import('../../src/modules/siigo/siigo.ciudades.service.js');
    expect(() => leerArchivoCatalogo(catalogoTemporal({ version: 'x', ciudades: [] }))).toThrow(/no trae ciudades/);
  });

  it('el total no cuadra con lo que trae → error, porque medio catálogo inactiva ciudades reales', async () => {
    const { leerArchivoCatalogo } = await import('../../src/modules/siigo/siigo.ciudades.service.js');
    const truncado = {
      version: '2026-08-06', total: 4605,
      ciudades: [{ countryCode: 'Co', countryName: 'Colombia', stateCode: '11', stateName: 'Bogotá D.C', cityCode: '11001', cityName: 'Bogotá' }],
    };
    expect(() => leerArchivoCatalogo(catalogoTemporal(truncado))).toThrow(/declara 4605 ciudades y trae 1/);
  });

  it('una ciudad sin código → error señalando cuál', async () => {
    const { leerArchivoCatalogo } = await import('../../src/modules/siigo/siigo.ciudades.service.js');
    const roto = {
      version: '2026-08-06', total: 1,
      ciudades: [{ countryCode: 'Co', countryName: 'Colombia', stateCode: '11', stateName: 'X', cityCode: '', cityName: 'Y' }],
    };
    expect(() => leerArchivoCatalogo(catalogoTemporal(roto))).toThrow(/sin alguno de sus códigos/);
  });

  it('el archivo real del repositorio se lee sin quejarse', async () => {
    const { leerArchivoCatalogo } = await import('../../src/modules/siigo/siigo.ciudades.service.js');
    expect(leerArchivoCatalogo(RUTA_REAL).ciudades.length).toBeGreaterThan(4000);
  });
});

describe('carga — repetible y sin borrar nada (AC3, AC4)', () => {
  const ARCHIVO = {
    version: '2026-08-06', origen: 'https://x/Lista-de-ciudades.xlsx', descargadoEn: '2026-08-06', total: 2,
    ciudades: [
      { countryCode: 'Co', countryName: 'Colombia', stateCode: '11', stateName: 'Bogotá D.C', cityCode: '11001', cityName: 'Bogotá' },
      { countryCode: 'Co', countryName: 'Colombia', stateCode: '05', stateName: 'Antioquia', cityCode: '05001', cityName: 'Medellín' },
    ],
  };

  /** Deja `db.select()` devolviendo lo que ya hay en la tabla y captura el upsert. */
  function prepararCarga(yaEnLaBase: Record<string, unknown>[]) {
    const upserts: unknown[][] = [];
    const desactivadas: unknown[] = [];
    selectMock.mockReturnValueOnce({ from: () => Promise.resolve(yaEnLaBase) });
    insertMock.mockImplementation(() => ({
      values: (filas: unknown[]) => {
        upserts.push(filas);
        return { onConflictDoUpdate: () => Promise.resolve() };
      },
    }));
    updateMock.mockImplementation(() => ({
      set: (payload: unknown) => ({ where: () => { desactivadas.push(payload); return Promise.resolve(); } }),
    }));
    return { upserts, desactivadas };
  }

  it('la primera carga inserta todo y no desactiva nada', async () => {
    const { cargarCiudades } = await import('../../src/modules/siigo/siigo.ciudades.service.js');
    const { upserts, desactivadas } = prepararCarga([]);
    const r = await cargarCiudades(catalogoTemporal(ARCHIVO));

    expect(r).toMatchObject({ total: 2, insertadas: 2, actualizadas: 0, inactivadas: 0, version: '2026-08-06' });
    expect(upserts.flat()).toHaveLength(2);
    expect(desactivadas).toHaveLength(0);
  });

  it('volver a cargar lo mismo no duplica: actualiza (AC3)', async () => {
    const { cargarCiudades } = await import('../../src/modules/siigo/siigo.ciudades.service.js');
    prepararCarga(ARCHIVO.ciudades.map((c) => ({ ...c, activo: true })));
    const r = await cargarCiudades(catalogoTemporal(ARCHIVO));
    expect(r).toMatchObject({ insertadas: 0, actualizadas: 2, inactivadas: 0 });
  });

  it('una ciudad que ya no viene en el listado se DESACTIVA, no se borra (AC4)', async () => {
    const { cargarCiudades } = await import('../../src/modules/siigo/siigo.ciudades.service.js');
    const { desactivadas } = prepararCarga([
      ...ARCHIVO.ciudades.map((c) => ({ ...c, activo: true })),
      { countryCode: 'Co', stateCode: '99', cityCode: '99999', activo: true },
    ]);
    const r = await cargarCiudades(catalogoTemporal(ARCHIVO));

    expect(r.inactivadas).toBe(1);
    // Un cliente antiguo puede referenciarla: borrarla dejaría su ficha apuntando a la nada.
    expect(desactivadas).toEqual([expect.objectContaining({ activo: false })]);
  });

  it('la que estaba inactiva y vuelve a venir se reactiva', async () => {
    const { cargarCiudades } = await import('../../src/modules/siigo/siigo.ciudades.service.js');
    prepararCarga(ARCHIVO.ciudades.map((c, i) => ({ ...c, activo: i === 0 ? false : true })));
    const r = await cargarCiudades(catalogoTemporal(ARCHIVO));
    expect(r.reactivadas).toBe(1);
  });

  it('lo que ya estaba desactivado y sigue sin venir no se vuelve a tocar', async () => {
    const { cargarCiudades } = await import('../../src/modules/siigo/siigo.ciudades.service.js');
    const { desactivadas } = prepararCarga([
      ...ARCHIVO.ciudades.map((c) => ({ ...c, activo: true })),
      { countryCode: 'Co', stateCode: '99', cityCode: '99999', activo: false },
    ]);
    const r = await cargarCiudades(catalogoTemporal(ARCHIVO));
    expect(r.inactivadas).toBe(0);
    expect(desactivadas).toHaveLength(0);
  });

  it('guarda el nombre normalizado para poder buscar sin tildes', async () => {
    const { cargarCiudades } = await import('../../src/modules/siigo/siigo.ciudades.service.js');
    const { upserts } = prepararCarga([]);
    await cargarCiudades(catalogoTemporal(ARCHIVO));
    const medellin = upserts.flat().find((f) => (f as { cityCode: string }).cityCode === '05001');
    expect(medellin).toMatchObject({ cityBusqueda: 'medellin', activo: true, version: '2026-08-06' });
  });

  it('no llama a Siigo por ningún lado (AC5)', async () => {
    // La garantía real es estructural: el servicio no importa el cliente de Siigo. Si algún día
    // alguien lo añade, este test no basta — pero el import se ve en la revisión.
    const fuente = readFileSync(
      path.resolve(process.cwd(), 'src/modules/siigo/siigo.ciudades.service.ts'), 'utf8',
    );
    expect(fuente).not.toMatch(/siigo\.client|siigo\.resiliencia|fetch\(/);
  });
});
