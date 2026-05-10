const express = require('express');
const multer = require('multer');
const Docxtemplater = require('docxtemplater');
const PizZip = require('pizzip');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.get('/', (req, res) => {
  res.send('DOCX render service is running');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'docx-render-service'
  });
});

app.get('/render-docx', (req, res) => {
  res.send('Use POST /render-docx with form-data fields: template and data');
});

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
    } catch (e) {
      return res.status(400).json({
        error: 'Invalid JSON in data field',
        details: e.message
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
    console.error(error);

    res.status(500).json({
      error: 'DOCX render failed',
      message: error.message,
      properties: error.properties || null
    });
  }
}

app.post('/render-docx', upload.single('template'), renderDocx);

// запасной endpoint, если где-то ошибешься с названием
app.post('/render', upload.single('template'), renderDocx);

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`DOCX render service started on port ${port}`);
});
