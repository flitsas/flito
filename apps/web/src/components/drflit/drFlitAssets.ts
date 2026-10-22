// Avatar oficial de Dr. Flit (HU #13764, retrabajo): los mismos assets que FLIT 2. Van por URL
// pública (`apps/web/public/assets/dr-flit/`) con `<img>`, así no entran al bundle ni pesan en /login.
export const DR_FLIT_ASSETS = {
  /** Robot completo saludando, 245×256: botón flotante. */
  fab: '/assets/dr-flit/fab-launcher.webp',
  /** Cabeza sobre círculo teal, 128×128: cabecera del panel y mensajes del bot. */
  header: '/assets/dr-flit/header-avatar.webp',
} as const;
