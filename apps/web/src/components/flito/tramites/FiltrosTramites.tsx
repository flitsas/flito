// FLITO — Gestión Trámites: búsqueda y filtros en acordeón (Épica #14707, bloque 4; UX §5.4, R1/R8/R10–R12).
//
// Fila del encabezado, siempre visible: [› Filtros (n)] [buscador] [Vistas rápidas] [Columnas · Orden] (ajustes
// 14707: Columnas y Orden suben aquí desde la barra de la tabla, que ya no existe sin selección). Desplegado: rejilla
// simétrica de 10 `CampoFiltro` (Creado · Aprobado · Trámite · SOAT · Impuestos / Fuente · Autogestión ·
// Empresa gestora · Tránsito · Ciudad) y, si hay algo puesto, el pie con los aplicados y «Limpiar filtros».
// Se aplican en vivo. El acordeón se pliega en cada visita (estado local) y sigue abierto mientras se esté en
// la página. Sin `empresasOpc` (usuario con enlace, HU #13452) la celda Empresa gestora no se pinta.
import { useId, useState, type ReactNode } from 'react';
import {
  ALERTA_OPERATIVA_LABEL, ESTADO_IMPUESTO_LABEL, ESTADO_SOAT_LABEL, ESTADOS_IMPUESTO_OPERATIVOS, ESTADOS_SOAT_OPERATIVOS,
  type EstadoImpuesto, type EstadoSoat, type FuenteTramite,
} from '@operaciones/shared-types';
import CampoFiltro, { campoPuesto, textoCampo, type CampoFiltroProps, type OpcionFiltro } from '../../flit/CampoFiltro';
import { claseBoton } from '../../flit/GradientButton';
import { OPCIONES_FUENTE } from '../../flito-tramites/FuenteTramite';
import { PRESET_RECIEN_LLEGADOS, type Autogestion, type EstadoFiltrosTramites } from './useFiltrosTramites';

const aOpc = (vs: string[]): OpcionFiltro[] => vs.map((v) => ({ value: v, label: v }));
// Épica #14707: los filtros ofrecen solo los estados OPERATIVOS (sin `descartado`).
const SOAT_OPC: OpcionFiltro[] = ESTADOS_SOAT_OPERATIVOS.map((e) => ({ value: e, label: ESTADO_SOAT_LABEL[e] }));
const IMP_OPC: OpcionFiltro[] = ESTADOS_IMPUESTO_OPERATIVOS.map((e) => ({ value: e, label: ESTADO_IMPUESTO_LABEL[e] }));
const FUENTE_OPC: OpcionFiltro[] = OPCIONES_FUENTE.map((o) => ({ value: o.valor, label: o.etiqueta }));
const AUTOG_OPC: OpcionFiltro[] = [
  { value: '', label: 'Todas' }, { value: 'si', label: 'Autogestionadas' }, { value: 'no', label: 'No autogestionadas' },
];

export interface FacetasTramites { estados: string[]; ciudades: string[]; transitos: string[] }

/** Texto del chip del pie: «SOAT: Pendiente», «SOAT: Pendiente, Pagado», «Tránsito: 3 seleccionados». */
function textoChip(c: CampoFiltroProps): string {
  if (c.tipo === 'multi' && c.seleccion.length === 2) {
    return c.seleccion.map((v) => c.opciones.find((o) => o.value === v)?.label ?? v).join(', ');
  }
  return textoCampo(c, true);
}

function quitar(c: CampoFiltroProps) {
  if (c.tipo === 'multi') c.onCambio([]);
  else if (c.tipo === 'unica') c.onCambio('');
  else c.onCambio({ desde: '', hasta: '' });
}

