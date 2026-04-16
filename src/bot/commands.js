/**
 * Telegram Bot Commands
 * 
 * Contains all command handler implementations.
 * Each handler processes a specific bot command.
 */

const queries = require('../db/queries');
const { scrapeAmazonProduct, validateAmazonUrl } = require('../scraper/amazon');
const { getUserPlan, canUserTrackMore, PLANS } = require('../services/plans');
const { validateAction, formatValidationMessage } = require('../services/planGuard');
const paymentService = require('../services/paymentService');
const { maybeSendReminderForUser } = require('../services/subscriptionReminderService');

const { mainMenuKeyboard, withNavigation, productListKeyboard } = require('./keyboards');

// ... (rest of imports)

// ===========================================
// /start COMMAND
// ===========================================

/**
 * Handle /start command
 * Registers new user and shows welcome message
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} msg - Telegram message object
 */
async function handleStart(bot, msg) {
    const chatId = msg.chat.id;
    const user = msg.from;

    try {
        // Register/update user in database
        const dbUser = await queries.upsertUser({
            telegramId: user.id,
            username: user.username || null,
            firstName: user.first_name || null,
            lastName: user.last_name || null,
            languageCode: user.language_code || 'ar'
        });

        console.log(`👤 User registered/updated: ${user.username || user.id} (DB ID: ${dbUser.id})`);

        const welcomeMessage = `
🎉 <b>مرحباً بك في TrackIt!</b>

أساعدك في تتبع أسعار منتجات أمازون وإشعارك عند انخفاضها.

<b>🔍 ماذا أفعل:</b>
• أراقب أسعار منتجات أمازون
• أنبّهك عند انخفاض الأسعار
• أوفّر لك المال على مشترياتك!

<b>📝 كيفية الاستخدام:</b>
1️⃣ اضغط <b>➕ تتبع منتج</b> أدناه
   أو أرسل رابط أمازون مباشرةً

2️⃣ سأجلب السعر الحالي وأبدأ التتبع

3️⃣ ستصلك إشعارات عند انخفاض السعر!

<b>⚡ خطتك الحالية:</b>
🆓 مجاني - تتبع <b>${PLANS.FREE.maxProducts} منتج</b>
⭐ برو - تتبع حتى <b>${PLANS.PRO.maxProducts} منتجات</b> مع فحص يومي
        `.trim();

        // Check if we can edit the message (for Back navigation)
        if (msg.message_id && msg.from.is_bot === false) {
            try {
                await bot.editMessageText(welcomeMessage, {
                    chat_id: chatId,
                    message_id: msg.message_id,
                    parse_mode: 'HTML',
                    ...mainMenuKeyboard
                });
                return;
            } catch (err) {
                // Ignore edit error, fall back to send
            }
        }

        await bot.sendMessage(chatId, welcomeMessage, {
            parse_mode: 'HTML',
            ...mainMenuKeyboard
        });

    } catch (error) {

        console.error('Error in /start command:', error);
        await bot.sendMessage(chatId, '❌ حدث خطأ ما. يرجى المحاولة مرة أخرى لاحقاً.');
    }
}

// ===========================================
// /track COMMAND
// ===========================================

/**
 * Handle /track command
 * Adds a new Amazon product to tracking list
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} msg - Telegram message object
 * @param {Array} match - Regex match result
 */
async function handleTrack(bot, msg, match) {
    const chatId = msg.chat.id;
    const user = msg.from;
    const url = match[1]?.trim();

    try {
        // Validate URL is provided
        if (!url) {
            await bot.sendMessage(chatId,
                '⚠️ يرجى إدخال رابط أمازون.\n\n' +
                '<b>الاستخدام:</b> <code>/track &lt;رابط-أمازون&gt;</code>\n\n' +
                '<b>مثال:</b>\n<code>/track https://amazon.in/dp/B08N5WRWNW</code>',
                { parse_mode: 'HTML' }
            );
            return;
        }

        // Validate Amazon URL format
        const validation = validateAmazonUrl(url);
        if (!validation.isValid) {
            await bot.sendMessage(chatId,
                `⚠️ ${validation.error}\n\n` +
                'يرجى إدخال رابط منتج صحيح من Amazon.in أو Amazon.com.',
                { parse_mode: 'HTML' }
            );
            return;
        }

        // Get or create user
        let dbUser = await queries.findUserByTelegramId(user.id);
        if (!dbUser) {
            dbUser = await queries.upsertUser({
                telegramId: user.id,
                username: user.username || null,
                firstName: user.first_name || null,
                lastName: user.last_name || null,
                languageCode: user.language_code || 'ar'
            });
        }

        // Check product limit based on user's plan
        const currentCount = await queries.countUserTrackedProducts(dbUser.id);
        const planValidation = validateAction(dbUser, 'TRACK_PRODUCT', { currentProductCount: currentCount });

        if (!planValidation.allowed) {
            const message = formatValidationMessage(planValidation);
            await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
            return;
        }

        // Send "processing" message
        const processingMsg = await bot.sendMessage(chatId,
            '🔍 <b>جارٍ جلب تفاصيل المنتج...</b>\n\nيرجى الانتظار بينما أجلب صفحة أمازون.',
            { parse_mode: 'HTML' }
        );

        // Scrape product details
        let productData;
        try {
            productData = await scrapeAmazonProduct(url);
        } catch (scrapeError) {
            await bot.editMessageText(
                `❌ <b>فشل في جلب المنتج</b>\n\n${scrapeError.message}\n\n` +
                `يرجى التأكد من:\n` +
                `• أن الرابط صفحة منتج أمازون صحيحة\n` +
                `• أن المنتج متوفر في المخزون\n` +
                `• حاول مرة أخرى بعد دقائق`,
                { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'HTML' }
            );
            return;
        }

        // Determine currency symbol
        const currencySymbol = productData.currency === 'INR' ? '₹' :
            productData.currency === 'USD' ? '$' :
                productData.currency === 'EUR' ? '€' :
                    productData.currency === 'GBP' ? '£' : productData.currency;

        // Save to database
        const savedProduct = await queries.createTrackedProduct({
            userId: dbUser.id,
            amazonUrl: url,
            title: productData.title,
            currentPrice: productData.price,
            currency: productData.currency
        });

        console.log(`📦 Product tracked: "${productData.title.substring(0, 30)}..." by ${user.username || user.id}`);

        // Send success message
        const successMessage = `
✅ <b>تمت إضافة المنتج للتتبع!</b>

📦 <b>المنتج:</b>
${truncateTitle(productData.title, 100)}

💰 <b>السعر الحالي:</b> ${currencySymbol}${formatPrice(productData.price)}

🎯 <b>السعر المستهدف:</b> غير محدد
<i>استخدم /setprice ${savedProduct.id} &lt;السعر&gt; لتحديد سعر التنبيه</i>

📊 <b>رقم المنتج:</b> #${savedProduct.id}

⏰ <b>الفحص التلقائي:</b> كل أحد الساعة 9 صباحاً (IST)
<i>استخدم /check للفحص اليدوي في أي وقت</i>

<i>سأخطرك عند انخفاض السعر!</i>
        `;

        await bot.editMessageText(successMessage, {
            chat_id: chatId,
            message_id: processingMsg.message_id,
            parse_mode: 'HTML'
        });

    } catch (error) {
        console.error('Error in /track command:', error);
        await bot.sendMessage(chatId, '❌ فشل في تتبع المنتج. يرجى المحاولة مرة أخرى.');
    }
}

