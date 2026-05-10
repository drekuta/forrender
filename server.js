const express = require('express');
const multer = require('multer');
const Docxtemplater = require('docxtemplater');
const PizZip = require('pizzip');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.get('/', (req, res) => {
  res.send('DOCX render service is running');
});

app.post('/render-docx', upload.single('template'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No template file uploaded. Field name must be template.' });
    }

    if (!req.body.data) {
      return res.status(400).json({ error: 'No JSON data provided. Field name must be data.' });
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
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`DOCX render service started on port ${port}`);
});