const iconoCerrar = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export default function FiltrosTramites({ f, facetas, empresasOpc, herramientas }: {
  f: EstadoFiltrosTramites;
  /** «Columnas» y «Orden»: al final de la fila del encabezado, con la misma altura (40 px). */
  herramientas?: ReactNode;
  facetas: FacetasTramites;
  /** Compañías de parametrización; `null` = usuario con enlace (sin celda Empresa gestora). */
  empresasOpc: { nit: string; nombre: string }[] | null;
}) {
  const [abierto, setAbierto] = useState(false);
  const idCuerpo = useId();

  const campos: CampoFiltroProps[] = [
    { tipo: 'fechas', rotulo: 'Creado', valor: f.creado, onCambio: f.setCreado },
    { tipo: 'fechas', rotulo: 'Aprobado', valor: f.aprobado, onCambio: f.setAprobado },
    { tipo: 'multi', rotulo: 'Trámite', opciones: aOpc(facetas.estados), seleccion: f.estadosSel, onCambio: f.setEstadosSel, todos: 'Todos', nombreGrupo: 'Estados del trámite' },
    { tipo: 'multi', rotulo: 'SOAT', opciones: SOAT_OPC, seleccion: f.soatSel, onCambio: (v) => f.setSoatSel(v as EstadoSoat[]), todos: 'Todos', nombreGrupo: 'Estados de SOAT' },
    { tipo: 'multi', rotulo: 'Impuestos', opciones: IMP_OPC, seleccion: f.impSel, onCambio: (v) => f.setImpSel(v as EstadoImpuesto[]), todos: 'Todos', nombreGrupo: 'Estados de impuestos' },
    { tipo: 'unica', rotulo: 'Fuente', opciones: FUENTE_OPC, valor: f.fuenteSel, onCambio: (v) => f.setFuenteSel(v as '' | FuenteTramite), ariaLabel: (t) => `Filtrar por fuente: ${t}` },
    { tipo: 'unica', rotulo: 'Autogestión', opciones: AUTOG_OPC, valor: f.autogestionSel, onCambio: (v) => f.setAutogestionSel(v as Autogestion), ariaLabel: (t) => `Filtrar por autogestión: ${t}` },
    ...(empresasOpc ? [{
      tipo: 'multi', rotulo: 'Empresa gestora', opciones: empresasOpc.map((e) => ({ value: e.nit, label: e.nombre })),
      seleccion: f.empresasSel, onCambio: f.setEmpresasSel, todos: 'Todas', nombreGrupo: 'Empresas gestoras',
    } satisfies CampoFiltroProps] : []),
    { tipo: 'multi', rotulo: 'Tránsito', opciones: aOpc(facetas.transitos), seleccion: f.transitosSel, onCambio: f.setTransitosSel, todos: 'Todos', nombreGrupo: 'Tránsitos' },
    { tipo: 'multi', rotulo: 'Ciudad', opciones: aOpc(facetas.ciudades), seleccion: f.ciudadesSel, onCambio: f.setCiudadesSel, todos: 'Todas', nombreGrupo: 'Ciudades' },
  ];
  const aplicados = campos.filter(campoPuesto);
  const presetPuesto = f.preset === PRESET_RECIEN_LLEGADOS.nombre;

  return (
    <section className="acordeon-filtros" aria-label="Búsqueda y filtros">
      <div className="acordeon-fila">
        <button type="button" className="acordeon-cabeza--compacta" aria-expanded={abierto} aria-controls={abierto ? idCuerpo : undefined}
          onClick={() => setAbierto((v) => !v)}>
          <svg className="chev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="m9 6 6 6-6 6" />
          </svg>
          <strong>Filtros</strong>
          {f.cuenta > 0 && <span className="acordeon__cuenta" aria-label={`${f.cuenta} filtros activos`}>{f.cuenta}</span>}
        </button>
        <div className="control-icono filtros__buscar">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
          </svg>
          <input className="control" type="search" placeholder="Buscar placa, VIN, id o propietario…" aria-label="Buscar placa, VIN, id o propietario…"
            value={f.texto} onChange={(e) => f.setTexto(e.target.value)} />
        </div>
        <div className="vistas-cabecera" role="group" aria-label="Vistas rápidas">
          <span className="filtros-rotulo" aria-hidden="true">Vistas rápidas</span>
          <button type="button" className="chip chip--sm" aria-pressed={presetPuesto} title={PRESET_RECIEN_LLEGADOS.descripcion}
            onClick={f.alternarPreset}>{PRESET_RECIEN_LLEGADOS.nombre}</button>
        </div>
        {herramientas && <div className="filtros__herramientas" data-testid="herramientas-tabla">{herramientas}</div>}
      </div>

      {abierto && (
        <div className="acordeon__cuerpo" id={idCuerpo}>
          <div className="filtros-rejilla">
            {campos.map((c) => <CampoFiltro key={c.rotulo} {...c} />)}
          </div>
          {(aplicados.length > 0 || f.alertaSel) && (
            <div className="filtros-pie">
              <span className="filtros-rotulo">Aplicados</span>
              <div className="filtros__activos" role="group" aria-label="Filtros aplicados">
                {aplicados.map((c) => {
                  const t = `${c.rotulo}: ${textoChip(c)}`;
                  return (
                    <button key={c.rotulo} type="button" className="filtro-activo flit-focus" aria-label={`Quitar filtro ${t}`} onClick={() => quitar(c)}>
                      <span>{t}</span>{iconoCerrar}
                    </button>
                  );
                })}
                {f.alertaSel && (
                  <button type="button" className="filtro-activo flit-focus" aria-label={`Quitar la alerta ${ALERTA_OPERATIVA_LABEL[f.alertaSel]}`}
                    onClick={() => f.setAlertaSel('')}>
                    <span>Alerta: {ALERTA_OPERATIVA_LABEL[f.alertaSel]}</span>{iconoCerrar}
                  </button>
                )}
              </div>
              <button type="button" className={claseBoton('ghost', 'sm', 'filtros-pie__limpiar')} onClick={f.limpiar}>Limpiar filtros</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
