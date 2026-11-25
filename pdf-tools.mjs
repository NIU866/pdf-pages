import { PDFDocument } from "./vendor/pdf.mjs";

export async function readPdf(bytes) {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  if (document.getPageCount() === 0) throw Error("PDF 中没有页面");
  return document;
}

export function selectPages(expression, pages) {
  if (!expression.trim()) return pages.slice();
  const selected = new Set();
  for (const token of expression.trim().split(/[,，、\s]+/)) {
    const match = token.match(/^(\d+)(?:[-–](\d+))?$/);
    if (!match) throw Error("页码范围格式有误，例如 1,3-5");
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    if (from < 1 || to < from || to > pages.length) throw Error("页码超出当前顺序的范围");
    for (let page = from; page <= to; page += 1) selected.add(pages[page - 1]);
  }
  if (!selected.size) throw Error("请选择至少一页");
  return Array.from(selected);
}

export async function makePdf(pages) {
  const output = await PDFDocument.create();
  const bySource = new Map();
  for (const page of pages) {
    if (!bySource.has(page.file)) bySource.set(page.file, []);
    bySource.get(page.file).push(page);
  }
  const copies = new Map();
  for (const [file, group] of bySource) {
    const imported = await output.copyPages(file.document, group.map(page => page.index));
    group.forEach((page, index) => copies.set(page, imported[index]));
  }
  pages.forEach(page => output.addPage(copies.get(page)));
  return output.save({ addDefaultPage: false });
}
