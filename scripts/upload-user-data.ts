/**
 * 🔐 СКРИПТ ДЛЯ ЗАЛИВКИ ДАННЫХ ПОЛЬЗОВАТЕЛЕЙ В БД
 * 
 * Этот скрипт позволяет добавлять или обновлять данные пользователей в базе данных.
 * Все API ключи автоматически шифруются перед сохранением.
 * 
 * ЗАПУСК:
 * npx ts-node scripts/upload-user-data.ts
 * 
 * ВАЖНО:
 * - Если пользователь с таким telegramId существует - данные будут ОБНОВЛЕНЫ
 * - Все ключи автоматически шифруются
 * - Пустые поля (null/undefined) не перезаписывают существующие данные
 */

import { PrismaClient } from '@prisma/client';
import { EncryptionService } from '../src/common/encryption.service';

const prisma = new PrismaClient();

// ============================================================================
// 📝 КОНФИГУРАЦИЯ ПОЛЬЗОВАТЕЛЕЙ
// ============================================================================
// Добавьте сюда данные пользователей, которых нужно загрузить в БД

interface UserData {
    telegramId: number;
    nickname?: string;

    // --- MAINNET KEYS ---
    binanceApiKey?: string;
    binanceApiSecret?: string;

    paradexAccountAddress?: string;
    paradexPrivateKey?: string;

    lighterL1Address?: string;
    lighterPrivateKey?: string;
    lighterApiKeyIndex?: number;
    lighterAccountIndex?: number;

    extendedApiKey?: string;
    extendedStarkPublicKey?: string;
    extendedStarkPrivateKey?: string;
    extendedVaultId?: number;

    hlPrivateKey?: string;
    hlWalletAddress?: string;
    hlAccountEth?: string;

    // --- TESTNET KEYS ---
    binanceApiKeyTest?: string;
    binanceApiSecretTest?: string;

    paradexTestAccountAddress?: string;
    paradexTestPrivateKey?: string;

    hlTestPrivateKey?: string;
    hlTestWalletAddress?: string;
    hlTestAccountEth?: string;

    extendedTestApiKey?: string;
    extendedTestStarkPublicKey?: string;
    extendedTestStarkPrivateKey?: string;
    extendedTestVaultId?: number;

    lighterTestL1Address?: string;
    lighterTestPrivateKey?: string;
    lighterTestApiKeyIndex?: number;
    lighterTestAccountIndex?: number;
}