// ===========================================
// /setprice COMMAND
// ===========================================

/**
 * Handle /setprice command
 * Sets target price for a tracked product
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} msg - Telegram message object
 * @param {Array} match - Regex match result
 */
async function handleSetPrice(bot, msg, match) {
    const chatId = msg.chat.id;
    const user = msg.from;
    const args = match[1]?.trim().split(/\s+/);

    try {
        // Validate arguments
        if (!args || args.length < 2 || !args[0] || !args[1]) {
            await bot.sendMessage(chatId,
                '⚠️ يرجى إدخال رقم المنتج والسعر المستهدف.\n\n' +
                '<b>الاستخدام:</b> <code>/setprice &lt;الرقم&gt; &lt;السعر&gt;</code>\n\n' +
                '<b>مثال:</b> <code>/setprice 1 999</code>\n\n' +
                'استخدم /status لمعرفة أرقام منتجاتك.',
                { parse_mode: 'HTML' }
            );
            return;
        }

        const productId = parseInt(args[0]);
        const targetPrice = parseFloat(args[1]);

        // Validate inputs
        if (isNaN(productId) || productId <= 0) {
            await bot.sendMessage(chatId, '⚠️ رقم منتج غير صحيح. استخدم /status لعرض منتجاتك.');
            return;
        }

        if (isNaN(targetPrice) || targetPrice <= 0) {
            await bot.sendMessage(chatId, '⚠️ سعر غير صحيح. يرجى إدخال رقم موجب.');
            return;
        }

        // Get user
        const dbUser = await queries.findUserByTelegramId(user.id);
        if (!dbUser) {
            await bot.sendMessage(chatId, '⚠️ يرجى استخدام /start أولاً للتسجيل.');
            return;
        }

        // Get user's products to verify ownership
        const products = await queries.getTrackedProductsByUserId(dbUser.id);
        const product = products.find(p => p.id === productId);

        if (!product) {
            await bot.sendMessage(chatId,
                '⚠️ المنتج غير موجود أو ليس لديك صلاحية تعديله.\n\n' +
                'استخدم /status لعرض منتجاتك المتتبعة.'
            );
            return;
        }

        // Update target price
        await queries.updateTargetPrice(productId, targetPrice);

        const currencySymbol = product.currency === 'INR' ? '₹' :
            product.currency === 'USD' ? '$' : product.currency;

        await bot.sendMessage(chatId,
            `✅ <b>تم تحديد السعر المستهدف!</b>\n\n` +
            `📦 ${truncateTitle(product.title, 60)}\n\n` +
            `💰 الحالي: ${currencySymbol}${formatPrice(product.current_price)}\n` +
            `🎯 المستهدف: ${currencySymbol}${formatPrice(targetPrice)}\n\n` +
            `<i>ستُخطَر عندما ينخفض السعر إلى ${currencySymbol}${formatPrice(targetPrice)} أو أقل!</i>`,
            { parse_mode: 'HTML' }
        );

        console.log(`🎯 Target price set: Product #${productId} -> ${currencySymbol}${targetPrice}`);

    } catch (error) {
        console.error('Error in /setprice command:', error);
        await bot.sendMessage(chatId, '❌ فشل في تحديد السعر. يرجى المحاولة مرة أخرى.');
    }
}

// ===========================================
// /status COMMAND
// ===========================================

/**
 * Handle /status command
 * Shows all tracked products for the user (paginated)
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} msg - Telegram message object
 */
async function handleStatus(bot, msg) {
    const chatId = msg.chat.id;
    const user = msg.from;

    // Call helper with page 1
    await showProductList(bot, chatId, user.id, 1, null, user);
}

// ===========================================
// ADMIN DASHBOARD COMMANDS
// ===========================================

async function handleAdminStats(bot, msg) {
    const chatId = msg.chat.id;
    const user = msg.from;

    try {
        if (!paymentService.isAdmin(user.id)) {
            await bot.sendMessage(chatId, '⛔ هذا الأمر متاح للإدارة فقط.');
            return;
        }

        const total = await queries.getUsersCount();
        const byPlan = await queries.getUsersCountByPlan();
        const activeSubs = await queries.getActiveSubscriptionsCount();
        const expiredSubs = await queries.getExpiredSubscriptionsCount();
        const pendingPayments = await queries.getPendingPaymentRequestsCount();

        const message = [
            '📊 <b>إحصائيات الإدارة</b>',
            '',
            `👥 <b>إجمالي المستخدمين:</b> ${total}`,
            `⭐ <b>مستخدمين برو:</b> ${byPlan.PRO}`,
            `🆓 <b>مستخدمين مجاني:</b> ${byPlan.FREE}`,
            '',
            `✅ <b>اشتراكات برو النشطة:</b> ${activeSubs}`,
            `❌ <b>اشتراكات برو المنتهية:</b> ${expiredSubs}`,
            '',
            `⏳ <b>طلبات الدفع المعلّقة:</b> ${pendingPayments}`
        ].join('\n');

        await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    } catch (error) {
        console.error('Error in /admin_stats:', error);
        await bot.sendMessage(chatId, '❌ حدث خطأ أثناء جلب الإحصائيات.');
    }
}

