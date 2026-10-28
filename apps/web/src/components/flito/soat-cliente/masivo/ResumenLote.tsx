// HU #14134 (AC3, AC7) — resumen del lote terminado: tres cifras, rechazadas con placa y motivo,
// «Descargar rechazadas», enlace a «Por validar» y «Cargar otro archivo». Una sola primaria.
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Loader2 } from 'lucide-react';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary } from '../../../flit/flitPageKit';
import StatusChip from '../../../flit/StatusChip';
import { COPY_COMUN } from './copyMasivo';
import type { FilaLote, ResumenLoteDto } from './tiposMasivo';

const MAX_RECHAZADAS_VISIBLES = 5;

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

export default function ResumenLote({
  resumen, filas, puedeDescargar, vencida, descargando, onDescargar, onOtro,
}: {
  resumen: ResumenLoteDto;
  filas: FilaLote[];
  puedeDescargar: boolean;
  vencida: boolean;
  descargando: boolean;
  onDescargar: () => void;
  onOtro: () => void;
}) {
  const navigate = useNavigate();
  const titulo = useRef<HTMLHeadingElement>(null);
  // Al terminar el foco pasa al encabezado del resultado (UX §Accesibilidad).
  useEffect(() => { titulo.current?.focus(); }, []);

  const rechazadas = filas.filter((f) => f.estado === 'rechazada');
  const visibles = rechazadas.slice(0, MAX_RECHAZADAS_VISIBLES);
  const hayDescarga = resumen.rechazadas > 0 && puedeDescargar && !vencida;
  const btnOtro = (primaria: boolean) => (
    <button type="button" className={`${primaria ? flitBtnPrimary : flitBtnSecondary} w-full justify-center sm:w-auto`}
      style={primaria ? flitBtnPrimaryStyle : undefined} onClick={onOtro}>Cargar otro archivo</button>
  );

  return (
    <div className="space-y-4">
      <h3 ref={titulo} tabIndex={-1} className="sr-only">
        Resultado de la carga terminada
      </h3>
      <p className="sr-only" aria-live="polite">
        {`Carga terminada: ${plural(resumen.creadas, 'creada', 'creadas')}, ${resumen.porValidar} por validar, ${plural(resumen.rechazadas, 'rechazada', 'rechazadas')}.`}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-4">
        <StatusChip tone="success">{plural(resumen.creadas, 'creada', 'creadas')}</StatusChip>
        <StatusChip tone="warning">{`${resumen.porValidar} por validar`}</StatusChip>
        <StatusChip tone="danger">{plural(resumen.rechazadas, 'rechazada', 'rechazadas')}</StatusChip>
      </div>

      {resumen.porValidar > 0 && (
        <div className="space-y-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          {resumen.porValidarFactura > 0 && <p>{plural(resumen.porValidarFactura, 'espera', 'esperan')} la factura de venta.</p>}
          {resumen.porValidarPropietario > 0 && <p>{plural(resumen.porValidarPropietario, 'espera', 'esperan')} los datos del propietario.</p>}
          <button
            type="button"
            className="flit-focus -mx-1 inline-flex min-h-[44px] items-center rounded px-1 text-sm font-semibold underline-offset-2 transition-colors hover:underline sm:min-h-0"
            style={{ color: 'var(--flit-blue-text)' }}
            onClick={() => navigate('/flito/soat', { state: { pastilla: 'incompleta' } })}
          >
            Ver en Por validar
          </button>
        </div>
      )}

      {resumen.rechazadas > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Rechazadas</h4>
          <ul className="space-y-1 text-sm">
            {visibles.map((f) => (
              <li key={f.nFila}>
                <span className="font-medium tabular-nums">{f.placa ?? f.vin ?? `Fila ${f.nFila}`}</span>
                {f.motivo ? ` · ${f.motivo.mensaje}` : ''}
              </li>
            ))}
          </ul>
          {resumen.rechazadas > visibles.length && (
            <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
              {`y ${resumen.rechazadas - visibles.length} más: están en la tabla y en el archivo.`}
            </p>
          )}
          {!hayDescarga && <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{COPY_COMUN.rechazadasNoDisponibles}</p>}
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row-reverse sm:flex-wrap sm:justify-end">
        {hayDescarga ? (
          <>
            <button type="button" className={`${flitBtnPrimary} w-full justify-center sm:w-auto`} style={flitBtnPrimaryStyle}
              aria-disabled={descargando || undefined} onClick={() => { if (!descargando) onDescargar(); }}>
              {descargando ? <Loader2 size={16} aria-hidden="true" className="animate-spin" /> : <Download size={16} aria-hidden="true" />}
              {descargando ? 'Descargando…' : 'Descargar rechazadas'}
            </button>
            {btnOtro(false)}
          </>
        ) : btnOtro(true)}
      </div>
    </div>
  );
}
