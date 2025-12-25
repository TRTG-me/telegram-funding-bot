import { PrismaClient, User } from '@prisma/client';
import { EncryptionService } from '../../common/encryption.service';

const prisma = new PrismaClient();

export class UserService {

    // === CASHE: UserId -> Decrypted User Object ===
    private userCache = new Map<number, { user: User, timestamp: number }>();
    private readonly CACHE_TTL = 1000 * 60 * 5; // 5 минут кеш

    // Получить пользователя (с кешированием)
    async getUser(telegramId: number): Promise<User | null> {
        if (!telegramId) return null;

        // 1. Проверка кеша
        const cached = this.userCache.get(telegramId);
        if (cached && (Date.now() - cached.timestamp < this.CACHE_TTL)) {
            return cached.user;
        }

        // 2. Запрос в БД
        try {
            const user = await prisma.user.findUnique({
                where: { telegramId: BigInt(telegramId) }
            });

            if (!user) return null;

            // 3. Расшифровка и сохранение в кеш
            const decrypted = this.decryptUserKeys(user);
            this.userCache.set(telegramId, { user: decrypted, timestamp: Date.now() });

            return decrypted;
        } catch (e) {
            console.error('DB Error getUserByTelegramId:', e);
            return null;
        }
    }

    // Совместимость с текущим кодом (алиас)
    async getUserByTelegramId(telegramId: number): Promise<User | null> {
        return this.getUser(telegramId);
    }

    // Проверка доступа (существует ли в БД + Кеш)
    async hasAccess(telegramId: number): Promise<boolean> {
        if (!telegramId) return false;

        // Сначала быстрый чек в кеше
        if (this.userCache.has(telegramId)) return true;

        try {
            const count = await prisma.user.count({
                where: { telegramId: BigInt(telegramId) }
            });
            return count > 0;
        } catch (e) {
            console.error('DB Error hasAccess:', e);
            return false;
        }
    }

    // Очистка кеша для пользователя (вызывать при обновлении данных)
    clearCache(telegramId: number) {
        this.userCache.delete(telegramId);
    }

    // Создать или обновить пользователя (с зашифровкой)
    async upsertUser(data: Partial<User>) {
        ifWithoutId(data);

        // Шифруем данные перед сохранением
        const encryptedData = this.encryptUserKeys(data);

        // Prisma требует bigint
        const tId = BigInt(data.telegramId as any);

        // Удаляем id из create/update данных, чтобы не было конфликта (id автоинкремент)
        // Но telegramId нужен для where
        const { id, telegramId, ...restData } = encryptedData;

        return await prisma.user.upsert({
            where: { telegramId: tId },
            update: restData,
            create: {
                telegramId: tId,
                ...restData
            }
        });
    }

    // === Helpers ===

    private encryptUserKeys(data: any): any {
        const keysToEncrypt = [
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

        const newData = { ...data };
        for (const key of keysToEncrypt) {
            if (newData[key] && typeof newData[key] === 'string') {
                newData[key] = EncryptionService.encrypt(newData[key]);
            }
        }
        return newData;
    }

    private decryptUserKeys(user: User): User {
        const keysToDecrypt = [
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

        const decryptedUser: any = { ...user }; // any чтобы проще присваивать

        // BigInt to Number/String conversion for JSON safety if needed later 
        // (Prisma returns BigInt which doesn't serialize to JSON well without polyfill)
        // Но пока оставим как есть внутри приложения.

        for (const key of keysToDecrypt) {
            if (decryptedUser[key]) {
                decryptedUser[key] = EncryptionService.decrypt(decryptedUser[key]);
            }
        }
        return decryptedUser as User;
    }
}

function ifWithoutId(data: any) {
    if (!data.telegramId) throw new Error("Telegram ID is required");
}
