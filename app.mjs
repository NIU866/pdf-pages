import { makePdf, readPdf, selectPages } from "./pdf-tools.mjs";
import { zipSync } from "./vendor/zip.mjs";

const $ = id => document.getElementById(id);
const files = [];
const pages = [];
const MAX_INPUT_BYTES = 120 * 1024 ** 2;
let nextId = 1;
let dragging = null;
let busy = false;

function element(parent, tag, text, className) {
  const child = document.createElement(tag);
  if (text) child.textContent = text;
  if (className) child.className = className;
  parent.append(child);
  return child;
}

function status(message) {
  $("status").textContent = message;
}

function setBusy(next) {
  busy = next;
  render();
}

function move(page, index, action) {
  if (busy) return;
  const from = pages.indexOf(page);
  const target = Math.max(0, Math.min(pages.length - 1, index));
  if (from === target || from < 0) return;
  pages.splice(from, 1);
  pages.splice(target, 0, page);
  render();
  if (action) {
    const row = $("pages").querySelector('[data-page="' + page.id + '"]');
    (row.querySelector('[data-action="' + action + '"]:enabled') ?? row.querySelector(".preview")).focus();
  }
  status("已把页面移到第 " + (target + 1) + " 位。");
}

function render() {
  $("count").textContent = files.length + " 份文件 · " + pages.length + " 页";
  $("empty").hidden = Boolean(pages.length);
  $("add").disabled = busy;
  for (const id of ["merge", "split", "reset", "clear"]) $(id).disabled = busy || !pages.length;
  $("pages").replaceChildren();
  pages.forEach((page, index) => {
    const row = element($("pages"), "li");
    row.dataset.page = page.id;
    row.draggable = !busy;
    element(row, "span", String(index + 1), "position");
    const info = element(row, "div");
    element(info, "strong", page.file.name, "name");
    element(info, "small", "原文件第 " + (page.index + 1) + " 页");
    const controls = element(row, "div", null, "page-buttons");
    const preview = element(controls, "a", "预览", "preview");
    preview.href = page.file.url + "#page=" + (page.index + 1);
    preview.target = "_blank";
    preview.rel = "noopener";
    preview.setAttribute("aria-label", "预览 " + page.file.name + " 第 " + (page.index + 1) + " 页");
    const up = element(controls, "button", "上移");
    const down = element(controls, "button", "下移");
    up.dataset.action = "up";
    down.dataset.action = "down";
    up.disabled = busy || index === 0;
    down.disabled = busy || index === pages.length - 1;
    up.addEventListener("click", () => move(page, index - 1, "up"));
    down.addEventListener("click", () => move(page, index + 1, "down"));
    row.addEventListener("dragstart", event => {
      if (event.target !== row || busy) return;
      dragging = page;
      event.dataTransfer.setData("text/plain", String(page.id));
      event.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      dragging = null;
      row.classList.remove("dragging");
    });
    row.addEventListener("dragover", event => {
      if (!dragging || dragging === page || busy) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      row.classList.add("drop-target");
    });
    row.addEventListener("dragleave", event => {
      if (!row.contains(event.relatedTarget)) row.classList.remove("drop-target");
    });
    row.addEventListener("drop", event => {
      event.preventDefault();
      row.classList.remove("drop-target");
      if (!dragging || dragging === page || busy) return;
      const bounds = row.getBoundingClientRect();
      const after = event.clientY >= bounds.top + bounds.height / 2;
      const from = pages.indexOf(dragging);
      move(dragging, index + Number(after) - Number(from < index));
      dragging = null;
    });
  });
}

async function addFiles(list) {
  if (busy || !list.length) return;
  setBusy(true);
  const rejected = [];
  let imported = 0;
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const raw of list) {
    if (!/\.pdf$/i.test(raw.name) && raw.type !== "application/pdf") {
      rejected.push(raw.name + " · 请选择 PDF 文件");
      continue;
    }
    if (raw.size + total > MAX_INPUT_BYTES) {
      rejected.push(raw.name + " · 文件合计最多 120 MB");
      continue;
    }
    status("正在读取 " + raw.name + "…");
    let document;
    try {
      document = await readPdf(new Uint8Array(await raw.arrayBuffer()));
    } catch (error) {
      const detail = /encrypt/i.test(error.message) ? "加密 PDF 需先用原密码另存" : "无法读取这份 PDF";
      rejected.push(raw.name + " · " + detail);
      continue;
    }
    if (pages.length + document.getPageCount() > 400) {
      rejected.push(raw.name + " · 工作区最多 400 页");
      continue;
    }
    const stored = { name:raw.name, size:raw.size, document, url:URL.createObjectURL(raw) };
    files.push(stored);
    for (let index = 0; index < document.getPageCount(); index += 1) {
      pages.push({ id:nextId++, file:stored, index });
    }
    total += raw.size;
    imported += 1;
  }
  setBusy(false);
  status([imported ? "已导入 " + imported + " 份 PDF。" : "", ...rejected].filter(Boolean).join(" "));
}

function download(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function output(split) {
  if (busy || !pages.length) return;
  let selected;
  try { selected = selectPages($("range").value, pages); }
  catch (error) { status(error.message); return; }
  setBusy(true);
  status("正在导出 " + selected.length + " 页…");
  try {
    if (!split) download(await makePdf(selected), "整理后的页面.pdf", "application/pdf");
    else {
      const archive = Object.create(null);
      let total = 0;
      for (let index = 0; index < selected.length; index += 1) {
        const bytes = await makePdf([selected[index]]);
        total += bytes.length;
        if (total > 160 * 1024 ** 2) throw Error("拆分输出超过 160 MB。请缩小页码范围后分批导出。");
        archive["page-" + String(index + 1).padStart(3, "0") + ".pdf"] = bytes;
        if (index % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      download(zipSync(archive, { level:0 }), "PDF-单页.zip", "application/zip");
    }
    status("已生成 " + selected.length + " 页的下载文件。");
  } catch (error) {
    status(/160 MB/.test(error.message) ? error.message : "导出失败。可缩小页码范围后重试。");
  } finally {
    setBusy(false);
  }
}

$("add").addEventListener("click", () => $("files").click());
$("files").addEventListener("change", () => {
  const list = [...$("files").files];
  $("files").value = "";
  addFiles(list);
});
const drop = $("drop");
drop.addEventListener("dragover", event => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  if (!busy) drop.classList.add("is-over");
});
drop.addEventListener("dragleave", event => {
  if (!drop.contains(event.relatedTarget)) drop.classList.remove("is-over");
});
drop.addEventListener("drop", event => {
  event.preventDefault();
  drop.classList.remove("is-over");
  addFiles([...event.dataTransfer.files]);
});
$("reset").addEventListener("click", () => {
  pages.sort((a, b) => a.id - b.id);
  render();
  status("已按文件导入顺序恢复。");
});
$("clear").addEventListener("click", () => {
  files.forEach(file => URL.revokeObjectURL(file.url));
  files.length = pages.length = 0;
  $("range").value = "";
  status("工作区已清空。");
  render();
});
$("merge").addEventListener("click", () => output(false));
$("split").addEventListener("click", () => output(true));

for (const kind of ["drop", "dragover"]) {
  document.addEventListener(kind, event => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  });
}