function buildAdminPager(type, page, hasPrev, hasNext) {
    const rows = [];
    const nav = [];

    if (hasPrev) nav.push({ text: '◀️ السابق', callback_data: `${type}_PAGE_${page - 1}` });
    nav.push({ text: `${page}`, callback_data: `${type}_PAGE_${page}` });
    if (hasNext) nav.push({ text: 'التالي ▶️', callback_data: `${type}_PAGE_${page + 1}` });

    rows.push(nav);
    rows.push([{ text: '❌ إغلاق', callback_data: 'CLOSE' }]);

    return { reply_markup: { inline_keyboard: rows } };
}

async function handleAdminUsers(bot, msg, match, forcedPage = null) {
    const chatId = msg.chat.id;
    const user = msg.from;
    const pageArg = forcedPage ?? parseInt((match?.[1] || '').trim());
    const page = Number.isFinite(pageArg) && pageArg > 0 ? pageArg : 1;
    const pageSize = 10;
    const offset = (page - 1) * pageSize;

    try {
        if (!paymentService.isAdmin(user.id)) {
            await bot.sendMessage(chatId, '⛔ هذا الأمر متاح للإدارة فقط.');
            return;
        }

        const users = await queries.getRecentUsers(pageSize + 1, offset);
        const hasNext = (users || []).length > pageSize;
        const pageUsers = (users || []).slice(0, pageSize);
        const hasPrev = page > 1;

        let text = `👥 <b>آخر المستخدمين</b> (صفحة ${page})\n\n`;

        if (pageUsers.length === 0) {
            text += '<i>لا توجد بيانات.</i>';
        } else {
            for (const u of pageUsers) {
                const username = u.username ? `@${u.username}` : 'بدون يوزر';
                const plan = u.plan === 'PRO' ? '⭐ برو' : '🆓 مجاني';
                const remaining = u.plan === 'PRO' ? queries.getRemainingDays(u) : 0;
                text += `• <code>${u.telegram_id}</code> | ${username} | ${plan} | ⏳ ${remaining} يوم\n`;
            }
        }

        const pager = buildAdminPager('ADMIN_USERS', page, hasPrev, hasNext);

        if (msg.message_id && msg.from.is_bot === false) {
            try {
                await bot.editMessageText(text, {
                    chat_id: chatId,
                    message_id: msg.message_id,
                    parse_mode: 'HTML',
                    ...pager
                });
                return;
            } catch (err) { }
        }

        await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...pager });
    } catch (error) {
        console.error('Error in /admin_users:', error);
        await bot.sendMessage(chatId, '❌ حدث خطأ أثناء جلب المستخدمين.');
    }
}

async function handleAdminPayments(bot, msg, match, forcedPage = null) {
    const chatId = msg.chat.id;
    const user = msg.from;
    const pageArg = forcedPage ?? parseInt((match?.[1] || '').trim());
    const page = Number.isFinite(pageArg) && pageArg > 0 ? pageArg : 1;
    const pageSize = 10;
    const offset = (page - 1) * pageSize;

    try {
        if (!paymentService.isAdmin(user.id)) {
            await bot.sendMessage(chatId, '⛔ هذا الأمر متاح للإدارة فقط.');
            return;
        }

        const rows = await queries.getPendingPaymentRequests(pageSize + 1, offset);
        const hasNext = (rows || []).length > pageSize;
        const pageRows = (rows || []).slice(0, pageSize);
        const hasPrev = page > 1;

        let text = `💳 <b>طلبات الدفع المعلّقة</b> (صفحة ${page})\n\n`;

        if (pageRows.length === 0) {
            text += '<i>لا توجد طلبات معلّقة.</i>';
        } else {
            for (const r of pageRows) {
                const username = r.username ? `@${r.username}` : 'بدون يوزر';
                const dateText = formatExpiryDateArabic(r.payment_requested_at || r.updated_at || r.created_at);
                text += `• <code>${r.telegram_id}</code> | ${username} | 📅 ${dateText}\n`;
            }
        }

        const pager = buildAdminPager('ADMIN_PAYMENTS', page, hasPrev, hasNext);

        if (msg.message_id && msg.from.is_bot === false) {
            try {
                await bot.editMessageText(text, {
                    chat_id: chatId,
                    message_id: msg.message_id,
                    parse_mode: 'HTML',
                    ...pager
                });
                return;
            } catch (err) { }
        }

        await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...pager });
    } catch (error) {
        console.error('Error in /admin_payments:', error);
        await bot.sendMessage(chatId, '❌ حدث خطأ أثناء جلب المدفوعات.');
    }
}

/**
 * Show product list with pagination
 * @param {TelegramBot} bot - Bot instance
 * @param {number} chatId - Chat ID
 * @param {number} userId - Telegram User ID
 * @param {number} page - Page number
 * @param {number} messageId - Message ID to edit (optional)
 * @param {Object} userObj - User object for logging (optional)
 */
