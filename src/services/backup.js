"use strict";

const dateUtils = require('./date_utils');
const optionService = require('./options');
const fs = require('fs-extra');
const dataDir = require('./data_dir');
const log = require('./log');
const sqlInit = require('./sql_init');
const syncMutexService = require('./sync_mutex');
const attributeService = require('./attributes');
const cls = require('./cls');
const utils = require('./utils');
const Database = require('better-sqlite3');

function regularBackup() {
    periodBackup('lastDailyBackupDate', 'daily', 24 * 3600);

    periodBackup('lastWeeklyBackupDate', 'weekly', 7 * 24 * 3600);

    periodBackup('lastMonthlyBackupDate', 'monthly', 30 * 24 * 3600);
}

function periodBackup(optionName, fileName, periodInSeconds) {
    const now = new Date();
    const lastDailyBackupDate = dateUtils.parseDateTime(optionService.getOption(optionName));

    if (now.getTime() - lastDailyBackupDate.getTime() > periodInSeconds * 1000) {
        backupNow(fileName);

        optionService.setOption(optionName, dateUtils.utcNowDateTime());
    }
}

const COPY_ATTEMPT_COUNT = 50;

async function copyFile(backupFile) {
    const sql = require('./sql');

    try {
        fs.unlinkSync(backupFile);
    } catch (e) {
    } // unlink throws exception if the file did not exist

    await sql.dbConnection.backup(backupFile);
}

async function backupNow(name) {
    // we don't want to backup DB in the middle of sync with potentially inconsistent DB state
    return await syncMutexService.doExclusively(async () => {
        const backupFile = `${dataDir.BACKUP_DIR}/backup-${name}.db`;

        await copyFile(backupFile);

        log.info("Created backup at " + backupFile);

        return backupFile;
    });
}

async function anonymize() {
    if (!fs.existsSync(dataDir.ANONYMIZED_DB_DIR)) {
        fs.mkdirSync(dataDir.ANONYMIZED_DB_DIR, 0o700);
    }

    const anonymizedFile = dataDir.ANONYMIZED_DB_DIR + "/" + "anonymized-" + dateUtils.getDateTimeForFile() + ".db";

    await copyFile(anonymizedFile);

    const db = new Database(anonymizedFile);

    db.prepare("UPDATE api_tokens SET token = 'API token value'").run();
    db.prepare("UPDATE notes SET title = 'title'").run();
    db.prepare("UPDATE note_contents SET content = 'text' WHERE content IS NOT NULL").run();
    db.prepare("UPDATE note_revisions SET title = 'title'").run();
    db.prepare("UPDATE note_revision_contents SET content = 'text' WHERE content IS NOT NULL").run();

    // we want to delete all non-builtin attributes because they can contain sensitive names and values
    // on the other hand builtin/system attrs should not contain any sensitive info
    const builtinAttrs = attributeService
        .getBuiltinAttributeNames()
        .map(name => "'" + utils.sanitizeSql(name) + "'").join(', ');

    db.prepare(`UPDATE attributes SET name = 'name', value = 'value' WHERE type = 'label' AND name NOT IN(${builtinAttrs})`).run();
    db.prepare(`UPDATE attributes SET name = 'name' WHERE type = 'relation' AND name NOT IN (${builtinAttrs})`).run();
    db.prepare("UPDATE branches SET prefix = 'prefix' WHERE prefix IS NOT NULL").run();
    db.prepare(`UPDATE options SET value = 'anonymized' WHERE name IN 
                    ('documentId', 'documentSecret', 'encryptedDataKey', 
                     'passwordVerificationHash', 'passwordVerificationSalt', 
                     'passwordDerivedKeySalt', 'username', 'syncServerHost', 'syncProxy') 
                      AND value != ''`).run();
    db.prepare("VACUUM").run();

    db.close();

    return {
        success: true,
        anonymizedFilePath: anonymizedFile
    };
}

if (!fs.existsSync(dataDir.BACKUP_DIR)) {
    fs.mkdirSync(dataDir.BACKUP_DIR, 0o700);
}

sqlInit.dbReady.then(() => {
    setInterval(cls.wrap(regularBackup), 4 * 60 * 60 * 1000);

    // kickoff first backup soon after start up
    setTimeout(cls.wrap(regularBackup), 5 * 60 * 1000);
});

module.exports = {
    backupNow,
    anonymize
};
