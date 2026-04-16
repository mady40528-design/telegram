const { sendMessage } = require('../bot');
const queries = require('../db/queries');

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

async function maybeSendReminderForUser(user) {
    if (!user || user.plan !== 'PRO') {
        return { sent: false, reason: 'not_pro' };
    }

    if (!queries.isSubscriptionActive(user)) {
        await queries.downgradeUserPlan(user.id);
        return { sent: false, reason: 'expired_downgraded' };
    }

    const remainingDays = queries.getRemainingDays(user);

    if (remainingDays !== 3 && remainingDays !== 1) {
        return { sent: false, reason: 'not_threshold' };
    }

    if (user.subscription_last_reminder_days === remainingDays) {
        return { sent: false, reason: 'already_reminded' };
    }

    const expiryText = formatExpiryDateArabic(user.subscription_expires_at);

    const message = remainingDays === 3
        ? `⚠️ <b>تنبيه مهم</b>\n\nمتبقي <b>3 أيام</b> على انتهاء اشتراك برو.\n📅 تاريخ الانتهاء: <b>${expiryText}</b>\n\n🔄 لتجديد الاشتراك استخدم /upgrade`
        : `🚨 <b>تذكير عاجل</b>\n\nمتبقي <b>يوم واحد</b> على انتهاء اشتراك برو.\n📅 تاريخ الانتهاء: <b>${expiryText}</b>\n\n🔄 لتجديد الاشتراك استخدم /upgrade`;

    await sendMessage(user.telegram_id, message, { disable_web_page_preview: true });
    await queries.setSubscriptionReminderState(user.id, remainingDays);

    return { sent: true, remainingDays };
}

async function runExpirationReminders() {
    const users = await queries.getAllActiveUsers();
    const proUsers = (users || []).filter(u => u.plan === 'PRO');

    for (const u of proUsers) {
        try {
            await maybeSendReminderForUser(u);
        } catch (err) {
            console.error(`Reminder failed for user ${u.telegram_id}:`, err.message);
        }
    }
}

module.exports = {
    maybeSendReminderForUser,
    runExpirationReminders
};

