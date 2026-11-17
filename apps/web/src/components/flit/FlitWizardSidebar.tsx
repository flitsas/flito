import { Icono } from './kit/Icono';

/**
 * Asistente de pasos del UI Kit 2026 (`.pasos` horizontal; PasosHorizontal de flit develop): la línea pasa por
 * debajo y por el centro de los círculos; hecho = disco verde con check, actual = blanco con borde azul y aro 4 px.
 * Mismas props de siempre (el nombre «Sidebar» se conserva por compatibilidad: ya no es lateral).
 */
interface FlitWizardSidebarProps {
  steps: string[];
  current: number; // paso activo, 1-based
}

export default function FlitWizardSidebar({ steps, current }: FlitWizardSidebarProps) {
  return (
    <ol className="kit-pasos" aria-label="Pasos del trámite" data-kit="pasos">
      {steps.map((label, i) => {
        const num = i + 1;
        const estado = current > num ? 'hecho' : current === num ? 'actual' : 'pendiente';
        return (
          <li key={i} className="kit-paso" data-estado={estado} aria-current={estado === 'actual' ? 'step' : undefined}>
            <span className="kit-paso__boton">
              <span className="kit-paso__num">{estado === 'hecho' ? <Icono nombre="check" size={18} /> : num}</span>
              <span className="kit-paso__etiqueta">{label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
