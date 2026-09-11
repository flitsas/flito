// HU #12092 (Feature #12073) — el OCR lee el COMPRADOR de la factura de venta, natural o jurídica.
//
// Verifica el CONTRATO y las REGLAS del extractor reinstaurado (`extraerFacturaVenta`), no la calidad
// del OCR: `anthropicMessages` está mockeado y los tests corren sin red ni API key. Lo que se afirma
// es la NORMALIZACIÓN (AC5), el «vacío y no aproximado» (AC3), la forma de salida (AC4) y —para lo
// que solo el modelo puede cumplir, la excluyencia natural/jurídica del AC2— la INSTRUCCIÓN del
// prompt que se la pide, porque borrarla es exactamente lo que dejaría el AC sin defensa y el resto
// de la suite en verde.
//
// ── Por qué hay asertos sobre el TEXTO del prompt ────────────────────────────────────────────────
//
// El AC1 y el AC2 son propiedades de la plantilla, no del código: quien las rompe no rompe una
// función, borra un párrafo. Sin estos asertos, quitar «NUNCA los dos juegos a la vez» o el aviso de
// que el comprador NO es el emisor no pondría rojo absolutamente nada, y el fallo aparecería en
// producción como una factura radicada a nombre del concesionario. Se afirma la sustancia (las
// palabras que llevan la regla), no el formato.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Igual que `flito-ocr.service.test.ts`: aísla del `.env` de demo. Estos tests ejercitan la ruta de
// Anthropic (mockeada), no el stub ni el fallback local.
process.env.OCR_STUB = '0';
process.env.OCR_LOCAL = '0';

const anthropicMock = vi.fn();
vi.mock('../../src/modules/tramites/anthropic.js', () => ({ anthropicMessages: anthropicMock }));

const { extraerFacturaVenta, OcrNoDisponibleError } =
  await import('../../src/modules/flito-ocr/flito-ocr.service.js');
const {
  PROMPT_FACTURA_VENTA, PROMPT_FACTURA_SOAT, PROMPT_RECIBO_IMPUESTO, PROMPT_DERECHO_TRAMITE,
} = await import('../../src/modules/flito-ocr/flito-ocr.prompts.js');
const {
  CampoFacturaVenta, CAMPO_FACTURA_VENTA_LABEL, CAMPOS_COMPRADOR_FACTURA,
  CAMPOS_REVISION_FACTURA_VENTA, TIPOS_DOCUMENTO_RUNT,
} = await import('@operaciones/shared-types');

/** Encola una respuesta OK de Anthropic con el JSON dado como texto del content. */
const respuesta = (obj: Record<string, unknown>) =>
  ({ ok: true as const, data: { content: [{ text: JSON.stringify(obj) }] } });

const doc = (umbral = 0.85) => ({
  nombreArchivo: 'factura.pdf',
  contentType: 'application/pdf',
  contenido: Buffer.from('%PDF-fake'),
  umbral,
});

const alta = (valor: string | null) => ({ valor, confianza: valor === null ? null : 'alta' });

/** Las 14 claves con valor `null`, para escribir en cada test SOLO lo que ese test mide. */
function modeloDice(over: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {};
  for (const campo of Object.values(CampoFacturaVenta)) base[campo] = alta(null);
  return respuesta({ ...base, ...over });
}

beforeEach(() => anthropicMock.mockReset());

// ───────────────────────────── AC1 — la plantilla se amplía ──────────────────