async function showProductList(bot, chatId, userId, page = 1, messageId = null, userObj = {}) {
    try {
        // Get user
        let dbUser = await queries.findUserByTelegramId(userId);
        if (!dbUser) {
            await bot.sendMessage(chatId,
                '⚠️ لم تقم بالتسجيل بعد.\n\nاستخدم /start للبدء!'
            );
            return;
        }

        // Get user's plan info & products
        const products = await queries.getTrackedProductsByUserId(dbUser.id);
        const trackCheck = canUserTrackMore(dbUser, products.length);

        // Subscription status + reminders
        let subscriptionNotice = '';
        let statusSummary = '';

        if (dbUser.plan === 'PRO') {
            if (!queries.isSubscriptionActive(dbUser)) {
                await queries.downgradeUserPlan(dbUser.id);
                dbUser = await queries.findUserByTelegramId(userId);
                subscriptionNotice = '❌ <b>انتهى اشتراكك. تم تحويلك إلى الخطة المجانية.</b>\n\n';
            } else {
                const remainingDays = queries.getRemainingDays(dbUser);
                const expiryText = formatExpiryDateArabic(dbUser.subscription_expires_at);

                statusSummary += `⭐ <b>الخطة الحالية:</b> برو\n`;
                statusSummary += `📦 <b>المنتجات:</b> ${trackCheck.current}/${trackCheck.limit}\n`;
                statusSummary += `⏳ <b>متبقي في اشتراكك:</b> ${remainingDays} يوم\n`;
                statusSummary += `📅 <b>تاريخ الانتهاء:</b> ${expiryText}\n`;

                if (remainingDays <= 3) {
                    statusSummary += `⚠️ <b>اشتراكك هينتهي قريباً</b>\n`;
                }

                statusSummary += '\n';

                // Fire-and-forget reminder (deduped in DB)
                try {
                    await maybeSendReminderForUser(dbUser);
                } catch (err) {
                    // Never block /status on reminder failures
                }
            }
        }

        const plan = getUserPlan(dbUser);

        if (!statusSummary) {
            const planArabic = dbUser.plan === 'PRO' ? 'برو' : 'مجاني';
            statusSummary += `${dbUser.plan === 'PRO' ? '⭐' : '🆓'} <b>الخطة الحالية:</b> ${planArabic}\n`;
            statusSummary += `📦 <b>المنتجات:</b> ${trackCheck.current}/${trackCheck.limit}\n\n`;
        }

        if (products.length === 0) {
            await bot.sendMessage(chatId,
                `📋 <b>منتجاتك المتتبعة</b>\n\n` +
                subscriptionNotice +
                statusSummary +
                `<i>لا تتابع أي منتجات حتى الآن.</i>\n\n` +
                `استخدم <code>/track &lt;رابط-أمازون&gt;</code> لإضافة أول منتج!`,
                {
                    parse_mode: 'HTML',
                    ...withNavigation(null, true, true)
                }
            );
            return;
        }

        // Pagination basics
        const pageSize = 3;
        const totalPages = Math.ceil(products.length / pageSize);

        // Ensure valid page
        if (page < 1) page = 1;
        if (page > totalPages) page = totalPages;

        const start = (page - 1) * pageSize;
        const end = start + pageSize;
        const pageProducts = products.slice(start, end);

        // Format product list
        let message = `📋 <b>منتجاتك المتتبعة</b> (صفحة ${page}/${totalPages})\n\n`;
        message += subscriptionNotice;
        message += statusSummary;
        message += `⏰ <b>تكرار الفحص:</b> ${plan.checkInterval.toLowerCase()}\n\n`;

        for (const product of pageProducts) {
            const currencySymbol = product.currency === 'INR' ? '₹' :
                product.currency === 'USD' ? '$' : product.currency;

            message += `<b>#${product.id}</b> ${truncateTitle(product.title, 40)}\n`;
            message += `💰 السعر: ${currencySymbol}${formatPrice(product.current_price)}`;

            if (product.target_price) {
                message += ` | 🎯 المستهدف: ${currencySymbol}${formatPrice(product.target_price)}`;
            }
            message += '\n';
        }

        message += `\n<i>استخدم الأزرار أدناه لإدارة المنتجات</i>`;

        // Add upgrade hint for free users (only on last page)
        if (plan.id === 'FREE' && !trackCheck.canTrack && page === totalPages) {
            message += `\n\n⭐ <b>ترقَّ إلى برو</b> للحصول على المزيد من المنتجات والفحص اليومي!`;
        }

        const keyboard = productListKeyboard(products, page, pageSize);
        if (dbUser.plan === 'PRO' && queries.isSubscriptionActive(dbUser)) {
            keyboard.reply_markup.inline_keyboard.unshift([
                { text: '🔄 تجديد الاشتراك', callback_data: 'RENEW_SUB' }
            ]);
        }

        if (messageId) {
            try {
                await bot.editMessageText(message, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'HTML',
                    ...keyboard
                });
                return;
            } catch (err) {
                // Ignore edit error
            }
        }

        // Send new message if no ID or edit failed
        if (!messageId) {
            await bot.sendMessage(chatId, message, {
                parse_mode: 'HTML',
                ...keyboard
            });
        }

        if (userObj.username || userObj.id) {
            console.log(`📊 Status shown for: ${userObj.username || userObj.id} (Page ${page})`);
        }

    } catch (error) {
        console.error('Error in showProductList:', error);
        await bot.sendMessage(chatId, '❌ فشل في جلب الحالة. يرجى المحاولة مرة أخرى.');
    }
}

// ===========================================
// /help COMMAND
// ===========================================

/**
 * Handle /help command
 * Shows help information
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} msg - Telegram message object
 */
async function handleHelp(bot, msg) {
    const chatId = msg.chat.id;

    const helpMessage = `
📚 <b>مساعدة TrackIt</b>

<b>🔹 الأوامر:</b>

/start - تهيئة البوت والتسجيل
/track <code>&lt;رابط&gt;</code> - تتبع منتج أمازون
/setprice <code>&lt;الرقم&gt; &lt;السعر&gt;</code> - تحديد سعر التنبيه
/status - عرض منتجاتك المتتبعة
/check - فحص الأسعار يدوياً الآن
/delete <code>&lt;الرقم&gt;</code> - حذف منتج متتبع
/help - عرض هذه الرسالة

<b>🔹 كيف يعمل:</b>
1. أرسل لي رابط منتج أمازون باستخدام /track
2. سأجلب السعر الحالي وأبدأ المراقبة
3. حدد سعرك المستهدف بـ /setprice
4. ستصلك إشعارات عند انخفاض السعر!

<b>🔹 الفحص التلقائي:</b>
• تُفحص الأسعار أسبوعياً (كل أحد الساعة 9 صباحاً IST)
• استخدم /check لتشغيل فحص يدوي في أي وقت

<b>🔹 المواقع المدعومة:</b>
• Amazon.in 🇮🇳
• Amazon.com 🇺🇸

<b>🔹 حدود الخطة المجانية:</b>
• تتبع حتى ${PLANS.FREE.maxProducts} منتجات
• فحص أسبوعي للأسعار

<i>💡 نصيحة: تتبع المنتجات قبل مواسم التخفيضات لأقصى توفير!</i>
    `;

    const helpKeyboard = withNavigation(mainMenuKeyboard, true, true);

    if (msg.message_id && msg.from.is_bot === false) {
        try {
            await bot.editMessageText(helpMessage, {
                chat_id: chatId,
                message_id: msg.message_id,
                parse_mode: 'HTML',
                ...helpKeyboard
            });
            return;
        } catch (err) {
            // Ignore edit error
        }
    }

    await bot.sendMessage(chatId, helpMessage, {
        parse_mode: 'HTML',
        ...helpKeyboard
    });
}

// ===========================================
// /delete COMMAND
// ===========================================

/**
 * Handle /delete command
 * Removes a product from tracking
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} msg - Telegram message object
 * @param {Array} match - Regex match result
 */
