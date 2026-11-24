import { Icono } from '../flit/kit/Icono';
import { inputCls } from './constantes';

// Campo del kit (`.campo` + `.control`): label visible, ayuda en gris, error naranja con su aviso delante.
export default function Field({ label, value, onChange, error, errorId, hint, hintId, ...rest }: { label: string; value: string; onChange: (v: string) => void; error?: string; errorId?: string; hint?: string; hintId?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const describedBy = [rest['aria-describedby'], hint && hintId ? hintId : undefined, error && errorId ? errorId : undefined].filter(Boolean).join(' ') || undefined;
  return (
    <label className="block text-xs font-semibold" style={{ color: 'var(--color-text-primary)' }}>
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={inputCls}
        aria-invalid={error ? true : rest['aria-invalid']}
        aria-describedby={describedBy}
        {...rest}
      />
      {hint && hintId ? (
        <p id={hintId} className="mt-1 text-xs font-normal" style={{ color: 'var(--color-text-tertiary)' }}>
          {hint}
        </p>
      ) : null}
      {error && errorId ? (
        <p id={errorId} className="mt-1 flex items-center gap-1 text-xs font-semibold" style={{ color: 'var(--kit-naranja-texto)' }} role="alert">
          <Icono nombre="alerta" size={14} />
          {error}
        </p>
      ) : null}
    </label>
  );
}
