const masterCrudService = require('../services/masterCrudService');

const getMasterTableData = async (req, res) => {
  try {
    const { masterId, tableName } = req.params;
    if (!masterId || !tableName) {
      return res.status(400).json({ success: false, error: 'masterId dan tableName wajib diisi.' });
    }
    const result = await masterCrudService.getMasterTableData(Number(masterId), tableName);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

const createMasterRow = async (req, res) => {
  try {
    const { masterId, tableName } = req.params;
    const { data } = req.body;
    if (!masterId || !tableName || !data) {
      return res.status(400).json({ success: false, error: 'Parameter tidak lengkap.' });
    }
    const result = await masterCrudService.createMasterRow(Number(masterId), tableName, data);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

const updateMasterRow = async (req, res) => {
  try {
    const { masterId, tableName } = req.params;
    const { pkColumn, pkValue, data } = req.body;
    if (!masterId || !tableName || !pkColumn || pkValue === undefined || !data) {
      return res.status(400).json({ success: false, error: 'Parameter tidak lengkap.' });
    }
    const result = await masterCrudService.updateMasterRow(Number(masterId), tableName, pkColumn, pkValue, data);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

const deleteMasterRow = async (req, res) => {
  try {
    const { masterId, tableName } = req.params;
    const { pkColumn, pkValue } = req.body;
    if (!masterId || !tableName || !pkColumn || pkValue === undefined) {
      return res.status(400).json({ success: false, error: 'Parameter tidak lengkap.' });
    }
    const result = await masterCrudService.deleteMasterRow(Number(masterId), tableName, pkColumn, pkValue);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

const validateMatrixQuestions = async (req, res) => {
  try {
    const { masterId } = req.params;
    if (!masterId) {
      return res.status(400).json({ success: false, error: 'masterId wajib diisi.' });
    }
    const result = await masterCrudService.validateMatrixQuestions(Number(masterId));
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

const saveUnifiedQuestionMatrix = async (req, res) => {
  try {
    const { masterId } = req.params;
    const { questionData, matrixData, isEdit, questionId } = req.body;
    if (!masterId || !questionData || !matrixData) {
      return res.status(400).json({ success: false, error: 'Parameter tidak lengkap.' });
    }
    const result = await masterCrudService.saveUnifiedQuestionMatrix(
      Number(masterId), questionData, matrixData, isEdit, questionId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

const getMatrixByQuestionId = async (req, res) => {
  try {
    const { masterId, questionId } = req.params;
    if (!masterId || !questionId) {
      return res.status(400).json({ success: false, error: 'Parameter tidak lengkap.' });
    }
    const result = await masterCrudService.getMatrixByQuestionId(Number(masterId), questionId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getMasterTableData,
  createMasterRow,
  updateMasterRow,
  deleteMasterRow,
  validateMatrixQuestions,
  saveUnifiedQuestionMatrix,
  getMatrixByQuestionId
};