const USERS_TO_UPLOAD: UserData[] = [
    // ========================================
    // ПРИМЕР 1: Полная конфигурация
    // ========================================
    {
        telegramId: 334987233,
        nickname: 'TORTUGA',

        // Binance Mainnet
        binanceApiKey: 'YQ7qTdN4supaX502t5sOm1buKXpJ7eVgmDJM9raYNZLsHpqmHSstLpxxIRxXe4g6',
        binanceApiSecret: 'eLNY9PmfPPYT1eSBrePSIL8FmPaw5Soqlby0T5vjxaZUsr5hWAftu1RBvPMqhijp',

        // Binance Testnet
        binanceApiKeyTest: 'BX3XOerBi5uB8zetZkIIXGyTEwpMuZV6u2PngB8HWDiZFLl7XVQe2wvyO0stV1Ry',
        binanceApiSecretTest: 'sZIO0E2DksI11RuBFxRhNBYFZkWWiGLiZvw3jDbiONaTMAj03hWh2rKV64z9sz97',

        // Hyperliquid Mainnet
        hlPrivateKey: '0xa5e89bf901c7b10952910ba62f36ef43bd319a04e7e366dd7be73cf8465402cc',
        hlWalletAddress: '0x98e0d70e8fb9E000177FcE76DFdF4e053e26c1ff',
        hlAccountEth: '0xF3Af929c886961cEC671A5391dF1EfC3005AAF64',

        // Hyperliquid Testnet
        hlTestPrivateKey: '0xc89ef8d315fc5a97396c6ca534978bfaaa68691d59c2d25cde4e7b589745e912',
        hlTestWalletAddress: '0xd457f263Df97f7f50b40056fDCb562205eEaffcd',
        hlTestAccountEth: '0xD5Ff1A5E83A92E12ccbC7db466D94be02Bd3EAfC',

        // Paradex Mainnet
        paradexAccountAddress: '0x3df717b103efd62fc230870bd7b469877ba3f4595821da673a675116f700ccf',
        paradexPrivateKey: '0x1c6c679b63a3a5ddc06bfebcea92ae4b43a7d30c65b1b6c786eecc856d25b95',

        // Paradex Testnet
        paradexTestAccountAddress: '0x704f1bcbbc2cc1a73dc5ef69aa654d19f18725eadf194449860a5825cc52db8',
        paradexTestPrivateKey: '0x23f3672ec9246b9e817dfd0fc37bd622a656789e8efbef2d74059dcbe521ca1',

        // Lighter Mainnet
        lighterL1Address: '0xF3Af929c886961cEC671A5391dF1EfC3005AAF64',
        lighterPrivateKey: 'fb6a1bc0c17b4a1e44a86779e069332d28679cb2ddf376bddf83be410f3c47cd4b6951c14fb1c470',
        lighterApiKeyIndex: 12,
        lighterAccountIndex: 342109,

        // Lighter Testnet
        lighterTestL1Address: '0x995aFEA0DB256397B4e0f468A3a449F5998e546B',
        lighterTestPrivateKey: '03ff8667a237017762487ce8c3dbd1c70fa60f273f6bdb284387813217cddc4ffa950d8fd9487837',
        lighterTestApiKeyIndex: 12,
        lighterTestAccountIndex: 723,

        // Extended Mainnet
        extendedApiKey: 'cba781913b289a55ec51f5a79011e19b',
        extendedStarkPublicKey: '0x1d1cc041733a9f4c1556fa82aa424127c3dde4b5bcfc8d3b22f81d47bf2c0db',
        extendedStarkPrivateKey: '0x14111ab7a98f82c145b5a24d0346907c24d5a08e4689132d1ad8679ee80e551',
        extendedVaultId: 216686,

        // Extended Testnet
        extendedTestApiKey: '12d14ff6ed5317aaf1ec1a081343ffe1',
        extendedTestStarkPublicKey: '0x7c208af52fe07036bee3ff14007f5ff4d537d30fb93aaad2e503b263a9d965f',
        extendedTestStarkPrivateKey: '0x4cf1fc88dd0f5c7dc1b9e8a8e2846d42c0a46deb854cdf15ab614112da9d547',
        extendedTestVaultId: 500805,
    },

    // ========================================
    // ПРИМЕР 2: Минимальная конфигурация (только Binance Testnet)
    // ========================================
    // {
    //     telegramId: 987654321,
    //     nickname: 'TestUser',
    //     binanceApiKeyTest: 'TEST_KEY',
    //     binanceApiSecretTest: 'TEST_SECRET',
    // },

    // ========================================
    // ДОБАВЬТЕ СВОИХ ПОЛЬЗОВАТЕЛЕЙ ЗДЕСЬ
    // ========================================
];

// ============================================================================
// 🔐 ФУНКЦИИ ШИФРОВАНИЯ
// ============================================================================

const KEYS_TO_ENCRYPT = [
    'binanceApiKey', 'binanceApiSecret',
    'paradexPrivateKey',
    'lighterPrivateKey',
    'extendedApiKey', 'extendedStarkPrivateKey', 'hlPrivateKey',
    // Testnet
    'binanceApiKeyTest', 'binanceApiSecretTest',
    'paradexTestPrivateKey', 'hlTestPrivateKey',
    'extendedTestApiKey', 'extendedTestStarkPrivateKey',
    'lighterTestPrivateKey'
];

function encryptUserData(data: UserData): any {
    const encrypted: any = { ...data };

    for (const key of KEYS_TO_ENCRYPT) {
        if (encrypted[key] && typeof encrypted[key] === 'string') {
            encrypted[key] = EncryptionService.encrypt(encrypted[key]);
        }
    }

    return encrypted;
}

