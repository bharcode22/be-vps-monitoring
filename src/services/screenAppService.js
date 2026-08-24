const { executeSshCommand } = require('../utils/sshExecutor');

/**
 * List status of Native Linux GUI Screen Apps (small-screen & big-screen)
 */
async function listScreenApps(server) {
  const cmd = `ps aux | grep -v grep | grep -E "(usr/lib/small-screen|small-screen)" >/dev/null 2>&1 && echo "small-screen:running" || echo "small-screen:exited"; ps aux | grep -v grep | grep -E "(usr/lib/big-screen|big-screen)" >/dev/null 2>&1 && echo "big-screen:running" || echo "big-screen:exited";`;

  try {
    const stdout = await executeSshCommand(server, cmd, { timeoutMs: 15000 });
    const apps = [];

    const isSmallScreenRunning = stdout.includes('small-screen:running');
    apps.push({
      id: 'sys-small-screen',
      name: 'small-screen',
      image: 'Native GUI App (/usr/lib/small-screen)',
      status: isSmallScreenRunning ? 'Up (running)' : 'Exited (0)',
      state: isSmallScreenRunning ? 'running' : 'exited',
      ports: 'System App',
      isSystemApp: true,
      path: '/usr/lib/small-screen/small-screen'
    });

    const isBigScreenRunning = stdout.includes('big-screen:running');
    apps.push({
      id: 'sys-big-screen',
      name: 'big-screen',
      image: 'Native GUI App (/usr/lib/big-screen)',
      status: isBigScreenRunning ? 'Up (running)' : 'Exited (0)',
      state: isBigScreenRunning ? 'running' : 'exited',
      ports: 'System App',
      isSystemApp: true,
      path: '/usr/lib/big-screen/big-screen'
    });

    return apps;
  } catch (err) {
    throw new Error(`Gagal memeriksa status Screen Apps: ${err.message}`);
  }
}

/**
 * Restart Screen App (small-screen or big-screen)
 */
async function restartScreenApp(server, appName) {
  const safeName = String(appName).trim().toLowerCase();
  if (safeName !== 'small-screen' && safeName !== 'big-screen') {
    throw new Error('Nama aplikasi layar tidak valid. Hanya small-screen atau big-screen yang didukung.');
  }

  const cmd = `systemctl restart ${safeName} 2>/dev/null || systemctl --user restart ${safeName} 2>/dev/null || (pkill -9 -f "${safeName}" 2>/dev/null; sleep 1; DISPLAY=:0 nohup /usr/lib/${safeName}/${safeName} >/dev/null 2>&1 &); sleep 1; ps aux | grep -v grep | grep -E "${safeName}"`;

  try {
    const stdout = await executeSshCommand(server, cmd, { timeoutMs: 25000 });
    return { success: true, app: safeName, output: stdout.trim() || `Aplikasi ${safeName} berhasil dimuat ulang.` };
  } catch (e) {
    return { success: true, app: safeName, output: `Sinyal restart dikirim ke ${safeName}.` };
  }
}

/**
 * Stop Screen App (small-screen or big-screen)
 */
async function stopScreenApp(server, appName) {
  const safeName = String(appName).trim().toLowerCase();
  if (safeName !== 'small-screen' && safeName !== 'big-screen') {
    throw new Error('Nama aplikasi layar tidak valid. Hanya small-screen atau big-screen yang didukung.');
  }

  const cmd = `systemctl stop ${safeName} 2>/dev/null || systemctl --user stop ${safeName} 2>/dev/null || pkill -9 -f "${safeName}" 2>/dev/null || true`;

  try {
    const stdout = await executeSshCommand(server, cmd, { timeoutMs: 15000 });
    return { success: true, app: safeName, output: stdout.trim() || `Aplikasi ${safeName} berhasil dihentikan.` };
  } catch (e) {
    return { success: true, app: safeName, output: `Sinyal stop dikirim ke ${safeName}.` };
  }
}

/**
 * Fetch logs for Screen App
 */
async function getScreenAppLogs(server, appName) {
  const safeName = String(appName).trim().toLowerCase();
  if (safeName !== 'small-screen' && safeName !== 'big-screen') {
    throw new Error('Nama aplikasi layar tidak valid. Hanya small-screen atau big-screen yang didukung.');
  }

  const cmd = `journalctl -u ${safeName} -n 100 --no-pager 2>/dev/null || journalctl --user -u ${safeName} -n 100 --no-pager 2>/dev/null || tail -n 100 /home/pod/.config/${safeName}/*.log 2>/dev/null || tail -n 100 /home/pod/.config/${safeName}/logs/*.log 2>/dev/null || tail -n 100 /tmp/${safeName}.log 2>/dev/null || (echo "=== INFORMASI PROSES NATIVE SYSTEM LINUX (${safeName}) ===" && ps aux | grep -v grep | grep -E "${safeName}");`;

  try {
    const stdout = await executeSshCommand(server, cmd, { timeoutMs: 15000 });
    return { success: true, app: safeName, logs: stdout.trim() || `Informasi log aplikasi ${safeName} aktif.` };
  } catch (err) {
    throw new Error(`Gagal mengambil log aplikasi ${safeName}: ${err.message}`);
  }
}

module.exports = {
  listScreenApps,
  restartScreenApp,
  stopScreenApp,
  getScreenAppLogs
};
