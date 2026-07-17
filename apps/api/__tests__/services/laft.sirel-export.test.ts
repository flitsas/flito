// Builder test: PDF watermark + SHA-256 estable + CSV header. Sin BD ni MinIO.

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  buildRosExport,
  buildRosCsvExport,
} from '../../src/modules/laft/sirel/sirel-export.builder.js';

const sampleRos = {
  id: 7,
  operationId: 100,
  generatedAt: new Date('2026-05-08T12:00:00Z'),
  clasificadoAt: new Date('2026-05-08T13:00:00Z'),
  slaDueAt: new Date('2026-05-09T13:00:00Z'),
  notes: 'Notas del oficial',
  sirelPayload: {
    encabezado: {
      tipo_reporte: 'ROS',
      entidad_reportante: { name: 'Kyverum LLC', nit: '900123456' },
      empleado_cumplimiento: 'cump1',
    },
    operacion: {
      fecha_deteccion: '2026-05-07',
      origen: 'manual',
      monto: 50000000,
      moneda: 'COP',
      descripcion: 'Estructuracion atipica',
      senales_alerta: ['split_efectivo', 'PEP_no_declarado'],
      analisis: 'Operacion fragmentada en 5 depositos consecutivos',
    },
  },
};

const cp = {
  kind: 'natural', docType: 'CC', docNumber: '900', fullName: 'Juan Pruebas',
  country: 'CO', city: 'Bogota', isPep: true, pepRole: 'Concejal',
  fundOrigin: 'Salario', riskLevel: 'alto', status: 'pendiente',
};

const signer = { nombre: 'Tatiana G.', rol: 'compliance', userId: 5, timestamp: new Date('2026-05-08T14:00:00Z') };

describe('sirel-export.builder · CSV', () => {
  it('header en español + valores con comillas escapadas', () => {
    const csv = buildRosCsvExport(sampleRos, cp);
    // BOM UTF-8 para Excel.
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const firstLine = csv.replace(/^﻿/, '').split('\r\n')[0];
    expect(firstLine).toBe('campo_sirel,valor');
    expect(csv).toContain('contraparte_nombre,Juan Pruebas');
    expect(csv).toContain('contraparte_es_pep,SI');
    expect(csv).toContain('operacion_senales_alerta,split_efectivo | PEP_no_declarado');
  });

  it('CSV es determinístico: mismo input → mismo SHA-256', () => {
    const csv1 = buildRosCsvExport(sampleRos, cp);
    const csv2 = buildRosCsvExport(sampleRos, cp);
    const h1 = crypto.createHash('sha256').update(csv1, 'utf8').digest('hex');
    const h2 = crypto.createHash('sha256').update(csv2, 'utf8').digest('hex');
    expect(h1).toEqual(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sin contraparte → fila contraparte_* vacía pero presente', () => {
    const csv = buildRosCsvExport(sampleRos, null);
    expect(csv).toContain('contraparte_nombre,');
    expect(csv).toContain('contraparte_es_pep,NO');
  });

  it('valores con coma se escapan con comillas RFC 4180', () => {
    const ros2 = { ...sampleRos, notes: 'linea1, linea2 con "comilla"' };
    const csv = buildRosCsvExport(ros2, cp);
    // RFC 4180: campo con coma o comilla → envolver en " y duplicar comillas internas.
    expect(csv).toContain('"linea1, linea2 con ""comilla"""');
  });
});

// Helper: pdf-lib codifica metadatos (Title/Subject/Keywords) como UTF-16BE
// hex con BOM 0xFEFF. Esta función decodifica el primer hex string que aparece
// tras una palabra clave para inspeccionarlo en assertions.
function decodePdfMetadata(pdfBytes: Uint8Array, key: 'Title' | 'Subject' | 'Keywords'): string {
  const txt = Buffer.from(pdfBytes).toString('latin1');
  const re = new RegExp(`/${key}\\s*<([0-9A-Fa-f]+)>`);
  const m = txt.match(re);
  if (!m) return '';
  const hex = m[1];
  const buf = Buffer.from(hex, 'hex');
  // BOM FEFF + UTF-16BE
  return buf.toString('utf16le') // pdf-lib usa BE pero los bytes pares→impar quedan en LE al hacer swap
    || '';
}

// pdf-lib codifica como UTF-16BE — node 'utf16le' no decodifica directo.
// Hacemos byte-swap antes de decodificar.
function decodePdfMetadataBE(pdfBytes: Uint8Array, key: 'Title' | 'Subject' | 'Keywords'): string {
  const txt = Buffer.from(pdfBytes).toString('latin1');
  const re = new RegExp(`/${key}\\s*<([0-9A-Fa-f]+)>`);
  const m = txt.match(re);
  if (!m) return '';
  const buf = Buffer.from(m[1], 'hex');
  // Swap pares para convertir BE→LE.
  const swapped = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i += 2) {
    swapped[i] = buf[i + 1];
    swapped[i + 1] = buf[i];
  }
  // Saltar BOM (2 bytes 0xFFFE en LE).
  const start = swapped.length >= 2 && swapped[0] === 0xFF && swapped[1] === 0xFE ? 2 : 0;
  return swapped.slice(start).toString('utf16le');
}

describe('sirel-export.builder · PDF', () => {
  it('genera PDF binario con watermark + SHA-256 retornado', async () => {
    const r = await buildRosExport({ ros: sampleRos, counterparty: cp, signer });
    expect(r.pdf).toBeInstanceOf(Uint8Array);
    expect(r.pdf.length).toBeGreaterThan(1000);
    // PDF mágico %PDF
    expect(String.fromCharCode(...r.pdf.slice(0, 4))).toBe('%PDF');

    // Subject y Keywords contienen "BORRADOR" + "RADICAR EN SIREL" (metadatos sin comprimir).
    const subject = decodePdfMetadataBE(r.pdf, 'Subject');
    expect(subject).toContain('BORRADOR');
    expect(subject).toContain('RADICAR EN SIREL');

    // SHA-256 en BD coincide con el calculado del CSV retornado.
    const expectedSha = crypto.createHash('sha256').update(r.csv, 'utf8').digest('hex');
    expect(r.sha256).toBe(expectedSha);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    // suprimir lint helper unused
    void decodePdfMetadata;
  });

  it('PDF imprime el SHA-256 del CSV en metadatos (verificación cruzada)', async () => {
    const r = await buildRosExport({ ros: sampleRos, counterparty: cp, signer });
    const subject = decodePdfMetadataBE(r.pdf, 'Subject');
    const title = decodePdfMetadataBE(r.pdf, 'Title');
    // El SHA del CSV debe aparecer en el Subject (queda sin comprimir, auditable
    // sin necesidad de descomprimir streams).
    expect(subject.toLowerCase()).toContain(r.sha256.toLowerCase());
    expect(title.toLowerCase()).toContain(r.sha256.toLowerCase());
  });
});
