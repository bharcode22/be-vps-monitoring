const fs = require('fs');
const path = require('path');

/**
 * Fetch list of available .env configuration files in backend/envoirment
 */
async function getEnvFiles() {
  try {
    const envDir = path.join(__dirname, '../../../envoirment');
    if (!fs.existsSync(envDir)) {
      return { success: true, files: [] };
    }
    const fileNames = fs.readdirSync(envDir).filter(f => f.endsWith('.env') || f.endsWith('.env.example'));
    const files = fileNames.map(fileName => {
      const filePath = path.join(envDir, fileName);
      let content = '';
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch (e) {
        content = '';
      }
      return {
        name: fileName,
        path: filePath,
        content
      };
    });
    return { success: true, files };
  } catch (err) {
    console.error('Error reading env files directory:', err);
    return { success: false, error: err.message, files: [] };
  }
}

/**
 * Read specific .env file content by filename
 */
function readEnvFileContent(envFilename) {
  if (!envFilename) return '';
  const envPath = path.join(__dirname, '../../../envoirment', envFilename);
  if (fs.existsSync(envPath)) {
    try {
      return fs.readFileSync(envPath, 'utf8');
    } catch (e) {
      return '';
    }
  }
  return '';
}

module.exports = {
  getEnvFiles,
  readEnvFileContent
};
