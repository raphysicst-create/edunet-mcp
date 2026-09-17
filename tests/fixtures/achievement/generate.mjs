// Synthetic, authored test content. These are not Korean curriculum quotations.
import { createRequire } from 'node:module';
import { deflateRawSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { markdownToHwpx } from 'kordoc';
const require = createRequire(import.meta.url);
const CFB = require('cfb');
export const descriptions = [
  '관찰한 물질의 성질을 여러 근거로 설명하고 서로 다른 사례를 비교할 수 있다.',
  '관찰한 물질의 성질을 설명하고 주어진 사례에서 공통점을 찾을 수 있다.',
  '관찰한 물질의 성질 가운데 한 가지를 주어진 보기에서 찾을 수 있다.',
];
const standard = '[9과01-01] 물질의 성질을 관찰한다.';
const record = (tag, level, data) => {
  const header = Buffer.alloc(4); header.writeUInt32LE((tag | (level << 10) | (data.length << 20)) >>> 0);
  return Buffer.concat([header, data]);
};
function paragraph(text, level = 0) {
  const header = Buffer.alloc(22); header.writeUInt32LE(text.length + 1);
  return [record(66, level, header), record(67, level + 1, Buffer.from(text + '\r', 'utf16le'))];
}
export function syntheticHwp({ merged = true } = {}) {
  const section = [...paragraph('학년: 중학교 1학년'), ...paragraph('과목: 과학'), record(66, 0, Buffer.alloc(22))];
  const control = Buffer.alloc(44); control.writeUInt32LE(1952607264); section.push(record(71, 1, control));
  const table = Buffer.alloc(24); table.writeUInt16LE(4, 4); table.writeUInt16LE(3, 6); section.push(record(77, 2, table));
  const rows = [['성취기준', '성취수준', '설명'], ...['상', '중', '하'].map((label, index) => [standard, label, descriptions[index]])];
  for (let row = 0; row < rows.length; row++) for (let col = 0; col < 3; col++) {
    if (merged && row > 1 && col === 0) continue;
    const header = Buffer.alloc(38); header.writeUInt16LE(1); header.writeUInt16LE(col, 8); header.writeUInt16LE(row, 10); header.writeUInt16LE(1, 12); header.writeUInt16LE(merged && row === 1 && col === 0 ? 3 : 1, 14);
    section.push(record(72, 2, header), ...paragraph(rows[row][col], 3));
  }
  const cfb = CFB.utils.cfb_new();
  const header = Buffer.alloc(256); header.write('HWP Document File'); header.writeUInt32LE(0x05000300, 32); header.writeUInt32LE(1, 36);
  CFB.utils.cfb_add(cfb, 'FileHeader', header);
  CFB.utils.cfb_add(cfb, 'DocInfo', deflateRawSync(Buffer.alloc(0)));
  CFB.utils.cfb_add(cfb, 'BodyText/Section0', deflateRawSync(Buffer.concat(section)));
  return Buffer.from(CFB.write(cfb, { type: 'buffer' }));
}
const hex = text => [...text].map(char => char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
export function syntheticPdf({ columns = false, scanned = false, pages = 1 } = {}) {
  const objects = [];
  const add = value => { objects.push(value); return objects.length; };
  const stream = text => `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
  add('<< /Type /Catalog /Pages 2 0 R >>'); add('');
  const cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n1 beginbfrange\n<0000> <ffff> <0000>\nendbfrange\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
  const cmapId = add(stream(cmap));
  const fontId = add(`<< /Type /Font /Subtype /Type0 /BaseFont /SyntheticTestFont /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode ${cmapId} 0 R >>`);
  add('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SyntheticTestFont /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /FontDescriptor 6 0 R >>');
  add('<< /Type /FontDescriptor /FontName /SyntheticTestFont /Flags 4 /FontBBox [0 -200 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 800 /StemV 80 >>');
  const pageIds = [];
  for (let page = 0; page < pages; page++) {
    const ops = [];
    const text = (value,x,y,size=10) => ops.push(`BT /F1 ${size} Tf ${x} ${y} Td <${hex(value)}> Tj ET`);
    if (!scanned) {
      text('학년: 중학교 1학년',30,760,12); text('과목: 과학',30,735,12);
      const xs = columns ? [30,210,335,460,585] : [30,250,320,585];
      const ys = columns ? [680,645,520] : [680,645,555,465,375];
      for (const x of xs) ops.push(`${x} ${ys.at(-1)} m ${x} ${ys[0]} l S`);
      for (const y of ys) ops.push(`${xs[0]} ${y} m ${xs.at(-1)} ${y} l S`);
      const rows = columns ? [['성취기준','A','B','C'],[standard,...descriptions]] : [['성취기준','성취수준','설명'],...['상','중','하'].map((label,i)=>[standard,label,descriptions[i]])];
      rows.forEach((row,r)=>row.forEach((value,c)=>{
        const width = Math.floor((xs[c+1]-xs[c]-12)/10);
        const segments = value.match(new RegExp(`.{1,${width}}`,'gu')) ?? [];
        segments.forEach((line,index)=>text(line,xs[c]+6,ys[r]-18-index*13));
      }));
    } else { ops.push('0.5 g 30 400 500 250 re f'); }
    const contentId = add(stream(ops.join('\n')));
    pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`));
  }
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id=>`${id} 0 R`).join(' ')}] /Count ${pages} >>`;
  let output='%PDF-1.4\n'; const offsets=[0];
  objects.forEach((obj,index)=>{offsets.push(Buffer.byteLength(output));output+=`${index+1} 0 obj\n${obj}\nendobj\n`;});
  const xref=Buffer.byteLength(output);
  output+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${n.toString().padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeFile(new URL('synthetic-rows.pdf',import.meta.url),syntheticPdf());
  await writeFile(new URL('synthetic-columns.pdf',import.meta.url),syntheticPdf({columns:true}));
  await writeFile(new URL('synthetic-merged.hwp',import.meta.url),syntheticHwp());
  const markdown = `# 중학교 1학년 과학\n\n| 성취기준 | 성취수준 | 설명 |\n| --- | --- | --- |\n${['상','중','하'].map((label,i)=>`| ${standard} | ${label} | ${descriptions[i]} |`).join('\n')}`;
  await writeFile(new URL('synthetic-rows.hwpx',import.meta.url),Buffer.from(await markdownToHwpx(markdown)));
}
