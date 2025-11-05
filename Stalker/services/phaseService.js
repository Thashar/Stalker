const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { createBotLogger } = require('../../utils/consoleLogger');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');

const logger = createBotLogger('Stalker');

class PhaseService {
    constructor(config, databaseService, ocrService, client) {
        this.config = config;
        this.databaseService = databaseService;
        this.ocrService = ocrService;
        this.client = client;
        this.activeSessions = new Map(); // sessionId → session data
        this.tempDir = path.join(__dirname, '..', 'temp', 'phase1');
        this.activeProcessing = new Map(); // guildId → userId (who is currently processing)
        this.waitingQueue = new Map(); // guildId → [{userId, addedAt}] (ordered FIFO queue)
        this.queueReservation = new Map(); // guildId → {userId, expiresAt, timeout} (reservation for first person)
    }

    /**
     * Checks if someone is currently processing in a guild
     */
    isProcessingActive(guildId) {
        return this.activeProcessing.has(guildId);
    }

    /**
     * Gets the user ID who is currently processing
     */
    getActiveProcessor(guildId) {
        return this.activeProcessing.get(guildId);
    }

    /**
     * Sets active processing
     */
    setActiveProcessing(guildId, userId) {
        this.activeProcessing.set(guildId, userId);
        logger.info(`[PHASE1] 🔒 User ${userId} locked processing for guild ${guildId}`);
    }

    /**
     * Adds user to waiting queue
     */
    async addToWaitingQueue(guildId, userId) {
        if (!this.waitingQueue.has(guildId)) {
            this.waitingQueue.set(guildId, []);
        }

        const queue = this.waitingQueue.get(guildId);

        // Check if user is already in queue
        if (queue.find(item => item.userId === userId)) {
            logger.warn(`[QUEUE] ⚠️ User ${userId} is already in queue for guild ${guildId}`);
            return;
        }

        queue.push({ userId, addedAt: Date.now() });
        const position = queue.length;

        logger.info(`[QUEUE] ➕ User ${userId} added to queue (position: ${position}) for guild ${guildId}`);

        // Notify user about their queue position
        await this.notifyQueuePosition(guildId, userId, position);
    }

    /**
     * Clears active processing and notifies waiting users
     */
    async clearActiveProcessing(guildId) {
        this.activeProcessing.delete(guildId);
        logger.info(`[PHASE] 🔓 Unlocked processing for guild ${guildId}`);

        // Check if there are people in queue
        if (this.waitingQueue.has(guildId)) {
            const queue = this.waitingQueue.get(guildId);

            if (queue.length > 0) {
                // Get first person from queue
                const nextPerson = queue[0];
                logger.info(`[QUEUE] 📢 Next person in queue: ${nextPerson.userId}`);

                // Create 5-minute reservation
                await this.createQueueReservation(guildId, nextPerson.userId);

                // Notify remaining people in queue about position change
                for (let i = 1; i < queue.length; i++) {
                    await this.notifyQueuePosition(guildId, queue[i].userId, i);
                }
            } else {
                // No people in queue - clear
                this.waitingQueue.delete(guildId);
            }
        }
    }

    /**
     * Creates reservation for first person in queue (5 min)
     */
    async createQueueReservation(guildId, userId) {
        // Clear previous reservation if exists
        if (this.queueReservation.has(guildId)) {
            const oldReservation = this.queueReservation.get(guildId);
            if (oldReservation.timeout) {
                clearTimeout(oldReservation.timeout);
            }
        }

        const expiresAt = Date.now() + (5 * 60 * 1000); // 5 minutes

        // Timeout that removes reservation and notifies next person
        const timeout = setTimeout(async () => {
            logger.warn(`[QUEUE] ⏰ Reservation expired for user ${userId}`);
            await this.expireReservation(guildId, userId);
        }, 5 * 60 * 1000);

        this.queueReservation.set(guildId, { userId, expiresAt, timeout });

        // Notify user they can use the command
        try {
            const user = await this.client.users.fetch(userId);
            const expiryTimestamp = Math.floor(expiresAt / 1000);
            await user.send({
                embeds: [new EmbedBuilder()
                    .setTitle('✅ Your turn!')
                    .setDescription(`You can now use the \`/faza1\` or \`/faza2\` command.\n\n⏱️ You have time until: <t:${expiryTimestamp}:R>\n\n⚠️ **If you don't use the command within 5 minutes, your turn will be forfeited.**`)
                    .setColor('#00FF00')
                    .setTimestamp()
                ]
            });
            logger.info(`[QUEUE] ✅ Notified user ${userId} about their turn`);
        } catch (error) {
            logger.error(`[QUEUE] ❌ Failed to notify user ${userId}:`, error.message);
        }
    }