async function handleDelete(bot, msg, match) {
    const chatId = msg.chat.id;
    const user = msg.from;
    const productIdStr = match[1]?.trim();

    try {
        if (!productIdStr) {
            await bot.sendMessage(chatId,
                '⚠️ يرجى إدخال رقم المنتج المراد حذفه.\n\n' +
                '<b>الاستخدام:</b> <code>/delete &lt;الرقم&gt;</code>\n\n' +
                'استخدم /status لمعرفة أرقام منتجاتك.',
                { parse_mode: 'HTML' }
            );
            return;
        }

        const productId = parseInt(productIdStr);

        if (isNaN(productId) || productId <= 0) {
            await bot.sendMessage(chatId, '⚠️ رقم منتج غير صحيح.');
            return;
        }

        // Get user
        const dbUser = await queries.findUserByTelegramId(user.id);
        if (!dbUser) {
            await bot.sendMessage(chatId, '⚠️ يرجى استخدام /start أولاً للتسجيل.');
            return;
        }

        // Delete product
        const deleted = await queries.deleteTrackedProduct(productId, dbUser.id);

        if (deleted) {
            await bot.sendMessage(chatId,
                `✅ <b>تم حذف المنتج #${productId} من التتبع.</b>\n\n` +
                `يمكنك الآن تتبع منتج جديد باستخدام /track`,
                { parse_mode: 'HTML' }
            );
            console.log(`🗑️ Product #${productId} deleted by ${user.username || user.id}`);
        } else {
            await bot.sendMessage(chatId,
                '⚠️ المنتج غير موجود أو ليس لديك صلاحية حذفه.\n\n' +
                'استخدم /status لعرض منتجاتك المتتبعة.'
            );
        }

    } catch (error) {
        console.error('Error in /delete command:', error);
        await bot.sendMessage(chatId, '❌ فشل في حذف المنتج. يرجى المحاولة مرة أخرى.');
    }
}

// ===========================================
// /check COMMAND
// ===========================================

/**
 * Handle /check command
 * Manually triggers price check for user's products
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} msg - Telegram message object
 */
async function handleCheck(bot, msg) {
    const chatId = msg.chat.id;
    const user = msg.from;

    try {
        // Get user
        const dbUser = await queries.findUserByTelegramId(user.id);
        if (!dbUser) {
            await bot.sendMessage(chatId, '⚠️ يرجى استخدام /start أولاً للتسجيل.');
            return;
        }

        // Get tracked products
        const products = await queries.getTrackedProductsByUserId(dbUser.id);

        if (products.length === 0) {
            await bot.sendMessage(chatId,
                '📋 لا تتابع أي منتجات حتى الآن.\n\n' +
                'استخدم /track لإضافة منتج أولاً!',
                {
                    parse_mode: 'HTML',
                    ...mainMenuKeyboard
                }
            );
            return;
        }

        // Send processing message
        const processingMsg = await bot.sendMessage(chatId,
            `🔍 <b>جارٍ فحص الأسعار لـ ${products.length} منتج/منتجات...</b>\n\nقد يستغرق هذا لحظة.`,
            { parse_mode: 'HTML' }
        );

        let results = [];

        for (const product of products) {
            try {
                // Add delay between requests
                if (results.length > 0) {
                    await new Promise(r => setTimeout(r, 2000));
                }

                // Scrape current price
                const scraped = await scrapeAmazonProduct(product.amazon_url);
                const oldPrice = product.current_price;
                const newPrice = scraped.price;

                // Update database
                await queries.updateProductPrice(product.id, newPrice, scraped.title);

                // Record price history
                await queries.addPriceHistory(product.id, newPrice);

                const currencySymbol = product.currency === 'INR' ? '₹' :
                    product.currency === 'USD' ? '$' : product.currency;

                // Determine price change
                let priceChange = '';
                if (newPrice < oldPrice) {
                    const drop = ((oldPrice - newPrice) / oldPrice * 100).toFixed(1);
                    priceChange = `📉 -${drop}%`;
                } else if (newPrice > oldPrice) {
                    const increase = ((newPrice - oldPrice) / oldPrice * 100).toFixed(1);
                    priceChange = `📈 +${increase}%`;
                } else {
                    priceChange = '➡️ لا تغيير';
                }

                results.push({
                    success: true,
                    product: product,
                    oldPrice,
                    newPrice,
                    priceChange,
                    currencySymbol
                });

            } catch (error) {
                results.push({
                    success: false,
                    product: product,
                    error: error.message
                });
            }
        }

        // Build results message
        let message = `✅ <b>اكتمل فحص الأسعار!</b>\n\n`;

        for (const result of results) {
            if (result.success) {
                message += `<b>#${result.product.id}</b> ${truncateTitle(result.product.title, 40)}\n`;
                message += `${result.currencySymbol}${formatPrice(result.oldPrice)} ← ${result.currencySymbol}${formatPrice(result.newPrice)} ${result.priceChange}\n\n`;
            } else {
                message += `<b>#${result.product.id}</b> ❌ فشل\n${result.error}\n\n`;
            }
        }

        // Check for price drops that hit target
        const drops = results.filter(r =>
            r.success &&
            r.product.target_price &&
            r.newPrice <= r.product.target_price
        );

        if (drops.length > 0) {
            message += `🎉 <b>${drops.length} منتج/منتجات وصلت للسعر المستهدف!</b>\n`;
        }

        await bot.editMessageText(message, {
            chat_id: chatId,
            message_id: processingMsg.message_id,
            parse_mode: 'HTML',
            ...mainMenuKeyboard
        });

        console.log(`🔍 Manual check by ${user.username || user.id}: ${results.filter(r => r.success).length}/${products.length} successful`);

    } catch (error) {
        console.error('Error in /check command:', error);
        await bot.sendMessage(chatId, '❌ فشل في فحص الأسعار. يرجى المحاولة مرة أخرى.');
    }
}

// ===========================================
// /plans COMMAND
// ===========================================

/**
 * Handle /plans command
 * Shows plan comparison
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} msg - Telegram message object
 */
