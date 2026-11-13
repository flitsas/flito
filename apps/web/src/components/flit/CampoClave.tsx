import { forwardRef, useState, type InputHTMLAttributes } from 'react';
import { Icono } from './kit/Icono';

/** Campo de contraseña del UI Kit 2026 (`.clave`): control con botón «ver» (ojo / ojo tachado) dentro. */
const CampoClave = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(function CampoClave(
  { className = '', ...rest }, ref,
) {
  const [ver, setVer] = useState(false);
  return (
    <div className="clave relative">
      <input ref={ref} type={ver ? 'text' : 'password'} className={`control pr-12 ${className}`} {...rest} />
      <button type="button" onClick={() => setVer((v) => !v)} aria-label={ver ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={ver}
        className="grid place-items-center !text-[color:var(--kit-azul)] transition-colors">
        <Icono nombre={ver ? 'ojo-tachado' : 'ojo'} size={20} />
      </button>
    </div>
  );
});
export default CampoClave;
