const express = require('express');
const multer = require('multer');
const cors = require('cors');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const FormData = require('form-data');

const app = express();

const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
});

function safeText(value) {
  return String(value || '').replace(/\r/g, '\n').trim();
}

function responseText(res, payload) {
  const text = safeText(
    payload.text ||
    payload.data ||
    payload.content ||
    payload.output ||
    ''
  );

  return res.json({
    success: Boolean(payload.success),
    source: payload.source || '',
    text,
    data: text,
    content: text,
    output: text,
    messages: payload.messages || [],
    metadata: payload.metadata || {},
  });
}

function parseJsonField(value) {
  if (!value) return {};

  if (typeof value === 'object') return value;

  let text = String(value).trim();

  try {
    return JSON.parse(text);
  } catch (e) {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');

    if (first >= 0 && last > first) {
      text = text.slice(first, last + 1);
      return JSON.parse(text);
    }

    throw new Error('Не удалось разобрать JSON data/json/payload.');
  }
}

function getUploadedFile(req, preferredNames = ['file', 'template']) {
  if (req.file) return req.file;

  if (Array.isArray(req.files)) {
    for (const name of preferredNames) {
      const found = req.files.find(f => f.fieldname === name);
      if (found) return found;
    }

    return req.files[0] || null;
  }

  return null;
}

app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'VOLOPAS document render service',
    routes: [
      'GET /health',
      'POST /extract-docx',
      'POST /extract-pdf',
      'POST /extract-pdf-ocr',
      'POST /fill-docx-template',
      'POST /render-docx',
    ],
  });
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    service: 'forrender',
    time: new Date().toISOString(),
  });
});

app.post('/extract-docx', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        source: 'docx',
        error: 'No DOCX file uploaded. Expected form-data field: file',
      });
    }

    const result = await mammoth.extractRawText({
      buffer: req.file.buffer,
    });

    const text = safeText(result.value);

    return responseText(res, {
      success: true,
      source: 'docx',
      text,
      messages: result.messages || [],
      metadata: {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        textLength: text.length,
      },
    });
  } catch (error) {
    console.error('DOCX extract error:', error);

    return res.status(500).json({
      success: false,
      source: 'docx',
      error: String(error.message || error),
    });
  }
});

app.post('/extract-pdf', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        source: 'pdf_text_layer',
        error: 'No PDF file uploaded. Expected form-data field: file',
      });
    }

    const result = await pdfParse(req.file.buffer);
    const text = safeText(result.text);

    return responseText(res, {
      success: true,
      source: 'pdf_text_layer',
      text,
      metadata: {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        pages: result.numpages,
        textLength: text.length,
        needsOcr: text.length < 30,
      },
    });
  } catch (error) {
    console.error('PDF extract error:', error);

    return res.status(500).json({
      success: false,
      source: 'pdf_text_layer',
      error: String(error.message || error),
      needsOcr: true,
    });
  }
});

app.post('/extract-pdf-ocr', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        source: 'pdf_ocr',
        error: 'No PDF file uploaded. Expected form-data field: file',
      });
    }

    const apiKey = process.env.OCR_SPACE_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        source: 'pdf_ocr',
        error: 'OCR_SPACE_API_KEY is not set in Render environment variables.',
      });
    }

    const form = new FormData();

    form.append('file', req.file.buffer, {
      filename: req.file.originalname || 'scan.pdf',
      contentType: req.file.mimetype || 'application/pdf',
    });

    form.append('language', 'rus');
    form.append('isOverlayRequired', 'false');
    form.append('OCREngine', '2');
    form.append('scale', 'true');
    form.append('detectOrientation', 'true');
    form.append('isTable', 'true');

    const response = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: {
        apikey: apiKey,
        ...form.getHeaders(),
      },
      body: form,
    });

    const result = await response.json();

    if (!response.ok || result.IsErroredOnProcessing) {
      return res.status(502).json({
        success: false,
        source: 'pdf_ocr',
        error: 'OCR.Space failed to process file.',
        details: result,
      });
    }

    const parsedResults = Array.isArray(result.ParsedResults)
      ? result.ParsedResults
      : [];

    const text = parsedResults
      .map((page, index) => {
        const pageText = safeText(page.ParsedText || '');
        return `--- PAGE ${index + 1} ---\n${pageText}`;
      })
      .join('\n\n')
      .trim();

    if (!text || text.length < 30) {
      return res.status(422).json({
        success: false,
        source: 'pdf_ocr',
        error: 'OCR completed, but extracted text is empty or too short.',
        details: result,
      });
    }

    return res.json({
      success: true,
      source: 'pdf_ocr',
      text,
      data: text,
      content: text,
      output: text,
      messages: [],
      metadata: {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        ocrEngine: 2,
        language: 'rus',
        textLength: text.length,
      },
    });
  } catch (error) {
    console.error('OCR PDF endpoint error:', error);

    return res.status(500).json({
      success: false,
      source: 'pdf_ocr',
      error: String(error.message || error),
    });
  }
});

