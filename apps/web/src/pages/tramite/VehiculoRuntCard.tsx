// TRAM-12b — tarjeta presentacional RUNT (paso 1 wizard). Solo render; tokens FLIT.
// TRAM-PASP-01 — pasaporte VIN expandible debajo de la tarjeta.

import { useState } from 'react';
import PasaporteVehiculo from '../vehiculo/PasaporteVehiculo';

interface Props {
  vehiculo: Record<string, unknown>;
  runtData: Record<string, unknown> | null;
}

const lbl = 'text-xs uppercase tracking-wide';
const lblStyle = { color: 'var(--color-text-tertiary)' } as const;
const vl = 'text-sm font-medium';
const vlStyle = { color: 'var(--color-text-primary)' } as const;
const vlMono = 'text-sm font-medium font-mono';
const grid = 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-5 gap-y-2';
const sec = 'border-t pt-3 mt-3';
const secBorder = { borderColor: 'var(--color-border)' } as const;
const cardStyle = {
  borderRadius: '9px',
  border: '1px solid var(--color-border)',
  overflow: 'hidden' as const,
};

export default function VehiculoRuntCard({ vehiculo, runtData }: Props) {
  const [showPasaporte, setShowPasaporte] = useState(false);
  const vd = vehiculo;
  const vinStr = String(vd.vin || '').trim();
  const rd = runtData || {};
  const soatRaw = rd.soat;
  const soat = soatRaw ? (Array.isArray(soatRaw) ? soatRaw[0] : soatRaw) as Record<string, unknown> : null;
  const dt = (rd.datosTecnicos || {}) as Record<string, unknown>;
  const sols = (rd.solicitudes || []) as Record<string, unknown>[];
  const fmtDate = (d: unknown) => (typeof d === 'string' && d ? d.split('T')[0] : '—');
  const activo = vd.estadoAutomotor === 'ACTIVO';

  return (
    <div className="space-y-0 bg-[var(--color-surface-elevated)]" style={cardStyle}>
      <div
        className="flex items-center justify-between px-5 py-4"
        style={{ background: 'var(--kit-azul-relleno)', color: 'var(--color-on-accent)' }}
      >
        <div className="flex items-center gap-4">
          <div
            className="rounded-[9px] border px-4 py-2"
            style={{ borderColor: 'color-mix(in srgb, var(--kit-naranja) 45%, transparent)', background: 'color-mix(in srgb, var(--kit-naranja) 15%, transparent)' }}
          >
            <span className="font-mono text-xl font-semibold tracking-[.2em]" style={{ color: 'var(--kit-naranja-texto)' }}>
              {String(vd.placa || '—')}
            </span>
          </div>
          <div>
            <p className="text-sm font-bold">{String(vd.marca || '')} {String(vd.linea || '')}</p>
            <p className="text-xs opacity-85">
              {String(vd.clase || vd.claseVehiculo || '')} · {String(vd.modelo || '')} · {String(vd.color || '').trim()}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {vinStr.length >= 11 && (
            <button
              type="button"
              onClick={() => setShowPasaporte((o) => !o)}
              className="flit-focus rounded-[999px] border px-3 py-1 text-xs font-semibold"
              style={{ borderColor: 'color-mix(in srgb, var(--color-on-accent) 45%, transparent)', color: 'var(--color-on-accent)' }}
            >
              {showPasaporte ? 'Ocultar pasaporte' : 'Pasaporte VIN'}
            </button>
          )}
          <span
            className="rounded-full px-3 py-1 text-xs font-bold"
            style={{
              background: activo ? 'color-mix(in srgb, var(--kit-verde) 25%, transparent)' : 'color-mix(in srgb, var(--kit-rojo) 25%, transparent)',
              color: activo ? 'var(--kit-verde)' : 'var(--kit-rojo)',
            }}
          >
            {String(vd.estadoAutomotor || '—')}
          </span>
        </div>
      </div>

      <div className="p-5">
        <p className="mb-2 text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--color-action)' }}>
          Identificación del vehículo
        </p>
        <div className={grid}>
          <div><p className={lbl} style={lblStyle}>VIN</p><p className={vlMono} style={vlStyle}>{String(vd.vin || '—')}</p></div>
          <div><p className={lbl} style={lblStyle}>No. Chasis</p><p className={vlMono} style={vlStyle}>{String(vd.numChasis || '—')}</p></div>
          <div><p className={lbl} style={lblStyle}>No. Motor</p><p className={vlMono} style={vlStyle}>{String(vd.numMotor || '—')}</p></div>
          <div><p className={lbl} style={lblStyle}>No. Serie</p><p className={vlMono} style={vlStyle}>{String(vd.numSerie || '—')}</p></div>
          <div><p className={lbl} style={lblStyle}>No. Licencia Transito</p><p className={vl} style={vlStyle}>{String(vd.numLicencia || '—')}</p></div>
          <div><p className={lbl} style={lblStyle}>Placa</p><p className={vl} style={vlStyle}>{String(vd.placa || '—')}</p></div>
          <div><p className={lbl} style={lblStyle}>Fecha Registro</p><p className={vl} style={vlStyle}>{fmtDate(vd.fechaRegistro)}</p></div>
          <div><p className={lbl} style={lblStyle}>Dias Matriculado</p><p className={vl} style={vlStyle}>{String(vd.diasMatriculado || '0')}</p></div>
        </div>

        <div className={sec} style={secBorder}>
          <p className="mb-2 text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--color-action)' }}>Características</p>
          <div className={grid}>
            <div><p className={lbl} style={lblStyle}>Marca</p><p className={vl} style={vlStyle}>{String(vd.marca || '—')}</p></div>
            <div><p className={lbl} style={lblStyle}>Linea</p><p className={vl} style={vlStyle}>{String(vd.linea || '—')}</p></div>
            <div><p className={lbl} style={lblStyle}>Modelo (Año)</p><p className={vl} style={vlStyle}>{String(vd.modelo || '—')}</p></div>
            <div><p className={lbl} style={lblStyle}>Clase</p><p className={vl} style={vlStyle}>{String(vd.clase || vd.claseVehiculo || '—')}</p></div>
            <div><p className={lbl} style={lblStyle}>Carrocería</p><p className={vl} style={vlStyle}>{String(vd.tipoCarrocería || '—')}</p></div>
            <div><p className={lbl} style={lblStyle}>Color</p><p className={vl} style={vlStyle}>{String(vd.color || '').trim() || '—'}</p></div>
            <div><p className={lbl} style={lblStyle}>Combustible</p><p className={vl} style={vlStyle}>{String(vd.tipoCombustible || '—')}</p></div>
            <div><p className={lbl} style={lblStyle}>Cilindraje</p><p className={vl} style={vlStyle}>{String(vd.cilindraje || '0')} cc</p></div>
            <div><p className={lbl} style={lblStyle}>Servicio</p><p className={vl} style={vlStyle}>{String(vd.tipoServicio || '—')}</p></div>
            <div><p className={lbl} style={lblStyle}>Clasificacion</p><p className={vl} style={vlStyle}>{String(vd.clasificacion || '—')}</p></div>
            <div><p className={lbl} style={lblStyle}>Puertas</p><p className={vl} style={vlStyle}>{String(vd.puertas || '—')}</p></div>
            <div><p className={lbl} style={lblStyle}>Pasajeros</p><p className={vl} style={vlStyle}>{String(vd.pasajerosSentados || dt.pasajerosSentados || '—')}</p></div>
          </div>
        </div>

        <div className={sec} style={secBorder}>
          <p className="mb-2 text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--color-action)' }}>Datos técnicos y estado legal</p>
          <div className={grid}>
            <div><p className={lbl} style={lblStyle}>Peso Bruto</p><p className={vl} style={vlStyle}>{String(dt.pesoBrutoVehicular || vd.pesoBruto || '—')} kg</p></div>
            <div><p className={lbl} style={lblStyle}>No. Ejes</p><p className={vl} style={vlStyle}>{String(dt.noEjes || vd.numeroEjes || '—')}</p></div>
            <div><p className={lbl} style={lblStyle}>Capacidad Carga</p><p className={vl} style={vlStyle}>{String(dt.capacidadCarga || vd.capacidadCarga || '—')}</p></div>
            <div><p className={lbl} style={lblStyle}>Organismo Transito</p><p className={vl} style={vlStyle}>{String(vd.organismoTransito || '—')}</p></div>
            <div>
              <p className={lbl} style={lblStyle}>Gravamenes</p>
              <p className="text-sm font-semibold" style={{ color: vd.gravamenes === 'NO' ? 'var(--kit-verde)' : 'var(--kit-rojo)' }}>{String(vd.gravamenes || '—')}</p>
            </div>
            <div>
              <p className={lbl} style={lblStyle}>Prendas</p>
              <p className="text-sm font-semibold" style={{ color: vd.prendas === 'NO' ? 'var(--kit-verde)' : 'var(--kit-rojo)' }}>{String(vd.prendas || '—')}</p>
            </div>
            <div><p className={lbl} style={lblStyle}>Repotenciado</p><p className={vl} style={vlStyle}>{String(vd.repotenciado || '—')}</p></div>
            <div><p className={lbl} style={lblStyle}>Vehiculo Ensenanza</p><p className={vl} style={vlStyle}>{String(vd.vehiculoEnsenanza || '—')}</p></div>
          </div>
        </div>

        {(vd.esRegrabadoMotor === 'SI' || vd.esRegrabadoChasis === 'SI' || vd.esRegrabadoSerie === 'SI' || vd.esRegrabadoVin === 'SI') && (
          <div className={sec} style={secBorder}>
            <p className="mb-2 text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--kit-rojo-texto)' }}>Regrabados</p>
            <div className={grid}>
              <div><p className={lbl} style={lblStyle}>Motor</p><p className={vl} style={vlStyle}>{String(vd.esRegrabadoMotor)} {vd.numRegraMotor ? `(${String(vd.numRegraMotor)})` : ''}</p></div>
              <div><p className={lbl} style={lblStyle}>Chasis</p><p className={vl} style={vlStyle}>{String(vd.esRegrabadoChasis)} {vd.numRegraChasis ? `(${String(vd.numRegraChasis)})` : ''}</p></div>
              <div><p className={lbl} style={lblStyle}>Serie</p><p className={vl} style={vlStyle}>{String(vd.esRegrabadoSerie)} {vd.numRegraSerie ? `(${String(vd.numRegraSerie)})` : ''}</p></div>
              <div><p className={lbl} style={lblStyle}>VIN</p><p className={vl} style={vlStyle}>{String(vd.esRegrabadoVin)} {vd.numRegraVin ? `(${String(vd.numRegraVin)})` : ''}</p></div>
            </div>
          </div>
        )}
      </div>

      {soat && (
        <div className="border-t px-5 py-3" style={{ borderColor: 'var(--color-border)', background: 'color-mix(in srgb, var(--kit-verde) 8%, transparent)' }}>
          <p className="mb-2 text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--kit-verde-texto)' }}>SOAT</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs lg:grid-cols-5">
            <div><span style={{ color: 'var(--color-text-tertiary)' }}>Aseguradora: </span><span className="font-semibold" style={{ color: 'var(--kit-verde-texto)' }}>{String(soat.razonSocialAsegur || '—')}</span></div>
            <div><span style={{ color: 'var(--color-text-tertiary)' }}>Poliza: </span><span className="font-semibold" style={{ color: 'var(--color-text-primary)' }}>{String(soat.numSoat || '—')}</span></div>
            <div><span style={{ color: 'var(--color-text-tertiary)' }}>Inicio: </span><span className="font-medium" style={{ color: 'var(--color-text-primary)' }}>{fmtDate(soat.fechaInicioPoliza)}</span></div>
            <div><span style={{ color: 'var(--color-text-tertiary)' }}>Vence: </span><span className="font-medium" style={{ color: 'var(--color-text-primary)' }}>{fmtDate(soat.fechaVencimSoat)}</span></div>
            <div>
              <span style={{ color: 'var(--color-text-tertiary)' }}>Estado: </span>
              <span className="font-bold" style={{ color: (soat.estado === 'VIGENTE' || soat.estadoSoat === 'VIGENTE') ? 'var(--kit-verde)' : 'var(--kit-rojo)' }}>
                {String(soat.estado || soat.estadoSoat || '—')}
              </span>
            </div>
          </div>
        </div>
      )}

      {sols.length > 0 && (
        <div className="border-t px-5 py-3" style={{ borderColor: 'var(--color-border)', background: 'color-mix(in srgb, var(--kit-azul) 8%, transparent)' }}>
          <p className="mb-2 text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--color-action)' }}>Solicitudes RUNT ({sols.length})</p>
          <div className="space-y-1.5">
            {sols.map((s, i) => {
              const ok = s.estado === 'AUTORIZADA' || s.estado === 'APROBADA';
              return (
                <div key={i} className="flex items-center gap-3 text-xs">
                  <span
                    className="rounded px-2 py-0.5 text-xs font-bold"
                    style={{
                      background: ok ? 'color-mix(in srgb, var(--kit-verde) 15%, transparent)' : 'color-mix(in srgb, var(--kit-naranja) 15%, transparent)',
                      color: ok ? 'var(--kit-verde)' : 'var(--kit-naranja)',
                    }}
                  >
                    {String(s.estado || '—')}
                  </span>
                  <span className="flex-1 truncate" style={{ color: 'var(--color-text-secondary)' }}>{String(s.tramitesRealizados || '').replace(/,\s*$/, '')}</span>
                  <span style={{ color: 'var(--color-text-tertiary)' }}>{String(s.entidad || '')}</span>
                  <span style={{ color: 'var(--color-text-tertiary)' }}>{fmtDate(s.fechaSolicitud)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {showPasaporte && vinStr.length >= 11 && (
        <div className="border-t px-5 py-4" style={{ borderColor: 'var(--color-border)', background: 'color-mix(in srgb, var(--kit-azul) 6%, transparent)' }}>
          <PasaporteVehiculo vin={vinStr} />
        </div>
      )}
    </div>
  );
}
