const sqlite3 = require('sqlite3');
const sqlite = require('sqlite');
const { dbLogger: logger } = require('./log.js');

// Connect to the SQLite database
const dbPromise = sqlite.open({
    filename: './stmp.db',
    driver: sqlite3.Database
});

const schemaDictionary = {
    users: {
        user_id: "TEXT UNIQUE PRIMARY KEY",
        username: "TEXT",
        username_color: "TEXT",
        created_at: "DATETIME DEFAULT CURRENT_TIMESTAMP",
        last_seen_at: "DATETIME DEFAULT CURRENT_TIMESTAMP"
    },
    user_roles: {
        user_id: "TEXT UNIQUE PRIMARY KEY",
        role: "TEXT DEFAULT 'user'",
        foreignKeys: {
            user_id: "users(user_id)"
        }
    },
    characters: {
        char_id: "TEXT UNIQUE PRIMARY KEY",
        displayname: "TEXT",
        display_color: "TEXT",
        created_at: "DATETIME DEFAULT CURRENT_TIMESTAMP",
        last_seen_at: "DATETIME DEFAULT CURRENT_TIMESTAMP"
    },
    aichats: {
        message_id: "INTEGER PRIMARY KEY",
        session_id: "INTEGER",
        user_id: "TEXT",
        username: "TEXT",
        message: "TEXT",
        entity: "TEXT",
        timestamp: "DATETIME DEFAULT CURRENT_TIMESTAMP",
        foreignKeys: {
            session_id: "sessions(session_id)",
            user_id: "users(user_id)"
        }
    },
    userchats: {
        message_id: "INTEGER PRIMARY KEY",
        user_id: "TEXT",
        message: "TEXT",
        timestamp: "DATETIME DEFAULT CURRENT_TIMESTAMP",
        active: "BOOLEAN DEFAULT TRUE",
        session_id: "INTEGER",
        foreignKeys: {
            session_id: "sessions(session_id)",
            user_id: "users(user_id)"
        }
    },
    sessions: {
        session_id: "INTEGER PRIMARY KEY",
        started_at: "DATETIME DEFAULT CURRENT_TIMESTAMP",
        ended_at: "DATETIME",
        is_active: "BOOLEAN DEFAULT TRUE"
    },
    apis: {
        name: "TEXT UNIQUE PRIMARY KEY",
        endpoint: "TEXT",
        key: "TEXT",
        type: "TEXT",
        claude: "BOOLEAN DEFAULT FALSE",
        created_at: "DATETIME DEFAULT CURRENT_TIMESTAMP",
        last_used_at: "DATETIME DEFAULT CURRENT_TIMESTAMP",
    }
};

async function ensureDatabaseSchema(schemaDictionary) {
    const db = await dbPromise;
    for (const [tableName, tableSchema] of Object.entries(schemaDictionary)) {
        // Create the table if it doesn't exist
        let createTableQuery = `CREATE TABLE IF NOT EXISTS ${tableName} (`;
        const columnDefinitions = [];
        for (const [columnName, columnType] of Object.entries(tableSchema)) {
            if (columnName !== 'foreignKeys') {
                columnDefinitions.push(`${columnName} ${columnType}`);
            }
        }

        // Adding foreign keys if they exist
        if (tableSchema.foreignKeys) {
            for (const [fkColumn, fkReference] of Object.entries(tableSchema.foreignKeys)) {
                columnDefinitions.push(`FOREIGN KEY (${fkColumn}) REFERENCES ${fkReference}`);
            }
        }

        createTableQuery += columnDefinitions.join(', ') + ')';
        await db.run(createTableQuery);

        // Check and add columns if they don't exist
        const tableInfo = await db.all(`PRAGMA table_info(${tableName})`);
        const existingColumns = tableInfo.map(column => column.name);

        for (const [columnName, columnType] of Object.entries(tableSchema)) {
            if (columnName !== 'foreignKeys' && !existingColumns.includes(columnName)) {
                const addColumnQuery = `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`;
                await db.run(addColumnQuery);
            }
        }
    }
    await db.run(`INSERT OR IGNORE INTO apis (name, endpoint, key, type, claude) VALUES ('Default', 'localhost:5000', '', 'TC', FALSE)`);
}


// Write the session ID of whatever the active session in the sessions table is
async function writeUserChatMessage(userId, message) {
    logger.debug('Writing user chat message to database...');
    const db = await dbPromise;
    try {
        await db.run('INSERT INTO userchats (user_id, message, session_id) VALUES (?, ?, ?)', [userId, message, (await db.get('SELECT session_id FROM sessions WHERE is_active = TRUE')).session_id]);
        logger.debug('A side chat message was inserted');
    } catch (err) {
        logger.error('Error writing side chat message:', err);
    }
}

