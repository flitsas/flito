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
      <p className="m-0 mb-3 text-base font-bold" style={{ color: 'var(--color-action)' }}>2. Validación legal (RUNT/SIMIT)</p>
      {!preflight && preflightLoading && (
        <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>Consultando RUNT, SIMIT e impuesto… (puede tardar ~30 s)</p>
      )}
      {preflightError && !preflight && (
        <div className="mb-3 rounded-[9px] border p-3" style={{ borderColor: 'var(--kit-rojo)', background: 'color-mix(in srgb, var(--kit-rojo) 6%, transparent)' }}>
          <p className="text-xs font-semibold" style={{ color: 'var(--kit-rojo-texto)' }}>No se pudo completar el pre-vuelo</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--color-text-secondary)' }}>{preflightError}</p>
          <GradientButton type="button" className="mt-2" onClick={reintentarPreflight} disabled={preflightLoading}>
            Reintentar pre-vuelo
          </GradientButton>
        </div>
      )}
      {preflight ? (
        <ul className="flex flex-col gap-2">
          {preflight.checks.map((c) => (
            <li key={c.key} className="flex flex-wrap items-start gap-2 rounded-[9px] border p-2.5 sm:flex-nowrap" style={{ borderColor: 'var(--color-border)' }}>
              <StatusChip tone={c.status === 'ok' ? 'success' : c.status === 'fail' ? 'danger' : c.status === 'warn' ? 'warning' : 'neutral'}>{c.status}</StatusChip>
              <div className="min-w-0"><p className="m-0 text-xs font-semibold" style={{ color: 'var(--color-text-primary)' }}>{c.label}</p><p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>{c.message}</p></div>
            </li>
          ))}
        </ul>
      ) : !preflightLoading && !preflightError ? (
        <GradientButton type="button" onClick={ejecutarPreflight} disabled={busy || preflightLoading || pasoSoloLectura(2)}>Ejecutar pre-vuelo</GradientButton>
      ) : null}
      {preflightBloquea && !forzarActivo && <p className="mt-3 text-xs font-semibold" style={{ color: 'var(--kit-rojo-texto)' }}>Hay bloqueos críticos (SOAT/RTM). Subsana antes de continuar.</p>}
      {forzarActivo && (
        <p className="mt-3 rounded-[9px] px-3 py-2 text-xs font-semibold" style={{ background: 'color-mix(in srgb, var(--kit-naranja) 8%, transparent)', color: 'var(--kit-naranja-texto)' }}>
          Modo admin: forzar continuar activo — bloqueos de pre-vuelo/SIMIT ignorados.
        </p>
      )}
      {isAdmin && (preflightBloquea || (impuestoUnknown && !pazSalvoOk)) && !forzarActivo && !pasoSoloLectura(2) && (
        <GradientButton type="button" variant="alerta" size="sm" className="mt-2" onClick={() => activarForzarContinuar()} disabled={busy}>
          Forzar continuar (admin)
        </GradientButton>
      )}
      {isAdmin && forzarActivo && (
        <GradientButton type="button" variant="secondary" size="sm" className="mt-2" onClick={() => desactivarForzarContinuar()} disabled={busy}>
          Desactivar forzar continuar
        </GradientButton>
      )}
      {impuestoUnknown && (
        <div className="mt-4 rounded-[9px] border p-3" style={{ borderColor: pazSalvoOk ? 'color-mix(in srgb, var(--kit-verde) 35%, transparent)' : 'var(--kit-naranja)', background: pazSalvoOk ? 'color-mix(in srgb, var(--kit-verde) 8%, transparent)' : 'color-mix(in srgb, var(--kit-naranja) 6%, transparent)' }}>
          <p className="text-xs font-bold" style={{ color: pazSalvoOk ? 'var(--kit-verde-texto)' : 'var(--kit-naranja-texto)' }}>Impuesto vehicular — paz y salvo</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
            Consulta la gobernación departamental o confirma manualmente. También puedes subir el paz y salvo en el paso 6.
          </p>
          {impuestoConsulta && (
            <div className="mt-2 rounded-[9px] border px-2.5 py-2 text-xs" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
              <p className="font-semibold" style={{ color: 'var(--color-text-primary)' }}>
                Fuente: {impuestoConsulta.fuente}
                {impuestoConsulta.datos.estadoPago ? ` · ${String(impuestoConsulta.datos.estadoPago)}` : ''}
              </p>
              {typeof impuestoConsulta.datos.totalPagar === 'number' && (
                <p style={{ color: 'var(--color-text-tertiary)' }}>
                  Total vigencia: ${Number(impuestoConsulta.datos.totalPagar).toLocaleString('es-CO')}
                </p>
              )}
              {impuestoConsulta.advertencia && (
                <p className="mt-0.5" style={{ color: 'var(--kit-naranja-texto)' }}>{impuestoConsulta.advertencia}</p>
              )}
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {!pazSalvoOk && !pasoSoloLectura(2) && (
              <>
                <GradientButton type="button" onClick={consultarImpuesto} disabled={busy}>
                  {busy ? 'Consultando…' : 'Consultar impuesto'}
                </GradientButton>
                <GradientButton type="button" variant="success" onClick={confirmarPazSalvoManual} disabled={busy}>
                  Confirmar verificación manual
                </GradientButton>
              </>
            )}
          </div>
          {pazSalvoOk && (
            <p className="mt-2 text-xs font-semibold" style={{ color: 'var(--kit-verde-texto)' }}>
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
