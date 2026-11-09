import PDFDocument from 'pdfkit';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Montagem de PDF com pdfkit (JavaScript puro, sem navegador no servidor).
 * Fonte Noto Sans embutida (acentos e PDF/A); perfil PDF/A-2b declarado.
 * A conformidade PDF/A precisa ser validada com o veraPDF antes da produção.
 */

const FONT_DIR = join(dirname(require.resolve('@fontsource/noto-sans/package.json')), 'files');
const REGULAR = readFileSync(join(FONT_DIR, 'noto-sans-latin-400-normal.woff'));
const BOLD = readFileSync(join(FONT_DIR, 'noto-sans-latin-700-normal.woff'));

const MARGIN = 48;
const INK = '#111827';
const MUTED = '#4b5563';
const LINE = '#d1d5db';

export interface IssueContext {
  title: string;
  documentNumber: string;
  company: { legalName: string; cnpj: string; unit: string };
  issuedAt: Date;
  issuedBy: string;
  verificationCode: string;
  verifyUrl: string;
  qrPng: Buffer;
  statusAtIssue: string;
  /** Aviso em destaque na primeira página (ex.: "RASCUNHO — NÃO VALE"). */
  warning: string | null;
}

export type Cell = string | number | null | undefined;

export class Pdf {
  readonly doc: PDFKit.PDFDocument;
  private chunks: Buffer[] = [];
  private done: Promise<Buffer>;

  constructor(private readonly ctx: IssueContext) {
    this.doc = new PDFDocument({
      size: 'A4', margins: { top: MARGIN, bottom: MARGIN + 24, left: MARGIN, right: MARGIN },
      bufferPages: true, pdfVersion: '1.7', subset: 'PDF/A-2b', tagged: true, displayTitle: true, lang: 'pt-BR',
      info: { Title: `${ctx.title} ${ctx.documentNumber}`, Author: ctx.company.legalName, Creator: 'Vigia', CreationDate: ctx.issuedAt },
    });
    this.doc.registerFont('r', REGULAR);
    this.doc.registerFont('b', BOLD);
    this.doc.font('r').fillColor(INK);
    this.doc.on('data', (c: Buffer) => this.chunks.push(c));
    this.done = new Promise((resolve) => this.doc.on('end', () => resolve(Buffer.concat(this.chunks))));
    this.cover();
  }

  get width() {
    return this.doc.page.width - MARGIN * 2;
  }

  private bottom() {
    return this.doc.page.height - MARGIN - 24;
  }

  ensure(h: number) {
    if (this.doc.y + h > this.bottom()) this.doc.addPage();
  }

  private cover() {
    const { doc, ctx } = this;
    const top = doc.y;
    doc.image(ctx.qrPng, doc.page.width - MARGIN - 96, top, { width: 96 });
    doc.font('b').fontSize(18).text(`${ctx.title}`, MARGIN, top, { width: this.width - 110 });
    doc.font('b').fontSize(14).text(ctx.documentNumber, { width: this.width - 110 });
    doc.font('r').fontSize(9).fillColor(MUTED)
      .text(`${ctx.company.legalName} · CNPJ ${formatCnpj(ctx.company.cnpj)}`, { width: this.width - 110 })
      .text(`Unidade: ${ctx.company.unit}`, { width: this.width - 110 })
      .text(`Verifique a autenticidade e a situação atual: ${ctx.verifyUrl}`, { width: this.width - 110 });
    doc.fillColor(INK);
    doc.y = Math.max(doc.y, top + 104);
    this.box(`SITUAÇÃO NA EMISSÃO: ${ctx.statusAtIssue.toUpperCase()}`, 'A situação pode ter mudado depois da emissão. Use o QR Code para conferir a situação atual.');
    if (ctx.warning) this.box(ctx.warning, null, '#991b1b');
    doc.moveDown(0.5);
  }

  box(title: string, text: string | null, color = INK) {
    const { doc } = this;
    const h = 22 + (text ? doc.font('r').fontSize(9).heightOfString(text, { width: this.width - 16 }) + 4 : 0);
    this.ensure(h + 8);
    const y = doc.y;
    doc.save().lineWidth(1.5).strokeColor(color).rect(MARGIN, y, this.width, h).stroke().restore();
    doc.font('b').fontSize(11).fillColor(color).text(title, MARGIN + 8, y + 6, { width: this.width - 16 });
    if (text) doc.font('r').fontSize(9).fillColor(MUTED).text(text, MARGIN + 8, doc.y + 2, { width: this.width - 16 });
    doc.fillColor(INK);
    doc.y = y + h + 6;
    doc.x = MARGIN;
  }

  h2(text: string) {
    this.ensure(40);
    this.doc.moveDown(0.6).font('b').fontSize(13).fillColor(INK).text(text, MARGIN, this.doc.y, { width: this.width });
    const y = this.doc.y + 2;
    this.doc.save().strokeColor(LINE).moveTo(MARGIN, y).lineTo(MARGIN + this.width, y).stroke().restore();
    this.doc.y = y + 6;
  }

