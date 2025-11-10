// src/modules/notifications/notification.service.ts

import { Telegraf } from 'telegraf';
import * as fs from 'fs/promises';
import * as path from 'path';

// Импортируем все сервисы бирж напрямую, так как этот модуль теперь автономен
import { BinanceService } from '../binance/binance.service';
import { HyperliquidService } from '../hyperliquid/hyperliquid.service';
import { ParadexService } from '../paradex/paradex.service';
import { LighterService } from '../lighter/lighter.service';
import { ExtendedService } from '../extended/extended.service';

// Определяем интерфейс для рангов локально
interface Rank {
    min: number;
    max: number;
    emoji: string;
}

export class NotificationService {
    // Карта для хранения активных таймеров для каждого пользователя
    private activeMonitors: Map<number, NodeJS.Timeout> = new Map();
    // Флаг-"замок", чтобы предотвратить одновременный запуск нескольких проверок
    private isCheckRunning: boolean = false;
    // Кеш по биржам: хранит последний успешный ответ и метку времени
    private cache: Map<string, { ts: number; data?: { leverage: number; accountEquity: number } }> = new Map();
    // TTL кеша в миллисекундах
    private CACHE_TTL = 25_000; // 30 секунд
    // Счётчики последовательных ошибок: Map<userId, Map<exchangeName, count>>
    private errorCounters: Map<number, Map<string, number>> = new Map();
    // Сколько последовательных ошибок требуется для уведомления
    private ERROR_THRESHOLD = 2;
    // Флаг завершения работы, чтобы не слать сообщения при shutdown
    private shuttingDown: boolean = false;

    constructor(
        private readonly bot: Telegraf<any>,
        private readonly binanceService: BinanceService,
        private readonly hyperliquidService: HyperliquidService,
        private readonly paradexService: ParadexService,
        private readonly lighterService: LighterService,
        private readonly extendedService: ExtendedService,
    ) { }

