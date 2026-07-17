import crypto from 'crypto';
import { env } from '../../../config/env.js';
import {
  IRndcClient, RndcCredentials, RndcResponse, RndcResultCode,
  IngresarRemesaInput, IngresarManifiestoInput, AnularInput, ConsultarEstadoInput,
} from './types.js';

// ============================================================================
// Mock client RNDC. Simula latencia, errores realistas y devuelve XML idéntico
// al que producirá el cliente real (Fase 4.3) para que el wire-up sea drop-in.
// ============================================================================
// Determinismo por payload: misma remesa → misma respuesta (testing reproducible).
// Idempotencia REAL la maneja envio.service vía rndc_idempotency_keys (BD).
// El mock aquí solo simula el comportamiento del servidor RNDC.

function sha1Hex(data: string): string {
  return crypto.createHash('sha1').update(data).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function uniformLatency(): number {
  // 200-800 ms uniforme + 5% chance 3-8 s (cola larga).
  if (Math.random() < 0.05) return 3000 + Math.random() * 5000;
  return 200 + Math.random() * 600;
}

// Mapeo determinista del primer hex char del payload-hash a un código de resultado.
// Permite que mismo payload → mismo código siempre (idempotencia visual del mock).
function deterministicCode(hashHexChar0: string, errorRate: number, timeoutRate: number): RndcResultCode {
  // Errores forzados por env (testing).
  const r = parseInt(hashHexChar0, 16) / 16; // 0..1
  if (r < timeoutRate) return 'TIMEOUT';
  if (r < timeoutRate + errorRate) return 'ER99';
  // Distribución base: 0-c → OK, d → ER05, e → ER99, f → TIMEOUT.
  const idx = parseInt(hashHexChar0, 16);
  if (idx <= 12) return '00';
  if (idx === 13) return 'ER05';
  if (idx === 14) return 'ER99';
  return 'TIMEOUT';
}

function buildMockXmlOk(consecutivoRndc: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<acceptanceResponse>
  <processCode>00</processCode>
  <processMessage>Procesado correctamente</processMessage>
  <consec>${consecutivoRndc}</consec>
  <generated_by>mock</generated_by>
</acceptanceResponse>`;
}

function buildMockXmlError(codigo: RndcResultCode, mensaje: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<acceptanceResponse>
  <processCode>${codigo}</processCode>
  <processMessage>${mensaje}</processMessage>
  <generated_by>mock</generated_by>
</acceptanceResponse>`;
}

function generateConsecutivoRndc(empresaNit: string): string {
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `${empresaNit}-${ts}-${rand}`;
}

function validateCredentials(creds: RndcCredentials): RndcResultCode | null {
  if (!creds.numNit || !creds.claveQR) return 'ER01';
  if (creds.claveQR.length < 6) return 'ER01';
  return null;
}

export class RndcMockClient implements IRndcClient {
  modo(): 'mock' | 'real' { return 'mock'; }

  private async simulate(
    payloadHash: string,
    creds: RndcCredentials,
    contextValidation?: () => RndcResultCode | null,
  ): Promise<RndcResponse> {
    const start = Date.now();

    // Validación inmediata de credenciales (sin latencia).
    const credErr = validateCredentials(creds);
    if (credErr) {
      return {
        ok: false, codigo: credErr,
        mensaje: 'Credenciales inválidas',
        rawXml: buildMockXmlError(credErr, 'Credenciales inválidas'),
        durationMs: Date.now() - start,
      };
    }

    // Validaciones contextuales (si las hay) ANTES de simular latencia.
    if (contextValidation) {
      const ctxErr = contextValidation();
      if (ctxErr) {
        return {
          ok: false, codigo: ctxErr,
          mensaje: `Validación contextual falló: ${ctxErr}`,
          rawXml: buildMockXmlError(ctxErr, `Validación contextual falló: ${ctxErr}`),
          durationMs: Date.now() - start,
        };
      }
    }

    const codigo = deterministicCode(
      payloadHash[0],
      env.RNDC_MOCK_ERROR_RATE,
      env.RNDC_MOCK_TIMEOUT_RATE,
    );

    const latency = uniformLatency();

    // Simular TIMEOUT como espera larga + lanza error como cliente real.
    if (codigo === 'TIMEOUT') {
      await sleep(Math.min(latency, 5000));
      return {
        ok: false, codigo: 'TIMEOUT',
        mensaje: 'Timeout esperando respuesta de RNDC',
        rawXml: buildMockXmlError('TIMEOUT', 'Timeout simulado'),
        durationMs: Date.now() - start,
      };
    }

    await sleep(latency);

    if (codigo === '00') {
      const consecutivoRndc = generateConsecutivoRndc(creds.empresaNit);
      return {
        ok: true, codigo: '00', consecutivoRndc,
        mensaje: 'Procesado correctamente',
        rawXml: buildMockXmlOk(consecutivoRndc),
        durationMs: Date.now() - start,
      };
    }

    const messages: Record<string, string> = {
      ER05: 'Producto o empaque no válido',
      ER99: 'Error interno RNDC, intente más tarde',
    };
    return {
      ok: false, codigo,
      mensaje: messages[codigo] ?? `Error ${codigo}`,
      rawXml: buildMockXmlError(codigo, messages[codigo] ?? `Error ${codigo}`),
      durationMs: Date.now() - start,
    };
  }

  async ingresarRemesa(input: IngresarRemesaInput, creds: RndcCredentials): Promise<RndcResponse> {
    const payloadStr = JSON.stringify({ ...input.payload, consec: input.consecutivoLocal });
    const hash = sha1Hex(payloadStr);

    return this.simulate(hash, creds, () => {
      const p = input.payload as Record<string, unknown>;
      if (!p.municipioOrigen && !p.municipioOrigenDane) return 'ER06';
      if (!p.municipioDestino && !p.municipioDestinoDane) return 'ER06';
      if (!p.productoCodigo) return 'ER05';
      return null;
    });
  }

  async ingresarManifiesto(input: IngresarManifiestoInput, creds: RndcCredentials): Promise<RndcResponse> {
    const payloadStr = JSON.stringify({ ...input.payload, consec: input.consecutivoLocal });
    const hash = sha1Hex(payloadStr);

    return this.simulate(hash, creds, () => {
      const p = input.payload as Record<string, unknown>;
      if (!p.placaPrincipal && !p.vehiculoPrincipalId) return 'ER03';
      if (!p.conductorDoc && !p.conductorId) return 'ER04';
      return null;
    });
  }

  async anularRemesa(input: AnularInput, creds: RndcCredentials): Promise<RndcResponse> {
    const hash = sha1Hex(`anular-remesa:${input.consecutivoRndc}`);
    return this.simulate(hash, creds, () => {
      if (!input.consecutivoRndc) return 'ER08';
      return null;
    });
  }

  async anularManifiesto(input: AnularInput, creds: RndcCredentials): Promise<RndcResponse> {
    const hash = sha1Hex(`anular-manifiesto:${input.consecutivoRndc}`);
    return this.simulate(hash, creds, () => {
      if (!input.consecutivoRndc) return 'ER08';
      return null;
    });
  }

  async consultarEstadoIngreso(input: ConsultarEstadoInput, creds: RndcCredentials): Promise<RndcResponse> {
    const hash = sha1Hex(`consultar:${input.consecutivoLocal}`);
    return this.simulate(hash, creds);
  }
}
