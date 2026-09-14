// FLITO — Servicios adicionales: la tabla del catálogo (HU #12542). UX §5.1, §5.4, §5.5 y §11.
//
// Solo lectura más dos botones por fila. El orden es el que llegó del servidor (nombre plegado):
// aquí no se reordena. «Por tarifar» se ata a `valor === 0` de un tipo ACTIVO —lo único que el
// catálogo sabe—, nunca a `creadoPorId === null`. Las filas de baja no llevan botones: ni apagados.
// Los botones existen solo con la función (`puedeEditar`, `puedeDarDeBaja`), nunca por rol.

import { FlitTable, FlitTh, FlitTr, flitBtnSecondarySm, flitBtnSecondaryStyle } from '../flit/flitPageKit';
import StatusChip from '../flit/StatusChip';
import { fechaCorta } from '../../lib/tarifas';
import { pesosCatalogo, type ServicioAdicionalTipo } from '../../lib/serviciosAdicionales';

interface Props {
  tipos: ServicioAdicionalTipo[];
  puedeEditar: boolean;
  puedeDarDeBaja: boolean;
  /** La lista se está repidiendo tras una escritura: la tabla sigue, los botones de fila se apagan. */
  bloqueada: boolean;
  onEditar: (tipo: ServicioAdicionalTipo) => void;
  onDarDeBaja: (tipo: ServicioAdicionalTipo) => void;
}

export default function TablaServiciosAdicionales({ tipos, puedeEditar, puedeDarDeBaja, bloqueada, onEditar, onDarDeBaja }: Props) {
  const conAcciones = puedeEditar || puedeDarDeBaja;
  return (
    <FlitTable label="Tipos de servicio adicional">
      <thead>
        <tr>
          <FlitTh className="w-[22%]">Nombre</FlitTh>
          <FlitTh>Descripción</FlitTh>
          <FlitTh className="w-[14%] !text-right">Valor</FlitTh>
          <FlitTh className="w-[16%]">Estado</FlitTh>
          {conAcciones && <FlitTh className="w-[1%] whitespace-nowrap"><span className="sr-only">Acciones</span></FlitTh>}
        </tr>
      </thead>
      <tbody>
        {tipos.map((t) => {
          const deBaja = !t.activo;
          const tinta = deBaja ? 'var(--flit-text-muted)' : 'var(--flit-text-primary)';
          return (
            <FlitTr key={t.id}>
              <th scope="row" data-id={t.id} className="px-4 py-3 text-left align-top text-sm font-semibold" style={{ color: tinta }}>
                {t.nombre}
              </th>
              <td
                className="px-4 py-3 align-top text-sm"
                style={{ color: deBaja ? 'var(--flit-text-muted)' : 'var(--flit-text-secondary)' }}
                title={t.descripcion ?? undefined}
                aria-label={t.descripcion ? undefined : 'Sin descripción'}
              >
                {t.descripcion
                  ? <span className="line-clamp-2">{t.descripcion}</span>
                  : <span aria-hidden="true" style={{ color: 'var(--flit-text-muted)' }}>—</span>}
              </td>
              <td className="px-4 py-3 text-right align-top text-sm tabular-nums" style={{ color: tinta }}>
                {pesosCatalogo(t.valor)}
                {t.activo && t.valor === 0 && (
                  <span className="block text-xs font-semibold" style={{ color: 'var(--flit-warning-ink)' }}>Por tarifar</span>
                )}
              </td>
              <td className="px-4 py-3 align-top text-sm">
                {deBaja ? (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <StatusChip tone="neutral">Dado de baja</StatusChip>
                    <span className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>· {fechaCorta(t.dadoDeBajaEn)}</span>
                  </span>
                ) : (
                  <StatusChip tone="success">Activo</StatusChip>
                )}
              </td>
              {conAcciones && (
                <td className="whitespace-nowrap px-4 py-3 text-right align-top">
                  {t.activo && (
                    <span className="inline-flex gap-2">
                      {puedeEditar && (
                        <button
                          type="button" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle}
                          aria-label={`Editar · ${t.nombre}`} disabled={bloqueada} onClick={() => onEditar(t)}
                        >
                          Editar
                        </button>
                      )}
                      {puedeDarDeBaja && (
                        <button
                          type="button" className={flitBtnSecondarySm}
                          style={{ ...flitBtnSecondaryStyle, color: 'var(--flit-danger-ink)' }}
                          aria-label={`Dar de baja · ${t.nombre}`} disabled={bloqueada} onClick={() => onDarDeBaja(t)}
                        >
                          Dar de baja
                        </button>
                      )}
                    </span>
                  )}
                </td>
              )}
            </FlitTr>
          );
        })}
      </tbody>
    </FlitTable>
  );
}
