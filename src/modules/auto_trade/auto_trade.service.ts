import { Injectable, Logger } from '@nestjs/common';
import { BinanceTickerService } from '../binance/websocket/binance.ticker.service';
import { HyperliquidTickerService } from '../hyperliquid/websocket/hyperliquid.ticker.service';
import { BinanceService } from '../binance/binance.service';
import { HyperliquidService } from '../hyperliquid/hyperliquid.service';

// Импорт хелперов
import * as Helpers from './auto_trade.helpers';

export type ExchangeName = 'Binance' | 'Hyperliquid' | 'Paradex' | 'Extended' | 'Lighter';

export interface TradeSessionConfig {
    userId: number;
    coin: string;
    longExchange: ExchangeName;
    shortExchange: ExchangeName;
    totalQuantity: number;
    stepQuantity: number;
    targetBp: number;
    onUpdate: (msg: string) => Promise<void>;
    onFinished: () => void;
}

@Injectable()
export class AutoTradeService {
    private readonly logger = new Logger(AutoTradeService.name);
    private activeSessions = new Map<number, boolean>();
    private activeSockets = new Map<number, { long: any, short: any, timeout: NodeJS.Timeout | null }>();

    constructor(
        private binanceTicker: BinanceTickerService,
        private hlTicker: HyperliquidTickerService,
        private binanceService: BinanceService,
        private hlService: HyperliquidService,
    ) { }

    // Геттер для передачи сервисов в хелперы
    private get services() {
        return { binance: this.binanceService, hl: this.hlService };
    }

    public isRunning(userId: number): boolean {
        return !!this.activeSessions.get(userId);
    }

    public stopSession(userId: number, reason: string = 'Unknown') { // <--- Добавили аргумент reason
        if (this.activeSockets.has(userId)) {
            const socketData = this.activeSockets.get(userId)!;

            if (socketData.timeout) clearTimeout(socketData.timeout);

            try {
                if (socketData.long && typeof socketData.long.stop === 'function') socketData.long.stop();
                if (socketData.short && typeof socketData.short.stop === 'function') socketData.short.stop();
            } catch (e) {
                console.error(`[AutoTrade] Error stopping sockets for ${userId}:`, e);
            }
            this.activeSockets.delete(userId);
        }
        this.activeSessions.delete(userId);

        // Логируем причину
        this.logger.log(`Session stopped for user ${userId}. Reason: ${reason}`);
    }

    public async startSession(config: TradeSessionConfig) {
        const { userId, coin, longExchange, shortExchange, totalQuantity, stepQuantity, targetBp, onUpdate, onFinished } = config;

        // 1. ВАЛИДАЦИЯ
        if (this.isRunning(userId)) return onUpdate('⚠️ У вас уже запущен процесс.');
        if (totalQuantity <= 0 || stepQuantity <= 0) return onUpdate('❌ Ошибка: Количество <= 0');
        if (stepQuantity > totalQuantity) return onUpdate('❌ Ошибка: Шаг > Всего');

        this.activeSessions.set(userId, true);

        // Объявляем переменную ДО использования
        let filledQuantity = 0;

        await onUpdate(`🚀 <b>DEBUG РЕЖИМ</b>)\n${coin} | L:${longExchange} S:${shortExchange} | ${filledQuantity}/${totalQuantity}`);

        let iteration = 1;
        let currentLongAsk: number | null = null;
        let currentShortBid: number | null = null;

        try {
            // Использование хелпера для формата
            const longSymbol = await Helpers.formatSymbol(longExchange, coin);
            const shortSymbol = await Helpers.formatSymbol(shortExchange, coin);

            const longTicker = this.getTickerService(longExchange);
            const shortTicker = this.getTickerService(shortExchange);

            await Promise.all([
                longTicker.start(longSymbol, (_: string, ask: string) => { currentLongAsk = parseFloat(ask); }),
                shortTicker.start(shortSymbol, (bid: string, _: string) => { currentShortBid = parseFloat(bid); })
            ]);

            this.activeSockets.set(userId, { long: longTicker, short: shortTicker, timeout: null });

            // === ОСНОВНОЙ ЦИКЛ ===
            const runStep = async () => {
                if (!this.isRunning(userId)) return;

                // А. Ждем цены
                if (!currentLongAsk || !currentShortBid) {
                    const t = setTimeout(runStep, 1000);
                    this.updateSocketTimeout(userId, t);
                    return;
                }

                // Б. Расчет остатка
                let remaining = Helpers.roundFloat(totalQuantity - filledQuantity);

                if (remaining <= 0.0001) {
                    await this.finishTrade(config, filledQuantity);
                    return;
                }

                // В. Объем шага
                const qtyToTrade = Helpers.roundFloat(Math.min(stepQuantity, remaining), 3);

                if (qtyToTrade <= 0) {
                    await this.finishTrade(config, filledQuantity);
                    return;
                }

                const currentMarketBp = ((currentShortBid! - currentLongAsk!) / currentShortBid!) * 10000;
                await onUpdate(`⚡️ <b>Итерация #${iteration}</b> (BP: ${currentMarketBp.toFixed(1)})\nПоза ${qtyToTrade} ${coin}`);

                try {
                    // --- ПАРАЛЛЕЛЬНЫЕ ТРЕЙДЫ ---
                    // Запускаем оба ордера одновременно
                    const [longRes, shortRes] = await Promise.all([
                        Helpers.executeTrade(longExchange, coin, 'BUY', qtyToTrade, this.services),
                        Helpers.executeTrade(shortExchange, coin, 'SELL', qtyToTrade, this.services)
                    ]);

                    // --- ПРОВЕРКА РЕЗУЛЬТАТОВ ---

                    // 1. Оба упали
                    if (!longRes.success && !shortRes.success) {
                        throw new Error(`Оба ордера не открылись.\nL: ${longRes.error}\nS: ${shortRes.error}`);
                    }

                    // 2. Лонг упал, Шорт открыт (КРИТИЧНО)
                    if (!longRes.success && shortRes.success) {
                        throw new Error(`🛑 <b>CRITICAL:</b> SHORT открыт (${shortRes.price}), а LONG упал (${longRes.error})!\n⚠️ <b>ЗАКРОЙТЕ SHORT ВРУЧНУЮ!</b>`);
                    }

                    // 3. Шорт упал, Лонг открыт (КРИТИЧНО)
                    if (longRes.success && !shortRes.success) {
                        throw new Error(`🛑 <b>CRITICAL:</b> LONG открыт (${longRes.price}), а SHORT упал (${shortRes.error})!\n⚠️ <b>ЗАКРОЙТЕ LONG ВРУЧНУЮ!</b>`);
                    }

                    // 4. УСПЕХ (Оба открыты)
                    const longPrice = longRes.price!;
                    const shortPrice = shortRes.price!;

                    const realizedBp = ((shortPrice - longPrice) / shortPrice) * 10000;

                    filledQuantity = Helpers.roundFloat(filledQuantity + qtyToTrade);

                    await onUpdate(
                        `🎉 <b>Шаг #${iteration} OK</b> | ${filledQuantity}/${totalQuantity}\n` +
                        `L: ${longPrice} | S: ${shortPrice} | <b>BP: ${realizedBp.toFixed(1)}</b>`
                    );

                    iteration++;

                    if (filledQuantity >= totalQuantity) {
                        await this.finishTrade(config, filledQuantity);
                        return;
                    }

                    await onUpdate(`⏳ Пауза 10 сек...`);
                    const t = setTimeout(runStep, 10000);
                    this.updateSocketTimeout(userId, t);

                } catch (err: any) {
                    await onUpdate(`❌ <b>ОШИБКА:</b> ${err.message}\n🔴 <b>ТРЕЙД ОСТАНОВЛЕН</b>`);
                    this.stopSession(userId);
                    onFinished();
                }
            };

            runStep();

        } catch (error: any) {
            await onUpdate(`❌ Start Error: ${error.message}`);
            this.stopSession(userId);
            onFinished();
        }
    }

