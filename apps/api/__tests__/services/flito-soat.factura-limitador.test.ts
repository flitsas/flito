// FLITO SOAT — limitador de intentos de contraseña de PDF cifrado (Bug #14569). Archivo aparte de
// flito-soat.factura.test.ts porque `soatPdfContrasenaLimiter` es un singleton con store en memoria
// (Redis mockeado a null): los intentos con clave de aquel archivo gastarían el cupo de estos tests.
// Además, cada test usa un `sub` propio, así la llave del limitador (`soat-pdf-clave:-<sub>`) no se
// comparte entre tests. Las peticiones van sin archivo: el limitador corre después de multer y antes
// del 400 «falta el archivo», así que cuentan sin tocar BD ni OCR.

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { testToken } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), update: vi.fn(), insert: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: vi.fn() }));

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', conAlcance('soat', router));
  return app;
}
const auth = async (sub: number) => `Bearer ${await testToken({ sub, username: `gestor${sub}@x.io`, role: 'admin' as never })}`;
const UUID = '00000000-0000-0000-0000-000000000001';
const CLAVE = '1032456789'; // como una cédula: no puede volver en la respuesta del freno
const MENSAJE = { error: 'Demasiados intentos de contraseña seguidos. Espera unos minutos e intenta de nuevo.' };

describe('soatPdfContrasenaLimiter — 10 intentos con clave por 15 min y usuario (Bug #14569)', () => {
  it('las cargas SIN contraseña no gastan cupo: 12 seguidas nunca dan 429', async () => {
    const app = await buildApp();
    const a = await auth(9101);
    const estados: number[] = [];
    for (let i = 0; i < 6; i++) {
      estados.push((await request(app).post(`/api/flito/soat/${UUID}/factura`).set('Authorization', a)).status);
      estados.push((await request(app).post('/api/flito/soat/facturas').set('Authorization', a)).status);
    }
    expect(estados).toEqual(Array(12).fill(400)); // el 400 de «falta el archivo», nunca el freno
  });

  it('con contraseña, el intento 11 en la ventana → 429 con el mensaje del limitador y sin repetir la clave (cupo compartido entre individual y masiva)', async () => {
    const app = await buildApp();
    const a = await auth(9102);
    const estados: number[] = [];
    for (let i = 0; i < 5; i++) {
      estados.push((await request(app).post(`/api/flito/soat/${UUID}/factura`).set('Authorization', a).field('contrasena', CLAVE)).status);
      estados.push((await request(app).post('/api/flito/soat/facturas').set('Authorization', a).field('contrasenas', JSON.stringify([CLAVE]))).status);
    }
    expect(estados).toEqual(Array(10).fill(400));

    const r = await request(app).post(`/api/flito/soat/${UUID}/factura`).set('Authorization', a).field('contrasena', CLAVE);
    expect(r.status).toBe(429);
    expect(r.body).toEqual(MENSAJE);
    expect(JSON.stringify(r.body)).not.toContain(CLAVE);

    // Otro usuario no hereda el freno: la llave es por usuario.
    const otro = await request(app).post(`/api/flito/soat/${UUID}/factura`).set('Authorization', await auth(9103)).field('contrasena', CLAVE);
    expect(otro.status).toBe(400);
  });
});

describe('soatPdfNombreClaveLimiter — 60 peticiones con nombre como clave por 15 min y usuario (punto 10)', () => {
  const MENSAJE_NOMBRE = { error: 'Demasiados intentos de abrir PDFs protegidos con el nombre del archivo. Espera unos minutos e intenta de nuevo.' };

  it('la 61.ª petición con nombre → 429 (cupo compartido: flag de la individual + `true` en nombresComoClave de la masiva); otro usuario no lo hereda', async () => {
    const app = await buildApp();
    const a = await auth(9201);
    const estados: number[] = [];
    for (let i = 0; i < 30; i++) {
      estados.push((await request(app).post(`/api/flito/soat/${UUID}/factura`).set('Authorization', a).field('usarNombreComoClave', 'true')).status);
      estados.push((await request(app).post('/api/flito/soat/facturas').set('Authorization', a).field('nombresComoClave', JSON.stringify([false, true]))).status);
    }
    expect(estados).toEqual(Array(60).fill(400));
    const r = await request(app).post('/api/flito/soat/facturas').set('Authorization', a).field('nombresComoClave', JSON.stringify([true]));
    expect(r.status).toBe(429);
    expect(r.body).toEqual(MENSAJE_NOMBRE);
    const otro = await request(app).post(`/api/flito/soat/${UUID}/factura`).set('Authorization', await auth(9202)).field('usarNombreComoClave', 'true');
    expect(otro.status).toBe(400);
  });

  it('las peticiones solo con el flag NO gastan el cupo de contraseñas: tras 15, las 10 con clave siguen pasando', async () => {
    const app = await buildApp();
    const a = await auth(9203);
    for (let i = 0; i < 15; i++) {
      expect((await request(app).post(`/api/flito/soat/${UUID}/factura`).set('Authorization', a).field('usarNombreComoClave', 'true')).status).toBe(400);
    }
    const conClave: number[] = [];
    for (let i = 0; i < 10; i++) {
      conClave.push((await request(app).post(`/api/flito/soat/${UUID}/factura`).set('Authorization', a).field('contrasena', CLAVE)).status);
    }
    expect(conClave).toEqual(Array(10).fill(400));
    const r = await request(app).post(`/api/flito/soat/${UUID}/factura`).set('Authorization', a).field('contrasena', CLAVE);
    expect(r.status).toBe(429);
    expect(r.body).toEqual(MENSAJE);
  });

  it('sin pedir nombre no cuenta: flag «false», nombresComoClave todo false, mal formado o ausente → 65 seguidas sin 429', async () => {
    const app = await buildApp();
    const a = await auth(9204);
    const estados: number[] = [];
    const variantes: (Record<string, string>)[] = [{}, { usarNombreComoClave: 'false' }, { nombresComoClave: JSON.stringify([false, false]) }, { nombresComoClave: 'no-json' }];
    for (let i = 0; i < 65; i++) {
      let req = request(app).post('/api/flito/soat/facturas').set('Authorization', a);
      for (const [k, v] of Object.entries(variantes[i % variantes.length])) req = req.field(k, v);
      estados.push((await req).status);
    }
    expect(estados.every((s) => s === 400)).toBe(true);
  });
});