// ============================================================================
// 📤 ФУНКЦИЯ ЗАГРУЗКИ ДАННЫХ
// ============================================================================

async function uploadUser(userData: UserData) {
    try {
        console.log(`\n📤 Обработка пользователя: ${userData.nickname || userData.telegramId}`);

        // Проверяем, существует ли пользователь
        const existing = await prisma.user.findUnique({
            where: { telegramId: BigInt(userData.telegramId) }
        });

        // Шифруем данные
        const encryptedData = encryptUserData(userData);

        // Убираем id и telegramId из данных для update/create
        const { telegramId, ...dataWithoutId } = encryptedData;

        // Для обновления: явно указываем все поля (даже если undefined -> null)
        // Это гарантирует полную перезапись данных
        const updateData: any = {};

        // Список всех полей из UserData (кроме telegramId)
        const allFields = [
            'nickname',
            // Mainnet
            'binanceApiKey', 'binanceApiSecret',
            'paradexAccountAddress', 'paradexPrivateKey',
            'lighterL1Address', 'lighterPrivateKey', 'lighterApiKeyIndex', 'lighterAccountIndex',
            'extendedApiKey', 'extendedStarkPublicKey', 'extendedStarkPrivateKey', 'extendedVaultId',
            'hlPrivateKey', 'hlWalletAddress', 'hlAccountEth',
            // Testnet
            'binanceApiKeyTest', 'binanceApiSecretTest',
            'paradexTestAccountAddress', 'paradexTestPrivateKey',
            'hlTestPrivateKey', 'hlTestWalletAddress', 'hlTestAccountEth',
            'extendedTestApiKey', 'extendedTestStarkPublicKey', 'extendedTestStarkPrivateKey', 'extendedTestVaultId',
            'lighterTestL1Address', 'lighterTestPrivateKey', 'lighterTestApiKeyIndex', 'lighterTestAccountIndex',
        ];

        // Заполняем updateData: если поле есть в userData - берем его, иначе null
        for (const field of allFields) {
            updateData[field] = dataWithoutId[field] !== undefined ? dataWithoutId[field] : null;
        }

        if (existing) {
            console.log(`   ℹ️  Пользователь существует (ID: ${existing.id})`);
            console.log(`   🔄 Полное обновление всех полей...`);

            await prisma.user.update({
                where: { telegramId: BigInt(userData.telegramId) },
                data: updateData
            });

            console.log(`   ✅ Данные успешно обновлены (все поля перезаписаны)`);
        } else {
            console.log(`   ℹ️  Пользователь не найден`);
            console.log(`   ➕ Создание нового пользователя...`);

            await prisma.user.create({
                data: {
                    telegramId: BigInt(userData.telegramId),
                    ...updateData
                }
            });

            console.log(`   ✅ Пользователь успешно создан`);
        }

        // Показываем статистику настроенных ключей
        const stats = {
            binance: !!(userData.binanceApiKey || userData.binanceApiKeyTest),
            hyperliquid: !!(userData.hlPrivateKey || userData.hlTestPrivateKey),
            paradex: !!(userData.paradexPrivateKey || userData.paradexTestPrivateKey),
            lighter: !!(userData.lighterPrivateKey || userData.lighterTestPrivateKey),
            extended: !!(userData.extendedApiKey || userData.extendedTestApiKey),
        };

        console.log(`   📊 Настроенные биржи:`);
        console.log(`      Binance:     ${stats.binance ? '✅' : '❌'}`);
        console.log(`      Hyperliquid: ${stats.hyperliquid ? '✅' : '❌'}`);
        console.log(`      Paradex:     ${stats.paradex ? '✅' : '❌'}`);
        console.log(`      Lighter:     ${stats.lighter ? '✅' : '❌'}`);
        console.log(`      Extended:    ${stats.extended ? '✅' : '❌'}`);

    } catch (error: any) {
        console.error(`   ❌ ОШИБКА при обработке пользователя ${userData.telegramId}:`, error.message);
        throw error;
    }
}

// ============================================================================
// ✅ ВАЛИДАЦИЯ ДАННЫХ
// ============================================================================