async function handlePlans(bot, msg) {
    const chatId = msg.chat.id;
    const user = msg.from;

    try {
        // Get user's current plan
        const dbUser = await queries.findUserByTelegramId(user.id);
        const currentPlan = dbUser?.plan || 'FREE';

        const plansMessage = `
📋 <b>خطط TrackIt</b>

${currentPlan === 'FREE' ? '👉 ' : ''}🆓 <b>الخطة المجانية</b> ${currentPlan === 'FREE' ? '(الحالية)' : ''}
━━━━━━━━━━━━━━━━━━
📦 تتبع <b>منتج واحد</b>
⏰ فحص أسبوعي للأسعار (الأحد)
🔔 تنبيهات انخفاض الأسعار
💰 السعر: <b>مجاني للأبد</b>

${currentPlan === 'PRO' ? '👉 ' : ''}⭐ <b>خطة برو</b> ${currentPlan === 'PRO' ? '(الحالية)' : ''}
━━━━━━━━━━━━━━━━━━
📦 تتبع حتى <b>10 منتجات</b>
⏰ فحص <b>يومي</b> للأسعار
🔔 إشعارات ذات أولوية
📊 تتبع سجل الأسعار
🎯 تنبيهات السعر المستهدف
💰 السعر: <b>٩٩ ₹/شهر</b>

${currentPlan === 'FREE' ? `\n⭐ <b>هل أنت مستعد للترقية؟</b>\nاستخدم /upgrade للحصول على بيانات الدفع وبدء طلب الترقية.` : `\n✅ أنت على خطة برو!\n<i>استمتع بالفحص اليومي و10 خانات للمنتجات.</i>`}
        `.trim();

        await bot.sendMessage(chatId, plansMessage, {
            parse_mode: 'HTML',
            ...mainMenuKeyboard
        });

    } catch (error) {
        console.error('Error in /plans command:', error);
        await bot.sendMessage(chatId, '❌ فشل في جلب الخطط. يرجى المحاولة مرة أخرى.');
    }
}

// ===========================================
// /upgrade COMMAND
// ===========================================

/**
 * Handle /upgrade command
 * Starts manual Vodafone Cash upgrade flow
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} msg - Telegram message object
 */
async function handleUpgrade(bot, msg) {
    const chatId = msg.chat.id;
    const user = msg.from;

    try {
        // Get user
        let dbUser = await queries.findUserByTelegramId(user.id);
        if (!dbUser) {
            await bot.sendMessage(chatId, '⚠️ يرجى استخدام /start أولاً للتسجيل.');
            return;
        }

        const upgradeResult = await paymentService.startUpgradeRequest(dbUser);

        if (upgradeResult.status === 'already_pro') {
            await bot.sendMessage(chatId,
                '⭐ <b>أنت بالفعل على خطة برو!</b>\n\n' +
                '📦 تتبع حتى 10 منتجات\n' +
                '⏰ فحص يومي للأسعار\n\n' +
                'استخدم /status لعرض منتجاتك المتتبعة.',
                {
                    parse_mode: 'HTML',
                    ...mainMenuKeyboard
                }
            );
            return;
        }

        if (upgradeResult.status === 'already_pending') {
            const pendingMessage = upgradeResult.proofSubmitted
                ? '⏳ <b>طلبك قيد المراجعة</b>\n\nتم استلام صورة التحويل بالفعل، وسيتم مراجعتها من الإدارة قريباً.'
                : '⏳ <b>طلبك قيد المراجعة</b>\n\nلقد أنشأت طلب ترقية بالفعل. يرجى إرسال صورة التحويل لإكمال المراجعة.';

            await bot.sendMessage(chatId, pendingMessage, {
                parse_mode: 'HTML',
                ...withNavigation(null, true, true)
            });
            return;
        }

        const instructionMessage = buildUpgradeInstructionsMessage(upgradeResult.payment);

        console.log(`💳 Upgrade request created for user: ${user.username || user.id}`);

        await bot.sendMessage(chatId, instructionMessage, {
            parse_mode: 'HTML',
            ...withNavigation(null, true, true)
        });

    } catch (error) {
        console.error('Error in /upgrade command:', error);
        await bot.sendMessage(chatId, '❌ فشل في الترقية. يرجى المحاولة مرة أخرى.');
    }
}

/**
 * Handle payment proof photo
 * Saves proof and forwards it to admin for review
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} msg - Telegram message object
 */
async function handlePaymentPhoto(bot, msg) {
    const chatId = msg.chat.id;
    const user = msg.from;

    try {
        const dbUser = await queries.findUserByTelegramId(user.id);
        if (!dbUser) {
            return;
        }

        const result = await paymentService.submitPaymentProof(dbUser, msg.photo || []);

        if (result.status === 'already_pro') {
            await bot.sendMessage(chatId, '⭐ أنت بالفعل على خطة برو.');
            return;
        }

        if (result.status === 'no_pending_request') {
            await bot.sendMessage(chatId,
                '⚠️ لا يوجد طلب ترقية مفتوح حالياً.\n\nاستخدم /upgrade أولاً للحصول على تعليمات الدفع.',
                { parse_mode: 'HTML' }
            );
            return;
        }

        if (result.status === 'proof_already_submitted') {
            await bot.sendMessage(chatId,
                '⏳ تم استلام صورة التحويل بالفعل، وطلبك قيد المراجعة الآن.',
                { parse_mode: 'HTML' }
            );
            return;
        }

        const adminCaption = [
            '💳 <b>إثبات دفع جديد</b>',
            '',
            `👤 الاسم: ${formatTelegramUserLabel(user)}`,
            `🆔 Telegram ID: <code>${user.id}</code>`,
            `📎 Username: ${user.username ? `@${user.username}` : 'غير متوفر'}`,
            '',
            `للاعتماد استخدم: <code>/approve ${user.id}</code>`
        ].join('\n');

        if (result.adminTelegramId) {
            try {
                await bot.sendPhoto(result.adminTelegramId, result.fileId, {
                    caption: adminCaption,
                    parse_mode: 'HTML'
                });
            } catch (forwardError) {
                console.error('Failed to forward payment proof to admin:', forwardError);
            }
        } else {
            console.warn(`Admin Telegram ID is not configured. Payment proof received from ${user.id}.`);
        }

        console.log(`💳 Payment proof submitted by user: ${user.username || user.id}`);

        await bot.sendMessage(chatId,
            '✅ <b>تم استلام صورة التحويل.</b>\n\nطلبك قيد المراجعة الآن، وسيتم تفعيل برو بعد مراجعة الإدارة.',
            {
                parse_mode: 'HTML',
                ...withNavigation(null, true, true)
            }
        );
    } catch (error) {
        console.error('Error handling payment proof photo:', error);
        await bot.sendMessage(chatId, '❌ تعذّر استلام صورة التحويل. حاول مرة أخرى.');
    }
}

/**
 * Handle /approve command
 * Admin-only command for approving manual upgrades
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} msg - Telegram message object
 * @param {Array} match - Regex match result
 */
