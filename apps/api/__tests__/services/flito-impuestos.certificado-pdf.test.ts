// Certificado PDF de la verificación contra el RUNT — contenido del documento (HU #11167).
//
// El constructor es PURO: recibe datos y devuelve bytes, sin base de datos ni red. Eso permite
// afirmar sobre el CONTENIDO del PDF, que es lo que la HU pide, en vez de conformarse con «devolvió
// algo que empieza por %PDF».
//
// Cómo se lee el contenido: buscar la frase en los bytes crudos NO funciona, por dos motivos que se
// acumulan. pdf-lib comprime los flujos con Flate, y dentro escribe cada texto como cadena
// hexadecimal (`<464C49544F> Tj`, no `(FLITO) Tj`). Así que hay que inflar los `stream … endstream` y
// después decodificar el hexadecimal, que en WinAnsi es byte a byte y se lee en latin1.
//
// No es un extractor de texto general —no reordena ni interpreta posiciones— pero para afirmar que
// una frase está o no está en el documento basta, y no añade una dependencia.

import zlib from 'zlib';
import { PDFDocument } from 'pdf-lib';
import { describe, it, expect } from 'vitest';
import {
  CampoCertificacion, ResultadoCampo, type ComparacionCampo,
} from '@operaciones/shared-types';
import {
  construirCertificadoPdf, fechaHoraColombia, fechaRuntLegible, sanitize, type CertificadoPdfDatos,
} from '../../src/modules/flito-impuestos/certificado-pdf.js';
import type { RegistroRuntCertificado } from '../../src/modules/flito-impuestos/certificacion-runt.js';

const INICIO = Buffer.from('stream');
const FIN = Buffer.from('endstream');

function textoDelPdf(pdf: Buffer): string {
  const trozos: string[] = [];
  let i = 0;
  for (;;) {
    const marca = pdf.indexOf(INICIO, i);
    if (marca === -1) break;
    let ini = marca + INICIO.length;
    if (pdf[ini] === 0x0d) ini++;
    if (pdf[ini] === 0x0a) ini++;
    const fin = pdf.indexOf(FIN, ini);
    if (fin === -1) break;
    const bruto = pdf.subarray(ini, fin);
    // Lo que no infla son flujos sin comprimir (o el propio xref): se leen tal cual.
    let contenido: string;
    try { contenido = zlib.inflateSync(bruto).toString('latin1'); }
    catch { contenido = bruto.toString('latin1'); }

    for (const [, hex] of contenido.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      trozos.push(Buffer.from(hex, 'hex').toString('latin1'));
    }
    i = fin + FIN.length;
  }
  return trozos.join('\n');
}

/**
 * Lo mismo, pero de corrido.
 *
 * Cada línea del PDF es un `Tj` independiente, así que una frase larga sale partida por donde cayera
 * el ajuste de línea. Afirmar sobre las leyendas del certificado con el texto crudo funcionaría hoy y
 * fallaría en cuanto alguien cambie un margen — sin que la leyenda haya dejado de estar.
 */
function textoPlano(pdf: Buffer): string {
  return textoDelPdf(pdf).replace(/\s+/g, ' ');
}

const CAMPOS: ComparacionCampo[] = [
  { campo: CampoCertificacion.PLACA, resultado: ResultadoCampo.COINCIDE, bloqueante: true, valorFlito: 'QIU744', valorRunt: 'QIU744' },
  { campo: CampoCertificacion.VIN, resultado: ResultadoCampo.COINCIDE, bloqueante: true, valorFlito: '3KPFF51ABTE156687', valorRunt: '3KPFF51ABTE156687' },
  { campo: CampoCertificacion.MARCA, resultado: ResultadoCampo.COINCIDE, bloqueante: false, valorFlito: 'KIA', valorRunt: 'KIA' },
  { campo: CampoCertificacion.LINEA, resultado: ResultadoCampo.DIFIERE, bloqueante: false, valorFlito: 'K3', valorRunt: 'K3 CROSS' },
  { campo: CampoCertificacion.MODELO, resultado: ResultadoCampo.COINCIDE, bloqueante: false, valorFlito: '2026', valorRunt: '2026' },
  { campo: CampoCertificacion.CLASE, resultado: ResultadoCampo.NO_VERIFICABLE, bloqueante: false, valorFlito: 'CAMIONETA', valorRunt: null },
];

