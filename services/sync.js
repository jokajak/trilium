"use strict";

const log = require('./log');
const rp = require('request-promise');
const sql = require('./sql');
const migration = require('./migration');
const utils = require('./utils');
const config = require('./config');
const SOURCE_ID = require('./source_id');
const audit_category = require('./audit_category');

const SYNC_SERVER = config['Sync']['syncServerHost'];
const isSyncSetup = !!SYNC_SERVER;


let syncInProgress = false;

async function pullSync(cookieJar, syncLog) {
    const lastSyncedPull = parseInt(await sql.getOption('last_synced_pull'));

    let syncRows;

    try {
        logSync("Pulling changes: " + SYNC_SERVER + '/api/sync/changed?lastSyncId=' + lastSyncedPull + "&sourceId=" + SOURCE_ID);

        syncRows = await rp({
            uri: SYNC_SERVER + '/api/sync/changed?lastSyncId=' + lastSyncedPull + "&sourceId=" + SOURCE_ID,
            jar: cookieJar,
            json: true,
            timeout: 5 * 1000
        });

        logSync("Pulled " + syncRows.length + " changes");
    }
    catch (e) {
        logSyncError("Can't pull changes, inner exception: ", e, syncLog);
    }

    for (const sync of syncRows) {
        let resp;

        try {
            resp = await rp({
                uri: SYNC_SERVER + "/api/sync/" + sync.entity_name + "/" + sync.entity_id,
                json: true,
                jar: cookieJar
            });
        }
        catch (e) {
            logSyncError("Can't pull " + sync.entity_name + " " + sync.entity_id, e, syncLog);
        }

        if (sync.entity_name === 'notes') {
            await updateNote(resp.entity, resp.links, sync.source_id, syncLog);
        }
        else if (sync.entity_name === 'notes_tree') {
            await updateNoteTree(resp, sync.source_id, syncLog);
        }
        else if (sync.entity_name === 'notes_history') {
            await updateNoteHistory(resp, sync.source_id, syncLog);
        }
        else {
            logSyncError("Unrecognized entity type " + sync.entity_name, e, syncLog);
        }

        await sql.setOption('last_synced_pull', sync.id);
    }

    logSync("Finished pull");
}

async function pushEntity(entity, entityName, cookieJar, syncLog) {
    try {
        const payload = {
            sourceId: SOURCE_ID,
            entity: entity
        };

        if (entityName === 'notes') {
            payload.links = await sql.getResults('select * from links where note_id = ?', [entity.note_id]);
        }

        await rp({
            method: 'PUT',
            uri: SYNC_SERVER + '/api/sync/' + entityName,
            body: payload,
            json: true,
            timeout: 5 * 1000,
            jar: cookieJar
        });
    }
    catch (e) {
        logSyncError("Failed sending update for entity " + entityName, e, syncLog);
    }
}

async function pushSync(cookieJar, syncLog) {
    let lastSyncedPush = parseInt(await sql.getOption('last_synced_push'));

    while (true) {
        const sync = await sql.getSingleResultOrNull('SELECT * FROM sync WHERE id > ? LIMIT 1', [lastSyncedPush]);

        if (sync === null) {
            // nothing to sync

            logSync("Nothing to push", syncLog);

            break;
        }

        let entity;

        if (sync.entity_name === 'notes') {
            entity = await sql.getSingleResult('SELECT * FROM notes WHERE note_id = ?', [sync.entity_id]);
        }
        else if (sync.entity_name === 'notes_tree') {
            entity = await sql.getSingleResult('SELECT * FROM notes_tree WHERE note_id = ?', [sync.entity_id]);
        }
        else if (sync.entity_name === 'notes_history') {
            entity = await sql.getSingleResult('SELECT * FROM notes_history WHERE note_history_id = ?', [sync.entity_id]);
        }
        else {
            logSyncError("Unrecognized entity type " + sync.entity_name, null, syncLog);
        }

        logSync("Pushing changes in " + sync.entity_name + " " + sync.entity_id);

        await pushEntity(entity, sync.entity_name, cookieJar, syncLog);

        lastSyncedPush = sync.id;

        await sql.setOption('last_synced_push', lastSyncedPush);
    }
}

