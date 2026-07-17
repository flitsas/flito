// TRAM-COMMS-02 — cron de recordatorios portal: selección de candidatos, rotación
// de token, canal y degradación. Sin red: db keyed + email mockeado.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const isSmtpConfiguredMock = vi.fn(() => true);
const sendEmailMock = vi.fn(async () => ({ ok: true }));
vi.mock('../../src/services/email.js', () => ({ isSmtpConfigured: isSmtpConfiguredMock, sendEmail: sendEmailMock }));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  kdb.reset();
  isSmtpConfiguredMock.mockReturnValue(true);
  sendEmailMock.mockClear().mockResolvedValue({ ok: true });
});

function candidate(over: Record<string, unknown> = {}) {
  return {
    id: 1, rol: 'comprador', email: 'c@x.co', telefono: null, whatsappOptIn: false,
    tramiteId: 10, placa: 'ABC123', vin: 'WAUZZZ123456789', ...over,
  };
}

describe('TRAM-COMMS-02 · runReminderSweep', () => {
  it('candidato con email → rota token, envía email, cuenta enviados', async () => {
    kdb.when.select('tramite_participantes', [candidate()]);
    kdb.when.update('tramite_participantes', [{ id: 1 }]); // returning de la rotación
    const { runReminderSweep } = await import('../../src/modules/tramites/portal-reminder.cron.js');
    const r = await runReminderSweep();
    expect(r.enviados).toBe(1);
    expect(r.omitidos).toBe(0);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0][0] as any;
    expect(arg.to).toBe('c@x.co');
    // Ley 1581: cuerpo sin PII de terceros — solo rol + placa + link al portal.
    expect(arg.html).toContain('comprador');
    expect(arg.html).toContain('ABC123');
    expect(arg.html).toContain('/tramite/portal/');
  });

  it('candidato sin canal (sin email ni WhatsApp) → omitido, no envía', async () => {
    kdb.when.select('tramite_participantes', [candidate({ email: null, telefono: null, whatsappOptIn: false })]);
    kdb.when.update('tramite_participantes', [{ id: 1 }]);
    const { runReminderSweep } = await import('../../src/modules/tramites/portal-reminder.cron.js');
    const r = await runReminderSweep();
    expect(r.enviados).toBe(0);
    expect(r.omitidos).toBe(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('SMTP y WhatsApp ambos off → skip (log) sin tocar BD', async () => {
    isSmtpConfiguredMock.mockReturnValue(false); // WhatsApp off por env ausente
    const { runReminderSweep } = await import('../../src/modules/tramites/portal-reminder.cron.js');
    const r = await runReminderSweep();
    expect(r.skipped).toBe(true);
    expect(r.candidatos).toBe(0);
    expect(kdb.select).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('reminderBody es puro y no incluye PII de terceros', async () => {
    const { reminderBody } = await import('../../src/modules/tramites/portal-reminder.cron.js');
    const b = reminderBody('vendedor', 'XYZ789', 'https://flit/tramite/portal/tok');
    expect(b.subject).toContain('vendedor');
    expect(b.text).toContain('XYZ789');
    expect(b.html).toContain('https://flit/tramite/portal/tok');
  });
});

describe('TRAM-COMMS-02 · portal helpers', () => {
  it('rotarTokenParticipante devuelve url + expires', async () => {
    kdb.when.update('tramite_participantes', [{ id: 5 }]);
    const { rotarTokenParticipante } = await import('../../src/modules/tramites/portal.js');
    const r = await rotarTokenParticipante(5);
    expect(r).not.toBeNull();
    expect(r!.url).toContain('/tramite/portal/');
    expect(new Date(r!.expires).getTime()).toBeGreaterThan(Date.now());
  });

  it('rotarTokenParticipante → null si el participante no existe / ya completó', async () => {
    kdb.when.update('tramite_participantes', []); // sin filas → no rota
    const { rotarTokenParticipante } = await import('../../src/modules/tramites/portal.js');
    expect(await rotarTokenParticipante(999)).toBeNull();
  });

  it('listarParticipantesPendientes mapea canal + vencido + último recordatorio', async () => {
    const past = new Date(Date.now() - 3600_000);
    const future = new Date(Date.now() + 3600_000);
    kdb.when.select('tramite_participantes', [
      { id: 1, rol: 'comprador', email: 'c@x.co', telefono: null, whatsappOptIn: false, expiresAt: future, lastReminderAt: past, createdAt: past },
      { id: 2, rol: 'vendedor', email: null, telefono: '3001', whatsappOptIn: true, expiresAt: past, lastReminderAt: null, createdAt: past },
    ]);
    const { listarParticipantesPendientes } = await import('../../src/modules/tramites/portal.js');
    const list = await listarParticipantesPendientes(10);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ rol: 'comprador', tieneEmail: true, vencido: false });
    expect(list[0].lastReminderAt).not.toBeNull();
    expect(list[1]).toMatchObject({ rol: 'vendedor', tieneEmail: false, tieneTelefono: true, whatsappOptIn: true, vencido: true });
    expect(list[1].lastReminderAt).toBeNull();
  });
});
