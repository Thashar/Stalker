const { Client, GatewayIntentBits, Events } = require('discord.js');
const cron = require('node-cron');

const config = require('./config/config');
const { delay } = require('./utils/helpers');
const { handleInteraction, registerSlashCommands, sendGhostPing } = require('./handlers/interactionHandlers');

const DatabaseService = require('./services/databaseService');
const OCRService = require('./services/ocrService');
const PunishmentService = require('./services/punishmentService');
const ReminderService = require('./services/reminderService');
const SurvivorService = require('./services/survivorService');
const MessageCleanupService = require('./services/messageCleanupService');
const { createBotLogger } = require('../utils/consoleLogger');

const logger = createBotLogger('Stalker');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent
    ]
});

// Initialize services
const databaseService = new DatabaseService(config);
const ocrService = new OCRService(config);
const punishmentService = new PunishmentService(config, databaseService);
const reminderService = new ReminderService(config);
const survivorService = new SurvivorService(config, logger);
const messageCleanupService = new MessageCleanupService(config, logger);
const PhaseService = require('./services/phaseService');
const phaseService = new PhaseService(config, databaseService, ocrService, client);

// Object containing all shared states
// Set global client access for messageCleanupService
global.stalkerClient = client;

// Add services to client for easy access in handlers
client.messageCleanupService = messageCleanupService;
client.databaseService = databaseService;

const sharedState = {
    client,
    config,
    databaseService,
    ocrService,
    punishmentService,
    reminderService,
    survivorService,
    messageCleanupService,
    phaseService
};

client.once(Events.ClientReady, async () => {
    logger.success('✅ Stalker ready - Boss punishments (OCR), multi-server support');

    // Initialize services
    await databaseService.initializeDatabase();
    await ocrService.initializeOCR();
    await messageCleanupService.init();

    // Register slash commands
    await registerSlashCommands(client, config);

    // Validate server configurations
    logger.info('📋 Validating server configurations...');
    for (const guild of client.guilds.cache.values()) {
        const serverConfig = config.getServerConfig(guild.id);
        if (!serverConfig) {
            logger.warn(`⚠️ Server not configured: ${guild.name} (${guild.id})`);
            logger.warn(`   Add configuration for this server in Stalker/config/servers.json`);
        } else {
            logger.success(`✅ Loaded configuration for: ${serverConfig.serverName || guild.name}`);
        }
    }

    // Start cron job for weekly point cleanup (Monday at midnight)
    cron.schedule('0 0 * * 1', async () => {
        logger.info('Starting weekly punishment point cleanup...');
        
        for (const guild of client.guilds.cache.values()) {
            try {
                await punishmentService.cleanupAllUsers(guild);
                logger.info(`Cleaned points for server: ${guild.name}`);
            } catch (error) {
                logger.error(`Error cleaning points for server ${guild.name}: ${error.message}`);
            }
        }
    }, {
        timezone: config.timezone
    });
    
    // Run cron job for temp file cleanup (daily at 02:00)
    cron.schedule('0 2 * * *', async () => {
        logger.info('Starting temporary file cleanup...');
        await ocrService.cleanupTempFiles();
    }, {
        timezone: config.timezone
    });

    // Removed automatic member cache refresh - now happens before command use
    
});

// Handle interactions
client.on(Events.InteractionCreate, async (interaction) => {
    try {
        await handleInteraction(interaction, sharedState, config);
    } catch (error) {
        logger.error(`❌ Error handling interaction: ${error.message}`);

        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ An error occurred while processing the command.',
                    ephemeral: true
                });
            } else if (interaction.deferred) {
                await interaction.editReply({
                    content: '❌ An error occurred while processing the command.'
                });
            }
        } catch (replyError) {
            logger.error(`❌ Cannot reply to interaction (probably timeout): ${replyError.message}`);
        }
    }
});

