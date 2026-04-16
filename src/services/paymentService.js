const queries = require('../db/queries');

const DEFAULT_PAYMENT_NUMBER = '01000000000';
const DEFAULT_PAYMENT_AMOUNT = '99';

function getPaymentConfig() {
    return {
        vodafoneCashNumber: process.env.VODAFONE_CASH_NUMBER || DEFAULT_PAYMENT_NUMBER,
        amount: process.env.VODAFONE_CASH_AMOUNT || DEFAULT_PAYMENT_AMOUNT,
        adminTelegramId: process.env.ADMIN_TELEGRAM_ID ? Number(process.env.ADMIN_TELEGRAM_ID) : null
    };
}

function isAdmin(telegramId) {
    const { adminTelegramId } = getPaymentConfig();
    return Boolean(adminTelegramId) && Number(telegramId) === adminTelegramId;
}

async function startUpgradeRequest(dbUser) {
    if (dbUser.plan === 'PRO') {
        return { status: 'already_pro' };
    }

    if (dbUser.payment_status === 'pending') {
        return {
            status: 'already_pending',
            proofSubmitted: Boolean(dbUser.payment_proof_file_id)
        };
    }

    const updatedUser = await queries.createPendingPaymentRequest(dbUser.id);

    return {
        status: 'pending_created',
        user: updatedUser,
        payment: getPaymentConfig()
    };
}

async function submitPaymentProof(dbUser, photo) {
    if (dbUser.plan === 'PRO') {
        return { status: 'already_pro' };
    }

    if (dbUser.payment_status !== 'pending') {
        return { status: 'no_pending_request' };
    }

    if (dbUser.payment_proof_file_id) {
        return { status: 'proof_already_submitted' };
    }

    const largestPhoto = photo[photo.length - 1];
    const updatedUser = await queries.savePaymentProof(dbUser.id, largestPhoto.file_id);

    return {
        status: 'proof_saved',
        user: updatedUser,
        adminTelegramId: getPaymentConfig().adminTelegramId,
        fileId: largestPhoto.file_id
    };
}

async function approveUpgradeByTelegramId(telegramId) {
    const parsedTelegramId = Number(telegramId);

    if (Number.isNaN(parsedTelegramId) || parsedTelegramId <= 0) {
        return { status: 'invalid_telegram_id' };
    }

    const dbUser = await queries.findUserByTelegramId(parsedTelegramId);
    if (!dbUser) {
        return { status: 'user_not_found' };
    }

    if (dbUser.plan === 'PRO') {
        return { status: 'already_pro', user: dbUser };
    }

    if (dbUser.payment_status !== 'pending') {
        return { status: 'no_pending_request', user: dbUser };
    }

    if (!dbUser.payment_proof_file_id) {
        return { status: 'proof_missing', user: dbUser };
    }

    const upgradedUser = await queries.upgradeUserPlan(dbUser.id, 'PRO', 10, 'DAILY');

    return {
        status: 'approved',
        user: upgradedUser
    };
}

module.exports = {
    getPaymentConfig,
    isAdmin,
    startUpgradeRequest,
    submitPaymentProof,
    approveUpgradeByTelegramId
};
