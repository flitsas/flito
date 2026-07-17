import { describe, it, expect, vi, beforeEach } from 'vitest';

const redisMock = {
  ttl: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
};
const getRedisMock = vi.fn();

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: getRedisMock,
}));

beforeEach(() => {
  redisMock.ttl.mockReset();
  redisMock.incr.mockReset();
  redisMock.expire.mockReset();
  redisMock.set.mockReset();
  redisMock.del.mockReset();
  getRedisMock.mockReset();
  // Reset módulo para limpiar memFails/memLocks Map state entre tests.
  vi.resetModules();
});

describe('loginLockout — checkLockout (Redis primary)', () => {
  it('Redis ttl > 0 → locked con remainingMins ceil', async () => {
    getRedisMock.mockReturnValue(redisMock);
    redisMock.ttl.mockResolvedValueOnce(125); // 2 min 5 seg → ceil = 3 min
    const { checkLockout } = await import('../../src/modules/auth/loginLockout.js');
    const r = await checkLockout('JuanPerez');
    expect(r).toEqual({ locked: true, remainingMins: 3 });
    // username normalizado a lowercase en la key
    expect(redisMock.ttl).toHaveBeenCalledWith('login:lock:juanperez');
  });

  it('Redis ttl = 0 → no locked', async () => {
    getRedisMock.mockReturnValue(redisMock);
    redisMock.ttl.mockResolvedValueOnce(0);
    const { checkLockout } = await import('../../src/modules/auth/loginLockout.js');
    const r = await checkLockout('user');
    expect(r).toEqual({ locked: false });
  });

  it('Redis ttl = -2 (no key) → no locked', async () => {
    getRedisMock.mockReturnValue(redisMock);
    redisMock.ttl.mockResolvedValueOnce(-2);
    const { checkLockout } = await import('../../src/modules/auth/loginLockout.js');
    const r = await checkLockout('user');
    expect(r).toEqual({ locked: false });
  });

  it('Redis throws → fallback in-memory (no locked si está vacío)', async () => {
    getRedisMock.mockReturnValue(redisMock);
    redisMock.ttl.mockRejectedValueOnce(new Error('redis down'));
    const { checkLockout } = await import('../../src/modules/auth/loginLockout.js');
    const r = await checkLockout('user');
    expect(r).toEqual({ locked: false });
  });

  it('Redis null (sin redis) → fallback in-memory directo', async () => {
    getRedisMock.mockReturnValue(null);
    const { checkLockout } = await import('../../src/modules/auth/loginLockout.js');
    const r = await checkLockout('user');
    expect(r).toEqual({ locked: false });
  });
});

describe('loginLockout — registerFailed (Redis primary)', () => {
  it('1er fallo: incr=1 → setea expire ATTEMPT_WINDOW_SEC=900s', async () => {
    getRedisMock.mockReturnValue(redisMock);
    redisMock.incr.mockResolvedValueOnce(1);
    redisMock.expire.mockResolvedValueOnce(1);
    const { registerFailed } = await import('../../src/modules/auth/loginLockout.js');
    await registerFailed('user');
    expect(redisMock.incr).toHaveBeenCalledWith('login:fail:user');
    expect(redisMock.expire).toHaveBeenCalledWith('login:fail:user', 900);
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it('5to fallo (MAX_ATTEMPTS) → bloquea por LOCK_DURATION_SEC=1800s y borra contador', async () => {
    getRedisMock.mockReturnValue(redisMock);
    redisMock.incr.mockResolvedValueOnce(5);
    redisMock.set.mockResolvedValueOnce('OK');
    redisMock.del.mockResolvedValueOnce(1);
    const { registerFailed } = await import('../../src/modules/auth/loginLockout.js');
    await registerFailed('user');
    expect(redisMock.set).toHaveBeenCalledWith('login:lock:user', '1', 'EX', 1800);
    expect(redisMock.del).toHaveBeenCalledWith('login:fail:user');
  });

  it('2-4to fallo: solo incr (no expire, no lock)', async () => {
    getRedisMock.mockReturnValue(redisMock);
    redisMock.incr.mockResolvedValueOnce(3);
    const { registerFailed } = await import('../../src/modules/auth/loginLockout.js');
    await registerFailed('user');
    expect(redisMock.expire).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it('Redis throws → fallback in-memory (no propaga)', async () => {
    getRedisMock.mockReturnValue(redisMock);
    redisMock.incr.mockRejectedValueOnce(new Error('redis down'));
    const { registerFailed } = await import('../../src/modules/auth/loginLockout.js');
    await expect(registerFailed('user')).resolves.toBeUndefined();
  });
});

describe('loginLockout — flujo end-to-end fallback in-memory (sin redis)', () => {
  it('5 fallos consecutivos → 6to checkLockout → locked', async () => {
    getRedisMock.mockReturnValue(null);
    const { registerFailed, checkLockout } = await import('../../src/modules/auth/loginLockout.js');

    for (let i = 0; i < 5; i++) await registerFailed('user');

    const r = await checkLockout('user');
    expect(r.locked).toBe(true);
    expect(r.remainingMins).toBeGreaterThan(0);
    expect(r.remainingMins).toBeLessThanOrEqual(30);
  });

  it('4 fallos no bloquean (umbral=5)', async () => {
    getRedisMock.mockReturnValue(null);
    const { registerFailed, checkLockout } = await import('../../src/modules/auth/loginLockout.js');
    for (let i = 0; i < 4; i++) await registerFailed('user');
    const r = await checkLockout('user');
    expect(r.locked).toBe(false);
  });

  it('clearLockout in-memory borra fails y locks', async () => {
    getRedisMock.mockReturnValue(null);
    const { registerFailed, clearLockout, checkLockout } = await import('../../src/modules/auth/loginLockout.js');
    for (let i = 0; i < 5; i++) await registerFailed('user');
    expect((await checkLockout('user')).locked).toBe(true);
    await clearLockout('user');
    expect((await checkLockout('user')).locked).toBe(false);
  });

  it('case-insensitive: USER y user comparten lockout', async () => {
    getRedisMock.mockReturnValue(null);
    const { registerFailed, checkLockout } = await import('../../src/modules/auth/loginLockout.js');
    for (let i = 0; i < 5; i++) await registerFailed('USER');
    expect((await checkLockout('user')).locked).toBe(true);
    expect((await checkLockout('UsEr')).locked).toBe(true);
  });

  it('usuarios distintos NO comparten contador', async () => {
    getRedisMock.mockReturnValue(null);
    const { registerFailed, checkLockout } = await import('../../src/modules/auth/loginLockout.js');
    for (let i = 0; i < 5; i++) await registerFailed('alice');
    // bob no afectado
    expect((await checkLockout('bob')).locked).toBe(false);
    expect((await checkLockout('alice')).locked).toBe(true);
  });
});

describe('loginLockout — clearLockout con redis', () => {
  it('llama del con AMBAS keys (fail + lock)', async () => {
    getRedisMock.mockReturnValue(redisMock);
    redisMock.del.mockResolvedValueOnce(2);
    const { clearLockout } = await import('../../src/modules/auth/loginLockout.js');
    await clearLockout('user');
    expect(redisMock.del).toHaveBeenCalledWith('login:fail:user', 'login:lock:user');
  });

  it('redis throws en del → fallback in-memory silencioso', async () => {
    getRedisMock.mockReturnValue(redisMock);
    redisMock.del.mockRejectedValueOnce(new Error('boom'));
    const { clearLockout } = await import('../../src/modules/auth/loginLockout.js');
    await expect(clearLockout('user')).resolves.toBeUndefined();
  });
});
