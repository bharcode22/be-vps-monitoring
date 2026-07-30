const dbAsync = require('../services/db');
const { runVpsScript, ALLOWED_SCRIPTS } = require('../services/scriptService');

/**
 * Execute bash script (/home/pod/scripts/exec/auto-script.sh or kill-process.sh) on server
 */
const executeScript = async (req, res) => {
  try {
    const { id } = req.params;
    const { scriptName } = req.body;

    if (!scriptName) {
      return res.status(400).json({ success: false, error: 'Nama file skrip wajib diisi.' });
    }

    if (!ALLOWED_SCRIPTS.includes(scriptName)) {
      return res.status(400).json({
        success: false,
        error: `Skrip '${scriptName}' tidak diizinkan. Hanya auto-script.sh dan kill-process.sh yang diizinkan.`
      });
    }

    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server tidak ditemukan' });
    }

    const result = await runVpsScript(server, scriptName);
    res.json({
      success: true,
      message: `Skrip ${scriptName} berhasil dieksekusi pada server ${server.name}.`,
      data: result
    });
  } catch (err) {
    console.error(`Script Execution Error (Server ${req.params.id}):`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  executeScript
};
