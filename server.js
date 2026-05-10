const express = require('express');
const multer = require('multer');
const Docxtemplater = require('docxtemplater');
const PizZip = require('pizzip');
const mammoth = require('mammoth');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.get('/', (req, res) => {
  res.send('DOCX render service is running');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'docx-render-service',
    endpoints: [
      'POST /render-docx',
      'POST /render',
      'POST /extract-docx',
      'POST /extract-word'
    ]
  });
});

app.get('/render-docx', (req, res) => {
  res.send('Use POST /render-docx with form-data fields: template and data');
});

app.get('/extract-docx', (req, res) => {
  res.send('Use POST /extract-docx with form-data field: file');
});

/**
 * DOCX TEXT EXTRACTOR
 * Used by n8n to extract text from client request DOCX files.
 *
 * n8n settings:
 * Method: POST
 * URL: https://forrender-l1ql.onrender.com/extract-docx
 * Body Content Type: Form-Data
 * Field:
 *   Name: file
 *   Type: n8n Binary File
 *   Input Data Field Name: data
 */
async function extractDocx(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'No DOCX file uploaded. Field name must be file.'
      });
    }

    const result = await mammoth.extractRawText({
      buffer: req.file.buffer
    });

    res.json({
      success: true,
      text: result.value || '',
      messages: result.messages || []
    });
  } catch (error) {
    console.error('DOCX extraction failed:', error);

    res.status(500).json({
      success: false,
      error: 'DOCX extraction failed',
      message: error.message
    });
  }
}

/**
 * DOCX TEMPLATE RENDERER
 * Used by n8n to fill Word template.
 *
 * n8n settings:
 * Method: POST
 * URL: https://forrender-l1ql.onrender.com/render-docx
 * Body Content Type: Form-Data
 * Fields:
 *   1) Name: template
 *      Type: n8n Binary File
 *      Input Data Field Name: template
 *
 *   2) Name: data
 *      Type: Text
 *      Value: {{ JSON.stringify($json.proposalData) }}
 */
async function renderDocx(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'No template file uploaded. Field name must be template.'
      });
    }

    if (!req.body.data) {
      return res.status(400).json({
        error: 'No JSON data provided. Field name must be data.'
      });
    }

    let jsonData;

    try {
      jsonData = JSON.parse(req.body.data);
    } catch (error) {
      return res.status(400).json({
        error: 'Invalid JSON in data field',
        message: error.message,
        receivedDataPreview: String(req.body.data).slice(0, 1000)
      });
    }

    const zip = new PizZip(req.file.buffer);

    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter() {
        return '';
      }
    });

    doc.render(jsonData);

    const buffer = doc.getZip().generate({
      type: 'nodebuffer',
      compression: 'DEFLATE'
    });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );

    res.setHeader(
      'Content-Disposition',
      'attachment; filename="commercial_proposal.docx"'
    );

    res.send(buffer);
  } catch (error) {
    console.error('DOCX render failed:', error);

    res.status(500).json({
      error: 'DOCX render failed',
      message: error.message,
      properties: error.properties || null
    });
  }
}

app.post('/extract-docx', upload.single('file'), extractDocx);
app.post('/extract-word', upload.single('file'), extractDocx);

app.post('/render-docx', upload.single('template'), renderDocx);
app.post('/render', upload.single('template'), renderDocx);

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`DOCX render service started on port ${port}`);
});
