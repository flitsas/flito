// HU #13429 AC3 / AC9 / AC10 — El reporte en seco de la 0239 (`--hu 13429`), puro: sobre la partida plegada de las
// migraciones 0001..0237 (un usuario sintético por rol) y sobre usuarios con excepciones. TCs TC-09 y TC-20.
// Los usuarios son sintéticos (ids, sin nombres ni documentos): el informe no saca PII.
//
// Mutante nombrado: quitar el paso C3 (cadena de los `conceder` de usuario) → cae «el conceder de una acción sin su
// ítem recibe el ítem y no pierde».
import { describe, it, expect } from 'vitest';
import { informeLegado, informeLegadoMarkdown, repartirLegado } from '../../src/modules/permisos/arbol/reparto-legado.js';
import type { FilaRolEnSeco, FilaUsuarioEnSeco, UsuarioEnSeco } from '../../src/modules/permisos/reparto-en-seco.js';
import { MIGRACIONES_CON_REPARTO, leerFuncionesSembradas, leerRepartoSembrado } from '../helpers/permisos-seed-sql.js';

const ANTES_0238 = MIGRACIONES_CON_REPARTO.filter((m) => m < '0238');
const PARTIDA = leerRepartoSembrado(ANTES_0238);
const EXISTENTES = new Set(leerFuncionesSembradas(ANTES_0238).keys());
const filasRol: FilaRolEnSeco[] = [...PARTIDA].flatMap(([rol, cs]) => [...cs].map((codigo) => ({ rol, codigo })));
const usuarios: UsuarioEnSeco[] = [...PARTIDA.keys()].sort().map((rol, i) => ({ id: 100 + i, rol }));

describe('TC-20 — partida del pliegue: 0 pérdidas, solo ganancias aprobadas, veredicto PARIDAD', () => {
  const informe = informeLegado(usuarios, { filasRol, filasUsuario: [] }, EXISTENTES);

  it('ningún rol ni usuario pierde; ninguna ganancia fuera de AC3 y P-30', () => {
    expect(informe.perdidas).toBe(0);
    expect(informe.noAprobadas).toBe(0);
  });

  it('TC-09: las ganancias de administración antigua salen por rol (conductor 0; supervisor_flota 24; compliance 31)', () => {
    const gana = (rol: string) => informe.roles.find((r) => r.rol === rol)!.gana;
    expect(gana('conductor')).toEqual([]);
    expect(gana('supervisor_flota')).toHaveLength(24);
    expect(gana('compliance')).toHaveLength(31);
    expect(gana('mensajero')).toEqual(['pagina.flito_logistica']);
    expect(informe.sembrado.find((s) => s.rol === 'conductor')!.codigos).toEqual(['menu.general', 'menu.perfil', 'menu.pesv']);
  });

  it('el informe en Markdown separa pérdidas, ganancias AC3 y visibilidad, y da el veredicto', () => {
    const md = informeLegadoMarkdown(informe, 'prueba');
    expect(md).toMatch(/## 1\. Por rol/);
    expect(md).toMatch(/Gana AC3 \(transitorio retirado\)/);
    expect(md).toMatch(/## 4\. Veredicto: PARIDAD/);
  });

  it('AC10: aplicada otra vez sobre su propio resultado (segunda corrida) no cambia nada', () => {
    const una = repartirLegado(usuarios, { filasRol, filasUsuario: [] }, EXISTENTES);
    const existentesDespues = new Set([...EXISTENTES].filter((c) => !/\.administrar$/.test(c) || c.startsWith('accion.')));
    const dos = repartirLegado(usuarios, una, existentesDespues);
    const pares = (f: FilaRolEnSeco[]) => f.map((x) => `${x.rol} ${x.codigo}`).sort();
    expect(pares(dos.filasRol)).toEqual(pares(una.filasRol));
  });
});

describe('Usuarios con excepciones', () => {
  const u = (id: number, rol: string): UsuarioEnSeco => ({ id, rol });
  const run = (us: UsuarioEnSeco[], propias: FilaUsuarioEnSeco[]) => informeLegado(us, { filasRol, filasUsuario: propias }, EXISTENTES);

  it('`conceder` de una operación antigua sin su ítem → recibe el ítem (y su elemento) y no pierde', () => {
    const i = run([u(1, 'mensajero')], [{ userId: 1, codigo: 'fleet.flota.administrar', efecto: 'conceder' }]);
    // Lo único nuevo para él es VER la pantalla de lo que ya hacía por API (visibilidad, no administración).
    // (y lo de su rol: Logística, P-30).
    expect(i.usuarios).toEqual([{ userId: 1, rol: 'mensajero', pierde: [], gana: ['pagina.fleet', 'pagina.flito_logistica'] }]);
    expect(i.noAprobadas).toBe(0);
    const filas = repartirLegado([u(1, 'mensajero')], { filasRol, filasUsuario: [{ userId: 1, codigo: 'fleet.flota.administrar', efecto: 'conceder' }] }, EXISTENTES).filasUsuario;
    expect(filas.map((f) => `${f.codigo} ${f.efecto}`).sort()).toEqual(['menu.flota conceder', 'pagina.fleet conceder']);
  });

  it('`revocar` del único transitorio PESV: la regla de dato (A1) se aplica a SU conjunto y no gana la administración PESV', () => {
    const propias: FilaUsuarioEnSeco[] = [{ userId: 2, codigo: 'pesv.diagnostico_consulta.administrar', efecto: 'revocar' }];
    const i = run([u(2, 'compliance')], propias);
    expect(i.usuarios[0]!.pierde).toEqual([]);
    expect(i.usuarios[0]!.gana.filter((g) => /^(pesv|drivers|jornadas|rutas)\./.test(g))).toEqual([]);
    const despues = repartirLegado([u(2, 'compliance')], { filasRol, filasUsuario: propias }, EXISTENTES).filasUsuario;
    expect(despues.filter((f) => f.efecto === 'revocar').every((f) => /^accion\.pesv_[a-z_]+\.administrar$/.test(f.codigo))).toBe(true);
  });

  it('`revocar` de un transitorio no PESV desaparece con él: el usuario GANA la administración por el ítem (AC3)', () => {
    const i = run([u(4, 'admin')], [{ userId: 4, codigo: 'fleet.flota.administrar', efecto: 'revocar' }]);
    expect(i.usuarios[0]!.gana).toEqual(['fleet.flota.administrar']);
    expect(i.noAprobadas).toBe(0);
  });

  it('un ancestro REVOCADO al usuario no se toca: la pérdida queda declarada en el reporte', () => {
    const i = run([u(3, 'transito')], [{ userId: 3, codigo: 'menu.transito', efecto: 'revocar' }]);
    expect(i.perdidas).toBeGreaterThan(0);
    expect(i.usuarios[0]!.pierde).toContain('transito.bandeja.ver_pendientes');
  });
});