// Valores con forma del payload real (QIU744, 2026-07-31). Todos presentes: así el «No reportado por
// el RUNT» de los tests de la tabla de comparación sigue saliendo SOLO de la tabla.
const REGISTRO: RegistroRuntCertificado = {
  clasificacion: 'AUTOMOVIL',
  color: 'GRIS TITANIO',
  cilindraje: '1598',
  tipoServicio: 'Particular',
  organismoTransito: 'STRIA TTEyMOV MEDELLIN',
  estadoAutomotor: 'ACTIVO',
  fechaMatricula: '2015-03-10',
  numMotor: 'G4FGSU123456',
  numChasis: '3KPFF51ABTE156687',
  numSerie: 'SER998877',
};

const BASE: CertificadoPdfDatos = {
  placaConsultada: 'QIU744',
  documentoConsultado: '43902633',
  tipoDocPropietario: 'C',
  propietarioNombre: 'MARIA MUÑOZ PEÑA',
  campos: CAMPOS,
  certificadoPorNombre: 'gestor@flit.io',
  certificadoEn: new Date('2026-07-31T14:05:00.000Z'),
  registroRunt: REGISTRO,
  generadoPor: 'auditor@flit.io',
  generadoEn: new Date('2026-08-03T15:30:45.000Z'),
};

describe('AC1 — contenido del certificado', () => {
  it('trae el origen FLITO', async () => {
    expect(textoDelPdf(await construirCertificadoPdf(BASE))).toContain('FLITO');
  });

  it('trae la fecha y hora de generación en huso de Colombia', async () => {
    const texto = textoDelPdf(await construirCertificadoPdf(BASE));

    // 15:30:45 UTC son las 10:30:45 en Bogotá (UTC-5), del mismo día.
    expect(texto).toContain('03/08/2026 10:30:45');
    expect(texto).toContain('hora de Colombia');
  });

  it('trae el usuario que generó el PDF, distinto del que certificó', async () => {
    const texto = textoDelPdf(await construirCertificadoPdf(BASE));

    expect(texto).toContain('auditor@flit.io');
    expect(texto).toContain('gestor@flit.io');
  });

  it('trae una tabla con cada campo comparado, sus dos valores y el resultado', async () => {
    const texto = textoDelPdf(await construirCertificadoPdf(BASE));

    for (const etiqueta of ['Placa', 'VIN', 'Marca', 'Linea', 'Modelo', 'Clase']) {
      expect(texto).toContain(etiqueta);
    }
    expect(texto).toContain('3KPFF51ABTE156687');
    expect(texto).toContain('K3 CROSS');
    expect(texto).toContain('Coincide');
    expect(texto).toContain('Difiere');
    expect(texto).toContain('No reportado por el RUNT');
  });

  it('un campo sin dato en el RUNT se muestra como no verificable, no como vacío', async () => {
    const texto = textoDelPdf(await construirCertificadoPdf(BASE));

    // El riesgo real es que una celda en blanco se lea como «el RUNT dijo que no hay clase».
    expect(texto).toContain('No reportado por el RUNT');
  });

  it('la celda del valor ausente lleva un guion, no un interrogante', async () => {
    const texto = textoDelPdf(await construirCertificadoPdf(BASE));

    // Un '?' en la columna del RUNT se lee como «el RUNT respondió algo dudoso», que es justo lo
    // contrario de «el RUNT no reportó este campo». El guion largo se convertía en '?' al sanear.
    expect(texto.split('\n')).toContain('-');
    expect(texto.split('\n')).not.toContain('?');
  });
});

describe('AC2 — bloque de propietario', () => {
  it('muestra el nombre marcado como dato de FLITO', async () => {
    const texto = textoDelPdf(await construirCertificadoPdf(BASE));

    expect(texto).toContain('Nombre (dato de FLITO)');
    expect(texto).toContain('MARIA MUNOZ PENA');
  });

  it('muestra el documento y la leyenda de que se validó ante el RUNT', async () => {
    const pdf = await construirCertificadoPdf(BASE);

    expect(textoDelPdf(pdf)).toContain('43902633');
    expect(textoPlano(pdf)).toContain('El documento del propietario quedo validado contra el RUNT');
    expect(textoPlano(pdf)).toContain('la consulta se autentica con placa y documento');
  });

  it('NO presenta el nombre como verificado por el RUNT', async () => {
    // La frase completa importa: el certificado tiene que decir explícitamente que el nombre NO se
    // verificó. Que simplemente no lo afirme dejaría al lector suponiendo lo contrario.
    expect(textoPlano(await construirCertificadoPdf(BASE)))
      .toContain('El nombre proviene de los registros de FLITO y no fue verificado contra el RUNT');
  });

  it('sin nombre en FLITO lo dice, en vez de dejar el hueco', async () => {
    const texto = textoDelPdf(await construirCertificadoPdf({ ...BASE, propietarioNombre: null }));

    expect(texto).toContain('No registrado en FLITO');
  });

  it('omite el tipo de documento si el RUNT no lo devolvió', async () => {
    const texto = textoDelPdf(await construirCertificadoPdf({ ...BASE, tipoDocPropietario: null }));

    expect(texto).not.toContain('Tipo de documento');
  });
});

