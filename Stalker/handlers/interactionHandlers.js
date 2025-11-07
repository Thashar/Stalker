const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const messages = require('../config/messages');
const { createBotLogger } = require('../../utils/consoleLogger');

const logger = createBotLogger('Stalker');

const confirmationData = new Map();

/**
 * Get server configuration or throw error if not configured
 */
function getServerConfigOrThrow(guildId, config) {
    const serverConfig = config.getServerConfig(guildId);
    if (!serverConfig) {
        throw new Error(`Bot is not configured for server ${guildId}. Check servers.json configuration.`);
    }
    return serverConfig;
}

async function handleInteraction(interaction, sharedState, config) {
    const { client, databaseService, ocrService, punishmentService, reminderService, survivorService, phaseService } = sharedState;

    logger.info(`[INTERACTION] 📨 Received: ${interaction.isCommand() ? 'command' : interaction.isButton() ? 'button' : interaction.isStringSelectMenu() ? 'menu' : 'other'} - ${interaction.commandName || interaction.customId || 'unknown'}`);

    try {
        if (interaction.isCommand()) {
            await handleSlashCommand(interaction, sharedState);
        } else if (interaction.isStringSelectMenu()) {
            await handleSelectMenu(interaction, config, reminderService, sharedState);
        } else if (interaction.isButton()) {
            await handleButton(interaction, sharedState);
        } else if (interaction.isModalSubmit()) {
            await handleModalSubmit(interaction, sharedState);
        }
    } catch (error) {
        logger.error('[INTERACTION] ❌ Interaction handling error:');
        logger.error('[INTERACTION] ❌ Command:', interaction.commandName || interaction.customId || 'unknown');
        logger.error('[INTERACTION] ❌ Guild:', interaction.guild?.name || 'unknown');
        logger.error('[INTERACTION] ❌ Error type:', typeof error);
        logger.error('[INTERACTION] ❌ Error message:', error?.message || 'no message');
        logger.error('[INTERACTION] ❌ Error name:', error?.name || 'no name');
        logger.error('[INTERACTION] ❌ Stack trace:', error?.stack || 'no stack');

        // Try to log error as string
        try {
            logger.error('[INTERACTION] ❌ Error toString:', String(error));
        } catch (e) {
            logger.error('[INTERACTION] ❌ Cannot convert error to string');
        }

        // Try to log error properties
        try {
            logger.error('[INTERACTION] ❌ Error keys:', Object.keys(error || {}));
        } catch (e) {
            logger.error('[INTERACTION] ❌ Cannot get error keys');
        }

        // Try to send error message to user
        try {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ An error occurred')
                .setDescription(messages.errors.unknownError)
                .setColor('#FF0000')
                .setTimestamp();

            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
            } else {
                await interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
            }
        } catch (replyError) {
            logger.error('[INTERACTION] ❌ Cannot send error message to user:', replyError?.message || 'unknown');
        }
    }
}

async function handleSlashCommand(interaction, sharedState) {
    const { config, databaseService, ocrService, punishmentService, reminderService, survivorService, phaseService } = sharedState;

    // Check permissions for all commands except /decode and /results
    const publicCommands = ['decode', 'results'];
    if (!publicCommands.includes(interaction.commandName)) {
        const serverConfig = getServerConfigOrThrow(interaction.guild.id, config);
        if (!hasPermission(interaction.member, serverConfig.allowedPunishRoles)) {
            await interaction.reply({ content: messages.errors.noPermission, flags: MessageFlags.Ephemeral });
            return;
        }
    }

    switch (interaction.commandName) {
        case 'punish':
            await handlePunishCommand(interaction, config, ocrService, punishmentService);
            break;
        case 'remind':
            await handleRemindCommand(interaction, config, ocrService, reminderService);
            break;
        case 'punishment':
            await handlePunishmentCommand(interaction, config, databaseService, punishmentService);
            break;
        case 'points':
            await handlePointsCommand(interaction, config, databaseService, punishmentService);
            break;
        case 'debug-roles':
            await handleDebugRolesCommand(interaction, config);
            break;
        case 'ocr-debug':
            await handleOcrDebugCommand(interaction, config);
            break;
        case 'decode':
            await handleDecodeCommand(interaction, sharedState);
            break;
        case 'phase1':
            await handlePhase1Command(interaction, sharedState);
            break;
        case 'results':
            await handleResultsCommand(interaction, sharedState);
            break;
        case 'modify':
            await handleModifyCommand(interaction, sharedState);
            break;
        case 'add':
            await handleAddCommand(interaction, sharedState);
            break;
        case 'phase2':
            await handlePhase2Command(interaction, sharedState);
            break;
        default:
            await interaction.reply({ content: 'Unknown command!', flags: MessageFlags.Ephemeral });
    }
}

async function handlePunishCommand(interaction, config, ocrService, punishmentService) {
    // Get server-specific configuration
    const serverConfig = getServerConfigOrThrow(interaction.guild.id, config);

    const attachment = interaction.options.getAttachment('image');

    if (!attachment) {
        await interaction.reply({ content: messages.errors.noImage, flags: MessageFlags.Ephemeral });
        return;
    }

    if (!attachment.contentType?.startsWith('image/')) {
        await interaction.reply({ content: messages.errors.invalidImage, flags: MessageFlags.Ephemeral });
        return;
    }

    try {
        // First respond with info about starting analysis
        await interaction.reply({ content: '🔍 Refreshing member cache and analyzing image...', flags: MessageFlags.Ephemeral });

        // Refresh member cache before analysis
        logger.info('🔄 Refreshing member cache for /punish command...');
        await interaction.guild.members.fetch();
        logger.info('✅ Member cache refreshed');

        const text = await ocrService.processImage(attachment);
        const zeroScorePlayers = await ocrService.extractPlayersFromText(text, interaction.guild, interaction.member);

        if (zeroScorePlayers.length === 0) {
            await interaction.editReply('No players with score 0 found in the image.');
            return;
        }

        // Check uncertain results before confirmation (pass serverConfig instead of config)
        await checkUncertainResults(interaction, zeroScorePlayers, attachment.url, serverConfig, punishmentService, text);

    } catch (error) {
        logger.error('[PUNISH] ❌ /punish command error:', error);
        await interaction.editReply({ content: messages.errors.ocrError });
    }
}

async function handleRemindCommand(interaction, config, ocrService, reminderService) {
    const attachment = interaction.options.getAttachment('image');
    
    if (!attachment) {
        await interaction.reply({ content: messages.errors.noImage, flags: MessageFlags.Ephemeral });
        return;
    }
    
    if (!attachment.contentType?.startsWith('image/')) {
        await interaction.reply({ content: messages.errors.invalidImage, flags: MessageFlags.Ephemeral });
        return;
    }
    
    try {
        // First respond with info about starting analysis
        await interaction.reply({ content: '🔍 Refreshing member cache and analyzing image...', flags: MessageFlags.Ephemeral });

        // Refresh member cache before analysis
        logger.info('🔄 Refreshing member cache for /remind command...');
        await interaction.guild.members.fetch();
        logger.info('✅ Member cache refreshed');

        const text = await ocrService.processImage(attachment);
        const zeroScorePlayers = await ocrService.extractPlayersFromText(text, interaction.guild, interaction.member);

        if (zeroScorePlayers.length === 0) {
            await interaction.editReply('No players with score 0 found in the image.');
            return;
        }

        // Convert nicks to objects with members for reminderService
        const foundUserObjects = [];
        for (const nick of zeroScorePlayers) {
            const member = interaction.guild.members.cache.find(m =>
                m.displayName.toLowerCase() === nick.toLowerCase() ||
                m.user.username.toLowerCase() === nick.toLowerCase()
            );
            if (member) {
                foundUserObjects.push({ member: member, matchedName: nick });
            }
        }

        // Generate unique ID for confirmation
        const confirmationId = Date.now().toString();

        // Save data to map
        confirmationData.set(confirmationId, {
            action: 'remind',
            foundUsers: foundUserObjects, // Objects with member property
            zeroScorePlayers: zeroScorePlayers, // Original nicks for display
            imageUrl: attachment.url,
            originalUserId: interaction.user.id,
            config: config,
            reminderService: reminderService
        });

        // Remove data after 5 minutes
        setTimeout(() => {
            confirmationData.delete(confirmationId);
        }, 5 * 60 * 1000);

        // Create buttons
        const confirmButton = new ButtonBuilder()
            .setCustomId(`confirm_remind_${confirmationId}`)
            .setLabel('✅ Yes')
            .setStyle(ButtonStyle.Success);

        const cancelButton = new ButtonBuilder()
            .setCustomId(`cancel_remind_${confirmationId}`)
            .setLabel('❌ No')
            .setStyle(ButtonStyle.Danger);

        const row = new ActionRowBuilder()
            .addComponents(confirmButton, cancelButton);

        const confirmationEmbed = new EmbedBuilder()
            .setTitle('🔍 Confirm Sending Reminder')
            .setDescription('Do you want to send a boss reminder to the found players?')
            .setColor('#ffa500')
            .addFields(
                { name: `✅ Found ${zeroScorePlayers.length} players with ZERO score`, value: `\`${zeroScorePlayers.join(', ')}\``, inline: false }
            )
            .setImage(attachment.url)
            .setTimestamp()
            .setFooter({ text: `Request from ${interaction.user.tag} | Confirm or cancel within 5 minutes` });

        await interaction.editReply({
            embeds: [confirmationEmbed],
            components: [row]
        });

    } catch (error) {
        logger.error('[REMIND] ❌ /remind command error:', error);
        await interaction.editReply({ content: messages.errors.ocrError });
    }
}

