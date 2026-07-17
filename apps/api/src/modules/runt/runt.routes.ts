import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { consultarVehiculoRunt, consultarPersonaRunt } from './runt.service.js';

const router = Router();

router.use(authMiddleware);

const consultaSchema = z.object({
  placa: z.string().max(10).optional(),
  vin: z.string().max(17).optional(),
  documento: z.string().max(20).optional(),
  tipoDocumento: z.string().max(5).optional(),
});

router.post('/consulta-vehiculo', async (req: Request, res: Response) => {
  const parsed = consultaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: 'Datos inválidos' });
    return;
  }

  const { placa, vin, documento, tipoDocumento } = parsed.data;

  if (!placa && !vin) {
    res.status(400).json({ ok: false, message: 'Placa o VIN requerido' });
    return;
  }

  try {
    const result = await consultarVehiculoRunt(placa, vin, documento, tipoDocumento);
    await audit(req, {
      action: 'update',
      resource: 'runt',
      detail: `Consulta RUNT: ${placa ? 'placa=' + placa : 'vin=' + vin} → ${result.ok ? 'OK' : 'FAIL'}`,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err.message || 'Error consultando RUNT' });
  }
});

// Consulta persona por documento en RUNT
const personaSchema = z.object({
  documento: z.string().min(1).max(20),
  tipoDocumento: z.string().max(5).optional(),
});

router.post('/consulta-persona', async (req: Request, res: Response) => {
  const parsed = personaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: 'Documento requerido' });
    return;
  }

  try {
    const result = await consultarPersonaRunt(parsed.data.documento, parsed.data.tipoDocumento);
    await audit(req, {
      action: 'update',
      resource: 'runt',
      detail: `Consulta persona RUNT: doc=${parsed.data.documento.slice(0, 4)}*** → ${result.ok ? 'OK' : 'FAIL'}`,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err.message || 'Error consultando RUNT' });
  }
});

// OCR de cedula — extrae datos de foto de documento de identidad
const ocrCedulaSchema = z.object({
  image: z.string().min(100),
  lado: z.enum(['frontal', 'reverso']),
});

router.post('/ocr-cedula', async (req: Request, res: Response) => {
  const parsed = ocrCedulaSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, message: 'Imagen y lado requeridos' }); return; }

  const { image, lado } = parsed.data;
  const clean = image.replace(/^data:image\/[a-z]+;base64,/, '');
  if (clean.length > 7 * 1024 * 1024) { res.status(400).json({ ok: false, message: 'Imagen max 5MB' }); return; }

  const prompt = lado === 'frontal'
    ? `Analiza el FRENTE de este documento de identidad colombiano y extrae datos con MAXIMA precision.

TIPOS: CC Amarilla (fondo amarillo), CC Digital (celeste/amarillo, policarbonato), TI Azul (menores), CE (verde/azul, Migracion), PPT (verde/dorado), Pasaporte.

EXTRAER — Lee CADA digito y letra con precision:
- firstName: primer nombre
- secondName: segundo nombre o null
- lastName: primer apellido
- secondLastName: segundo apellido o null
- documentNumber: numero EXACTO del documento
- documentType: cc_amarilla/cc_digital/tarjeta_identidad/cedula_extranjeria/ppt/pasaporte
- birthDate: YYYY-MM-DD si visible en frente (CC Digital y TI si, CC Amarilla NO)
- gender: Masculino o Femenino

JSON sin markdown:
{"firstName":"","secondName":null,"lastName":"","secondLastName":null,"documentNumber":"","documentType":"cc_amarilla","birthDate":null,"gender":""}`
    : `Analiza el REVERSO de este documento de identidad colombiano.

EXTRAER:
- birthDate: YYYY-MM-DD (en CC Amarilla esta en el REVERSO, campo "FECHA DE NACIMIENTO". NO confundir con FECHA DE EXPEDICION)
- bloodType: grupo sanguineo (O+, A+, B+, AB+, etc)
- birthPlace: lugar de nacimiento
- expeditionDate: fecha expedicion YYYY-MM-DD
- expeditionPlace: lugar de expedicion
- gender: M o F
- documentNumber: si es visible

JSON sin markdown:
{"birthDate":"","bloodType":"","birthPlace":"","expeditionDate":"","expeditionPlace":"","gender":"","documentNumber":""}`;

  try {
    const https = await import('https');
    const { env } = await import('../../config/env.js');
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 800,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: clean } },
        { type: 'text', text: prompt },
      ] }],
    });
    const r: any = await new Promise((resolve, reject) => {
      const rq = https.default.request({
        method: 'POST', hostname: 'api.anthropic.com', path: '/v1/messages',
        headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) },
      }, (r2) => { let d = ''; r2.on('data', (c: string) => (d += c)); r2.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); });
      rq.setTimeout(60000, () => rq.destroy(new Error('Timeout')));
      rq.on('error', reject); rq.write(body); rq.end();
    });

    if (r.error) { res.status(500).json({ ok: false, message: r.error.message }); return; }
    const text = r.content?.[0]?.text || '';
    let data: any;
    try { data = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()); }
    catch { res.status(500).json({ ok: false, message: 'No se pudo leer el documento' }); return; }

    await audit(req, { action: 'update', resource: 'ocr_cedula', detail: `OCR cedula ${lado}` });
    res.json({ ok: true, data, lado });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

export default router;
