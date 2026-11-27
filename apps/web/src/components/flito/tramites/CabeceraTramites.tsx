// FLITO — Trámites: encabezado de la bandeja. Cada cabecera se pinta solo si la vista de columnas activa
// la muestra (`ver(clave)`, ADR-0045); las claves son las del catálogo de
// `apps/api/.../flito-vistas-columnas.catalogo.ts`.
//
// Épica #14707, bloque 4 (UX §5.4, R11): sin filtros en las cabeceras. Los seis `ThFiltroMulti` pasaron al
// panel de Filtros (`FiltrosTramites`): un solo sitio para filtrar. Tampoco hay columna «Ver»: el ID de la
// fila abre el detalle.
import { FlitTh, FlitTr } from '../../flit/flitPageKit';

export interface CabeceraTramitesProps {
  ver: (clave: string) => boolean;
  /** Casilla «todas las filas de la página»: solo para Operaciones. */
  seleccionPagina?: { marcada: boolean; onCambio: (marcar: boolean) => void };
}

const COLUMNAS: ReadonlyArray<readonly [clave: string, rotulo: string, estrecha?: boolean]> = [
  ['tramite', 'Trámite'], ['fuente', 'Fuente', true], ['creado', 'Creado'], ['aprobado', 'Aprobado'], ['vehiculo', 'Vehículo'],
  ['comprador', 'Propietario'], ['correo', 'Correo'], ['nombre_gestor', 'Gestor'], ['correo_gestor', 'Correo del gestor'],
  ['empresa_gestora', 'Empresa gestora'], ['transito', 'Tránsito'], ['ciudad', 'Ciudad'], ['soat', 'SOAT'], ['impuestos', 'Impuestos'],
  ['logistica', 'Logística'], ['derechos_transito', 'Derechos de tránsito'], ['soportes', 'Soportes'],
];

export default function CabeceraTramites({ ver, seleccionPagina }: CabeceraTramitesProps) {
  return (
    <thead>
      <FlitTr>
        {/* Marca las filas VIVAS de la página (Épica #14707: salta las muertas). */}
        {seleccionPagina && (
          <FlitTh>
            <input type="checkbox" aria-label="Seleccionar las filas de esta página"
              checked={seleccionPagina.marcada} onChange={(e) => seleccionPagina.onCambio(e.target.checked)} />
          </FlitTh>
        )}
        {COLUMNAS.map(([clave, rotulo, estrecha]) => (ver(clave) ? <FlitTh key={clave} estrecha={estrecha}>{rotulo}</FlitTh> : null))}
      </FlitTr>
    </thead>
  );
}
