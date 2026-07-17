// OPS-02b r2: mock KEYED por tabla.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
const { update: updateMock, execute: executeMock } = kdb;

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const withLockMock = vi.fn();
vi.mock('../../src/shared/utils/lock.js', () => ({
  withLock: withLockMock,
}));

const sendEmailMock = vi.fn();
vi.mock('../../src/services/email.js', () => ({
  sendEmail: sendEmailMock,
  isSmtpConfigured: vi.fn().mockReturnValue(true),
  escapeHtml: (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)),
}));

beforeEach(() => {
  kdb.reset();
  updateMock.mockReset();
  executeMock.mockReset();
  withLockMock.mockReset();
  sendEmailMock.mockReset();
  withLockMock.mockImplementation(async (_n: string, _t: number, fn: any) => fn());
});

// Helper: stub la cadena `update().set().where()` con un spy en el set callback.
function stubUpdateChain(setSpy?: (v: any) => void) {
  return {
    set: (v: any) => { setSpy?.(v); return { where: () => Promise.resolve(undefined) }; },
  };
}

describe('fleet/documents.cron — runFleetAlertsOnce', () => {
  it('lock NO obtenido → ceros', async () => {
    withLockMock.mockResolvedValueOnce(null);
    const { runFleetAlertsOnce } = await import('../../src/modules/fleet/documents.cron.js');
    const r = await runFleetAlertsOnce();
    expect(r).toEqual({ candidatos: 0, enviados: 0, saltados: 0 });
    expect(executeMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('candidato + slot reservado + destinatarios → email enviado + estado actualizado', async () => {
    // 1) candidatos query
    executeMock.mockResolvedValueOnce({ rows: [{
      doc_id: 100, vehicle_id: 5, plate: 'ABC123', alias: null,
      tipo_nombre: 'SOAT', numero: 'S-001',
      vigencia_hasta: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
      dias_alerta: [7, 30],
      destinatarios_default: ['ops@kyverum.com'],
      destinatarios_extra: [],
    }] });
    // 2) reserve INSERT...ON CONFLICT
    executeMock.mockResolvedValueOnce({ rows: [{ id: 42 }] });

    let updateAlertSent: any = null;
    let updateVehicleDoc: any = null;
    updateMock.mockReturnValueOnce(stubUpdateChain((v) => { updateAlertSent = v; })); // alertsSent (post-email)
    updateMock.mockReturnValueOnce(stubUpdateChain((v) => { updateVehicleDoc = v; })); // vehicleDocuments estado

    sendEmailMock.mockResolvedValueOnce({ ok: true, messageId: 'msg-fleet-001' });

    const { runFleetAlertsOnce } = await import('../../src/modules/fleet/documents.cron.js');
    const r = await runFleetAlertsOnce();

    expect(r.candidatos).toBe(1);
    expect(r.enviados).toBe(1);
    expect(r.saltados).toBe(0);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].to).toEqual(['ops@kyverum.com']);
    expect(sendEmailMock.mock.calls[0][0].subject).toContain('ABC123');
    expect(sendEmailMock.mock.calls[0][0].subject).toContain('SOAT');
    expect(updateAlertSent).toMatchObject({
      resultado: 'enviado',
      emailMessageId: 'msg-fleet-001',
      destinatarios: ['ops@kyverum.com'],
    });
    expect(['vigente', 'por_vencer', 'vencido']).toContain(updateVehicleDoc.estado);
  });

  it('slot ya reservado (ON CONFLICT vacío) → saltado, no envía email', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{
      doc_id: 200, vehicle_id: 6, plate: 'XYZ999', alias: null,
      tipo_nombre: 'RTM', numero: 'R-1',
      vigencia_hasta: new Date(Date.now() + 1 * 86_400_000).toISOString().slice(0, 10),
      dias_alerta: [1],
      destinatarios_default: ['ops@kyverum.com'],
      destinatarios_extra: [],
    }] });
    // Reserve devuelve [] → ya enviado antes
    executeMock.mockResolvedValueOnce({ rows: [] });

    const { runFleetAlertsOnce } = await import('../../src/modules/fleet/documents.cron.js');
    const r = await runFleetAlertsOnce();

    expect(r.saltados).toBe(1);
    expect(r.enviados).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('sin destinatarios → marca sin_destinatarios, no envía email', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{
      doc_id: 300, vehicle_id: 7, plate: 'AAA111', alias: null,
      tipo_nombre: 'POLIZA', numero: 'P-1',
      vigencia_hasta: new Date(Date.now() + 0).toISOString().slice(0, 10),
      dias_alerta: [0],
      destinatarios_default: [],
      destinatarios_extra: [],
    }] });
    executeMock.mockResolvedValueOnce({ rows: [{ id: 99 }] });

    let captured: any = null;
    updateMock.mockReturnValueOnce(stubUpdateChain((v) => { captured = v; }));

    const { runFleetAlertsOnce } = await import('../../src/modules/fleet/documents.cron.js');
    const r = await runFleetAlertsOnce();

    expect(r.saltados).toBe(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(captured).toMatchObject({ resultado: 'sin_destinatarios', destinatarios: [] });
  });

  it('email falla → marca error con errorMsg', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{
      doc_id: 400, vehicle_id: 8, plate: 'BBB222', alias: null,
      tipo_nombre: 'TARJETA', numero: 'T-1',
      vigencia_hasta: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
      dias_alerta: [5],
      destinatarios_default: ['x@y.com'],
      destinatarios_extra: [],
    }] });
    executeMock.mockResolvedValueOnce({ rows: [{ id: 50 }] });

    let captured: any = null;
    updateMock.mockReturnValueOnce(stubUpdateChain((v) => { captured = v; }));
    updateMock.mockReturnValueOnce(stubUpdateChain()); // vehicleDocuments

    sendEmailMock.mockResolvedValueOnce({ ok: false, error: 'SMTP refused' });

    const { runFleetAlertsOnce } = await import('../../src/modules/fleet/documents.cron.js');
    const r = await runFleetAlertsOnce();

    expect(r.enviados).toBe(0);
    expect(captured).toMatchObject({ resultado: 'error', errorMsg: 'SMTP refused' });
  });

  it('destinatarios deduplicados (default + extra repetidos)', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{
      doc_id: 500, vehicle_id: 9, plate: 'CCC333', alias: null,
      tipo_nombre: 'X', numero: 'N',
      vigencia_hasta: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
      dias_alerta: [3],
      destinatarios_default: ['a@x.com', 'b@x.com'],
      destinatarios_extra: ['b@x.com', 'c@x.com'],
    }] });
    executeMock.mockResolvedValueOnce({ rows: [{ id: 60 }] });

    updateMock.mockReturnValueOnce(stubUpdateChain());
    updateMock.mockReturnValueOnce(stubUpdateChain());
    sendEmailMock.mockResolvedValueOnce({ ok: true, messageId: 'msg' });

    const { runFleetAlertsOnce } = await import('../../src/modules/fleet/documents.cron.js');
    await runFleetAlertsOnce();

    expect(sendEmailMock.mock.calls[0][0].to).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
  });
});

describe('fleet/documents.cron — startDocumentAlertsCron (lifecycle)', () => {
  it('SMTP no configurado → cron no se inicia', async () => {
    const emailMod = await import('../../src/services/email.js');
    (emailMod.isSmtpConfigured as any).mockReturnValueOnce(false);
    const { startDocumentAlertsCron, stopDocumentAlertsCron } = await import('../../src/modules/fleet/documents.cron.js');
    startDocumentAlertsCron();
    stopDocumentAlertsCron();
    // No throw
  });

  it('start es idempotente', async () => {
    const { startDocumentAlertsCron, stopDocumentAlertsCron } = await import('../../src/modules/fleet/documents.cron.js');
    startDocumentAlertsCron();
    startDocumentAlertsCron();
    stopDocumentAlertsCron();
  });
});