    /**
     * Expires reservation and moves to next person
     */
    async expireReservation(guildId, userId) {
        // Remove reservation
        this.queueReservation.delete(guildId);

        // Remove user from queue
        if (this.waitingQueue.has(guildId)) {
            const queue = this.waitingQueue.get(guildId);
            const index = queue.findIndex(item => item.userId === userId);

            if (index !== -1) {
                queue.splice(index, 1);
                logger.info(`[QUEUE] ➖ User ${userId} removed from queue (timeout)`);

                // Notify user they lost their turn
                try {
                    const user = await this.client.users.fetch(userId);
                    await user.send({
                        embeds: [new EmbedBuilder()
                            .setTitle('⏰ Time expired')
                            .setDescription('You didn\'t use the command within 5 minutes. Your turn was forfeited.\n\nYou can use the command again to join at the end of the queue.')
                            .setColor('#FF0000')
                            .setTimestamp()
                        ]
                    });
                } catch (error) {
                    logger.error(`[QUEUE] ❌ Failed to notify user ${userId} about expiration:`, error.message);
                }
            }

            // Notify next person if available
            if (queue.length > 0) {
                const nextPerson = queue[0];
                await this.createQueueReservation(guildId, nextPerson.userId);

                // Notify remaining people about position change
                for (let i = 1; i < queue.length; i++) {
                    await this.notifyQueuePosition(guildId, queue[i].userId, i);
                }
            } else {
                this.waitingQueue.delete(guildId);
            }
        }
    }

    /**
     * Notifies user about their queue position
     */
    async notifyQueuePosition(guildId, userId, position) {
        try {
            const user = await this.client.users.fetch(userId);
            const activeUserId = this.activeProcessing.get(guildId);

            let description = `Your position in queue: **${position}**\n\n`;

            if (activeUserId) {
                try {
                    const activeUser = await this.client.users.fetch(activeUserId);
                    description += `🔒 Currently using: **${activeUser.username}**\n`;
                } catch (err) {
                    description += `🔒 System is currently busy\n`;
                }
            }

            // Add info about people ahead of user
            if (this.waitingQueue.has(guildId)) {
                const queue = this.waitingQueue.get(guildId);
                const peopleAhead = queue.slice(0, position - 1);

                if (peopleAhead.length > 0) {
                    description += `\n👥 Ahead of you in queue:\n`;
                    for (let i = 0; i < Math.min(peopleAhead.length, 3); i++) {
                        try {
                            const person = await this.client.users.fetch(peopleAhead[i].userId);
                            description += `${i + 1}. **${person.username}**\n`;
                        } catch (err) {
                            description += `${i + 1}. *User*\n`;
                        }
                    }

                    if (peopleAhead.length > 3) {
                        description += `... and ${peopleAhead.length - 3} others\n`;
                    }
                }
            }

            description += `\n✅ You'll receive a notification when it's your turn.`;

            await user.send({
                embeds: [new EmbedBuilder()
                    .setTitle('📋 You are in queue')
                    .setDescription(description)
                    .setColor('#FFA500')
                    .setTimestamp()
                ]
            });

            logger.info(`[QUEUE] 📬 Notified user ${userId} about position ${position}`);
        } catch (error) {
            logger.error(`[QUEUE] ❌ Failed to notify user ${userId} about position:`, error.message);
        }
    }

    /**
     * Checks if user has reservation
     */
    hasReservation(guildId, userId) {
        if (!this.queueReservation.has(guildId)) {
            return false;
        }
        const reservation = this.queueReservation.get(guildId);
        return reservation.userId === userId && reservation.expiresAt > Date.now();
    }

    /**
     * Gets queue info for user (to display in channel)
     */
    async getQueueInfo(guildId, userId) {
        const activeUserId = this.activeProcessing.get(guildId);
        const queue = this.waitingQueue.get(guildId) || [];
        const userIndex = queue.findIndex(item => item.userId === userId);
        const position = userIndex + 1;

        let description = '';

        // Info about currently using person
        if (activeUserId) {
            try {
                const activeUser = await this.client.users.fetch(activeUserId);
                description += `🔒 **Currently using:** ${activeUser.username}\n\n`;
            } catch (err) {
                description += `🔒 **System is currently busy**\n\n`;
            }
        }

        // User position
        description += `📋 **Your position in queue:** ${position}\n`;
        description += `👥 **Total people in queue:** ${queue.length}\n\n`;

        // List of people ahead of user
        const peopleAhead = queue.slice(0, userIndex);
        if (peopleAhead.length > 0) {
            description += `**People ahead of you:**\n`;
            const displayLimit = Math.min(peopleAhead.length, 3);

            for (let i = 0; i < displayLimit; i++) {
                try {
                    const person = await this.client.users.fetch(peopleAhead[i].userId);
                    description += `${i + 1}. ${person.username}\n`;
                } catch (err) {
                    description += `${i + 1}. *User*\n`;
                }
            }

            if (peopleAhead.length > 3) {
                description += `... and ${peopleAhead.length - 3} others\n`;
            }
            description += `\n`;
        }

        description += `✅ **You'll receive a DM notification** when it's your turn.`;

        return { description, position, queueLength: queue.length };
    }

