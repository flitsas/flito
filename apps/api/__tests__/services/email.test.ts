import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock nodemailer ANTES del import del SUT.
const sendMailMock = vi.fn();
const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));

vi.mock('nodemailer', () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}));

// IMPORTANTE: mutar process.env (NO env.SMTP_*) porque vi.resetModules() reparseará
// config/env.ts desde process.env. Cualquier mutación al env importado quedaría huérfana.
function setSmtpEnv(opts: { host?: string; port?: string; user?: string; pass?: string; fromName?: string } = {}) {
  if (opts.host === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = opts.host;
  if (opts.port === undefined) delete process.env.SMTP_PORT; else process.env.SMTP_PORT = opts.port;
  if (opts.user === undefined) delete process.env.SMTP_USER; else process.env.SMTP_USER = opts.user;
  if (opts.pass === undefined) delete process.env.SMTP_PASS; else process.env.SMTP_PASS = opts.pass;
  if (opts.fromName === undefined) delete process.env.SMTP_FROM_NAME; else process.env.SMTP_FROM_NAME = opts.fromName;
}

const SMTP_OK = {
  host: 'smtp.office365.com',
  port: '587',
  user: 'info@kyverum.com',
  pass: 'super-secret-pass',
  fromName: 'FLIT Operaciones',
};

beforeEach(() => {
  sendMailMock.mockReset();
  createTransportMock.mockClear();
  setSmtpEnv(SMTP_OK);
  vi.resetModules(); // fresh import → env.ts re-parse desde process.env actualizado
});

afterEach(() => {
  setSmtpEnv(SMTP_OK); // restaurar para siguientes tests
});

describe('email — escapeHtml', () => {
  it('escapa < > & " \' a entidades HTML', async () => {
    const { escapeHtml } = await import('../../src/services/email.js');
    expect(escapeHtml('<script>alert("xss")</script>'))
      .toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(escapeHtml("O'Reilly & Co"))
      .toBe('O&#39;Reilly &amp; Co');
  });

  it('null/undefined → string vacío (no throw)', async () => {
    const { escapeHtml } = await import('../../src/services/email.js');
    expect(escapeHtml(null as any)).toBe('');
    expect(escapeHtml(undefined as any)).toBe('');
  });

  it('escapa & primero (no doble-escape)', async () => {
    const { escapeHtml } = await import('../../src/services/email.js');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('email — isValidEmail', () => {
  it('formatos válidos pasan', async () => {
    const { isValidEmail } = await import('../../src/services/email.js');
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('user.name+tag@kyverum.com')).toBe(true);
  });

  it('formatos inválidos rechazados', async () => {
    const { isValidEmail } = await import('../../src/services/email.js');
    expect(isValidEmail('no-arroba')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false); // sin TLD
    expect(isValidEmail('a @b.co')).toBe(false); // espacio
    expect(isValidEmail('')).toBe(false);
  });
});

describe('email — isSmtpConfigured', () => {
  it('true cuando HOST + USER + PASS están', async () => {
    const { isSmtpConfigured } = await import('../../src/services/email.js');
    expect(isSmtpConfigured()).toBe(true);
  });

  it('false cuando falta SMTP_HOST', async () => {
    setSmtpEnv({ ...SMTP_OK, host: undefined });
    vi.resetModules();
    const { isSmtpConfigured } = await import('../../src/services/email.js');
    expect(isSmtpConfigured()).toBe(false);
  });

  it('false cuando falta SMTP_PASS', async () => {
    setSmtpEnv({ ...SMTP_OK, pass: undefined });
    vi.resetModules();
    const { isSmtpConfigured } = await import('../../src/services/email.js');
    expect(isSmtpConfigured()).toBe(false);
  });
});

describe('email — sendEmail', () => {
  it('SMTP no configurado → ok=false sin tocar nodemailer', async () => {
    setSmtpEnv({ ...SMTP_OK, host: undefined });
    vi.resetModules();
    const { sendEmail } = await import('../../src/services/email.js');
    const r = await sendEmail({ to: 'a@b.co', subject: 's', html: '<p>x</p>' });
    expect(r).toEqual({ ok: false, error: 'SMTP no configurado' });
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('todos los destinatarios inválidos → sin_destinatarios sin enviar', async () => {
    const { sendEmail } = await import('../../src/services/email.js');
    const r = await sendEmail({ to: ['no-arroba', 'tampoco'], subject: 's', html: 'x' });
    expect(r).toEqual({ ok: false, error: 'sin_destinatarios' });
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('filtra inválidos y envía a los válidos', async () => {
    sendMailMock.mockResolvedValueOnce({ messageId: 'm-001' });
    const { sendEmail } = await import('../../src/services/email.js');
    const r = await sendEmail({ to: ['a@b.co', 'no-arroba', 'c@d.co'], subject: 's', html: 'x' });
    expect(r).toEqual({ ok: true, messageId: 'm-001' });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0][0].to).toBe('a@b.co, c@d.co');
  });

  it('envía con from name + List-Unsubscribe header automático', async () => {
    sendMailMock.mockResolvedValueOnce({ messageId: 'm-002' });
    const { sendEmail } = await import('../../src/services/email.js');
    await sendEmail({ to: 'x@y.com', subject: 'Asunto', html: '<p>cuerpo</p>', text: 'cuerpo' });
    const args = sendMailMock.mock.calls[0][0];
    expect(args.from).toEqual({ name: 'FLIT Operaciones', address: 'info@kyverum.com' });
    expect(args.subject).toBe('Asunto');
    expect(args.html).toBe('<p>cuerpo</p>');
    expect(args.text).toBe('cuerpo');
    expect(args.replyTo).toBe('info@kyverum.com');
    expect(args.headers['List-Unsubscribe']).toBe('<mailto:info@kyverum.com?subject=unsubscribe>');
  });

  it('headers custom se mergean con List-Unsubscribe (no lo sobrescriben)', async () => {
    sendMailMock.mockResolvedValueOnce({ messageId: 'm-003' });
    const { sendEmail } = await import('../../src/services/email.js');
    await sendEmail({
      to: 'x@y.com', subject: 's', html: 'x',
      headers: { 'X-Custom': '1', 'X-Other': 'v' },
    });
    const headers = sendMailMock.mock.calls[0][0].headers;
    expect(headers['X-Custom']).toBe('1');
    expect(headers['X-Other']).toBe('v');
    expect(headers['List-Unsubscribe']).toBeTruthy();
  });

  it('replyTo custom se respeta', async () => {
    sendMailMock.mockResolvedValueOnce({ messageId: 'm-004' });
    const { sendEmail } = await import('../../src/services/email.js');
    await sendEmail({ to: 'x@y.com', subject: 's', html: 'x', replyTo: 'no-reply@k.com' });
    expect(sendMailMock.mock.calls[0][0].replyTo).toBe('no-reply@k.com');
  });

  it('throws en sendMail → ok=false con error.message', async () => {
    sendMailMock.mockRejectedValueOnce(new Error('SMTP refused'));
    const { sendEmail } = await import('../../src/services/email.js');
    const r = await sendEmail({ to: 'x@y.com', subject: 's', html: 'x' });
    expect(r).toEqual({ ok: false, error: 'SMTP refused' });
  });

  it('throws sin message → ok=false con "error_smtp"', async () => {
    sendMailMock.mockRejectedValueOnce({ noMessage: true });
    const { sendEmail } = await import('../../src/services/email.js');
    const r = await sendEmail({ to: 'x@y.com', subject: 's', html: 'x' });
    expect(r).toEqual({ ok: false, error: 'error_smtp' });
  });

  it('to como string single → recipients=[string]', async () => {
    sendMailMock.mockResolvedValueOnce({ messageId: 'm-005' });
    const { sendEmail } = await import('../../src/services/email.js');
    await sendEmail({ to: 'x@y.com', subject: 's', html: 'x' });
    expect(sendMailMock.mock.calls[0][0].to).toBe('x@y.com');
  });
});

describe('email — transport singleton (lazy + reusable)', () => {
  it('createTransport se llama 1 vez aún con N envíos', async () => {
    sendMailMock.mockResolvedValue({ messageId: 'm' });
    const { sendEmail } = await import('../../src/services/email.js');
    await sendEmail({ to: 'x@y.com', subject: 's', html: 'x' });
    await sendEmail({ to: 'a@b.co', subject: 's', html: 'x' });
    await sendEmail({ to: 'c@d.co', subject: 's', html: 'x' });
    expect(createTransportMock).toHaveBeenCalledTimes(1);
  });

  it('config TLS minVersion 1.2 + pool=true + maxConnections=3', async () => {
    sendMailMock.mockResolvedValueOnce({ messageId: 'm' });
    const { sendEmail } = await import('../../src/services/email.js');
    await sendEmail({ to: 'x@y.com', subject: 's', html: 'x' });
    const cfg = createTransportMock.mock.calls[0][0];
    expect(cfg.tls.minVersion).toBe('TLSv1.2');
    expect(cfg.pool).toBe(true);
    expect(cfg.maxConnections).toBe(3);
    expect(cfg.secure).toBe(false); // STARTTLS, no TLS implícito
  });
});