describe('AC1 — `PROMPT_FACTURA_VENTA` pide los nueve campos del comprador', () => {
  it('**el JSON de salida de la plantilla declara las CATORCE claves**', async () => {
    // Es lo que el modelo copia: una clave que no esté aquí no vuelve nunca, por muy bien que esté
    // descrita más arriba en el prompt.
    const json = PROMPT_FACTURA_VENTA.slice(PROMPT_FACTURA_VENTA.lastIndexOf('{"placa"'));
    const salida = JSON.parse(json) as Record<string, unknown>;

    expect(Object.keys(salida).sort()).toEqual([...Object.values(CampoFacturaVenta)].sort());
    expect(Object.keys(salida)).toHaveLength(14);
    for (const campo of CAMPOS_COMPRADOR_FACTURA) {
      expect(salida[campo], `${campo} falta en el JSON de salida del prompt`)
        .toEqual({ valor: null, confianza: null });
    }
  });

  it('**las otras TRES plantillas no se tocan**: ninguna pide datos del comprador', () => {
    // El AC1 lo dice explícitamente. Un `nombres`/`numeroDocumento` colado en la plantilla del SOAT
    // haría que el OCR de la póliza —que corre sobre miles de documentos y SÍ persiste— empezara a
    // leer datos personales que nadie pidió.
    for (const plantilla of [PROMPT_FACTURA_SOAT, PROMPT_RECIBO_IMPUESTO, PROMPT_DERECHO_TRAMITE]) {
      for (const campo of CAMPOS_COMPRADOR_FACTURA) {
        expect(plantilla).not.toContain(`"${campo}"`);
      }
      expect(plantilla).not.toContain('COMPRADOR');
      expect(plantilla).not.toContain('ADQUIRIENTE');
    }
  });

  it('el prompt avisa de que el comprador NO es el concesionario emisor', () => {
    // El error caro de esta plantilla, equivalente al «VALOR ASEGURADO» del SOAT: en una factura de
    // concesionario el bloque que más se ve es el del vendedor. Sin este aviso, el modelo devuelve
    // el NIT del concesionario como documento del comprador —un valor perfectamente plausible— y la
    // solicitud se radica a nombre de quien vendió el carro.
    expect(PROMPT_FACTURA_VENTA).toContain('COMPRADOR');
    expect(PROMPT_FACTURA_VENTA).toMatch(/NO es el EMISOR/i);
    expect(PROMPT_FACTURA_VENTA).toMatch(/NUNCA tomes los datos del emisor/i);
  });

  it('el prompt acota `tipoDocumento` a los ocho tipos del catálogo RUNT y prohíbe deducirlo', () => {
    for (const tipo of TIPOS_DOCUMENTO_RUNT) {
      expect(PROMPT_FACTURA_VENTA, `el prompt no ofrece ${tipo}`).toContain(tipo);
    }
    expect(PROMPT_FACTURA_VENTA).toMatch(/NO lo deduzcas/i);
  });
});

// ───────────────────────────── AC2 — natural vs jurídica ─────────────────────

describe('AC2 — natural y jurídica son EXCLUYENTES (CF-06, RN-B5)', () => {
  it('**el prompt exige la excluyencia y la explica en los dos sentidos**', () => {
    // La regla la cumple el modelo, así que lo único que este repo puede defender es la instrucción.
    // Si alguien borra esta parte del prompt, este test cae — y es el único que caería.
    expect(PROMPT_FACTURA_VENTA).toMatch(/NUNCA los dos juegos a la vez/i);
    expect(PROMPT_FACTURA_VENTA).toMatch(/PERSONA NATURAL/);
    expect(PROMPT_FACTURA_VENTA).toMatch(/PERSONA JURÍDICA/);
    // Y la pista que la hace decidible sin adivinar: el tipo de documento.
    expect(PROMPT_FACTURA_VENTA).toMatch(/NIT, es una empresa/i);
  });

  it('factura a nombre de una EMPRESA → razonSocial con valor, nombres y apellidos en null', async () => {
    anthropicMock.mockResolvedValue(modeloDice({
      razonSocial: alta('Transportes del Norte S.A.S.'),
      tipoDocumento: alta('NIT'),
      numeroDocumento: alta('900.123.456-7'),
    }));

    const r = await extraerFacturaVenta(doc());

    expect(r.razonSocial).toEqual({ valor: 'Transportes del Norte S.A.S.', confianza: 0.95, confiable: true });
    expect(r.nombres).toEqual({ valor: null, confianza: 0, confiable: false });
    expect(r.apellidos).toEqual({ valor: null, confianza: 0, confiable: false });
    expect(r.tipoDocumento!.valor).toBe('NIT');
  });

  it('factura a nombre de una PERSONA NATURAL → nombres y apellidos, razonSocial en null', async () => {
    anthropicMock.mockResolvedValue(modeloDice({
      nombres: alta('Juana María'),
      apellidos: alta('Pérez Gómez'),
      tipoDocumento: alta('CC'),
      numeroDocumento: alta('1.020.304.050'),
    }));

    const r = await extraerFacturaVenta(doc());

    // `trimN` y NO mayúsculas forzadas: el valor va a un formulario que la persona lee y corrige.
    expect(r.nombres!.valor).toBe('Juana María');
    expect(r.apellidos!.valor).toBe('Pérez Gómez');
    expect(r.razonSocial).toEqual({ valor: null, confianza: 0, confiable: false });
  });
});

