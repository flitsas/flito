import { test, expect } from '@playwright/test';
import { loginAs, ADMIN_USER } from '../helpers/auth';

// Jornadas — control de tiempos Decreto 1079/2015 (4h continuas, 10h jornada, 60h sem).
// Cubre vista conductor (MiJornada) + vista admin (JornadasConductor).

const CONDUCTOR_USER = {
  id: 5, username: 'e2e_conductor', name: 'Conductor E2E',
  role: 'conductor' as const, allowedPages: ['pesv'],
};

test.describe('Mi Jornada — vista conductor', () => {
  test('sin jornada activa muestra CTA "Iniciar jornada"', async ({ page }) => {
    await loginAs(page, CONDUCTOR_USER);
    // /jornadas/abierta retorna 404 cuando no hay jornada activa
    await page.route('**/api/jornadas/abierta', (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'sin_jornada' }) })
    );

    await page.goto('/pesv/mi-jornada');
    await expect(page.getByRole('heading', { name: /Mi Jornada/i })).toBeVisible();
    await expect(page.getByText(/Sin jornada activa/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Iniciar jornada/i })).toBeVisible();
  });

  test('con jornada activa muestra timer + pausas + cerrar', async ({ page }) => {
    await loginAs(page, CONDUCTOR_USER);
    const jornadaActiva = {
      id: 42, conductorId: 5, vehicleId: 99,
      inicioAt: '2026-05-07T07:00:00',
      finAt: null, horasConduccion: null, horasDescansoPre: '12.5',
      cerrada: false, pausas: [],
    };
    await page.route('**/api/jornadas/abierta', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(jornadaActiva) })
    );

    await page.goto('/pesv/mi-jornada');
    await expect(page.getByText(/Jornada en curso/i)).toBeVisible();
    // Botones de pausa visibles cuando NO hay pausa abierta
    await expect(page.getByRole('button', { name: /Pausa descanso/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Pausa comida/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Cerrar jornada/i })).toBeVisible();
    // Datos de la jornada
    await expect(page.getByText(/Descanso previo: 12\.5h/i)).toBeVisible();
    await expect(page.getByText(/Veh[íi]culo: #99/i)).toBeVisible();
  });

  test('pausa abierta solo muestra "Cerrar pausa"', async ({ page }) => {
    await loginAs(page, CONDUCTOR_USER);
    const jornadaConPausa = {
      id: 43, conductorId: 5, vehicleId: null,
      inicioAt: '2026-05-07T07:00:00', finAt: null,
      horasConduccion: null, horasDescansoPre: null, cerrada: false,
      pausas: [{ id: 1, motivo: 'descanso', inicioAt: '2026-05-07T09:00:00', finAt: null, duracionMin: null }],
    };
    await page.route('**/api/jornadas/abierta', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(jornadaConPausa) })
    );

    await page.goto('/pesv/mi-jornada');
    // CTAs de pausa NO visibles cuando hay pausa abierta
    await expect(page.getByRole('button', { name: /Pausa descanso/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Cerrar pausa/i })).toBeVisible();
  });
});

test.describe('Jornadas — vista admin', () => {
  test('admin lista jornadas con estados', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    const fixture = [
      { id: 100, conductorId: 5, vehicleId: 1, inicioAt: '2026-05-07T07:00:00', finAt: null,
        horasConduccion: null, horasDescansoPre: '10', cerrada: false, cerradaAutomatica: false },
      { id: 101, conductorId: 6, vehicleId: 2, inicioAt: '2026-05-06T06:00:00', finAt: '2026-05-06T16:00:00',
        horasConduccion: '9.5', horasDescansoPre: '11', cerrada: true, cerradaAutomatica: false },
      { id: 102, conductorId: 7, vehicleId: 3, inicioAt: '2026-05-05T05:00:00', finAt: '2026-05-05T21:30:00',
        horasConduccion: '15.0', horasDescansoPre: '8', cerrada: true, cerradaAutomatica: true },
    ];
    await page.route('**/api/jornadas**', (route) => {
      const url = route.request().url();
      // Excluye detalle /:id y subrecursos
      if (/\/jornadas\/\d+($|\?)/.test(url)) return route.continue();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: fixture }) });
    });

    await page.goto('/pesv/jornadas');
    await expect(page.getByRole('heading', { name: /Control de Jornada/i })).toBeVisible();
    await expect(page.getByText(/En curso/i).first()).toBeVisible();
    await expect(page.getByText(/Cierre auto/i)).toBeVisible();
    await expect(page.getByText(/^Cerrada$/i).first()).toBeVisible();
  });

  test('detalle jornada muestra pausas y alarma sin ack', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    const lista = [
      { id: 200, conductorId: 5, vehicleId: 1, inicioAt: '2026-05-07T05:00:00', finAt: '2026-05-07T20:00:00',
        horasConduccion: '14.0', horasDescansoPre: '7', cerrada: true, cerradaAutomatica: false },
    ];
    const detalle = {
      ...lista[0],
      pausas: [
        { id: 1, motivo: 'comida', inicioAt: '2026-05-07T12:00:00', finAt: '2026-05-07T12:45:00', duracionMin: 45 },
      ],
      alarmas: [
        { id: 11, jornadaId: 200, tipo: 'mas_10h_jornada', valorObservado: '14.0', valorLimite: '10',
          unidad: 'h', ackAt: null, generadaAt: '2026-05-07T20:00:00' },
        { id: 12, jornadaId: 200, tipo: 'menos_8h_descanso', valorObservado: '7', valorLimite: '8',
          unidad: 'h', ackAt: '2026-05-07T20:30:00', generadaAt: '2026-05-07T20:00:00' },
      ],
    };
    // Único handler que distingue lista vs detalle por path — Playwright usa el último
    // route registrado, así que evitamos colisiones manejando todo en un solo callback.
    await page.route('**/api/jornadas**', (route) => {
      const url = route.request().url();
      if (/\/jornadas\/\d+($|\?)/.test(url)) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detalle) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: lista }) });
    });

    await page.goto('/pesv/jornadas');
    await page.getByRole('button', { name: /^Ver$/ }).first().click();
    await expect(page.getByRole('heading', { name: /Jornada #200/i })).toBeVisible();
    await expect(page.getByText(/Pausas \(1\)/i)).toBeVisible();
    await expect(page.getByText(/Jornada total > 10h/i)).toBeVisible();
    // Alarma no-ack tiene CTA "Reconocer"
    await expect(page.getByRole('button', { name: /Reconocer/i })).toBeVisible();
    // Alarma ack muestra fecha de ack en lugar del botón
    await expect(page.getByText(/Ack 2026-05-07/i)).toBeVisible();
  });

  test('empty state se muestra sin jornadas', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await page.route('**/api/jornadas**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) })
    );

    await page.goto('/pesv/jornadas');
    await expect(page.getByText(/Sin jornadas/i)).toBeVisible();
  });
});
