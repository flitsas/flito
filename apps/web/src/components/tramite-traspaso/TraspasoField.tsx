import { inputCls } from './constantes';

export default function Field({ label, value, onChange, error, errorId, hint, hintId, ...rest }: { label: string; value: string; onChange: (v: string) => void; error?: string; errorId?: string; hint?: string; hintId?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const describedBy = [rest['aria-describedby'], hint && hintId ? hintId : undefined, error && errorId ? errorId : undefined].filter(Boolean).join(' ') || undefined;
  return (
    <label className="block text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
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
        <p id={hintId} className="mt-1 text-[10px] font-normal" style={{ color: 'var(--flit-text-muted)' }}>
          {hint}
        </p>
      ) : null}
      {error && errorId ? (
        <p id={errorId} className="mt-1 text-[11px] font-semibold" style={{ color: 'var(--flit-danger)' }} role="alert">
          {error}
        </p>
      ) : null}
    </label>
  );
}
