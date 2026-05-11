const express = require('express');
const multer = require('multer');
const cors = require('cors');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

const fs = require('fs');
const path = require('path');
const os = require('os');

const { createWorker } = require('tesseract.js');
const pdfPoppler = require('pdf-poppler');

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
  const text = safeText(payload.text || payload.data || payload.content || payload.output || '');

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
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-ocr-'));
  const pdfPath = path.join(workDir, 'input.pdf');

  let worker = null;

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        source: 'pdf_ocr',
        error: 'No PDF file uploaded. Expected form-data field: file',
      });
    }

    fs.writeFileSync(pdfPath, req.file.buffer);

    const outputPrefix = 'page';

    await pdfPoppler.convert(pdfPath, {
      format: 'png',
      out_dir: workDir,
      out_prefix: outputPrefix,
      page: null,
      scale: 1800,
    });

    const imageFiles = fs
      .readdirSync(workDir)
      .filter(name => name.toLowerCase().endsWith('.png'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map(name => path.join(workDir, name));

    if (imageFiles.length === 0) {
      return res.status(422).json({
        success: false,
        source: 'pdf_ocr',
        error: 'PDF was not converted to images. OCR cannot continue.',
      });
    }

    worker = await createWorker('rus+eng');

    const parts = [];

    for (let i = 0; i < imageFiles.length; i++) {
      const result = await worker.recognize(imageFiles[i]);
      const pageText = safeText(result?.data?.text || '');

      parts.push(`--- PAGE ${i + 1} ---\n${pageText}`);
    }

    const text = safeText(parts.join('\n\n'));

    return responseText(res, {
      success: true,
      source: 'pdf_ocr',
      text,
      metadata: {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        pages: imageFiles.length,
        textLength: text.length,
      },
    });
  } catch (error) {
    console.error('OCR PDF error:', error);

    return res.status(500).json({
      success: false,
      source: 'pdf_ocr',
      error: String(error.message || error),
      hint: 'If this happens on Render Free, OCR may require more memory/time or Poppler support.',
    });
  } finally {
    try {
      if (worker) {
        await worker.terminate();
      }
    } catch (e) {
      console.error('OCR worker terminate error:', e);
    }

    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (e) {
      console.error('Cleanup OCR temp dir error:', e);
    }
  }
});

app.post('/fill-docx-template', upload.any(), async (req, res) => {
  try {
    const templateFile = getUploadedFile(req, ['template', 'file']);

    if (!templateFile) {
      return res.status(400).json({
        success: false,
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
  req.url = '/fill-docx-template';
  return app._router.handle(req, res);
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
    ],
  });
});

app.listen(PORT, () => {
  console.log(`DOCX/PDF render service started on port ${PORT}`);
  console.log(`Available at /health`);
});
