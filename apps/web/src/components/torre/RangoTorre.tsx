// Torre de Control (Épica #14590) — barra de fechas de las 5 pestañas (RN-TOR-W2, spec UX vistas flexibles §3).
// Desde y Hasta siempre a la vista (date nativos con label), atajos en `FiltroSegmentado` y los meses sueltos en un
// select «Mes». Un atajo llena los campos con sus fechas reales; editar a mano lo desmarca y deja el periodo como
// rango propio. Con «Desde» > «Hasta» o una fecha incompleta NO se consulta: error en línea con `aria-invalid` y el
// último resultado válido queda a la vista con su aviso. Las fechas son texto `YYYY-MM-DD` de Bogotá, nunca `Date`.
// El estado sigue en `sessionStorage['flito-torre-filtros']` (RN-TOR-W1); nada de esto va en la URL.
import { useEffect, useId, useState, type ReactNode } from 'react';
import type { FiltrosTorre, PeriodoTorre } from '../../lib/torreFiltros';
import FiltroSegmentado from '../flit/FiltroSegmentado';
import FlitSelect from '../flit/FlitSelect';
import InlineAlert from '../flit/InlineAlert';
import { flitInp } from '../flit/flitPageKit';
import { ATAJOS_PERIODO, etiquetaPeriodo, fechaLarga, fraseRango, hoyBogota, opcionesMes, rangoDePeriodo } from './formatoTorre';

type Rango = { desde: string; hasta: string };

const ES_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** `null` = el rango se puede consultar; si no, el texto del error en línea (spec §6). */
export function errorRangoTorre(r: Rango, hoy: string): string | null {
  if (!ES_FECHA.test(r.desde) || !ES_FECHA.test(r.hasta)) return 'Escriba la fecha completa en «Desde» y en «Hasta».';
  if (r.desde > r.hasta) return 'La fecha «Desde» es posterior a «Hasta». Corrija una de las dos.';
  if (r.hasta > hoy) return 'Las fechas llegan hasta hoy. Corrija «Hasta».';
  return null;
}

const ATAJOS = new Set<string>(ATAJOS_PERIODO.map((a) => a.valor));

/**
 * Piezas de la barra de fechas, para que `BarraFiltrosTorre` las acomode en su rejilla (Compañía · fechas · Mes y,
 * debajo, los atajos). `aviso` va al final de la barra mientras el rango sea inválido.
 */
export function useRangoTorre({ filtros, onCambio, onInvalido }: {
  filtros: FiltrosTorre;
  onCambio: (f: FiltrosTorre) => void;
  onInvalido?: (invalido: boolean) => void;
}): { campos: ReactNode; mes: ReactNode; atajos: ReactNode; aviso: ReactNode } {
  const hoy = hoyBogota();
  const resuelto = rangoDePeriodo(filtros, hoy);
  // Lo que el usuario escribe y aún no se puede consultar. `null` = los campos muestran el periodo vigente.
  const [borrador, setBorrador] = useState<Rango | null>(null);
  const [anuncio, setAnuncio] = useState('');
  const clave = `${filtros.periodo}|${filtros.rango?.desde ?? ''}|${filtros.rango?.hasta ?? ''}`;
  useEffect(() => { setBorrador(null); }, [clave]);

  const vista = borrador ?? resuelto;
  const error = borrador ? errorRangoTorre(borrador, hoy) : null;
  const invalido = error !== null;
  useEffect(() => { onInvalido?.(invalido); }, [invalido, onInvalido]);

  const id = useId();
  const idAyuda = `${id}-ayuda`;
  const idError = `${id}-error`;

  const anunciar = (f: Pick<FiltrosTorre, 'periodo' | 'rango'>) => {
    const r = rangoDePeriodo(f, hoy);
    setAnuncio(`Periodo: ${fechaLarga(r.desde)} a ${fechaLarga(r.hasta)}`);
  };
  const aplicar = (periodo: PeriodoTorre) => {
    setBorrador(null);
    onCambio({ ...filtros, periodo, rango: null });
    anunciar({ periodo, rango: null });
  };
  const editar = (campo: keyof Rango, v: string) => {
    const siguiente = { ...vista, [campo]: v };
    if (errorRangoTorre(siguiente, hoy)) { setBorrador(siguiente); return; }
    setBorrador(null);
    onCambio({ ...filtros, periodo: 'personalizado', rango: siguiente });
  };

  const atajoActivo = !borrador && ATAJOS.has(filtros.periodo) ? filtros.periodo : '';
  const mesActivo = !borrador && filtros.periodo.startsWith('m:') ? filtros.periodo : '';
  const meses = opcionesMes(hoy);
  const opcionesSelect = [
    { valor: '', etiqueta: 'Elegir un mes' },
    ...meses,
    // Un `m:` guardado más viejo que la lista (sessionStorage de otra versión) se sigue viendo elegido.
    ...(mesActivo && !meses.some((m) => m.valor === mesActivo) ? [{ valor: mesActivo, etiqueta: etiquetaPeriodo(filtros) }] : []),
  ];

  const campo = (c: keyof Rango, etiqueta: string) => (
    <div className="min-w-0 lg:w-44">
      <label htmlFor={`${id}-${c}`} className="mb-1.5 block text-[0.8125rem] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        {etiqueta}
      </label>
      <input id={`${id}-${c}`} type="date" className={flitInp} value={vista[c]} max={hoy}
        aria-invalid={invalido || undefined} aria-describedby={invalido ? `${idAyuda} ${idError}` : idAyuda}
        style={invalido ? { borderColor: 'var(--flit-danger-ink)' } : undefined}
        data-torre={`fecha-${c}`} onChange={(e) => editar(c, e.target.value)} />
    </div>
  );

  const campos = (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="grid grid-cols-2 gap-3 lg:flex lg:items-end lg:gap-2">
        {campo('desde', 'Desde')}
        <span aria-hidden="true" className="hidden pb-2.5 lg:block" style={{ color: 'var(--color-text-tertiary)' }}>→</span>
        {campo('hasta', 'Hasta')}
      </div>
      <span id={idAyuda} className="sr-only">Formato día/mes/año</span>
      {/* `polite` y no `alert`: no interrumpe mientras se escribe. Ícono además del color (no solo color). */}
      <p id={idError} aria-live="polite" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }} data-torre="error-rango">
        {error && <><span aria-hidden="true">⚠ </span>{error}</>}
      </p>
      <p className="sr-only" role="status">{anuncio}</p>
    </div>
  );

  const mes = (
    <FlitSelect label="Mes" value={mesActivo} opciones={opcionesSelect}
      onChange={(v) => { if (v) aplicar(v as PeriodoTorre); }} />
  );

  const atajos = (
    <FiltroSegmentado<string> rotulo="Atajos" ariaLabel="Atajos de periodo" opciones={ATAJOS_PERIODO} valor={atajoActivo}
      onCambio={(v) => aplicar(v as PeriodoTorre)} />
  );

  const aviso = invalido ? (
    <InlineAlert tono="info">El resultado corresponde al último periodo válido: {fraseRango(resuelto)}.</InlineAlert>
  ) : null;

  return { campos, mes, atajos, aviso };
}
