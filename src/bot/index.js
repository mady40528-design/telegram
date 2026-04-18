/**
 * Telegram Bot Module - Main Entry Point
 * 
 * Initializes the Telegram bot and registers all command handlers.
 */

const TelegramBot = require('node-telegram-bot-api');
const commands = require('./commands');

// Bot instance (singleton)
let bot = null;

/**
 * Initialize the Telegram bot
 * Sets up polling and registers all command handlers
 * @returns {Promise<TelegramBot>} The bot instance
 */
async function initializeBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token) {
        throw new Error('TELEGRAM_BOT_TOKEN غير محدد في متغيرات البيئة');
    }

    if (token === 'your_bot_token_here') {
        throw new Error('يرجى تعيين رمز بوت Telegram الفعلي في ملف .env');
    }

    // Create bot instance with polling
    bot = new TelegramBot(token, {
        polling: true
    });

    // Register command handlers
    registerCommands();

    // Handle polling errors
    bot.on('polling_error', (error) => {
        console.error('❌ خطأ في استطلاع Telegram:', error.code, error.message);
    });

    // Handle general errors
    bot.on('error', (error) => {
        console.error('❌ خطأ في بوت Telegram:', error.message);
    });

    // Log successful connection
    try {
        const me = await bot.getMe();
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🤖 تم تشغيل بوت TrackIt');
        console.log(`📱 اسم المستخدم: @${me.username}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    } catch (error) {
        console.error('❌ فشل الاتصال بـ Telegram:', error.message);
        throw error;
    }

    return bot;
}

/**
 * Register all bot command handlers
 */
function registerCommands() {
    // /start - Initialize the bot for a user
    bot.onText(/\/start/, (msg) => commands.handleStart(bot, msg));

    // /track <url> - Track a new Amazon product
    bot.onText(/\/track(.*)/, (msg, match) => commands.handleTrack(bot, msg, match));

    // /setprice <id> <price> - Set target price for a product
    bot.onText(/\/setprice(.*)/, (msg, match) => commands.handleSetPrice(bot, msg, match));

    // /status - View tracked products and their status
    bot.onText(/\/status/, (msg) => commands.handleStatus(bot, msg));

    // /help - Show help message
    bot.onText(/\/help/, (msg) => commands.handleHelp(bot, msg));

    // /delete <id> - Remove a tracked product
    bot.onText(/\/delete(.*)/, (msg, match) => commands.handleDelete(bot, msg, match));

    // /check - Manually trigger price check for user's products
    bot.onText(/\/check/, (msg) => commands.handleCheck(bot, msg));

    // /plans - Show plan comparison
    bot.onText(/\/plans/, (msg) => commands.handlePlans(bot, msg));

    // /upgrade - Start manual PRO upgrade request
    bot.onText(/\/upgrade/, (msg) => commands.handleUpgrade(bot, msg));

    // /approve <telegramId> - Admin approves manual payment
    bot.onText(/\/approve(.*)/, (msg, match) => commands.handleApprove(bot, msg, match));

    // /downgrade - Downgrade to FREE plan
    bot.onText(/\/downgrade/, (msg) => commands.handleDowngrade(bot, msg));

    // Admin dashboard commands
    bot.onText(/\/admin_stats/, (msg) => commands.handleAdminStats(bot, msg));
    bot.onText(/\/admin_users(.*)/, (msg, match) => commands.handleAdminUsers(bot, msg, match));
    bot.onText(/\/admin_payments(.*)/, (msg, match) => commands.handleAdminPayments(bot, msg, match));

    // Handle incoming messages for direct Amazon links
    bot.on('message', async (msg) => {
        const text = msg.text || '';

        // Ignore if it's a command (handled by onText) or empty
        if (!text || text.startsWith('/')) return;

        // Check for Amazon URLs
        if (text.includes('amazon.in')|| text.includes('amzn.eu')|| text.includes('amazon.eg') || text.includes('amazon.com') || text.includes('amzn.in') || text.includes('amzn.to')) {
            console.log(`🔗 تم اكتشاف رابط مباشر من ${msg.from.username || msg.from.id}`);
            await commands.handleTrack(bot, msg, [text, text]);
        }
    });

    // Handle payment proof screenshots
    bot.on('photo', async (msg) => {
        await commands.handlePaymentPhoto(bot, msg);
    });

    // Handle callback queries (Inline Buttons)
    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const action = query.data;

        // Acknowledge callback to stop loading animation
        try {
            await bot.answerCallbackQuery(query.id);
        } catch (error) {
            console.error('خطأ في الرد على الاستدعاء:', error.message);
        }

        // Construct mock msg object for command handlers
        const msg = query.message;
        msg.from = query.from;

        // Handle Dynamic Actions (Page, Check, Delete)
        if (action.startsWith('PAGE_')) {
            const page = parseInt(action.split('_')[1]);
            await commands.showProductList(bot, chatId, query.from.id, page, msg.message_id, query.from);
            return;
        }

        if (action.startsWith('CHECK_')) {
            const parts = action.split('_');
            const id = parseInt(parts[1]);
            const page = parseInt(parts[2]) || 1;
            await commands.handleCheckCallback(bot, msg, id, page);
            return;
        }

        if (action.startsWith('DELETE_')) {
            const parts = action.split('_');
            const id = parseInt(parts[1]);
            const page = parseInt(parts[2]) || 1;
            await commands.handleDeleteCallback(bot, msg, id, page);
            return;
        }

        if (action.startsWith('ADMIN_USERS_PAGE_')) {
            const page = parseInt(action.split('_')[3]) || 1;
            await commands.handleAdminUsers(bot, msg, null, page);
            return;
        }

        if (action.startsWith('ADMIN_PAYMENTS_PAGE_')) {
            const page = parseInt(action.split('_')[3]) || 1;
            await commands.handleAdminPayments(bot, msg, null, page);
            return;
        }

        switch (action) {
            case 'TRACK':
                await bot.sendMessage(chatId,
                    '👇 <b>أرسل لي رابط منتج أمازون:</b>\n\n' +
                    '<code>https://amazon.eg/dp/...</code>\n\n' +
                    'أو استخدم الأمر: <code>/track &lt;رابط&gt;</code>',
                    {
                        parse_mode: 'HTML',
                        ...require('./keyboards').closeKeyboard
                    }
                );
                break;

            case 'STATUS':
                await commands.showProductList(bot, chatId, query.from.id, 1, msg.message_id, query.from);
                break;

            case 'DASHBOARD':
                const dashboardUrl = process.env.DASHBOARD_URL || 'https://trackismartbot.netlify.app';
                const magicLink = `${dashboardUrl}/?user_id=${query.from.id}`;
                const isLocal = dashboardUrl.includes('localhost') || dashboardUrl.includes('127.0.0.1');

                if (isLocal) {
                    await bot.sendMessage(chatId,
                        `📊 <b>لوحة تحكم TrackIt</b>\n\n` +
                        `استخدم هذا الرابط للوصول إلى لوحة التحكم المحلية:\n` +
                        `<a href="${magicLink}">🚀 فتح لوحة التحكم</a>\n\n` +
                        `<i>(الرابط صالح لحسابك فقط)</i>`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '❌ إغلاق', callback_data: 'CLOSE' }]
                                ]
                            }
                        }
                    );
                } else {
                    await bot.sendMessage(chatId,
                        `📊 <b>لوحة تحكم TrackIt</b>\n\n` +
                        `اضغط الزر أدناه لعرض منتجاتك ومخططات سجل الأسعار والاتجاهات على الويب!\n\n` +
                        `<i>(الرابط صالح لحسابك فقط)</i>`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '🚀 فتح لوحة التحكم', url: magicLink }],
                                    [{ text: '❌ إغلاق', callback_data: 'CLOSE' }]
                                ]
                            }
                        }
                    );
                }
                break;

            case 'PLANS':
                await commands.handlePlans(bot, msg);
                break;

            case 'UPGRADE':
                await commands.handleUpgrade(bot, msg);
                break;

            case 'RENEW_SUB':
                await commands.handleUpgrade(bot, msg);
                break;

            case 'HELP':
                await commands.handleHelp(bot, msg);
                break;

            case 'BACK':
                await commands.handleStart(bot, msg);
                break;

            case 'CLOSE':
                try {
                    await bot.deleteMessage(chatId, msg.message_id);
                } catch (err) {
                    await bot.editMessageText('✅ تم إغلاق الجلسة. استخدم /start للبدء مجدداً.', {
                        chat_id: chatId,
                        message_id: msg.message_id
                    });
                }
                break;

            default:
                console.log('إجراء استدعاء غير معروف:', action);
        }
    });

    console.log('📋 تم تسجيل أوامر البوت: /start, /track, /setprice, /status, /help, /delete, /check, /plans, /upgrade, /approve, /downgrade');
}

/**
 * Get the bot instance
 * @returns {TelegramBot} The bot instance
 */
function getBot() {
    if (!bot) {
        throw new Error('البوت غير مُهيّأ. استدعِ initializeBot() أولاً.');
    }
    return bot;
}

/**
 * Send a message to a specific user
 * @param {number} chatId - Telegram chat ID
 * @param {string} message - Message to send
 * @param {Object} options - Additional options
 */
async function sendMessage(chatId, message, options = {}) {
    const botInstance = getBot();
    return botInstance.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...options
    });
}

/**
 * Stop the bot (for graceful shutdown)
 */
function stopBot() {
    if (bot) {
        bot.stopPolling();
        bot = null;
        console.log('🤖 تم إيقاف البوت');
    }
}

module.exports = {
    initializeBot,
    getBot,
    sendMessage,
    stopBot
};