async function getPastChats(type) {
    logger.debug(`Getting data for all past ${type} chats...`);
    const db = await dbPromise;
    try {
        const rows = await db.all(`
            SELECT s.session_id, s.started_at, s.ended_at, s.is_active, a.user_id, a.timestamp,
            strftime('%Y-%m-%d %H:%M:%S', a.timestamp, 'localtime') AS local_timestamp
            FROM sessions s
            JOIN aichats a ON s.session_id = a.session_id
            JOIN sessions s2 ON s.session_id = s2.session_id
            ORDER BY s.started_at ASC
        `);

        const result = {};

        for (const row of rows) {
            const sessionID = row.session_id;

            // Create a 'messages' object for each unique session_id
            if (!result[sessionID]) {
                result[sessionID] = {
                    session_id: row.session_id,
                    started_at: row.started_at,
                    ended_at: row.ended_at,
                    is_active: row.is_active,
                    aiName: null,
                    messageCount: 0,
                    latestTimestamp: null
                };
            }

            // Check if the user_id does not contain a hyphen to determine if it's an AI user
            if (!row.user_id.includes('-')) {
                const aiName = row.user_id;
                if (!result[sessionID].aiName) {
                    result[sessionID].aiName = aiName;
                } else if (!result[sessionID].aiName.includes(aiName)) {
                    result[sessionID].aiName += `, ${aiName}`;
                }
            }

            // Use the local_timestamp directly from the row
            const localTimestamp = row.local_timestamp;

            // Update the message count and latest timestamp for the session
            result[sessionID].messageCount++;
            result[sessionID].latestTimestamp = localTimestamp;
        }

        return result;
    } catch (err) {
        logger.error('An error occurred while reading from the database:', err);
        throw err;
    }
}

async function deletePastChat(sessionID) {
    logger.debug('Deleting past chat... ' + sessionID);
    const db = await dbPromise;
    let wasActive = false;
    try {
        const row = await db.get('SELECT * FROM sessions WHERE session_id = ?', [sessionID]);
        if (row) {
            await db.run('DELETE FROM aichats WHERE session_id = ?', [sessionID]);
            if (row.is_active) {
                wasActive = true;
            }
            await db.run('DELETE FROM sessions WHERE session_id = ?', [row.session_id]);
            logger.debug(`Session ${sessionID} was deleted`);
        }
        return ['ok', wasActive];
    } catch (err) {
        logger.error('Error deleting session:', err);
    }
}

// Only read the user chat messages that are active
async function readUserChat() {
    logger.debug('Reading user chat...');
    const db = await dbPromise;
    try {
        const rows = await db.all(`
            SELECT u.username, u.username_color AS userColor, uc.message 
            FROM userchats uc 
            JOIN users u ON uc.user_id = u.user_id
            WHERE uc.active = TRUE
            ORDER BY uc.timestamp ASC 
        `);
        return JSON.stringify(rows.map(row => ({
            username: row.username,
            content: row.message,
            userColor: row.userColor
        })));
    } catch (err) {
        logger.error('An error occurred while reading from the database:', err);
        throw err;
    }
}

//Remove last AI chat in the current session from the database
async function removeLastAIChatMessage() {
    logger.debug('Removing last AI chat message from database...');
    const db = await dbPromise;
    //Get the last message_id from the current session
    try {
        const row = await db.get('SELECT message_id FROM aichats WHERE session_id = (SELECT session_id FROM sessions WHERE is_active = TRUE) ORDER BY message_id DESC LIMIT 1');
        if (row) {
            await db.run('DELETE FROM aichats WHERE message_id = ?', [row.message_id]);
            logger.debug('A message was deleted');
        }
    } catch (err) {
        logger.error('Error deleting message:', err);
    }
}

// Write an AI chat message to the database
async function writeAIChatMessage(username, userId, message, entity) {
    logger.debug('Writing AI chat message to database...' + username + ' ' + userId + ' ' + message + ' ' + entity);
    const db = await dbPromise;
    try {
        let sessionId;
        const row = await db.get('SELECT session_id FROM sessions WHERE is_active = TRUE');
        if (!row) {
            logger.debug('No active session found, creating a new session...');
            await db.run('INSERT INTO sessions DEFAULT VALUES');
            sessionId = (await db.get('SELECT session_id FROM sessions WHERE is_active = TRUE')).session_id;
            logger.debug(`A new session was created with session_id ${sessionId}`);
        } else {
            sessionId = row.session_id;
        }
        await db.run('INSERT INTO aichats (session_id, user_id, message, username, entity) VALUES (?, ?, ?, ?, ?)', [sessionId, userId, message, username, entity]);
        logger.debug('An AI chat message was inserted');
    } catch (err) {
        logger.error('Error writing AI chat message:', err);
    }
}