app.post('/fill-docx-template', upload.any(), async (req, res) => {
  try {
    const templateFile = getUploadedFile(req, ['template', 'file']);

    if (!templateFile) {
      return res.status(400).json({
        success: false,
        source: 'fill_docx_template',
        error: 'No DOCX template uploaded. Expected form-data field: template or file',
      });
    }

    const rawData =
      req.body.data ||
      req.body.json ||
      req.body.payload ||
      req.body.proposalData ||
      '{}';

    const data = parseJsonField(rawData);

    const zip = new PizZip(templateFile.buffer);

    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: {
        start: '{{',
        end: '}}',
      },
      nullGetter() {
        return '';
      },
    });

    doc.render(data);

    const outputBuffer = doc.getZip().generate({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    });

    const fileName =
      req.body.fileName ||
      req.body.filename ||
      `kp_${new Date().toISOString().slice(0, 10)}.docx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(fileName)}"`
    );

    return res.send(outputBuffer);
  } catch (error) {
    console.error('DOCX render error:', error);

    let details = undefined;

    if (error.properties && error.properties.errors) {
      details = error.properties.errors.map(e => ({
        id: e.properties?.id,
        explanation: e.properties?.explanation,
        file: e.properties?.file,
        tag: e.properties?.xtag,
      }));
    }

    return res.status(500).json({
      success: false,
      source: 'fill_docx_template',
      error: String(error.message || error),
      details,
    });
  }
});

app.post('/render-docx', upload.any(), async (req, res) => {
  try {
    const templateFile = getUploadedFile(req, ['template', 'file']);

    if (!templateFile) {
      return res.status(400).json({
        success: false,
        source: 'render_docx',
        error: 'No DOCX template uploaded. Expected form-data field: template or file',
      });
    }

    const rawData =
      req.body.data ||
      req.body.json ||
      req.body.payload ||
      req.body.proposalData ||
      '{}';

    const data = parseJsonField(rawData);

    const zip = new PizZip(templateFile.buffer);

    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: {
        start: '{{',
        end: '}}',
      },
      nullGetter() {
        return '';
      },
    });

    doc.render(data);

    const outputBuffer = doc.getZip().generate({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    });

    const fileName =
      req.body.fileName ||
      req.body.filename ||
      `kp_${new Date().toISOString().slice(0, 10)}.docx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(fileName)}"`
    );

    return res.send(outputBuffer);
  } catch (error) {
    console.error('Render DOCX error:', error);

    let details = undefined;

    if (error.properties && error.properties.errors) {
      details = error.properties.errors.map(e => ({
        id: e.properties?.id,
        explanation: e.properties?.explanation,
        file: e.properties?.file,
        tag: e.properties?.xtag,
      }));
    }

    return res.status(500).json({
      success: false,
      source: 'render_docx',
      error: String(error.message || error),
      details,
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Cannot ${req.method} ${req.path}`,
    available_routes: [
      'GET /health',
      'POST /extract-docx',
      'POST /extract-pdf',
      'POST /extract-pdf-ocr',
      'POST /fill-docx-template',
      'POST /render-docx',
    ],
  });
});

app.listen(PORT, () => {
  console.log(`DOCX/PDF render service started on port ${PORT}`);
  console.log(`Available at /health`);
});