async function handleApprove(bot, msg, match) {
    const chatId = msg.chat.id;
    const adminUser = msg.from;
    const telegramId = match[1]?.trim();

    try {
        if (!paymentService.isAdmin(adminUser.id)) {
            await bot.sendMessage(chatId, '⛔ هذا الأمر متاح للإدارة فقط.');
            return;
        }

        if (!telegramId) {
            await bot.sendMessage(chatId,
                '⚠️ يرجى إدخال Telegram ID.\n\n<b>الاستخدام:</b> <code>/approve &lt;telegramId&gt;</code>',
                { parse_mode: 'HTML' }
            );
            return;
        }

        const parsedTelegramId = Number(telegramId);
        if (Number.isNaN(parsedTelegramId) || parsedTelegramId <= 0) {
            await bot.sendMessage(chatId, '⚠️ رقم Telegram ID غير صحيح.');
            return;
        }

        const dbUser = await queries.findUserByTelegramId(parsedTelegramId);
        if (!dbUser) {
            await bot.sendMessage(chatId, '⚠️ المستخدم غير موجود.');
            return;
        }

        if (dbUser.payment_status !== 'pending') {
            await bot.sendMessage(chatId, '⚠️ لا يوجد طلب ترقية معلق لهذا المستخدم.');
            return;
        }

        if (!dbUser.payment_proof_file_id) {
            await bot.sendMessage(chatId, '⚠️ لا يمكن الاعتماد قبل استلام صورة التحويل.');
            return;
        }

        let updatedUser;

        if (dbUser.plan !== 'PRO') {
            await queries.upgradeUserPlan(dbUser.id, 'PRO', 10, 'DAILY');
            updatedUser = await queries.extendSubscription(dbUser, 30);
        } else {
            updatedUser = await queries.extendSubscription(dbUser, 30);
        }

        await queries.updateUserPaymentStatus(dbUser.id, 'approved');

        console.log(`✅ Upgrade approved by admin for Telegram user: ${telegramId} until ${updatedUser.subscription_expires_at}`);

        await bot.sendMessage(chatId,
            `✅ تم اعتماد الدفع للمستخدم <code>${telegramId}</code>.\n\nينتهي الاشتراك في: <code>${updatedUser.subscription_expires_at}</code>`,
            { parse_mode: 'HTML' }
        );

        try {
            await bot.sendMessage(parsedTelegramId,
                '🎉 <b>تمت الموافقة على طلبك!</b>\n\nأنت الآن على خطة <b>PRO</b> لمدة 30 يوماً.',
                {
                    parse_mode: 'HTML',
                    ...mainMenuKeyboard
                }
            );
        } catch (notifyError) {
            console.error(`Failed to notify approved user ${telegramId}:`, notifyError);
        }

    } catch (error) {
        console.error('Error in /approve command:', error);
        await bot.sendMessage(chatId, '❌ فشل اعتماد الطلب. حاول مرة أخرى.');
    }
}

// ===========================================
// HELPER FUNCTIONS
// ===========================================

/**
 * Truncate title to specified length
 * @param {string} title - Product title
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated title
 */
function truncateTitle(title, maxLength = 50) {
    if (!title) return 'منتج غير معروف';
    if (title.length <= maxLength) return title;
    return title.substring(0, maxLength - 3) + '...';
}

/**
 * Format price with proper decimals
 * @param {number} price - Price value
 * @returns {string} Formatted price
 */