async function handlePunishmentCommand(interaction, config, databaseService, punishmentService) {
    const category = interaction.options.getString('category');
    const serverConfig = getServerConfigOrThrow(interaction.guild.id, config);
    const roleId = serverConfig.targetRoles[category];

    if (!roleId) {
        await interaction.reply({ content: 'Invalid category!', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply();

    // Refresh member cache before checking ranking
    try {
        logger.info('🔄 Refreshing member cache for punishment...');
        await interaction.guild.members.fetch();
        logger.info('✅ Member cache refreshed');
    } catch (error) {
        logger.error('❌ Cache refresh error:', error);
    }

    try {
        const ranking = await punishmentService.getRankingForRole(interaction.guild, roleId);
        const roleName = serverConfig.roleDisplayNames[category];
        
        let rankingText = '';
        if (ranking.length === 0) {
            rankingText = 'No users with punishment points in this category.';
        } else {
            for (let i = 0; i < ranking.length && i < 10; i++) {
                const user = ranking[i];
                const punishmentEmoji = user.points >= 2 ? '🎭' : '';
                rankingText += `${i + 1}. ${user.member.displayName} - ${user.points} points ${punishmentEmoji}\n`;
            }
        }


        // Next points removal
        const nextMonday = new Date();
        nextMonday.setDate(nextMonday.getDate() + (7 - nextMonday.getDay()) % 7);
        if (nextMonday.getDay() !== 1) {
            nextMonday.setDate(nextMonday.getDate() + 1);
        }
        nextMonday.setHours(0, 0, 0, 0);
        const nextRemovalText = `${nextMonday.toLocaleDateString('en-US')} at 00:00`;

        // Warning channel
        const warningChannelId = serverConfig.warningChannels[roleId];
        const warningChannel = interaction.guild.channels.cache.get(warningChannelId);
        const warningChannelText = warningChannel ? `<#${warningChannelId}>` : 'Channel not found';

        const embed = new EmbedBuilder()
            .setTitle(`📊 Punishment Points Ranking`)
            .setDescription(`**Category:** ${roleName}\n\n${rankingText}`)
            .setColor('#ff6b6b')
            .addFields(
                { name: '⏰ Next points removal', value: nextRemovalText, inline: false },
                { name: '🎭 Punishment role (2+ points)', value: `<@&${serverConfig.punishmentRoleId}>`, inline: false },
                { name: '🚨 Lottery ban role (3+ points)', value: `<@&${serverConfig.lotteryBanRoleId}>`, inline: false },
                { name: '📢 Warning channel', value: warningChannelText, inline: false },
                { name: '⚖️ Rules', value: '2+ points = punishment role\n3+ points = lottery ban\n< 2 points = no role\nWarnings: 2 and 3 points', inline: false }
            )
            .setTimestamp()
            .setFooter({ text: `Category: ${category} | Every Monday at midnight, 1 point is removed from everyone (${serverConfig.timezone})` });

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('[PUNISHMENT] ❌ /punishment command error:', error);
        await interaction.editReply({ content: messages.errors.databaseError });
    }
}

async function handlePointsCommand(interaction, config, databaseService, punishmentService) {
    const user = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    
    await interaction.deferReply();
    
    try {
        if (amount === null || amount === undefined) {
            // Remove user from system
            await databaseService.deleteUser(interaction.guild.id, user.id);
            await interaction.editReply({ content: `✅ Removed user ${user} from punishment points system.` });
        } else if (amount > 0) {
            // Add points
            await punishmentService.addPointsManually(interaction.guild, user.id, amount);
            await interaction.editReply({ content: `✅ Added ${amount} points for ${user}.` });
        } else if (amount < 0) {
            // Remove points
            await punishmentService.removePointsManually(interaction.guild, user.id, Math.abs(amount));
            await interaction.editReply({ content: `✅ Removed ${Math.abs(amount)} points for ${user}.` });
        } else {
            // amount === 0
            const userData = await databaseService.getUserPunishments(interaction.guild.id, user.id);
            await interaction.editReply({ content: `${user} currently has ${userData.points} punishment points.` });
        }
    } catch (error) {
        logger.error('[POINTS] ❌ /points command error:', error);
        await interaction.editReply({ content: messages.errors.databaseError });
    }
}

async function handleDebugRolesCommand(interaction, config) {
    // Get server-specific configuration
    const serverConfig = getServerConfigOrThrow(interaction.guild.id, config);

    const category = interaction.options.getString('category');
    const roleId = serverConfig.targetRoles[category];

    if (!roleId) {
        await interaction.reply({ content: 'Invalid category!', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply();

    // Refresh member cache before checking roles
    try {
        logger.info('🔄 Refreshing member cache for debug-roles...');
        await interaction.guild.members.fetch();
        logger.info('✅ Member cache refreshed');
    } catch (error) {
        logger.error('❌ Cache refresh error:', error);
    }

    try {
        const role = interaction.guild.roles.cache.get(roleId);
        const roleName = serverConfig.roleDisplayNames[category];
        
        if (!role) {
            await interaction.editReply({ content: 'Role not found!', flags: MessageFlags.Ephemeral });
            return;
        }
        
        // Get all members with this role
        const members = role.members;
        let membersList = '';
        
        if (members.size === 0) {
            membersList = 'No members with this role.';
        } else {
            const sortedMembers = members.sort((a, b) => a.displayName.localeCompare(b.displayName));
            let count = 0;
            for (const [userId, member] of sortedMembers) {
                if (count >= 50) { // Limit for embed
                    membersList += `\n... and ${members.size - count} more`;
                    break;
                }
                membersList += `${count + 1}. ${member.displayName}\n`;
                count++;
            }
        }
        
        // Punishment role info
        const punishmentRole = interaction.guild.roles.cache.get(serverConfig.punishmentRoleId);
        const punishmentRoleInfo = punishmentRole ? `<@&${serverConfig.punishmentRoleId}>` : 'Not found';

        // Warning channel
        const warningChannelId = serverConfig.warningChannels[roleId];
        const warningChannel = interaction.guild.channels.cache.get(warningChannelId);
        const warningChannelInfo = warningChannel ? `<#${warningChannelId}>` : 'Not found';

        const embed = new EmbedBuilder()
            .setTitle(`🔧 Debug - ${roleName}`)
            .setDescription(`**Role:** <@&${roleId}>\n**Role ID:** ${roleId}\n**Member count:** ${members.size}`)
            .addFields(
                { name: '👥 Members', value: membersList.length > 1024 ? membersList.substring(0, 1020) + '...' : membersList, inline: false },
                { name: '🎭 Punishment role (2+ pts)', value: punishmentRoleInfo, inline: true },
                { name: '🚨 Lottery ban role (3+ pts)', value: `<@&${serverConfig.lotteryBanRoleId}>`, inline: true },
                { name: '📢 Warning channel', value: warningChannelInfo, inline: true },
                { name: '⚙️ Configuration', value: `Category: ${category}\nTimezone: ${config.timezone}\nBoss deadline: ${config.bossDeadline.hour}:${config.bossDeadline.minute.toString().padStart(2, '0')}`, inline: false }
            )
            .setColor('#0099FF')
            .setTimestamp()
            .setFooter({ text: `Debug executed by ${interaction.user.tag}` });
        
        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('[DEBUG] ❌ /debug-roles command error:', error);
        await interaction.editReply({ content: 'An error occurred while debugging roles.' });
    }
}

async function handleSelectMenu(interaction, config, reminderService, sharedState) {
    if (interaction.customId === 'reminder_role_select') {
        // Get server-specific configuration
        const serverConfig = getServerConfigOrThrow(interaction.guild.id, config);

        const selectedRole = interaction.values[0];
        const roleId = serverConfig.targetRoles[selectedRole];

        if (!roleId) {
            await interaction.reply({ content: 'Invalid role!', flags: MessageFlags.Ephemeral });
            return;
        }

        await interaction.deferReply();

        try {
            await reminderService.sendBulkReminder(interaction.guild, roleId);
            await interaction.editReply({ content: `✅ Sent reminder to role ${serverConfig.roleDisplayNames[selectedRole]}` });
        } catch (error) {
            logger.error('[REMINDER] ❌ Reminder sending error:', error);
            await interaction.editReply({ content: messages.errors.unknownError });
        }
    } else if (interaction.customId === 'results_select_clan') {
        await handleResultsClanSelect(interaction, sharedState);
    } else if (interaction.customId === 'results_select_week') {
        await handleResultsWeekSelect(interaction, sharedState);
    } else if (interaction.customId.startsWith('modify_select_clan|')) {
        await handleModifyClanSelect(interaction, sharedState);
    } else if (interaction.customId.startsWith('modify_select_round|')) {
        await handleModifyRoundSelect(interaction, sharedState);
    } else if (interaction.customId.startsWith('modify_select_week_')) {
        await handleModifyWeekSelect(interaction, sharedState);
    } else if (interaction.customId.startsWith('modify_select_player_')) {
        await handleModifyPlayerSelect(interaction, sharedState);
    } else if (interaction.customId.startsWith('add_select_week|')) {
        await handleAddWeekSelect(interaction, sharedState);
    } else if (interaction.customId.startsWith('add_select_round|')) {
        await handleAddRoundSelect(interaction, sharedState);
    } else if (interaction.customId.startsWith('add_select_user|')) {
        await handleAddUserSelect(interaction, sharedState);
    }
}

async function handleButton(interaction, sharedState) {
    const { config, databaseService, punishmentService, survivorService, phaseService } = sharedState;

    // Handle build pagination buttons
    if (interaction.customId === 'statystyki_page' || interaction.customId === 'ekwipunek_page' || interaction.customId === 'tech_party_page' || interaction.customId === 'survivor_page' || interaction.customId === 'legend_colls_page' || interaction.customId === 'epic_colls_page' || interaction.customId === 'custom_sets_page' || interaction.customId === 'pets_page') {
        if (!sharedState.buildPagination) {
            await interaction.reply({ content: '❌ Pagination session expired.', flags: MessageFlags.Ephemeral });
            return;
        }

        const paginationData = sharedState.buildPagination.get(interaction.message.id);
        if (!paginationData) {
            await interaction.reply({ content: '❌ Pagination data not found.', flags: MessageFlags.Ephemeral });
            return;
        }

        // All users can change pages

        // Set new page based on button
        let newPage = paginationData.currentPage;
        if (interaction.customId === 'statystyki_page') {
            newPage = 0;
        } else if (interaction.customId === 'ekwipunek_page') {
            newPage = 1;
        } else if (interaction.customId === 'tech_party_page') {
            newPage = 2;
        } else if (interaction.customId === 'survivor_page') {
            newPage = 3;
        } else if (interaction.customId === 'legend_colls_page') {
            newPage = 4;
        } else if (interaction.customId === 'epic_colls_page') {
            newPage = 5;
        } else if (interaction.customId === 'custom_sets_page') {
            newPage = 6;
        } else if (interaction.customId === 'pets_page') {
            newPage = 7;
        }

        // Update pagination data
        paginationData.currentPage = newPage;

        // Refresh timestamp - reset timer to 15 minutes from now
        const newTimestamp = Date.now();
        paginationData.timestamp = newTimestamp;
        const deleteAt = newTimestamp + (15 * 60 * 1000);

        const navigationButtons = survivorService.createNavigationButtons(newPage);

        // Update footer of ALL embeds with new timestamp and viewer
        const viewerDisplayName = interaction.member?.displayName || interaction.user.username;

        // Calculate exact deletion time
        const deleteTime = new Date(deleteAt);
        const hours = deleteTime.getHours().toString().padStart(2, '0');
        const minutes = deleteTime.getMinutes().toString().padStart(2, '0');
        const timeString = `${hours}:${minutes}`;

        // Update all embeds in pagination
        paginationData.embeds.forEach((embed, index) => {
            const currentFooter = embed.data.footer?.text || '';
            const pageName = currentFooter.split(' • ')[0];
            const newFooterText = `${pageName} • Analysis will be deleted at ${timeString} • Viewing ${viewerDisplayName}`;
            embed.setFooter({ text: newFooterText });
        });

        const currentEmbed = paginationData.embeds[newPage];

        // Update scheduled message deletion
        if (sharedState.messageCleanupService) {
            await sharedState.messageCleanupService.removeScheduledMessage(interaction.message.id);
            await sharedState.messageCleanupService.scheduleMessageDeletion(
                interaction.message.id,
                interaction.message.channelId,
                deleteAt,
                paginationData.userId
            );
        }

        await interaction.update({
            embeds: [currentEmbed],
            components: navigationButtons
        });
        return;
    }

    // Handle "Delete" button for build embeds
    if (interaction.customId === 'delete_embed') {
        // After bot restart, there's no pagination data in RAM, but message still exists
        // Allow message deletion if user is its owner (check by embed footer or other methods)

        let canDelete = false;
        let userId = null;

        // Check if we have pagination data in memory
        if (sharedState.buildPagination && sharedState.buildPagination.has(interaction.message.id)) {
            const paginationData = sharedState.buildPagination.get(interaction.message.id);
            userId = paginationData.userId;
            canDelete = interaction.user.id === userId;
        } else {
            // After restart there's no data in RAM, but check if message is in scheduled deletions file
            const scheduledMessages = sharedState.messageCleanupService.scheduledMessages || [];
            const scheduledMessage = scheduledMessages.find(msg => msg.messageId === interaction.message.id);

            if (scheduledMessage) {
                // Check if user is owner (if we have saved userId)
                if (scheduledMessage.userId && scheduledMessage.userId === interaction.user.id) {
                    canDelete = true;
                } else if (!scheduledMessage.userId) {
                    // For older messages without userId, allow anyone to delete
                    canDelete = true;
                }
            }
        }

        if (!canDelete) {
            await interaction.reply({
                content: '❌ Only the embed owner can delete it or the pagination session has expired.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // Delete embed and pagination data
        try {
            // Remove scheduled automatic deletion from file
            await sharedState.messageCleanupService.removeScheduledMessage(interaction.message.id);

            // Delete message
            await interaction.message.delete();

            // Remove pagination data from memory
            sharedState.buildPagination.delete(interaction.message.id);

            logger.info(`🗑️ Build embed was deleted by ${interaction.user.tag}`);
        } catch (error) {
            logger.error(`❌ Embed deletion error: ${error.message}`);
            await interaction.reply({
                content: '❌ An error occurred while deleting embed.',
                flags: MessageFlags.Ephemeral
            });
        }
        return;
    }

    if (interaction.customId.startsWith('confirm_')) {
        const parts = interaction.customId.split('_');
        const action = parts[1];
        const confirmationId = parts[2];
        
        const data = confirmationData.get(confirmationId);
        
        if (!data) {
            await interaction.reply({ content: 'Confirmation data expired. Please try again.', flags: MessageFlags.Ephemeral });
            return;
        }
        
        // Check if user has right to confirm
        if (data.originalUserId !== interaction.user.id) {
            await interaction.reply({ content: 'Only the person who initiated the command can confirm it.', flags: MessageFlags.Ephemeral });
            return;
        }
        
        confirmationData.delete(confirmationId);
        
        try {
            switch (action) {
                case 'punish':
                    const results = await data.punishmentService.processPunishments(interaction.guild, data.foundUsers);
                    
                    // Update ephemeral message with confirmation
                    const punishConfirmation = new EmbedBuilder()
                        .setTitle('✅ Punishment points added')
                        .setDescription('Successfully added punishment points for the found players.')
                        .setColor('#00ff00')
                        .setTimestamp()
                        .setFooter({ text: `Executed by ${interaction.user.tag}` });
                    
                    await interaction.update({ 
                        embeds: [punishConfirmation],
                        components: []
                    });

                    // Original embed format for public message
                    const processedUsers = [];
                    let addedPoints = 0;
                    
                    for (const result of results) {
                        const warningEmoji = result.points === 2 || result.points === 3 ? '📢' : '';
                        const punishmentEmoji = result.points >= 2 ? '🎭' : '';
                        processedUsers.push(`${result.user} - ${result.points} points ${punishmentEmoji}${warningEmoji}`);
                        addedPoints += 1;
                    }
                    
                    const targetMembers = interaction.guild.members.cache.filter(member => 
                        Object.values(data.config.targetRoles).some(roleId => member.roles.cache.has(roleId))
                    );
                    
                    // Send public embed with full summary
                    const punishEmbed = new EmbedBuilder()
                        .setTitle('📊 Analysis Complete')
                        .setColor('#ff6b6b')
                        .addFields(
                            { name: '📷 Found players with score 0', value: `\`${data.zeroScorePlayers.join(', ')}\``, inline: false },
                            { name: '✅ Matched and added points', value: processedUsers.length > 0 ? processedUsers.join('\n') : 'Brak', inline: false },
                            { name: '📈 Added points', value: addedPoints.toString(), inline: true },
                            { name: '🎭 Punishment role (2+ pts)', value: `<@&${data.config.punishmentRoleId}>`, inline: true },
                            { name: '🚨 Lottery ban role (3+ pts)', value: `<@&${data.config.lotteryBanRoleId}>`, inline: true }
                        )
                        .setImage(data.imageUrl)
                        .setTimestamp()
                        .setFooter({ text: `Analyzed by ${interaction.user.tag} | 🎭 = punishment role (2+ pts) | 🚨 = lottery ban role (3+ pts) | 📢 = warning sent` });
                    
                    await interaction.followUp({ 
                        embeds: [punishEmbed],
                        ephemeral: false
                    });
                    break;
                case 'remind':
                    const reminderResult = await data.reminderService.sendReminders(interaction.guild, data.foundUsers);
                    
                    // Update ephemeral message with confirmation
                    const confirmationSuccess = new EmbedBuilder()
                        .setTitle('✅ Reminder sent')
                        .setDescription('Successfully sent reminders for the found players.')
                        .setColor('#00ff00')
                        .setTimestamp()
                        .setFooter({ text: `Executed by ${interaction.user.tag}` });
                    
                    await interaction.update({ 
                        embeds: [confirmationSuccess],
                        components: []
                    });
                    
                    // Calculate time until deadline
                    const now = new Date();
                    const polandTime = new Date(now.toLocaleString('en-US', { timeZone: data.config.timezone }));
                    const deadline = new Date(polandTime);
                    deadline.setHours(data.config.bossDeadline.hour, data.config.bossDeadline.minute, 0, 0);
                    
                    if (polandTime >= deadline) {
                        deadline.setDate(deadline.getDate() + 1);
                    }
                    
                    const timeDiff = deadline - polandTime;
                    const hours = Math.floor(timeDiff / (1000 * 60 * 60));
                    const minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));
                    
                    let timeDisplay = '';
                    if (timeDiff > 0) {
                        if (hours > 0) {
                            timeDisplay = `${hours}h ${minutes}m`;
                        } else {
                            timeDisplay = `${minutes}m`;
                        }
                    } else {
                        timeDisplay = 'Deadline passed!';
                    }
                    
                    const matchedUsers = data.foundUsers.map(user => `${user.member} (${user.matchedName})`);
                    
                    // Send public embed with full summary
                    const reminderEmbed = new EmbedBuilder()
                        .setTitle('📢 Reminder Sent')
                        .setColor('#ffa500')
                        .addFields(
                            { name: '📷 Found players with score 0', value: `\`${data.zeroScorePlayers.join(', ')}\``, inline: false },
                            { name: '📢 Sent reminders to', value: matchedUsers.length > 0 ? matchedUsers.join('\n') : 'None', inline: false },
                            { name: '⏰ Time remaining until 17:50', value: timeDisplay, inline: true },
                            { name: '📤 Sent messages', value: reminderResult.sentMessages.toString(), inline: true },
                            { name: '📢 To channels', value: reminderResult.roleGroups.toString(), inline: true }
                        )
                        .setImage(data.imageUrl)
                        .setTimestamp()
                        .setFooter({ text: `Reminder sent by ${interaction.user.tag} | Boss deadline: 17:50` });
                    
                    await interaction.followUp({ 
                        embeds: [reminderEmbed],
                        ephemeral: false
                    });
                    break;
            }
        } catch (error) {
            logger.error('[CONFIRM] ❌ Confirmation error:', error.message);
            logger.error('[CONFIRM] ❌ Stack trace:', error.stack);
            await interaction.followUp({ content: messages.errors.unknownError, flags: MessageFlags.Ephemeral });
        }
    } else if (interaction.customId.startsWith('uncertainty_')) {
        const parts = interaction.customId.split('_');
        const choice = parts[1]; // 'yes' or 'no'
        const uncertaintyId = parts[2];
        
        const data = confirmationData.get(uncertaintyId);
        
        if (!data) {
            await interaction.reply({ content: 'Data expired. Please try again.', flags: MessageFlags.Ephemeral });
            return;
        }
        
        if (data.originalUserId !== interaction.user.id) {
            await interaction.reply({ content: 'Only the person who initiated the command can confirm it.', flags: MessageFlags.Ephemeral });
            return;
        }
        
        confirmationData.delete(uncertaintyId);
        
        let finalPlayers = data.allPlayers;
        
        if (choice === 'no') {
            // Remove uncertain results from list
            finalPlayers = data.allPlayers.filter(player => !data.uncertainPlayers.includes(player));
            logger.info(`❓ Removed uncertain results from list: ${data.uncertainPlayers.join(', ')}`);
        } else {
            logger.info(`❓ Uncertain results remain in list: ${data.uncertainPlayers.join(', ')}`);
        }
        
        if (finalPlayers.length === 0) {
            await interaction.update({
                content: 'No players to punish after excluding uncertain results.',
                components: []
            });
            return;
        }
        
        // Proceed to final confirmation
        await showFinalConfirmationWithUpdate(interaction, finalPlayers, data.imageUrl, data.config, data.punishmentService);
        
    } else if (interaction.customId.startsWith('cancel_')) {
        const parts = interaction.customId.split('_');
        const confirmationId = parts[2];
        
        const data = confirmationData.get(confirmationId);
        
        if (data && data.originalUserId !== interaction.user.id) {
            await interaction.reply({ content: 'Only the person who initiated the command can cancel it.', flags: MessageFlags.Ephemeral });
            return;
        }
        
        confirmationData.delete(confirmationId);
        
        await interaction.update({
            content: '❌ Action was cancelled.',
            components: [],
            embeds: []
        });
    } else if (interaction.customId === 'phase1_overwrite_yes' || interaction.customId === 'phase1_overwrite_no') {
        // Handle Phase 1 data overwrite buttons
        await handlePhase1OverwriteButton(interaction, sharedState);
    } else if (interaction.customId === 'phase1_complete_yes' || interaction.customId === 'phase1_complete_no' || interaction.customId === 'phase1_cancel_session') {
        // Handle photo completion confirmation and cancellation buttons
        await handlePhase1CompleteButton(interaction, sharedState);
    } else if (interaction.customId.startsWith('phase1_resolve_')) {
        // Handle conflict resolution buttons
        await handlePhase1ConflictResolveButton(interaction, sharedState);
    } else if (interaction.customId === 'phase1_confirm_save' || interaction.customId === 'phase1_cancel_save') {
        // Handle final save confirmation buttons
        await handlePhase1FinalConfirmButton(interaction, sharedState);
    } else if (interaction.customId.startsWith('modify_confirm_') || interaction.customId === 'modify_cancel') {
        await handleModifyConfirmButton(interaction, sharedState);
    } else if (interaction.customId.startsWith('modify_page_prev|') || interaction.customId.startsWith('modify_page_next|')) {
        await handleModifyPaginationButton(interaction, sharedState);
    } else if (interaction.customId.startsWith('modify_week_prev|') || interaction.customId.startsWith('modify_week_next|')) {
        await handleModifyWeekPaginationButton(interaction, sharedState);
    } else if (interaction.customId.startsWith('results_weeks_prev|') || interaction.customId.startsWith('results_weeks_next|')) {
        await handleResultsWeekPaginationButton(interaction, sharedState);
    } else if (interaction.customId.startsWith('results_phase2_view|')) {
        await handleResultsPhase2ViewButton(interaction, sharedState);
    } else if (interaction.customId.startsWith('results_view|')) {
        await handleResultsViewButton(interaction, sharedState);
    } else if (interaction.customId.startsWith('phase2_overwrite_')) {
        await handlePhase2OverwriteButton(interaction, sharedState);
    } else if (interaction.customId.startsWith('phase2_complete_') || interaction.customId.startsWith('phase2_resolve_') || interaction.customId === 'phase2_cancel_session') {
        await handlePhase2CompleteButton(interaction, sharedState);
    } else if (interaction.customId === 'phase2_confirm_save' || interaction.customId === 'phase2_cancel_save') {
        await handlePhase2FinalConfirmButton(interaction, sharedState);
    } else if (interaction.customId === 'phase2_round_continue') {
        await handlePhase2RoundContinue(interaction, sharedState);
    }
}

function hasPermission(member, allowedRoles) {
    return allowedRoles.some(roleId => member.roles.cache.has(roleId));
}

/**
 * Sends "ghost ping" - a message with ping that is deleted after 5 seconds
 * If user doesn't click button, ping is repeated every 30 seconds
 * @param {Object} channel - Discord channel
 * @param {string} userId - User ID to ping
 * @param {Object} session - phaseService session (optional - for saving timers)
 */
async function sendGhostPing(channel, userId, session = null) {
    try {
        const pingMessage = await channel.send({
            content: `<@${userId}> Image analysis completed, continue!`
        });

        // Delete message after 5 seconds
        setTimeout(async () => {
            try {
                await pingMessage.delete();
            } catch (error) {
                logger.error('[GHOST_PING] ❌ Failed to delete ghost ping:', error.message);
            }
        }, 5000);

        logger.info(`[GHOST_PING] 📨 Sent ghost ping to user ${userId}`);

        // If we have session, set timer to repeat ping every 30 seconds
        if (session) {
            // Clear previous timer if exists
            if (session.pingTimer) {
                clearInterval(session.pingTimer);
            }

            // Set new timer
            session.pingTimer = setInterval(async () => {
                try {
                    const repeatPingMessage = await channel.send({
                        content: `<@${userId}> Image analysis completed, continue!`
                    });

                    setTimeout(async () => {
                        try {
                            await repeatPingMessage.delete();
                        } catch (error) {
                            logger.error('[GHOST_PING] ❌ Failed to delete repeated ghost ping:', error.message);
                        }
                    }, 5000);

                    logger.info(`[GHOST_PING] 🔄 Repeated ghost ping to user ${userId}`);
                } catch (error) {
                    logger.error('[GHOST_PING] ❌ Error while repeating ghost ping:', error.message);
                }
            }, 30000); // 30 seconds

            logger.info(`[GHOST_PING] ⏰ Set timer for repeating pings every 30s for session ${session.sessionId}`);
        }
    } catch (error) {
        logger.error('[GHOST_PING] ❌ Ghost ping sending error:', error.message);
    }
}

/**
 * Stops repeating ghost pings for session
 * @param {Object} session - phaseService session
 */
function stopGhostPing(session) {
    if (session && session.pingTimer) {
        clearInterval(session.pingTimer);
        session.pingTimer = null;
        logger.info(`[GHOST_PING] ⏹️ Stopped repeating ghost pings for session ${session.sessionId}`);
    }
}

function createConfirmationButtons(action) {
    return new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`confirm_${action}`)
                .setLabel('Confirm')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`cancel_${action}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger)
        );
}

// Function to unregister specific command
async function unregisterCommand(client, commandName) {
    try {
        logger.info(`[COMMANDS] 🗑️ Unregistering command: ${commandName}`);

        // Get all commands
        const commands = await client.application.commands.fetch();

        // Find command to delete
        const commandToDelete = commands.find(cmd => cmd.name === commandName);

        if (commandToDelete) {
            await commandToDelete.delete();
            logger.info(`[COMMANDS] ✅ Command ${commandName} has been unregistered`);
            return true;
        } else {
            logger.info(`[COMMANDS] ⚠️ Command ${commandName} was not found`);
            return false;
        }
    } catch (error) {
        logger.error(`[COMMANDS] ❌ Command unregistration error ${commandName}:`, error);
        return false;
    }
}

// Function to register slash commands
async function registerSlashCommands(client, config) {
    try {
        logger.info('[COMMANDS] 🔄 Starting command registration for all servers...');

        // Clear all global commands first (we use guild-specific commands only)
        await client.application.commands.set([]);
        logger.info('[COMMANDS] 🗑️ Cleared global commands (using guild-specific only)');

        // Register commands per-guild (for each server)
        for (const guild of client.guilds.cache.values()) {
            const serverConfig = config.getServerConfig(guild.id);

            if (!serverConfig) {
                logger.warn(`[COMMANDS] ⚠️ Skipping command registration for unconfigured server: ${guild.name} (${guild.id})`);
                continue;
            }

            // Build dynamic choices for punishment and debug-roles commands based on server config
            const clanChoices = Object.entries(serverConfig.targetRoles).map(([clanKey, roleId]) => ({
                name: serverConfig.roleDisplayNames[clanKey] || clanKey,
                value: clanKey
            }));

            const commands = [
                new SlashCommandBuilder()
                    .setName('punish')
                    .setDescription('Analyze image and find players with 0 score')
                    .addAttachmentOption(option =>
                        option.setName('image')
                            .setDescription('Image to analyze')
                            .setRequired(true)
                    ),

                new SlashCommandBuilder()
                    .setName('remind')
                    .setDescription('Send boss reminder for players with 0 score')
                    .addAttachmentOption(option =>
                        option.setName('image')
                            .setDescription('Image to analyze')
                            .setRequired(true)
                    ),

                new SlashCommandBuilder()
                    .setName('punishment')
                    .setDescription('Display punishment points ranking')
                    .addStringOption(option =>
                        option.setName('category')
                            .setDescription('Ranking category')
                            .setRequired(true)
                            .addChoices(...clanChoices)
                    ),

                new SlashCommandBuilder()
                    .setName('points')
                    .setDescription('Add or remove points from user')
                    .addUserOption(option =>
                        option.setName('user')
                            .setDescription('User')
                            .setRequired(true)
                    )
                    .addIntegerOption(option =>
                        option.setName('amount')
                            .setDescription('Number of points (positive = add, negative = remove, empty = remove user)')
                            .setRequired(false)
                            .setMinValue(-20)
                            .setMaxValue(20)
                    ),

                new SlashCommandBuilder()
                    .setName('debug-roles')
                    .setDescription('Debug server roles')
                    .addStringOption(option =>
                        option.setName('category')
                            .setDescription('Category to check')
                            .setRequired(true)
                            .addChoices(...clanChoices)
                    ),

                new SlashCommandBuilder()
                    .setName('ocr-debug')
                    .setDescription('Toggle detailed OCR logging')
                    .addBooleanOption(option =>
                        option.setName('enabled')
                            .setDescription('Enable (true) or disable (false) detailed logging')
                            .setRequired(false)
                    ),

                new SlashCommandBuilder()
                    .setName('decode')
                    .setDescription('Decode Survivor.io build code and display equipment data'),

                new SlashCommandBuilder()
                    .setName('phase1')
                    .setDescription('Collect and save results of all players for Phase 1'),

                new SlashCommandBuilder()
                    .setName('results')
                    .setDescription('Display results for all phases'),

                new SlashCommandBuilder()
                    .setName('modify')
                    .setDescription('Modify player result')
                    .addStringOption(option =>
                        option.setName('phase')
                            .setDescription('Select phase')
                            .setRequired(true)
                            .addChoices(
                                { name: 'Phase 1', value: 'phase1' },
                                { name: 'Phase 2', value: 'phase2' }
                            )
                    ),

                new SlashCommandBuilder()
                    .setName('add')
                    .setDescription('Add new player to existing results')
                    .addStringOption(option =>
                        option.setName('phase')
                            .setDescription('Select phase')
                            .setRequired(true)
                            .addChoices(
                                { name: 'Phase 1', value: 'phase1' },
                                { name: 'Phase 2', value: 'phase2' }
                            )
                    ),

                new SlashCommandBuilder()
                    .setName('phase2')
                    .setDescription('Collect and save results of all players for Phase 2 (3 rounds)')
            ];

            // Register commands for this specific guild
            await guild.commands.set(commands);
            logger.success(`[COMMANDS] ✅ Registered ${commands.length} commands for ${serverConfig.serverName || guild.name} with ${clanChoices.length} clans`);
        }

        logger.success('[COMMANDS] ✅ Command registration completed for all servers');
    } catch (error) {
        logger.error('[COMMANDS] ❌ Command registration error:', error);
    }
}

async function checkUncertainResults(interaction, players, imageUrl, config, punishmentService, ocrText) {
    // Check which players have © symbol at end of line
    const uncertainPlayers = [];
    const certainPlayers = [];
    
    for (const player of players) {
        // Find line with this player in OCR text
        const lines = ocrText.split('\n');
        let hasUncertainty = false;
        
        for (const line of lines) {
            const normalizedLine = line.toLowerCase();
            const normalizedPlayer = player.toLowerCase();
            
            if (normalizedLine.includes(normalizedPlayer) && line.trim().endsWith('©')) {
                hasUncertainty = true;
                break;
            }
        }
        
        if (hasUncertainty) {
            uncertainPlayers.push(player);
        } else {
            certainPlayers.push(player);
        }
    }
    
    if (uncertainPlayers.length > 0) {
        // Show question about uncertain results
        await showUncertaintyQuestion(interaction, uncertainPlayers, players, imageUrl, config, punishmentService);
    } else {
        // Proceed to normal confirmation
        await showFinalConfirmation(interaction, players, imageUrl, config, punishmentService);
    }
}

async function checkUncertainResultsWithUpdate(interaction, players, imageUrl, config, punishmentService, ocrText) {
    // Check which players have © symbol at end of line
    const uncertainPlayers = [];
    const certainPlayers = [];
    
    for (const player of players) {
        // Find line with this player in OCR text
        const lines = ocrText.split('\n');
        let hasUncertainty = false;
        
        for (const line of lines) {
            const normalizedLine = line.toLowerCase();
            const normalizedPlayer = player.toLowerCase();
            
            if (normalizedLine.includes(normalizedPlayer) && line.trim().endsWith('©')) {
                hasUncertainty = true;
                break;
            }
        }
        
        if (hasUncertainty) {
            uncertainPlayers.push(player);
        } else {
            certainPlayers.push(player);
        }
    }
    
    if (uncertainPlayers.length > 0) {
        // Show question about uncertain results
        await showUncertaintyQuestionWithUpdate(interaction, uncertainPlayers, players, imageUrl, config, punishmentService);
    } else {
        // Proceed to normal confirmation
        await showFinalConfirmationWithUpdate(interaction, players, imageUrl, config, punishmentService);
    }
}

async function showUncertaintyQuestion(interaction, uncertainPlayers, allPlayers, imageUrl, config, punishmentService) {
    const uncertaintyId = Date.now().toString();
    
    // Zapisz dane do mapy
    confirmationData.set(uncertaintyId, {
        action: 'uncertainty_check',
        uncertainPlayers: uncertainPlayers,
        allPlayers: allPlayers,
        imageUrl: imageUrl,
        config: config,
        punishmentService: punishmentService,
        originalUserId: interaction.user.id
    });
    
    // Usuń dane po 5 minut
    setTimeout(() => {
        confirmationData.delete(uncertaintyId);
    }, 5 * 60 * 1000);
    
    const playersText = uncertainPlayers.map(nick => `**${nick}**`).join(', ');
    
    const yesButton = new ButtonBuilder()
        .setCustomId(`uncertainty_yes_${uncertaintyId}`)
        .setLabel('✅ Yes')
        .setStyle(ButtonStyle.Success);
    
    const noButton = new ButtonBuilder()
        .setCustomId(`uncertainty_no_${uncertaintyId}`)
        .setLabel('❌ No')
        .setStyle(ButtonStyle.Danger);
    
    const row = new ActionRowBuilder()
        .addComponents(yesButton, noButton);
    
    const embed = new EmbedBuilder()
        .setTitle('❓ Uncertain OCR Result')
        .setDescription(`Bot is not certain about the result for: ${playersText} (symbol © detected).\nShould we add ${uncertainPlayers.length > 1 ? 'these players' : 'this player'} to the list with zeros?`)
        .setColor('#FFA500')
        .setImage(imageUrl)
        .setTimestamp()
        .setFooter({ text: `Check the image and decide • Request from ${interaction.user.tag}` });
    
    await interaction.editReply({
        embeds: [embed],
        components: [row]
    });
}

async function showUncertaintyQuestionWithUpdate(interaction, uncertainPlayers, allPlayers, imageUrl, config, punishmentService) {
    const uncertaintyId = Date.now().toString();
    
    // Zapisz dane do mapy
    confirmationData.set(uncertaintyId, {
        action: 'uncertainty_check',
        uncertainPlayers: uncertainPlayers,
        allPlayers: allPlayers,
        imageUrl: imageUrl,
        config: config,
        punishmentService: punishmentService,
        originalUserId: interaction.user.id
    });
    
    // Usuń dane po 5 minut
    setTimeout(() => {
        confirmationData.delete(uncertaintyId);
    }, 5 * 60 * 1000);
    
    const playersText = uncertainPlayers.map(nick => `**${nick}**`).join(', ');
    
    const yesButton = new ButtonBuilder()
        .setCustomId(`uncertainty_yes_${uncertaintyId}`)
        .setLabel('✅ Yes')
        .setStyle(ButtonStyle.Success);
    
    const noButton = new ButtonBuilder()
        .setCustomId(`uncertainty_no_${uncertaintyId}`)
        .setLabel('❌ No')
        .setStyle(ButtonStyle.Danger);
    
    const row = new ActionRowBuilder()
        .addComponents(yesButton, noButton);
    
    const embed = new EmbedBuilder()
        .setTitle('❓ Uncertain OCR Result')
        .setDescription(`Bot is not certain about the result for: ${playersText} (symbol © detected).\nShould we add ${uncertainPlayers.length > 1 ? 'these players' : 'this player'} to the list with zeros?`)
        .setColor('#FFA500')
        .setImage(imageUrl)
        .setTimestamp()
        .setFooter({ text: `Check the image and decide • Request from ${interaction.user.tag}` });
    
    await interaction.update({
        embeds: [embed],
        components: [row]
    });
}

async function showFinalConfirmation(interaction, finalPlayers, imageUrl, config, punishmentService) {
    const confirmationId = Date.now().toString();
    
    // Convert nicks to objects with members for punishmentService
    const foundUserObjects = [];
    for (const nick of finalPlayers) {
        const member = interaction.guild.members.cache.find(m => 
            m.displayName.toLowerCase() === nick.toLowerCase() || 
            m.user.username.toLowerCase() === nick.toLowerCase()
        );
        if (member) {
            foundUserObjects.push({ 
                userId: member.id,
                member: member, 
                matchedName: nick 
            });
        }
    }
    
    // Save data to map
    confirmationData.set(confirmationId, {
        action: 'punish',
        foundUsers: foundUserObjects,
        zeroScorePlayers: finalPlayers,
        imageUrl: imageUrl,
        originalUserId: interaction.user.id,
        config: config,
        punishmentService: punishmentService
    });
    
    // Remove data after 5 minutes
    setTimeout(() => {
        confirmationData.delete(confirmationId);
    }, 5 * 60 * 1000);
    
    const confirmButton = new ButtonBuilder()
        .setCustomId(`confirm_punish_${confirmationId}`)
        .setLabel('✅ Yes')
        .setStyle(ButtonStyle.Success);
    
    const cancelButton = new ButtonBuilder()
        .setCustomId(`cancel_punish_${confirmationId}`)
        .setLabel('❌ No')
        .setStyle(ButtonStyle.Danger);
    
    const row = new ActionRowBuilder()
        .addComponents(confirmButton, cancelButton);
    
    const confirmationEmbed = new EmbedBuilder()
        .setTitle('⚖️ Confirmation of Adding Punishment Points')
        .setDescription('Do you want to add punishment points for the found players?')
        .setColor('#ff6b6b')
        .addFields(
            { name: `✅ Found ${finalPlayers.length} players with ZERO score`, value: `\`${finalPlayers.join(', ')}\``, inline: false }
        )
        .setImage(imageUrl)
        .setTimestamp()
        .setFooter({ text: `Request from ${interaction.user.tag} | Confirm or cancel within 5 minutes` });
    
    await interaction.editReply({ 
        embeds: [confirmationEmbed],
        components: [row]
    });
}

async function showFinalConfirmationWithUpdate(interaction, finalPlayers, imageUrl, config, punishmentService) {
    const confirmationId = Date.now().toString();
    
    // Convert nicks to objects with members for punishmentService
    const foundUserObjects = [];
    for (const nick of finalPlayers) {
        const member = interaction.guild.members.cache.find(m => 
            m.displayName.toLowerCase() === nick.toLowerCase() || 
            m.user.username.toLowerCase() === nick.toLowerCase()
        );
        if (member) {
            foundUserObjects.push({ 
                userId: member.id,
                member: member, 
                matchedName: nick 
            });
        }
    }
    
    // Save data to map
    confirmationData.set(confirmationId, {
        action: 'punish',
        foundUsers: foundUserObjects,
        zeroScorePlayers: finalPlayers,
        imageUrl: imageUrl,
        originalUserId: interaction.user.id,
        config: config,
        punishmentService: punishmentService
    });
    
    // Remove data after 5 minutes
    setTimeout(() => {
        confirmationData.delete(confirmationId);
    }, 5 * 60 * 1000);
    
    const confirmButton = new ButtonBuilder()
        .setCustomId(`confirm_punish_${confirmationId}`)
        .setLabel('✅ Yes')
        .setStyle(ButtonStyle.Success);
    
    const cancelButton = new ButtonBuilder()
        .setCustomId(`cancel_punish_${confirmationId}`)
        .setLabel('❌ No')
        .setStyle(ButtonStyle.Danger);
    
    const row = new ActionRowBuilder()
        .addComponents(confirmButton, cancelButton);
    
    const confirmationEmbed = new EmbedBuilder()
        .setTitle('⚖️ Confirmation of Adding Punishment Points')
        .setDescription('Do you want to add punishment points for the found players?')
        .setColor('#ff6b6b')
        .addFields(
            { name: `✅ Found ${finalPlayers.length} players with ZERO score`, value: `\`${finalPlayers.join(', ')}\``, inline: false }
        )
        .setImage(imageUrl)
        .setTimestamp()
        .setFooter({ text: `Request from ${interaction.user.tag} | Confirm or cancel within 5 minutes` });
    
    await interaction.update({ 
        embeds: [confirmationEmbed],
        components: [row]
    });
}

async function handleOcrDebugCommand(interaction, config) {
    // Check administrator permissions
    if (!interaction.member.permissions.has('Administrator')) {
        await interaction.reply({
            content: '❌ You don\'t have permission to use this command. Required: **Administrator**',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const enabled = interaction.options.getBoolean('enabled');

    if (enabled === null) {
        // Check current state
        const currentState = config.ocr.detailedLogging.enabled;
        await interaction.reply({
            content: `🔍 **Detailed OCR logging:** ${currentState ? '✅ Enabled' : '❌ Disabled'}`,
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Toggle state
    config.ocr.detailedLogging.enabled = enabled;

    const statusText = enabled ? '✅ Enabled' : '❌ Disabled';
    const emoji = enabled ? '🔍' : '🔇';

    logger.info(`${emoji} Szczegółowe logowanie OCR zostało ${enabled ? 'włączone' : 'wyłączone'} przez ${interaction.user.tag}`);

    await interaction.reply({
        content: `${emoji} **Detailed OCR logging:** ${statusText}`,
        flags: MessageFlags.Ephemeral
    });
}

async function handleDecodeCommand(interaction, sharedState) {
    const { config, survivorService } = sharedState;

    // Get server-specific configuration
    const serverConfig = getServerConfigOrThrow(interaction.guild.id, config);

    // Sprawdź czy kanał jest zablokowany for command /decode
    const currentChannelId = interaction.channelId;
    const parentChannelId = interaction.channel?.parent?.id;

    // Check if this is an allowed channel or thread in an allowed channel
    const isAllowedChannel = serverConfig.allowedDecodeChannels.includes(currentChannelId) ||
                            serverConfig.allowedDecodeChannels.includes(parentChannelId);

    // Administrators can use the command anywhere
    const isAdmin = interaction.member.permissions.has('Administrator');

    if (!isAllowedChannel && !isAdmin) {
        await interaction.reply({
            content: '❌ Command `/decode` is available only on selected channels.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Display modal with field to enter code
    const modal = new ModalBuilder()
        .setCustomId('decode_modal')
        .setTitle('Decode Survivor.io Build');

    const codeInput = new TextInputBuilder()
        .setCustomId('build_code')
        .setLabel('Build Code')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Copy the code received after clicking "EXPORT" on https://sio-tools.vercel.app/')
        .setRequired(true)
        .setMinLength(10)
        .setMaxLength(4000);

    const actionRow = new ActionRowBuilder().addComponents(codeInput);
    modal.addComponents(actionRow);

    await interaction.showModal(modal);
}

async function handleModalSubmit(interaction, sharedState) {
    if (interaction.customId === 'decode_modal') {
        await handleDecodeModalSubmit(interaction, sharedState);
    // Modal results_attachments_modal was removed - now we use file upload directly
    } else if (interaction.customId.startsWith('modify_modal_')) {
        await handleModifyModalSubmit(interaction, sharedState);
    } else if (interaction.customId.startsWith('add_modal|')) {
        await handleAddModalSubmit(interaction, sharedState);
    }
}

async function handlePhase1Command(interaction, sharedState) {
    const { config, phaseService, databaseService } = sharedState;

    // Get server-specific configuration
    const serverConfig = getServerConfigOrThrow(interaction.guild.id, config);

    // Check permissions (admin or allowedPunishRoles)
    const isAdmin = interaction.member.permissions.has('Administrator');
    const hasPunishRole = hasPermission(interaction.member, serverConfig.allowedPunishRoles);

    if (!isAdmin && !hasPunishRole) {
        await interaction.reply({
            content: '❌ You don\'t have permission to use this command. Required: **Administrator** or moderator role.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    await interaction.deferReply();

    try {
        // Detect user clan
        const targetRoleIds = Object.entries(serverConfig.targetRoles);
        let userClan = null;

        for (const [clanKey, roleId] of targetRoleIds) {
            if (interaction.member.roles.cache.has(roleId)) {
                userClan = clanKey;
                logger.info(`[PHASE1] 🎯 Detected user clan: ${clanKey} (${serverConfig.roleDisplayNames[clanKey]})`);
                break;
            }
        }

        if (!userClan) {
            await interaction.editReply({
                content: '❌ Your clan was not detected. You must have one of the roles: ' +
                    Object.values(config.roleDisplayNames).join(', ')
            });
            return;
        }

        // Check if someone is already processing data
        if (phaseService.isProcessingActive(interaction.guild.id)) {
            const activeUserId = phaseService.getActiveProcessor(interaction.guild.id);

            // Check if user has reservation
            if (!phaseService.hasReservation(interaction.guild.id, interaction.user.id)) {
                // User doesn't have reservation - add to queue
                await phaseService.addToWaitingQueue(interaction.guild.id, interaction.user.id);

                // Get queue information
                const queueInfo = await phaseService.getQueueInfo(interaction.guild.id, interaction.user.id);

                await interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setTitle('⏳ Queue busy')
                        .setDescription(queueInfo.description)
                        .setColor('#FFA500')
                        .setTimestamp()
                    ]
                });
                return;
            }

            // User has reservation but someone else is still using - this shouldn't happen
            logger.warn(`[PHASE] ⚠️ User ${interaction.user.id} ma rezerwację ale ktoś inny (${activeUserId}) nadal przetwarza`);
        }

        // If user has reservation, remove from queue
        phaseService.removeFromQueue(interaction.guild.id, interaction.user.id);

        // Sprawdź czy dane for tego tygodnia i klanu już istnieją
        const weekInfo = phaseService.getCurrentWeekInfo();
        const existingData = await databaseService.checkPhase1DataExists(
            interaction.guild.id,
            weekInfo.weekNumber,
            weekInfo.year,
            userClan
        );

        if (existingData.exists) {
            // Show warning with buttons
            const warningEmbed = await phaseService.createOverwriteWarningEmbed(
                interaction.guild.id,
                weekInfo,
                userClan,
                1,
                interaction.guild
            );

            if (warningEmbed) {
                await interaction.editReply({
                    embeds: [warningEmbed.embed],
                    components: [warningEmbed.row]
                });
                return;
            }
        }

        // Zablokuj przetwarzanie for tego guild
        phaseService.setActiveProcessing(interaction.guild.id, interaction.user.id);

        // Create session
        const sessionId = phaseService.createSession(
            interaction.user.id,
            interaction.guild.id,
            interaction.channelId
        );

        const session = phaseService.getSession(sessionId);
        session.publicInteraction = interaction;
        session.clan = userClan;

        // Show embed requesting images (PUBLIC)
        const awaitingEmbed = phaseService.createAwaitingImagesEmbed();
        await interaction.editReply({
            embeds: [awaitingEmbed.embed],
            components: [awaitingEmbed.row]
        });

        logger.info(`[PHASE1] ✅ Session created, waiting for images from ${interaction.user.tag}`);

    } catch (error) {
        logger.error('[PHASE1] ❌ /phase1 command error:', error);

        // Unlock in case of error
        phaseService.clearActiveProcessing(interaction.guild.id);

        await interaction.editReply({
            content: '❌ An error occurred while initializing /phase1 command.'
        });
    }
}

async function handleDecodeModalSubmit(interaction, sharedState) {
    const { config, survivorService } = sharedState;

    const code = interaction.fields.getTextInputValue('build_code');

    if (!code || code.trim().length === 0) {
        await interaction.reply({
            content: '❌ No code provided for decoding.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    await interaction.deferReply();

    try {
        const buildData = survivorService.decodeBuild(code.trim());

        if (!buildData.success) {
            await interaction.editReply({
                content: `❌ **Failed to decode code**\n\n**Error:** ${buildData.error}\n**Code:** \`${code}\``,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const userDisplayName = interaction.member?.displayName || interaction.user.username;
        const viewerDisplayName = interaction.member?.displayName || interaction.user.username;
        const embeds = await survivorService.createBuildEmbeds(buildData.data, userDisplayName, code, viewerDisplayName);
        const navigationButtons = survivorService.createNavigationButtons(0);
        const response = await interaction.editReply({
            embeds: [embeds[0]], // Start from first page
            components: navigationButtons
        });

        // Store data for pagination
        if (!sharedState.buildPagination) {
            sharedState.buildPagination = new Map();
        }

        sharedState.buildPagination.set(response.id, {
            embeds: embeds,
            currentPage: 0,
            userId: interaction.user.id,
            timestamp: Date.now()
        });

        // Schedule message deletion after 15 minutes (persist across restarts)
        const deleteAt = Date.now() + (15 * 60 * 1000); // 15 minut
        await sharedState.messageCleanupService.scheduleMessageDeletion(
            response.id,
            response.channelId,
            deleteAt,
            interaction.user.id // Save owner
        );

        // Remove pagination data after 15 minutes (only if bot doesn't get restarted)
        setTimeout(() => {
            if (sharedState.buildPagination && sharedState.buildPagination.has(response.id)) {
                sharedState.buildPagination.delete(response.id);
            }
        }, 15 * 60 * 1000);

        logger.info(`✅ Successfully decoded Survivor.io build for ${interaction.user.tag}`);

    } catch (error) {
        logger.error(`❌ Survivor.io build decoding error: ${error.message}`);

        await interaction.editReply({
            content: `❌ **An error occurred while decoding**\n\n**Error:** ${error.message}\n**Code:** \`${code}\``,
            flags: MessageFlags.Ephemeral
        });
    }
}

// =============== PHASE 1 HANDLERS ===============

async function handlePhase1OverwriteButton(interaction, sharedState) {
    const { phaseService, config } = sharedState;

    if (interaction.customId === 'phase1_overwrite_no') {
        // Cancel - odblokuj przetwarzanie
        phaseService.clearActiveProcessing(interaction.guild.id);

        await interaction.update({
            content: '❌ Operation cancelled.',
            embeds: [],
            components: []
        });
        return;
    }

    // Detect user clan ponownie
    const targetRoleIds = Object.entries(config.targetRoles);
    let userClan = null;

    for (const [clanKey, roleId] of targetRoleIds) {
        if (interaction.member.roles.cache.has(roleId)) {
            userClan = clanKey;
            break;
        }
    }

    if (!userClan) {
        await interaction.update({
            content: '❌ Your clan was not detected.',
            embeds: [],
            components: []
        });
        return;
    }

    // Overwrite - lock processing and create session
    phaseService.setActiveProcessing(interaction.guild.id, interaction.user.id);

    const sessionId = phaseService.createSession(
        interaction.user.id,
        interaction.guild.id,
        interaction.channelId
    );

    const session = phaseService.getSession(sessionId);
    session.publicInteraction = interaction;
    session.clan = userClan;

    const awaitingEmbed = phaseService.createAwaitingImagesEmbed();
    await interaction.update({
        embeds: [awaitingEmbed.embed],
        components: [awaitingEmbed.row]
    });

    logger.info(`[PHASE1] ✅ Session created (overwriting), waiting for images from ${interaction.user.tag}`);
}

async function handlePhase1CompleteButton(interaction, sharedState) {
    const { phaseService } = sharedState;

    const session = phaseService.getSessionByUserId(interaction.user.id);

    if (!session) {
        await interaction.reply({
            content: '❌ Session expired or does not exist.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    if (session.userId !== interaction.user.id) {
        await interaction.reply({
            content: '❌ Only the person who initiated the command can confirm it.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    if (interaction.customId === 'phase1_cancel_session') {
        // Cancel session and release queue
        await phaseService.cleanupSession(session.sessionId);
        await phaseService.clearActiveProcessing(interaction.guild.id);

        await interaction.update({
            content: '❌ Session cancelled.',
            embeds: [],
            components: []
        });

        logger.info(`[PHASE1] ❌ Session cancelled by user: ${interaction.user.tag}`);
        return;
    }

    if (interaction.customId === 'phase1_complete_no') {
        // Add more images
        session.stage = 'awaiting_images';
        phaseService.refreshSessionTimeout(session.sessionId);

        const awaitingEmbed = phaseService.createAwaitingImagesEmbed();
        await interaction.update({
            embeds: [awaitingEmbed.embed],
            components: [awaitingEmbed.row]
        });

        logger.info(`[PHASE1] ➕ User wants to add more images`);
        return;
    }

    // Yes, analyze
    await interaction.update({
        content: '🔄 Analyzing results...',
        embeds: [],
        components: []
    });

    try {
        // Identify conflicts
        const conflicts = phaseService.identifyConflicts(session);

        if (conflicts.length > 0) {
            // Proceed to conflict resolution
            session.stage = 'resolving_conflicts';
            const firstConflict = phaseService.getNextUnresolvedConflict(session);

            if (firstConflict) {
                const conflictEmbed = phaseService.createConflictEmbed(firstConflict, 1, conflicts.length, 1);
                await interaction.editReply({
                    embeds: [conflictEmbed.embed],
                    components: [conflictEmbed.row]
                });
            }
        } else {
            // No conflicts - proceed to final summary
            await showPhase1FinalSummary(interaction, session, phaseService);
        }

    } catch (error) {
        logger.error('[PHASE1] ❌ Results analysis error:', error);
        await interaction.editReply({
            content: '❌ An error occurred while analyzing results.'
        });
    }
}

async function handlePhase1ConflictResolveButton(interaction, sharedState) {
    const { phaseService } = sharedState;

    const session = phaseService.getSessionByUserId(interaction.user.id);

    if (!session) {
        await interaction.reply({
            content: '❌ Session expired or does not exist.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    if (session.userId !== interaction.user.id) {
        await interaction.reply({
            content: '❌ Only the person who initiated the command can resolve conflicts.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Stop ghost ping - user clicked button
    stopGhostPing(session);

    // Wyciągnij nick i wartość z customId
    // Format: phase1_resolve_{nick}_{value}
    const parts = interaction.customId.split('_');
    const value = parts[parts.length - 1];
    const nick = parts.slice(2, parts.length - 1).join('_');

    logger.info(`[PHASE1] Rozstrzygam konflikt for nick="${nick}", value="${value}"`);

    // Resolve conflict
    phaseService.resolveConflict(session, nick, parseInt(value) || 0);

    logger.info(`[PHASE1] Rozstrzygnięto konfliktów: ${session.resolvedConflicts.size}/${session.conflicts.length}`);

    // Check if there are more conflicts
    const nextConflict = phaseService.getNextUnresolvedConflict(session);

    if (nextConflict) {
        // Show next conflict
        const currentIndex = session.resolvedConflicts.size + 1;
        const totalConflicts = session.conflicts.length;

        logger.info(`[PHASE1] Next conflict: nick="${nextConflict.nick}", index=${currentIndex}/${totalConflicts}`);

        const conflictEmbed = phaseService.createConflictEmbed(nextConflict, currentIndex, totalConflicts, 1);
        await interaction.update({
            embeds: [conflictEmbed.embed],
            components: [conflictEmbed.row]
        });
    } else {
        logger.info(`[PHASE1] All conflicts resolved!`);
        // All conflicts resolved - show final summary
        await interaction.update({
            content: '🔄 Preparing summary...',
            embeds: [],
            components: []
        });

        await showPhase1FinalSummary(interaction, session, phaseService);
    }
}

async function handlePhase1FinalConfirmButton(interaction, sharedState) {
    const { phaseService } = sharedState;

    const session = phaseService.getSessionByUserId(interaction.user.id);

    if (!session) {
        await interaction.reply({
            content: '❌ Session expired or does not exist.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    if (session.userId !== interaction.user.id) {
        await interaction.reply({
            content: '❌ Tylko osoba, która uruchomiła komendę może ją zatwierdzić.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Stop ghost ping - user clicked button
    stopGhostPing(session);

    if (interaction.customId === 'phase1_cancel_save') {
        // Cancel - delete temp files and release queue
        await phaseService.cleanupSession(session.sessionId);
        await phaseService.clearActiveProcessing(interaction.guild.id);

        await interaction.update({
            content: '❌ Operation cancelled. Dane nie have been saved.',
            embeds: [],
            components: []
        });
        return;
    }

    // Confirm - zapisz do bazy
    await interaction.update({
        content: '💾 Zapisuję wyniki do bazy danych...',
        embeds: [],
        components: []
    });

    try {
        const finalResults = phaseService.getFinalResults(session);
        const savedCount = await phaseService.saveFinalResults(session, finalResults, interaction.guild, interaction.user.id);

        const weekInfo = phaseService.getCurrentWeekInfo();
        const stats = phaseService.calculateStatistics(finalResults);
        const clanName = sharedState.config.roleDisplayNames[session.clan] || session.clan;

        // Zbierz nicki players z wynikiem 0
        const playersWithZero = [];
        for (const [nick, score] of finalResults) {
            if (score === 0) {
                playersWithZero.push(nick);
            }
        }

        // Publiczny raport (wszystko widoczne for wszystkich)
        const publicEmbed = new EmbedBuilder()
            .setTitle('✅ Phase 1 - Data Saved Successfully')
            .setDescription(`Results for week **${weekInfo.weekNumber}/${weekInfo.year}** have been saved.`)
            .setColor('#00FF00')
            .addFields(
                { name: '👥 Unique players', value: stats.uniqueNicks.toString(), inline: true },
                { name: '📈 Score > 0', value: `${stats.aboveZero} people`, inline: true },
                { name: '⭕ Score = 0', value: `${stats.zeroCount} people`, inline: true },
                { name: '🏆 Total TOP30', value: `${stats.top30Sum.toLocaleString('pl-PL')} pkt`, inline: false },
                { name: '🎯 Clan', value: clanName, inline: false }
            )
            .setTimestamp()
            .setFooter({ text: `Zapisane przez ${interaction.user.tag}` });

        // Add players list z zerem jeśli są
        if (playersWithZero.length > 0) {
            const zeroList = playersWithZero.join(', ');
            publicEmbed.addFields({ name: '📋 Playere z wynikiem 0', value: zeroList, inline: false });
        }

        await interaction.editReply({ embeds: [publicEmbed], components: [] });

        // Delete temp files after saving (will also unlock processing)
        await phaseService.cleanupSession(session.sessionId);
        logger.info(`[PHASE1] ✅ Data saved for tygodnia ${weekInfo.weekNumber}/${weekInfo.year}`);

    } catch (error) {
        logger.error('[PHASE1] ❌ Error zapisu danych:', error);

        // Odblokuj przetwarzanie w przypadku błędu
        phaseService.clearActiveProcessing(interaction.guild.id);

        await interaction.editReply({
            content: '❌ An error occurred while zapisu danych do bazy.',
            components: []
        });
    }
}

async function showPhase1FinalSummary(interaction, session, phaseService) {
    const finalResults = phaseService.getFinalResults(session);
    const stats = phaseService.calculateStatistics(finalResults);
    const weekInfo = phaseService.getCurrentWeekInfo();

    // Prepare players list z paskami postępu
    const players = Array.from(finalResults.entries()).map(([nick, score]) => ({
        displayName: nick,
        score: score,
        userId: null // W phase1 nie mamy userId w finalResults
    }));

    const sortedPlayers = players.sort((a, b) => b.score - a.score);
    const maxScore = sortedPlayers[0]?.score || 1;

    const resultsText = sortedPlayers.map((player, index) => {
        const position = index + 1;
        const barLength = 16;
        const filledLength = player.score > 0 ? Math.max(1, Math.round((player.score / maxScore) * barLength)) : 0;
        const progressBar = player.score > 0 ? '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength) : '░'.repeat(barLength);

        return `${progressBar} ${position}. ${player.displayName} - ${player.score.toLocaleString('pl-PL')}`;
    }).join('\n');

    const summaryEmbed = phaseService.createFinalSummaryEmbed(stats, weekInfo, session.clan, 1);

    // Add players list to description
    const clanName = phaseService.config.roleDisplayNames[session.clan] || session.clan;
    summaryEmbed.embed.setDescription(
        `**Clan:** ${clanName}\n**Week:** ${weekInfo.weekNumber}/${weekInfo.year}\n**TOP30:** ${stats.top30Sum.toLocaleString('en-US')} pts\n\n${resultsText}\n\n✅ Analyzed all images and resolved conflicts.\n\n**⚠️ Carefully verify that the final read result matches the actual points earned in the game.**\n**Accept the result only when everything matches!**`
    );

    session.stage = 'final_confirmation';

    await interaction.editReply({
        embeds: [summaryEmbed.embed],
        components: [summaryEmbed.row]
    });
}

// =============== PHASE 2 HANDLERS ===============

async function handlePhase2Command(interaction, sharedState) {
    const { config, phaseService, databaseService } = sharedState;

    // Get server-specific configuration
    const serverConfig = getServerConfigOrThrow(interaction.guild.id, config);

    // Check permissions (admin or allowedPunishRoles)
    const isAdmin = interaction.member.permissions.has('Administrator');
    const hasPunishRole = hasPermission(interaction.member, serverConfig.allowedPunishRoles);

    if (!isAdmin && !hasPunishRole) {
        await interaction.reply({
            content: '❌ You don\'t have permission to use this command. Required: **Administrator** or moderator role.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    await interaction.deferReply();

    try {
        // Detect user clan
        const targetRoleIds = Object.entries(serverConfig.targetRoles);
        let userClan = null;

        for (const [clanKey, roleId] of targetRoleIds) {
            if (interaction.member.roles.cache.has(roleId)) {
                userClan = clanKey;
                logger.info(`[PHASE2] 🎯 Detected user clan: ${clanKey} (${serverConfig.roleDisplayNames[clanKey]})`);
                break;
            }
        }

        if (!userClan) {
            await interaction.editReply({
                content: '❌ Your clan was not detected. You must have one of the roles: ' +
                    Object.values(config.roleDisplayNames).join(', ')
            });
            return;
        }

        // Check if someone is already processing data
        if (phaseService.isProcessingActive(interaction.guild.id)) {
            const activeUserId = phaseService.getActiveProcessor(interaction.guild.id);

            // Check if user has reservation
            if (!phaseService.hasReservation(interaction.guild.id, interaction.user.id)) {
                // User doesn't have reservation - add to queue
                await phaseService.addToWaitingQueue(interaction.guild.id, interaction.user.id);

                // Get queue information
                const queueInfo = await phaseService.getQueueInfo(interaction.guild.id, interaction.user.id);

                await interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setTitle('⏳ Queue busy')
                        .setDescription(queueInfo.description)
                        .setColor('#FFA500')
                        .setTimestamp()
                    ]
                });
                return;
            }

            // User has reservation but someone else is still using - this shouldn't happen
            logger.warn(`[PHASE] ⚠️ User ${interaction.user.id} ma rezerwację ale ktoś inny (${activeUserId}) nadal przetwarza`);
        }

        // If user has reservation, remove from queue
        phaseService.removeFromQueue(interaction.guild.id, interaction.user.id);

        // Sprawdź czy dane for tego tygodnia i klanu już istnieją
        const weekInfo = phaseService.getCurrentWeekInfo();
        const existingData = await databaseService.checkPhase2DataExists(
            interaction.guild.id,
            weekInfo.weekNumber,
            weekInfo.year,
            userClan
        );

        if (existingData.exists) {
            // Show warning with buttons
            const warningEmbed = await phaseService.createOverwriteWarningEmbed(
                interaction.guild.id,
                weekInfo,
                userClan,
                2,
                interaction.guild
            );

            if (warningEmbed) {
                await interaction.editReply({
                    embeds: [warningEmbed.embed],
                    components: [warningEmbed.row]
                });
                return;
            }
        }

        // Zablokuj przetwarzanie for tego guild
        phaseService.setActiveProcessing(interaction.guild.id, interaction.user.id);

        // Create session for fazy 2
        const sessionId = phaseService.createSession(
            interaction.user.id,
            interaction.guild.id,
            interaction.channelId,
            2 // phase 2
        );

        const session = phaseService.getSession(sessionId);
        session.publicInteraction = interaction;
        session.clan = userClan;

        // Show embed with request for images for round 1 (PUBLIC)
        const awaitingEmbed = phaseService.createAwaitingImagesEmbed(2, 1);
        await interaction.editReply({
            embeds: [awaitingEmbed.embed],
            components: [awaitingEmbed.row]
        });

        logger.info(`[PHASE2] ✅ Session created, waiting for images z rundy 1/3 od ${interaction.user.tag}`);

    } catch (error) {
        logger.info(`[PHASE2] ❌ Error command /phase2:`, error);

        // Unlock in case of error
        phaseService.clearActiveProcessing(interaction.guild.id);

        await interaction.editReply({
            content: '❌ An error occurred while starting command.'
        });
    }
}

async function handlePhase2OverwriteButton(interaction, sharedState) {
    const { phaseService, config } = sharedState;

    if (interaction.customId === 'phase2_overwrite_no') {
        phaseService.clearActiveProcessing(interaction.guild.id);
        await interaction.update({
            content: '❌ Operation cancelled.',
            embeds: [],
            components: []
        });
        return;
    }

    const targetRoleIds = Object.entries(config.targetRoles);
    let userClan = null;

    for (const [clanKey, roleId] of targetRoleIds) {
        if (interaction.member.roles.cache.has(roleId)) {
            userClan = clanKey;
            break;
        }
    }

    if (!userClan) {
        await interaction.update({
            content: '❌ Your clan was not detected.',
            embeds: [],
            components: []
        });
        return;
    }

    phaseService.setActiveProcessing(interaction.guild.id, interaction.user.id);

    const sessionId = phaseService.createSession(
        interaction.user.id,
        interaction.guild.id,
        interaction.channelId,
        2
    );

    const session = phaseService.getSession(sessionId);
    session.publicInteraction = interaction;
    session.clan = userClan;

    const awaitingEmbed = phaseService.createAwaitingImagesEmbed(2, 1);
    await interaction.update({
        embeds: [awaitingEmbed.embed],
        components: [awaitingEmbed.row]
    });

    logger.info(`[PHASE2] ✅ Session created (overwriting), waiting for images from ${interaction.user.tag}`);
}

async function handlePhase2CompleteButton(interaction, sharedState) {
    const { phaseService } = sharedState;

    const session = phaseService.getSessionByUserId(interaction.user.id);

    if (!session || session.userId !== interaction.user.id) {
        await interaction.reply({
            content: '❌ Session wygasła lub nie masz uprawnień.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    if (interaction.customId === 'phase2_cancel_session') {
        // Cancel session and release queue
        await phaseService.cleanupSession(session.sessionId);
        await phaseService.clearActiveProcessing(interaction.guild.id);

        await interaction.update({
            content: '❌ Session cancelled.',
            embeds: [],
            components: []
        });

        logger.info(`[PHASE2] ❌ Session cancelled by user: ${interaction.user.tag}`);
        return;
    }

    if (interaction.customId === 'phase2_complete_no') {
        session.stage = 'awaiting_images';
        phaseService.refreshSessionTimeout(session.sessionId);

        const awaitingEmbed = phaseService.createAwaitingImagesEmbed(2, session.currentRound);
        await interaction.update({
            embeds: [awaitingEmbed.embed],
            components: [awaitingEmbed.row]
        });
        return;
    }

    // Jeśli to przycisk rozwiązywania konfliktu
    if (interaction.customId.startsWith('phase2_resolve_')) {
        // Stop ghost ping - user clicked button
        stopGhostPing(session);

        const parts = interaction.customId.split('_');
        const nick = parts[2];
        const chosenValue = parseInt(parts[3]);

        logger.info(`[PHASE2] Rozstrzygam konflikt for nick="${nick}", value="${chosenValue}"`);

        const conflict = phaseService.getNextUnresolvedConflict(session);

        if (conflict) {
            phaseService.resolveConflict(session, conflict.nick, chosenValue);
            const nextConflict = phaseService.getNextUnresolvedConflict(session);

            if (nextConflict) {
                const conflictEmbed = phaseService.createConflictEmbed(
                    nextConflict,
                    session.resolvedConflicts.size + 1,
                    session.conflicts.length,
                    2
                );
                await interaction.update({
                    embeds: [conflictEmbed.embed],
                    components: [conflictEmbed.row]
                });
                return;
            }
        }

        // All conflicts resolved - pokaż summary rundy
        logger.info(`[PHASE2] ✅ All conflicts resolved!`);

        // Pokaż summary rundy (działa for rund 1, 2 i 3)
        await showPhase2RoundSummary(interaction, session, phaseService);
        return;
    }

    // Przycisk "Tak, gotowe" po dodaniu zdjęć
    await interaction.update({
        content: '🔄 Analyzing results...',
        embeds: [],
        components: []
    });

    try {
        const aggregated = phaseService.aggregateResults(session);
        const conflicts = phaseService.identifyConflicts(session);

        if (conflicts.length > 0) {
            session.stage = 'resolving_conflicts';
            session.currentConflictIndex = 0;
            const conflictEmbed = phaseService.createConflictEmbed(conflicts[0], 0, conflicts.length, 2);
            await interaction.editReply({
                embeds: [conflictEmbed.embed],
                components: [conflictEmbed.row]
            });
        } else {
            // Brak konfliktów - pokaż summary rundy
            await showPhase2RoundSummary(interaction, session, phaseService);
        }
    } catch (error) {
        logger.error('[PHASE2] ❌ Error analizy:', error);
        await interaction.editReply({
            content: '❌ An error occurred while analizy wyników.'
        });
    }
}

async function handlePhase2FinalConfirmButton(interaction, sharedState) {
    const { phaseService, databaseService } = sharedState;

    const session = phaseService.getSessionByUserId(interaction.user.id);

    if (!session || session.userId !== interaction.user.id) {
        await interaction.reply({
            content: '❌ Session wygasła lub nie masz uprawnień.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Stop ghost ping - user clicked button
    stopGhostPing(session);

    if (interaction.customId === 'phase2_cancel_save') {
        // Anuluj zapis i zwolnij kolejkę
        await phaseService.cleanupSession(session.sessionId);
        await phaseService.clearActiveProcessing(interaction.guild.id);

        await interaction.update({
            content: '❌ Cancelled zapis danych.',
            embeds: [],
            components: []
        });
        return;
    }

    await interaction.update({
        content: '💾 Saving results...',
        embeds: [],
        components: []
    });

    try {
        // Results wszystkich rund są już w roundsData (dodane po rozwiązaniu konfliktów)
        logger.info(`[PHASE2] 📊 Sumowanie wyników z ${session.roundsData.length} rund...`);
        const summedResults = phaseService.sumPhase2Results(session);
        const weekInfo = phaseService.getCurrentWeekInfo();

        // Przygotuj dane z każdej rundy
        const roundsData = [];
        for (const roundData of session.roundsData) {
            const roundPlayers = [];
            for (const [nick, score] of roundData.results) {
                const member = interaction.guild.members.cache.find(m =>
                    m.displayName.toLowerCase() === nick.toLowerCase() ||
                    m.user.username.toLowerCase() === nick.toLowerCase()
                );

                if (member) {
                    roundPlayers.push({
                        userId: member.id,
                        displayName: member.displayName,
                        score: score
                    });
                }
            }
            roundsData.push({
                round: roundData.round,
                players: roundPlayers
            });
        }

        // Przygotuj zsumowane wyniki
        const summaryPlayers = [];
        for (const [nick, totalScore] of summedResults) {
            const member = interaction.guild.members.cache.find(m =>
                m.displayName.toLowerCase() === nick.toLowerCase() ||
                m.user.username.toLowerCase() === nick.toLowerCase()
            );

            if (member) {
                summaryPlayers.push({
                    userId: member.id,
                    displayName: member.displayName,
                    score: totalScore
                });
            }
        }

        // Zapisz wszystko do bazy
        await databaseService.savePhase2Results(
            session.guildId,
            weekInfo.weekNumber,
            weekInfo.year,
            session.clan,
            roundsData,
            summaryPlayers,
            interaction.user.id
        );

        const stats = phaseService.calculateStatistics(summedResults);
        const clanName = sharedState.config.roleDisplayNames[session.clan] || session.clan;

        // Oblicz sumę zer z wszystkich 3 rund
        let totalZeroCount = 0;
        for (const roundData of session.roundsData) {
            for (const [nick, score] of roundData.results) {
                if (score === 0) {
                    totalZeroCount++;
                }
            }
        }

        const publicEmbed = new EmbedBuilder()
            .setTitle('✅ Phase 2 - Data Saved Successfully')
            .setDescription(`Results for week **${weekInfo.weekNumber}/${weekInfo.year}** have been saved.`)
            .setColor('#00FF00')
            .addFields(
                { name: '⭕ Score = 0 (suma z 3 rund)', value: `${totalZeroCount} occurrences`, inline: false },
                { name: '🎯 Clan', value: clanName, inline: false }
            )
            .setTimestamp()
            .setFooter({ text: `Zapisane przez ${interaction.user.tag}` });

        await interaction.editReply({ embeds: [publicEmbed], components: [] });
        await phaseService.cleanupSession(session.sessionId);
        logger.info(`[PHASE2] ✅ Data saved for tygodnia ${weekInfo.weekNumber}/${weekInfo.year}`);

    } catch (error) {
        logger.error('[PHASE2] ❌ Error zapisu:', error);
        phaseService.clearActiveProcessing(interaction.guild.id);
        await interaction.editReply({
            content: '❌ An error occurred while zapisywania danych.'
        });
    }
}

async function showPhase2FinalSummary(interaction, session, phaseService) {
    logger.info(`[PHASE2] 📋 Creating final summary...`);

    try {
        logger.info(`[PHASE2] 🔢 Starting results summation...`);
        const summedResults = phaseService.sumPhase2Results(session);

        logger.info(`[PHASE2] 📊 Calculating statistics...`);
        const stats = phaseService.calculateStatistics(summedResults);

        // Oblicz sumę zer z wszystkich 3 rund
        let totalZeroCount = 0;
        for (const roundData of session.roundsData) {
            for (const [nick, score] of roundData.results) {
                if (score === 0) {
                    totalZeroCount++;
                }
            }
        }
        stats.totalZeroCount = totalZeroCount;

        logger.info(`[PHASE2] 📅 Pobieram informacje o tygodniu...`);
        const weekInfo = phaseService.getCurrentWeekInfo();

        logger.info(`[PHASE2] 🎨 Creating summary embed...`);
        const summaryEmbed = phaseService.createFinalSummaryEmbed(stats, weekInfo, session.clan, 2);

        session.stage = 'final_confirmation';

        logger.info(`[PHASE2] 📤 Sending summary do użytkownika...`);
        logger.info(`[PHASE2] 🔍 Stan interakcji - deferred: ${interaction.deferred}, replied: ${interaction.replied}`);

        try {
            // Po update() trzeba użyć followUp() zamiast editReply()
            if (interaction.replied) {
                await interaction.followUp({
                    embeds: [summaryEmbed.embed],
                    components: [summaryEmbed.row]
                });
            } else {
                await interaction.editReply({
                    embeds: [summaryEmbed.embed],
                    components: [summaryEmbed.row]
                });
            }
            logger.info(`[PHASE2] ✅ Podsumowanie sent successfully`);
        } catch (replyError) {
            logger.error(`[PHASE2] ❌ Error while wysyłania odpowiedzi:`, replyError);
            logger.error(`[PHASE2] ❌ Reply error message:`, replyError?.message);
            logger.error(`[PHASE2] ❌ Reply error code:`, replyError?.code);
            throw replyError;
        }
    } catch (error) {
        logger.error(`[PHASE2] ❌ Error w showPhase2FinalSummary:`, error);
        logger.error(`[PHASE2] ❌ Error stack:`, error.stack);
        throw error;
    }
}

async function handlePhase2RoundContinue(interaction, sharedState) {
    const { phaseService } = sharedState;

    const session = phaseService.getSessionByUserId(interaction.user.id);

    if (!session || session.userId !== interaction.user.id) {
        await interaction.reply({
            content: '❌ Session wygasła lub nie masz uprawnień.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Stop ghost ping - user clicked button
    stopGhostPing(session);

    // Sprawdź czy to była ostatnia runda
    if (session.currentRound < 3) {
        // Save current round results and move to next
        phaseService.startNextRound(session);
        const awaitingEmbed = phaseService.createAwaitingImagesEmbed(2, session.currentRound);
        await interaction.update({
            content: '',
            embeds: [awaitingEmbed.embed],
            components: [awaitingEmbed.row]
        });
        logger.info(`[PHASE2] 🔄 Moving to round ${session.currentRound}/3`);
    } else {
        // Zapisz wyniki ostatniej rundy przed pokazaniem podsumowania
        logger.info(`[PHASE2] 💾 Saving results rundy 3 przed summarym...`);
        const lastRoundData = {
            round: session.currentRound,
            results: phaseService.getFinalResults(session)
        };
        logger.info(`[PHASE2] 📊 Results rundy 3: ${lastRoundData.results.size} players`);
        session.roundsData.push(lastRoundData);
        logger.info(`[PHASE2] ✅ Saved wyniki rundy ${session.currentRound}/3. Total ${session.roundsData.length} rund w roundsData`);

        // Show final summary
        await interaction.update({
            content: '✅ All rounds completed! Preparing final summary...',
            embeds: [],
            components: []
        });

        try {
            await showPhase2FinalSummary(interaction, session, phaseService);
        } catch (error) {
            logger.error(`[PHASE2] ❌ Error while wyświetlania podsumowania:`, error);
            throw error;
        }
    }
}

async function showPhase2RoundSummary(interaction, session, phaseService) {
    logger.info(`[PHASE2] 📋 Creating round summary ${session.currentRound}...`);

    // Oblicz statystyki for tej rundy
    const finalResults = phaseService.getFinalResults(session);
    const stats = phaseService.calculateStatistics(finalResults);

    // Prepare players list z paskami postępu
    const players = Array.from(finalResults.entries()).map(([nick, score]) => ({
        displayName: nick,
        score: score,
        userId: null
    }));

    const sortedPlayers = players.sort((a, b) => b.score - a.score);
    const maxScore = sortedPlayers[0]?.score || 1;

    const resultsText = sortedPlayers.map((player, index) => {
        const position = index + 1;
        const barLength = 16;
        const filledLength = player.score > 0 ? Math.max(1, Math.round((player.score / maxScore) * barLength)) : 0;
        const progressBar = player.score > 0 ? '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength) : '░'.repeat(barLength);

        return `${progressBar} ${position}. ${player.displayName} - ${player.score.toLocaleString('pl-PL')}`;
    }).join('\n');

    const weekInfo = phaseService.getCurrentWeekInfo();
    const clanName = phaseService.config.roleDisplayNames[session.clan] || session.clan;

    const embed = new EmbedBuilder()
        .setTitle(`✅ Round ${session.currentRound}/3 - Podsumowanie`)
        .setDescription(`**Clan:** ${clanName}\n**Week:** ${weekInfo.weekNumber}/${weekInfo.year}\n**TOP30:** ${stats.top30Sum.toLocaleString('pl-PL')} pkt\n\n${resultsText}`)
        .setColor('#00FF00')
        .setFooter({ text: `Total players: ${sortedPlayers.length}` })
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('phase2_round_continue')
                .setLabel(session.currentRound < 3 ? '✅ Continue to next round' : '✅ Show final summary')
                .setStyle(ButtonStyle.Success)
        );

    // Użyj odpowiedniej metody w zależności od stanu interakcji
    if (interaction.replied || interaction.deferred) {
        await interaction.editReply({
            embeds: [embed],
            components: [row]
        });
    } else {
        await interaction.update({
            embeds: [embed],
            components: [row]
        });
    }
}

// =============== ADD HANDLERS ===============

async function handleAddWeekSelect(interaction, sharedState) {
    const { config } = sharedState;
    const [prefix, phase, clan] = interaction.customId.split('|');
    const selectedWeek = interaction.values[0];

    // Jeśli Phase 2, pokaż wybór rundy
    if (phase === 'phase2') {
        const roundOptions = [
            new StringSelectMenuOptionBuilder()
                .setLabel('Round 1')
                .setValue('round1')
                .setDescription('Add to round 1'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Round 2')
                .setValue('round2')
                .setDescription('Add to round 2'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Round 3')
                .setValue('round3')
                .setDescription('Add to round 3')
        ];

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`add_select_round|${phase}|${clan}|${selectedWeek}`)
            .setPlaceholder('Select round')
            .addOptions(roundOptions);

        const row = new ActionRowBuilder().addComponents(selectMenu);

        const embed = new EmbedBuilder()
            .setTitle('➕ Dodaj gracza - Phase 2')
            .setDescription(`**Step 2/3:** Select round\n**Week:** ${selectedWeek}\n**Clan:** ${config.roleDisplayNames[clan]}`)
            .setColor('#00FF00')
            .setTimestamp();

        await interaction.update({
            embeds: [embed],
            components: [row]
        });
    } else {
        // Phase 1 - pokaż select menu z użytkownikami z odpowiednią rolą
        await showUserSelectMenu(interaction, sharedState, phase, clan, selectedWeek, 'none');
    }
}

async function handleAddRoundSelect(interaction, sharedState) {
    const [prefix, phase, clan, weekNumber] = interaction.customId.split('|');
    const selectedRound = interaction.values[0];

    // Pokaż select menu z użytkownikami z odpowiednią rolą
    await showUserSelectMenu(interaction, sharedState, phase, clan, weekNumber, selectedRound);
}

async function showUserSelectMenu(interaction, sharedState, phase, clan, weekNumber, round) {
    const { config, databaseService } = sharedState;

    // Get server-specific configuration
    const serverConfig = getServerConfigOrThrow(interaction.guild.id, config);

    // Pobierz role ID for wybranego klanu
    const clanRoleId = serverConfig.targetRoles[clan];

    if (!clanRoleId) {
        await interaction.update({
            content: '❌ Not found roli for tego klanu.',
            embeds: [],
            components: []
        });
        return;
    }

    // Pobierz dane z bazy for tego tygodnia
    const [week, year] = weekNumber.split('-');
    let existingPlayerIds = new Set();

    try {
        if (phase === 'phase1') {
            const weekData = await databaseService.getPhase1Results(
                interaction.guild.id,
                parseInt(week),
                parseInt(year),
                clan
            );
            if (weekData && weekData.players) {
                weekData.players.forEach(p => existingPlayerIds.add(p.userId));
            }
        } else if (phase === 'phase2') {
            const weekData = await databaseService.getPhase2Results(
                interaction.guild.id,
                parseInt(week),
                parseInt(year),
                clan
            );
            if (weekData) {
                if (round === 'summary' && weekData.summary) {
                    weekData.summary.players.forEach(p => existingPlayerIds.add(p.userId));
                } else if (round !== 'summary' && weekData.rounds) {
                    const roundIndex = round === 'round1' ? 0 : round === 'round2' ? 1 : 2;
                    if (weekData.rounds[roundIndex]) {
                        weekData.rounds[roundIndex].players.forEach(p => existingPlayerIds.add(p.userId));
                    }
                }
            }
        }
    } catch (error) {
        logger.error('[ADD] Error pobierania istniejących players:', error);
    }

    // Pobierz wszystkich członków serwera z odpowiednią rolą
    await interaction.guild.members.fetch();
    const membersWithRole = interaction.guild.members.cache.filter(member =>
        member.roles.cache.has(clanRoleId) && !existingPlayerIds.has(member.id)
    );

    if (membersWithRole.size === 0) {
        await interaction.update({
            content: '❌ Not found użytkowników do dodania. Wszyscy członkowie klanu mają już wyniki.',
            embeds: [],
            components: []
        });
        return;
    }

    // Sortuj alfabetycznie po displayName
    const sortedMembers = Array.from(membersWithRole.values())
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
        .slice(0, 25); // Discord limit: max 25 opcji

    // Utwórz opcje select menu
    const userOptions = sortedMembers.map(member =>
        new StringSelectMenuOptionBuilder()
            .setLabel(member.displayName)
            .setValue(member.id)
            .setDescription(`@${member.user.username}`)
    );

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`add_select_user|${phase}|${clan}|${weekNumber}|${round}`)
        .setPlaceholder('Select user')
        .addOptions(userOptions);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    const phaseTitle = phase === 'phase2' ? 'Phase 2' : 'Phase 1';
    const roundText = round !== 'none' && round !== 'summary'
        ? `, ${round === 'round1' ? 'Round 1' : round === 'round2' ? 'Round 2' : 'Round 3'}`
        : round === 'summary' ? ', Podsumowanie' : '';
    const stepNumber = phase === 'phase2' ? '3/3' : '2/2';

    const embed = new EmbedBuilder()
        .setTitle(`➕ Dodaj gracza - ${phaseTitle}${roundText}`)
        .setDescription(`**Step ${stepNumber}:** Select user\n**Week:** ${weekNumber}\n**Clan:** ${config.roleDisplayNames[clan]}\n\nAvailable users: **${sortedMembers.length}**`)
        .setColor('#00FF00')
        .setTimestamp();

    await interaction.update({
        embeds: [embed],
        components: [row]
    });
}

async function handleAddUserSelect(interaction, sharedState) {
    const [prefix, phase, clan, weekNumber, round] = interaction.customId.split('|');
    const selectedUserId = interaction.values[0];

    // Pobierz wybranego użytkownika
    const selectedMember = await interaction.guild.members.fetch(selectedUserId);

    if (!selectedMember) {
        await interaction.update({
            content: '❌ Not found wybranego użytkownika.',
            embeds: [],
            components: []
        });
        return;
    }

    // Pokaż modal tylko z polem na wynik
    const modal = new ModalBuilder()
        .setCustomId(`add_modal|${phase}|${clan}|${weekNumber}|${round}|${selectedUserId}`)
        .setTitle(`Dodaj wynik for ${selectedMember.displayName}`);

    const scoreInput = new TextInputBuilder()
        .setCustomId('score')
        .setLabel('Score')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Wpisz wynik (liczba)')
        .setRequired(true);

    const row = new ActionRowBuilder().addComponents(scoreInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
}

async function handleAddCommand(interaction, sharedState) {
    const { config, databaseService } = sharedState;

    // Get server-specific configuration
    const serverConfig = getServerConfigOrThrow(interaction.guild.id, config);

    // Check permissions (admin or allowedPunishRoles)
    const isAdmin = interaction.member.permissions.has('Administrator');
    const hasPunishRole = hasPermission(interaction.member, serverConfig.allowedPunishRoles);

    if (!isAdmin && !hasPunishRole) {
        await interaction.reply({
            content: '❌ You don\'t have permission to use this command. Required: **Administrator** or moderator role.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Detect user clan
    const targetRoleIds = Object.entries(serverConfig.targetRoles);
    let userClan = null;

    for (const [clanKey, roleId] of targetRoleIds) {
        if (interaction.member.roles.cache.has(roleId)) {
            userClan = clanKey;
            break;
        }
    }

    if (!userClan) {
        await interaction.reply({
            content: '❌ Your clan was not detected. Musisz mieć jedną z ról klanowych aby dodawać wyniki.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const selectedPhase = interaction.options.getString('phase');

    try {
        const clanName = config.roleDisplayNames[userClan];

        // Pobierz dostępne tygodnie for tego klanu
        const availableWeeks = await databaseService.getAvailableWeeks(interaction.guild.id);
        const weeksForClan = availableWeeks.filter(week => week.clans.includes(userClan));

        if (weeksForClan.length === 0) {
            await interaction.reply({
                content: `❌ Brak zapisanych wyników for clan ${clanName}. Najpierw użyj \`/phase1\` lub \`/phase2\` aby dodać wyniki.`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // Twórz select menu z tygodniami
        const weekOptions = weeksForClan.slice(0, 25).map(week => {
            return new StringSelectMenuOptionBuilder()
                .setLabel(`Week ${week.weekNumber}/${week.year}`)
                .setValue(`${week.weekNumber}-${week.year}`)
                .setDescription(`${week.clans.map(c => config.roleDisplayNames[c]).join(', ')}`);
        });

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`add_select_week|${selectedPhase}|${userClan}`)
            .setPlaceholder('Select week')
            .addOptions(weekOptions);

        const row = new ActionRowBuilder().addComponents(selectMenu);

        const phaseTitle = selectedPhase === 'phase2' ? 'Phase 2' : 'Phase 1';
        const totalSteps = selectedPhase === 'phase2' ? '3' : '2';
        const embed = new EmbedBuilder()
            .setTitle(`➕ Dodaj gracza - ${phaseTitle}`)
            .setDescription(`**Step 1/${totalSteps}:** Select week\n**Clan:** ${clanName}`)
            .setColor('#00FF00')
            .setTimestamp();

        await interaction.reply({
            embeds: [embed],
            components: [row],
            flags: MessageFlags.Ephemeral
        });

    } catch (error) {
        logger.error('[ADD] ❌ Error command /add:', error);
        await interaction.reply({
            content: '❌ An error occurred while initializing command.',
            flags: MessageFlags.Ephemeral
        });
    }
}

async function handleAddModalSubmit(interaction, sharedState) {
    const { config, databaseService } = sharedState;
    const customIdParts = interaction.customId.split('|');
    const [prefix, phase, clan, weekNumber, round, userId] = customIdParts;

    const scoreInput = interaction.fields.getTextInputValue('score');
    const scoreNum = parseInt(scoreInput);

    if (isNaN(scoreNum)) {
        await interaction.reply({
            content: '❌ Score musi być liczbą.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        // Pobierz informacje o użytkowniku
        const member = await interaction.guild.members.fetch(userId);
        const displayName = member.displayName;

        const [week, year] = weekNumber.split('-');

        if (phase === 'phase1') {
            // Dodaj gracza do Fazy 1
            const weekData = await databaseService.getPhase1Results(
                interaction.guild.id,
                parseInt(week),
                parseInt(year),
                clan
            );

            if (!weekData) {
                await interaction.editReply({
                    content: '❌ Not found danych for tego tygodnia.'
                });
                return;
            }

            // Zapisz nowego gracza
            await databaseService.savePhase1Result(
                interaction.guild.id,
                userId, // userId
                displayName, // displayName
                scoreNum, // score
                parseInt(week),
                parseInt(year),
                clan,
                null // createdBy - nie nadpisujemy oryginalnego autora
            );

            // Odśwież dane i przelicz TOP30
            const updatedData = await databaseService.getPhase1Results(
                interaction.guild.id,
                parseInt(week),
                parseInt(year),
                clan
            );

            const sortedPlayers = [...updatedData.players].sort((a, b) => b.score - a.score);
            const top30 = sortedPlayers.slice(0, 30);
            const top30Sum = top30.reduce((sum, p) => sum + p.score, 0);

            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle('✅ Player dodany - Phase 1')
                    .setDescription(`Added gracza **${displayName}** z wynikiem **${scoreNum}**`)
                    .addFields(
                        { name: 'Week', value: `${week}/${year}`, inline: true },
                        { name: 'Clan', value: config.roleDisplayNames[clan], inline: true },
                        { name: 'TOP30 (suma)', value: top30Sum.toString(), inline: true }
                    )
                    .setColor('#00FF00')
                    .setTimestamp()
                ]
            });

        } else if (phase === 'phase2') {
            // Dodaj gracza do Fazy 2
            const weekData = await databaseService.getPhase2Results(
                interaction.guild.id,
                parseInt(week),
                parseInt(year),
                clan
            );

            if (!weekData) {
                await interaction.editReply({
                    content: '❌ Not found danych for tego tygodnia.'
                });
                return;
            }

            if (round === 'summary') {
                // Dodaj do podsumowania
                weekData.summary.players.push({
                    userId: userId,
                    displayName: displayName,
                    score: scoreNum
                });
            } else {
                // Dodaj do konkretnej rundy
                const roundIndex = round === 'round1' ? 0 : round === 'round2' ? 1 : 2;

                weekData.rounds[roundIndex].players.push({
                    userId: userId,
                    displayName: displayName,
                    score: scoreNum
                });

                // Przelicz sumę wyników for this player we wszystkich rundach
                let totalScore = 0;
                for (const r of weekData.rounds) {
                    const playerInRound = r.players.find(p => p.userId === userId);
                    if (playerInRound) {
                        totalScore += playerInRound.score;
                    }
                }

                // Update summary
                const playerInSummary = weekData.summary.players.find(p => p.userId === userId);
                if (playerInSummary) {
                    playerInSummary.score = totalScore;
                } else {
                    weekData.summary.players.push({
                        userId: userId,
                        displayName: displayName,
                        score: totalScore
                    });
                }
            }

            // Zapisz dane (zachowaj oryginalnego autora)
            await databaseService.savePhase2Results(
                interaction.guild.id,
                parseInt(week),
                parseInt(year),
                clan,
                weekData.rounds,
                weekData.summary.players,
                weekData.createdBy || interaction.user.id
            );

            const roundName = round === 'summary' ? 'Podsumowanie' :
                              round === 'round1' ? 'Round 1' :
                              round === 'round2' ? 'Round 2' : 'Round 3';

            // Policz sumę for podsumowania
            const summarySum = weekData.summary.players.reduce((sum, p) => sum + p.score, 0);

            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle('✅ Player dodany - Phase 2')
                    .setDescription(`Added gracza **${displayName}** z wynikiem **${scoreNum}**`)
                    .addFields(
                        { name: 'Week', value: `${week}/${year}`, inline: true },
                        { name: 'Clan', value: config.roleDisplayNames[clan], inline: true },
                        { name: 'Round', value: roundName, inline: true },
                        { name: 'Total (summary)', value: summarySum.toString(), inline: false }
                    )
                    .setColor('#00FF00')
                    .setTimestamp()
                ]
            });
        }

    } catch (error) {
        logger.error('[ADD] ❌ Error adding player:', error);
        await interaction.editReply({
            content: '❌ An error occurred while adding player.'
        });
    }
}

// =============== MODIFY HANDLERS ===============

async function handleModifyCommand(interaction, sharedState) {
    const { config, databaseService } = sharedState;

    // Get server-specific configuration
    const serverConfig = getServerConfigOrThrow(interaction.guild.id, config);

    // Check permissions (admin or allowedPunishRoles)
    const isAdmin = interaction.member.permissions.has('Administrator');
    const hasPunishRole = hasPermission(interaction.member, serverConfig.allowedPunishRoles);

    if (!isAdmin && !hasPunishRole) {
        await interaction.reply({
            content: '❌ You don\'t have permission to use this command. Required: **Administrator** or moderator role.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Detect user clan
    const targetRoleIds = Object.entries(serverConfig.targetRoles);
    let userClan = null;

    for (const [clanKey, roleId] of targetRoleIds) {
        if (interaction.member.roles.cache.has(roleId)) {
            userClan = clanKey;
            break;
        }
    }

    if (!userClan) {
        await interaction.reply({
            content: '❌ Your clan was not detected. Musisz mieć jedną z ról klanowych aby modyfikować wyniki.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const selectedPhase = interaction.options.getString('phase');

    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Skip clan selection and go directly to selecting week
        await showModifyWeekSelection(interaction, databaseService, config, userClan, selectedPhase, null, 0);

    } catch (error) {
        logger.error('[MODIFY] ❌ Error command /modify:', error);
        await interaction.editReply({
            content: '❌ An error occurred while starting command.',
            flags: MessageFlags.Ephemeral
        });
    }
}

async function showModifyWeekSelection(interaction, databaseService, config, userClan, selectedPhase, selectedRound = null, page = 0) {
    const clanName = config.roleDisplayNames[userClan];

    // Pobierz dostępne tygodnie for wybranego klanu i fazy
    let allWeeks;
    if (selectedPhase === 'phase2') {
        allWeeks = await databaseService.getAvailableWeeksPhase2(interaction.guild.id);
    } else {
        allWeeks = await databaseService.getAvailableWeeks(interaction.guild.id);
    }

    const weeksForClan = allWeeks.filter(week => week.clans.includes(userClan));

    if (weeksForClan.length === 0) {
        await interaction.editReply({
            content: `❌ Brak zapisanych wyników for clan **${clanName}**.`,
            components: []
        });
        return;
    }

    // Paginacja tygodni
    const weeksPerPage = 20;
    const totalPages = Math.ceil(weeksForClan.length / weeksPerPage);
    const currentPage = Math.max(0, Math.min(page, totalPages - 1));
    const startIndex = currentPage * weeksPerPage;
    const endIndex = startIndex + weeksPerPage;
    const weeksOnPage = weeksForClan.slice(startIndex, endIndex);

    // Utwórz select menu z tygodniami
    const customIdSuffix = selectedRound ? `${selectedPhase}|${selectedRound}` : selectedPhase;
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`modify_select_week_${customIdSuffix}`)
        .setPlaceholder('Select week')
        .addOptions(
            weeksOnPage.map(week => {
                const date = new Date(week.createdAt);
                const dateStr = date.toLocaleDateString('pl-PL', {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric'
                });

                return new StringSelectMenuOptionBuilder()
                    .setLabel(`Week ${week.weekNumber}/${week.year}`)
                    .setDescription(`Saved: ${dateStr}`)
                    .setValue(`${userClan}|${week.weekNumber}-${week.year}`);
            })
        );

    const components = [new ActionRowBuilder().addComponents(selectMenu)];

    // Dodaj przyciski paginacji if there are more than 1 page
    if (totalPages > 1) {
        const paginationRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`modify_week_prev|${customIdSuffix}|${userClan}|${currentPage}`)
                    .setLabel('◀ Previous')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(currentPage === 0),
                new ButtonBuilder()
                    .setCustomId(`modify_week_info|${customIdSuffix}|${userClan}|${currentPage}`)
                    .setLabel(`Page ${currentPage + 1}/${totalPages}`)
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId(`modify_week_next|${customIdSuffix}|${userClan}|${currentPage}`)
                    .setLabel('Next ▶')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(currentPage === totalPages - 1)
            );
        components.push(paginationRow);
    }

    const phaseTitle = selectedPhase === 'phase2' ? 'Phase 2' : 'Phase 1';
    const roundText = selectedRound ? ` - ${selectedRound === 'round1' ? 'Round 1' : selectedRound === 'round2' ? 'Round 2' : selectedRound === 'round3' ? 'Round 3' : 'Total'}` : '';
    const stepNumber = selectedPhase === 'phase2' ? (selectedRound ? '3/3' : '1/3') : '1/2';

    const embed = new EmbedBuilder()
        .setTitle(`🔧 Modyfikacja wyniku - ${phaseTitle}${roundText}`)
        .setDescription(`**Step ${stepNumber}:** Select week\n**Clan:** ${clanName}\n\nWeeks: ${weeksForClan.length}${totalPages > 1 ? ` | Page ${currentPage + 1}/${totalPages}` : ''}`)
        .setColor('#FF9900')
        .setTimestamp();

    await interaction.editReply({
        embeds: [embed],
        components: components
    });
}

async function handleModifyClanSelect(interaction, sharedState) {
    const { databaseService, config } = sharedState;

    await interaction.deferUpdate();

    try {
        // Format: modify_select_clan|phase1 lub modify_select_clan|phase2
        const parts = interaction.customId.split('|');
        const selectedPhase = parts[1];
        const selectedClan = interaction.values[0];

        // Step 2: Pokaż wybór tygodnia
        await showModifyWeekSelection(interaction, databaseService, config, selectedClan, selectedPhase, null, 0);

    } catch (error) {
        logger.error('[MODIFY] ❌ Error selecting clan:', error);
        await interaction.editReply({
            content: '❌ An error occurred while selecting clan.',
            components: []
        });
    }
}

async function handleModifyRoundSelect(interaction, sharedState) {
    const { databaseService, config } = sharedState;

    await interaction.deferUpdate();

    try {
        // Format: modify_select_round|clan|weekNumber-year|phase
        const parts = interaction.customId.split('|');
        const clan = parts[1];
        const weekKey = parts[2];
        const selectedPhase = parts[3];
        const selectedRound = interaction.values[0];

        const [weekNumber, year] = weekKey.split('-').map(Number);
        const clanName = config.roleDisplayNames[clan];

        // Pobierz wyniki for wybranego tygodnia
        const weekData = await databaseService.getPhase2Results(interaction.guild.id, weekNumber, year, clan);

        if (!weekData) {
            await interaction.editReply({
                content: `❌ Brak danych for wybranego tygodnia i klanu **${clanName}**.`,
                components: []
            });
            return;
        }

        // Wybierz players z odpowiedniej rundy
        let players;
        if (selectedRound === 'round1' && weekData.rounds && weekData.rounds[0]) {
            players = weekData.rounds[0].players;
        } else if (selectedRound === 'round2' && weekData.rounds && weekData.rounds[1]) {
            players = weekData.rounds[1].players;
        } else if (selectedRound === 'round3' && weekData.rounds && weekData.rounds[2]) {
            players = weekData.rounds[2].players;
        } else {
            await interaction.editReply({
                content: `❌ Brak danych for wybranej rundy.`,
                components: []
            });
            return;
        }

        if (!players || players.length === 0) {
            await interaction.editReply({
                content: `❌ Brak players for wybranej rundy.`,
                components: []
            });
            return;
        }

        // Sortuj players alfabetycznie
        const sortedPlayers = [...players].sort((a, b) => a.displayName.localeCompare(b.displayName));

        // Paginacja
        const playersPerPage = 20;
        const totalPages = Math.ceil(sortedPlayers.length / playersPerPage);
        const currentPage = 0;
        const startIndex = 0;
        const endIndex = playersPerPage;
        const playersOnPage = sortedPlayers.slice(startIndex, endIndex);

        // Utwórz select menu z graczami
        const customIdSuffix = `${selectedPhase}|${selectedRound}`;
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`modify_select_player_${customIdSuffix}`)
            .setPlaceholder('Select player')
            .addOptions(
                playersOnPage.map(player => {
                    return new StringSelectMenuOptionBuilder()
                        .setLabel(`${player.displayName} - ${player.score} pkt`)
                        .setValue(`${clan}|${weekNumber}-${year}|${player.userId}`);
                })
            );

        const components = [new ActionRowBuilder().addComponents(selectMenu)];

        // Dodaj przyciski paginacji if there are more than 1 page
        if (totalPages > 1) {
            const paginationRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`modify_page_prev|${clan}|${weekNumber}-${year}|${currentPage}|${customIdSuffix}`)
                        .setLabel('◀ Previous')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId(`modify_page_info|${clan}|${weekNumber}-${year}|${currentPage}|${customIdSuffix}`)
                        .setLabel(`Page 1/${totalPages}`)
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId(`modify_page_next|${clan}|${weekNumber}-${year}|${currentPage}|${customIdSuffix}`)
                        .setLabel('Next ▶')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(totalPages === 1)
                );
            components.push(paginationRow);
        }

        const roundText = selectedRound === 'round1' ? 'Round 1' : selectedRound === 'round2' ? 'Round 2' : 'Round 3';
        const embed = new EmbedBuilder()
            .setTitle(`🔧 Modyfikacja wyniku - Phase 2 - ${roundText}`)
            .setDescription(`**Step 4/4:** Select player do modyfikacji\n**Clan:** ${clanName}\n**Week:** ${weekNumber}/${year}\n\nPlayers: ${sortedPlayers.length}${totalPages > 1 ? ` | Page 1/${totalPages}` : ''}`)
            .setColor('#FF9900')
            .setTimestamp();

        await interaction.editReply({
            embeds: [embed],
            components: components
        });

    } catch (error) {
        logger.error('[MODIFY] ❌ Error selecting round:', error);
        await interaction.editReply({
            content: '❌ An error occurred while selecting round.',
            components: []
        });
    }
}

async function handleModifyWeekSelect(interaction, sharedState, page = 0) {
    const { databaseService, config } = sharedState;

    await interaction.deferUpdate();

    try {
        // Parsuj customId: modify_select_week_phase1 lub modify_select_week_phase2
        const customIdParts = interaction.customId.replace('modify_select_week_', '').split('|');
        const selectedPhase = customIdParts[0]; // phase1 lub phase2

        const selectedValue = interaction.values[0];
        const [clan, weekKey] = selectedValue.split('|');
        const [weekNumber, year] = weekKey.split('-').map(Number);

        const clanName = config.roleDisplayNames[clan];

        // Dla Fazy 2 - pokaż wybór rundy
        if (selectedPhase === 'phase2') {
            const roundOptions = [
                new StringSelectMenuOptionBuilder()
                    .setLabel('Round 1')
                    .setValue('round1'),
                new StringSelectMenuOptionBuilder()
                    .setLabel('Round 2')
                    .setValue('round2'),
                new StringSelectMenuOptionBuilder()
                    .setLabel('Round 3')
                    .setValue('round3')
            ];

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`modify_select_round|${clan}|${weekNumber}-${year}|${selectedPhase}`)
                .setPlaceholder('Select round')
                .addOptions(roundOptions);

            const row = new ActionRowBuilder().addComponents(selectMenu);

            const embed = new EmbedBuilder()
                .setTitle('🔧 Modyfikacja wyniku - Phase 2')
                .setDescription(`**Step 3/4:** Select round\n**Clan:** ${clanName}\n**Week:** ${weekNumber}/${year}`)
                .setColor('#FF9900')
                .setTimestamp();

            await interaction.editReply({
                embeds: [embed],
                components: [row]
            });
            return;
        }

        // Dla Fazy 1 - pokaż wybór gracza
        const weekData = await databaseService.getPhase1Results(interaction.guild.id, weekNumber, year, clan);

        if (!weekData || !weekData.players) {
            await interaction.editReply({
                content: `❌ Brak danych for wybranego tygodnia i klanu **${clanName}**.`,
                components: []
            });
            return;
        }

        const players = weekData.players;

        if (!players || players.length === 0) {
            await interaction.editReply({
                content: `❌ Brak players for wybranego tygodnia.`,
                components: []
            });
            return;
        }

        // Sortuj players alfabetycznie
        const sortedPlayers = [...players].sort((a, b) => a.displayName.localeCompare(b.displayName));

        // Paginacja
        const playersPerPage = 20;
        const totalPages = Math.ceil(sortedPlayers.length / playersPerPage);
        const currentPage = Math.max(0, Math.min(page, totalPages - 1));
        const startIndex = currentPage * playersPerPage;
        const endIndex = startIndex + playersPerPage;
        const playersOnPage = sortedPlayers.slice(startIndex, endIndex);

        // Utwórz select menu z graczami
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`modify_select_player_${selectedPhase}`)
            .setPlaceholder('Select player')
            .addOptions(
                playersOnPage.map(player => {
                    return new StringSelectMenuOptionBuilder()
                        .setLabel(`${player.displayName} - ${player.score} pkt`)
                        .setValue(`${clan}|${weekNumber}-${year}|${player.userId}`);
                })
            );

        const components = [new ActionRowBuilder().addComponents(selectMenu)];

        // Dodaj przyciski paginacji if there are more than 1 page
        if (totalPages > 1) {
            const paginationRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`modify_page_prev|${clan}|${weekNumber}-${year}|${currentPage}|${selectedPhase}`)
                        .setLabel('◀ Previous')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(currentPage === 0),
                    new ButtonBuilder()
                        .setCustomId(`modify_page_info|${clan}|${weekNumber}-${year}|${currentPage}|${selectedPhase}`)
                        .setLabel(`Page ${currentPage + 1}/${totalPages}`)
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId(`modify_page_next|${clan}|${weekNumber}-${year}|${currentPage}|${selectedPhase}`)
                        .setLabel('Next ▶')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(currentPage === totalPages - 1)
                );
            components.push(paginationRow);
        }

        const phaseTitle = selectedPhase === 'phase2' ? 'Phase 2' : 'Phase 1';
        const stepNumber = '3/3';

        const embed = new EmbedBuilder()
            .setTitle(`🔧 Modyfikacja wyniku - ${phaseTitle}`)
            .setDescription(`**Step ${stepNumber}:** Select player do modyfikacji\n**Clan:** ${clanName}\n**Week:** ${weekNumber}/${year}\n\nPlayers: ${sortedPlayers.length}${totalPages > 1 ? ` | Page ${currentPage + 1}/${totalPages}` : ''}`)
            .setColor('#FF9900')
            .setTimestamp();

        await interaction.editReply({
            embeds: [embed],
            components: components
        });

    } catch (error) {
        logger.error('[MODIFY] ❌ Error selecting week:', error);
        await interaction.editReply({
            content: '❌ An error occurred while selecting week.',
            components: []
        });
    }
}

async function handleModifyPlayerSelect(interaction, sharedState) {
    const { databaseService, config } = sharedState;

    try {
        // Parsuj customId: modify_select_player_phase1 lub modify_select_player_phase2|round1
        const customIdParts = interaction.customId.replace('modify_select_player_', '').split('|');
        const selectedPhase = customIdParts[0];
        const selectedRound = customIdParts[1] || null;

        const selectedValue = interaction.values[0];
        const [clan, weekKey, userId] = selectedValue.split('|');
        const [weekNumber, year] = weekKey.split('-').map(Number);

        logger.info(`[MODIFY] Wybrano gracza: phase=${selectedPhase}, round=${selectedRound}, clan=${clan}, week=${weekNumber}/${year}, userId=${userId}`);

        // Pobierz dane gracza
        let weekData;
        let player;

        if (selectedPhase === 'phase2') {
            weekData = await databaseService.getPhase2Results(interaction.guild.id, weekNumber, year, clan);

            if (!weekData) {
                logger.error(`[MODIFY] Brak weekData for Phase2: guild=${interaction.guild.id}, week=${weekNumber}, year=${year}, clan=${clan}`);
                await interaction.reply({
                    content: '❌ Not found danych for wybranego tygodnia.',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            // Znajdź gracza w odpowiedniej rundzie (tylko round1, round2, round3)
            logger.info(`[MODIFY] weekData structure: rounds=${weekData.rounds ? 'exists' : 'null'}, roundsLength=${weekData.rounds?.length}`);

            if (selectedRound === 'round1' && weekData.rounds && weekData.rounds[0]) {
                logger.info(`[MODIFY] Szukam w round1, players count: ${weekData.rounds[0].players?.length}`);
                player = weekData.rounds[0].players.find(p => p.userId === userId);
                logger.info(`[MODIFY] Znaleziono gracza w round1: ${player ? 'TAK' : 'NIE'}`);
            } else if (selectedRound === 'round2' && weekData.rounds && weekData.rounds[1]) {
                logger.info(`[MODIFY] Szukam w round2, players count: ${weekData.rounds[1].players?.length}`);
                player = weekData.rounds[1].players.find(p => p.userId === userId);
            } else if (selectedRound === 'round3' && weekData.rounds && weekData.rounds[2]) {
                logger.info(`[MODIFY] Szukam w round3, players count: ${weekData.rounds[2].players?.length}`);
                player = weekData.rounds[2].players.find(p => p.userId === userId);
            } else {
                logger.error(`[MODIFY] Nie można znaleźć rundy: selectedRound=${selectedRound}, weekData.rounds[0]=${weekData.rounds?.[0] ? 'exists' : 'null'}`);
            }
        } else {
            weekData = await databaseService.getPhase1Results(interaction.guild.id, weekNumber, year, clan);

            if (!weekData || !weekData.players) {
                logger.error(`[MODIFY] Brak weekData for Phase1: guild=${interaction.guild.id}, week=${weekNumber}, year=${year}, clan=${clan}, weekData=${weekData}`);
                await interaction.reply({
                    content: '❌ Not found danych for wybranego tygodnia.',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            player = weekData.players.find(p => p.userId === userId);
        }

        if (!player) {
            logger.error(`[MODIFY] Not found gracza: userId=${userId}, phase=${selectedPhase}, round=${selectedRound}, clan=${clan}, week=${weekNumber}/${year}`);
            await interaction.reply({
                content: '❌ Not found gracza.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // Pokaż modal do wprowadzenia nowego wyniku
        const customIdSuffix = selectedRound ? `${selectedPhase}|${selectedRound}` : selectedPhase;
        const modal = new ModalBuilder()
            .setCustomId(`modify_modal_${customIdSuffix}|${clan}|${weekNumber}-${year}|${userId}`)
            .setTitle('Modify player result');

        const scoreInput = new TextInputBuilder()
            .setCustomId('new_score')
            .setLabel(`Nowy wynik for ${player.displayName}`)
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(`Aktualny wynik: ${player.score}`)
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(6);

        const row = new ActionRowBuilder().addComponents(scoreInput);
        modal.addComponents(row);

        await interaction.showModal(modal);

    } catch (error) {
        logger.error('[MODIFY] ❌ Error selecting player:', error);
        await interaction.reply({
            content: '❌ An error occurred while selecting player.',
            flags: MessageFlags.Ephemeral
        });
    }
}

async function handleModifyPaginationButton(interaction, sharedState) {
    const { databaseService, config } = sharedState;

    await interaction.deferUpdate();

    try {
        const parts = interaction.customId.split('|');
        const action = parts[0]; // modify_page_prev lub modify_page_next
        const clan = parts[1];
        const weekKey = parts[2];
        const currentPage = parseInt(parts[3]);
        const selectedPhase = parts[4] || 'phase1'; // phase1 lub phase2
        const selectedRound = parts[5] || null; // round1, round2, round3 lub null

        const [weekNumber, year] = weekKey.split('-').map(Number);

        // Oblicz nową stronę
        let newPage = currentPage;
        if (action === 'modify_page_prev') {
            newPage = Math.max(0, currentPage - 1);
        } else if (action === 'modify_page_next') {
            newPage = currentPage + 1;
        }

        const clanName = config.roleDisplayNames[clan];

        // Pobierz wyniki for wybranego tygodnia i klanu
        let weekData;
        let players;

        if (selectedPhase === 'phase2') {
            weekData = await databaseService.getPhase2Results(interaction.guild.id, weekNumber, year, clan);

            if (!weekData) {
                logger.error(`[MODIFY] Brak weekData for Phase2: guild=${interaction.guild.id}, week=${weekNumber}, year=${year}, clan=${clan}`);
                await interaction.editReply({
                    content: `❌ Brak danych for wybranego tygodnia i klanu **${clanName}**.`,
                    embeds: [],
                    components: []
                });
                return;
            }

            // Wybierz players z odpowiedniej rundy (tylko round1, round2, round3)
            if (selectedRound === 'round1' && weekData.rounds && weekData.rounds[0]) {
                players = weekData.rounds[0].players;
            } else if (selectedRound === 'round2' && weekData.rounds && weekData.rounds[1]) {
                players = weekData.rounds[1].players;
            } else if (selectedRound === 'round3' && weekData.rounds && weekData.rounds[2]) {
                players = weekData.rounds[2].players;
            }
        } else {
            weekData = await databaseService.getPhase1Results(interaction.guild.id, weekNumber, year, clan);

            if (!weekData) {
                logger.error(`[MODIFY] Brak weekData for Phase1: guild=${interaction.guild.id}, week=${weekNumber}, year=${year}, clan=${clan}`);
                await interaction.editReply({
                    content: `❌ Brak danych for wybranego tygodnia i klanu **${clanName}**.`,
                    embeds: [],
                    components: []
                });
                return;
            }

            players = weekData.players;
        }

        if (!players || players.length === 0) {
            logger.error(`[MODIFY] Brak players for: guild=${interaction.guild.id}, week=${weekNumber}, year=${year}, clan=${clan}, phase=${selectedPhase}, round=${selectedRound}`);
            await interaction.editReply({
                content: `❌ Brak players for wybranego tygodnia i klanu **${clanName}**.`,
                embeds: [],
                components: []
            });
            return;
        }

        // Sortuj players alfabetycznie
        const sortedPlayers = [...players].sort((a, b) => a.displayName.localeCompare(b.displayName));

        // Paginacja
        const playersPerPage = 20;
        const totalPages = Math.ceil(sortedPlayers.length / playersPerPage);
        const validPage = Math.max(0, Math.min(newPage, totalPages - 1));
        const startIndex = validPage * playersPerPage;
        const endIndex = startIndex + playersPerPage;
        const playersOnPage = sortedPlayers.slice(startIndex, endIndex);

        // Utwórz select menu z graczami na aktualnej stronie
        const customIdSuffix = selectedRound ? `${selectedPhase}|${selectedRound}` : selectedPhase;
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`modify_select_player_${customIdSuffix}`)
            .setPlaceholder('Select player')
            .addOptions(
                playersOnPage.map(player => {
                    return new StringSelectMenuOptionBuilder()
                        .setLabel(`${player.displayName} - ${player.score} pkt`)
                        .setValue(`${clan}|${weekNumber}-${year}|${player.userId}`);
                })
            );

        const components = [new ActionRowBuilder().addComponents(selectMenu)];

        // Dodaj przyciski paginacji
        const paginationCustomId = selectedRound
            ? `|${selectedPhase}|${selectedRound}`
            : `|${selectedPhase}`;

        const paginationRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`modify_page_prev|${clan}|${weekNumber}-${year}|${validPage}${paginationCustomId}`)
                    .setLabel('◀ Previous')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(validPage === 0),
                new ButtonBuilder()
                    .setCustomId(`modify_page_info|${clan}|${weekNumber}-${year}|${validPage}${paginationCustomId}`)
                    .setLabel(`Page ${validPage + 1}/${totalPages}`)
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId(`modify_page_next|${clan}|${weekNumber}-${year}|${validPage}${paginationCustomId}`)
                    .setLabel('Next ▶')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(validPage === totalPages - 1)
            );
        components.push(paginationRow);

        const phaseTitle = selectedPhase === 'phase2' ? 'Phase 2' : 'Phase 1';
        const roundText = selectedRound ? ` - ${selectedRound === 'round1' ? 'Round 1' : selectedRound === 'round2' ? 'Round 2' : selectedRound === 'round3' ? 'Round 3' : 'Total'}` : '';
        const stepNumber = selectedPhase === 'phase2' ? (selectedRound ? '4/4' : '?/4') : '3/3';

        const embed = new EmbedBuilder()
            .setTitle(`🔧 Modyfikacja wyniku - ${phaseTitle}${roundText}`)
            .setDescription(`**Step ${stepNumber}:** Select player do modyfikacji\n**Clan:** ${clanName}\n**Week:** ${weekNumber}/${year}\n\nPlayers: ${sortedPlayers.length} | Page ${validPage + 1}/${totalPages}`)
            .setColor('#FF9900')
            .setTimestamp();

        await interaction.editReply({
            embeds: [embed],
            components: components
        });

    } catch (error) {
        logger.error('[MODIFY] ❌ Error paginacji:', error);
        logger.error('[MODIFY] ❌ Error stack:', error.stack);
        logger.error('[MODIFY] ❌ customId:', interaction.customId);

        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({
                    content: '❌ An error occurred while changing page.',
                    embeds: [],
                    components: []
                });
            } else {
                await interaction.update({
                    content: '❌ An error occurred while changing page.',
                    embeds: [],
                    components: []
                });
            }
        } catch (replyError) {
            logger.error('[MODIFY] ❌ Error while odpowiedzi na błąd:', replyError);
        }
    }
}

async function handleModifyWeekPaginationButton(interaction, sharedState) {
    const { databaseService, config } = sharedState;

    try {
        const parts = interaction.customId.split('|');
        const action = parts[0]; // modify_week_prev lub modify_week_next
        const clan = parts[1];
        const currentPage = parseInt(parts[2]);

        // Oblicz nową stronę
        let newPage = currentPage;
        if (action === 'modify_week_prev') {
            newPage = Math.max(0, currentPage - 1);
        } else if (action === 'modify_week_next') {
            newPage = currentPage + 1;
        }

        const clanName = config.roleDisplayNames[clan];

        // Pobierz dostępne tygodnie for wybranego klanu
        const allWeeks = await databaseService.getAvailableWeeks(interaction.guild.id);
        const weeksForClan = allWeeks.filter(week => week.clans.includes(clan));

        if (weeksForClan.length === 0) {
            await interaction.update({
                content: `❌ Brak zapisanych wyników for clan **${clanName}**.`,
                embeds: [],
                components: []
            });
            return;
        }

        // Paginacja tygodni
        const weeksPerPage = 20;
        const totalPages = Math.ceil(weeksForClan.length / weeksPerPage);
        const validPage = Math.max(0, Math.min(newPage, totalPages - 1));
        const startIndex = validPage * weeksPerPage;
        const endIndex = startIndex + weeksPerPage;
        const weeksOnPage = weeksForClan.slice(startIndex, endIndex);

        // Utwórz select menu z tygodniami na aktualnej stronie
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('modify_select_week')
            .setPlaceholder('Select week')
            .addOptions(
                weeksOnPage.map(week => {
                    const date = new Date(week.createdAt);
                    const dateStr = date.toLocaleDateString('pl-PL', {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric'
                    });

                    return new StringSelectMenuOptionBuilder()
                        .setLabel(`Week ${week.weekNumber}/${week.year}`)
                        .setDescription(`Saved: ${dateStr}`)
                        .setValue(`${clan}|${week.weekNumber}-${week.year}`);
                })
            );

        const components = [new ActionRowBuilder().addComponents(selectMenu)];

        // Dodaj przyciski paginacji
        const paginationRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`modify_week_prev|${clan}|${validPage}`)
                    .setLabel('◀ Previous')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(validPage === 0),
                new ButtonBuilder()
                    .setCustomId(`modify_week_info|${clan}|${validPage}`)
                    .setLabel(`Page ${validPage + 1}/${totalPages}`)
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId(`modify_week_next|${clan}|${validPage}`)
                    .setLabel('Next ▶')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(validPage === totalPages - 1)
            );
        components.push(paginationRow);

        const embed = new EmbedBuilder()
            .setTitle('🔧 Modyfikacja wyniku - Phase 1')
            .setDescription(`**Step 2/4:** Select week for clan **${clanName}**\n\nWeeks: ${weeksForClan.length} | Page ${validPage + 1}/${totalPages}`)
            .setColor('#FF9900')
            .setTimestamp();

        await interaction.update({
            embeds: [embed],
            components: components
        });

    } catch (error) {
        logger.error('[MODIFY] ❌ Error paginacji tygodni:', error);
        await interaction.update({
            content: '❌ An error occurred while changing page.',
            embeds: [],
            components: []
        });
    }
}

async function handleModifyModalSubmit(interaction, sharedState) {
    const { databaseService, config } = sharedState;

    try {
        // Parsuj customId: modify_modal_phase1|clan|week|userId lub modify_modal_phase2|round1|clan|week|userId
        const customIdParts = interaction.customId.replace('modify_modal_', '').split('|');

        let selectedPhase, selectedRound, clan, weekKey, userId;

        logger.info(`[MODIFY] Modal customId parts: ${JSON.stringify(customIdParts)}`);

        if (customIdParts[0] === 'phase2') {
            selectedPhase = customIdParts[0];
            selectedRound = customIdParts[1];
            clan = customIdParts[2];
            weekKey = customIdParts[3];
            userId = customIdParts[4];
        } else {
            selectedPhase = customIdParts[0];
            selectedRound = null;
            clan = customIdParts[1];
            weekKey = customIdParts[2];
            userId = customIdParts[3];
        }

        logger.info(`[MODIFY] Modal parsed: phase=${selectedPhase}, round=${selectedRound}, clan=${clan}, week=${weekKey}, userId=${userId}`);

        const [weekNumber, year] = weekKey.split('-').map(Number);
        const newScore = interaction.fields.getTextInputValue('new_score');

        // Walidacja nowego wyniku
        if (!/^\d+$/.test(newScore)) {
            await interaction.reply({
                content: '❌ Score musi być liczbą całkowitą.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const newScoreNum = parseInt(newScore);

        // Pobierz dane gracza
        let weekData;
        let player;

        if (selectedPhase === 'phase2') {
            weekData = await databaseService.getPhase2Results(interaction.guild.id, weekNumber, year, clan);

            // Znajdź gracza w odpowiedniej rundzie (tylko round1, round2, round3)
            if (selectedRound === 'round1' && weekData.rounds && weekData.rounds[0]) {
                player = weekData.rounds[0].players.find(p => p.userId === userId);
            } else if (selectedRound === 'round2' && weekData.rounds && weekData.rounds[1]) {
                player = weekData.rounds[1].players.find(p => p.userId === userId);
            } else if (selectedRound === 'round3' && weekData.rounds && weekData.rounds[2]) {
                player = weekData.rounds[2].players.find(p => p.userId === userId);
            }
        } else {
            weekData = await databaseService.getPhase1Results(interaction.guild.id, weekNumber, year, clan);
            player = weekData.players.find(p => p.userId === userId);
        }

        if (!player) {
            await interaction.reply({
                content: '❌ Not found gracza.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const clanName = config.roleDisplayNames[clan];
        const phaseTitle = selectedPhase === 'phase2' ? 'Phase 2' : 'Phase 1';
        const roundText = selectedRound ? ` - ${selectedRound === 'round1' ? 'Round 1' : selectedRound === 'round2' ? 'Round 2' : selectedRound === 'round3' ? 'Round 3' : 'Total'}` : '';

        // Pokaż potwierdzenie
        const embed = new EmbedBuilder()
            .setTitle(`⚠️ Confirmation zmiany wyniku - ${phaseTitle}${roundText}`)
            .setDescription(`Czy na pewno chcesz zmienić wynik for **${player.displayName}**?`)
            .setColor('#FF9900')
            .addFields(
                { name: '🎯 Clan', value: clanName, inline: true },
                { name: '📅 Week', value: `${weekNumber}/${year}`, inline: true },
                { name: '📊 Stary wynik', value: player.score.toString(), inline: true },
                { name: '📈 Nowy wynik', value: newScoreNum.toString(), inline: true }
            )
            .setTimestamp();

        const customIdSuffix = selectedRound ? `${selectedPhase}|${selectedRound}` : selectedPhase;
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`modify_confirm_${customIdSuffix}|${clan}|${weekNumber}-${year}|${userId}|${newScoreNum}`)
                    .setLabel('🟢 Zamień')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('modify_cancel')
                    .setLabel('🔴 Anuluj')
                    .setStyle(ButtonStyle.Danger)
            );

        await interaction.reply({
            embeds: [embed],
            components: [row],
            flags: MessageFlags.Ephemeral
        });

    } catch (error) {
        logger.error('[MODIFY] ❌ Error modala:', error);
        await interaction.reply({
            content: '❌ An error occurred while przetwarzania formularza.',
            flags: MessageFlags.Ephemeral
        });
    }
}

async function handleModifyConfirmButton(interaction, sharedState) {
    const { databaseService, config } = sharedState;

    if (interaction.customId === 'modify_cancel') {
        await interaction.update({
            content: '❌ Operation cancelled.',
            embeds: [],
            components: []
        });
        return;
    }

    try {
        // Parsuj customId: modify_confirm_phase1|clan|week|userId|score lub modify_confirm_phase2|round1|clan|week|userId|score
        const customIdParts = interaction.customId.replace('modify_confirm_', '').split('|');

        let selectedPhase, selectedRound, clan, weekKey, userId, newScore;

        logger.info(`[MODIFY] Confirm customId parts: ${JSON.stringify(customIdParts)}`);

        if (customIdParts[0] === 'phase2') {
            selectedPhase = customIdParts[0];
            selectedRound = customIdParts[1];
            clan = customIdParts[2];
            weekKey = customIdParts[3];
            userId = customIdParts[4];
            newScore = customIdParts[5];
        } else {
            selectedPhase = customIdParts[0];
            selectedRound = null;
            clan = customIdParts[1];
            weekKey = customIdParts[2];
            userId = customIdParts[3];
            newScore = customIdParts[4];
        }

        logger.info(`[MODIFY] Confirm parsed: phase=${selectedPhase}, round=${selectedRound}, clan=${clan}, week=${weekKey}, userId=${userId}, newScore=${newScore}`);

        const [weekNumber, year] = weekKey.split('-').map(Number);
        const newScoreNum = parseInt(newScore);

        // Pobierz dane gracza przed zmianą
        let weekData;
        let player;

        if (selectedPhase === 'phase2') {
            weekData = await databaseService.getPhase2Results(interaction.guild.id, weekNumber, year, clan);

            // Znajdź gracza w odpowiedniej rundzie (tylko round1, round2, round3)
            if (selectedRound === 'round1' && weekData.rounds && weekData.rounds[0]) {
                player = weekData.rounds[0].players.find(p => p.userId === userId);
            } else if (selectedRound === 'round2' && weekData.rounds && weekData.rounds[1]) {
                player = weekData.rounds[1].players.find(p => p.userId === userId);
            } else if (selectedRound === 'round3' && weekData.rounds && weekData.rounds[2]) {
                player = weekData.rounds[2].players.find(p => p.userId === userId);
            }
        } else {
            weekData = await databaseService.getPhase1Results(interaction.guild.id, weekNumber, year, clan);
            player = weekData.players.find(p => p.userId === userId);
        }

        if (!player) {
            await interaction.update({
                content: '❌ Not found gracza.',
                embeds: [],
                components: []
            });
            return;
        }

        const oldScore = player.score;

        // Update wynik
        if (selectedPhase === 'phase2') {
            // Aktualizuj wynik w odpowiedniej rundzie (tylko round1, round2, round3)
            if (selectedRound === 'round1') {
                weekData.rounds[0].players = weekData.rounds[0].players.map(p =>
                    p.userId === userId ? { ...p, score: newScoreNum } : p
                );
            } else if (selectedRound === 'round2') {
                weekData.rounds[1].players = weekData.rounds[1].players.map(p =>
                    p.userId === userId ? { ...p, score: newScoreNum } : p
                );
            } else if (selectedRound === 'round3') {
                weekData.rounds[2].players = weekData.rounds[2].players.map(p =>
                    p.userId === userId ? { ...p, score: newScoreNum } : p
                );
            }

            // Przelicz sumę wyników for wszystkich players
            const summedScores = new Map(); // userId -> total score
            for (const round of weekData.rounds) {
                for (const p of round.players) {
                    const current = summedScores.get(p.userId) || 0;
                    summedScores.set(p.userId, current + p.score);
                }
            }

            // Update summary.players z nowymi sumami
            weekData.summary.players = weekData.summary.players.map(p => ({
                ...p,
                score: summedScores.get(p.userId) || 0
            }));

            logger.info(`[MODIFY] Zaktualizowano sumę for gracza ${userId}: ${summedScores.get(userId)}`);

            // Zapisz zaktualizowane dane (zachowaj oryginalnego creatora)
            await databaseService.savePhase2Results(
                interaction.guild.id,
                weekNumber,
                year,
                clan,
                weekData.rounds,
                weekData.summary.players,
                weekData.createdBy || interaction.user.id
            );
        } else {
            await databaseService.savePhase1Result(
                interaction.guild.id,
                userId,
                player.displayName,
                newScoreNum,
                weekNumber,
                year,
                clan
            );
        }

        const clanName = config.roleDisplayNames[clan];
        const phaseTitle = selectedPhase === 'phase2' ? 'Phase 2' : 'Phase 1';
        const roundText = selectedRound ? ` - ${selectedRound === 'round1' ? 'Round 1' : selectedRound === 'round2' ? 'Round 2' : selectedRound === 'round3' ? 'Round 3' : 'Total'}` : '';

        // Confirmation
        const embed = new EmbedBuilder()
            .setTitle(`✅ Score został zmieniony - ${phaseTitle}${roundText}`)
            .setDescription(`Pomyślnie zmieniono wynik for **${player.displayName}**`)
            .setColor('#00FF00')
            .addFields(
                { name: '🎯 Clan', value: clanName, inline: true },
                { name: '📅 Week', value: `${weekNumber}/${year}`, inline: true },
                { name: '📊 Stary wynik', value: oldScore.toString(), inline: true },
                { name: '📈 Nowy wynik', value: newScoreNum.toString(), inline: true }
            )
            .setTimestamp()
            .setFooter({ text: `Zmodyfikowane przez ${interaction.user.tag}` });

        await interaction.update({
            embeds: [embed],
            components: []
        });

        logger.info(`[MODIFY] ✅ Zmieniono wynik ${player.displayName}: ${oldScore} → ${newScoreNum} (Clan: ${clan}, Week: ${weekNumber}/${year})`);

    } catch (error) {
        logger.error('[MODIFY] ❌ Error potwierdzenia:', error);
        await interaction.update({
            content: '❌ An error occurred while zapisywania zmiany.',
            embeds: [],
            components: []
        });
    }
}

// =============== RESULTS HANDLERS ===============

async function handleResultsClanSelect(interaction, sharedState, page = 0) {
    const { databaseService, config } = sharedState;

    await interaction.deferUpdate();

    try {
        const selectedClan = interaction.values[0];
        const clanName = config.roleDisplayNames[selectedClan];

        // Pobierz dostępne tygodnie for wybranego klanu z obu faz
        const allWeeksPhase1 = await databaseService.getAvailableWeeks(interaction.guild.id);
        const allWeeksPhase2 = await databaseService.getAvailableWeeksPhase2(interaction.guild.id);

        const weeksForClanPhase1 = allWeeksPhase1.filter(week => week.clans.includes(selectedClan));
        const weeksForClanPhase2 = allWeeksPhase2.filter(week => week.clans.includes(selectedClan));

        // Połącz tygodnie z obu faz i posortuj po numerze tygodnia (malejąco)
        const combinedWeeks = [];

        // Znajdź wszystkie unikalne tygodnie
        const uniqueWeeks = new Map();

        for (const week of weeksForClanPhase1) {
            const key = `${week.weekNumber}-${week.year}`;
            if (!uniqueWeeks.has(key)) {
                uniqueWeeks.set(key, {
                    weekNumber: week.weekNumber,
                    year: week.year,
                    hasPhase1: true,
                    hasPhase2: false,
                    createdAt: week.createdAt
                });
            } else {
                uniqueWeeks.get(key).hasPhase1 = true;
            }
        }

        for (const week of weeksForClanPhase2) {
            const key = `${week.weekNumber}-${week.year}`;
            if (!uniqueWeeks.has(key)) {
                uniqueWeeks.set(key, {
                    weekNumber: week.weekNumber,
                    year: week.year,
                    hasPhase1: false,
                    hasPhase2: true,
                    createdAt: week.createdAt
                });
            } else {
                uniqueWeeks.get(key).hasPhase2 = true;
            }
        }

        const weeksForClan = Array.from(uniqueWeeks.values()).sort((a, b) => {
            if (a.year !== b.year) return b.year - a.year;
            return b.weekNumber - a.weekNumber;
        });

        if (weeksForClan.length === 0) {
            await interaction.editReply({
                content: `📊 Brak zapisanych wyników for clan **${clanName}**.\n\nUżyj \`/phase1\` lub \`/phase2\` aby rozpocząć zbieranie danych.`,
                components: []
            });
            return;
        }

        // Paginacja: 20 tygodni na stronę
        const weeksPerPage = 20;
        const totalPages = Math.ceil(weeksForClan.length / weeksPerPage);
        const startIndex = page * weeksPerPage;
        const endIndex = Math.min(startIndex + weeksPerPage, weeksForClan.length);
        const weeksOnPage = weeksForClan.slice(startIndex, endIndex);

        // Utwórz select menu z tygodniami
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('results_select_week')
            .setPlaceholder('Select week')
            .addOptions(
                weeksOnPage.map(week => {
                    const date = new Date(week.createdAt);
                    const dateStr = date.toLocaleDateString('pl-PL', {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric'
                    });

                    const phases = [];
                    if (week.hasPhase1) phases.push('F1');
                    if (week.hasPhase2) phases.push('F2');
                    const phasesLabel = phases.join(', ');

                    return new StringSelectMenuOptionBuilder()
                        .setLabel(`Week ${week.weekNumber}/${week.year} (${phasesLabel})`)
                        .setDescription(`Saved: ${dateStr}`)
                        .setValue(`${selectedClan}|${week.weekNumber}-${week.year}`);
                })
            );

        const components = [new ActionRowBuilder().addComponents(selectMenu)];

        // Dodaj przyciski nawigacji jeśli jest więcej niż jedna strona
        if (totalPages > 1) {
            const navRow = new ActionRowBuilder();

            const prevButton = new ButtonBuilder()
                .setCustomId(`results_weeks_prev|${selectedClan}|${page}`)
                .setLabel('◀ Previous')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 0);

            const nextButton = new ButtonBuilder()
                .setCustomId(`results_weeks_next|${selectedClan}|${page}`)
                .setLabel('Next ▶')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page >= totalPages - 1);

            navRow.addComponents(prevButton, nextButton);
            components.push(navRow);
        }

        const embed = new EmbedBuilder()
            .setTitle('📊 Results - All Phases')
            .setDescription(`**Step 2/2:** Select week for clan **${clanName}**:`)
            .setColor('#0099FF')
            .setFooter({ text: `Page ${page + 1}/${totalPages} | Total tygodni: ${weeksForClan.length}` })
            .setTimestamp();

        await interaction.editReply({
            embeds: [embed],
            components: components
        });

    } catch (error) {
        logger.error('[RESULTS] ❌ Error selecting clan:', error);
        await interaction.editReply({
            content: '❌ An error occurred while selecting clan.',
            components: []
        });
    }
}

async function handleResultsWeekPaginationButton(interaction, sharedState) {
    const { databaseService, config } = sharedState;

    try {
        // Format customId: results_weeks_prev|clanKey|page lub results_weeks_next|clanKey|page
        const customIdParts = interaction.customId.split('|');
        const action = customIdParts[0]; // np. "results_weeks_prev"
        const clan = customIdParts[1];
        const currentPage = parseInt(customIdParts[2]);

        // Oblicz nową stronę
        let newPage = currentPage;
        if (action === 'results_weeks_prev') {
            newPage = Math.max(0, currentPage - 1);
        } else if (action === 'results_weeks_next') {
            newPage = currentPage + 1;
        }

        // Wywołaj ponownie handleResultsClanSelect z nową stroną
        // Musimy przygotować mock interaction z values
        const mockInteraction = {
            ...interaction,
            values: [clan],
            deferUpdate: async () => {} // Mock - już jest deferred
        };

        await handleResultsClanSelect(mockInteraction, sharedState, newPage);

    } catch (error) {
        logger.error('[RESULTS] ❌ Error paginacji tygodni:', error);
        await interaction.update({
            content: '❌ An error occurred while changing page.',
            embeds: [],
            components: []
        });
    }
}

async function handleResultsWeekSelect(interaction, sharedState, view = 'phase1') {
    const { databaseService, config } = sharedState;

    await interaction.deferUpdate();

    try {
        const selectedValue = interaction.values[0]; // Format: "clanKey|weekNumber-year"
        const [clan, weekKey] = selectedValue.split('|');
        const [weekNumber, year] = weekKey.split('-').map(Number);

        const clanName = config.roleDisplayNames[clan];

        // Pobierz dane z obu faz
        const weekDataPhase1 = await databaseService.getPhase1Results(interaction.guild.id, weekNumber, year, clan);
        const weekDataPhase2 = await databaseService.getPhase2Results(interaction.guild.id, weekNumber, year, clan);

        if (!weekDataPhase1 && !weekDataPhase2) {
            await interaction.editReply({
                content: `❌ Brak danych for wybranego tygodnia i klanu **${clanName}**.`,
                components: []
            });
            return;
        }

        // Wyświetl wyniki w zależności od wybranego widoku (domyślnie Phase 1)
        // useFollowUp = true for publicznej wiadomości
        await showCombinedResults(interaction, weekDataPhase1, weekDataPhase2, clan, weekNumber, year, view, config, false, true);

    } catch (error) {
        logger.error('[RESULTS] ❌ Error wyświetlania wyników:', error);
        await interaction.editReply({
            content: '❌ An error occurred while wyświetlania wyników.',
            components: []
        });
    }
}

async function handleResultsViewButton(interaction, sharedState) {
    const { databaseService, config } = sharedState;

    try {
        // Format: results_view|clanKey|weekNumber-year|view
        const parts = interaction.customId.split('|');
        const clan = parts[1];
        const weekKey = parts[2];
        const view = parts[3];

        const [weekNumber, year] = weekKey.split('-').map(Number);

        // Pobierz dane z obu faz
        const weekDataPhase1 = await databaseService.getPhase1Results(interaction.guild.id, weekNumber, year, clan);
        const weekDataPhase2 = await databaseService.getPhase2Results(interaction.guild.id, weekNumber, year, clan);

        if (!weekDataPhase1 && !weekDataPhase2) {
            await interaction.update({
                content: '❌ Brak danych.',
                embeds: [],
                components: []
            });
            return;
        }

        await showCombinedResults(interaction, weekDataPhase1, weekDataPhase2, clan, weekNumber, year, view, config, true);

    } catch (error) {
        logger.error('[RESULTS] ❌ Error przełączania widoku:', error);
        await interaction.update({
            content: '❌ An error occurred while przełączania widoku.',
            embeds: [],
            components: []
        });
    }
}

async function handleResultsPhase2ViewButton(interaction, sharedState) {
    const { databaseService, config } = sharedState;

    try {
        // Format: results_phase2_view|clanKey|weekNumber-year|view
        const parts = interaction.customId.split('|');
        const clan = parts[1];
        const weekKey = parts[2];
        const view = parts[3];

        const [weekNumber, year] = weekKey.split('-').map(Number);

        const weekData = await databaseService.getPhase2Results(interaction.guild.id, weekNumber, year, clan);

        if (!weekData) {
            await interaction.update({
                content: '❌ Brak danych.',
                embeds: [],
                components: []
            });
            return;
        }

        await showPhase2Results(interaction, weekData, clan, weekNumber, year, view, config, true);

    } catch (error) {
        logger.error('[RESULTS] ❌ Error przełączania widoku Phase 2:', error);
        await interaction.update({
            content: '❌ An error occurred while przełączania widoku.',
            embeds: [],
            components: []
        });
    }
}

async function showPhase2Results(interaction, weekData, clan, weekNumber, year, view, config, isUpdate = false) {
    const clanName = config.roleDisplayNames[clan];

    // Wybierz dane do wyświetlenia w zależności od widoku
    let players;
    let viewTitle;

    if (view === 'round1' && weekData.rounds && weekData.rounds[0]) {
        players = weekData.rounds[0].players;
        viewTitle = 'Round 1';
    } else if (view === 'round2' && weekData.rounds && weekData.rounds[1]) {
        players = weekData.rounds[1].players;
        viewTitle = 'Round 2';
    } else if (view === 'round3' && weekData.rounds && weekData.rounds[2]) {
        players = weekData.rounds[2].players;
        viewTitle = 'Round 3';
    } else {
        // Domyślnie pokaż sumę
        players = weekData.summary ? weekData.summary.players : weekData.players;
        viewTitle = 'Total';
    }

    if (!players || players.length === 0) {
        const replyMethod = isUpdate ? 'update' : 'editReply';
        await interaction[replyMethod]({
            content: `❌ Brak danych for wybranego widoku.`,
            embeds: [],
            components: []
        });
        return;
    }

    const sortedPlayers = [...players].sort((a, b) => b.score - a.score);
    const maxScore = sortedPlayers[0]?.score || 1;

    // Oblicz TOP30 for rund 1, 2, 3 oraz sumy
    let top30Text = '';
    if (view === 'round1' || view === 'round2' || view === 'round3') {
        const top30Players = sortedPlayers.slice(0, 30);
        const top30Sum = top30Players.reduce((sum, player) => sum + player.score, 0);
        top30Text = `**TOP30:** ${top30Sum.toLocaleString('pl-PL')} pkt\n`;
    } else if (view === 'summary') {
        // Dla sumy: oblicz TOP30 z każdej rundy osobno i zsumuj
        let totalTop30Sum = 0;

        if (weekData.rounds && weekData.rounds.length === 3) {
            for (let i = 0; i < 3; i++) {
                if (weekData.rounds[i] && weekData.rounds[i].players) {
                    const roundPlayers = [...weekData.rounds[i].players].sort((a, b) => b.score - a.score);
                    const roundTop30 = roundPlayers.slice(0, 30);
                    const roundTop30Sum = roundTop30.reduce((sum, player) => sum + player.score, 0);
                    totalTop30Sum += roundTop30Sum;
                }
            }
            top30Text = `**TOP30:** ${totalTop30Sum.toLocaleString('pl-PL')} pkt (suma TOP30 z 3 rund)\n`;
        }
    }

    const resultsText = sortedPlayers.map((player, index) => {
        const position = index + 1;
        const barLength = 16;
        const filledLength = player.score > 0 ? Math.max(1, Math.round((player.score / maxScore) * barLength)) : 0;
        const progressBar = player.score > 0 ? '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength) : '░'.repeat(barLength);

        const isCaller = player.userId === interaction.user.id;
        const displayName = isCaller ? `**${player.displayName}**` : player.displayName;

        return `${progressBar} ${position}. ${displayName} - ${player.score}`;
    }).join('\n');

    const embed = new EmbedBuilder()
        .setTitle(`📊 Results - Phase 2 - ${viewTitle}`)
        .setDescription(`**Clan:** ${clanName}\n**Week:** ${weekNumber}/${year}\n${top30Text}\n${resultsText}`)
        .setColor('#0099FF')
        .setFooter({ text: `Total players: ${sortedPlayers.length} | Saved: ${new Date(weekData.createdAt).toLocaleDateString('pl-PL')}` })
        .setTimestamp();

    // Przyciski nawigacji między rundami
    const navRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`results_phase2_view|${clan}|${weekNumber}-${year}|round1`)
                .setLabel('Round 1')
                .setStyle(view === 'round1' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`results_phase2_view|${clan}|${weekNumber}-${year}|round2`)
                .setLabel('Round 2')
                .setStyle(view === 'round2' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`results_phase2_view|${clan}|${weekNumber}-${year}|round3`)
                .setLabel('Round 3')
                .setStyle(view === 'round3' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`results_phase2_view|${clan}|${weekNumber}-${year}|summary`)
                .setLabel('Total')
                .setStyle(view === 'summary' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        );

    const replyMethod = isUpdate ? 'update' : 'editReply';
    await interaction[replyMethod]({
        embeds: [embed],
        components: [navRow]
    });
}

async function showCombinedResults(interaction, weekDataPhase1, weekDataPhase2, clan, weekNumber, year, view, config, isUpdate = false, useFollowUp = false) {
    const clanName = config.roleDisplayNames[clan];

    // Wybierz dane do wyświetlenia w zależności od widoku
    let players;
    let viewTitle;
    let weekData;

    if (view === 'phase1' && weekDataPhase1) {
        players = weekDataPhase1.players;
        viewTitle = 'Phase 1';
        weekData = weekDataPhase1;
    } else if (view === 'round1' && weekDataPhase2?.rounds?.[0]) {
        players = weekDataPhase2.rounds[0].players;
        viewTitle = 'Round 1';
        weekData = weekDataPhase2;
    } else if (view === 'round2' && weekDataPhase2?.rounds?.[1]) {
        players = weekDataPhase2.rounds[1].players;
        viewTitle = 'Round 2';
        weekData = weekDataPhase2;
    } else if (view === 'round3' && weekDataPhase2?.rounds?.[2]) {
        players = weekDataPhase2.rounds[2].players;
        viewTitle = 'Round 3';
        weekData = weekDataPhase2;
    } else if (view === 'summary' && weekDataPhase2) {
        players = weekDataPhase2.summary ? weekDataPhase2.summary.players : weekDataPhase2.players;
        viewTitle = 'Total';
        weekData = weekDataPhase2;
    } else {
        // Fallback - pokaż pierwszą dostępną fazę
        if (weekDataPhase1) {
            players = weekDataPhase1.players;
            viewTitle = 'Phase 1';
            weekData = weekDataPhase1;
            view = 'phase1';
        } else if (weekDataPhase2) {
            players = weekDataPhase2.summary ? weekDataPhase2.summary.players : weekDataPhase2.players;
            viewTitle = 'Total';
            weekData = weekDataPhase2;
            view = 'summary';
        }
    }

    if (!players || players.length === 0) {
        const replyMethod = isUpdate ? 'update' : 'editReply';
        await interaction[replyMethod]({
            content: `❌ Brak danych for wybranego widoku.`,
            embeds: [],
            components: []
        });
        return;
    }

    const sortedPlayers = [...players].sort((a, b) => b.score - a.score);
    const maxScore = sortedPlayers[0]?.score || 1;

    // Oblicz TOP30 for Fazy 1 oraz rund 1, 2, 3 i sumy Fazy 2 - pobierz historyczne rekordy
    let descriptionExtra = '';
    let playerHistoricalRecords = new Map(); // userId -> bestScore

    if (view === 'phase1' || view === 'round1' || view === 'round2' || view === 'round3' || view === 'summary') {
        let top30Sum = 0;

        // Dla "Total Phase 2" - oblicz sumę TOP30 z każdej rundy osobno
        if (view === 'summary' && weekDataPhase2?.rounds) {
            for (let i = 0; i < 3; i++) {
                if (weekDataPhase2.rounds[i] && weekDataPhase2.rounds[i].players) {
                    const roundPlayers = [...weekDataPhase2.rounds[i].players].sort((a, b) => b.score - a.score);
                    const roundTop30 = roundPlayers.slice(0, 30);
                    const roundTop30Sum = roundTop30.reduce((sum, player) => sum + player.score, 0);
                    top30Sum += roundTop30Sum;
                }
            }
        } else {
            // Dla pozostałych widoków - standardowe TOP30
            const top30Players = sortedPlayers.slice(0, 30);
            top30Sum = top30Players.reduce((sum, player) => sum + player.score, 0);
        }

        // Pobierz TOP30 z poprzedniego tygodnia (tylko for Fazy 1)
        const { databaseService } = interaction.client;
        let top30ProgressText = '';

        if (view === 'phase1' && databaseService) {
            try {
                // Znajdź poprzedni tydzień
                const availableWeeks = await databaseService.getAvailableWeeks(interaction.guild.id);
                const weeksForClan = availableWeeks
                    .filter(w => w.clans.includes(clan))
                    .sort((a, b) => {
                        if (a.year !== b.year) return b.year - a.year;
                        return b.weekNumber - a.weekNumber;
                    });

                // Znajdź poprzedni tydzień przed aktualnym
                const currentWeekIndex = weeksForClan.findIndex(w =>
                    w.weekNumber === weekNumber && w.year === year
                );

                if (currentWeekIndex !== -1 && currentWeekIndex < weeksForClan.length - 1) {
                    const previousWeek = weeksForClan[currentWeekIndex + 1];
                    const previousWeekData = await databaseService.getPhase1Results(
                        interaction.guild.id,
                        previousWeek.weekNumber,
                        previousWeek.year,
                        clan
                    );

                    if (previousWeekData && previousWeekData.players) {
                        const previousTop30 = [...previousWeekData.players]
                            .sort((a, b) => b.score - a.score)
                            .slice(0, 30);
                        const previousTop30Sum = previousTop30.reduce((sum, p) => sum + p.score, 0);
                        const top30Difference = top30Sum - previousTop30Sum;

                        if (top30Difference > 0) {
                            top30ProgressText = `\n**Progres:** +${top30Difference.toLocaleString('pl-PL')} pkt`;
                        } else if (top30Difference < 0) {
                            top30ProgressText = `\n**Regres:** ${top30Difference.toLocaleString('pl-PL')} pkt`;
                        }
                    }
                }
            } catch (error) {
                logger.error('[RESULTS] Error pobierania TOP30 z poprzedniego tygodnia:', error);
            }
        }

        // Dodaj informację o sposobie liczenia for widoku "Total"
        const summaryNote = view === 'summary' ? ' (suma TOP30 z 3 rund)' : '';
        descriptionExtra = `**TOP30:** ${top30Sum.toLocaleString('pl-PL')} pkt${summaryNote}${top30ProgressText}\n`;

        // Pobierz historyczne rekordy for wszystkich players (tylko for Fazy 1)
        if (view === 'phase1' && databaseService) {
            for (const player of sortedPlayers) {
                if (player.userId) {
                    const historicalBest = await databaseService.getPlayerHistoricalBestScore(
                        interaction.guild.id,
                        player.userId,
                        weekNumber,
                        year,
                        clan
                    );
                    if (historicalBest !== null) {
                        playerHistoricalRecords.set(player.userId, historicalBest);
                    }
                }
            }
        }
    }

    // Przechowuj informacje o progresie for każdego gracza (do TOP3)
    const playerProgressData = [];

    const resultsText = sortedPlayers.map((player, index) => {
        const position = index + 1;
        const barLength = 16;
        const filledLength = player.score > 0 ? Math.max(1, Math.round((player.score / maxScore) * barLength)) : 0;
        const progressBar = player.score > 0 ? '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength) : '░'.repeat(barLength);

        const isCaller = player.userId === interaction.user.id;
        const displayName = isCaller ? `**${player.displayName}**` : player.displayName;

        // Dla Fazy 1 dodaj progres względem historycznego rekordu
        let progressText = '';
        let difference = 0;
        if (view === 'phase1' && player.userId && playerHistoricalRecords.has(player.userId)) {
            const historicalBest = playerHistoricalRecords.get(player.userId);
            difference = player.score - historicalBest;

            // Pokazuj strzałki tylko jeśli historyczny rekord > 0
            if (difference > 0 && historicalBest > 0) {
                // Nowy rekord - użyj indeksu górnego (superscript) z trójkątem
                const superscriptMap = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
                const superscriptNumber = ('' + difference).split('').map(c => superscriptMap[c] || c).join('');
                progressText = ` ▲${superscriptNumber}`;
            } else if (difference < 0 && player.score > 0) {
                // Poniżej rekordu - użyj indeksu dolnego (subscript) z trójkątem - tylko jeśli wynik > 0
                const subscriptMap = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉' };
                const subscriptNumber = ('' + Math.abs(difference)).split('').map(c => subscriptMap[c] || c).join('');
                progressText = ` ▼${subscriptNumber}`;
            }

            // Zapisz dane do TOP3 tylko jeśli historyczny rekord > 0
            if (historicalBest > 0) {
                playerProgressData.push({
                    displayName: player.displayName,
                    difference: difference,
                    userId: player.userId,
                    score: player.score
                });
            }
        }

        return `${progressBar} ${position}. ${displayName} - ${player.score}${progressText}`;
    }).join('\n');

    // Dla Fazy 1: oblicz TOP3 progresów i regresów
    let top3Section = '';
    if (view === 'phase1' && playerProgressData.length > 0) {
        // TOP3 najlepsze progresy (największe dodatnie wartości)
        const topProgress = [...playerProgressData]
            .filter(p => p.difference > 0)
            .sort((a, b) => b.difference - a.difference)
            .slice(0, 3);

        // TOP3 największe regresy (największe ujemne wartości) - wykluczamy osoby z wynikiem 0
        const topRegress = [...playerProgressData]
            .filter(p => p.difference < 0 && p.score > 0)
            .sort((a, b) => a.difference - b.difference)
            .slice(0, 3);

        if (topProgress.length > 0 || topRegress.length > 0) {
            top3Section = '\n\n';

            // Oblicz sumę wszystkich progresów i regresów
            const totalProgressSum = playerProgressData
                .filter(p => p.difference > 0)
                .reduce((sum, p) => sum + p.difference, 0);

            const totalRegressSum = playerProgressData
                .filter(p => p.difference < 0 && p.score > 0)
                .reduce((sum, p) => sum + Math.abs(p.difference), 0);

            if (topProgress.length > 0) {
                top3Section += '**🏆 TOP3 Progres:**\n';
                topProgress.forEach((p, idx) => {
                    const isCaller = p.userId === interaction.user.id;
                    const displayName = isCaller ? `**${p.displayName}**` : p.displayName;
                    const emoji = isCaller ? ' <a:PepeOklaski:1259556219312410760>' : '';
                    top3Section += `${idx + 1}. ${displayName} (+${p.difference})${emoji}\n`;
                });

                if (totalProgressSum > 0) {
                    top3Section += `**Total progresu:** +${totalProgressSum.toLocaleString('pl-PL')} pkt\n`;
                }
            }

            if (topRegress.length > 0) {
                if (topProgress.length > 0) top3Section += '\n';
                top3Section += '**💀 TOP3 Regres:**\n';
                topRegress.forEach((p, idx) => {
                    const isCaller = p.userId === interaction.user.id;
                    const displayName = isCaller ? `**${p.displayName}**` : p.displayName;
                    const emoji = isCaller ? ' <:PFrogLaczek:1425166409461268510>' : '';
                    top3Section += `${idx + 1}. ${displayName} (${p.difference})${emoji}\n`;
                });

                if (totalRegressSum > 0) {
                    top3Section += `**Total regresu:** -${totalRegressSum.toLocaleString('pl-PL')} pkt\n`;
                }
            }
        }
    }

    // Kanały, na których wiadomości z /results nie będą automatycznie usuwane
    const permanentChannels = [
        '1185510890930458705',
        '1200055492458856458',
        '1200414388327292938',
        '1262792522497921084'
    ];

    // Specjalne wątki (bez auto-usuwania)
    const permanentThreads = [
        '1346401063858606092'  // Wątek w specjalnym kanale
    ];

    // Sprawdź czy to specjalny kanał lub wątek w specjalnym kanale
    const currentChannelId = interaction.channelId;
    const parentChannelId = interaction.channel?.parentId || interaction.channel?.parent?.id;
    const isPermanentChannel = permanentChannels.includes(currentChannelId) ||
                               (parentChannelId && permanentChannels.includes(parentChannelId)) ||
                               permanentThreads.includes(currentChannelId);

    // Oblicz timestamp usunięcia (15 minut od teraz - zawsze resetuj przy każdym kliknięciu)
    const messageCleanupService = interaction.client.messageCleanupService;
    const shouldAutoDelete = !isPermanentChannel;
    const deleteAt = shouldAutoDelete ? Date.now() + (15 * 60 * 1000) : null;
    const deleteTimestamp = deleteAt ? Math.floor(deleteAt / 1000) : null;

    // Opis z informacją o wygaśnięciu - NIE pokazuj na specjalnych kanałach/wątkach
    const expiryInfo = (shouldAutoDelete && deleteTimestamp) ? `\n\n⏱️ Wygasa: <t:${deleteTimestamp}:R>` : '';

    const embed = new EmbedBuilder()
        .setTitle(`📊 Results - ${viewTitle}`)
        .setDescription(`**Clan:** ${clanName}\n**Week:** ${weekNumber}/${year}\n${descriptionExtra}\n${resultsText}${top3Section}${expiryInfo}`)
        .setColor('#0099FF')
        .setFooter({ text: `Total players: ${sortedPlayers.length} | Saved: ${new Date(weekData.createdAt).toLocaleDateString('pl-PL')}` })
        .setTimestamp();

    // Przyciski nawigacji między fazami
    const navRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`results_view|${clan}|${weekNumber}-${year}|phase1`)
                .setLabel('Phase 1')
                .setStyle(view === 'phase1' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(!weekDataPhase1),
            new ButtonBuilder()
                .setCustomId(`results_view|${clan}|${weekNumber}-${year}|round1`)
                .setLabel('Round 1')
                .setStyle(view === 'round1' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(!weekDataPhase2?.rounds?.[0]),
            new ButtonBuilder()
                .setCustomId(`results_view|${clan}|${weekNumber}-${year}|round2`)
                .setLabel('Round 2')
                .setStyle(view === 'round2' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(!weekDataPhase2?.rounds?.[1]),
            new ButtonBuilder()
                .setCustomId(`results_view|${clan}|${weekNumber}-${year}|round3`)
                .setLabel('Round 3')
                .setStyle(view === 'round3' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(!weekDataPhase2?.rounds?.[2]),
            new ButtonBuilder()
                .setCustomId(`results_view|${clan}|${weekNumber}-${year}|summary`)
                .setLabel('Total Phase 2')
                .setStyle(view === 'summary' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(!weekDataPhase2)
        );

    const replyOptions = {
        embeds: [embed],
        components: [navRow]
    };

    let response;
    if (useFollowUp) {
        // Dla /results - wyślij publiczną wiadomość
        await interaction.editReply({
            content: '✅ Results have been sent publicly below.',
            embeds: [],
            components: []
        });
        response = await interaction.followUp(replyOptions);
    } else if (isUpdate) {
        // Dla przycisków nawigacji
        response = await interaction.update(replyOptions);
    } else {
        // Dla innych komend (widoczne tylko for wywołującego)
        response = await interaction.editReply(replyOptions);
    }

    // Zaplanuj usunięcie wiadomości po 15 minutach (resetuj timer przy każdym kliknięciu)
    // Dla update, message jest w interaction.message
    // Dla followUp/editReply, message jest w response
    const messageToSchedule = (isUpdate || useFollowUp) ? (isUpdate ? interaction.message : response) : response;

    if (messageToSchedule && messageCleanupService && shouldAutoDelete) {
        // Usuń stary scheduled deletion jeśli istnieje
        if (isUpdate) {
            await messageCleanupService.removeScheduledMessage(messageToSchedule.id);
        }

        // Dodaj nowy scheduled deletion z nowym czasem (15 minut od teraz)
        await messageCleanupService.scheduleMessageDeletion(
            messageToSchedule.id,
            messageToSchedule.channelId,
            deleteAt,
            interaction.user.id
        );
    } else if (messageToSchedule && messageCleanupService && !shouldAutoDelete) {
        // Jeśli kanał jest na liście permanentnych, usuń zaplanowane usunięcie (jeśli istnieje)
        if (isUpdate) {
            await messageCleanupService.removeScheduledMessage(messageToSchedule.id);
        }
    }
}

async function handleResultsCommand(interaction, sharedState) {
    const { config } = sharedState;

    // Get server-specific configuration
    const serverConfig = getServerConfigOrThrow(interaction.guild.id, config);

    // Sprawdź czy kanał jest dozwolony
    const allowedChannels = [
        ...Object.values(serverConfig.warningChannels),
        '1348200849242984478'
    ];

    // Administrators can use the command anywhere
    const isAdmin = interaction.member.permissions.has('Administrator');

    if (!allowedChannels.includes(interaction.channelId) && !isAdmin) {
        await interaction.reply({
            content: `❌ Command \`/results\` jest dostępna tylko na określonych kanałach.`,
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        // Utwórz select menu z klanami (bez parametru phase)
        const clanOptions = Object.entries(serverConfig.targetRoles).map(([clanKey, roleId]) => {
            return new StringSelectMenuOptionBuilder()
                .setLabel(serverConfig.roleDisplayNames[clanKey])
                .setValue(clanKey);
        });

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('results_select_clan')
            .setPlaceholder('Select clan')
            .addOptions(clanOptions);

        const row = new ActionRowBuilder().addComponents(selectMenu);

        const embed = new EmbedBuilder()
            .setTitle('📊 Results - All Phases')
            .setDescription('**Step 1/2:** Select clan for which you want to see results:')
            .setColor('#0099FF')
            .setTimestamp();

        await interaction.editReply({
            embeds: [embed],
            components: [row],
            flags: MessageFlags.Ephemeral
        });

    } catch (error) {
        logger.error('[RESULTS] ❌ Error pobierania wyników:', error);
        await interaction.editReply({
            content: '❌ An error occurred while pobierania wyników.'
        });
    }
}

module.exports = {
    handleInteraction,
    registerSlashCommands,
    unregisterCommand,
    confirmationData,
    sendGhostPing,
    stopGhostPing
};