// ───────────────────────────── AC3 — vacío, no aproximado ────────────────────

describe('AC3 — lo que no se lee queda vacío', () => {
  it('**un campo que el modelo no leyó sale `{valor:null, confianza:0, confiable:false}`**', async () => {
    anthropicMock.mockResolvedValue(modeloDice({ placa: alta('QTQ100') }));

    const r = await extraerFacturaVenta(doc());

    for (const campo of CAMPOS_COMPRADOR_FACTURA) {
      expect(r[campo], campo).toEqual({ valor: null, confianza: 0, confiable: false });
    }
    expect(r.placa!.valor).toBe('QTQ100');
  });

  it('un campo AUSENTE de la respuesta del modelo tampoco se inventa', async () => {
    // El modelo devuelve solo cinco claves: las nueve del comprador ni siquiera vienen. El extractor
    // las rellena en vacío, no las omite —el consumidor tiene que poder distinguir «no lo leyó» de
    // «esta versión no lo pide»— y desde luego no las deriva de las que sí llegaron.
    anthropicMock.mockResolvedValue(respuesta({
      placa: alta('QTQ100'), vin: alta('9BWZZZ377VT004251'),
      numeroFactura: alta('FE-1234'), fechaFactura: alta('2026-03-04'),
      valorVehiculo: alta('85.000.000'),
    }));

    const r = await extraerFacturaVenta(doc());

    for (const campo of CAMPOS_COMPRADOR_FACTURA) {
      expect(r[campo], campo).toEqual({ valor: null, confianza: 0, confiable: false });
    }
  });

  it('el prompt manda dejar TODO el bloque del comprador en null si no se distingue del emisor', () => {
    expect(PROMPT_FACTURA_VENTA).toMatch(/deja TODOS estos campos en null/i);
  });
});

// ───────────────────────────── AC4 — contrato de salida ──────────────────────

describe('AC4 — contrato de salida y umbral de quien llama', () => {
  it('**cada uno de los catorce campos llega como `{valor, confianza, confiable}`**', async () => {
    anthropicMock.mockResolvedValue(modeloDice({ nombres: alta('ANA'), apellidos: alta('DIAZ') }));

    const r = await extraerFacturaVenta(doc()) as Record<string, unknown>;

    expect(Object.keys(r).sort()).toEqual([...Object.values(CampoFacturaVenta)].sort());
    for (const campo of Object.values(CampoFacturaVenta)) {
      expect(Object.keys(r[campo] as object).sort(), campo).toEqual(['confiable', 'confianza', 'valor']);
    }
  });

  it('**el umbral lo decide QUIEN LLAMA**: con 0.5 lo «media» del comprador pasa a confiable', async () => {
    anthropicMock.mockResolvedValue(modeloDice({
      nombres: { valor: 'ANA', confianza: 'media' },
      celular: { valor: '3001234567', confianza: 'media' },
    }));

    const conDefecto = await extraerFacturaVenta(doc(0.85));
    expect(conDefecto.nombres!.confianza).toBe(0.6);
    expect(conDefecto.nombres!.confiable).toBe(false);

    anthropicMock.mockResolvedValue(modeloDice({
      nombres: { valor: 'ANA', confianza: 'media' },
      celular: { valor: '3001234567', confianza: 'media' },
    }));
    const conUmbralBajo = await extraerFacturaVenta(doc(0.5));
    expect(conUmbralBajo.nombres!.confiable).toBe(true);
    expect(conUmbralBajo.celular!.confiable).toBe(true);
  });

  it('`CAMPO_FACTURA_VENTA_LABEL` rotula los catorce (el `Record` exhaustivo del AC4)', () => {
    for (const campo of Object.values(CampoFacturaVenta)) {
      expect(CAMPO_FACTURA_VENTA_LABEL[campo], campo).toBeTruthy();
    }
    expect(Object.keys(CAMPO_FACTURA_VENTA_LABEL)).toHaveLength(14);
  });

  it('los cinco campos que deciden el TITULAR fuerzan la segunda pasada (Sonnet)', async () => {
    // Documentales nítidos, comprador dudoso. Si la escalación no cubriera al titular, esto se
    // resolvería con UNA llamada y el dato que decide a nombre de quién queda la solicitud se daría
    // por bueno con el modelo barato.
    anthropicMock.mockResolvedValue(modeloDice({
      placa: alta('QTQ100'), vin: alta('9BWZZZ377VT004251'), valorVehiculo: alta('85000000'),
      numeroDocumento: { valor: '1020304050', confianza: 'media' },
    }));

    await extraerFacturaVenta(doc());

    expect(anthropicMock).toHaveBeenCalledTimes(2);
  });
});