    /**
     * Removes user from queue after using command
     */
    removeFromQueue(guildId, userId) {
        // Clear reservation
        if (this.queueReservation.has(guildId)) {
            const reservation = this.queueReservation.get(guildId);
            if (reservation.userId === userId) {
                if (reservation.timeout) {
                    clearTimeout(reservation.timeout);
                }
                this.queueReservation.delete(guildId);
                logger.info(`[QUEUE] ✅ Removed reservation for user ${userId}`);
            }
        }

        // Remove from queue
        if (this.waitingQueue.has(guildId)) {
            const queue = this.waitingQueue.get(guildId);
            const index = queue.findIndex(item => item.userId === userId);

            if (index !== -1) {
                queue.splice(index, 1);
                logger.info(`[QUEUE] ➖ User ${userId} removed from queue (started using)`);
            }

            if (queue.length === 0) {
                this.waitingQueue.delete(guildId);
            }
        }
    }

    /**
     * Initializes temporary folder
     */
    async initTempDir() {
        try {
            await fs.mkdir(this.tempDir, { recursive: true });
        } catch (error) {
            logger.error('[PHASE1] ❌ Error creating temp folder:', error);
        }
    }

    /**
     * Downloads image from URL and saves locally
     */
    async downloadImage(url, sessionId, index) {
        await this.initTempDir();

        const filename = `${sessionId}_${index}_${Date.now()}.png`;
        const filepath = path.join(this.tempDir, filename);

        return new Promise((resolve, reject) => {
            https.get(url, (response) => {
                const fileStream = require('fs').createWriteStream(filepath);
                response.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close();
                    logger.info(`[PHASE1] 💾 Saved image: ${filename}`);
                    resolve(filepath);
                });

                fileStream.on('error', (err) => {
                    reject(err);
                });
            }).on('error', (err) => {
                reject(err);
            });
        });
    }

    /**
     * Removes session files from temp
     */
    async cleanupSessionFiles(sessionId) {
        try {
            const files = await fs.readdir(this.tempDir);
            const sessionFiles = files.filter(f => f.startsWith(sessionId));

            for (const file of sessionFiles) {
                const filepath = path.join(this.tempDir, file);
                await fs.unlink(filepath);
                logger.info(`[PHASE1] 🗑️ Deleted file: ${file}`);
            }
        } catch (error) {
            logger.error('[PHASE1] ❌ Error cleaning session files:', error);
        }
    }

    /**
     * Creates new Phase 1 session
     */
    createSession(userId, guildId, channelId, phase = 1) {
        const sessionId = `${userId}_${Date.now()}`;

        const session = {
            sessionId,
            userId,
            guildId,
            channelId,
            phase, // 1 or 2
            currentRound: 1, // for phase 2: 1, 2 or 3
            roundsData: [], // for phase 2: data from each round
            processedImages: [], // [{imageUrl, results: [{nick, score}]}]
            aggregatedResults: new Map(), // nick → [scores]
            conflicts: [], // [{nick, values: [{value, count}]}]
            resolvedConflicts: new Map(), // nick → finalScore
            stage: 'awaiting_images', // 'awaiting_images' | 'confirming_complete' | 'resolving_conflicts' | 'final_confirmation'
            createdAt: Date.now(),
            timeout: null,
            downloadedFiles: [], // paths to downloaded files
            messageToDelete: null, // message with images to delete
            publicInteraction: null, // interaction for progress updates (PUBLIC)
            roleNicksSnapshotPath: null // path to role nicks snapshot
        };

        this.activeSessions.set(sessionId, session);

        // Auto-cleanup after 15 minutes
        session.timeout = setTimeout(() => {
            this.cleanupSession(sessionId);
        }, 15 * 60 * 1000);

        logger.info(`[PHASE${phase}] 📝 Created session: ${sessionId}`);
        return sessionId;
    }

    /**
     * Gets user session
     */
    getSession(sessionId) {
        return this.activeSessions.get(sessionId);
    }

    /**
     * Gets user session by userId (last active)
     */
    getSessionByUserId(userId) {
        for (const [sessionId, session] of this.activeSessions.entries()) {
            if (session.userId === userId) {
                return session;
            }
        }
        return null;
    }

    /**
     * Refreshes session timeout
     */
    refreshSessionTimeout(sessionId) {
        const session = this.activeSessions.get(sessionId);
        if (!session) return;

        if (session.timeout) {
            clearTimeout(session.timeout);
        }

        session.timeout = setTimeout(() => {
            this.cleanupSession(sessionId);
        }, 15 * 60 * 1000);
    }

    /**
     * Removes session
     */
    async cleanupSession(sessionId) {
        const session = this.activeSessions.get(sessionId);
        if (!session) return;

        logger.info(`[PHASE${session.phase || 1}] 🧹 Starting session cleanup: ${sessionId}`);

        if (session.timeout) {
            clearTimeout(session.timeout);
            session.timeout = null;
        }

        // Stop ghost ping timer if exists
        if (session.pingTimer) {
            clearInterval(session.pingTimer);
            session.pingTimer = null;
            logger.info(`[PHASE${session.phase || 1}] ⏹️ Stopped ghost ping timer for session: ${sessionId}`);
        }

        // Remove files from temp
        await this.cleanupSessionFiles(sessionId);

        // Remove nicks snapshot if exists
        if (session.roleNicksSnapshotPath) {
            await this.ocrService.deleteRoleNicksSnapshot(session.roleNicksSnapshotPath);
            session.roleNicksSnapshotPath = null;
        }

        // Clear large data structures from memory
        if (session.processedImages) {
            session.processedImages.length = 0;
            session.processedImages = null;
        }
        if (session.aggregatedResults) {
            session.aggregatedResults.clear();
            session.aggregatedResults = null;
        }
        if (session.conflicts) {
            session.conflicts.length = 0;
            session.conflicts = null;
        }
        if (session.resolvedConflicts) {
            session.resolvedConflicts.clear();
            session.resolvedConflicts = null;
        }
        if (session.roundsData) {
            session.roundsData.length = 0;
            session.roundsData = null;
        }
        if (session.downloadedFiles) {
            session.downloadedFiles.length = 0;
            session.downloadedFiles = null;
        }

        // Unlock processing for this guild
        await this.clearActiveProcessing(session.guildId);

        // Remove session from map
        this.activeSessions.delete(sessionId);

        // Force garbage collection if available (only in --expose-gc mode)
        if (global.gc) {
            global.gc();
            logger.info(`[PHASE${session.phase || 1}] 🗑️ Session cleaned, GC called: ${sessionId}`);
        } else {
            logger.info(`[PHASE${session.phase || 1}] 🗑️ Session cleaned: ${sessionId}`);
        }
    }

    /**
     * Processes images from disk (already downloaded)
     */
    async processImagesFromDisk(sessionId, downloadedFiles, guild, member, publicInteraction) {
        const session = this.getSession(sessionId);
        if (!session) {
            throw new Error('Session does not exist or has expired');
        }

        session.publicInteraction = publicInteraction;

        logger.info(`[PHASE1] 🔄 Processing ${downloadedFiles.length} images from disk for session ${sessionId}`);

        // Create nicks snapshot from role at the beginning
        const snapshotPath = path.join(this.tempDir, `role_nicks_snapshot_${sessionId}.json`);
        const snapshotCreated = await this.ocrService.saveRoleNicksSnapshot(guild, member, snapshotPath);

        if (snapshotCreated) {
            session.roleNicksSnapshotPath = snapshotPath;
            logger.info(`[PHASE1] ✅ Nicks snapshot created: ${snapshotPath}`);
        } else {
            logger.warn(`[PHASE1] ⚠️ Failed to create snapshot - live fetching will be used`);
        }

        const results = [];
        const totalImages = downloadedFiles.length;

        for (let i = 0; i < downloadedFiles.length; i++) {
            const fileData = downloadedFiles[i];
            const attachment = fileData.originalAttachment;

            try {
                // Update progress - loading
                await this.updateProgress(session, {
                    currentImage: i + 1,
                    totalImages: totalImages,
                    stage: 'loading',
                    action: 'Loading image'
                });

                logger.info(`[PHASE1] 📷 Processing image ${i + 1}/${totalImages}: ${attachment.name}`);

                // Update progress - OCR
                await this.updateProgress(session, {
                    currentImage: i + 1,
                    totalImages: totalImages,
                    stage: 'ocr',
                    action: 'Text recognition (OCR)'
                });

                // Process OCR from local file
                const text = await this.ocrService.processImageFromFile(fileData.filepath);

                // Update progress - extraction
                await this.updateProgress(session, {
                    currentImage: i + 1,
                    totalImages: totalImages,
                    stage: 'extracting',
                    action: 'Extracting player scores'
                });

                // Extract all players with scores (not just zeros)
                // Use snapshot if exists
                const playersWithScores = await this.ocrService.extractAllPlayersWithScores(
                    text,
                    guild,
                    member,
                    session.roleNicksSnapshotPath
                );

                results.push({
                    imageUrl: attachment.url,
                    imageName: attachment.name,
                    results: playersWithScores
                });

                // Add to session
                session.processedImages.push({
                    imageUrl: attachment.url,
                    imageName: attachment.name,
                    results: playersWithScores
                });

                // Update progress - aggregation
                await this.updateProgress(session, {
                    currentImage: i + 1,
                    totalImages: totalImages,
                    stage: 'aggregating',
                    action: 'Aggregating results'
                });

                // Temporary aggregation for progress stats
                this.aggregateResults(session);

                logger.info(`[PHASE1] ✅ Found ${playersWithScores.length} players on image ${i + 1}`);
            } catch (error) {
                logger.error(`[PHASE1] ❌ Error processing image ${i + 1}:`, error);
                results.push({
                    imageUrl: attachment.url,
                    imageName: attachment.name,
                    error: error.message,
                    results: []
                });

                session.processedImages.push({
                    imageUrl: attachment.url,
                    imageName: attachment.name,
                    error: error.message,
                    results: []
                });
            }
        }

        // Final aggregation
        this.aggregateResults(session);

        return results;
    }

    /**
     * Updates progress in public message
     */
    async updateProgress(session, progress) {
        if (!session.publicInteraction) return;

        try {
            const { currentImage, totalImages, stage, action } = progress;
            const percent = Math.round((currentImage / totalImages) * 100);

            // Calculate statistics
            const uniqueNicks = session.aggregatedResults.size;
            const confirmedResults = Array.from(session.aggregatedResults.values())
                .filter(scores => scores.length >= 2 && new Set(scores).size === 1).length;
            const unconfirmedResults = uniqueNicks - confirmedResults;

            // Calculate conflicts - nicks with different values
            const conflictsCount = Array.from(session.aggregatedResults.values())
                .filter(scores => new Set(scores).size > 1).length;

            // Calculate players with zero - nicks that have at least one value of 0
            const playersWithZero = Array.from(session.aggregatedResults.entries())
                .filter(([nick, scores]) => scores.some(score => score === 0 || score === '0'))
                .length;

            const progressBar = this.createProgressBar(percent);

            // Icons for different stages
            const stageIcons = {
                'loading': '📥',
                'ocr': '🔍',
                'extracting': '📊',
                'aggregating': '🔄'
            };
            const icon = stageIcons[stage] || '⚙️';

            const phaseTitle = session.phase === 2 ? 'Phase 2' : 'Phase 1';
            const roundText = session.phase === 2 ? ` - Round ${session.currentRound}/3` : '';

            const embed = new EmbedBuilder()
                .setTitle(`🔄 Processing images - ${phaseTitle}${roundText}`)
                .setDescription(`**Image:** ${currentImage}/${totalImages}\n${icon} ${action}\n${progressBar} ${percent}%`)
                .setColor('#FFA500')
                .addFields(
                    { name: '👥 Unique nicks', value: uniqueNicks.toString(), inline: true },
                    { name: '✅ Confirmed', value: confirmedResults.toString(), inline: true },
                    { name: '❓ Unconfirmed', value: unconfirmedResults.toString(), inline: true },
                    { name: '⚠️ Conflicts', value: conflictsCount.toString(), inline: true },
                    { name: '🥚 Players with zero', value: playersWithZero.toString(), inline: true }
                )
                .setTimestamp()
                .setFooter({ text: 'Processing...' });

            // Try to update via editReply
            try {
                await session.publicInteraction.editReply({
                    embeds: [embed]
                });
            } catch (editError) {
                // Interaction expired - cancel session and unlock queue
                if (editError.code === 10015 || editError.message?.includes('Unknown Webhook') || editError.message?.includes('Invalid Webhook Token')) {
                    logger.warn('[PHASE] ⏰ Interaction expired, cancelling session and unlocking queue');

                    // Send info to channel
                    try {
                        const channel = await this.client.channels.fetch(session.channelId);
                        if (channel) {
                            await channel.send({
                                embeds: [new EmbedBuilder()
                                    .setTitle('⏰ Session expired')
                                    .setDescription('❌ Session expired due to inactivity. Try again.\n\nDiscord interaction expired (max 15 minutes). Data was not saved.')
                                    .setColor('#FF0000')
                                    .setTimestamp()
                                ]
                            });
                        }
                    } catch (channelError) {
                        logger.error('[PHASE] Failed to send session expiration info:', channelError.message);
                    }

                    // Clean session and unlock processing
                    await this.cleanupSession(session.sessionId);
                    this.clearActiveProcessing(session.guildId);

                    return; // Stop processing
                } else {
                    throw editError;
                }
            }
        } catch (error) {
            logger.error('[PHASE] ❌ Error updating progress:', error.message);
        }
    }

    /**
     * Creates progress bar
     */
    createProgressBar(percent) {
        const filled = Math.round(percent / 5);
        const empty = 20 - filled;
        return '█'.repeat(filled) + '░'.repeat(empty);
    }

    /**
     * Aggregates results from all images
     */
    aggregateResults(session) {
        session.aggregatedResults.clear();

        for (const imageData of session.processedImages) {
            if (imageData.error) continue;

            for (const player of imageData.results) {
                const nick = player.nick;
                const score = player.score;

                if (!session.aggregatedResults.has(nick)) {
                    session.aggregatedResults.set(nick, []);
                }

                session.aggregatedResults.get(nick).push(score);
            }
        }

        logger.info(`[PHASE1] 📊 Aggregated results for ${session.aggregatedResults.size} unique nicks`);
    }

    /**
     * Identifies conflicts (different values for the same nick)
     */
    identifyConflicts(session) {
        session.conflicts = [];

        for (const [nick, scores] of session.aggregatedResults.entries()) {
            // Check if there's a conflict (different values)
            const uniqueScores = [...new Set(scores)];

            if (uniqueScores.length > 1) {
                // Conflict - count occurrences of each value
                const valueCounts = new Map();
                for (const score of scores) {
                    valueCounts.set(score, (valueCounts.get(score) || 0) + 1);
                }

                const values = Array.from(valueCounts.entries())
                    .map(([value, count]) => ({ value, count }))
                    .sort((a, b) => b.count - a.count); // Sort by number of occurrences

                // Auto-accept: if most frequent value occurs 2+ times and there's only one such value
                const valuesWithTwoOrMore = values.filter(v => v.count >= 2);

                if (valuesWithTwoOrMore.length === 1) {
                    // Only one value occurs 2+ times - auto-accept it
                    logger.info(`[PHASE1] ✅ Auto-accept for "${nick}": ${valuesWithTwoOrMore[0].value} (${valuesWithTwoOrMore[0].count}x)`);
                    session.resolvedConflicts.set(nick, valuesWithTwoOrMore[0].value);
                } else {
                    // More than one value occurs 2+ times or none occur 2+ times - require choice
                    session.conflicts.push({ nick, values });
                }
            }
        }

        logger.info(`[PHASE1] ❓ Identified ${session.conflicts.length} conflicts requiring choice`);
        return session.conflicts;
    }

    /**
     * Resolves conflict for given nick
     */
    resolveConflict(session, nick, selectedValue) {
        session.resolvedConflicts.set(nick, selectedValue);
        logger.info(`[PHASE1] ✅ Resolved conflict for "${nick}": ${selectedValue}`);
    }

    /**
     * Gets next unresolved conflict
     */
    getNextUnresolvedConflict(session) {
        for (const conflict of session.conflicts) {
            if (!session.resolvedConflicts.has(conflict.nick)) {
                return conflict;
            }
        }
        return null;
    }

    /**
     * Generates final results (after resolving conflicts)
     */
    getFinalResults(session) {
        const finalResults = new Map();

        for (const [nick, scores] of session.aggregatedResults.entries()) {
            const uniqueScores = [...new Set(scores)];

            if (uniqueScores.length === 1) {
                // No conflict - use the only value
                finalResults.set(nick, uniqueScores[0]);
            } else {
                // Conflict - use resolved value
                const resolvedValue = session.resolvedConflicts.get(nick);
                if (resolvedValue !== undefined) {
                    finalResults.set(nick, resolvedValue);
                } else {
                    logger.warn(`[PHASE1] ⚠️ Unresolved conflict for "${nick}", skipping`);
                }
            }
        }

        return finalResults;
    }

    /**
     * Calculates final statistics
     */
    calculateStatistics(finalResults) {
        const uniqueNicks = finalResults.size;
        let aboveZero = 0;
        let zeroCount = 0;

        const sortedScores = Array.from(finalResults.values())
            .map(score => parseInt(score) || 0)
            .sort((a, b) => b - a);

        for (const score of sortedScores) {
            if (score > 0) {
                aboveZero++;
            } else if (score === 0) {
                zeroCount++;
            }
        }

        const top30Sum = sortedScores.slice(0, 30).reduce((sum, score) => sum + score, 0);

        return {
            uniqueNicks,
            aboveZero,
            zeroCount,
            top30Sum,
            sortedScores
        };
    }

    /**
     * Saves results to database
     */
    async saveFinalResults(session, finalResults, guild, createdBy) {
        const weekInfo = this.getCurrentWeekInfo();

        logger.info(`[PHASE1] 💾 Saving results for week ${weekInfo.weekNumber}/${weekInfo.year}, clan: ${session.clan}`);

        // Delete old data if exists
        await this.databaseService.deletePhase1DataForWeek(session.guildId, weekInfo.weekNumber, weekInfo.year, session.clan);

        // Save new data
        const members = await guild.members.fetch();
        const savedCount = [];
        let isFirstSave = true;

        for (const [nick, score] of finalResults.entries()) {
            // Find Discord member
            const member = members.find(m =>
                m.displayName.toLowerCase() === nick.toLowerCase() ||
                m.user.username.toLowerCase() === nick.toLowerCase()
            );

            if (member) {
                await this.databaseService.savePhase1Result(
                    session.guildId,
                    member.id,
                    member.displayName,
                    parseInt(score) || 0,
                    weekInfo.weekNumber,
                    weekInfo.year,
                    session.clan,
                    isFirstSave ? createdBy : null
                );
                savedCount.push(nick);
                isFirstSave = false;
            } else {
                logger.warn(`[PHASE1] ⚠️ Discord member not found for nick: ${nick}`);
            }
        }

        logger.info(`[PHASE1] ✅ Saved ${savedCount.length}/${finalResults.size} results`);
        return savedCount.length;
    }

    /**
     * Gets current week info (ISO week)
     * MODIFICATION: Week starts on Tuesday instead of Monday
     */
    getCurrentWeekInfo() {
        const now = new Date();

        // If it's Monday, use week number from previous Sunday
        const dayOfWeek = now.getDay();
        const dateForWeek = dayOfWeek === 1 ? new Date(now.getTime() - 24 * 60 * 60 * 1000) : now;

        const year = dateForWeek.getFullYear();
        const weekNumber = this.getISOWeek(dateForWeek);

        return { weekNumber, year };
    }

    /**
     * Calculates ISO week number
     */
    getISOWeek(date) {
        const target = new Date(date.valueOf());
        const dayNumber = (date.getDay() + 6) % 7;
        target.setDate(target.getDate() - dayNumber + 3);
        const firstThursday = target.valueOf();
        target.setMonth(0, 1);
        if (target.getDay() !== 4) {
            target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
        }
        return 1 + Math.ceil((firstThursday - target) / 604800000);
    }

    /**
     * Creates embed requesting images
     */
    createAwaitingImagesEmbed(phase = 1, round = null) {
        const expiryTime = Date.now() + (15 * 60 * 1000); // 15 minutes from now
        const expiryTimestamp = Math.floor(expiryTime / 1000);

        // Get current week info
        const { weekNumber, year } = this.getCurrentWeekInfo();

        let title = `📸 Phase ${phase} - Submit result screenshots`;
        if (phase === 2 && round) {
            title = `📸 Phase 2 - Round ${round}/3 - Submit result screenshots`;
        }

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(
                `📅 **Week:** ${weekNumber}/${year}\n\n` +
                '**⚠️ IMPORTANT - Screenshot guidelines:**\n' +
                '• Take screenshots **straight and carefully**\n' +
                '• More screenshots (up to 10) improve read quality\n' +
                '• If a nick appears **at least 2x**, it increases data confidence\n' +
                '• Avoid blurry or skewed images\n\n' +
                '**You can submit from 1 to 10 images in one message.**\n\n' +
                `⏱️ Expiration time: <t:${expiryTimestamp}:R>`
            )
            .setColor('#0099FF')
            .setTimestamp()
            .setFooter({ text: 'Submit images via a regular message in this channel' });

        const customIdPrefix = phase === 2 ? 'phase2' : 'phase1';
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`${customIdPrefix}_cancel_session`)
                    .setLabel('❌ Cancel')
                    .setStyle(ButtonStyle.Danger)
            );

        return { embed, row };
    }

    /**
     * Creates embed confirming processed images
     */
    createProcessedImagesEmbed(processedCount, totalImages, phase = 1) {
        const embed = new EmbedBuilder()
            .setTitle('✅ Images processed')
            .setDescription(`Processed **${processedCount}** images.\nTotal in session: **${totalImages}** images.`)
            .setColor('#00FF00')
            .setTimestamp();

        const phasePrefix = phase === 2 ? 'phase2' : 'phase1';

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`${phasePrefix}_complete_yes`)
                    .setLabel('✅ Yes, analyze')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`${phasePrefix}_complete_no`)
                    .setLabel('➕ Add more')
                    .setStyle(ButtonStyle.Primary)
            );

        return { embed, row };
    }

    /**
     * Creates conflict embed
     */
    createConflictEmbed(conflict, currentIndex, totalConflicts, phase = 1) {
        const valuesText = conflict.values
            .map(v => `• **${v.value}** (${v.count}x)`)
            .join('\n');

        const embed = new EmbedBuilder()
            .setTitle(`❓ Conflict ${currentIndex}/${totalConflicts}`)
            .setDescription(`**Nick:** ${conflict.nick}\n\n**Read values:**\n${valuesText}\n\nWhich value is correct?`)
            .setColor('#FFA500')
            .setTimestamp()
            .setFooter({ text: `Resolving conflicts • ${currentIndex} of ${totalConflicts}` });

        const row = new ActionRowBuilder();
        const phasePrefix = phase === 2 ? 'phase2' : 'phase1';

        // Dodaj przyciski dla każdej wartości (max 5)
        // CustomId format: phase1_resolve_{nick}_{value}
        for (let i = 0; i < Math.min(conflict.values.length, 5); i++) {
            const value = conflict.values[i];
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`${phasePrefix}_resolve_${conflict.nick}_${value.value}`)
                    .setLabel(`${value.value}`)
                    .setStyle(ButtonStyle.Secondary)
            );
        }

        return { embed, row };
    }

    /**
     * Creates final summary embed
     */
    createFinalSummaryEmbed(stats, weekInfo, clan, phase = 1) {
        const clanName = this.config.roleDisplayNames[clan] || clan;
        const phaseTitle = phase === 2 ? 'Phase 2' : 'Phase 1';
        const phasePrefix = phase === 2 ? 'phase2' : 'phase1';

        const fields = [];

        // For Phase 1 - show all statistics
        if (phase === 1) {
            fields.push(
                { name: '✅ Unique nicks', value: stats.uniqueNicks.toString(), inline: true },
                { name: '📈 Score above 0', value: `${stats.aboveZero} people`, inline: true },
                { name: '⭕ Score equal to 0', value: `${stats.zeroCount} people`, inline: true },
                { name: '🏆 TOP30 score sum', value: `${stats.top30Sum.toLocaleString('en-US')} points`, inline: false }
            );
        } else if (phase === 2) {
            // For Phase 2 - show sum of zeros from 3 rounds
            if (stats.totalZeroCount !== undefined) {
                fields.push(
                    { name: '⭕ Score = 0 (sum from 3 rounds)', value: `${stats.totalZeroCount} occurrences`, inline: false }
                );
            }
        }

        // For both phases add clan
        fields.push({ name: '🎯 Analyzed clan', value: clanName, inline: false });

        const embed = new EmbedBuilder()
            .setTitle(`📊 ${phaseTitle} Summary - Week ${weekInfo.weekNumber}/${weekInfo.year}`)
            .setDescription('Analyzed all images and resolved conflicts.')
            .setColor('#00FF00')
            .addFields(...fields)
            .setTimestamp()
            .setFooter({ text: 'Confirm and save data?' });

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`${phasePrefix}_confirm_save`)
                    .setLabel('🟢 Confirm')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`${phasePrefix}_cancel_save`)
                    .setLabel('🔴 Cancel')
                    .setStyle(ButtonStyle.Danger)
            );

        return { embed, row };
    }

    /**
     * Creates warning embed about existing data
     */
    async createOverwriteWarningEmbed(guildId, weekInfo, clan, phase = 1, guild = null) {
        let existingData;

        if (phase === 2) {
            existingData = await this.databaseService.getPhase2Summary(guildId, weekInfo.weekNumber, weekInfo.year, clan);
        } else {
            existingData = await this.databaseService.getPhase1Summary(guildId, weekInfo.weekNumber, weekInfo.year, clan);
        }

        if (!existingData) {
            return null;
        }

        const createdDate = new Date(existingData.createdAt);
        const dateStr = createdDate.toLocaleString('en-US');

        const clanName = this.config.roleDisplayNames[clan] || clan;

        const fields = [
            { name: '📅 Save date', value: dateStr, inline: true }
        ];

        // Add creator info if available
        logger.info(`[PHASE${phase}] createdBy: ${existingData.createdBy}, guild: ${guild ? 'exists' : 'null'}`);

        if (existingData.createdBy && guild) {
            try {
                const creator = await guild.members.fetch(existingData.createdBy);
                fields.push({ name: '👤 Added by', value: creator.displayName, inline: true });
                logger.info(`[PHASE${phase}] Added 'Added by' field: ${creator.displayName}`);
            } catch (error) {
                logger.warn(`[PHASE${phase}] User ${existingData.createdBy} not found:`, error.message);
            }
        } else {
            logger.warn(`[PHASE${phase}] No creator info - createdBy: ${existingData.createdBy}, guild: ${guild ? 'exists' : 'null'}`);
        }

        // Add player count only for Phase 1
        if (phase === 1) {
            fields.push({ name: '👥 Player count', value: existingData.playerCount.toString(), inline: true });
        }

        // Add TOP30 sum only for Phase 1
        if (phase === 1) {
            fields.push({ name: '🏆 TOP30 sum', value: `${existingData.top30Sum.toLocaleString('en-US')} pts`, inline: true });
        }

        const embed = new EmbedBuilder()
            .setTitle('⚠️ Data already exists')
            .setDescription(`Phase ${phase} data for week **${weekInfo.weekNumber}/${weekInfo.year}** (clan: **${clanName}**) already exists in the database.`)
            .setColor('#FF6600')
            .addFields(...fields)
            .setTimestamp()
            .setFooter({ text: 'Do you want to overwrite this data?' });

        const customIdPrefix = phase === 2 ? 'phase2' : 'phase1';
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`${customIdPrefix}_overwrite_yes`)
                    .setLabel('🔴 Overwrite old data')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`${customIdPrefix}_overwrite_no`)
                    .setLabel('⚪ Cancel')
                    .setStyle(ButtonStyle.Secondary)
            );

        return { embed, row };
    }

    /**
     * Proceeds to next round for Phase 2
     */
    startNextRound(session) {
        // Save data from current round
        const finalResults = this.getFinalResults(session);
        logger.info(`[PHASE2] 📊 Round ${session.currentRound} results: ${finalResults.size} players`);

        const roundData = {
            round: session.currentRound,
            results: finalResults
        };
        session.roundsData.push(roundData);

        logger.info(`[PHASE2] ✅ Finished round ${session.currentRound}/3`);

        // Clear data for next round
        session.processedImages = [];
        session.aggregatedResults = new Map();
        session.conflicts = [];
        session.resolvedConflicts = new Map();
        session.downloadedFiles = [];
        session.currentRound++;
        session.stage = 'awaiting_images';

        logger.info(`[PHASE2] 🔄 Starting round ${session.currentRound}/3`);
    }

    /**
     * Sums results from all rounds for Phase 2
     */
    sumPhase2Results(session) {
        const summedResults = new Map(); // nick → total score

        logger.info(`[PHASE2] 🔢 Summing results from ${session.roundsData.length} rounds`);

        // Sum results from all rounds
        for (const roundData of session.roundsData) {
            if (!roundData.results) {
                logger.error(`[PHASE2] ❌ Missing results for round ${roundData.round}`);
                continue;
            }

            if (!(roundData.results instanceof Map)) {
                logger.error(`[PHASE2] ❌ Round ${roundData.round} results are not a Map:`, typeof roundData.results);
                continue;
            }

            logger.info(`[PHASE2] Round ${roundData.round}: ${roundData.results.size} players`);

            for (const [nick, score] of roundData.results) {
                if (score === null || score === undefined || isNaN(score)) {
                    logger.warn(`[PHASE2] ⚠️ Invalid score for ${nick} in round ${roundData.round}: ${score}`);
                    continue;
                }
                const currentScore = summedResults.get(nick) || 0;
                summedResults.set(nick, currentScore + score);
            }
        }

        logger.info(`[PHASE2] ✅ Result sum: ${summedResults.size} players`);
        return summedResults;
    }
}

module.exports = PhaseService;
