# ADR 0002 — PDF gerado com pdfkit

**Situação:** aceita (Fase 4).

## Contexto

APR e PT precisam de um PDF arquivável, com QR Code de verificação, fonte com
acentos embutida e, se possível, PDF/A. A geração roda na API (Node 22).

## Opções

1. **Navegador sem interface (Chromium/Puppeteer)** renderizando HTML: layout
   fácil, mas exige um navegador no servidor (imagem grande, mais superfície de
   ataque, consumo de memória por documento) e não gera PDF/A.
2. **pdfkit** (JavaScript puro): sem binários, controle total do layout, fontes
   embutidas, suporte a PDF/A-1/2/3 declarado e PDF marcado (tagged).
3. Serviço externo de PDF: envia dados de clientes para terceiros. Descartado.

## Decisão

pdfkit 0.20, com Noto Sans (licença OFL) embutida e `qrcode` para o QR Code.
O layout fica em `apps/api/src/documents/pdf.ts`.

## Consequências

- Tabelas e quebras de página são feitas à mão (`Pdf.table`, `Pdf.ensure`).
- Os testes conferem o texto com `pdftotext` e a estrutura com `qpdf --check`
  (pacotes `poppler-utils` e `qpdf` no CI).
- A conformidade PDF/A **não** está comprovada: validar com veraPDF antes da
  produção.
- Assinatura digital ICP-Brasil (PAdES) no próprio PDF, se o parecer jurídico
  exigir, é um passo separado (biblioteca de assinatura e certificado da
  empresa).