// Update all messages in the current session to a new session ID and clear the current session
async function newSession() {
    logger.debug('Creating a new session...');
    const db = await dbPromise;
    try {
        await db.run('UPDATE sessions SET is_active = FALSE, ended_at = CURRENT_TIMESTAMP WHERE is_active = TRUE');
        await db.run('INSERT INTO sessions DEFAULT VALUES');
    } catch (error) {
        logger.error('Error creating a new session:', error);
    }
}

// mark currently active user chat entries as inactive
async function newUserChatSession() {
    logger.debug('Creating a new user chat session...');
    const db = await dbPromise;
    try {
        await db.run('UPDATE userchats SET active = FALSE WHERE active = TRUE');
    } catch (error) {
        logger.error('Error creating a new user chat session:', error);
    }
}

// Create or update the user in the database
async function upsertUser(uuid, username, color) {
    logger.debug('Adding/updating user...' + uuid);
    const db = await dbPromise;
    try {
        await db.run('INSERT OR REPLACE INTO users (user_id, username, username_color, last_seen_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)', [uuid, username, color]);
        logger.debug('A user was upserted');
    } catch (err) {
        logger.error('Error writing user:', err);
    }
}

async function upsertUserRole(uuid, role) {
    logger.debug('Adding/updating user role...' + uuid + ' ' + role);
    const db = await dbPromise;
    try {
        await db.run('INSERT OR REPLACE INTO user_roles (user_id, role) VALUES (?, ?)', [uuid, role]);
        logger.debug('A user role was upserted');
    } catch (err) {
        logger.error('Error writing user role:', err);
    }
}

// Create or update the character in the database
async function upsertChar(uuid, displayname, color) {
    logger.debug('Adding/updating character...' + uuid);
    const db = await dbPromise;
    try {
        await db.run('INSERT OR REPLACE INTO characters (char_id, displayname, display_color, last_seen_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)', [uuid, displayname, color]);
        logger.debug('A character was upserted');
    } catch (err) {
        logger.error('Error writing character:', err);
    }
}

// Get user info from the database, including the role
async function getUser(uuid) {
    logger.debug('Getting user...' + uuid);
    const db = await dbPromise;
    try {
        return await db.get('SELECT u.user_id, u.username, u.username_color, u.created_at, u.last_seen_at, ur.role FROM users u LEFT JOIN user_roles ur ON u.user_id = ur.user_id WHERE u.user_id = ?', [uuid]);
    } catch (err) {
        logger.error('Error getting user:', err);
        throw err;
    }
}

// Read AI chat data from the SQLite database
async function readAIChat(sessionID = null) {
    logger.debug('Reading AI chat...');
    const db = await dbPromise;
    let sessionWhereClause = '';
    let params = [];

    if (sessionID) {
        sessionWhereClause = 'WHERE a.session_id = ?';
        params = [sessionID];
    } else {
        sessionWhereClause = 'WHERE a.session_id = (SELECT session_id FROM sessions WHERE is_active = TRUE)';
    }

    try {
        const rows = await db.all(`
            SELECT 
                a.username,
                a.message,
                CASE
                    WHEN u.user_id IS NULL THEN 
                        (SELECT c.display_color FROM characters c WHERE c.char_id = a.user_id)
                    ELSE 
                        u.username_color
                END AS userColor,
                a.message_id,
                a.entity
            FROM aichats a
            LEFT JOIN users u ON a.user_id = u.user_id
            ${sessionWhereClause}
            ORDER BY a.timestamp ASC
        `, params);

        const result = JSON.stringify(rows.map(row => ({
            username: row.username,
            content: row.message,
            userColor: row.userColor,
            messageID: row.message_id,
            entity: row.entity
        })));

        // Update the active session if sessionID is provided
        if (sessionID) {
            await db.run('UPDATE sessions SET is_active = FALSE');
            await db.run('UPDATE sessions SET is_active = TRUE WHERE session_id = ?', [sessionID]);
        }
        if (sessionID === null) { //happens when loading initial AIchat on page load
            return result;
        } else { //happens when user loads a past chat later.
            return [result, sessionID];
        }

    } catch (err) {
        logger.error('An error occurred while reading from the database:', err);
        throw err;
    }
}