// ───────────────────────────── AC5 — normalización ───────────────────────────

describe('AC5 — normalización de los campos del comprador', () => {
  it('**numeroDocumento pierde puntos, comas y espacios; conserva el guion del DV y las letras**', async () => {
    anthropicMock.mockResolvedValue(modeloDice({ numeroDocumento: alta(' 900.123,456-7 ') }));
    expect((await extraerFacturaVenta(doc())).numeroDocumento!.valor).toBe('900123456-7');

    // Un pasaporte: quitar las letras lo destruiría, y el AC solo habla de puntos y comas.
    anthropicMock.mockResolvedValue(modeloDice({ numeroDocumento: alta('ap 123.456') }));
    expect((await extraerFacturaVenta(doc())).numeroDocumento!.valor).toBe('AP123456');
  });

  it('**celular queda en SOLO dígitos**', async () => {
    anthropicMock.mockResolvedValue(modeloDice({ celular: alta('+57 (300) 123-45-67') }));
    expect((await extraerFacturaVenta(doc())).celular!.valor).toBe('573001234567');
  });

  it('un celular sin un solo dígito → null, no una cadena vacía', async () => {
    anthropicMock.mockResolvedValue(modeloDice({ celular: alta('N/A') }));
    expect((await extraerFacturaVenta(doc())).celular).toEqual({ valor: null, confianza: 0, confiable: false });
  });

  it('**tipoDocumento cruza `TIPOS_DOCUMENTO_RUNT` o es null — nunca un valor inventado**', async () => {
    for (const tipo of TIPOS_DOCUMENTO_RUNT) {
      anthropicMock.mockResolvedValue(modeloDice({ tipoDocumento: alta(tipo.toLowerCase()) }));
      expect((await extraerFacturaVenta(doc())).tipoDocumento!.valor, tipo).toBe(tipo);
    }

    // Lo que un modelo devuelve de verdad cuando no se le acota: el nombre largo. No cruza → null, y
    // el campo llega vacío al formulario en vez de llegar con algo que el `z.enum` del alta
    // rechazaría con un 400 sobre un desplegable que se rellenó solo.
    for (const invento of ['CEDULA', 'Cédula de ciudadanía', 'DNI', 'RUT', '']) {
      anthropicMock.mockResolvedValue(modeloDice({ tipoDocumento: alta(invento) }));
      const r = await extraerFacturaVenta(doc());
      expect(r.tipoDocumento, invento).toEqual({ valor: null, confianza: 0, confiable: false });
    }
  });

  it('`NIT.` con el punto que el modelo suele añadir sí cruza', async () => {
    anthropicMock.mockResolvedValue(modeloDice({ tipoDocumento: alta('NIT.') }));
    expect((await extraerFacturaVenta(doc())).tipoDocumento!.valor).toBe('NIT');
  });

  it('**un valor que no cabe en su columna → null y `confiable: false`, NO truncado**', async () => {
    // `flito_compradores.nombres` es varchar(200) y `municipio` varchar(100). Truncar prellenaría el
    // formulario con un nombre cortado por la mitad —que parece correcto— y la dirección recortada
    // acabaría persistida. Devolver null deja el campo vacío y la persona lo escribe.
    anthropicMock.mockResolvedValue(modeloDice({
      nombres: alta('A'.repeat(201)),
      apellidos: alta('B'.repeat(200)),
      municipio: alta('C'.repeat(101)),
      direccion: alta('D'.repeat(300)),
      numeroDocumento: alta('9'.repeat(31)),
      celular: alta('3'.repeat(31)),
    }));

    const r = await extraerFacturaVenta(doc());

    expect(r.nombres).toEqual({ valor: null, confianza: 0, confiable: false });   // 201 > 200
    expect(r.apellidos!.valor).toHaveLength(200);                                  // 200 cabe justo
    expect(r.municipio).toEqual({ valor: null, confianza: 0, confiable: false });  // 101 > 100
    expect(r.direccion!.valor).toHaveLength(300);                                  // 300 cabe justo
    expect(r.numeroDocumento).toEqual({ valor: null, confianza: 0, confiable: false });
    expect(r.celular).toEqual({ valor: null, confianza: 0, confiable: false });
  });
});

