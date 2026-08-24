const { executeSshCommand } = require('../utils/sshExecutor');

const ALLOWED_SCRIPTS = ['auto-script.sh', 'kill-process.sh'];
const SCRIPT_DIR = '/home/pod/scripts/exec';

/**
 * Execute bash script inside /home/pod/scripts/exec/ on local host or remote SSH server
 */
async function runVpsScript(server, scriptName) {
  if (!ALLOWED_SCRIPTS.includes(scriptName)) {
    throw new Error(`Skrip ${scriptName} tidak diizinkan untuk dieksekusi. Hanya auto-script.sh dan kill-process.sh yang diizinkan.`);
  }

  const scriptPath = `${SCRIPT_DIR}/${scriptName}`;
  const command = `cd ${SCRIPT_DIR} && (sed -i 's/\\r$//' ${scriptName} 2>/dev/null || true); (chmod +x ${scriptName} 2>/dev/null || true); (bash ./${scriptName} || sh ./${scriptName} || ./${scriptName}) 2>&1`;

  try {
    const stdout = await executeSshCommand(server, command, { timeoutMs: 30000 });
    return {
      success: true,
      script: scriptName,
      path: scriptPath,
      output: stdout || 'Skrip selesai tanpa output.'
    };
  } catch (err) {
    throw new Error(`Gagal mengeksekusi skrip ${scriptName}: ${err.message}`);
  }
}

module.exports = {
  runVpsScript,
  ALLOWED_SCRIPTS
};
