const podInfluxService = require('../services/podInfluxService');

/**
 * Controller to manage and explore InfluxDB on POD V3 Edge nodes
 * Strictly READ-ONLY operations.
 */
class PodInfluxController {
  /**
   * GET /api/pod-influx/pods
   * List all POD V3 units with Influx port status and token info
   */
  async getPods(req, res) {
    try {
      const pods = await podInfluxService.listPodServers();
      return res.json({
        success: true,
        count: pods.length,
        data: pods
      });
    } catch (err) {
      console.error('[podInfluxController.getPods] Error:', err.message);
      return res.status(500).json({
        success: false,
        error: `Gagal memuat daftar armada POD V3: ${err.message}`
      });
    }
  }

  /**
   * GET /api/pod-influx/pods/:id/health
   * Check single POD InfluxDB connection and authorization health
   */
  async getPodHealth(req, res) {
    const { id } = req.params;
    try {
      const health = await podInfluxService.checkPodInfluxHealth(Number(id));
      return res.json({
        success: true,
        data: health
      });
    } catch (err) {
      console.error(`[podInfluxController.getPodHealth] Error for POD ${id}:`, err.message);
      return res.status(500).json({
        success: false,
        error: `Gagal mengecek status Influx POD: ${err.message}`
      });
    }
  }

  /**
   * POST /api/pod-influx/pods/:id/token/refresh
   * Force refresh token via SSH or set manual override
   */
  async refreshToken(req, res) {
    const { id } = req.params;
    const { token } = req.body || {};

    try {
      const result = await podInfluxService.refreshPodToken(Number(id), token);
      return res.json({
        success: true,
        message: token
          ? 'Token override manual berhasil disimpan dan diuji.'
          : 'Token berhasil di-refresh dari /home/pod/influx_token.json via SSH.',
        data: result
      });
    } catch (err) {
      console.error(`[podInfluxController.refreshToken] Error for POD ${id}:`, err.message);
      return res.status(500).json({
        success: false,
        error: `Gagal memperbarui token POD: ${err.message}`
      });
    }
  }

  /**
   * GET /api/pod-influx/pods/:id/buckets
   * Get list of buckets directly from the POD's InfluxDB
   */
  async getBuckets(req, res) {
    const { id } = req.params;

    try {
      const buckets = await podInfluxService.getPodBuckets(Number(id));
      return res.json({
        success: true,
        count: buckets.length,
        data: buckets
      });
    } catch (err) {
      console.error(`[podInfluxController.getBuckets] Error for POD ${id}:`, err.message);
      return res.status(500).json({
        success: false,
        error: err.message
      });
    }
  }

  /**
   * GET /api/pod-influx/pods/:id/schema
   * Discover schema (measurements, field keys, units) for a bucket in the POD
   */
  async getSchema(req, res) {
    const { id } = req.params;
    const { bucket = 'pod_monitoring', measurement, measurements } = req.query;

    try {
      const schema = await podInfluxService.getPodSchema(Number(id), bucket, measurements || measurement);
      return res.json({
        success: true,
        data: schema
      });
    } catch (err) {
      console.error(`[podInfluxController.getSchema] Error for POD ${id}:`, err.message);
      return res.status(500).json({
        success: false,
        error: err.message
      });
    }
  }

  /**
   * POST /api/pod-influx/pods/:id/query
   * Execute read-only Flux query on the POD
   */
  async queryData(req, res) {
    const { id } = req.params;
    const queryOptions = req.body || {};

    try {
      const result = await podInfluxService.queryPodData(Number(id), queryOptions);
      return res.json({
        success: true,
        ...result
      });
    } catch (err) {
      console.error(`[podInfluxController.queryData] Error for POD ${id}:`, err.message);
      const isForbidden = err.message.includes('Akses Ditolak');
      return res.status(isForbidden ? 403 : 500).json({
        success: false,
        error: err.message
      });
    }
  }

  /**
   * POST or GET /api/pod-influx/pods/:id/export
   * Export query results to CSV or JSON directly from the POD
   */
  async exportData(req, res) {
    const { id } = req.params;
    const options = req.method === 'POST' ? req.body : req.query;
    const format = (options.format || 'csv').toLowerCase();

    try {
      const { fileName, contentType, content } = await podInfluxService.exportPodData(
        Number(id),
        options,
        format
      );

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      return res.send(content);
    } catch (err) {
      console.error(`[podInfluxController.exportData] Error for POD ${id}:`, err.message);
      const isForbidden = err.message.includes('Akses Ditolak');
      return res.status(isForbidden ? 403 : 500).json({
        success: false,
        error: err.message
      });
    }
  }

