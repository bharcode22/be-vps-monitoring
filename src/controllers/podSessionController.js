const fs = require('fs');
const path = require('path');
const { getMasterPool } = require('../services/masterDbService');
const dbAsync = require('../services/db');

const TEMPLATES_DIR = path.resolve(__dirname, '../../data/pod_session_templates');

// Ensure templates directory exists
if (!fs.existsSync(TEMPLATES_DIR)) {
  try {
    fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
  } catch (e) {
    console.error('Failed to create TEMPLATES_DIR:', e.message);
  }
}

/**
 * GET /api/vps/pod-sessions/pods
 * Mengambil daftar unit server HANYA untuk POD V3 dari tabel `servers` (model Server).
 * Menggunakan kolom `pod_uuid` untuk diterapkan di setiap kebutuhan `pod_id` / `podSettingId` endpoint.
 */
async function getMasterPods(req, res) {
  try {
    const query = `
      SELECT 
        id as server_id,
        name,
        host,
        port,
        code,
        pod_uuid,
        pod_version,
        type
      FROM servers 
      WHERE type = 'pod' 
        AND (pod_version = 'v3' OR pod_version ILIKE '%v3%')
        AND pod_uuid IS NOT NULL 
        AND TRIM(pod_uuid) != ''
      ORDER BY 
        CASE WHEN code ~ '^[0-9]+$' THEN CAST(code AS INTEGER) ELSE 9999 END ASC, 
        code ASC;
    `;
    const rows = await dbAsync.all(query);

    const pods = rows.map(s => ({
      id: s.pod_uuid.trim(), // Primary identifier (podSettingId / pod_id) untuk Master API
      pod_uuid: s.pod_uuid.trim(),
      serverId: s.server_id,
      name: s.name,
      code: s.code,
      host: s.host,
      ip_address: s.host,
      pod_version: s.pod_version || 'v3',
      isMonitored: true
    }));

    return res.json({
      success: true,
      pods,
      count: pods.length
    });
  } catch (error) {
    console.error('Error fetching pod v3 servers:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Gagal mengambil daftar server POD V3 dari tabel servers'
    });
  }
}

/**
 * GET /api/vps/pod-sessions/experiences/:podId
 * Retrieve standard Signature experiences for a specific POD from Master DB
 */
async function getPodExperiences(req, res) {
  try {
    const { podId } = req.params;
    if (!podId) {
      return res.status(400).json({ success: false, error: 'Parameter podId diperlukan' });
    }

    const pool = await getMasterPool();
    const query = `
      SELECT 
        id, 
        pod_id, 
        menu_name, 
        information, 
        link_class, 
        icon_name, 
        icon_class, 
        active, 
        created_date 
      FROM experiences 
      WHERE pod_id::text = $1::text 
      ORDER BY id ASC;
    `;
    const expRes = await pool.query(query, [podId]);

    return res.json({
      success: true,
      podId,
      experiences: expRes.rows || []
    });
  } catch (error) {
    console.error('Error fetching pod experiences:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Gagal mengambil sesi Signature POD'
    });
  }
}

/**
 * GET /api/vps/pod-sessions/templates
 * Retrieve all saved detail_experience templates
 */
function getTemplates(req, res) {
  try {
    if (!fs.existsSync(TEMPLATES_DIR)) {
      return res.json({ success: true, templates: [] });
    }

    const files = fs.readdirSync(TEMPLATES_DIR);
    const templates = [];

    files.forEach(file => {
      if (file.endsWith('.json')) {
        try {
          const filePath = path.join(TEMPLATES_DIR, file);
          const content = fs.readFileSync(filePath, 'utf8');
          const parsed = JSON.parse(content);
          templates.push({
            filename: file,
            ...parsed
          });
        } catch (e) {
          console.warn(`Skipping invalid template file ${file}:`, e.message);
        }
      }
    });

    // Sort by created_at desc
    templates.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    return res.json({
      success: true,
      templates,
      count: templates.length
    });
  } catch (error) {
    console.error('Error reading templates:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Gagal membaca library template'
    });
  }
}

/**
 * POST /api/vps/pod-sessions/templates
 * Save a new detail_experience template
 */
function saveTemplate(req, res) {
  try {
    const {
      template_name,
      target_session = 'RECHARGE',
      description = '',
      detail_experience,
      author = 'Operator'
    } = req.body;

    if (!template_name || !detail_experience) {
      return res.status(400).json({
        success: false,
        error: 'template_name dan detail_experience wajib diisi'
      });
    }

    // Sanitize filename
    const slug = template_name
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .substring(0, 50);
    const filename = `${target_session.toLowerCase()}_${slug}_${Date.now()}.json`;
    const filePath = path.join(TEMPLATES_DIR, filename);

    // Remove any POD-specific local IDs from detail_experience to keep it clean and portable
    const cleanDetail = { ...detail_experience };
    delete cleanDetail.id;
    delete cleanDetail.experience_id;

    const templateData = {
      id: `tpl-${Date.now()}`,
      template_version: '1.0',
      template_name,
      target_session: target_session.toUpperCase(),
      description,
      author,
      created_at: new Date().toISOString(),
      detail_experience: cleanDetail
    };

    fs.writeFileSync(filePath, JSON.stringify(templateData, null, 2), 'utf8');

    return res.json({
      success: true,
      message: 'Template berhasil disimpan',
      template: {
        filename,
        ...templateData
      }
    });
  } catch (error) {
    console.error('Error saving template:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Gagal menyimpan template'
    });
  }
}

/**
 * DELETE /api/vps/pod-sessions/templates/:filename
 * Delete a saved template
 */
function deleteTemplate(req, res) {
  try {
    const { filename } = req.params;
    if (!filename || !filename.endsWith('.json')) {
      return res.status(400).json({ success: false, error: 'Nama file template tidak valid' });
    }

    const safeFilename = path.basename(filename);
    const filePath = path.join(TEMPLATES_DIR, safeFilename);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return res.json({ success: true, message: `Template ${safeFilename} berhasil dihapus` });
    } else {
      return res.status(404).json({ success: false, error: 'File template tidak ditemukan' });
    }
  } catch (error) {
    console.error('Error deleting template:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Gagal menghapus template'
    });
  }
}

module.exports = {
  getMasterPods,
  getPodExperiences,
  getTemplates,
  saveTemplate,
  deleteTemplate
};
