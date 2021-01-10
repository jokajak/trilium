"use strict";

const syncService = require('../../services/sync');
const syncUpdateService = require('../../services/sync_update');
const entityChangesService = require('../../services/entity_changes.js');
const sql = require('../../services/sql');
const sqlInit = require('../../services/sql_init');
const optionService = require('../../services/options');
const contentHashService = require('../../services/content_hash');
const log = require('../../services/log');
const syncOptions = require('../../services/sync_options');
const dateUtils = require('../../services/date_utils');
const entityConstructor = require('../../entities/entity_constructor');
const utils = require('../../services/utils');

async function testSync() {
    try {
        if (!syncOptions.isSyncSetup()) {
            return { success: false, message: "Sync server host is not configured. Please configure sync first." };
        }

        await syncService.login();

        // login was successful so we'll kick off sync now
        // this is important in case when sync server has been just initialized
        syncService.sync();

        return { success: true, message: "Sync server handshake has been successful, sync has been started." };
    }
    catch (e) {
        return {
            success: false,
            message: e.message
        };
    }
}

function getStats() {
    if (!sqlInit.schemaExists()) {
        // fail silently but prevent errors from not existing options table
        return {};
    }

    const stats = {
        initialized: optionService.getOption('initialized') === 'true',
        outstandingPullCount: syncService.getOutstandingPullCount()
    };

    log.info(`Returning sync stats: ${JSON.stringify(stats)}`);

    return stats;
}

function checkSync() {
    return {
        entityHashes: contentHashService.getEntityHashes(),
        maxEntityChangeId: sql.getValue('SELECT COALESCE(MAX(id), 0) FROM entity_changes WHERE isSynced = 1')
    };
}

function syncNow() {
    log.info("Received request to trigger sync now.");

    return syncService.sync();
}

function fillEntityChanges() {
    entityChangesService.fillAllEntityChanges();

    log.info("Sync rows have been filled.");
}

function forceFullSync() {
    optionService.setOption('lastSyncedPull', 0);
    optionService.setOption('lastSyncedPush', 0);

    log.info("Forcing full sync.");

    // not awaiting for the job to finish (will probably take a long time)
    syncService.sync();
}

function forceNoteSync(req) {
    const noteId = req.params.noteId;

    const now = dateUtils.utcNowDateTime();

    sql.execute(`UPDATE notes SET utcDateModified = ? WHERE noteId = ?`, [now, noteId]);
    entityChangesService.moveEntityChangeToTop('notes', noteId);

    sql.execute(`UPDATE note_contents SET utcDateModified = ? WHERE noteId = ?`, [now, noteId]);
    entityChangesService.moveEntityChangeToTop('note_contents', noteId);

    for (const branchId of sql.getColumn("SELECT branchId FROM branches WHERE noteId = ?", [noteId])) {
        sql.execute(`UPDATE branches SET utcDateModified = ? WHERE branchId = ?`, [now, branchId]);

        entityChangesService.moveEntityChangeToTop('branches', branchId);
    }

    for (const attributeId of sql.getColumn("SELECT attributeId FROM attributes WHERE noteId = ?", [noteId])) {
        sql.execute(`UPDATE attributes SET utcDateModified = ? WHERE attributeId = ?`, [now, attributeId]);

        entityChangesService.moveEntityChangeToTop('attributes', attributeId);
    }

    for (const noteRevisionId of sql.getColumn("SELECT noteRevisionId FROM note_revisions WHERE noteId = ?", [noteId])) {
        sql.execute(`UPDATE note_revisions SET utcDateModified = ? WHERE noteRevisionId = ?`, [now, noteRevisionId]);
        entityChangesService.moveEntityChangeToTop('note_revisions', noteRevisionId);

        sql.execute(`UPDATE note_revision_contents SET utcDateModified = ? WHERE noteRevisionId = ?`, [now, noteRevisionId]);
        entityChangesService.moveEntityChangeToTop('note_revision_contents', noteRevisionId);
    }

    entityChangesService.moveEntityChangeToTop('recent_changes', noteId);

    log.info("Forcing note sync for " + noteId);

    // not awaiting for the job to finish (will probably take a long time)
    syncService.sync();
}

function getChanged(req) {
    const startTime = Date.now();

    const lastEntityChangeId = parseInt(req.query.lastEntityChangeId);

    const entityChanges = sql.getRows("SELECT * FROM entity_changes WHERE isSynced = 1 AND id > ? LIMIT 1000", [lastEntityChangeId]);

    const ret = {
        entityChanges: syncService.getEntityChangesRecords(entityChanges),
        maxEntityChangeId: sql.getValue('SELECT COALESCE(MAX(id), 0) FROM entity_changes WHERE isSynced = 1')
    };

    if (ret.entityChanges.length > 0) {
        log.info(`Returning ${ret.entityChanges.length} entity changes in ${Date.now() - startTime}ms`);
    }

    return ret;
}

const partialRequests = {};

function update(req) {
    let {body} = req;

    const pageCount = parseInt(req.get('pageCount'));
    const pageIndex = parseInt(req.get('pageIndex'));

    if (pageCount !== 1) {
        const requestId = req.get('requestId');

        if (pageIndex === 0) {
            partialRequests[requestId] = {
                createdAt: Date.now(),
                payload: ''
            };
        }

        if (!partialRequests[requestId]) {
            throw new Error(`Partial request ${requestId}, index ${pageIndex} of ${pageCount} of pages does not have expected record.`);
        }

        partialRequests[requestId].payload += req.body;

        if (pageIndex !== pageCount - 1) {
            return;
        }
        else {
            body = JSON.parse(partialRequests[requestId].payload);
            delete partialRequests[requestId];
        }
    }

    const {sourceId, entities} = body;

    for (const {entityChange, entity} of entities) {
        syncUpdateService.updateEntity(entityChange, entity, sourceId);
    }
}

setInterval(() => {
    for (const key in partialRequests) {
        if (partialRequests[key].createdAt - Date.now() > 5 * 60 * 1000) {
            delete partialRequests[key];
        }
    }
}, 60 * 1000);

function syncFinished() {
    // after first sync finishes, the application is ready to be used
    // this is meaningless but at the same time harmless (idempotent) for further syncs
    sqlInit.setDbAsInitialized();
}

function queueSector(req) {
    const entityName = utils.sanitizeSqlIdentifier(req.params.entityName);
    const sector = utils.sanitizeSqlIdentifier(req.params.sector);

    const entityPrimaryKey = entityConstructor.getEntityFromEntityName(entityName).primaryKeyName;

    entityChangesService.addEntityChangesForSector(entityName, entityPrimaryKey, sector);
}

module.exports = {
    testSync,
    checkSync,
    syncNow,
    fillEntityChanges,
    forceFullSync,
    forceNoteSync,
    getChanged,
    update,
    getStats,
    syncFinished,
    queueSector
};