    private async finishTrade(config: TradeSessionConfig, filledQty: number) {
        const { userId, coin, longExchange, shortExchange, onUpdate, onFinished } = config;

        await onUpdate('🏁 <b>Трейд завершен.</b> Сверяю итоговые позиции через API...');

        let msg = '';

        try {
            // Запрашиваем данные через хелпер
            const [longPos, shortPos] = await Promise.all([
                Helpers.getPositionData(longExchange, coin, this.services),
                Helpers.getPositionData(shortExchange, coin, this.services)
            ]);

            // 1. Проверяем наличие позиций
            if (longPos.size === 0 && shortPos.size === 0) {
                msg = `⚠️ <b>Позиции не найдены!</b>\nРазмер на обеих биржах равен 0.`;
            }
            else if (longPos.size === 0) {
                msg = `⚠️ <b>Нет позиции на LONG (${longExchange})!</b>\n` +
                    `Long: 0\nShort: ${shortPos.size}\nТребуется проверка!`;
            }
            else if (shortPos.size === 0) {
                msg = `⚠️ <b>Нет позиции на SHORT (${shortExchange})!</b>\n` +
                    `Long: ${longPos.size}\nShort: 0\nТребуется проверка!`;
            }
            else {
                // 2. Сверка размеров
                const diff = Math.abs(longPos.size - shortPos.size);
                const tolerance = config.totalQuantity * 0.01;

                if (diff > tolerance) {
                    msg = `⚠️ <b>РАССИНХРОН ПОЗИЦИЙ!</b>\n\n` +
                        `🔸 <b>${longExchange} (L):</b> ${longPos.size}\n` +
                        `🔸 <b>${shortExchange} (S):</b> ${shortPos.size}\n\n` +
                        `❌ Разница: ${diff.toFixed(4)}\n` +
                        `<i>Проверьте вручную!</i>`;
                } else {
                    // 3. Успешный финал
                    const finalBp = ((shortPos.price - longPos.price) / shortPos.price) * 10000;

                    msg = `✅ <b>УСПЕХ! Трейды окончены.</b>\n\n` +
                        `📦 <b>Размер:</b> ${longPos.size} ${coin}\n` +
                        `📈 <b>L (${longExchange}):</b> ${longPos.price.toFixed(4)}\n` +
                        `📉 <b>S (${shortExchange}):</b> ${shortPos.price.toFixed(4)}\n\n` +
                        `📊 <b>Итоговый Entry BP: ${finalBp.toFixed(1)}</b>`;
                }
            }

        } catch (e: any) {
            console.error('Finish trade error:', e);
            msg = `❌ <b>ОШИБКА ПРОВЕРКИ API</b>\n\n` +
                `Причина: ${e.message}\n` +
                `<i>Проверьте терминалы бирж вручную.</i>`;
        }

        await onUpdate(msg);
        this.stopSession(userId);
        onFinished();
    }

    private updateSocketTimeout(userId: number, t: NodeJS.Timeout) {
        const s = this.activeSockets.get(userId);
        if (s) s.timeout = t;
    }

    private getTickerService(exchange: ExchangeName): any {
        switch (exchange) {
            case 'Binance': return this.binanceTicker;
            case 'Hyperliquid': return this.hlTicker;
            default: throw new Error(`No ticker for ${exchange}`);
        }
    }
}