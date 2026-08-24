const { executeSshCommand } = require('../utils/sshExecutor');

const DOCKER_FORMAT = '{"id":"{{.ID}}","name":"{{.Names}}","image":"{{.Image}}","status":"{{.Status}}","state":"{{.State}}","ports":"{{.Ports}}","created":"{{.CreatedAt}}"}';

/**
 * List all Docker containers on the server (docker ps -a)
 */
async function listDockerContainers(server) {
  const cmd = `docker ps -a --format '${DOCKER_FORMAT}' 2>/dev/null || echo ""`;
  try {
    const stdout = await executeSshCommand(server, cmd, { timeoutMs: 15000 });
    const lines = stdout.trim().split('\n').filter(line => line.trim() !== '');
    const containers = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        containers.push(parsed);
      } catch (e) {
        // Skip unparseable lines
      }
    }

    return containers;
  } catch (err) {
    throw new Error(`Gagal mengeksekusi pemeriksaan container Docker: ${err.message}`);
  }
}

/**
 * Restart a Docker container by name
 */
async function restartDockerContainer(server, containerName) {
  // Sanitize containerName to prevent command injection
  const safeName = String(containerName).replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!safeName) throw new Error('Nama container tidak valid.');

  const cmd = `docker restart ${safeName}`;
  try {
    const stdout = await executeSshCommand(server, cmd, { timeoutMs: 25000 });
    return { success: true, container: safeName, output: stdout.trim() };
  } catch (err) {
    // Auto-recovery for Docker network disconnection bug ("failed to set up container networking: network ... not found")
    if (err.message && (err.message.includes('network') || err.message.includes('not found') || err.message.includes('Cannot restart container'))) {
      try {
        const recoveryCmd = `
          COMPOSE_PATH=$(find $HOME/dev $HOME/workspace $HOME/prod $HOME -maxdepth 3 -name "docker-compose*.y*ml" -o -name "compose*.y*ml" 2>/dev/null | xargs grep -l "${safeName}" 2>/dev/null | head -n 1)
          if [ -n "$COMPOSE_PATH" ]; then
            COMPOSE_DIR=$(dirname "$COMPOSE_PATH")
            cd "$COMPOSE_DIR" && (docker compose up -d --force-recreate ${safeName} 2>&1 || docker-compose up -d --force-recreate ${safeName} 2>&1)
          else
            docker rm -f ${safeName} 2>/dev/null || true
            docker start ${safeName} 2>&1 || true
          fi
        `;
        const recoveryOut = await executeSshCommand(server, recoveryCmd, { timeoutMs: 60000 });
        return { success: true, container: safeName, output: `Container ${safeName} berhasil dipulihkan & direstart:\n${recoveryOut.trim()}` };
      } catch (recErr) {
        throw new Error(`Gagal memuat ulang (restart) container ${safeName}: ${err.message}. Upaya perbaikan otomatis: ${recErr.message}`);
      }
    }
    throw new Error(`Gagal memuat ulang (restart) container ${safeName}: ${err.message}`);
  }
}

/**
 * Stop a Docker container by name or ID
 */
async function stopDockerContainer(server, containerName) {
  const safeName = String(containerName).replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!safeName) throw new Error('Nama container tidak valid.');

  const cmd = `docker stop ${safeName}`;
  try {
    const stdout = await executeSshCommand(server, cmd, { timeoutMs: 20000 });
    return { success: true, container: safeName, output: stdout.trim() };
  } catch (err) {
    throw new Error(`Gagal menghentikan (stop) container ${safeName}: ${err.message}`);
  }
}

/**
 * Fetch last 100 lines of Docker container logs
 */
async function getDockerContainerLogs(server, containerName) {
  const safeName = String(containerName).replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!safeName) throw new Error('Nama container tidak valid.');

  const cmd = `docker logs --tail 100 ${safeName} 2>&1`;
  try {
    const stdout = await executeSshCommand(server, cmd, { timeoutMs: 15000 });
    return { success: true, container: safeName, logs: stdout };
  } catch (err) {
    throw new Error(`Gagal mengambil log container ${safeName}: ${err.message}`);
  }
}

/**
 * Remove a Docker container (docker rm -f)
 */
async function removeDockerContainer(server, containerName) {
  const safeName = String(containerName).replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!safeName) throw new Error('Nama container tidak valid.');

  const cmd = `docker rm -f ${safeName}`;
  try {
    const stdout = await executeSshCommand(server, cmd, { timeoutMs: 15000 });
    return { success: true, container: safeName, output: stdout.trim() };
  } catch (err) {
    throw new Error(`Gagal menghapus (docker rm) container ${safeName}: ${err.message}`);
  }
}

module.exports = {
  listDockerContainers,
  restartDockerContainer,
  stopDockerContainer,
  removeDockerContainer,
  getDockerContainerLogs
};