// ───────────────────────────── El motor caído ────────────────────────────────

describe('el OCR no disponible se propaga como `OcrNoDisponibleError` 503', () => {
  it('el 503 de `anthropicMessages` llega TIPADO al llamador, no como un 500 anónimo', async () => {
    anthropicMock.mockResolvedValue({ ok: false, status: 503, message: 'OCR no disponible' });

    await expect(extraerFacturaVenta(doc())).rejects.toBeInstanceOf(OcrNoDisponibleError);
    await expect(extraerFacturaVenta(doc())).rejects.toMatchObject({ status: 503 });
  });
});

// ───────────── La cola de revisión de Operaciones NO gana nueve casillas ─────

describe('la trampa del enum: `camposEsperados` no puede crecer con el comprador', () => {
  it('**`CAMPOS_REVISION_FACTURA_VENTA` son los CINCO documentales y ninguno del comprador**', async () => {
    expect([...CAMPOS_REVISION_FACTURA_VENTA])
      .toEqual(['placa', 'vin', 'numeroFactura', 'fechaFactura', 'valorVehiculo']);
    for (const campo of CAMPOS_COMPRADOR_FACTURA) {
      expect(CAMPOS_REVISION_FACTURA_VENTA, campo).not.toContain(campo);
    }
  });

  it('**`camposEsperados(FACTURA_VENTA)` sigue devolviendo exactamente los cinco de siempre**', async () => {
    // Este es el aserto que muere si alguien devuelve la rama a `Object.values(CampoFacturaVenta)`:
    // esa versión pinta en la cola de revisión de Operaciones un formulario con nueve casillas de PII
    // del comprador —nombre, cédula, dirección, celular— sobre una fila que puede no ser del canal, y
    // el build queda verde igual. Es la única defensa que tiene esa pantalla.
    const { camposEsperados } = await import('../../src/modules/flito-revisiones/flito-revisiones.service.js');
    const { FlujoRevision } = await import('@operaciones/shared-types');

    expect(camposEsperados(FlujoRevision.FACTURA_VENTA))
      .toEqual(['placa', 'vin', 'numeroFactura', 'fechaFactura', 'valorVehiculo']);
  });

  it('las otras tres colas siguen sirviendo su enum entero (no se les cambió nada)', async () => {
    const { camposEsperados } = await import('../../src/modules/flito-revisiones/flito-revisiones.service.js');
    const { FlujoRevision, CampoSoat, CampoImpuesto, CampoDerechoTramite } =
      await import('@operaciones/shared-types');

    expect(camposEsperados(FlujoRevision.SOAT)).toEqual(Object.values(CampoSoat));
    expect(camposEsperados(FlujoRevision.IMPUESTOS)).toEqual(Object.values(CampoImpuesto));
    expect(camposEsperados(FlujoRevision.DERECHOS)).toEqual(Object.values(CampoDerechoTramite));
  });
});
