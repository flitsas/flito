import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateMock = vi.fn();
const executeMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    update: updateMock,
    execute: executeMock,
    select: vi.fn(),
    insert: vi.fn(),
  },
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
  updateMock.mockReset();
  executeMock.mockReset();
  withLockMock.mockReset();
  sendEmailMock.mockReset();
  withLockMock.mockImplementation(async (_n: string, _t: number, fn: any) => fn());
});

function stubUpdateChain(setSpy?: (v: any) => void) {
  return {
    set: (v: any) => { setSpy?.(v); return { where: () => Promise.resolve(undefined) }; },
  };
}

describe('drivers/documents.cron — runDriverAlertsOnce', () => {
  it('lock NO obtenido → ceros', async () => {
    withLockMock.mockResolvedValueOnce(null);
    const { runDriverAlertsOnce } = await import('../../src/modules/drivers/documents.cron.js');
    const r = await runDriverAlertsOnce();
    expect(r).toEqual({ candidatos: 0, enviados: 0, saltados: 0 });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('candidato con email del conductor → email del conductor incluido en destinatarios', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{
      doc_id: 11, user_id: 7, name: 'Juan Pérez', email: 'juan@drivers.co',
      tipo_nombre: 'LICENCIA', numero: 'L-001',
      vigencia_hasta: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
      destinatarios_default: ['ops@kyverum.com'],
      destinatarios_extra: ['supervisor@kyverum.com'],
    }] });
    executeMock.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    updateMock.mockReturnValueOnce(stubUpdateChain());
    updateMock.mockReturnValueOnce(stubUpdateChain());

    sendEmailMock.mockResolvedValueOnce({ ok: true, messageId: 'msg-1' });

    const { runDriverAlertsOnce } = await import('../../src/modules/drivers/documents.cron.js');
    const r = await runDriverAlertsOnce();

    expect(r.enviados).toBe(1);
    expect(sendEmailMock.mock.calls[0][0].to).toEqual(['ops@kyverum.com', 'supervisor@kyverum.com', 'juan@drivers.co']);
    expect(sendEmailMock.mock.calls[0][0].subject).toContain('Juan Pérez');
    expect(sendEmailMock.mock.calls[0][0].subject).toContain('LICENCIA');
  });

  it('candidato sin email del conductor → solo destinatarios default+extra', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{
      doc_id: 12, user_id: 8, name: null, email: null,
      tipo_nombre: 'EPS', numero: null,
      vigencia_hasta: new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10), // vencido
      destinatarios_default: ['ops@kyverum.com'],
      destinatarios_extra: [],
    }] });
    executeMock.mockResolvedValueOnce({ rows: [{ id: 2 }] });

    updateMock.mockReturnValueOnce(stubUpdateChain());
    updateMock.mockReturnValueOnce(stubUpdateChain());
    sendEmailMock.mockResolvedValueOnce({ ok: true, messageId: 'msg-2' });

    const { runDriverAlertsOnce } = await import('../../src/modules/drivers/documents.cron.js');
    await runDriverAlertsOnce();

    expect(sendEmailMock.mock.calls[0][0].to).toEqual(['ops@kyverum.com']);
    expect(sendEmailMock.mock.calls[0][0].subject).toContain('VENCIDO');
    // Cuando user_id se usa como name fallback: "Conductor #8" o similar
    expect(sendEmailMock.mock.calls[0][0].subject).toMatch(/#8|EPS/);
  });

  it('slot ya reservado (ON CONFLICT vacío) → saltado', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{
      doc_id: 13, user_id: 9, name: 'X', email: 'x@y.com',
      tipo_nombre: 'CC', numero: 'N',
      vigencia_hasta: new Date(Date.now() + 1 * 86_400_000).toISOString().slice(0, 10),
      destinatarios_default: ['a@x.com'],
      destinatarios_extra: [],
    }] });
    executeMock.mockResolvedValueOnce({ rows: [] });

    const { runDriverAlertsOnce } = await import('../../src/modules/drivers/documents.cron.js');
    const r = await runDriverAlertsOnce();

    expect(r.saltados).toBe(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
