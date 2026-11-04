// Paso 2 — validación legal: pre-vuelo RUNT/SIMIT, forzar continuar (admin) y paz y salvo de impuesto.

import { puedeAvanzarDesdePasoTraspaso } from '@operaciones/shared-types';
import GradientButton from '../flit/GradientButton';
import StatusChip from '../flit/StatusChip';
import { PasoCerradoBanner } from './TraspasoBanners';
import type { UseTramiteTraspaso } from './useTramiteTraspaso';

type Props = Pick<UseTramiteTraspaso,
  'preflight' | 'preflightLoading' | 'preflightError' | 'preflightBloquea' | 'impuestoUnknown' | 'pazSalvoOk' | 'pazSalvoImpuesto'
  | 'impuestoConsulta' | 'forzarActivo' | 'isAdmin' | 'busy' | 'gateCtx' | 'pasoSoloLectura' | 'ejecutarPreflight' | 'reintentarPreflight'
  | 'activarForzarContinuar' | 'desactivarForzarContinuar' | 'consultarImpuesto' | 'confirmarPazSalvoManual' | 'continuarDesdePaso'>;

export default function PasoValidacionLegal({
  preflight, preflightLoading, preflightError, preflightBloquea, impuestoUnknown, pazSalvoOk, pazSalvoImpuesto,
  impuestoConsulta, forzarActivo, isAdmin, busy, gateCtx, pasoSoloLectura, ejecutarPreflight, reintentarPreflight,
  activarForzarContinuar, desactivarForzarContinuar, consultarImpuesto, confirmarPazSalvoManual, continuarDesdePaso,
}: Props) {
  return (
    <div>
      {pasoSoloLectura(2) && <PasoCerradoBanner />}
      <p className="mb-3 text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>2. Validación legal (RUNT/SIMIT)</p>
      {!preflight && preflightLoading && (
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Consultando RUNT, SIMIT e impuesto… (puede tardar ~30 s)</p>
      )}
      {preflightError && !preflight && (
        <div className="mb-3 rounded-[10px] border p-3" style={{ borderColor: 'var(--flit-danger)', background: 'rgba(228,61,48,0.06)' }}>
          <p className="text-xs font-semibold" style={{ color: 'var(--flit-danger)' }}>No se pudo completar el pre-vuelo</p>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>{preflightError}</p>
          <GradientButton type="button" className="mt-2" onClick={reintentarPreflight} disabled={preflightLoading}>
            Reintentar pre-vuelo
          </GradientButton>
        </div>
      )}
      {preflight ? (
        <ul className="flex flex-col gap-2">
          {preflight.checks.map((c) => (
            <li key={c.key} className="flex items-start gap-2 rounded-[10px] border p-2.5" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <StatusChip tone={c.status === 'ok' ? 'success' : c.status === 'fail' ? 'danger' : c.status === 'warn' ? 'warning' : 'neutral'}>{c.status}</StatusChip>
              <div><p className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{c.label}</p><p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{c.message}</p></div>
            </li>
          ))}
        </ul>
      ) : !preflightLoading && !preflightError ? (
        <GradientButton type="button" onClick={ejecutarPreflight} disabled={busy || preflightLoading || pasoSoloLectura(2)}>Ejecutar pre-vuelo</GradientButton>
      ) : null}
      {preflightBloquea && !forzarActivo && <p className="mt-3 text-xs font-semibold" style={{ color: 'var(--flit-danger)' }}>Hay bloqueos críticos (SOAT/RTM). Subsana antes de continuar.</p>}
      {forzarActivo && (
        <p className="mt-3 rounded-[8px] px-3 py-2 text-[11px] font-semibold" style={{ background: 'rgba(240,90,53,0.08)', color: 'var(--flit-warning)' }}>
          Modo admin: forzar continuar activo — bloqueos de pre-vuelo/SIMIT ignorados.
        </p>
      )}
      {isAdmin && (preflightBloquea || (impuestoUnknown && !pazSalvoOk)) && !forzarActivo && !pasoSoloLectura(2) && (
        <button type="button" onClick={() => activarForzarContinuar()} disabled={busy}
          className="flit-focus mt-2 rounded-[999px] px-3 py-1.5 text-[11px] font-semibold"
          style={{ color: 'var(--flit-warning)', background: 'rgba(240,90,53,0.12)' }}>
          Forzar continuar (admin)
        </button>
      )}
      {isAdmin && forzarActivo && (
        <button type="button" onClick={() => desactivarForzarContinuar()} disabled={busy}
          className="flit-focus mt-2 rounded-[999px] px-3 py-1.5 text-[11px] font-semibold"
          style={{ color: 'var(--flit-text-muted)', background: 'var(--flit-bg-app)' }}>
          Desactivar forzar continuar
        </button>
      )}
      {impuestoUnknown && (
        <div className="mt-4 rounded-[12px] border p-3" style={{ borderColor: pazSalvoOk ? 'rgba(112,207,58,0.35)' : 'var(--flit-warning)', background: pazSalvoOk ? 'rgba(112,207,58,0.08)' : 'rgba(240,90,53,0.06)' }}>
          <p className="text-xs font-bold" style={{ color: pazSalvoOk ? 'var(--flit-success)' : 'var(--flit-warning)' }}>Impuesto vehicular — paz y salvo</p>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>
            Consulta la gobernación departamental o confirma manualmente. También puedes subir el paz y salvo en el paso 6.
          </p>
          {impuestoConsulta && (
            <div className="mt-2 rounded-[8px] border px-2.5 py-2 text-[11px]" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}>
              <p className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                Fuente: {impuestoConsulta.fuente}
                {impuestoConsulta.datos.estadoPago ? ` · ${String(impuestoConsulta.datos.estadoPago)}` : ''}
              </p>
              {typeof impuestoConsulta.datos.totalPagar === 'number' && (
                <p style={{ color: 'var(--flit-text-muted)' }}>
                  Total vigencia: ${Number(impuestoConsulta.datos.totalPagar).toLocaleString('es-CO')}
                </p>
              )}
              {impuestoConsulta.advertencia && (
                <p className="mt-0.5" style={{ color: 'var(--flit-warning)' }}>{impuestoConsulta.advertencia}</p>
              )}
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {!pazSalvoOk && !pasoSoloLectura(2) && (
              <>
                <GradientButton type="button" onClick={consultarImpuesto} disabled={busy}>
                  {busy ? 'Consultando…' : 'Consultar impuesto'}
                </GradientButton>
                <button type="button" onClick={confirmarPazSalvoManual} disabled={busy}
                  className="flit-focus rounded-[999px] px-3 py-1.5 text-[11px] font-semibold"
                  style={{ color: 'var(--flit-blue)', background: 'rgba(79,116,201,0.12)' }}>
                  Confirmar verificación manual
                </button>
              </>
            )}
          </div>
          {pazSalvoOk && (
            <p className="mt-2 text-[11px] font-semibold" style={{ color: 'var(--flit-success)' }}>
              Paz y salvo registrado ({pazSalvoImpuesto?.metodo === 'upload' ? 'documento' : pazSalvoImpuesto?.metodo === 'consulta' ? 'consulta gobernación' : 'manual'}).
            </p>
          )}
        </div>
      )}
      {!pasoSoloLectura(2) && (
        <div className="mt-4 flex justify-end">
          <GradientButton type="button" onClick={() => continuarDesdePaso(2)} disabled={busy || !puedeAvanzarDesdePasoTraspaso(2, gateCtx).ok}>
            Continuar
          </GradientButton>
        </div>
      )}
    </div>
  );
}
