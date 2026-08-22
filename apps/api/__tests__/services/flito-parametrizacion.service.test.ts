import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock },
  getPoolStats: vi.fn(),
}));

beforeEach(() => selectMock.mockReset());

const { carpetaDe, modalidadVigente, umbralPara } = await import(
  '../../src/modules/flito-parametrizacion/flito-parametrizacion.service.js'
);

// Los tests de `resolverProveedor` se retiran con la función (HU #10979): las reglas de
// enrutamiento por ámbito ya no existen, el proveedor se elige al enviar el SOAT al gestor. Lo que
// fijaban —que la compañía gana al organismo y este al global— dejó de ser una regla del sistema.

describe('modalidadVigente', () => {
  it('sin vigencia abierta → AUTOGESTIONADO (default: FLITO no gestiona salvo marca explícita)', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    expect(await modalidadVigente('11001')).toBe('autogestionado');
  });

  it('con vigencia abierta → su modalidad', async () => {
    selectMock.mockReturnValueOnce(chain([{ modalidad: 'requiere_gestion' }]));
    expect(await modalidadVigente('11001')).toBe('requiere_gestion');
  });
});

describe('umbralPara', () => {
  it('sin sobrescritura → umbral por defecto del env (0.85)', () => {
    expect(umbralPara(null)).toBe(0.85);
    expect(umbralPara(undefined)).toBe(0.85);
  });
  it('con sobrescritura → ese valor', () => {
    expect(umbralPara('0.9')).toBe(0.9);
    expect(umbralPara(0.7)).toBe(0.7);
  });
});

// HU #11770 — la raíz de la carpeta es el PREFIJO de la clave del objeto, y `firmarDescargaEntidad`
// mete la clave entera en el `?key=` del enlace de descarga: lo que se ponga aquí acaba en los logs
// de acceso de nginx, en el historial del navegador y en el `Referer`. `clients.document` es el NIT
// de la empresa, pero con un cliente persona natural es una CÉDULA. Es el mismo vector que el Bug
// #11694 cerró por el sufijo (el nombre del archivo); esto cierra el prefijo.
describe('carpetaDe — la raíz no lleva el documento del cliente (HU #11770)', () => {
  // Cédula de persona natural: el caso que convierte esto en un problema de datos personales y no
  // de estética. Un NIT de empresa también sobra en una URL, pero esto es lo que pesa.
  const CEDULA = '79483215';

  // La fila que llega de `clients` TRAE el documento, aunque `carpetaDe` ya no lo pida: así lo que
  // se comprueba es que no se usa, no que no esté disponible. Es lo que verá el mutante si alguien
  // devuelve `compania.document ?? compania.id` a la expresión de la raíz.
  // El tipo de `id` es el MISMO que acepta `carpetaDe`, no `string` a secas: si el fixture lo
  // ensancha, este archivo deja de compilar contra la firma real y nadie se entera — `__tests__`
  // queda fuera de `build:api` (`include: src/**/*`) y vitest no comprueba tipos. Lo encontró el
  // gate de QA de esta misma HU, con ocho TS2345 vivos. (HU #11770, H-1.)
  const filaCliente = (
    over: Partial<{ id: number | `factura-${string}`; flitoCarpetaStorage: string | null }> = {},
  ) =>
    ({ id: 42, document: CEDULA, name: 'JUAN PÉREZ', flitoCarpetaStorage: null, ...over });

  it('sin carpeta parametrizada, la raíz se nombra con el id — el documento NO aparece', () => {
    const carpeta = carpetaDe(filaCliente(), 'impuestos/recibos');
    expect(carpeta).toBe('_sin-carpeta-configurada/42/impuestos/recibos');
    expect(carpeta).not.toContain(CEDULA);
  });

  it('con carpeta parametrizada manda la carpeta, y el documento tampoco entra', () => {
    const carpeta = carpetaDe(
      filaCliente({ flitoCarpetaStorage: '  clientes/transportes-del-sur  ' }), 'soat/facturas',
    );
    // El `trim()` es parte del contrato: la carpeta la teclea una persona en parametrización.
    expect(carpeta).toBe('clientes/transportes-del-sur/soat/facturas');
    expect(carpeta).not.toContain(CEDULA);
  });

  it('carpeta en blanco cuenta como no parametrizada (no produce una raíz vacía)', () => {
    expect(carpetaDe(filaCliente({ id: 7, flitoCarpetaStorage: '   ' }), 'bolsas-recargas'))
      .toBe('_sin-carpeta-configurada/7/bolsas-recargas');
  });

  // Lo único que se le pide a la raíz además de no ser PII: estable y única por compañía. Si dos
  // clientes distintos compartieran carpeta, los soportes de uno se verían en la del otro.
  it('dos compañías sin carpeta no colisionan', () => {
    expect(carpetaDe(filaCliente({ id: 42 }), 'sub'))
      .not.toBe(carpetaDe(filaCliente({ id: 43 }), 'sub'));
  });

  // OJO con lo que este caso prueba y lo que NO. `carpetaDe` es pura, así que llamarla dos veces
  // con lo mismo TIENE que dar lo mismo: eso no es estabilidad, es una tautología, y sobrevive a
  // cualquier mutante de esta HU. Lo que de verdad importa —que una carpeta ya archivada se siga
  // encontrando— se prueba fijando el valor LITERAL, que es lo que rompería quien cambie de
  // identificador otra vez. (HU #11770, H-3.)
  it('la raíz de un id dado es un valor fijo, no derivado: lo ya archivado se sigue encontrando', () => {
    expect(carpetaDe(filaCliente({ id: 42 }), 'sub')).toBe('_sin-carpeta-configurada/42/sub');
    expect(carpetaDe(filaCliente({ id: 7 }), 'sub')).toBe('_sin-carpeta-configurada/7/sub');
  });

  // `siigo.archivo-documentos` es el único llamador que pasa un id que no es el de una compañía: una
  // factura sin empresa vinculada se archiva bajo una identidad derivada de la propia factura para
  // no acabar en una carpeta llamada `null`.
  it('acepta un id de texto (facturas Siigo sin compañía vinculada)', () => {
    expect(carpetaDe(filaCliente({ id: 'factura-abc' }), 'facturacion-electronica'))
      .toBe('_sin-carpeta-configurada/factura-abc/facturacion-electronica');
  });
});
