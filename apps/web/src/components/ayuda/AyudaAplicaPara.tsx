// «Aplica para» al pie de la ficha (HU #13706 AC3 · diseño slim §5 · UX HU-4). Calculado desde la
// matriz por defecto (`rolesPorDefectoDePagina`), nunca escrito a mano. Solo en el estado Lleno.

import { ROLE_LABELS, isValidPage } from '@operaciones/shared-types';
import type { EntradaAyuda } from '../../content/ayuda/catalogo';
import { rolesPorDefectoDePagina } from '../../lib/ayudaFlito';

/** «A», «A y B», «A, B y C». */
function enumerar(nombres: string[]): string {
  if (nombres.length <= 1) return nombres.join('');
  return `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`;
}

export function textoAplicaPara(entrada: EntradaAyuda): string | null {
  if (!entrada.permiso || !isValidPage(entrada.permiso)) return null;
  const roles = rolesPorDefectoDePagina(entrada.permiso).map((r) => ROLE_LABELS[r]);
  return `Por defecto ${enumerar(roles)}. También quien tenga permiso a la pantalla ${entrada.etiqueta}.`;
}

export default function AyudaAplicaPara({ entrada }: { entrada: EntradaAyuda }) {
  const texto = textoAplicaPara(entrada);
  if (!texto) return null;
  return (
    <p
      className="mt-6 break-words border-t pt-4 text-sm leading-6"
      style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-text-secondary)' }}
      data-testid="ayuda-aplica-para"
    >
      <span className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Aplica para:</span> {texto}
    </p>
  );
}