  para(text: string, opts: { muted?: boolean; bold?: boolean; size?: number } = {}) {
    const size = opts.size ?? 10;
    const h = this.doc.font(opts.bold ? 'b' : 'r').fontSize(size).heightOfString(text, { width: this.width });
    this.ensure(Math.min(h, 200));
    this.doc.fillColor(opts.muted ? MUTED : INK).text(text, MARGIN, this.doc.y, { width: this.width });
    this.doc.fillColor(INK);
  }

  /** Pares rótulo: valor, em duas colunas. */
  fields(pairs: [string, Cell][]) {
    const labelW = 150;
    for (const [label, value] of pairs) {
      const v = value === null || value === undefined || value === '' ? '—' : String(value);
      const h = Math.max(this.doc.font('r').fontSize(10).heightOfString(v, { width: this.width - labelW }), 14);
      this.ensure(h + 2);
      const y = this.doc.y;
      this.doc.font('b').fontSize(9).fillColor(MUTED).text(label, MARGIN, y, { width: labelW - 8 });
      this.doc.font('r').fontSize(10).fillColor(INK).text(v, MARGIN + labelW, y, { width: this.width - labelW });
      this.doc.y = Math.max(this.doc.y, y + h) + 2;
    }
    this.doc.x = MARGIN;
  }

  /** Tabela com quebra de linha nas células e repetição do cabeçalho a cada página. */
  table(columns: { header: string; width: number }[], rows: Cell[][]) {
    const total = columns.reduce((a, c) => a + c.width, 0);
    const widths = columns.map((c) => (c.width / total) * this.width);
    const pad = 4;
    const drawHeader = () => {
      const hh = Math.max(...columns.map((c, i) => this.doc.font('b').fontSize(8).heightOfString(c.header, { width: widths[i]! - pad * 2 }))) + pad * 2;
      const y = this.doc.y;
      this.doc.save().rect(MARGIN, y, this.width, hh).fill('#f3f4f6').restore();
      let x = MARGIN;
      columns.forEach((c, i) => {
        this.doc.font('b').fontSize(8).fillColor(INK).text(c.header, x + pad, y + pad, { width: widths[i]! - pad * 2 });
        x += widths[i]!;
      });
      this.doc.y = y + hh;
    };
    this.ensure(40);
    drawHeader();
    for (const row of rows) {
      const cells = row.map((v) => (v === null || v === undefined || v === '' ? '—' : String(v)));
      const h = Math.max(...cells.map((c, i) => this.doc.font('r').fontSize(8.5).heightOfString(c, { width: widths[i]! - pad * 2 }))) + pad * 2;
      if (this.doc.y + h > this.bottom()) {
        this.doc.addPage();
        drawHeader();
      }
      const y = this.doc.y;
      let x = MARGIN;
      cells.forEach((c, i) => {
        this.doc.font('r').fontSize(8.5).fillColor(INK).text(c, x + pad, y + pad, { width: widths[i]! - pad * 2 });
        x += widths[i]!;
      });
      this.doc.save().strokeColor(LINE).moveTo(MARGIN, y + h).lineTo(MARGIN + this.width, y + h).stroke().restore();
      this.doc.y = y + h;
    }
    this.doc.x = MARGIN;
    this.doc.moveDown(0.3);
  }

  image(buf: Buffer, caption: string, w = 160) {
    const h = w * 0.75 + 30;
    this.ensure(h);
    const y = this.doc.y;
    this.doc.image(buf, MARGIN, y, { fit: [w, w * 0.75] });
    this.doc.font('r').fontSize(7.5).fillColor(MUTED).text(caption, MARGIN, y + w * 0.75 + 4, { width: this.width });
    this.doc.fillColor(INK);
    this.doc.y = y + h;
  }

  /** Rodapé em todas as páginas e finalização. */
  async finish(): Promise<Buffer> {
    const { doc, ctx } = this;
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      // Sem margem inferior durante o rodapé: senão o pdfkit cria páginas novas.
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const y = doc.page.height - MARGIN + 6;
      const page = `Página ${i + 1} de ${range.count}`;
      doc.font('r').fontSize(7.5).fillColor(MUTED);
      const pw = doc.widthOfString(page) + 4;
      doc.text(`${ctx.documentNumber} · Emitido em ${formatDateTime(ctx.issuedAt)} por ${ctx.issuedBy} · Código ${ctx.verificationCode}`,
        MARGIN, y, { width: this.width - pw - 8, lineBreak: false, ellipsis: true });
      doc.text(page, MARGIN + this.width - pw, y, { width: pw, align: 'right', lineBreak: false });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
    return this.done;
  }
}

export function formatCnpj(c: string) {
  return c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

/** Datas no fuso de Brasília, com o fuso explícito. */
export function formatDateTime(d: Date | string | null | undefined) {
  if (!d) return '—';
  return `${new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })} (horário de Brasília)`;
}

export function formatDate(d: Date | string | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}
