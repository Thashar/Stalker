const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

class VacationService {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.cooldowns = new Map(); // userId -> lastRequestTime
        this.roleTimeouts = new Map(); // userId -> timeoutId
        this.userInteractions = new Map(); // userId -> interaction (dla aktualizacji ephemeral message)
    }

    async sendPermanentVacationMessage(guild) {
        try {
            const vacationChannel = await guild.channels.fetch(this.config.vacations.vacationChannelId);
            if (!vacationChannel) {
                this.logger.error('❌ Vacation channel not found');
                return;
            }

            // Delete all previous bot messages from channel
            const messages = await vacationChannel.messages.fetch({ limit: 50 });
            const botMessages = messages.filter(msg => msg.author.bot);

            for (const message of botMessages.values()) {
                try {
                    await message.delete();
                } catch (error) {
                    this.logger.warn(`⚠️ Cannot delete message: ${error.message}`);
                }
            }

            // Create button for submitting vacation
            const vacationButton = new ButtonBuilder()
                .setCustomId('vacation_request')
                .setLabel('Submit vacation')
                .setEmoji('<:PepePaluszki:1341086255433121914>')
                .setStyle(ButtonStyle.Success);

            const row = new ActionRowBuilder()
                .addComponents(vacationButton);

            await vacationChannel.send({
                components: [row]
            });

            this.logger.info('✅ Sent permanent vacation message');
        } catch (error) {
            this.logger.error(`❌ Error sending permanent message: ${error.message}`);
        }
    }

    async handleVacationRequest(interaction) {
        try {
            const userId = interaction.user.id;

            // Check cooldown
            if (this.isOnCooldown(userId)) {
                const remainingTime = this.getRemainingCooldown(userId);
                await interaction.reply({
                    content: `⏰ You can submit another vacation request in ${remainingTime}.`,
                    ephemeral: true
                });
                return;
            }

            // Send first message with rules
            const rulesMessage = `Important rules regarding vacation submissions:
- Vacations must be submitted up to 2 weeks before the vacation starts,
- Each vacation can last a maximum of 2 weeks,
- If you need to extend your vacation, do so only during its duration.
- During vacation you can skip daily points, events, and in some cases LME phase 3
- **Remember that vacation does not apply during LME phase 1, unless participation is impossible (broken phone, no internet in another country).**
- Vacation protects against punishment points for lack of participation in LME phase 3.

If you have read and agree to the above rules, press the button below to submit your request.`;

            const submitButton = new ButtonBuilder()
                .setCustomId(`vacation_submit_${userId}`)
                .setLabel('Submit vacation request')
                .setStyle(ButtonStyle.Success);

            const cancelButton = new ButtonBuilder()
                .setCustomId(`vacation_cancel_${userId}`)
                .setLabel("Don't open request")
                .setStyle(ButtonStyle.Danger);

            const row = new ActionRowBuilder()
                .addComponents(submitButton, cancelButton);

            await interaction.reply({
                content: rulesMessage,
                components: [row],
                ephemeral: true
            });

        } catch (error) {
            this.logger.error(`❌ Error handling vacation request: ${error.message}`);
            await interaction.reply({
                content: '❌ An error occurred while handling the request.',
                ephemeral: true
            });
        }
    }

    async handleVacationSubmit(interaction) {
        try {
            const userId = interaction.user.id;
            const member = interaction.member;

            // Assign vacation request role
            const vacationRole = interaction.guild.roles.cache.get(this.config.vacations.vacationRequestRoleId);
            if (vacationRole) {
                await member.roles.add(vacationRole);
                this.logger.info(`✅ Assigned vacation role to user ${member.user.tag}`);

                // Set automatic role removal after 15 minutes
                this.setRoleTimeout(userId, interaction.guild);
            }

            // Set cooldown
            this.setCooldown(userId);

            const successMessage = `You can now write your request in the chat.
Remember to provide the exact dates when you will be unavailable.

**After sending the message you can submit a new request only after 6h!**`;

            await interaction.update({
                content: successMessage,
                components: []
            });

            // Save interaction reference for later update
            this.userInteractions.set(userId, interaction);

            // Check if vacation message is last
            await this.ensureVacationMessageIsLast(interaction.guild);

        } catch (error) {
            this.logger.error(`❌ Error submitting request: ${error.message}`);
            await interaction.update({
                content: '❌ An error occurred while submitting the request.',
                components: []
            });
        }
    }

    async handleVacationCancel(interaction) {
        try {
            await interaction.update({
                content: 'Request has been closed.',
                components: []
            });

        } catch (error) {
            this.logger.error(`❌ Error canceling request: ${error.message}`);
        }
    }

    async handleVacationMessage(message) {
        try {
            // Check if message is in vacation channel
            if (message.channel.id !== this.config.vacations.vacationChannelId) {
                return;
            }

            // Check if user has vacation request role and remove it
            const vacationRole = message.guild.roles.cache.get(this.config.vacations.vacationRequestRoleId);
            if (vacationRole && message.member.roles.cache.has(vacationRole.id)) {
                await message.member.roles.remove(vacationRole);
                this.logger.info(`✅ Removed vacation role from user ${message.author.tag} after writing request`);

                // Cancel automatic role removal (user wrote request)
                this.clearRoleTimeout(message.author.id);

                // Update user's ephemeral message
                const userInteraction = this.userInteractions.get(message.author.id);
                if (userInteraction) {
                    try {
                        await userInteraction.editReply({
                            content: 'Request has been submitted.',
                            components: []
                        });
                        this.logger.info(`✅ Updated ephemeral message for ${message.author.tag}`);
                    } catch (error) {
                        this.logger.warn(`⚠️ Cannot update ephemeral message for ${message.author.tag}: ${error.message}`);
                    }

                    // Delete interaction reference
                    this.userInteractions.delete(message.author.id);
                }
            }

            // Check if bot message with vacation button is last
            await this.ensureVacationMessageIsLast(message.guild);

        } catch (error) {
            this.logger.error(`❌ Error handling vacation message: ${error.message}`);
        }
    }

    async ensureVacationMessageIsLast(guild) {
        try {
            const vacationChannel = await guild.channels.fetch(this.config.vacations.vacationChannelId);
            if (!vacationChannel) {
                return;
            }

            // Fetch latest messages from channel
            const messages = await vacationChannel.messages.fetch({ limit: 10 });
            const messageList = Array.from(messages.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);

            if (messageList.length === 0) {
                // If channel is empty, send message
                await this.sendPermanentVacationMessage(guild);
                return;
            }

            const lastMessage = messageList[messageList.length - 1];

            // Check if last message is bot message with vacation button
            const isVacationMessage = lastMessage.author.bot &&
                (!lastMessage.content || lastMessage.content === '') &&
                lastMessage.components.length > 0 &&
                lastMessage.components[0].components.some(comp => comp.customId === 'vacation_request');

            if (!isVacationMessage) {
                // Bot message is not last or doesn't exist - refresh
                this.logger.info('🔄 Vacation message is not last - refreshing');
                await this.sendPermanentVacationMessage(guild);
            }

        } catch (error) {
            this.logger.error(`❌ Error checking vacation message position: ${error.message}`);
        }
    }

    isOnCooldown(userId) {
        const lastRequest = this.cooldowns.get(userId);
        if (!lastRequest) return false;

        const now = Date.now();
        const cooldownTime = this.config.vacations.cooldownHours * 60 * 60 * 1000; // Convert hours to milliseconds
        return (now - lastRequest) < cooldownTime;
    }

    getRemainingCooldown(userId) {
        const lastRequest = this.cooldowns.get(userId);
        if (!lastRequest) return '0 minutes';

        const now = Date.now();
        const cooldownTime = this.config.vacations.cooldownHours * 60 * 60 * 1000;
        const remaining = cooldownTime - (now - lastRequest);

        if (remaining <= 0) return '0 minutes';

        const hours = Math.floor(remaining / (1000 * 60 * 60));
        const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));

        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        } else {
            return `${minutes}m`;
        }
    }

    setCooldown(userId) {
        this.cooldowns.set(userId, Date.now());
    }

    setRoleTimeout(userId, guild) {
        // Clear existing timeout if exists
        this.clearRoleTimeout(userId);

        // Set new timeout for 15 minutes (900000 ms)
        const timeoutId = setTimeout(async () => {
            try {
                const member = await guild.members.fetch(userId);
                const vacationRole = guild.roles.cache.get(this.config.vacations.vacationRequestRoleId);

                if (member && vacationRole && member.roles.cache.has(vacationRole.id)) {
                    await member.roles.remove(vacationRole);
                    this.logger.info(`⏰ Automatically removed vacation role from user ${member.user.tag} after 15 minutes`);

                    // Check if vacation message is last
                    await this.ensureVacationMessageIsLast(guild);
                }

                // Remove timeout from map
                this.roleTimeouts.delete(userId);

            } catch (error) {
                this.logger.error(`❌ Error automatically removing vacation role: ${error.message}`);
                this.roleTimeouts.delete(userId);
            }
        }, 15 * 60 * 1000); // 15 minutes

        // Save timeout ID
        this.roleTimeouts.set(userId, timeoutId);
        this.logger.info(`⏱️ Set automatic vacation role removal in 15 minutes for user ${userId}`);
    }

    clearRoleTimeout(userId) {
        const timeoutId = this.roleTimeouts.get(userId);
        if (timeoutId) {
            clearTimeout(timeoutId);
            this.roleTimeouts.delete(userId);
            this.logger.info(`🚫 Canceled automatic vacation role removal for user ${userId}`);
        }
    }
}

module.exports = VacationService;