/**
 * Master-to-POD Synchronization Service (Facade / Aggregator)
 * 
 * Refactored into modular domain services located in ./masterToPodSync/:
 * - syncHelpers: Database clients, cache, batch upsert, TCP probing
 * - syncMetadataService: Master database & table catalogs, FK relation discovery
 * - syncComparisonService: Single & fleet-wide schema and data matrix comparison
 * - syncExecutionService: Master ➔ POD & POD ➔ Master sync logic
 * - syncMaintenanceService: Cascading delete & duplicate cleanup
 */

const {
  clearSchemaCache,
  getPodUuidMap,
  createMasterClient,
  getPodDbUrl,
  getTableConflictColumns
} = require('./masterToPodSync/syncHelpers');

const {
  getMasterDatabases,
  getMasterTables,
  getMasterTableFast,
  findChildRelations,
  getTableRelations
} = require('./masterToPodSync/syncMetadataService');

const {
  compareMasterTableWithSinglePod,
  compareMasterTableAcrossPods,
  fetchPodFleetTableCounts,
  auditFleetDiscrepancies
} = require('./masterToPodSync/syncComparisonService');

const {
  syncMasterTableToPods,
  syncSingleMasterRowToPods,
  syncPodTableToMaster,
  syncSinglePodRowToMaster,
  syncRelationalTablesToPods
} = require('./masterToPodSync/syncExecutionService');

const {
  deleteMasterTableRow,
  deletePodTableRow,
  cleanMasterDuplicates,
  checkMasterDuplicates
} = require('./masterToPodSync/syncMaintenanceService');

module.exports = {
  // Metadata & Catalogs
  getMasterDatabases,
  getMasterTables,
  getTableRelations,
  getMasterTableFast,
  findChildRelations,

  // Comparison & Audits
  compareMasterTableWithSinglePod,
  compareMasterTableAcrossPods,
  fetchPodFleetTableCounts,
  auditFleetDiscrepancies,

  // Sync Executions
  syncMasterTableToPods,
  syncSingleMasterRowToPods,
  syncPodTableToMaster,
  syncSinglePodRowToMaster,
  syncRelationalTablesToPods,

  // Deletion & Cleanups
  deleteMasterTableRow,
  deletePodTableRow,
  checkMasterDuplicates,
  cleanMasterDuplicates,

  // Cache & Helpers
  clearSchemaCache,
  getPodUuidMap,
  createMasterClient,
  getPodDbUrl,
  getTableConflictColumns
};
