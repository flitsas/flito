// Firma electrónica avanzada PDF — port pdfSigner.cjs (Ley 527/1999).

import { createRequire } from 'module';
import { PDFDocument } from 'pdf-lib';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const forge = require('node-forge');
const { SignPdf } = require('@signpdf/signpdf') as { SignPdf: new () => { sign: (pdf: Buffer, signer: unknown) => Promise<Buffer> } };
const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib') as { pdflibAddPlaceholder: (opts: Record<string, unknown>) => void };
const { P12Signer } = require('@signpdf/signer-p12') as { P12Signer: new (p12: Buffer, opts: { passphrase: string }) => unknown };

export interface PdfFirmante {
  nombre: string; documento: string; tipoDoc?: string; email?: string;
  rol?: string; razon?: string; ubicacion?: string;
}

function generarP12SelfSigned(firmante: PdfFirmante, passphrase: string): Buffer {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = Date.now().toString(16) + forge.util.bytesToHex(forge.random.getBytesSync(4));
  const now = new Date();
  cert.validity.notBefore = now;
  cert.validity.notAfter = new Date(now.getFullYear() + 10, now.getMonth(), now.getDate());
  const subject: Array<{ name: string; value: string }> = [
    { name: 'commonName', value: (firmante.nombre || 'Firmante').slice(0, 64) },
    { name: 'serialNumber', value: String(firmante.documento || '').slice(0, 64) },
    { name: 'organizationName', value: 'Sistema Kyverum Operaciones FLIT' },
    { name: 'organizationalUnitName', value: firmante.rol || 'Firmante' },
    { name: 'countryName', value: 'CO' },
  ];
  if (firmante.email) subject.push({ name: 'emailAddress', value: firmante.email.slice(0, 64) });
  cert.setSubject(subject);
  cert.setIssuer([
    { name: 'commonName', value: 'Kyverum FEA Authority' },
    { name: 'organizationName', value: 'Sistema Kyverum Operaciones FLIT' },
    { name: 'organizationalUnitName', value: 'Firma Electronica Avanzada' },
    { name: 'countryName', value: 'CO' },
  ]);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, keyEncipherment: true },
    { name: 'extKeyUsage', clientAuth: true, emailProtection: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, { algorithm: '3des', friendlyName: 'Kyverum FEA ' + (firmante.nombre || '') });
  return Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
}

export async function firmarPdf(pdfBuffer: Buffer, firmante: PdfFirmante): Promise<Buffer> {
  const passphrase = 'kyverum-fea-' + Date.now();
  const p12Buffer = generarP12SelfSigned(firmante, passphrase);
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  pdflibAddPlaceholder({
    pdfDoc,
    reason: firmante.razon || ('Firma ' + (firmante.rol || 'firmante')),
    contactInfo: firmante.email || 'noreply@kyverum.io',
    name: firmante.nombre || 'Firmante',
    location: firmante.ubicacion || 'Colombia',
    signatureLength: 8192,
  });
  const pdfWithPlaceholder = await pdfDoc.save();
  const signer = new P12Signer(p12Buffer, { passphrase });
  const signPdf = new SignPdf();
  return signPdf.sign(Buffer.from(pdfWithPlaceholder), signer);
}

export async function firmarPdfMultiple(pdfBuffer: Buffer, firmantes: PdfFirmante[]): Promise<Buffer> {
  let current = pdfBuffer;
  for (const f of firmantes) {
    if (!f?.nombre) continue;
    try { current = await firmarPdf(current, f); } catch { break; }
  }
  return current;
}