    /**
     * Приватный метод для загрузки и парсинга рангов из файла.
     */
    private async _loadRanks(): Promise<Rank[]> {
        try {
            const ranksPath = path.join(__dirname, '..', '..', '..', 'ranking-config.json');
            const data = await fs.readFile(ranksPath, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            console.error('Критическая ошибка: не удалось загрузить или распарсить ranking-config.json:', error);
            return [];
        }
    }


    private async _performCheck(userId: number): Promise<void> {
        // Если сервис завершает работу, ничего не делаем
        if (this.shuttingDown) return;
        // Если проверка уже запущена, выходим, чтобы избежать дублирования запросов.
        if (this.isCheckRunning) {
            console.log('Проверка уже выполняется, новая проверка пропущена.');
            return;
        }

        // "Закрываем замок", чтобы другие вызовы не прошли
        this.isCheckRunning = true;

        try {
            const freshRanks = await this._loadRanks();
            if (freshRanks.length < 4) {
                console.error("Файл рангов неполный, невозможно определить порог тревоги. Проверка пропущена.");
                return;
            }

            const alertThreshold = freshRanks[3].min; // Динамически определяем порог

            const exchangeServices = [
                { name: 'Binance', service: this.binanceService },
                { name: 'Hyperliquid', service: this.hyperliquidService },
                { name: 'Paradex', service: this.paradexService },
                { name: 'Lighter', service: this.lighterService },
                { name: 'Extended', service: this.extendedService },
            ];

            // Выполняем запросы через кеширующий метод, чтобы снизить нагрузку на API
            const results = await Promise.allSettled(
                exchangeServices.map(ex => this.getCachedLeverage(ex.name, ex.service))
            );

            results.forEach((result, index) => {
                const exchangeName = exchangeServices[index].name;

                // Логируем результат запроса для каждой биржи: либо плечо, либо ошибка
                if (result.status === 'fulfilled') {
                    try {
                        // console.log(`${exchangeName} - ${result.value.leverage.toFixed(2)}`);
                    } catch (e) {
                        //  console.log(`${exchangeName} - ${String((result as any).value?.leverage)}`);
                    }
                } else {
                    console.log(`${exchangeName} - ERROR: ${String((result as any).reason)}`);
                }

                if (result.status === 'rejected') {
                    // Обновляем счётчик ошибок для данного пользователя и биржи
                    let userMap = this.errorCounters.get(userId);
                    if (!userMap) {
                        userMap = new Map<string, number>();
                        this.errorCounters.set(userId, userMap);
                    }

                    const prev = userMap.get(exchangeName) || 0;
                    const next = prev + 1;
                    userMap.set(exchangeName, next);

                    const cached = this.cache.get(exchangeName);
                    if (!cached || !cached.data) {
                        // Уведомляем пользователя только если достигнут порог последовательных ошибок
                        if (next >= this.ERROR_THRESHOLD) {
                            const errorMessage = `❗️ Ошибка API на бирже <b>${exchangeName}</b>. Не удалось получить данные (${next} попытки).`;
                            if (!this.shuttingDown) {
                                this.bot.telegram.sendMessage(userId, errorMessage, { parse_mode: 'HTML' });
                            } else {
                                console.log(`[Shutdown] Пропущено уведомление для ${userId}: ${errorMessage}`);
                            }
                            // Сброс счётчика после уведомления, чтобы не спамить повторно
                            userMap.set(exchangeName, 0);
                        } else {
                            console.log(`API ${exchangeName} вернул ошибку для пользователя ${userId}. Попытка ${next}/${this.ERROR_THRESHOLD}.`);
                        }
                    } else {
                        // Если есть старый кеш, логируем и используем кеш, не меняем счётчик
                        console.log(`API ${exchangeName} вернул ошибку, использую последний успешный кеш для пользователя ${userId}.`);
                    }

                    return;
                }

                const { leverage, accountEquity } = result.value;

                // Успешный ответ — сбрасываем счётчик ошибок для этого пользователя/биржи
                const userMap = this.errorCounters.get(userId);
                if (userMap) {
                    userMap.set(exchangeName, 0);
                }

                if (leverage >= alertThreshold) {
                    const rank = freshRanks.find(r => leverage >= r.min && leverage < r.max);
                    const emoji = rank ? rank.emoji : '‼️';
                    const equity = Math.round(accountEquity);
                    const leverageStr = leverage.toFixed(2);
                    const alertMessage = `${emoji} Внимание! Биржа <b>${exchangeName}</b>\nЭквити: <b>${equity}$</b>\nПлечо: <b>${leverageStr}x</b>`;
                    if (!this.shuttingDown) {
                        this.bot.telegram.sendMessage(userId, alertMessage, { parse_mode: 'HTML' });
                    } else {
                        console.log(`[Shutdown] Пропущено оповещение для ${userId}: ${alertMessage}`);
                    }
                }
            });
        } catch (error) {
            console.error(`Ошибка в цикле мониторинга для пользователя ${userId}:`, error);
            if (!this.shuttingDown) {
                this.bot.telegram.sendMessage(userId, '🔴 Произошла критическая ошибка в процессе мониторинга.');
            } else {
                console.log(`[Shutdown] Пропущено критическое оповещение для ${userId}`);
            }
        } finally {
            // "Открываем замок" в любом случае, даже если была ошибка.
            // Это гарантирует, что следующая проверка сможет запуститься.
            this.isCheckRunning = false;
        }
    }


    private async getCachedLeverage(serviceName: string, serviceInstance: any) {
        const now = Date.now();
        const entry = this.cache.get(serviceName);

        if (entry && entry.data && (now - entry.ts) < this.CACHE_TTL) {
            return entry.data;
        }

        try {
            const data = await serviceInstance.calculateLeverage();
            if (data && typeof data.leverage === 'number') {
                this.cache.set(serviceName, { ts: now, data });
            }
            return data;
        } catch (err) {
            // Если есть старый успешный кеш, возвращаем его — это защитит от временных ошибок API
            if (entry && entry.data) {
                return entry.data;
            }
            // Иначе пробрасываем ошибку дальше
            throw err;
        }
    }

    /**
     * Запускает мониторинг для конкретного пользователя.
     */
    public startMonitoring(userId: number): string {
        if (this.activeMonitors.has(userId)) {
            return '✅ Мониторинг уже активен.';
        }

        // Устанавливаем безопасный интервал в 1 минуту (60 000 миллисекунд)
        const intervalId = setInterval(() => this._performCheck(userId), 60000);

        this.activeMonitors.set(userId, intervalId);
        console.log(`Мониторинг запущен для пользователя: ${userId}`);
        return '🔔 Мониторинг плечей активирован.';
    }

    /**
     * Останавливает мониторинг для конкретного пользователя.
     */
    public stopMonitoring(userId: number): string {
        const intervalId = this.activeMonitors.get(userId);

        if (intervalId) {
            clearInterval(intervalId);
            this.activeMonitors.delete(userId);
            console.log(`Мониторинг остановлен для пользователя: ${userId}`);
            return '🔕 Мониторинг плечей отключен.';
        } else {
            return 'ℹ️ Мониторинг не был активен.';
        }
    }
    public stopAllMonitors(): void {
        // Помечаем, что идёт завершение работы
        this.shuttingDown = true;
        // Проверяем, есть ли вообще активные таймеры
        if (this.activeMonitors.size > 0) {
            console.log(`[Graceful Shutdown] Останавливаем ${this.activeMonitors.size} активных мониторингов...`);

            // Проходим по всем сохраненным ID таймеров и останавливаем каждый
            for (const intervalId of this.activeMonitors.values()) {
                clearInterval(intervalId);
            }

            // Полностью очищаем карту
            this.activeMonitors.clear();
            console.log('[Graceful Shutdown] Все мониторинги остановлены.');
        }
    }

}