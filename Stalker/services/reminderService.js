const { EmbedBuilder } = require('discord.js');
const messages = require('../config/messages');

const { createBotLogger } = require('../../utils/consoleLogger');

const logger = createBotLogger('Stalker');

class ReminderService {
    constructor(config) {
        this.config = config;
    }

    /**
     * Get server configuration or throw error if not configured
     */
    getServerConfigOrThrow(guildId) {
        const serverConfig = this.config.getServerConfig(guildId);
        if (!serverConfig) {
            throw new Error(`Bot is not configured for server ${guildId}. Check servers.json configuration.`);
        }
        return serverConfig;
    }

    async sendReminders(guild, foundUsers) {
        try {
            // Get server-specific configuration
            const serverConfig = this.getServerConfigOrThrow(guild.id);

            const timeUntilDeadline = this.calculateTimeUntilDeadline();
            const roleGroups = new Map();
            let sentMessages = 0;

            // Group users by role
            for (const userData of foundUsers) {
                const { member } = userData;

                for (const [roleKey, roleId] of Object.entries(serverConfig.targetRoles)) {
                    if (member.roles.cache.has(roleId)) {
                        if (!roleGroups.has(roleKey)) {
                            roleGroups.set(roleKey, []);
                        }
                        roleGroups.get(roleKey).push(member);
                        break;
                    }
                }
            }

            // Send reminders for each role group
            for (const [roleKey, members] of roleGroups) {
                const roleId = serverConfig.targetRoles[roleKey];
                const warningChannelId = serverConfig.warningChannels[roleId];

                if (warningChannelId) {
                    const warningChannel = guild.channels.cache.get(warningChannelId);

                    if (warningChannel) {
                        const userMentions = members.map(member => member.toString()).join(' ');
                        const timeMessage = messages.formatTimeMessage(timeUntilDeadline);
                        const reminderMessage = messages.reminderMessage(timeMessage, userMentions);

                        await warningChannel.send(reminderMessage);
                        sentMessages++;

                        logger.info(`✅ Sent reminder to channel ${warningChannel.name} for ${members.length} users`);
                    }
                }
            }

            logger.info(`✅ Sent ${sentMessages} reminders for ${foundUsers.length} users`);

            return {
                sentMessages: sentMessages,
                roleGroups: roleGroups.size,
                totalUsers: foundUsers.length
            };
        } catch (error) {
            logger.error('Reminder error');
            logger.error('❌ Error sending reminders:', error.message);
            logger.error('❌ Stack trace:', error.stack);
            throw error;
        }
    }

    calculateTimeUntilDeadline() {
        const now = new Date();
        const polandTime = new Date(now.toLocaleString('en-US', { timeZone: this.config.timezone }));
        
        const deadline = new Date(polandTime);
        deadline.setHours(this.config.bossDeadline.hour, this.config.bossDeadline.minute, 0, 0);
        
        if (polandTime >= deadline) {
            deadline.setDate(deadline.getDate() + 1);
        }
        
        const timeDiff = deadline - polandTime;
        const totalMinutes = Math.floor(timeDiff / (1000 * 60));
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        
        return {
            totalMinutes: totalMinutes,
            hours: hours,
            minutes: minutes
        };
    }

    async sendRoleReminders(guild, roleId) {
        try {
            logger.info('Role reminders');
            logger.info(`🏰 Server: ${guild.name} (${guild.id})`);
            logger.info(`🎭 Role: ${roleId}`);

            const role = guild.roles.cache.get(roleId);

            if (!role) {
                throw new Error('Role not found');
            }

            const members = role.members;
            const remindersSent = [];

            for (const [userId, member] of members) {
                try {
                    const timeLeft = this.calculateTimeUntilDeadline();
                    const timeMessage = messages.formatTimeMessage(timeLeft);

                    const embed = new EmbedBuilder()
                        .setTitle('⏰ BOSS REMINDER')
                        .setDescription(`${timeMessage}\n\nRemember to defeat the boss to avoid punishment points!`)
                        .setColor('#FFA500')
                        .setTimestamp()
                        .setFooter({ text: 'Automatic reminder system' });

                    await member.send({ embeds: [embed] });
                    remindersSent.push(member);

                    logger.info(`✅ Sent reminder to ${member.displayName} (${member.id})`);
                } catch (error) {
                    logger.info(`⚠️ Failed to send reminder to ${member.displayName}: ${error.message}`);
                }
            }

            logger.info('Role reminders summary:');
            logger.info(`📤 Reminders sent: ${remindersSent.length}`);
            logger.info(`👥 Role members: ${members.size}`);
            logger.info('✅ Role reminders completed');

            return remindersSent;
        } catch (error) {
            logger.error('Role reminders error');
            logger.error('❌ Error sending reminders to role:', error);
            throw error;
        }
    }

    async sendBulkReminder(guild, roleId, customMessage = null) {
        try {
            logger.info('Bulk reminder');
            logger.info(`🏰 Server: ${guild.name} (${guild.id})`);
            logger.info(`🎭 Role: ${roleId}`);

            // Get server-specific configuration
            const serverConfig = this.config.getServerConfig(guild.id);
            if (!serverConfig) {
                logger.error(`❌ Server ${guild.id} not configured`);
                throw new Error('Server not configured');
            }

            const role = guild.roles.cache.get(roleId);

            if (!role) {
                throw new Error('Role not found');
            }

            const timeLeft = this.calculateTimeUntilDeadline();
            const timeMessage = messages.formatTimeMessage(timeLeft);

            const embed = new EmbedBuilder()
                .setTitle('⏰ BOSS REMINDER')
                .setDescription(customMessage || `${timeMessage}\n\nRemember to defeat the boss to avoid punishment points!`)
                .setColor('#FFA500')
                .setTimestamp()
                .setFooter({ text: 'Automatic reminder system' });

            const warningChannelId = serverConfig.warningChannels[roleId];

            if (warningChannelId) {
                const warningChannel = guild.channels.cache.get(warningChannelId);

                if (warningChannel) {
                    await warningChannel.send({
                        content: `${role}`,
                        embeds: [embed]
                    });

                    logger.info(`✅ Sent bulk reminder to channel ${warningChannel.name} (${warningChannel.id})`);
                    logger.info(`💬 Content: ${customMessage ? 'Custom message' : 'Standard reminder'}`);
                    return true;
                }
            }

            throw new Error('Warning channel not found for this role');
        } catch (error) {
            logger.error('Bulk reminder error');
            logger.error('❌ Error sending bulk reminder:', error);
            throw error;
        }
    }

    isDeadlinePassed() {
        const now = new Date();
        const polandTime = new Date(now.toLocaleString('en-US', { timeZone: this.config.timezone }));
        
        const deadline = new Date(polandTime);
        deadline.setHours(this.config.bossDeadline.hour, this.config.bossDeadline.minute, 0, 0);
        
        return polandTime >= deadline;
    }

    getNextDeadline() {
        const now = new Date();
        const polandTime = new Date(now.toLocaleString('en-US', { timeZone: this.config.timezone }));
        
        const deadline = new Date(polandTime);
        deadline.setHours(this.config.bossDeadline.hour, this.config.bossDeadline.minute, 0, 0);
        
        if (polandTime >= deadline) {
            deadline.setDate(deadline.getDate() + 1);
        }
        
        return deadline;
    }

    formatTimeLeft(timeLeft) {
        if (timeLeft <= 0) {
            return 'Deadline passed!';
        }

        const hours = Math.floor(timeLeft / (1000 * 60 * 60));
        const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));

        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        } else {
            return `${minutes}m`;
        }
    }
}

module.exports = ReminderService;