async function login(syncLog) {
    const timestamp = utils.nowTimestamp();

    const documentSecret = await sql.getOption('document_secret');
    const hash = utils.hmac(documentSecret, timestamp);

    const cookieJar = rp.jar();

    try {
        await rp({
            method: 'POST',
            uri: SYNC_SERVER + '/api/login',
            body: {
                timestamp: timestamp,
                dbVersion: migration.APP_DB_VERSION,
                hash: hash
            },
            json: true,
            timeout: 5 * 1000,
            jar: cookieJar
        });

        return cookieJar;
    }
    catch (e) {
        logSyncError("Can't login to API for sync, inner exception: ", e, syncLog);
    }
}

async function sync() {
    const syncLog = [];

    if (syncInProgress) {
        syncLog.push("Sync already in progress");

        return syncLog;
    }

    syncInProgress = true;

    try {
        if (!await migration.isDbUpToDate()) {
            syncLog.push("DB not up to date");

            return syncLog;
        }

        const cookieJar = await login(syncLog);

        await pullSync(cookieJar, syncLog);

        await pushSync(cookieJar, syncLog);
    }
    catch (e) {
        logSync("sync failed: " + e.stack, syncLog);
    }
    finally {
        syncInProgress = false;
    }

    return syncLog;
}

function logSync(message, syncLog) {
    log.info(message);

    if (syncLog) {
        syncLog.push(message);
    }
}

function logSyncError(message, e, syncLog) {
    let completeMessage = message;

    if (e) {
        completeMessage += ", inner exception: " + e.stack;
    }

    log.info(completeMessage);

    if (syncLog) {
        syncLog.push(completeMessage);
    }

    throw new Error(completeMessage);
}

async function updateNote(entity, links, sourceId, syncLog) {
    const origNote = await sql.getSingleResult("select * from notes where note_id = ?", [entity.note_id]);

    if (origNote === null || origNote.date_modified <= entity.date_modified) {
        await sql.doInTransaction(async () => {
            await sql.replace("notes", entity);

            await sql.remove("links", entity.note_id);

            for (const link of links) {
                delete link['lnk_id'];

                await sql.insert('link', link);
            }

            await sql.addNoteSync(entity.note_id, sourceId);

            // we don't distinguish between those for now
            await sql.addSyncAudit(audit_category.UPDATE_CONTENT, sourceId, entity.note_id);
            await sql.addSyncAudit(audit_category.UPDATE_TITLE, sourceId, entity.note_id);
        });

        logSync("Update/sync note " + entity.note_id, syncLog);
    }
    else {
        logSync("Sync conflict in note " + entity.note_id, syncLog);
    }
}

async function updateNoteTree(entity, sourceId, syncLog) {
    const orig = await sql.getSingleResultOrNull("select * from notes_tree where note_id = ?", [entity.note_id]);

    if (orig === null || orig.date_modified < entity.date_modified) {
        await sql.doInTransaction(async () => {
            await sql.replace('notes_tree', entity);

            await sql.addNoteTreeSync(entity.note_id, sourceId);

            await sql.addSyncAudit(audit_category.UPDATE_TITLE, sourceId, entity.note_id);
        });

        logSync("Update/sync note tree " + entity.note_id, syncLog);
    }
    else {
        logSync("Sync conflict in note tree " + entity.note_id, syncLog);
    }
}

async function updateNoteHistory(entity, sourceId, syncLog) {
    const orig = await sql.getSingleResultOrNull("select * from notes_history where note_history_id = ?", [entity.note_history_id]);

    if (orig === null || orig.date_modified_to < entity.date_modified_to) {
        await sql.doInTransaction(async () => {
            delete entity['id'];

            await sql.replace('notes_history', entity);

            await sql.addNoteHistorySync(entity.note_history_id, sourceId);
        });

        logSync("Update/sync note history " + entity.note_history_id, syncLog);
    }
    else {
        logSync("Sync conflict in note history for " + entity.note_id + ", from=" + entity.date_modified_from + ", to=" + entity.date_modified_to, syncLog);
    }
}

if (SYNC_SERVER) {
    log.info("Setting up sync");

    setInterval(sync, 60000);

    // kickoff initial sync immediately
    setTimeout(sync, 1000);
}
else {
    log.info("Sync server not configured, sync timer not running.")
}

module.exports = {
    sync,
    updateNote,
    updateNoteTree,
    updateNoteHistory,
    isSyncSetup
};