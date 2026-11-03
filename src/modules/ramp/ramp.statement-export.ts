/**
 * Minimal single-page PDF (Helvetica) for statement export — no extra deps.
 */
export function buildSimplePdf(opts: { title: string; lines: string[] }): Buffer {
  const contentLines = [opts.title, '', ...opts.lines];
  const escaped = contentLines.map((l) =>
    String(l).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'),
  );

  // Build text drawing operators (top-down from y=800)
  let y = 800;
  const ops: string[] = ['BT', '/F1 10 Tf', '14 TL', `50 ${y} Td`];
  for (let i = 0; i < escaped.length; i++) {
    if (i === 0) {
      ops.push(`/F1 14 Tf`, `(${escaped[i]}) Tj`, `/F1 10 Tf`, 'T*');
    } else {
      ops.push(`(${escaped[i]}) Tj`, 'T*');
    }
    y -= 14;
    if (y < 40) break;
  }
  ops.push('ET');
  const stream = ops.join('\n');

  const objects: string[] = [];
  objects.push('1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj');
  objects.push('2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj');
  objects.push(
    '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj',
  );
  objects.push(
    `4 0 obj<< /Length ${Buffer.byteLength(stream, 'utf8')} >>stream\n${stream}\nendstream endobj`,
  );
  objects.push('5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj');

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += obj + '\n';
  }
  const xrefPos = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}

export function buildStatementCsv(
  rows: Array<Record<string, string | number | null | undefined>>,
): string {
  if (!rows.length) return 'date,description,type,amount,balance_after\n';
  const headers = Object.keys(rows[0]!);
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? '' : typeof v === 'number' ? String(v) : v;
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join(
    '\n',
  );
}