// Handle messages (for Phase 1 images)
client.on(Events.MessageCreate, async (message) => {
    // Ignore messages from bots
    if (message.author.bot) return;

    // Handle messages with images for Phase 1
    try {
        const session = phaseService.getSessionByUserId(message.author.id);

        if (session && session.stage === 'awaiting_images' && session.channelId === message.channelId) {
            // Check if message has attachments (images)
            const imageAttachments = message.attachments.filter(att => att.contentType?.startsWith('image/'));

            if (imageAttachments.size > 0) {
                logger.info(`[PHASE1] 📸 Received ${imageAttachments.size} images from ${message.author.tag}`);

                const attachmentsArray = Array.from(imageAttachments.values());

                // STEP 1: Save all images to disk
                logger.info('[PHASE1] 💾 Saving images to disk...');
                const downloadedFiles = [];

                for (let i = 0; i < attachmentsArray.length; i++) {
                    try {
                        const filepath = await phaseService.downloadImage(
                            attachmentsArray[i].url,
                            session.sessionId,
                            session.downloadedFiles.length + i
                        );
                        downloadedFiles.push({
                            filepath,
                            originalAttachment: attachmentsArray[i]
                        });
                    } catch (error) {
                        logger.error(`[PHASE1] ❌ Error downloading image ${i + 1}:`, error);
                    }
                }

                session.downloadedFiles.push(...downloadedFiles.map(f => f.filepath));
                logger.info(`[PHASE1] ✅ Saved ${downloadedFiles.length} images to disk`);

                // STEP 2: Delete message with images from channel
                try {
                    await message.delete();
                    logger.info('[PHASE1] 🗑️ Deleted message with images from channel');
                } catch (deleteError) {
                    logger.error('[PHASE1] ❌ Error deleting message:', deleteError);
                }

                // STEP 3: Process images from disk
                const results = await phaseService.processImagesFromDisk(
                    session.sessionId,
                    downloadedFiles,
                    message.guild,
                    message.member,
                    session.publicInteraction
                );

                // Show processing confirmation in public message
                const processedCount = results.length;
                const totalImages = session.processedImages.length;

                const confirmation = phaseService.createProcessedImagesEmbed(processedCount, totalImages, session.phase);

                session.stage = 'confirming_complete';
                phaseService.refreshSessionTimeout(session.sessionId);

                if (session.publicInteraction) {
                    await session.publicInteraction.editReply({
                        embeds: [confirmation.embed],
                        components: [confirmation.row]
                    });

                    // Send ghost ping instead of regular ping in edited message
                    const channel = await client.channels.fetch(session.channelId);
                    await sendGhostPing(channel, message.author.id, session);
                }
            }
        }
    } catch (error) {
        logger.error(`[PHASE1] ❌ Error handling Phase 1 message: ${error.message}`);
    }

    // MessageCreate handling for /results moved to message collector in interactionHandlers.js
    // This code block is no longer used, but kept for reference in case of issues
});

// Error handling
client.on('error', error => {
    // Ignore WebSocket 520 errors - they are temporary
    if (error.message && error.message.includes('520')) {
        logger.warn('Temporary WebSocket 520 error - automatic reconnection');
        return;
    }

    logger.error(`Discord client error: ${error.message}`);
});

client.on('warn', warning => {
    logger.warn(`Discord warning: ${warning}`);
});

// Process error handling
process.on('unhandledRejection', error => {
    // Ignore WebSocket 520 errors - they are temporary
    if (error.message && error.message.includes('520')) {
        logger.warn('Temporary WebSocket 520 error - ignoring');
        return;
    }

    logger.error(`Unhandled Promise rejection: ${error.message}`);
    logger.error(error);
});

process.on('uncaughtException', error => {
    logger.error(`Uncaught exception: ${error.message}`);
    logger.error(error);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    logger.info('Received SIGINT signal, shutting down bot...');

    try {
        await client.destroy();
        logger.info('Bot successfully shut down');
        process.exit(0);
    } catch (error) {
        logger.error(`Error shutting down bot: ${error.message}`);
        process.exit(1);
    }
});

process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM signal, shutting down bot...');

    try {
        await client.destroy();
        logger.info('Bot successfully shut down');
        process.exit(0);
    } catch (error) {
        logger.error(`Error shutting down bot: ${error.message}`);
        process.exit(1);
    }
});

// Function to refresh member cache
async function refreshMemberCache() {
    try {
        logger.info('Refreshing member cache');

        let totalMembers = 0;
        let guildsProcessed = 0;

        for (const guild of client.guilds.cache.values()) {
            try {
                logger.info(`🏰 Processing server: ${guild.name} (${guild.id})`);

                // Refresh cache for all server members
                const members = await guild.members.fetch();

                logger.info(`👥 Loaded ${members.size} members for server ${guild.name}`);
                totalMembers += members.size;
                guildsProcessed++;

                // Check how many members have target roles
                let targetRoleMembers = 0;
                for (const roleId of Object.values(config.targetRoles)) {
                    const role = guild.roles.cache.get(roleId);
                    if (role) {
                        targetRoleMembers += role.members.size;
                        logger.info(`🎭 Role ${role.name}: ${role.members.size} members`);
                    }
                }

                logger.info(`✅ Server ${guild.name}: ${members.size} members, ${targetRoleMembers} with target roles`);

            } catch (error) {
                logger.error(`❌ Error refreshing cache for server ${guild.name}: ${error.message}`);
            }
        }

        logger.info('Member cache refresh summary:');
        logger.info(`🏰 Servers processed: ${guildsProcessed}`);
        logger.info(`👥 Total members: ${totalMembers}`);
        logger.info('✅ Member cache refresh completed successfully');

    } catch (error) {
        logger.error('Cache refresh error');
        logger.error('❌ Error refreshing member cache:', error);
    }
}

// Bot management functions
async function startBot() {
    try {
        if (!config.token) {
            throw new Error('STALKER_DISCORD_TOKEN is not set in environment variables');
        }

        await client.login(config.token);
        return client;
    } catch (error) {
        logger.error(`Bot startup error: ${error.message}`);
        throw error;
    }
}

async function stopBot() {
    try {
        logger.info('Stopping Stalker bot...');

        // Stop automatic message cleanup service
        messageCleanupService.stop();

        await client.destroy();
        logger.info('Bot stopped');
    } catch (error) {
        logger.error(`Bot shutdown error: ${error.message}`);
        throw error;
    }
}

// Export bot management functions
module.exports = {
    client,
    startBot,
    stopBot,
    sharedState,
    refreshMemberCache,

    // For compatibility with main launcher
    start: startBot,
    stop: stopBot
};