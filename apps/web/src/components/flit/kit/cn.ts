/** Une clases condicionales (sin dependencia: equivalente mínimo de clsx). */
export function cn(...xs: Array<string | false | null | undefined>): string {
  return xs.filter(Boolean).join(' ');
}
