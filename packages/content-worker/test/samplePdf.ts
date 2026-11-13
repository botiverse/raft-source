/** A small valid PDF: one page per line of text (Helvetica), with a correct xref table. */
export function samplePdf(pages: readonly string[]): Uint8Array {
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, index) => {
    const stream = `BT /F1 36 Tf 72 700 Td (${text.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`;
    objects[pageIds[index]!] =
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> " +
      `/Contents ${pageIds[index]! + 1} 0 R >>`;
    objects[pageIds[index]! + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/**
 * A PDF of several lines a page, for the text layer: each page is its lines top to bottom (16 pt,
 * from 72 pt in, the first baseline at 720 pt, 24 pt apart), or none: a page with a drawing and no
 * text, as a scan is. A line of ASCII (and octal escapes of Helvetica's standard encoding: `\256`
 * is the "fi" ligature) is in Helvetica. Any other is in a CJK font that isn't embedded, its words
 * as UCS-2: one of the Adobe-GB1 collection (the UniGB-UCS2-H CMap, which pdf.js reads from the
 * viewer's files), or, for a line with radicals (U+2E80 to U+2FDF, which that collection lacks), one
 * whose own ToUnicode map names each code as itself, as Chromium's PDFs name some glyphs.
 * The pages in `turned` (from 0) are shown a quarter turn clockwise (`/Rotate 90`).
 */
export function textPdf(pages: readonly (readonly string[])[], turned: readonly number[] = []): Uint8Array {
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 9 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[4] = "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>";
  objects[5] =
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /DW 1000 >>";
  const toUnicode =
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def " +
    "/CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange " +
    "1 beginbfrange <0000> <FFFF> <0000> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end";
  objects[6] = "<< /Type /Font /Subtype /Type0 /BaseFont /Radicals /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 8 0 R >>";
  objects[7] =
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Radicals /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>";
  objects[8] = `<< /Length ${toUnicode.length} >>\nstream\n${toUnicode}\nendstream`;
  const ascii = /^[\x20-\x7e]*$/;
  const radicals = /[\u2e80-\u2fdf]/;
  const ucs2 = (line: string) => [...line].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  pages.forEach((lines, index) => {
    const shown = lines.map((line) =>
      ascii.test(line)
        ? // A backslash stays one (an octal escape); only the brackets are escaped.
          `/F1 16 Tf (${line.replace(/[()]/g, (c) => `\\${c}`)}) Tj T*`
        : `/${radicals.test(line) ? "F3" : "F2"} 16 Tf <${ucs2(line)}> Tj T*`,
    );
    const stream = lines.length === 0 ? "0.8 g 100 300 400 300 re f" : `BT 72 720 Td 24 TL ${shown.join(" ")} ET`;
    objects[pageIds[index]!] =
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 6 0 R >> >> " +
      `${turned.includes(index) ? "/Rotate 90 " : ""}/Contents ${pageIds[index]! + 1} 0 R >>`;
    objects[pageIds[index]! + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
