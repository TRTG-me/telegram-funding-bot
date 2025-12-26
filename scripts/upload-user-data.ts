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
    {
        telegramId: 123456789,
        nickname: 'USER_1',

        // Binance Mainnet
        binanceApiKey: 'REPLACE_ME',
        binanceApiSecret: 'REPLACE_ME',

        // Binance Testnet
        binanceApiKeyTest: 'REPLACE_ME',
        binanceApiSecretTest: 'REPLACE_ME',

        // ... и так далее для всех остальных полей
    },
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
