const fs = require('fs');
const path = require('path');
const podInfluxService = require('../services/podInfluxService');
const { podChartPdfService, parseInfluxCsvForReport } = require('../services/report/podChartPdfService');

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
    const { bucket = 'pod_monitoring', buckets, measurement, measurements } = req.query;

    try {
      const targetBuckets = buckets || bucket;
      const schema = await podInfluxService.getPodSchema(Number(id), targetBuckets, measurements || measurement);
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

  /**
   * POST or GET /api/pod-influx/pods/:id/chart-report
   * Generate landscape 3-page timeseries chart PDF report (PEMF, Temp & Hum, Heartbeat)
   */
  async generateChartPdfReport(req, res) {
    const { id } = req.params;
    const podId = Number(id);
    const options = req.method === 'POST' ? req.body : req.query;

    const {
      date = null,
      startTime = null,
      stopTime = null,
      moduleName = 'Chair',
      moduleId = String(podId || 502),
      csvFile = null,
      clientData = null
    } = options;

    try {
      let dataset = null;
      const targetDate = date || new Date().toISOString().slice(0, 10);

      // 1. If explicit CSV file given, parse directly
      if (csvFile && typeof csvFile === 'string') {
        const repoRoot = path.resolve(__dirname, '../../..');
        const resolvedPath = path.resolve(repoRoot, csvFile);
        if (fs.existsSync(resolvedPath)) {
          const content = fs.readFileSync(resolvedPath, 'utf-8');
          dataset = parseInfluxCsvForReport(content, targetDate);
        }
      }

      // 2. Obtain records either from clientData (frontend memory) or Influx query
      if (!dataset) {
        let records = null;
        // Strip |> limit(...) so the report covers the full time range without truncation
        let fluxQuery = options.rawFluxQuery;
        if (fluxQuery) {
          fluxQuery = fluxQuery
            .split('\n')
            .filter(line => !line.trim().startsWith('|> limit('))
            .join('\n');
        }

        // Only use clientData if it is NOT truncated by a preview limit
        const clientDataIsTruncated = Array.isArray(clientData) && clientData.length > 0 && options.rawFluxQuery && options.rawFluxQuery.includes('limit(');

        if (Array.isArray(clientData) && clientData.length > 0 && !clientDataIsTruncated) {
          records = clientData;
        } else {
          if (!fluxQuery) {
            const rangeClause = options.range
              ? `|> range(start: ${options.range})`
              : `|> range(start: ${startTime || targetDate + 'T00:00:00Z'}, stop: ${stopTime || targetDate + 'T23:59:59Z'})`;

            fluxQuery = `b0 = from(bucket: "pod_monitoring")
  ${rangeClause}
  |> filter(fn: (r) => r["_measurement"] == "mod_chair" or r["_measurement"] == "hb_module" or r["_measurement"] == "heartbeat")
  |> filter(fn: (r) => r["_field"] == "temperature" or r["_field"] == "humidity" or r["_field"] == "current" or r["_field"] == "chair_temp" or r["_field"] == "chair_hum" or r["_field"] == "set_pemf" or r["_field"] =~ /^hb/)
  |> set(key: "bucket", value: "pod_monitoring")
b1 = from(bucket: "power_monitoring")
  ${rangeClause}
  |> filter(fn: (r) => r["_measurement"] == "mod_chair" or r["_measurement"] == "hb_module" or r["_measurement"] == "heartbeat")
  |> filter(fn: (r) => r["_field"] == "temperature" or r["_field"] == "humidity" or r["_field"] == "current" or r["_field"] == "chair_temp" or r["_field"] == "chair_hum" or r["_field"] == "set_pemf" or r["_field"] =~ /^hb/)
  |> set(key: "bucket", value: "power_monitoring")
union(tables: [b0, b1])`;
          }

          const queryResult = await podInfluxService.queryPodData(podId, {
            rawFluxQuery: fluxQuery,
            limit: 0
          });
          records = Array.isArray(queryResult?.data) ? queryResult.data : [];
        }

        const rawPemf = [];
        const rawTemp = [];
        const rawHum = [];
        const rawHb = [];

        if (Array.isArray(records)) {
          for (const r of records) {
            if (r._value === null || r._value === undefined || isNaN(Number(r._value))) continue;
            const timeMs = new Date(r._time).getTime();
            if (isNaN(timeMs)) continue;
            const val = Number(r._value);
            const field = String(r._field || '').toLowerCase();
            const section = String(r.chair_section || '').toUpperCase();
            const measurement = String(r._measurement || '').toLowerCase();

            // Current: matches 'current', 'pemf_cur', 'set_pemf' (keep original value matching frontend)
            if (field.includes('current') || field === 'pemf_cur' || field === 'set_pemf') {
              rawPemf.push({ time: timeMs, value: val, section });
            } else if (field.includes('temp') || field.includes('suhu') || field === 'chair_temp') {
              rawTemp.push({ time: timeMs, value: val });
            } else if (field.includes('hum') || field.includes('kelembaban') || field === 'chair_hum') {
              rawHum.push({ time: timeMs, value: val });
            } else if (field.includes('heartbeat') || field.includes('hb') || field.startsWith('hb') || measurement === 'heartbeat') {
              rawHb.push({ time: timeMs, value: val });
            }
          }
        }

        // Use all matching current points (preserving original values and chair_sections)
        const pemfPoints = rawPemf;

        const sortFn = (a, b) => a.time - b.time;
        pemfPoints.sort(sortFn);
        rawTemp.sort(sortFn);
        rawHum.sort(sortFn);
        rawHb.sort(sortFn);

        // Effective date display
        let effectiveDate = targetDate;
        if (startTime && stopTime) {
          const sDate = startTime.slice(0, 10);
          const eDate = stopTime.slice(0, 10);
          effectiveDate = sDate === eDate ? sDate : `${sDate} s/d ${eDate}`;
        } else if (records[0]?._time) {
          effectiveDate = records[0]._time.slice(0, 10);
        }

        dataset = {
          date: effectiveDate,
          pemf: pemfPoints,
          temp: rawTemp,
          hum: rawHum,
          heartbeat: rawHb
        };
      }

      const cleanDate = targetDate.replace(/-/g, '');
      const fileName = `report_${moduleName.toLowerCase()}_${moduleId}_${cleanDate}.pdf`;

      const pdfBuffer = await podChartPdfService.buildReport({
        dataset,
        options: {
          date: dataset?.date || targetDate,
          startTime,
          stopTime,
          moduleName,
          moduleId,
          sampling: options.sampling || '1s',
          timeZone: options.timeZone || 'Original'
        }
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Length', pdfBuffer.length);
      return res.send(pdfBuffer);
    } catch (err) {
      console.error(`[podInfluxController.generateChartPdfReport] Error for POD ${id}:`, err.message);
      return res.status(500).json({
        success: false,
        error: `Gagal membuat laporan PDF grafik sensor: ${err.message}`
      });
    }
  }
}

module.exports = new PodInfluxController();
