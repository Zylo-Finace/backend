/** Strip stray trailing `)` — e.g. "Paycom (Opay))" → "Paycom (Opay)". */
export function cleanBankDisplayName(raw: string): string {
  let s = String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  while (s.endsWith('))')) s = s.slice(0, -1);
  const opens = (s.match(/\(/g) ?? []).length;
  const closes = (s.match(/\)/g) ?? []).length;
  if (opens > closes) s += ')'.repeat(opens - closes);
  if (closes > opens) {
    let extra = closes - opens;
    while (extra > 0 && s.endsWith(')')) {
      s = s.slice(0, -1);
      extra -= 1;
    }
  }
  return s;
}