describe('AC4 — dos descargas del mismo certificado', () => {
  it('cambia la hora de generación pero no los datos certificados', async () => {
    const primera = textoDelPdf(await construirCertificadoPdf(BASE));
    const segunda = textoDelPdf(await construirCertificadoPdf({
      ...BASE, generadoEn: new Date('2026-08-03T15:47:10.000Z'),
    }));

    expect(primera).toContain('03/08/2026 10:30:45');
    expect(segunda).toContain('03/08/2026 10:47:10');
    expect(segunda).not.toContain('03/08/2026 10:30:45');

    // Todo lo demás sale del mismo snapshot y por tanto no se mueve.
    for (const dato of ['QIU744', '3KPFF51ABTE156687', '43902633', 'MARIA MUNOZ PENA', 'gestor@flit.io']) {
      expect(primera).toContain(dato);
      expect(segunda).toContain(dato);
    }
  });
});

describe('AC6 — tildes y eñes', () => {
  it('genera el PDF sin lanzar con un nombre lleno de diacríticos', async () => {
    const pdf = await construirCertificadoPdf({ ...BASE, propietarioNombre: 'JOSÉ ÁNGEL MUÑOZ ÑUSTES' });

    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(textoDelPdf(pdf)).toContain('JOSE ANGEL MUNOZ NUSTES');
  });

  it('sanitize deja legible lo acentuado y no revienta con lo que no es ASCII', () => {
    // pdf-lib LANZA ante un carácter que WinAnsi no representa; por eso esto no es cosmético.
    expect(sanitize('MUÑOZ PEÑA')).toBe('MUNOZ PENA');
    expect(sanitize('José Ángel')).toBe('Jose Angel');
    expect(sanitize('emoji 🚗 aquí')).toBe('emoji ?? aqui');
  });

  it('sanitize traduce la puntuación tipográfica en vez de marcarla como ilegible', () => {
    // Un guion largo o unas comillas curvas son ASCII de sobra; convertirlos en '?' ensuciaría un
    // dato que se entiende perfectamente.
    expect(sanitize('K3 — CROSS')).toBe('K3 - CROSS');
    expect(sanitize('“SPARK” GT')).toBe('"SPARK" GT');
    expect(sanitize('LINEA…')).toBe('LINEA...');
  });

  it('un valor del RUNT con caracteres raros no impide certificar la descarga', async () => {
    const raros: ComparacionCampo[] = [
      { campo: CampoCertificacion.LINEA, resultado: ResultadoCampo.DIFIERE, bloqueante: false, valorFlito: 'LÍNEA — ñ', valorRunt: 'K3 CROSS' },
    ];
    const pdf = await construirCertificadoPdf({ ...BASE, campos: raros });

    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('HU #13204 AC1 — bloque «Registro del vehículo (RUNT)»', () => {
  it('trae el título y las diez etiquetas con sus valores', async () => {
    const texto = textoDelPdf(await construirCertificadoPdf(BASE));

    expect(texto).toContain('Registro del vehiculo (RUNT)');
    for (const etiqueta of [
      'Clasificacion:', 'Color:', 'Cilindraje:', 'Tipo de servicio:', 'Organismo de transito:',
      'Estado del automotor:', 'Fecha de matricula:', 'Numero de motor:', 'Numero de chasis:', 'Numero de serie:',
    ]) {
      expect(texto.split('\n')).toContain(etiqueta);
    }
    for (const valor of ['AUTOMOVIL', 'GRIS TITANIO', '1598', 'Particular', 'STRIA TTEyMOV MEDELLIN', 'ACTIVO',
      'G4FGSU123456', 'SER998877']) {
      expect(texto.split('\n')).toContain(valor);
    }
  });

  it('la fecha de matrícula YYYY-MM-DD sale DD/MM/YYYY sin correrse un día', async () => {
    const texto = textoDelPdf(await construirCertificadoPdf(BASE));

    expect(texto.split('\n')).toContain('10/03/2015');
    expect(texto).not.toContain('09/03/2015');
  });

  it('la fila «Consulta RUNT y certificación» lleva la hora de Colombia y no se duplica con «Certificado el»', async () => {
    const texto = textoDelPdf(await construirCertificadoPdf(BASE));

    expect(texto).toContain('Consulta RUNT y certificacion:');
    // 14:05 UTC = 09:05 en Bogotá.
    expect(texto).toContain('31/07/2026 09:05:00 (hora de Colombia)');
    expect(texto).not.toContain('Certificado el');
  });

  it('la tabla de comparación se mantiene', async () => {
    const texto = textoDelPdf(await construirCertificadoPdf(BASE));

    expect(texto).toContain('DATOS DEL VEHICULO VERIFICADOS');
    expect(texto).toContain('K3 CROSS');
  });
});

describe('HU #13204 AC2 — campo ausente', () => {
  it('un campo null dice «No reportado por el RUNT», nunca guion ni vacío', async () => {
    const soloLaTabla = textoDelPdf(await construirCertificadoPdf({ ...BASE, campos: [] }));
    expect(soloLaTabla).not.toContain('No reportado por el RUNT');

    const texto = textoDelPdf(await construirCertificadoPdf({
      ...BASE, campos: [], registroRunt: { ...REGISTRO, numSerie: null },
    }));
    const lineas = texto.split('\n');
    const i = lineas.indexOf('Numero de serie:');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(lineas[i + 1]).toBe('No reportado por el RUNT');
  });

  it('con los diez en null genera el PDF sin fallar', async () => {
    const vacio = Object.fromEntries(Object.keys(REGISTRO).map((k) => [k, null])) as unknown as RegistroRuntCertificado;
    const texto = textoDelPdf(await construirCertificadoPdf({ ...BASE, campos: [], registroRunt: vacio }));

    expect(texto.split('\n').filter((l) => l === 'No reportado por el RUNT')).toHaveLength(10);
  });
});

describe('HU #13204 AC7 — tildes, comillas y celdas que no se solapan', () => {
  it('valores con «»“”—ñ no lanzan y salen saneados', async () => {
    const pdf = await construirCertificadoPdf({
      ...BASE, registroRunt: { ...REGISTRO, color: '«GRIS» “PLATA” — ÑANDÚ', organismoTransito: 'SECRETARÍA DE MOVILIDAD' },
    });

    const texto = textoDelPdf(pdf);
    expect(texto).toContain('"GRIS" "PLATA" - NANDU');
    expect(texto).toContain('SECRETARIA DE MOVILIDAD');
  });

  it('un valor de 200 caracteres se recorta con «...» y el texto completo no aparece', async () => {
    const largo = 'ORGANISMO '.repeat(20).trim();
    const texto = textoDelPdf(await construirCertificadoPdf({
      ...BASE, registroRunt: { ...REGISTRO, organismoTransito: largo },
    }));

    expect(texto).not.toContain(largo);
    expect(texto.split('\n').some((l) => l.startsWith('ORGANISMO') && l.endsWith('...'))).toBe(true);
  });

  it('con 40 campos de comparación el documento pasa a una segunda página sin lanzar', async () => {
    const muchos = Array.from({ length: 40 }, () => CAMPOS[2]);
    const pdf = await construirCertificadoPdf({ ...BASE, campos: muchos });

    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(1);
    const texto = textoDelPdf(pdf);
    expect(texto).toContain('Registro del vehiculo (RUNT)');
    expect(texto).toContain('PROPIETARIO');
  });

  it('con los seis campos habituales cabe en una página', async () => {
    expect((await PDFDocument.load(await construirCertificadoPdf(BASE))).getPageCount()).toBe(1);
  });
});

describe('fechaRuntLegible', () => {
  it('corta la cadena ISO sin pasar por Date', () => {
    expect(fechaRuntLegible('2015-03-10')).toBe('10/03/2015');
    expect(fechaRuntLegible('2015-03-10T00:00:00')).toBe('10/03/2015');
  });

  it('cualquier otro formato sale tal cual', () => {
    expect(fechaRuntLegible('10/03/2015')).toBe('10/03/2015');
  });
});

describe('fechaHoraColombia', () => {
  it('formatea en UTC-5 y no en UTC', () => {
    // Las 02:00 UTC del día 4 son todavía las 21:00 del día 3 en Bogotá. Formatear en UTC pondría
    // en un documento de evidencia una fecha que el usuario no reconoce como la suya.
    expect(fechaHoraColombia(new Date('2026-08-04T02:00:00.000Z'))).toContain('03/08/2026 21:00:00');
  });

  it('usa reloj de 24 horas', () => {
    expect(fechaHoraColombia(new Date('2026-08-03T23:15:00.000Z'))).toContain('18:15:00');
  });
});
