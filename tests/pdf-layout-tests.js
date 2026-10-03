const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'PdfService.gs'), 'utf8');
const context = { Object, Math, Number, isFinite };
vm.runInNewContext(source, context, { filename: 'PdfService.gs' });

function dimensions(width, height) {
  return context.pdfImageDimensions_(
    width,
    height,
    context.pdfPointsToPixels_(context.PDF_LAYOUT.CONTENT_WIDTH_POINTS),
    context.pdfPointsToPixels_(context.PDF_LAYOUT.FULL_PAGE_IMAGE_HEIGHT_POINTS)
  );
}

assert.deepStrictEqual(
  JSON.parse(JSON.stringify(dimensions(1024, 768))),
  { width: 761, height: 571 },
  'A landscape USG image should fill the available PDF width.'
);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(dimensions(720, 1280))),
  { width: 510, height: 906 },
  'A portrait document should fill the available PDF height.'
);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(dimensions(100, 100))),
  { width: 761, height: 761 },
  'A small square image should be enlarged to the available width.'
);

[
  [1024, 768],
  [720, 1280],
  [2000, 500],
  [100, 100]
].forEach(([width, height]) => {
  const result = dimensions(width, height);
  assert(result.width <= context.pdfPointsToPixels_(context.PDF_LAYOUT.CONTENT_WIDTH_POINTS), 'Image width exceeds the PDF margin boundary.');
  assert(result.height <= context.pdfPointsToPixels_(context.PDF_LAYOUT.FULL_PAGE_IMAGE_HEIGHT_POINTS), 'Image height exceeds the PDF page boundary.');
  assert(Math.abs((result.width / result.height) - (width / height)) < 0.01, 'Image aspect ratio changed.');
});

assert.strictEqual(context.pdfUsgImagesPerPage_(), 1, 'USG layout must always use one image per page.');
assert(source.includes("body.appendParagraph('Halaman ' + pageNumber)"), 'Every composed page must receive a visible page number.');

context.normalizeString_ = (value) => String(value || '');
context.DOCUMENT_TYPE_LABELS = { KTP: 'KTP (Identitas)' };
context.getPrivateFileBlob_ = () => ({});
context.DocumentApp = { HorizontalAlignment: { CENTER: 'CENTER', RIGHT: 'RIGHT' } };

function makeParagraph(text) {
  return {
    text,
    alignment: '',
    spacingBefore: 0,
    fontSize: 0,
    setAlignment(value) { this.alignment = value; return this; },
    setSpacingAfter() { return this; },
    setSpacingBefore(value) { this.spacingBefore = value; return this; },
    editAsText() {
      return {
        setFontSize: (value) => { this.fontSize = value; return { setForegroundColor() {} }; }
      };
    }
  };
}

const imageParagraph = makeParagraph('image');
const insertedImage = {
  width: 300,
  height: 400,
  getWidth() { return this.width; },
  getHeight() { return this.height; },
  setWidth(value) { this.width = value; return this; },
  setHeight(value) { this.height = value; return this; },
  setAltTitle() { return this; },
  setAltDescription() { return this; },
  getParent() { return { asParagraph() { return imageParagraph; } }; }
};
const paragraphs = [];
const mockBody = {
  appendParagraph(text) { const paragraph = makeParagraph(text); paragraphs.push(paragraph); return paragraph; },
  appendImage() { return insertedImage; }
};
const insertedDimensions = context.appendPdfImage_(
  mockBody,
  { document_type: 'KTP', drive_file_id: 'FILE-1', image_width: 720, image_height: 1280 },
  1,
  context.pdfPointsToPixels_(context.PDF_LAYOUT.FULL_PAGE_IMAGE_HEIGHT_POINTS),
  context.pdfPointsToPixels_(context.PDF_LAYOUT.CONTENT_WIDTH_POINTS)
);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(insertedDimensions)),
  { width: 680, height: 906 },
  'The inserted image ratio must override stale stored orientation metadata.'
);

context.appendPdfPageNumber_(mockBody, 2, insertedDimensions.height);
const pageNumber = paragraphs[paragraphs.length - 1];
assert.strictEqual(pageNumber.text, 'Halaman 2', 'Page number text is incorrect.');
assert.strictEqual(pageNumber.alignment, 'RIGHT', 'Page number must be right-aligned.');

console.log('PDF full-page image dimension checks passed.');
