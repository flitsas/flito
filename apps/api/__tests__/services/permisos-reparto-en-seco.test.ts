// HU #13421 (ADR-0023 §D4, AC6) — El núcleo puro del reporte en seco: simula las filas propuestas,
// resuelve `(R ∪ C) \ V` como el motor y dice, por ruta, quién gana y quién pierde, con `user_id` + rol.
import { describe, it, expect } from 'vitest';
import {
  efectivas, informeMarkdown, repartoEnSeco, simularPropuesta,
  type EntradaEnSeco, type FilaRolEnSeco, type FilaUsuarioEnSeco, type UsuarioEnSeco,
} from '../../src/modules/permisos/reparto-en-seco.js';

const USUARIOS: UsuarioEnSeco[] = [
  { id: 1, rol: 'admin' },
  { id: 2, rol: 'lider_pesv' },
  { id: 3, rol: 'conductor' },
  { id: 4, rol: 'conductor' },   // revocado de pagina.pesv por excepción
  { id: 5, rol: 'transito' },    // concedido pagina.pesv por excepción
  { id: 6, rol: 'compliance' },  // tiene pesv_raci pero NO pesv (panel editado)
];
const FILAS_ROL: FilaRolEnSeco[] = [
  { rol: 'admin', codigo: 'pagina.pesv' }, { rol: 'lider_pesv', codigo: 'pagina.pesv' },
  { rol: 'conductor', codigo: 'pagina.pesv' },
  { rol: 'admin', codigo: 'pagina.pesv_raci' }, { rol: 'compliance', codigo: 'pagina.pesv_raci' },
];
const FILAS_USR: FilaUsuarioEnSeco[] = [
  { userId: 4, codigo: 'pagina.pesv', efecto: 'revocar' },
  { userId: 5, codigo: 'pagina.pesv', efecto: 'conceder' },
];
const PROPUESTA = {
  copias: [{ origen: 'pagina.pesv', destinos: ['pagina.pesv_comite'] }],
  literales: [
    { rol: 'admin', codigo: 'pagina.pesv_comite' },
    { rol: 'admin', codigo: 'pesv.comite.administrar' }, { rol: 'lider_pesv', codigo: 'pesv.comite.administrar' },
  ],
};

function entrada(over: Partial<EntradaEnSeco> = {}): EntradaEnSeco {
  return {
    usuarios: USUARIOS, filasRol: FILAS_ROL, filasUsuario: FILAS_USR, propuesta: PROPUESTA,
    rutas: [
      { llave: 'comite GET /', antes: { codigos: ['pagina.pesv'] }, despues: { codigos: ['pagina.pesv_comite'] } },
      {
        llave: 'comite POST /',
        antes: { codigos: ['pagina.pesv'], roles: ['admin', 'lider_pesv'] },
        despues: { codigos: ['pagina.pesv_comite', 'pesv.comite.administrar'] },
      },
    ],
    ...over,
  };
}

describe('reparto en seco — simulación y resolutor', () => {
  it('la copia viva lleva roles Y excepciones (con su efecto) a cada destino; los literales se suman sin duplicar', () => {
    const sim = simularPropuesta(FILAS_ROL, FILAS_USR, PROPUESTA);
    const comite = sim.filasRol.filter((f) => f.codigo === 'pagina.pesv_comite').map((f) => f.rol).sort();
    expect(comite).toEqual(['admin', 'conductor', 'lider_pesv']);
    expect(sim.filasUsuario.filter((f) => f.codigo === 'pagina.pesv_comite')).toEqual([
      { userId: 4, codigo: 'pagina.pesv_comite', efecto: 'revocar' },
      { userId: 5, codigo: 'pagina.pesv_comite', efecto: 'conceder' },
    ]);
  });

  it('resuelve (R ∪ C) \\ V como el motor', () => {
    const e = efectivas(USUARIOS, FILAS_ROL, FILAS_USR);
    expect(e.get(3)!.has('pagina.pesv')).toBe(true);
    expect(e.get(4)!.has('pagina.pesv')).toBe(false);
    expect(e.get(5)!.has('pagina.pesv')).toBe(true);
  });
});