function validateUsers(users: UserData[]) {
    const telegramIds = new Map<number, string>();
    const duplicates: Array<{ id: number, users: string[] }> = [];

    for (const user of users) {
        const nickname = user.nickname || `User_${user.telegramId}`;

        if (telegramIds.has(user.telegramId)) {
            // Нашли дубликат
            const existingDup = duplicates.find(d => d.id === user.telegramId);
            if (existingDup) {
                existingDup.users.push(nickname);
            } else {
                duplicates.push({
                    id: user.telegramId,
                    users: [telegramIds.get(user.telegramId)!, nickname]
                });
            }
        }
        telegramIds.set(user.telegramId, nickname);
    }

    if (duplicates.length > 0) {
        console.error('\n❌ КРИТИЧЕСКАЯ ОШИБКА: Найдены дубликаты telegramId!');
        console.error('═'.repeat(60));

        duplicates.forEach(dup => {
            console.error(`\n   telegramId: ${dup.id}`);
            console.error(`   Конфликтующие пользователи:`);
            dup.users.forEach((name, idx) => {
                console.error(`     ${idx + 1}. ${name}`);
            });
        });

        console.error('\n⚠️  ВАЖНО:');
        console.error('   - Каждый telegramId должен быть УНИКАЛЬНЫМ');
        console.error('   - При дубликатах второй пользователь ПЕРЕЗАПИШЕТ первого');
        console.error('   - Исправьте массив USERS_TO_UPLOAD и запустите снова');
        console.error('═'.repeat(60));
        process.exit(1);
    }
}

// ============================================================================
// 🚀 ГЛАВНАЯ ФУНКЦИЯ
// ============================================================================

async function main() {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  🔐 СКРИПТ ЗАГРУЗКИ ДАННЫХ ПОЛЬЗОВАТЕЛЕЙ В БД             ║');
    console.log('╚════════════════════════════════════════════════════════════╝');

    console.log(`\n📋 Всего пользователей для загрузки: ${USERS_TO_UPLOAD.length}`);

    if (USERS_TO_UPLOAD.length === 0) {
        console.log('\n⚠️  ПРЕДУПРЕЖДЕНИЕ: Список пользователей пуст!');
        console.log('   Отредактируйте массив USERS_TO_UPLOAD в этом файле.');
        return;
    }

    // Проверяем на дубликаты telegramId
    validateUsers(USERS_TO_UPLOAD);

    // Проверяем ENCRYPTION_KEY
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        console.error('\n❌ ОШИБКА: ENCRYPTION_KEY не настроен или имеет неверную длину!');
        console.error('   ENCRYPTION_KEY должен быть строкой из 32 символов.');
        console.error('   Проверьте файл .env');
        process.exit(1);
    }

    console.log('\n🔐 ENCRYPTION_KEY найден и валиден');

    let successCount = 0;
    let errorCount = 0;

    // Загружаем каждого пользователя
    for (const userData of USERS_TO_UPLOAD) {
        try {
            await uploadUser(userData);
            successCount++;
        } catch (error) {
            errorCount++;
        }
    }

    console.log('\n' + '═'.repeat(60));
    console.log('📊 ИТОГОВАЯ СТАТИСТИКА:');
    console.log('═'.repeat(60));
    console.log(`✅ Успешно обработано: ${successCount}`);
    console.log(`❌ Ошибок:             ${errorCount}`);
    console.log(`📝 Всего:              ${USERS_TO_UPLOAD.length}`);
    console.log('═'.repeat(60));

    if (errorCount === 0) {
        console.log('\n🎉 Все пользователи успешно загружены!');
    } else {
        console.log('\n⚠️  Некоторые пользователи не были загружены. Проверьте ошибки выше.');
    }
}

// ============================================================================
// 🎬 ЗАПУСК
// ============================================================================

main()
    .catch((error) => {
        console.error('\n💥 КРИТИЧЕСКАЯ ОШИБКА:', error);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
        console.log('\n👋 Отключение от базы данных...');
        console.log('✅ Готово!\n');
    });
