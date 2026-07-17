// OPS-02b r3: mock KEYED por tabla.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
const { execute: executeMock } = kdb;

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const withLockMock = vi.fn();
vi.mock('../../src/shared/utils/lock.js', () => ({
  withLock: withLockMock,
}));

beforeEach(() => {
  kdb.reset();
  executeMock.mockReset();
  withLockMock.mockReset();
  withLockMock.mockImplementation(async (_n: string, _t: number, fn: any) => fn());
});

describe('maintenance/schedule.cron — runScheduleOnce', () => {
  it('lock NO obtenido → ceros en todas las stats', async () => {
    withLockMock.mockResolvedValueOnce(null);
    const { runScheduleOnce } = await import('../../src/modules/maintenance/schedule.cron.js');
    const r = await runScheduleOnce();
    expect(r).toEqual({
      vehiculos: 0, rutinas_evaluadas: 0,
      schedules_creados: 0, schedules_actualizados: 0,
      vencidas_marcadas: 0,
    });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('vencidas: marca pendientes con fecha + 7 días en el pasado', async () => {
    // 1) UPDATE vencidas → 3 ids
    executeMock.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    // 2) SELECT vehículos → 0 vehículos
    executeMock.mockResolvedValueOnce({ rows: [] });

    const { runScheduleOnce } = await import('../../src/modules/maintenance/schedule.cron.js');
    const r = await runScheduleOnce();

    expect(r.vencidas_marcadas).toBe(3);
    expect(r.vehiculos).toBe(0);
    expect(r.rutinas_evaluadas).toBe(0);
  });

  it('vehículo con km_periodo + dias_periodo → MIN entre fecha estimada y fecha por días', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] }); // vencidas
    executeMock.mockResolvedValueOnce({ rows: [{
      id: 5, tipo_vehiculo: 'camion', combustible: 'diesel',
      promedio_dia: 200, odom_actual: 50000,
    }] }); // vehículos
    executeMock.mockResolvedValueOnce({ rows: [{
      routine_id: 10, km_periodo: 5000, horas_periodo: null, dias_periodo: 90,
    }] }); // rutinas
    executeMock.mockResolvedValueOnce({ rows: [] }); // ult_exec vacío
    executeMock.mockResolvedValueOnce({ rows: [{ inserted: true }] }); // upsert

    const { runScheduleOnce } = await import('../../src/modules/maintenance/schedule.cron.js');
    const r = await runScheduleOnce();

    expect(r.vehiculos).toBe(1);
    expect(r.rutinas_evaluadas).toBe(1);
    expect(r.schedules_creados).toBe(1);
    expect(r.schedules_actualizados).toBe(0);
  });

  it('rutina sin km_periodo ni dias_periodo → no crea schedule (continue)', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] }); // vencidas
    executeMock.mockResolvedValueOnce({ rows: [{
      id: 6, tipo_vehiculo: 'auto', combustible: 'gasolina',
      promedio_dia: 100, odom_actual: 10000,
    }] });
    executeMock.mockResolvedValueOnce({ rows: [{
      routine_id: 20, km_periodo: null, horas_periodo: null, dias_periodo: null,
    }] });
    executeMock.mockResolvedValueOnce({ rows: [] }); // ult_exec
    // No hay 5to call (continue saltea el upsert)

    const { runScheduleOnce } = await import('../../src/modules/maintenance/schedule.cron.js');
    const r = await runScheduleOnce();

    expect(r.rutinas_evaluadas).toBe(1);
    expect(r.schedules_creados).toBe(0);
    expect(r.schedules_actualizados).toBe(0);
  });

  it('upsert con xmax!=0 (UPDATE existente) → cuenta como actualizado, no creado', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] }); // vencidas
    executeMock.mockResolvedValueOnce({ rows: [{
      id: 7, tipo_vehiculo: 'auto', combustible: 'gasolina',
      promedio_dia: 100, odom_actual: 5000,
    }] });
    executeMock.mockResolvedValueOnce({ rows: [{
      routine_id: 30, km_periodo: 1000, horas_periodo: null, dias_periodo: null,
    }] });
    executeMock.mockResolvedValueOnce({ rows: [] }); // ult_exec
    executeMock.mockResolvedValueOnce({ rows: [{ inserted: false }] }); // upsert UPDATE

    const { runScheduleOnce } = await import('../../src/modules/maintenance/schedule.cron.js');
    const r = await runScheduleOnce();

    expect(r.schedules_creados).toBe(0);
    expect(r.schedules_actualizados).toBe(1);
  });

  it('múltiples vehículos → suma rutinas_evaluadas correctamente', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] }); // vencidas
    executeMock.mockResolvedValueOnce({ rows: [
      { id: 1, tipo_vehiculo: 'auto', combustible: 'gasolina', promedio_dia: 100, odom_actual: 1000 },
      { id: 2, tipo_vehiculo: 'auto', combustible: 'gasolina', promedio_dia: 150, odom_actual: 2000 },
    ] });
    // Vehículo 1: 2 rutinas
    executeMock.mockResolvedValueOnce({ rows: [
      { routine_id: 100, km_periodo: 1000, horas_periodo: null, dias_periodo: null },
      { routine_id: 101, km_periodo: null, horas_periodo: null, dias_periodo: 60 },
    ] });
    executeMock.mockResolvedValueOnce({ rows: [] }); // ult_exec rutina 100 v1
    executeMock.mockResolvedValueOnce({ rows: [{ inserted: true }] }); // upsert
    executeMock.mockResolvedValueOnce({ rows: [] }); // ult_exec rutina 101 v1
    executeMock.mockResolvedValueOnce({ rows: [{ inserted: true }] });
    // Vehículo 2: 1 rutina
    executeMock.mockResolvedValueOnce({ rows: [
      { routine_id: 200, km_periodo: 500, horas_periodo: null, dias_periodo: null },
    ] });
    executeMock.mockResolvedValueOnce({ rows: [] }); // ult_exec rutina 200 v2
    executeMock.mockResolvedValueOnce({ rows: [{ inserted: false }] });

    const { runScheduleOnce } = await import('../../src/modules/maintenance/schedule.cron.js');
    const r = await runScheduleOnce();

    expect(r.vehiculos).toBe(2);
    expect(r.rutinas_evaluadas).toBe(3);
    expect(r.schedules_creados).toBe(2);
    expect(r.schedules_actualizados).toBe(1);
  });

  it('promedio_dia=null en vehículo → usa default 100', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({ rows: [{
      id: 8, tipo_vehiculo: 'auto', combustible: 'gasolina',
      promedio_dia: null, odom_actual: 0,
    }] });
    executeMock.mockResolvedValueOnce({ rows: [{
      routine_id: 40, km_periodo: 1000, horas_periodo: null, dias_periodo: null,
    }] });
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({ rows: [{ inserted: true }] });

    const { runScheduleOnce } = await import('../../src/modules/maintenance/schedule.cron.js');
    const r = await runScheduleOnce();

    expect(r.schedules_creados).toBe(1);
    // Si default no aplicara, división por 0 → NaN → no crearía
  });
});