  /**
   * POST /api/pod-influx/pods/:id/cli-export
   * Trigger direct Influx CLI export on the POD via SSH
   */
  async runCliExportOnPod(req, res) {
    const { id } = req.params;
    try {
      const result = await podInfluxService.executePodCliExport(Number(id), req.body || {});
      return res.json({
        success: true,
        message: 'Ekspor data via Influx CLI di POD berhasil dijalankan.',
        data: result
      });
    } catch (err) {
      console.error(`[podInfluxController.runCliExportOnPod] Error for POD ${id}:`, err.message);
      const isForbidden = err.message.includes('Akses Ditolak');
      return res.status(isForbidden ? 403 : 500).json({
        success: false,
        error: err.message
      });
    }
  }

  /**
   * GET /api/pod-influx/pods/:id/exports
   * List all exported CSV files stored on the POD
   */
  async listExportFiles(req, res) {
    const { id } = req.params;
    try {
      const files = await podInfluxService.listPodExportFiles(Number(id));
      return res.json({
        success: true,
        count: files.length,
        data: files
      });
    } catch (err) {
      console.error(`[podInfluxController.listExportFiles] Error for POD ${id}:`, err.message);
      return res.status(500).json({
        success: false,
        error: `Gagal memuat daftar berkas ekspor: ${err.message}`
      });
    }
  }

  /**
   * DELETE /api/pod-influx/pods/:id/exports/:filename
   * Delete an exported CSV file from the POD
   */
  async deleteExportFile(req, res) {
    const { id, filename } = req.params;
    try {
      const result = await podInfluxService.deletePodExportFile(Number(id), filename);
      return res.json({
        success: true,
        message: `Berkas ${result.fileName} berhasil dihapus dari POD.`
      });
    } catch (err) {
      console.error(`[podInfluxController.deleteExportFile] Error for POD ${id}:`, err.message);
      return res.status(500).json({
        success: false,
        error: `Gagal menghapus berkas ekspor: ${err.message}`
      });
    }
  }

  /**
   * GET /api/pod-influx/pods/:id/exports/:filename/download
   * Stream download an exported CSV file directly from the POD to the client browser
   */
  async downloadExportFile(req, res) {
    const { id, filename } = req.params;
    try {
      await podInfluxService.streamPodExportFileToClient(Number(id), filename, res);
    } catch (err) {
      console.error(`[podInfluxController.downloadExportFile] Error for POD ${id}:`, err.message);
      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          error: `Gagal mengunduh berkas ekspor: ${err.message}`
        });
      }
    }
  }

  /**
   * GET /api/pod-influx/templates
   * Get all cross-POD saved query templates
   */
  async getTemplates(req, res) {
    try {
      const templates = await podInfluxService.getQueryTemplates();
      return res.json({
        success: true,
        count: templates.length,
        data: templates
      });
    } catch (err) {
      console.error('[podInfluxController.getTemplates] Error:', err.message);
      return res.status(500).json({
        success: false,
        error: `Gagal memuat template query: ${err.message}`
      });
    }
  }

  /**
   * POST /api/pod-influx/templates
   * Save a new cross-POD query template
   */
  async createTemplate(req, res) {
    try {
      const created = await podInfluxService.createQueryTemplate(req.body);
      return res.json({
        success: true,
        message: 'Template query berhasil disimpan.',
        data: created
      });
    } catch (err) {
      console.error('[podInfluxController.createTemplate] Error:', err.message);
      const isForbidden = err.message.includes('Akses Ditolak');
      return res.status(isForbidden ? 403 : 500).json({
        success: false,
        error: err.message
      });
    }
  }

  /**
   * PUT /api/pod-influx/templates/:id
   * Update an existing query template
   */
  async updateTemplate(req, res) {
    const { id } = req.params;
    try {
      const updated = await podInfluxService.updateQueryTemplate(Number(id), req.body);
      return res.json({
        success: true,
        message: 'Template query berhasil diperbarui.',
        data: updated
      });
    } catch (err) {
      console.error(`[podInfluxController.updateTemplate] Error for template ${id}:`, err.message);
      const isForbidden = err.message.includes('Akses Ditolak');
      return res.status(isForbidden ? 403 : 500).json({
        success: false,
        error: err.message
      });
    }
  }

  /**
   * DELETE /api/pod-influx/templates/:id
   * Delete a query template
   */
  async deleteTemplate(req, res) {
    const { id } = req.params;
    try {
      const deleted = await podInfluxService.deleteQueryTemplate(Number(id));
      return res.json({
        success: true,
        message: 'Template query berhasil dihapus.',
        data: deleted
      });
    } catch (err) {
      console.error(`[podInfluxController.deleteTemplate] Error for template ${id}:`, err.message);
      return res.status(500).json({
        success: false,
        error: err.message
      });
    }
  }
}

module.exports = new PodInfluxController();
