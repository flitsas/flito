// FLITO — Trámites: encabezado de la bandeja con los filtros por columna. JSX movido desde
// `pages/FlitoTramites.tsx` (la página tiene techo congelado de líneas) al añadir las vistas de
// columnas (ADR-0045): cada cabecera se pinta solo si la vista activa la muestra (`ver(clave)`).
// Las claves son las del catálogo de `apps/api/.../flito-vistas-columnas.catalogo.ts`.
import type { ReactNode } from 'react';
import {
  ESTADO_IMPUESTO_LABEL, ESTADO_SOAT_LABEL, ESTADOS_IMPUESTO_OPERATIVOS, ESTADOS_SOAT_OPERATIVOS, type EstadoImpuesto, type EstadoSoat,
} from '@operaciones/shared-types';
import ThFiltroMulti, { type OpcionFiltro } from '../../flit/ThFiltroMulti';
import { FlitTh, FlitTr } from '../../flit/flitPageKit';

// Filtros embebidos en el encabezado de la tabla: multiselect compacto por columna que filtra en
// servidor. Reemplaza la antigua barra de filtros.
type Opc = OpcionFiltro;
const aOpc = (vs: string[]): Opc[] => vs.map((v) => ({ value: v, label: v }));
// Épica #14707: los filtros ofrecen solo los estados OPERATIVOS (sin `descartado`).
const SOAT_OPC: Opc[] = ESTADOS_SOAT_OPERATIVOS.map((e) => ({ value: e, label: ESTADO_SOAT_LABEL[e] }));
const IMP_OPC: Opc[] = ESTADOS_IMPUESTO_OPERATIVOS.map((e) => ({ value: e, label: ESTADO_IMPUESTO_LABEL[e] }));

type Filtro<T> = [T[], (v: T[]) => void];

export interface CabeceraTramitesProps {
  ver: (clave: string) => boolean;
  /** Casilla «todas las filas de la página»: solo para Operaciones. */
  seleccionPagina?: { marcada: boolean; onCambio: (marcar: boolean) => void };
  /** ADR-0046: hay columna del botón «Ver» (detalle en modal). */
  conDetalle?: boolean;
  facetas: { estados: string[]; ciudades: string[]; transitos: string[] };
  estados: Filtro<string>;
  ciudades: Filtro<string>;
  transitos: Filtro<string>;
  soat: Filtro<EstadoSoat>;
  imp: Filtro<EstadoImpuesto>;
  /** Filtro de empresa gestora: solo sin enlace (vista FLITO). */
  empresas?: { filtro: Filtro<string>; opciones: { nit: string; nombre: string }[] };
}

export default function CabeceraTramites({
  ver, seleccionPagina, conDetalle = false, facetas, estados, ciudades, transitos, soat, imp, empresas,
}: CabeceraTramitesProps) {
  const th = (clave: string, contenido: ReactNode, estrecha = false) =>
    ver(clave) ? <FlitTh key={clave} estrecha={estrecha}>{contenido}</FlitTh> : null;
  return (
    <thead>
      <FlitTr>
        {/* Marca TODAS las filas de la página, no solo las accionables: la casilla ya no
            es la del trabajo que se puede hacer con ella (AC1). */}
        {seleccionPagina && (
          <FlitTh>
            <input type="checkbox" aria-label="Seleccionar las filas de esta página"
              checked={seleccionPagina.marcada} onChange={(e) => seleccionPagina.onCambio(e.target.checked)} />
          </FlitTh>
        )}
        {/* ADR-0046: columna del botón «Ver» (detalle en modal). Siempre visible, fuera del selector de columnas. */}
        {conDetalle && <FlitTh estrecha><span className="sr-only">Detalle</span></FlitTh>}
        {th('tramite', <>Trámite<ThFiltroMulti seleccion={estados[0]} onCambio={estados[1]} opciones={aOpc(facetas.estados)} placeholder="Todos los estados" /></>)}
        {th('fuente', 'Fuente', true)}
        {th('creado', 'Creado')}
        {th('aprobado', 'Aprobado')}
        {th('vehiculo', 'Vehículo')}
        {th('comprador', 'Propietario')}
        {th('correo', 'Correo')}
        {th('nombre_gestor', 'Gestor')}
        {th('correo_gestor', 'Correo del gestor')}
        {th('empresa_gestora', <>
          Empresa gestora
          {empresas && (
            <ThFiltroMulti seleccion={empresas.filtro[0]} onCambio={empresas.filtro[1]}
              opciones={empresas.opciones.map((e) => ({ value: e.nit, label: e.nombre }))} placeholder="Todas" />
          )}
        </>)}
        {th('transito', <>Tránsito<ThFiltroMulti seleccion={transitos[0]} onCambio={transitos[1]} opciones={aOpc(facetas.transitos)} placeholder="Todos" /></>)}
        {th('ciudad', <>Ciudad<ThFiltroMulti seleccion={ciudades[0]} onCambio={ciudades[1]} opciones={aOpc(facetas.ciudades)} placeholder="Todas" /></>)}
        {th('soat', <>SOAT<ThFiltroMulti seleccion={soat[0]} onCambio={(v) => soat[1](v as EstadoSoat[])} opciones={SOAT_OPC} placeholder="Todos" /></>)}
        {th('impuestos', <>Impuestos<ThFiltroMulti seleccion={imp[0]} onCambio={(v) => imp[1](v as EstadoImpuesto[])} opciones={IMP_OPC} placeholder="Todos" /></>)}
        {th('logistica', 'Logística')}
        {th('derechos_transito', 'Derechos de tránsito')}
        {th('soportes', 'Soportes')}
      </FlitTr>
    </thead>
  );
}
