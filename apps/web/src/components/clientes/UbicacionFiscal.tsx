// Ubicación fiscal del cliente: país, departamento y ciudad en cascada (HU #11298, AC4).
//
// **No hay campo de texto libre para la ciudad fiscal**, y es la razón de ser del componente: la
// ciudad que va a Siigo es un código de su catálogo, no un nombre. Escribirla a mano es cómo se
// acaba emitiendo una factura contra un municipio que la DIAN no reconoce.
//
// El texto libre que el cliente ya traía sí se muestra —es lo único que sabe quien confirma— junto
// a la equivalencia que propuso el sistema.

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { flitInp, FlitField } from '../flit/flitPageKit';
import StatusChip from '../flit/StatusChip';
import type { OpcionUbicacion, PropuestaCiudad } from './tipos';

interface Props {
  clienteId: number;
  countryCode: string;
  stateCode: string;
  cityCode: string;
  /** Lo que hay hoy en `clients.city`: texto libre, solo informativo. */
  ciudadTexto: string | null;
  editable: boolean;
  onCambio: (v: { countryCode: string; stateCode: string; cityCode: string }) => void;
}

export default function UbicacionFiscal({
  clienteId, countryCode, stateCode, cityCode, ciudadTexto, editable, onCambio,
}: Props) {
  const [paises, setPaises] = useState<OpcionUbicacion[]>([]);
  const [departamentos, setDepartamentos] = useState<OpcionUbicacion[]>([]);
  const [ciudades, setCiudades] = useState<OpcionUbicacion[]>([]);
  const [catalogoCargado, setCatalogoCargado] = useState<boolean | null>(null);
  const [propuesta, setPropuesta] = useState<PropuestaCiudad | null>(null);

  useEffect(() => {
    let vivo = true;
    void (async () => {
      try {
        const estado = await api.get<{ cargado: boolean }>('/siigo/ciudades');
        if (!vivo) return;
        setCatalogoCargado(estado.cargado);
        if (!estado.cargado) return;
        const r = await api.get<{ data: OpcionUbicacion[] }>('/siigo/ciudades/paises');
        if (vivo) setPaises(r.data ?? []);
      } catch {
        // Distinguir «no cargado» de «falló» no aporta aquí: en los dos casos la cascada no se
        // puede pintar y el aviso es el mismo. El detalle del fallo vive en la pantalla del
        // catálogo, que es donde se arregla.
        if (vivo) setCatalogoCargado(false);
      }
    })();
    return () => { vivo = false; };
  }, []);

  const cargarDepartamentos = useCallback(async (pais: string) => {
    if (!pais) { setDepartamentos([]); return; }
    const r = await api.get<{ data: OpcionUbicacion[] }>(`/siigo/ciudades/${pais}/departamentos`);
    setDepartamentos(r.data ?? []);
  }, []);

  const cargarCiudades = useCallback(async (pais: string, depto: string) => {
    if (!pais || !depto) { setCiudades([]); return; }
    const r = await api.get<{ data: OpcionUbicacion[] }>(`/siigo/ciudades/${pais}/${depto}/ciudades`);
    setCiudades(r.data ?? []);
  }, []);

  useEffect(() => { void cargarDepartamentos(countryCode); }, [countryCode, cargarDepartamentos]);
  useEffect(() => { void cargarCiudades(countryCode, stateCode); }, [countryCode, stateCode, cargarCiudades]);

  // La equivalencia propuesta solo tiene sentido si hay texto y todavía no hay código: una vez
  // elegida la ciudad, seguir sugiriendo otra sería ruido.
  useEffect(() => {
    if (!ciudadTexto || cityCode) { setPropuesta(null); return; }
    let vivo = true;
    api.get<{ certeza: PropuestaCiudad['certeza']; candidatas: PropuestaCiudad['candidatas']; textoOrigen: string }>(
      `/siigo/clientes-ciudades/${clienteId}/propuesta`,
    ).then((p) => { if (vivo) setPropuesta(p); }).catch(() => { if (vivo) setPropuesta(null); });
    return () => { vivo = false; };
  }, [clienteId, ciudadTexto, cityCode]);

  if (catalogoCargado === false) {
    return (
      <p role="alert" className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
        <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>
        El catálogo de ubicaciones de Siigo no está cargado. Sin él no se puede elegir la ciudad
        fiscal: cárgalo desde la parametrización de facturación electrónica.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <FlitField label="País">
          <select
            aria-label="País"
            className={flitInp}
            value={countryCode}
            disabled={!editable}
            onChange={(e) => onCambio({ countryCode: e.target.value, stateCode: '', cityCode: '' })}
          >
            <option value="">Sin definir</option>
            {paises.map((p) => <option key={p.codigo} value={p.codigo}>{p.nombre}</option>)}
          </select>
        </FlitField>

        <FlitField label="Departamento">
          <select
            aria-label="Departamento"
            className={flitInp}
            value={stateCode}
            disabled={!editable || countryCode === ''}
            onChange={(e) => onCambio({ countryCode, stateCode: e.target.value, cityCode: '' })}
          >
            <option value="">Sin definir</option>
            {departamentos.map((d) => <option key={d.codigo} value={d.codigo}>{d.nombre}</option>)}
          </select>
        </FlitField>

        <FlitField label="Ciudad">
          <select
            aria-label="Ciudad"
            className={flitInp}
            value={cityCode}
            disabled={!editable || stateCode === ''}
            onChange={(e) => onCambio({ countryCode, stateCode, cityCode: e.target.value })}
          >
            <option value="">Sin definir</option>
            {ciudades.map((c) => <option key={c.codigo} value={c.codigo}>{c.nombre}</option>)}
          </select>
        </FlitField>
      </div>

      {ciudadTexto && (
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Ciudad registrada en la ficha: <strong>{ciudadTexto}</strong>
          {cityCode === '' && ' — todavía sin equivalencia confirmada.'}
        </p>
      )}

      {propuesta && propuesta.certeza !== 'sin_equivalencia' && editable && (
        <div className="rounded-[10px] px-3 py-2 text-xs" style={{ background: 'rgba(79, 116, 201, 0.08)' }}>
          <p className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Equivalencia propuesta para «{propuesta.textoOrigen}»{' '}
            <StatusChip tone={propuesta.certeza === 'exacta' ? 'success' : 'warning'}>
              {propuesta.certeza === 'exacta' ? 'Coincidencia exacta'
                : propuesta.certeza === 'aproximada' ? 'Parecida — revísala'
                  : 'Varias posibles — elige cuál'}
            </StatusChip>
          </p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {propuesta.candidatas.map((c) => (
              <li key={`${c.stateCode}-${c.cityCode}`}>
                <button
                  type="button"
                  className="flit-focus underline"
                  style={{ color: 'var(--flit-info)' }}
                  onClick={() => onCambio({
                    countryCode: c.countryCode, stateCode: c.stateCode, cityCode: c.cityCode,
                  })}
                >
                  {c.cityName} · {c.stateName}
                </button>
              </li>
            ))}
          </ul>
          {/* Se propone, no se aplica: quien confirma es quien responde por el municipio que sale
              impreso en la factura. */}
          <p className="mt-1" style={{ color: 'var(--flit-text-muted)' }}>
            Nada se aplica solo: elige la que corresponda y guarda.
          </p>
        </div>
      )}
    </div>
  );
}
