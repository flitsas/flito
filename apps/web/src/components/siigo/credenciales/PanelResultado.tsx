// Panel de resultado de «Probar conexión» (HU 11890, AC3).
//
// La regla que gobierna este archivo: `POST /probar-conexion` responde **200 tanto si la prueba
// pasa como si falla**, y el veredicto viaja en `ok`/`codigo`. Por eso `ok:false` se pinta AQUÍ,
// en un panel `role="status"` dentro de su tarjeta, y nunca en la banda de error de la página.
// Lo que sí es un error —que la petición no llegue a 200— lo pinta la tarjeta con `role="alert"`.

import { fecha } from '../estilos';
import {
  AMBIENTE_EN_FRASE, TINTA_TONO, copiaVeredicto, sinAutorreferencia,
  type Ambiente, type ResultadoDiagnostico,
} from './tipos';
import { claseBoton } from '../../flit/GradientButton';
import type { ChipTone } from '../../flit/StatusChip';

/** Tono del aviso del kit para cada tono de veredicto (`.kit-alerta[data-tono]`). */
const AVISO_TONO: Record<ChipTone, 'info' | 'ok' | 'warn' | 'danger'> = {
  success: 'ok', active: 'info', warning: 'warn', danger: 'danger', draft: 'info', neutral: 'info',
};
const ICONO_AVISO = { info: 'info', ok: 'ok', warn: 'alerta', danger: 'error' } as const;

interface Props {
  ambiente: Ambiente;
  resultado: ResultadoDiagnostico;
  /** Cuándo se pulsó el botón. El DTO no trae hora, así que se rotula «Probada el …». */
  probadaEn: string;
  onCerrar: () => void;
}

export default function PanelResultado({ ambiente, resultado, probadaEn, onCerrar }: Props) {
  const copia = copiaVeredicto(resultado.codigo, ambiente);
  // En `mock` el diagnóstico ni lee la credencial (`siigo.diagnostico.service.ts`): puede devolver
  // `ok:true` con `username:null` sin haber comprobado ninguna llave. Un ✓ verde ahí diría
  // «producción está lista» sin haber tocado producción, así que el símbolo pasa a 🧪.
  const simulado = resultado.modo !== 'real';
  const mensaje = sinAutorreferencia(resultado.mensaje);
  const idTitulo = `resultado-${ambiente}-titulo`;

  return (
    <section
      role="status"
      aria-labelledby={idTitulo}
      className="kit-alerta"
      data-kit="alerta"
      data-tono={AVISO_TONO[copia.tono]}
    >
      <img src={`/kit/aviso-${ICONO_AVISO[AVISO_TONO[copia.tono]]}.svg`} alt="" aria-hidden="true" className="kit-alerta__icono" />
      <div className="min-w-0 flex-1">
      <h4 id={idTitulo} className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-secondary)' }}>
        Resultado de la prueba
      </h4>

      {simulado && (
        <p className="mt-2 text-sm" style={{ color: 'var(--kit-naranja-texto)' }}>
          <span aria-hidden="true">🧪 </span>
          Modo simulado: esta prueba no salió hacia Siigo. El resultado no dice nada sobre si tus
          credenciales sirven.
        </p>
      )}

      <p className="mt-1 text-sm font-semibold" style={{ color: TINTA_TONO[copia.tono] }}>
        <span aria-hidden="true">{simulado ? '🧪' : copia.simbolo} </span>
        {copia.encabezado}
      </p>

      {/* El mensaje del servidor, literal salvo la frase que manda a esta misma pantalla. */}
      {copia.pintarMensajeDelServidor && mensaje && (
        <p className="mt-1 text-sm" style={{ color: 'var(--color-text-primary)' }}>{mensaje}</p>
      )}
      {copia.segunda && (
        <p className="mt-1 text-sm" style={{ color: 'var(--color-text-primary)' }}>{copia.segunda}</p>
      )}

      {/* Los datos técnicos, literales y completos: son exactamente lo que se copia y se pega al
          pedir ayuda. `duracionMs: 1` es información real —dice que nunca salió de la máquina—, así
          que no se redondea ni se convierte a segundos. */}
      <p className="mt-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
        Ambiente {resultado.ambiente} · modo {resultado.modo} ·{' '}
        {resultado.username ? `usuario ${resultado.username}` : 'sin usuario'} ·{' '}
        {resultado.tokenObtenido ? 'token obtenido' : 'token no obtenido'} · {resultado.duracionMs} ms
      </p>

      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>Probada el {fecha(probadaEn)}</p>
        <button type="button" onClick={onCerrar} className={claseBoton('secondary', 'sm')} data-variante="secundario">
          Cerrar
          {/* Hay un panel por tarjeta: sin el ambiente en el nombre, los dos «Cerrar» son
              indistinguibles para quien navega por lista de botones. */}
          <span className="sr-only"> el resultado de la prueba de {AMBIENTE_EN_FRASE[ambiente]}</span>
        </button>
      </div>
      </div>
    </section>
  );
}