describe('reparto en seco — el diff por ruta (AC6)', () => {
  it('con copia viva + lista literal del requireRole: PARIDAD (nadie gana ni pierde), excepciones incluidas', () => {
    const i = repartoEnSeco(entrada());
    expect(i.diferencias).toBe(0);
    expect(i.rutas.map((r) => [r.llave, r.antes, r.despues])).toEqual([['comite GET /', 4, 4], ['comite POST /', 2, 2]]);
    expect(informeMarkdown(i, 'prueba')).toMatch(/## 5\. Veredicto: PARIDAD/);
  });

  it('una lista literal más ancha que el requireRole se ve como GANANCIA, con user_id y rol (fail-closed visible)', () => {
    const i = repartoEnSeco(entrada({
      propuesta: { ...PROPUESTA, literales: [...PROPUESTA.literales, { rol: 'conductor', codigo: 'pesv.comite.administrar' }] },
    }));
    expect(i.rutas[1]!.ganan).toEqual({ conductor: 1 });
    expect(i.detalle).toEqual([{ llave: 'comite POST /', userId: 3, rol: 'conductor', cambio: 'gana' }]);
    expect(informeMarkdown(i, 'x')).toMatch(/DIFERENCIAS \(1\)/);
  });

  it('una intersección que deja fuera a un rol se ve como PÉRDIDA', () => {
    const i = repartoEnSeco(entrada({
      propuesta: { ...PROPUESTA, literales: PROPUESTA.literales.filter((f) => f.rol !== 'lider_pesv') },
    }));
    expect(i.rutas[1]!.pierden).toEqual({ lider_pesv: 1 });
    expect(i.detalle).toEqual([{ llave: 'comite POST /', userId: 2, rol: 'lider_pesv', cambio: 'pierde' }]);
  });

  it('quitar la guarda de router filtrada (raci pedía también pagina.pesv) se ve como ganancia del que solo tenía pesv_raci', () => {
    const i = repartoEnSeco(entrada({
      rutas: [{ llave: 'raci GET /', antes: { codigos: ['pagina.pesv', 'pagina.pesv_raci'] }, despues: { codigos: ['pagina.pesv_raci'] } }],
    }));
    expect(i.detalle).toEqual([{ llave: 'raci GET /', userId: 6, rol: 'compliance', cambio: 'gana' }]);
  });

  it('con el recorte del Paso 3b (0227): raci queda en la intersección con pagina.pesv → PARIDAD, revocado y concedido por excepción incluidos', () => {
    const usuarios: UsuarioEnSeco[] = [...USUARIOS, { id: 7, rol: 'compliance' }, { id: 8, rol: 'compliance' }];
    const filasUsuario: FilaUsuarioEnSeco[] = [
      ...FILAS_USR,
      { userId: 7, codigo: 'pagina.pesv', efecto: 'conceder' },   // compliance con pesv propio: SÍ pasaba
      { userId: 5, codigo: 'pagina.pesv_raci', efecto: 'conceder' }, // transito con pesv concedido: SÍ pasaba
      { userId: 3, codigo: 'pagina.pesv_raci', efecto: 'conceder' }, // conductor: tenía pesv por rol: SÍ pasaba
      { userId: 4, codigo: 'pagina.pesv_raci', efecto: 'conceder' }, // conductor con pesv REVOCADO: NO pasaba
    ];
    const raci = { llave: 'raci GET /', antes: { codigos: ['pagina.pesv', 'pagina.pesv_raci'] }, despues: { codigos: ['pagina.pesv_raci'] } };
    const recortes = [{ paginas: ['pagina.pesv_raci'], requisito: 'pagina.pesv' }];
    const sinRecorte = repartoEnSeco(entrada({ usuarios, filasUsuario, rutas: [raci] }));
    expect(sinRecorte.detalle.map((d) => d.userId).sort()).toEqual([4, 6, 8]);
    const conRecorte = repartoEnSeco(entrada({ usuarios, filasUsuario, rutas: [raci], propuesta: { ...PROPUESTA, recortes } }));
    expect(conRecorte.diferencias).toBe(0);
    expect(conRecorte.rutas[0]!.despues).toBe(conRecorte.rutas[0]!.antes);
    expect(conRecorte.rutas[0]!.antes).toBe(4); // 1 (admin), 3 y 5 (raci propia), 7 (pesv propio); 2 no tiene raci
  });

  it('el Markdown no lleva PII: solo user_id y rol en el detalle', () => {
    const md = informeMarkdown(repartoEnSeco(entrada({
      propuesta: { ...PROPUESTA, literales: [...PROPUESTA.literales, { rol: 'conductor', codigo: 'pesv.comite.administrar' }] },
    })), 'x');
    expect(md).toMatch(/\| `comite POST \/` \| 3 \| conductor \| gana \|/);
    expect(md).not.toMatch(/@|nombre|correo|cedula|cédula/i);
  });
});