async function deleteMessage(messageID) {
    logger.debug('Deleting message...');
    const db = await dbPromise;
    try {
        await db.run('DELETE FROM aichats WHERE message_id = ?', [messageID]);
        logger.debug('A message was deleted');
    } catch (err) {
        logger.error('Error deleting message:', err);
    }
}

async function getUserColor(UUID) {
    logger.debug('Getting user color...' + UUID);
    const db = await dbPromise;
    try {
        const row = await db.get('SELECT username_color FROM users WHERE user_id = ?', [UUID]);
        if (row) {
            const userColor = row.username_color;
            return userColor;
        } else {
            logger.warn(`User not found for UUID: ${UUID}`);
            return null;
        }
    } catch (err) {
        logger.error('Error getting user color:', err);
        throw err;
    }
}

async function getCharacterColor(charName) {
    logger.debug('Getting character color...' + charName);
    const db = await dbPromise;
    try {
        const row = await db.get('SELECT display_color FROM characters WHERE char_id = ?', [charName]);
        if (row) {
            const charColor = row.display_color;
            logger.debug(`User color: ${charColor}`);
            return charColor;
        } else {
            logger.warn(`Character not found for: ${charName}`);
            return null;
        }
    } catch (err) {
        logger.error('Error getting user color:', err);
        throw err;
    }
}

async function getMessage(messageID) {
    logger.debug('Getting message...' + messageID);
    const db = await dbPromise;
    try {
        return await db.get('SELECT * FROM aichats WHERE message_id = ?', [messageID]);
    } catch (err) {
        logger.error('Error getting message:', err);
        throw err;
    }
}

async function upsertAPI(name, endpoint, key, type, claude) {
    logger.debug('Adding/updating API...' + name);
    const db = await dbPromise;
    try {
        await db.run('INSERT OR REPLACE INTO apis (name, endpoint, key, type, claude) VALUES (?, ?, ?, ?, ?)', [name, endpoint, key, type, claude]);
        logger.debug('An API was upserted');
    } catch (err) {
        logger.error('Error writing API:', err);
    }
}

async function getAPIs() {
    logger.debug('Getting APIs...');
    const db = await dbPromise;
    try {
        return await db.all('SELECT * FROM apis');
    } catch (err) {
        logger.error('Error getting APIs:', err);
        throw err;
    }
}

async function getAPI(name) {
    logger.debug('Getting API...' + name);
    const db = await dbPromise;
    try {
        let gotAPI = await db.get('SELECT * FROM apis WHERE name = ?', [name]);
        logger.debug(gotAPI);
        if (gotAPI) {
            return gotAPI;
        } else {
            logger.error('API not found:', name);
            return null; // or handle the absence of the API in a different way
        }
    } catch (err) {
        logger.error('Error getting API:', err);
        throw err;
    }
}

async function exportSession(sessionID) {
    logger.debug('Exporting session...' + sessionID);
    const db = await dbPromise;
    try {
        const rows = await db.all(`
            SELECT 
                a.username,
                a.message,
                CASE
                    WHEN u.user_id IS NULL THEN 
                        (SELECT c.display_color FROM characters c WHERE c.char_id = a.user_id)
                    ELSE 
                        u.username_color
                END AS userColor,
                a.message_id,
                a.entity
            FROM aichats a
            LEFT JOIN users u ON a.user_id = u.user_id
            WHERE a.session_id = ?
            ORDER BY a.timestamp ASC
        `, [sessionID]);

        const result = JSON.stringify(rows.map(row => ({
            username: row.username,
            content: row.message,
            userColor: row.userColor,
            messageID: row.message_id,
            entity: row.entity
        })));

        return result;

    } catch (err) {
        logger.error('An error occurred while reading from the database:', err);
        throw err;
    }
}

ensureDatabaseSchema(schemaDictionary);


module.exports = {
    writeUserChatMessage: writeUserChatMessage,
    writeAIChatMessage: writeAIChatMessage,
    newSession: newSession,
    upsertUser: upsertUser,
    getUser: getUser,
    readAIChat: readAIChat,
    readUserChat: readUserChat,
    upsertChar: upsertChar,
    removeLastAIChatMessage: removeLastAIChatMessage,
    getPastChats: getPastChats,
    deleteMessage: deleteMessage,
    getMessage: getMessage,
    deletePastChat: deletePastChat,
    getUserColor: getUserColor,
    upsertUserRole: upsertUserRole,
    getCharacterColor: getCharacterColor,
    upsertAPI: upsertAPI,
    getAPIs: getAPIs,
    getAPI: getAPI,
    newUserChatSession: newUserChatSession
};