function formatPrice(price) {
    if (price === null || price === undefined) return 'غير متاح';
    return price.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function buildUpgradeInstructionsMessage(payment) {
    return [
        '💎 <b>الترقية إلى برو عبر فودافون كاش</b>',
        '',
        'لإكمال الترقية، حوّل المبلغ التالي ثم أرسل صورة التحويل هنا:',
        '',
        `📱 رقم فودافون كاش: <code>${payment.vodafoneCashNumber}</code>`,
        `💰 المبلغ المطلوب: <b>${payment.amount}</b>`,
        '',
        'بعد التحويل، أرسل <b>سكرين شوت</b> واضح داخل نفس المحادثة.',
        'سيتم مراجعة الطلب من الإدارة، وبعد الموافقة ستصبح على خطة <b>PRO</b>.',
        '',
        '⚠️ لا ترسل أكثر من طلب واحد قبل انتهاء المراجعة.'
    ].join('\n');
}

function formatTelegramUserLabel(user) {
    const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
    return fullName || user.username || `User ${user.id}`;
}

function formatExpiryDateArabic(isoOrDate) {
    try {
        const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
        return d.toLocaleString('ar-EG', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch {
        return String(isoOrDate || '');
    }
}

// ===========================================
// /downgrade COMMAND
// ===========================================

/**
 * Handle /downgrade command
 * Resets user to FREE plan and enforces product limits
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} msg - Telegram message object
 */
async function handleDowngrade(bot, msg) {
    const chatId = msg.chat.id;
    const user = msg.from;

    try {
        if (!paymentService.isAdmin(user.id)) {
            await bot.sendMessage(
                chatId,
                '❌ لا يمكنك الرجوع للخطة المجانية يدوياً، سيتم التحويل تلقائياً عند انتهاء الاشتراك'
            );
            return;
        }

        // Get user
        const dbUser = await queries.findUserByTelegramId(user.id);
        if (!dbUser) {
            await bot.sendMessage(chatId, '⚠️ يرجى استخدام /start أولاً للتسجيل.');
            return;
        }

        // Check if already FREE
        if (dbUser.plan === 'FREE' || !dbUser.plan) {
            await bot.sendMessage(chatId,
                '🆓 <b>أنت بالفعل على الخطة المجانية!</b>\n\n' +
                'استخدم /plans لعرض الخطط المتاحة.',
                {
                    parse_mode: 'HTML',
                    ...mainMenuKeyboard
                }
            );
            return;
        }

        // Get current tracked products
        const products = await queries.getTrackedProductsByUserId(dbUser.id);
        const freeLimit = PLANS.FREE.maxProducts;

        // Check if user has more products than FREE limit allows
        if (products.length > freeLimit) {
            const sortedByAge = [...products].sort((a, b) =>
                new Date(a.created_at) - new Date(b.created_at)
            );
            const productsToKeep = sortedByAge.slice(0, freeLimit);
            const productsToDelete = sortedByAge.slice(freeLimit);

            // Delete excess products
            for (const p of productsToDelete) {
                await queries.deleteTrackedProduct(p.id, dbUser.id);
            }

            // Downgrade plan
            await queries.downgradeUserPlan(dbUser.id);

            let message = `⬇️ <b>تم التخفيض إلى الخطة المجانية</b>\n\n`;
            message += `تم تخفيض حسابك.\n\n`;
            message += `⚠️ <b>المنتجات المحذوفة:</b>\n`;

            for (const p of productsToDelete) {
                message += `• #${p.id} ${truncateTitle(p.title, 40)}\n`;
            }

            message += `\n✅ <b>المنتجات المحتفظ بها (الأقدم ${freeLimit}):</b>\n`;
            for (const p of productsToKeep) {
                message += `• #${p.id} ${truncateTitle(p.title, 40)}\n`;
            }

            message += `\n📋 <b>حدود الخطة المجانية:</b>\n`;
            message += `• تتبع ${freeLimit} منتج\n`;
            message += `• فحص أسبوعي للأسعار\n\n`;
            message += `<i>استخدم /upgrade في أي وقت لاستعادة مزايا برو!</i>`;

            const downgradeKeyboard = withNavigation(null, true, true);

            if (msg.message_id && msg.from.is_bot === false) {
                try {
                    await bot.editMessageText(message, {
                        chat_id: chatId,
                        message_id: msg.message_id,
                        parse_mode: 'HTML',
                        ...downgradeKeyboard
                    });
                    console.log(`⬇️ User downgraded: ${user.username || user.id}, deleted ${productsToDelete.length} products`);
                    return;
                } catch (err) { }
            }

            await bot.sendMessage(chatId, message, {
                parse_mode: 'HTML',
                ...downgradeKeyboard
            });

            console.log(`⬇️ User downgraded: ${user.username || user.id}, deleted ${productsToDelete.length} products`);

        } else {
            // No products to delete, just downgrade
            await queries.downgradeUserPlan(dbUser.id);

            const message = `
⬇️ <b>تم التخفيض إلى الخطة المجانية</b>

تم تخفيض حسابك بنجاح.

📋 <b>حدود الخطة المجانية:</b>
• تتبع ${freeLimit} منتج
• فحص أسبوعي للأسعار (الأحد)

تم الاحتفاظ بـ ${products.length} منتج/منتجات متتبعة.

<i>استخدم /upgrade في أي وقت لاستعادة مزايا برو!</i>
            `.trim();

            const downgradeKeyboard = withNavigation(null, true, true);

            if (msg.message_id && msg.from.is_bot === false) {
                try {
                    await bot.editMessageText(message, {
                        chat_id: chatId,
                        message_id: msg.message_id,
                        parse_mode: 'HTML',
                        ...downgradeKeyboard
                    });
                    console.log(`⬇️ User downgraded: ${user.username || user.id}`);
                    return;
                } catch (err) { }
            }

            await bot.sendMessage(chatId, message, {
                parse_mode: 'HTML',
                ...downgradeKeyboard
            });

            console.log(`⬇️ User downgraded: ${user.username || user.id}`);
        }

    } catch (error) {
        console.error('Error in /downgrade command:', error);
        await bot.sendMessage(chatId, '❌ فشل في التخفيض. يرجى المحاولة مرة أخرى.');
    }
}

/**
 * Handle CHECK callback
 * Checks price for a specific product and refreshes list
 * @param {TelegramBot} bot 
 * @param {Object} msg 
 * @param {number} productId 
 * @param {number} page 
 */
async function handleCheckCallback(bot, msg, productId, page) {
    const chatId = msg.chat.id;
    const user = msg.from;

    try {
        const dbUser = await queries.findUserByTelegramId(user.id);
        if (!dbUser) return;

        // Verify ownership
        const products = await queries.getTrackedProductsByUserId(dbUser.id);
        const product = products.find(p => p.id === productId);

        if (!product) {
            await bot.answerCallbackQuery(msg.id, { text: '❌ المنتج غير موجود', show_alert: true });
            return;
        }

        // Notify processing
        await bot.answerCallbackQuery(msg.id, { text: '🔍 جارٍ فحص السعر...', show_alert: false });

        // Check price
        try {
            const scraped = await scrapeAmazonProduct(product.amazon_url);
            await queries.updateProductPrice(productId, scraped.price, scraped.title);
            await queries.addPriceHistory(productId, scraped.price);

            // Notify result
            const oldPrice = product.current_price;
            const newPrice = scraped.price;
            let changeText = 'لا تغيير';

            if (newPrice < oldPrice) changeText = `📉 انخفاض: ${((oldPrice - newPrice) / oldPrice * 100).toFixed(1)}%`;
            if (newPrice > oldPrice) changeText = `📈 ارتفاع: ${((newPrice - oldPrice) / oldPrice * 100).toFixed(1)}%`;

            const currencySymbol = product.currency === 'INR' ? '₹' : '$';

            await bot.answerCallbackQuery(msg.id, {
                text: `✅ تم الفحص!\nالسعر: ${currencySymbol}${formatPrice(newPrice)}\n${changeText}`,
                show_alert: true
            });

        } catch (err) {
            await bot.answerCallbackQuery(msg.id, { text: `❌ فشل الفحص: ${err.message}`, show_alert: true });
        }

        // Refresh list
        await showProductList(bot, chatId, dbUser.id, page, msg.message_id);

    } catch (error) {
        console.error('Check callback error:', error);
    }
}

/**
 * Handle DELETE callback
 * Deletes a product and refreshes list
 */
async function handleDeleteCallback(bot, msg, productId, page) {
    const chatId = msg.chat.id;
    const user = msg.from;

    try {
        const dbUser = await queries.findUserByTelegramId(user.id);
        if (!dbUser) return;

        // Verify ownership & Delete
        const deleted = await queries.deleteTrackedProduct(productId, dbUser.id);

        if (deleted) {
            await bot.answerCallbackQuery(msg.id, { text: '🗑️ تم حذف المنتج', show_alert: true });
            await showProductList(bot, chatId, dbUser.id, page, msg.message_id);
        } else {
            await bot.answerCallbackQuery(msg.id, { text: '❌ تعذّر حذف المنتج', show_alert: true });
        }

    } catch (error) {
        console.error('Delete callback error:', error);
    }
}

module.exports = {
    handleStart,
    handleTrack,
    handleSetPrice,
    handleStatus,
    handleAdminStats,
    handleAdminUsers,
    handleAdminPayments,
    handleHelp,
    handleDelete,
    handleCheck,
    handlePlans,
    handleUpgrade,
    handlePaymentPhoto,
    handleApprove,
    handleDowngrade,
    showProductList,
    handleCheckCallback,
    handleDeleteCallback
};
